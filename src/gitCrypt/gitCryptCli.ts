import { spawn } from 'node:child_process';
import { chmod, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { GitCryptRepositoryStatus } from './types';

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export class GitCryptCommandError extends Error {
  public constructor(
    message: string,
    public readonly unavailable: boolean,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'GitCryptCommandError';
  }
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandExecutor {
  run(executable: string, args: readonly string[], cwd: string): Promise<CommandResult>;
}

export class ProcessCommandExecutor implements CommandExecutor {
  public run(executable: string, args: readonly string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const fail = (error: GitCryptCommandError): void => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        reject(error);
      };

      child.once('error', (error: NodeJS.ErrnoException) => {
        fail(
          new GitCryptCommandError(
            error.code === 'ENOENT'
              ? 'git-crypt is not installed or is not available on PATH.'
              : error.message,
            error.code === 'ENOENT',
          ),
        );
      });

      const collect = (target: Buffer[]) => (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          fail(new GitCryptCommandError('git-crypt output exceeded the safety limit.', false));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));

      child.once('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        const result = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        };
        if (code !== 0) {
          reject(
            new GitCryptCommandError(
              result.stderr.trim() || `git-crypt exited with code ${code ?? 'unknown'}.`,
              false,
              code ?? undefined,
            ),
          );
          return;
        }
        resolve(result);
      });
    });
  }
}

/** Performs explicit git-crypt operations without reading key or protected file contents. */
export class GitCryptCli {
  public constructor(
    private readonly executable = 'git-crypt',
    private readonly executor: CommandExecutor = new ProcessCommandExecutor(),
  ) {}

  public async inspect(
    repositoryRoot: string,
    gitDir: string,
    hasProtectedFiles: boolean,
  ): Promise<GitCryptRepositoryStatus> {
    const installedKeyCount = await countInstalledKeys(gitDir);
    try {
      const result = await this.executor.run(this.executable, ['--version'], repositoryRoot);
      return {
        available: true,
        version: result.stdout.trim() || result.stderr.trim() || undefined,
        localState:
          installedKeyCount > 0
            ? 'unlocked'
            : hasProtectedFiles
              ? 'locked'
              : 'not-initialized',
        installedKeyCount,
      };
    } catch (error) {
      if (error instanceof GitCryptCommandError && error.unavailable) {
        return {
          available: false,
          localState:
            installedKeyCount > 0
              ? 'unlocked'
              : hasProtectedFiles
                ? 'locked'
                : 'not-initialized',
          installedKeyCount,
        };
      }
      throw error;
    }
  }

  public async unlockWithKey(repositoryRoot: string, keyFile: string): Promise<void> {
    const absoluteKeyFile = path.resolve(keyFile);
    try {
      await this.executor.run(this.executable, ['unlock', absoluteKeyFile], repositoryRoot);
    } catch (error) {
      throw maskPathInError(error, absoluteKeyFile, '<key file>');
    }
  }

  public async initializeRepository(repositoryRoot: string): Promise<void> {
    await this.executor.run(this.executable, ['init'], repositoryRoot);
  }

  public async unlockWithGpg(repositoryRoot: string): Promise<void> {
    await this.executor.run(this.executable, ['unlock'], repositoryRoot);
  }

  public async lockRepository(repositoryRoot: string): Promise<void> {
    await this.executor.run(this.executable, ['lock', '--all'], repositoryRoot);
  }

  public async addGpgUser(repositoryRoot: string, gpgUserId: string): Promise<void> {
    const normalizedUserId = gpgUserId.trim();
    if (normalizedUserId.length === 0) {
      throw new GitCryptCommandError('A GPG user ID is required.', false);
    }
    if (normalizedUserId.startsWith('-') || /[\0\r\n]/u.test(normalizedUserId)) {
      throw new GitCryptCommandError('The GPG user ID contains unsupported characters.', false);
    }
    try {
      await this.executor.run(
        this.executable,
        ['add-gpg-user', '--no-commit', normalizedUserId],
        repositoryRoot,
      );
    } catch (error) {
      throw maskPathInError(error, normalizedUserId, '<GPG user ID>');
    }
  }

  public async exportKey(repositoryRoot: string, destination: string): Promise<boolean> {
    const absoluteDestination = path.resolve(destination);
    try {
      await this.executor.run(this.executable, ['export-key', absoluteDestination], repositoryRoot);
      if (process.platform !== 'win32') {
        try {
          await chmod(absoluteDestination, 0o600);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    } catch (error) {
      throw maskPathInError(error, absoluteDestination, '<export destination>');
    }
  }
}

async function countInstalledKeys(gitDir: string): Promise<number> {
  try {
    const entries = await readdir(path.join(gitDir, 'git-crypt', 'keys'), {
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile() || entry.isDirectory()).length;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 0;
    }
    throw error;
  }
}

function maskPathInError(error: unknown, sensitivePath: string, replacement: string): Error {
  if (!(error instanceof Error)) {
    return new GitCryptCommandError('Unknown git-crypt error.', false);
  }
  const escapedPath = sensitivePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const message = error.message.replace(new RegExp(escapedPath, 'gu'), replacement);
  if (error instanceof GitCryptCommandError) {
    return new GitCryptCommandError(message, error.unavailable, error.exitCode);
  }
  return new Error(message);
}
