import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test, TestContext } from 'node:test';
import {
  GitClient,
  GitClientLike,
  GitIndexEntry,
  GitRepositoryLocation,
} from '../src/git/gitClient';
import { GitCryptService } from '../src/gitCrypt/gitCryptService';

const execFileAsync = promisify(execFile);

test('classifies a normal file as none', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.secret filter=git-crypt\n',
    'README.md': 'public fixture\n',
  });
  const service = await initialize(root);

  assert.equal(service.getStatus(path.join(root, 'README.md')), 'none');
  assert.equal(service.getWorkspaceStatus().repositories[0]?.protectedFiles, 0);
});

test('classifies a git-crypt target with an encrypted index blob as encrypted', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.secret filter=git-crypt diff=git-crypt\n',
    'config.secret': 'fixture\n',
  });
  await stageBlob(root, 'config.secret', true);
  const service = await initialize(root);

  assert.equal(service.getStatus(path.join(root, 'config.secret')), 'encrypted');
  assert.equal(service.getWorkspaceStatus().repositories[0]?.gitCryptDetected, true);
  assert.equal(service.getWorkspaceStatus().repositories[0]?.encryptedIndexFiles, 1);
});

test('warns when a git-crypt target is not present in the index', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.secret filter=git-crypt\n',
    'config.secret': 'fixture\n',
  });
  const service = await initialize(root);

  assert.equal(service.getStatus(path.join(root, 'config.secret')), 'warning');
  assert.match(
    service.getStatusDetail(path.join(root, 'config.secret')) ?? '',
    /not present in the Git index/u,
  );
});

test('warns when a git-crypt target has a plaintext index blob', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.secret filter=git-crypt\n',
    'config.secret': 'fixture\n',
  });
  await stageBlob(root, 'config.secret', false);
  const service = await initialize(root);

  assert.equal(service.getStatus(path.join(root, 'config.secret')), 'warning');
  assert.match(
    service.getStatusDetail(path.join(root, 'config.secret')) ?? '',
    /unencrypted Git index blob/u,
  );
});

test('supports a repository without .gitattributes', async (t) => {
  const root = await createRepository(t, { 'plain.txt': 'fixture\n' });
  const service = await initialize(root);

  assert.equal(service.getStatus(path.join(root, 'plain.txt')), 'none');
  assert.equal(service.getWorkspaceStatus().repositories[0]?.gitCryptDetected, false);
});

test('handles a non-Git workspace without throwing', async (t) => {
  const root = await createDirectory(t);
  const service = await initialize(root);

  assert.equal(service.getWorkspaceStatus().repositories.length, 0);
  assert.equal(service.getWorkspaceStatus().nonGitFolders, 1);
});

test('handles an unavailable Git command without throwing', async (t) => {
  const root = await createDirectory(t);
  const service = new GitCryptService(new GitClient(path.join(root, 'missing-git')));

  await service.initialize([root]);

  assert.equal(service.getWorkspaceStatus().repositories.length, 0);
  assert.equal(service.getWorkspaceStatus().gitUnavailable, true);
});

test('handles a protected path containing spaces', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.env filter=git-crypt\n',
    'config/production secret.env': 'fixture\n',
  });
  await stageBlob(root, 'config/production secret.env', true);
  const service = await initialize(root);

  assert.equal(
    service.getStatus(path.join(root, 'config', 'production secret.env')),
    'encrypted',
  );
});

test('uses nested .gitattributes rules resolved by Git', async (t) => {
  const root = await createRepository(t, {
    'nested/.gitattributes': '*.json filter=git-crypt\n',
    'nested/credentials.json': 'fixture\n',
    'outside.json': 'fixture\n',
  });
  await stageBlob(root, 'nested/credentials.json', true);
  const service = await initialize(root);

  assert.equal(service.getStatus(path.join(root, 'nested', 'credentials.json')), 'encrypted');
  assert.equal(service.getStatus(path.join(root, 'outside.json')), 'none');
});

test('maps a repository subdirectory opened as the workspace root', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.env filter=git-crypt\n',
    'nested/config.env': 'fixture\n',
  });
  await stageBlob(root, 'nested/config.env', true);
  const service = await initialize(path.join(root, 'nested'));

  assert.equal(service.getStatus(path.join(root, 'nested', 'config.env')), 'encrypted');
});

test('honors attribute override rules resolved by Git', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.env filter=git-crypt\npublic.env -filter\n',
    'private.env': 'fixture\n',
    'public.env': 'fixture\n',
  });
  await stageBlob(root, 'private.env', true);
  const service = await initialize(root);

  assert.equal(service.getStatus(path.join(root, 'private.env')), 'encrypted');
  assert.equal(service.getStatus(path.join(root, 'public.env')), 'none');
});

