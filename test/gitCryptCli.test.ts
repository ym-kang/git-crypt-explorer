import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test, TestContext } from 'node:test';
import {
  CommandExecutor,
  CommandResult,
  GitCryptCli,
  GitCryptCommandError,
} from '../src/gitCrypt/gitCryptCli';

const execFileAsync = promisify(execFile);

test('reports not-initialized, locked, and unlocked local states', async (t) => {
  const root = await createDirectory(t);
  const gitDir = path.join(root, '.git');
  const cli = new GitCryptCli('git-crypt', new StaticExecutor('git-crypt 0.8.0\n'));

  assert.equal((await cli.inspect(root, gitDir, false)).localState, 'not-initialized');
  assert.equal((await cli.inspect(root, gitDir, true)).localState, 'locked');

  const keys = path.join(gitDir, 'git-crypt', 'keys');
  await mkdir(keys, { recursive: true });
  await writeFile(path.join(keys, 'default'), 'test-only key placeholder', 'utf8');
  const status = await cli.inspect(root, gitDir, true);

  assert.equal(status.localState, 'unlocked');
  assert.equal(status.installedKeyCount, 1);
  assert.equal(status.version, 'git-crypt 0.8.0');
});

test('reports an unavailable git-crypt executable without throwing', async (t) => {
  const root = await createDirectory(t);
  const executor: CommandExecutor = {
    run: async () => {
      throw new GitCryptCommandError('missing', true);
    },
  };

  const status = await new GitCryptCli('missing-git-crypt', executor).inspect(
    root,
    path.join(root, '.git'),
    false,
  );

  assert.equal(status.available, false);
  assert.equal(status.localState, 'not-initialized');
});

test('passes key paths as argv and masks them in unlock errors', async (t) => {
  const root = await createDirectory(t);
  const keyPath = path.join(root, 'folder with spaces', 'secret.key');
  const executor = new RecordingExecutor(async (_executable, args) => {
    throw new GitCryptCommandError(`Unable to open ${args[1]}`, false, 1);
  });

  await assert.rejects(
    new GitCryptCli('git-crypt', executor).unlockWithKey(root, keyPath),
    (error: unknown) => {
      assert.ok(error instanceof GitCryptCommandError);
      assert.equal(error.message.includes(keyPath), false);
      assert.match(error.message, /<key file>/u);
      return true;
    },
  );
  assert.deepEqual(executor.calls[0]?.args, ['unlock', keyPath]);
});

test('exports through git-crypt and restricts permissions when supported', async (t) => {
  const root = await createDirectory(t);
  const destination = path.join(root, 'exported key.key');
  const executor = new RecordingExecutor(async (_executable, args) => {
    const outputPath = args[1];
    assert.ok(outputPath);
    await writeFile(outputPath, 'test-only exported key', 'utf8');
    return { stdout: '', stderr: '' };
  });

  const restricted = await new GitCryptCli('git-crypt', executor).exportKey(root, destination);

  assert.deepEqual(executor.calls[0]?.args, ['export-key', destination]);
  assert.equal(restricted, process.platform !== 'win32');
  if (process.platform !== 'win32') {
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
  }
});

test('uses safe argv for init, GPG unlock, lock, and add-gpg-user', async (t) => {
  const root = await createDirectory(t);
  const executor = new RecordingExecutor(async () => ({ stdout: '', stderr: '' }));
  const cli = new GitCryptCli('git-crypt', executor);

  await cli.initializeRepository(root);
  await cli.unlockWithGpg(root);
  await cli.lockRepository(root);
  await cli.addGpgUser(root, '  developer@example.com  ');

  assert.deepEqual(
    executor.calls.map((call) => call.args),
    [
      ['init'],
      ['unlock'],
      ['lock', '--all'],
      ['add-gpg-user', '--no-commit', 'developer@example.com'],
    ],
  );
});

test('does not allow an empty GPG user ID', async (t) => {
  const root = await createDirectory(t);
  const executor = new RecordingExecutor(async () => ({ stdout: '', stderr: '' }));

  await assert.rejects(
    new GitCryptCli('git-crypt', executor).addGpgUser(root, '   '),
    /GPG user ID is required/u,
  );
  assert.equal(executor.calls.length, 0);
});

test('rejects a GPG user ID that could be interpreted as an option', async (t) => {
  const root = await createDirectory(t);
  const executor = new RecordingExecutor(async () => ({ stdout: '', stderr: '' }));

  await assert.rejects(
    new GitCryptCli('git-crypt', executor).addGpgUser(root, '--trusted'),
    /unsupported characters/u,
  );
  assert.equal(executor.calls.length, 0);
});

test('real git-crypt supports init, export, lock, and unlock workflow', async (t) => {
  const root = await createDirectory(t);
  try {
    await execFileAsync('git-crypt', ['--version'], { cwd: root });
  } catch {
    t.skip('git-crypt is not installed');
    return;
  }

  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  const gitDir = path.join(root, '.git');
  const cli = new GitCryptCli();
  await cli.initializeRepository(root);
  assert.equal((await cli.inspect(root, gitDir, true)).localState, 'unlocked');

  const exportedKey = path.join(root, 'test-export.key');
  await cli.exportKey(root, exportedKey);
  assert.ok((await stat(exportedKey)).size > 0);

  await cli.lockRepository(root);
  assert.equal((await cli.inspect(root, gitDir, true)).localState, 'locked');

  await cli.unlockWithKey(root, exportedKey);
  assert.equal((await cli.inspect(root, gitDir, true)).localState, 'unlocked');
});

class StaticExecutor implements CommandExecutor {
  public constructor(private readonly version: string) {}

  public async run(): Promise<CommandResult> {
    return { stdout: this.version, stderr: '' };
  }
}

class RecordingExecutor implements CommandExecutor {
  public readonly calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];

  public constructor(
    private readonly handler: (
      executable: string,
      args: readonly string[],
      cwd: string,
    ) => Promise<CommandResult>,
  ) {}

  public run(executable: string, args: readonly string[], cwd: string): Promise<CommandResult> {
    this.calls.push({ executable, args, cwd });
    return this.handler(executable, args, cwd);
  }
}

async function createDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-crypt-cli-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}
