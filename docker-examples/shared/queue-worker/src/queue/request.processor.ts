import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueService } from './queue.service';
import { MclaudeService } from '../mclaude/mclaude.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { Request } from '../database/entities/request.entity';

@Injectable()
export class RequestProcessor implements OnModuleInit {
  private readonly logger: Logger;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private isProcessing = false;
  private shouldStop = false;

  constructor(
    private readonly queue: QueueService,
    private readonly mclaude: MclaudeService,
    private readonly workspace: WorkspaceService,
    private readonly config: ConfigService,
    workerIndex: number,
  ) {
    const prefix = this.config.get<string>('worker.idPrefix') || 'worker';
    this.workerId = `${prefix}-${workerIndex}`;
    this.logger = new Logger(`${RequestProcessor.name}:${this.workerId}`);
    this.pollIntervalMs = this.config.get<number>('worker.pollIntervalMs') || 5000;
  }

  onModuleInit() {
    this.startPolling();
  }

  private async startPolling() {
    this.logger.log(`Starting poll loop (interval: ${this.pollIntervalMs}ms)`);

    while (!this.shouldStop) {
      if (!this.isProcessing) {
        await this.processNext();
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  async processNext(): Promise<void> {
    this.isProcessing = true;

    try {
      const request = await this.queue.claimNext(this.workerId);
      if (!request) {
        this.isProcessing = false;
        return;
      }

      await this.processRequest(request);
    } catch (error) {
      this.logger.error(`Unexpected error in processNext: ${error}`);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processRequest(request: Request): Promise<void> {
    const startTime = Date.now();
    let workDir: string | null = null;

    this.logger.log(`Processing request ${request.id}`);
    if (request.repoUrl) {
      this.logger.log(`  Repo: ${request.repoUrl} (${request.branch || 'main'})`);
    } else {
      this.logger.log(`  Repo: (none - using empty workspace)`);
    }
    this.logger.log(`  Prompt: ${request.prompt.substring(0, 100)}...`);
    if (request.metadata && Object.keys(request.metadata).length > 0) {
      this.logger.log(`  Metadata keys: ${Object.keys(request.metadata).join(', ')}`);
    }

    try {
      // 1. Setup workspace
      workDir = await this.workspace.setup(request.id);
      this.logger.log(`  Workspace: ${workDir}`);

      // 2. Clone repository (if URL provided)
      if (request.repoUrl) {
        await this.workspace.cloneRepo(workDir, request.repoUrl, request.branch || 'main');
        this.logger.log(`  Repository cloned`);
      }

      // 3. Execute mclaude (with metadata injected as env vars)
      const result = await this.mclaude.execute(workDir, request.prompt, request.config, request.metadata);
      const durationMs = Date.now() - startTime;

      // 4. Extract artifacts from output
      const prUrl = this.extractPrUrl(result.stdout);
      const commitSha = await this.workspace.getLatestCommit(workDir);
      const branchName = await this.workspace.getCurrentBranch(workDir);

      // 5. Write success result
      await this.queue.writeResult({
        requestId: request.id,
        status: result.exitCode === 0 ? 'success' : 'partial',
        output: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
        prUrl,
        commitSha,
        branchName,
        durationMs,
        workerId: this.workerId,
      });

      this.logger.log(`  Completed in ${durationMs}ms`);
      if (prUrl) this.logger.log(`  PR created: ${prUrl}`);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(`  Failed: ${errorMessage}`);

      await this.queue.writeResult({
        requestId: request.id,
        status: 'error',
        output: {},
        durationMs,
        workerId: this.workerId,
        error: errorMessage,
        errorDetails: { stack: errorStack },
      });
    } finally {
      // Cleanup workspace if configured
      if (workDir && this.config.get<boolean>('workspace.cleanupAfterComplete')) {
        try {
          await this.workspace.cleanup(workDir);
          this.logger.log(`  Workspace cleaned up`);
        } catch (cleanupError) {
          this.logger.warn(`  Failed to cleanup workspace: ${cleanupError}`);
        }
      }
    }
  }

  private extractPrUrl(output: string): string | undefined {
    // Match GitHub PR URLs in the output
    const prUrlMatch = output.match(
      /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/,
    );
    return prUrlMatch ? prUrlMatch[0] : undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  stop() {
    this.shouldStop = true;
  }
}