test('rebuilds cached status after .gitattributes changes', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.env filter=git-crypt\n',
    'config.env': 'fixture\n',
  });
  await stageBlob(root, 'config.env', true);
  const service = await initialize(root);
  assert.equal(service.getStatus(path.join(root, 'config.env')), 'encrypted');

  await writeFile(path.join(root, '.gitattributes'), '*.env -filter\n', 'utf8');
  await service.refreshAll();

  assert.equal(service.getStatus(path.join(root, 'config.env')), 'none');
});

test('keeps independent snapshots for a multi-root workspace', async (t) => {
  const first = await createRepository(t, {
    '.gitattributes': '*.key filter=git-crypt\n',
    'first.key': 'fixture\n',
  });
  await stageBlob(first, 'first.key', true);
  const second = await createRepository(t, {
    'second.txt': 'fixture\n',
  });
  const service = new GitCryptService();

  await service.initialize([first, second]);

  assert.equal(service.getWorkspaceStatus().repositories.length, 2);
  assert.equal(service.getStatus(path.join(first, 'first.key')), 'encrypted');
  assert.equal(service.getStatus(path.join(second, 'second.txt')), 'none');
});

test('checks all repository paths in one attribute batch', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.secret filter=git-crypt\n',
    'one.secret': 'fixture\n',
    'two.secret': 'fixture\n',
    'three.txt': 'fixture\n',
  });
  const countingGit = new CountingGitClient();
  const service = new GitCryptService(countingGit);

  await service.initialize([root]);

  assert.equal(countingGit.checkFilterCalls, 1);
  assert.equal(countingGit.lastBatchSize, 4);
});

test('checks each index object once and reuses the repository object-id cache', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.secret filter=git-crypt\n',
    'one.secret': 'same fixture\n',
    'two.secret': 'same fixture\n',
  });
  await stageBlob(root, 'one.secret', true);
  await stageBlob(root, 'two.secret', true);
  const countingGit = new CountingGitClient();
  const service = new GitCryptService(countingGit);

  await service.initialize([root]);
  await service.refreshAll();

  assert.equal(countingGit.nonEmptyBlobChecks, 1);
  assert.equal(countingGit.checkedObjectIds[0]?.length, 1);
});

test('detects a blob produced by a real git-crypt clean filter when available', async (t) => {
  const root = await createRepository(t, {
    '.gitattributes': '*.secret filter=git-crypt diff=git-crypt\n',
    'config.secret': 'test-only plaintext fixture\n',
  });
  try {
    await execFileAsync('git-crypt', ['--version'], { cwd: root });
  } catch {
    t.skip('git-crypt is not installed');
    return;
  }
  await execFileAsync('git-crypt', ['init'], { cwd: root });
  await execFileAsync('git', ['add', '--', '.gitattributes', 'config.secret'], { cwd: root });

  const service = await initialize(root);

  assert.equal(service.getStatus(path.join(root, 'config.secret')), 'encrypted');
  assert.equal(service.getWorkspaceStatus().repositories[0]?.warnings, 0);
});

class CountingGitClient implements GitClientLike {
  private readonly delegate = new GitClient();
  public checkFilterCalls = 0;
  public lastBatchSize = 0;
  public nonEmptyBlobChecks = 0;
  public checkedObjectIds: string[][] = [];

  public discover(cwd: string): Promise<GitRepositoryLocation> {
    return this.delegate.discover(cwd);
  }

  public listFiles(repositoryRoot: string): Promise<readonly string[]> {
    return this.delegate.listFiles(repositoryRoot);
  }

  public checkFilter(
    repositoryRoot: string,
    repositoryRelativePaths: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    this.checkFilterCalls += 1;
    this.lastBatchSize = repositoryRelativePaths.length;
    return this.delegate.checkFilter(repositoryRoot, repositoryRelativePaths);
  }

  public listIndexEntries(repositoryRoot: string): Promise<readonly GitIndexEntry[]> {
    return this.delegate.listIndexEntries(repositoryRoot);
  }

  public checkBlobEncryption(
    repositoryRoot: string,
    objectIds: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    if (objectIds.length > 0) {
      this.nonEmptyBlobChecks += 1;
      this.checkedObjectIds.push([...objectIds]);
    }
    return this.delegate.checkBlobEncryption(repositoryRoot, objectIds);
  }
}

async function initialize(root: string): Promise<GitCryptService> {
  const service = new GitCryptService();
  await service.initialize([root]);
  return service;
}

async function createRepository(
  t: TestContext,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await createDirectory(t);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

async function createDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-crypt-explorer-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function stageBlob(root: string, relativePath: string, encrypted: boolean): Promise<void> {
  if (encrypted) {
    const header = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);
    await writeFile(
      path.join(root, relativePath),
      Buffer.concat([header, Buffer.from('test-only encrypted payload')]),
    );
  }
  const { stdout } = await execFileAsync(
    'git',
    ['hash-object', '-w', '--no-filters', '--', relativePath],
    { cwd: root },
  );
  const objectId = stdout.trim();
  await execFileAsync(
    'git',
    ['update-index', '--add', '--cacheinfo', `100644,${objectId},${relativePath}`],
    { cwd: root },
  );
}
