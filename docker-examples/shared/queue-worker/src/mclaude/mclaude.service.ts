import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execa, ExecaError } from 'execa';
import { RequestConfig, RequestMetadata } from '../database/entities/request.entity';

export interface MclaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

@Injectable()
export class MclaudeService {
  private readonly logger = new Logger(MclaudeService.name);
  private readonly variant: string;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.variant = this.config.get<string>('mclaude.variant') || 'mc';
    this.defaultTimeoutMs = this.config.get<number>('mclaude.timeoutMs') || 1800000;
  }

  /**
   * Execute mclaude with the given prompt in the specified working directory
   */
  async execute(
    workDir: string,
    prompt: string,
    requestConfig?: RequestConfig,
    metadata?: RequestMetadata,
  ): Promise<MclaudeResult> {
    const timeoutMs = requestConfig?.timeout_minutes
      ? requestConfig.timeout_minutes * 60 * 1000
      : this.defaultTimeoutMs;

    // Convert metadata to environment variables (SCREAMING_SNAKE_CASE)
    const metadataEnv = this.metadataToEnv(metadata);

    this.logger.log(`Executing mclaude (variant: ${this.variant})`);
    this.logger.debug(`  Working directory: ${workDir}`);
    this.logger.debug(`  Timeout: ${timeoutMs}ms`);
    this.logger.debug(`  Prompt length: ${prompt.length} chars`);
    if (Object.keys(metadataEnv).length > 0) {
      this.logger.debug(`  Metadata env vars: ${Object.keys(metadataEnv).join(', ')}`);
    }

    try {
      // Use --print flag for non-interactive mode
      const result = await execa(this.variant, ['--print', prompt], {
        cwd: workDir,
        timeout: timeoutMs,
        env: {
          ...process.env,
          // Inject metadata as environment variables
          ...metadataEnv,
          // Ensure non-interactive mode
          CC_MIRROR_SPLASH: '0',
          // Set model if specified in config
          ...(requestConfig?.model && {
            ANTHROPIC_DEFAULT_MODEL: this.getModelId(requestConfig.model),
          }),
        },
        // Capture all output
        all: true,
        reject: false, // Don't throw on non-zero exit code
      });

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode ?? 1,
        timedOut: result.timedOut ?? false,
      };
    } catch (error) {
      if (this.isExecaError(error)) {
        // Handle timeout specifically
        if (error.timedOut) {
          this.logger.warn(`mclaude timed out after ${timeoutMs}ms`);
          return {
            stdout: error.stdout || '',
            stderr: error.stderr || '',
            exitCode: 124, // Standard timeout exit code
            timedOut: true,
          };
        }

        return {
          stdout: error.stdout || '',
          stderr: error.stderr || error.message,
          exitCode: error.exitCode ?? 1,
          timedOut: false,
        };
      }

      // Unknown error
      throw error;
    }
  }

  private getModelId(model: 'haiku' | 'sonnet' | 'opus'): string {
    // Map friendly names to actual model IDs
    const modelMap: Record<string, string> = {
      haiku: 'claude-3-5-haiku-latest',
      sonnet: 'claude-sonnet-4-20250514',
      opus: 'claude-opus-4-5-20251101',
    };
    return modelMap[model] || model;
  }

  /**
   * Convert metadata object to environment variables
   * Keys are converted to SCREAMING_SNAKE_CASE
   * e.g., { supabaseUrl: 'http://...' } -> { SUPABASE_URL: 'http://...' }
   */
  private metadataToEnv(metadata?: RequestMetadata): Record<string, string> {
    if (!metadata) return {};

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      // Convert camelCase to SCREAMING_SNAKE_CASE
      const envKey = key
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()
        .replace(/^_/, '');
      env[envKey] = String(value);
    }
    return env;
  }

  private isExecaError(error: unknown): error is ExecaError {
    return (
      error !== null &&
      typeof error === 'object' &&
      'exitCode' in error
    );
  }
}
