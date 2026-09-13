import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test, TestContext } from 'node:test';
import {
  GitClient,
  GitCommandError,
  parseCheckAttrOutput,
  parseIndexEntries,
} from '../src/git/gitClient';

const execFileAsync = promisify(execFile);

test('parses NUL-delimited git check-attr output', () => {
  const output = Buffer.from(
    'file with spaces.env\0filter\0git-crypt\0plain.txt\0filter\0unspecified\0',
  );

  const result = parseCheckAttrOutput(output);

  assert.equal(result.get('file with spaces.env'), 'git-crypt');
  assert.equal(result.get('plain.txt'), 'unspecified');
});

test('rejects malformed check-attr output', () => {
  assert.throws(
    () => parseCheckAttrOutput(Buffer.from('file\0filter\0')),
    GitCommandError,
  );
});

test('parses NUL-delimited index entries without splitting spaces or tabs in paths', () => {
  const objectId = '0123456789012345678901234567890123456789';
  const output = Buffer.from(`100644 ${objectId} 0\tfolder/a file\twith tab.env\0`);

  assert.deepEqual(parseIndexEntries(output), [
    {
      mode: '100644',
      objectId,
      stage: 0,
      path: 'folder/a file\twith tab.env',
    },
  ]);
});

test('checks encrypted, plaintext, and empty blobs in one cat-file batch', async (t) => {
  const root = await createRepository(t);
  const magic = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);
  const encryptedId = await writeBlob(
    root,
    'encrypted.bin',
    Buffer.concat([magic, Buffer.from('x')]),
  );
  const plaintextId = await writeBlob(root, 'plain.bin', Buffer.from('plain fixture'));
  const emptyId = await writeBlob(root, 'empty.bin', Buffer.alloc(0));

  const result = await new GitClient().checkBlobEncryption(root, [
    encryptedId,
    plaintextId,
    emptyId,
    encryptedId,
  ]);

  assert.equal(result.size, 3);
  assert.equal(result.get(encryptedId), true);
  assert.equal(result.get(plaintextId), false);
  assert.equal(result.get(emptyId), false);
});

async function createRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-client-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

async function writeBlob(root: string, name: string, contents: Buffer): Promise<string> {
  await writeFile(path.join(root, name), contents);
  const { stdout } = await execFileAsync(
    'git',
    ['hash-object', '-w', '--no-filters', '--', name],
    { cwd: root },
  );
  return stdout.trim();
}
