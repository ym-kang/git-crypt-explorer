import { spawn } from 'node:child_process';
import * as path from 'node:path';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BYTES = 1024 * 1024;
const GIT_CRYPT_HEADER = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);

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

export interface GitIndexEntry {
  readonly path: string;
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
}

export interface GitClientLike {
  initialize(repositoryRoot: string): Promise<void>;
  discover(cwd: string): Promise<GitRepositoryLocation>;
  listFiles(repositoryRoot: string): Promise<readonly string[]>;
  checkFilter(
    repositoryRoot: string,
    repositoryRelativePaths: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  listIndexEntries(repositoryRoot: string): Promise<readonly GitIndexEntry[]>;
  checkBlobEncryption(
    repositoryRoot: string,
    objectIds: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>>;
}

interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/** Runs Git repository queries and initialization. It never invokes git-crypt or reads working-tree file contents. */
export class GitClient implements GitClientLike {
  public constructor(private readonly executable = 'git') {}

  public async initialize(repositoryRoot: string): Promise<void> {
    await this.run(['-C', repositoryRoot, 'init'], repositoryRoot);
  }

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

  public async listIndexEntries(repositoryRoot: string): Promise<readonly GitIndexEntry[]> {
    const result = await this.run(
      ['-C', repositoryRoot, 'ls-files', '--stage', '-z'],
      repositoryRoot,
    );
    return parseIndexEntries(result.stdout);
  }

  public checkBlobEncryption(
    repositoryRoot: string,
    objectIds: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const uniqueObjectIds = [...new Set(objectIds)];
    if (uniqueObjectIds.length === 0) {
      return Promise.resolve(new Map());
    }
    return inspectBlobsWithCatFile(this.executable, repositoryRoot, uniqueObjectIds);
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

export function parseIndexEntries(output: Buffer): readonly GitIndexEntry[] {
  const entries: GitIndexEntry[] = [];
  for (const record of splitNul(output)) {
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new GitCommandError('Git returned malformed index data.', false);
    }
    const metadata = record.slice(0, tab).split(' ');
    const mode = metadata[0];
    const objectId = metadata[1];
    const stageText = metadata[2];
    const stage = Number(stageText);
    if (!mode || !objectId || !stageText || !Number.isInteger(stage)) {
      throw new GitCommandError('Git returned malformed index metadata.', false);
    }
    entries.push({ mode, objectId, stage, path: record.slice(tab + 1) });
  }
  return entries;
}

function inspectBlobsWithCatFile(
  executable: string,
  repositoryRoot: string,
  objectIds: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-C', repositoryRoot, 'cat-file', '--batch'], {
      cwd: repositoryRoot,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const results = new Map<string, boolean>();
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let objectIndex = 0;
    let headerBuffer = Buffer.alloc(0);
    let awaitingContentDelimiter = false;
    let current:
      | {
          readonly requestedId: string;
          remaining: number;
          readonly prefix: Buffer;
          prefixBytes: number;
        }
      | undefined;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      current?.prefix.fill(0);
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

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_ERROR_BYTES) {
        stderr.push(chunk);
      }
    });

    child.stdout.on('data', (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length && !settled) {
        if (awaitingContentDelimiter) {
          if (chunk[offset] !== 0x0a) {
            fail(new GitCommandError('Git returned malformed batch blob data.', false));
            return;
          }
          awaitingContentDelimiter = false;
          offset += 1;
          continue;
        }

        if (current) {
          const available = Math.min(current.remaining, chunk.length - offset);
          const prefixAvailable = Math.min(
            GIT_CRYPT_HEADER.length - current.prefixBytes,
            available,
          );
          if (prefixAvailable > 0) {
            chunk.copy(
              current.prefix,
              current.prefixBytes,
              offset,
              offset + prefixAvailable,
            );
            current.prefixBytes += prefixAvailable;
          }
          current.remaining -= available;
          offset += available;

          if (current.remaining === 0) {
            const encrypted =
              current.prefixBytes === GIT_CRYPT_HEADER.length &&
              current.prefix.equals(GIT_CRYPT_HEADER);
            results.set(current.requestedId, encrypted);
            current.prefix.fill(0);
            current = undefined;
            objectIndex += 1;
            awaitingContentDelimiter = true;
          }
          continue;
        }

        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) {
          headerBuffer = Buffer.concat([headerBuffer, chunk.subarray(offset)]);
          if (headerBuffer.length > 256) {
            fail(new GitCommandError('Git returned an oversized batch header.', false));
          }
          return;
        }

        const header = Buffer.concat([headerBuffer, chunk.subarray(offset, newline)]).toString(
          'ascii',
        );
        headerBuffer = Buffer.alloc(0);
        offset = newline + 1;
        const requestedId = objectIds[objectIndex];
        if (!requestedId) {
          fail(new GitCommandError('Git returned unexpected batch output.', false));
          return;
        }
        if (header.endsWith(' missing')) {
          results.set(requestedId, false);
          objectIndex += 1;
          continue;
        }
        const fields = header.split(' ');
        const type = fields[1];
        const size = Number(fields[2]);
        if (!type || !Number.isSafeInteger(size) || size < 0) {
          fail(new GitCommandError('Git returned malformed batch metadata.', false));
          return;
        }
        current = {
          requestedId,
          remaining: size,
          prefix: Buffer.alloc(GIT_CRYPT_HEADER.length),
          prefixBytes: 0,
        };
        if (size === 0) {
          results.set(requestedId, false);
          current.prefix.fill(0);
          current = undefined;
          objectIndex += 1;
          awaitingContentDelimiter = true;
        }
      }
    });

    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      current?.prefix.fill(0);
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        reject(
          new GitCommandError(
            detail || `Git cat-file exited with code ${code ?? 'unknown'}.`,
            false,
            code ?? undefined,
          ),
        );
        return;
      }
      if (
        objectIndex !== objectIds.length ||
        current !== undefined ||
        headerBuffer.length > 0 ||
        awaitingContentDelimiter
      ) {
        reject(new GitCommandError('Git returned incomplete batch blob data.', false));
        return;
      }
      resolve(results);
    });

    child.stdin.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        fail(new GitCommandError(error.message, false));
      }
    });
    child.stdin.end(`${objectIds.join('\n')}\n`, 'ascii');
  });
}

function splitNul(buffer: Buffer): string[] {
  const values = buffer.toString('utf8').split('\0');
  if (values.at(-1) === '') {
    values.pop();
  }
  return values;
}
