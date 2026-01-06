import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execa } from 'execa';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly baseDir: string;

  constructor(private readonly config: ConfigService) {
    this.baseDir = this.config.get<string>('workspace.base') || '/workspace';
  }

  /**
   * Setup a workspace directory for a request
   */
  async setup(requestId: string): Promise<string> {
    const workDir = path.join(this.baseDir, requestId);

    // Create the workspace directory
    await fs.mkdir(workDir, { recursive: true });

    // Create a .claude directory for project-specific config
    await fs.mkdir(path.join(workDir, '.claude'), { recursive: true });

    this.logger.debug(`Created workspace: ${workDir}`);
    return workDir;
  }

  /**
   * Clone a git repository into the workspace
   */
  async cloneRepo(workDir: string, repoUrl: string, branch: string): Promise<void> {
    this.logger.log(`Cloning ${repoUrl} (branch: ${branch})`);

    // Clone into a 'repo' subdirectory
    const repoDir = path.join(workDir, 'repo');

    await execa(
      'git',
      ['clone', '--depth', '1', '--branch', branch, repoUrl, repoDir],
      {
        cwd: workDir,
        env: {
          ...process.env,
          GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
        },
      },
    );

    this.logger.debug(`Cloned to ${repoDir}`);
  }

  /**
   * Get the latest commit SHA from the repository
   */
  async getLatestCommit(workDir: string): Promise<string | undefined> {
    const repoDir = path.join(workDir, 'repo');

    try {
      const result = await execa('git', ['rev-parse', 'HEAD'], {
        cwd: repoDir,
      });
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(workDir: string): Promise<string | undefined> {
    const repoDir = path.join(workDir, 'repo');

    try {
      const result = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoDir,
      });
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasChanges(workDir: string): Promise<boolean> {
    const repoDir = path.join(workDir, 'repo');

    try {
      const result = await execa('git', ['status', '--porcelain'], {
        cwd: repoDir,
      });
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clean up a workspace directory
   */
  async cleanup(workDir: string): Promise<void> {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
      this.logger.debug(`Cleaned up workspace: ${workDir}`);
    } catch (error) {
      this.logger.warn(`Failed to cleanup ${workDir}: ${error}`);
    }
  }

  /**
   * Copy custom skills to the workspace's mclaude config
   */
  async copySkills(workDir: string, skillsDir: string): Promise<void> {
    const targetDir = path.join(workDir, '.cc-mirror', 'mc', 'config', 'skills');
    await fs.mkdir(targetDir, { recursive: true });

    // Copy skill directories
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.copyDir(
          path.join(skillsDir, entry.name),
          path.join(targetDir, entry.name),
        );
      }
    }

    this.logger.debug(`Copied skills from ${skillsDir} to ${targetDir}`);
  }

  /**
   * Copy domain knowledge (CLAUDE.md) to the workspace
   */
  async copyDomainKnowledge(workDir: string, claudeMdPath: string): Promise<void> {
    const targetPath = path.join(workDir, 'repo', '.claude', 'CLAUDE.md');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(claudeMdPath, targetPath);
    this.logger.debug(`Copied CLAUDE.md to ${targetPath}`);
  }

  private async copyDir(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}
