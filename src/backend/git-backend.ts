import { FileSystemAdapter, Vault } from 'obsidian';
import { SyncBackend, SyncResult, SyncStatus, FileChange } from './base';
import { t } from '../i18n';
import { getErrorMessage, toError } from '../utils/error';
import { Logger, LogLevel } from '../utils/logger';

export class GitBackend extends SyncBackend {
  readonly name = 'git';
  private vaultPath: string;
  private gitPath: string;
  private remoteUrl: string;
  private token: string;
  private commitMessage: string;
  private debug: boolean;
  private logger: Logger;

  constructor(vault: Vault, gitPath: string = 'git', remoteUrl: string = '', token: string = '', commitMessage?: string, debug = false) {
    super();
    // The vault's absolute path lives on the desktop-only FileSystemAdapter
    this.vaultPath = vault.adapter instanceof FileSystemAdapter ? vault.adapter.getBasePath() : '';
    this.gitPath = gitPath;
    this.remoteUrl = remoteUrl;
    this.token = token;
    this.commitMessage = commitMessage || '';
    this.debug = debug;
    this.logger = new Logger('GitBackend', debug ? LogLevel.DEBUG : LogLevel.INFO);
    this.log('GitBackend created', {
      vaultPath: this.vaultPath,
      gitPath: this.gitPath,
      remoteUrl: this.remoteUrl,
      hasToken: !!this.token,
    });
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      this.logger.info(...args);
    }
  }

  /**
   * Get remote URL from git config
   */
  async getRemoteUrl(): Promise<string | null> {
    try {
      const url = await this.exec('remote get-url origin');
      return url.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(): Promise<string | null> {
    try {
      const branch = await this.exec('rev-parse --abbrev-ref HEAD');
      return branch.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get remote repository info (auto-detect)
   */
  async getRepoInfo(): Promise<{ remoteUrl: string | null; branch: string | null }> {
    const remoteUrl = await this.getRemoteUrl();
    const branch = await this.getCurrentBranch();
    return { remoteUrl, branch };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const version = (await this.exec('--version')).trim();
      this.log('isAvailable: git version =', version);

      // Check if current directory is a git repo
      const isInsideWorkTree = (await this.exec('rev-parse --is-inside-work-tree')).trim();
      this.log('isAvailable: isInsideWorkTree =', isInsideWorkTree, ', vaultPath =', this.vaultPath);

      // Auto-configure remote if remoteUrl is provided
      if (this.remoteUrl) {
        try {
          const remotes = await this.exec('remote -v');
          if (!remotes.trim()) {
            this.log('isAvailable: No remote configured, adding origin:', this.remoteUrl);
            await this.exec(`remote add origin ${this.remoteUrl}`);
          }
          // Always update URL with token for authentication
          if (this.token) {
            const authUrl = this.remoteUrl.replace(
              'https://',
              `https://x-access-token:${this.token}@`
            );
            await this.exec(`remote set-url origin ${authUrl}`);
            this.log('isAvailable: Updated remote URL with token');
          }
        } catch (error) {
          this.log('isAvailable: Remote config error (ignored):', getErrorMessage(error));
        }
      }

      this.log('isAvailable: Git backend is available');
      return true;
    } catch (error) {
      this.logger.warn('isAvailable: Git backend not available:', getErrorMessage(error));
      return false;
    }
  }

  async pull(): Promise<SyncResult> {
    try {
      this.log('pull: Pulling from remote...');
      const output = await this.exec('pull --no-rebase');
      const pulled = this.countChanges(output);
      this.log('pull: Success, pulled', pulled, 'files');
      return {
        success: true,
        message: output.trim(),
        pulled,
      };
    } catch (error) {
      this.logger.warn('pull: Pull failed:', getErrorMessage(error));
      return {
        success: false,
        message: 'Pull failed',
        error: toError(error),
      };
    }
  }

  async push(): Promise<SyncResult> {
    try {
      const branch = (await this.exec('rev-parse --abbrev-ref HEAD')).trim();
      this.log('push: Current branch:', branch);

      // Check if upstream is already set
      let hasUpstream = false;
      try {
        await this.exec(`rev-parse --abbrev-ref ${branch}@{upstream}`);
        hasUpstream = true;
      } catch {
        // No upstream set
      }
      this.log('push: Has upstream:', hasUpstream);

      // Use -u flag only if upstream is not set
      const pushCmd = hasUpstream ? 'push' : `push -u origin ${branch}`;
      this.log('push: Executing:', pushCmd);
      const output = await this.exec(pushCmd);

      const pushed = this.countChanges(output);
      this.log('push: Success, pushed', pushed, 'files');
      return {
        success: true,
        message: output.trim(),
        pushed,
      };
    } catch (error) {
      this.logger.warn('push: Push failed:', getErrorMessage(error));
      return {
        success: false,
        message: `Push failed: ${getErrorMessage(error)}`,
        error: toError(error),
      };
    }
  }

  /**
   * Build commit message from template
   */
  private buildCommitMessage(): string {
    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').substring(0, 19);
    return (this.commitMessage || 'vault backup: {{date}}')
      .replace('{{date}}', dateStr)
      .replace('{{path}}', 'batch');
  }

  async sync(): Promise<SyncResult> {
    try {
      this.log('sync: Starting git sync...');

      // Step 0: Check git state before syncing
      const stateCheck = await this.checkGitState();
      if (!stateCheck.ok) {
        this.log('sync: Git state check failed:', stateCheck.message);
        return {
          success: false,
          message: stateCheck.message,
          error: new Error(stateCheck.message),
        };
      }

      // Step 1: Stage all changes
      this.log('sync: Staging all changes...');
      await this.exec('add -A');

      // Step 2: Check if there are changes to commit
      const status = await this.exec('status --porcelain');
      const changedFiles = status.trim().split('\n').filter(line => line.trim());
      this.log('sync: Changed files:', changedFiles.length);

      if (status.trim()) {
        const message = this.buildCommitMessage();
        // Escape double quotes in the message for shell safety
        const safeMessage = message.replace(/"/g, '\\"');
        this.log('sync: Committing with message:', message);
        await this.exec(`commit -m "${safeMessage}"`);
      } else {
        this.log('sync: No changes to commit');
      }

      // Step 3: Try to pull with merge (skip if remote is empty or no upstream)
      this.log('sync: Pulling from remote...');
      try {
        const pullOutput = await this.exec('pull --no-rebase');
        this.log('sync: Pull result:', pullOutput.trim());
      } catch (pullError) {
        // Remote might be empty or no upstream set — that's OK for first push
        const msg = (pullError as Error).message;
        if (msg.includes('couldn\'t find remote ref') ||
            msg.includes('no upstream') ||
            msg.includes('fatal: couldn\'t find remote ref') ||
            msg.includes('There is no tracking information')) {
          this.log('sync: No upstream or empty remote, will push');
        } else {
          this.logger.warn('sync: Pull failed:', msg);
          throw pullError; // Re-throw other errors
        }
      }

      // Step 4: Push
      this.log('sync: Pushing to remote...');
      const pushResult = await this.push();
      this.log('sync: Push result:', pushResult);
      return pushResult;
    } catch (error) {
      this.logger.error('sync: Sync failed:', getErrorMessage(error));
      return {
        success: false,
        message: `Sync failed: ${getErrorMessage(error)}`,
        error: toError(error),
      };
    }
  }

  /**
   * Check git state and return error if abnormal
   */
  private async checkGitState(): Promise<{ ok: boolean; message: string }> {
    try {
      const status = await this.exec('status');

      // Check for rebase in progress
      if (status.includes('rebase') || status.includes('REBASE')) {
        return {
          ok: false,
          message: t('conflict.rebaseInProgress'),
        };
      }

      // Check for merge in progress
      if (status.includes('merge') || status.includes('MERGE')) {
        return {
          ok: false,
          message: t('conflict.mergeInProgress'),
        };
      }

      // Check for cherry-pick in progress
      if (status.includes('cherry-pick') || status.includes('CHERRY_PICK')) {
        return {
          ok: false,
          message: t('conflict.cherryPickInProgress'),
        };
      }

      return { ok: true, message: '' };
    } catch (error) {
      // If git status fails, might be in a bad state
      return {
        ok: false,
        message: `Git state check failed: ${getErrorMessage(error)}`,
      };
    }
  }

  async status(): Promise<SyncStatus> {
    try {
      // Get current branch
      const branch = (await this.exec('rev-parse --abbrev-ref HEAD')).trim();
      this.log('status: Current branch:', branch);

      // Get ahead/behind counts
      let ahead = 0, behind = 0;
      try {
        const counts = await this.exec('rev-list --left-right --count HEAD...@{upstream}');
        const [a, b] = counts.trim().split('\t').map(Number);
        ahead = a || 0;
        behind = b || 0;
        this.log('status: Ahead:', ahead, ', Behind:', behind);
      } catch {
        // No upstream configured
        this.log('status: No upstream configured');
      }

      // Get changed files
      const statusOutput = await this.exec('status --porcelain');
      const changedFiles = this.parseStatus(statusOutput);
      this.log('status: Changed files:', changedFiles.length);

      // Check for conflicts
      const hasConflicts = statusOutput.includes('UU') || statusOutput.includes('AA');
      if (hasConflicts) {
        this.log('status: Conflicts detected');
      }

      return { ahead, behind, changedFiles, branch, hasConflicts };
    } catch (error) {
      this.logger.warn('status: Failed to get status:', getErrorMessage(error));
      return {
        ahead: 0,
        behind: 0,
        changedFiles: [],
        branch: 'unknown',
        hasConflicts: false,
      };
    }
  }

  async initializeRepo(): Promise<SyncResult> {
    // Git backend doesn't need special initialization
    // User should have already run `git init` and `git remote add`
    return { success: true, message: 'No initialization needed for git backend' };
  }

  dispose(): void {
    // Nothing to dispose for native git
  }

  async exec(args: string): Promise<string> {
    // SAFETY: This method is only called on desktop — the caller
    // (isGitAvailable in main.ts) checks Platform.isDesktop first.
    // child_process is listed in esbuild "external" so it is never
    // bundled; require() resolves it from Electron's Node.js runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- require() is safe here: only called on desktop, child_process is in esbuild external
    const { exec } = require('child_process') as typeof import('child_process');
    return new Promise((resolve, reject) => {
      // Build environment with token for authentication
      const env = { ...process.env };
      if (this.token) {
        // Use GIT_ASKPASS to provide credentials non-interactively
        // This tells git to use our token when it asks for credentials
        env.GIT_TERMINAL_PROMPT = '0'; // Disable interactive prompts
        env.GIT_ASKPASS = 'echo'; // Use echo as credential helper
        if (this.remoteUrl.includes('github.com')) {
          env.GITHUB_TOKEN = this.token;
        }
      }

      exec(`${this.gitPath} ${args}`, {
        cwd: this.vaultPath,
        env,
      }, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  private parseStatus(output: string): FileChange[] {
    const changes: FileChange[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const statusCode = line.substring(0, 2);
      const path = line.substring(3).trim();

      let status: FileChange['status'];
      if (statusCode.includes('A')) status = 'added';
      else if (statusCode.includes('D')) status = 'deleted';
      else if (statusCode.includes('R')) status = 'renamed';
      else status = 'modified';

      changes.push({ path, status });
    }
    return changes;
  }

  private countChanges(output: string): number {
    const match = output.match(/(\d+) file/);
    return match ? parseInt(match[1]) : 0;
  }
}
