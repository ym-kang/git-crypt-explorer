import { spawn } from 'node:child_process';
import * as path from 'node:path';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class GitCommandError extends Error {
  public constructor(
    message: string,
    public readonly unavailable: boolean,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export interface GitRepositoryLocation {
  readonly root: string;
  readonly gitDir: string;
  readonly workspacePrefix: string;
}

export interface GitClientLike {
  discover(cwd: string): Promise<GitRepositoryLocation>;
  listFiles(repositoryRoot: string): Promise<readonly string[]>;
  checkFilter(
    repositoryRoot: string,
    repositoryRelativePaths: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/** Runs read-only Git queries. It never invokes git-crypt or reads file contents. */
export class GitClient implements GitClientLike {
  public constructor(private readonly executable = 'git') {}

  public async discover(cwd: string): Promise<GitRepositoryLocation> {
    const result = await this.run(
      ['-C', cwd, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-prefix'],
      cwd,
    );
    const lines = result.stdout.toString('utf8').split(/\r?\n/u);
    const root = lines[0];
    const gitDir = lines[1];

    if (!root || !gitDir) {
      throw new GitCommandError('Git returned an incomplete repository location.', false);
    }

    return {
      root: path.resolve(root),
      gitDir: path.resolve(gitDir),
      workspacePrefix: lines[2] ?? '',
    };
  }

  public async listFiles(repositoryRoot: string): Promise<readonly string[]> {
    const result = await this.run(
      ['-C', repositoryRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      repositoryRoot,
    );
    return splitNul(result.stdout);
  }

  public async checkFilter(
    repositoryRoot: string,
    repositoryRelativePaths: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (repositoryRelativePaths.length === 0) {
      return new Map();
    }

    const input = Buffer.from(`${repositoryRelativePaths.join('\0')}\0`, 'utf8');
    const result = await this.run(
      ['-C', repositoryRoot, 'check-attr', '-z', '--stdin', 'filter'],
      repositoryRoot,
      input,
    );
    return parseCheckAttrOutput(result.stdout);
  }

  private run(args: readonly string[], cwd: string, input?: Buffer): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        reject(error);
      };

      child.once('error', (error: NodeJS.ErrnoException) => {
        fail(
          new GitCommandError(
            error.code === 'ENOENT' ? 'Git is not installed or is not available on PATH.' : error.message,
            error.code === 'ENOENT',
          ),
        );
      });

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          fail(new GitCommandError('Git output exceeded the safety limit.', false));
          return;
        }
        stdout.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_OUTPUT_BYTES) {
          stderr.push(chunk);
        }
      });

      child.once('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);

        if (code !== 0) {
          const detail = stderrBuffer.toString('utf8').trim();
          reject(
            new GitCommandError(
              detail || `Git exited with code ${code ?? 'unknown'}.`,
              false,
              code ?? undefined,
            ),
          );
          return;
        }

        resolve({ stdout: stdoutBuffer, stderr: stderrBuffer });
      });

      child.stdin.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          fail(new GitCommandError(error.message, false));
        }
      });
      child.stdin.end(input);
    });
  }
}

export function parseCheckAttrOutput(output: Buffer): ReadonlyMap<string, string> {
  const fields = splitNul(output);
  const result = new Map<string, string>();

  if (fields.length % 3 !== 0) {
    throw new GitCommandError('Git returned malformed attribute data.', false);
  }

  for (let index = 0; index < fields.length; index += 3) {
    const file = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (file !== undefined && attribute === 'filter' && value !== undefined) {
      result.set(file, value);
    }
  }

  return result;
}

function splitNul(buffer: Buffer): string[] {
  const values = buffer.toString('utf8').split('\0');
  if (values.at(-1) === '') {
    values.pop();
  }
  return values;
}
