import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { GitClient } from '../../src/git/gitClient';
import {
  gitCryptTargetOperationError,
  recommendGitCryptSetup,
} from '../../src/gitCrypt/setupRecommendation';

import { test, TestContext } from 'node:test';

const execFileAsync = promisify(execFile);

test('SC-001: empty folder can be initialized and discovered as a Git repository', async (t) => {
  const folder = await createEmptyFolder(t);
  const git = new GitClient();

  assert.equal(recommendGitCryptSetup(false), 'initialize-git');

  await git.initialize(folder);
  const location = await git.discover(folder);

  assert.equal(location.root, await realpath(folder));
  assert.equal((await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: folder })).stdout.trim(), 'true');
});

test('SC-002: protected files in a locked repository recommend unlock', () => {
  assert.equal(recommendGitCryptSetup(true, 1, 'locked'), 'unlock');
});

test('SC-003: repository without targets or a local key recommends a new git-crypt key', () => {
  assert.equal(recommendGitCryptSetup(true, 0, 'not-initialized'), 'initialize-git-crypt');
});

test('SC-004: encryption target changes require an installed unlocked key', () => {
  assert.equal(
    gitCryptTargetOperationError({
      available: true,
      localState: 'locked',
      installedKeyCount: 0,
    }),
    'git-crypt is locked. Unlock the repository before changing encryption targets.',
  );
  assert.equal(
    gitCryptTargetOperationError({
      available: true,
      localState: 'unlocked',
      installedKeyCount: 1,
    }),
    undefined,
  );
  assert.equal(
    gitCryptTargetOperationError({
      available: true,
      localState: 'not-initialized',
      installedKeyCount: 0,
    }),
    'git-crypt is not initialized locally. Initialize or unlock the repository before changing encryption targets.',
  );
});

async function createEmptyFolder(t: TestContext): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'git-crypt-setup-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}
