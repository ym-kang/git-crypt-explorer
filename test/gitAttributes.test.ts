import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { promisify } from 'node:util';
import { updateGitAttributes } from '../src/gitCrypt/gitAttributes';

const execFileAsync = promisify(execFile);

test('adds an exact git-crypt rule for a file', () => {
  const update = updateGitAttributes('*.txt text\n', 'secrets/api key.json', 'protect');

  assert.equal(
    update.contents,
    '*.txt text\n"/secrets/api key.json" filter=git-crypt diff=git-crypt\n',
  );
  assert.equal(update.changed, true);
});

test('replaces the generated override when protection is toggled', () => {
  const protectedAttributes = updateGitAttributes('', 'secret.env', 'protect').contents;
  const unprotected = updateGitAttributes(protectedAttributes, 'secret.env', 'unprotect');

  assert.equal(unprotected.contents, '"/secret.env" !filter !diff\n');
  assert.equal(unprotected.changed, true);
});

test('does not duplicate an already-effective exact rule', () => {
  const contents = '"/secret.env" filter=git-crypt diff=git-crypt\n';

  assert.deepEqual(updateGitAttributes(contents, 'secret.env', 'protect'), {
    contents,
    changed: false,
    rule: '"/secret.env" filter=git-crypt diff=git-crypt',
  });
});

test('preserves CRLF endings when replacing a rule', () => {
  const update = updateGitAttributes(
    '*.env filter=git-crypt\r\n"/public.env" !filter !diff\r\n',
    'public.env',
    'protect',
  );

  assert.equal(
    update.contents,
    '*.env filter=git-crypt\r\n"/public.env" filter=git-crypt diff=git-crypt\r\n',
  );
});

test('quotes glob syntax, backslashes, quotes, and control characters in paths', () => {
  const update = updateGitAttributes('', 'a*b?[x]\\c"d\t.env', 'protect');

  assert.equal(
    update.rule,
    '"/a\\\\*b\\\\?\\\\[x\\\\]\\\\\\\\c\\"d\\011.env" filter=git-crypt diff=git-crypt',
  );
});

test('an exact rule does not match another filename when interpreted by Git', async (t) => {
  const root = await createRepository(t);
  const literalName = 'a*b?[x].txt';
  const globMatchName = 'axbyx.txt';
  const attributes = updateGitAttributes('', literalName, 'protect').contents;
  await writeFile(path.join(root, '.gitattributes'), attributes, 'utf8');
  await writeFile(path.join(root, literalName), 'literal\n', 'utf8');
  await writeFile(path.join(root, globMatchName), 'other\n', 'utf8');

  const literal = await execFileAsync('git', ['check-attr', 'filter', '--', literalName], {
    cwd: root,
  });
  const other = await execFileAsync('git', ['check-attr', 'filter', '--', globMatchName], {
    cwd: root,
  });

  assert.match(literal.stdout, /filter: git-crypt/u);
  assert.match(other.stdout, /filter: unspecified/u);
});

test('an unprotect rule overrides a broader git-crypt rule only for that file', async (t) => {
  const root = await createRepository(t);
  const attributes = updateGitAttributes(
    '*.secret filter=git-crypt diff=git-crypt\n',
    'public.secret',
    'unprotect',
  ).contents;
  await writeFile(path.join(root, '.gitattributes'), attributes, 'utf8');
  await writeFile(path.join(root, 'public.secret'), 'public\n', 'utf8');
  await writeFile(path.join(root, 'private.secret'), 'private\n', 'utf8');

  const publicFile = await execFileAsync('git', ['check-attr', 'filter', '--', 'public.secret'], {
    cwd: root,
  });
  const privateFile = await execFileAsync('git', ['check-attr', 'filter', '--', 'private.secret'], {
    cwd: root,
  });

  assert.match(publicFile.stdout, /filter: unspecified/u);
  assert.match(privateFile.stdout, /filter: git-crypt/u);
});

test('a directory rule protects descendants but excludes nested attribute files', async (t) => {
  const root = await createRepository(t);
  await mkdir(path.join(root, 'secrets', 'nested'), { recursive: true });
  const attributes = updateGitAttributes('', 'secrets', 'protect', 'directory').contents;
  await writeFile(path.join(root, '.gitattributes'), attributes, 'utf8');
  await writeFile(path.join(root, 'secrets', 'token.txt'), 'secret\n', 'utf8');
  await writeFile(path.join(root, 'secrets', 'nested', '.gitattributes'), '', 'utf8');
  await writeFile(path.join(root, 'public.txt'), 'public\n', 'utf8');

  const protectedFile = await checkFilter(root, 'secrets/token.txt');
  const attributesFile = await checkFilter(root, 'secrets/nested/.gitattributes');
  const publicFile = await checkFilter(root, 'public.txt');

  assert.match(protectedFile, /filter: git-crypt/u);
  assert.match(attributesFile, /filter: unspecified/u);
  assert.match(publicFile, /filter: unspecified/u);
  assert.equal(
    attributes,
    '"/secrets/**" filter=git-crypt diff=git-crypt\n' +
      '"/secrets/**/.gitattributes" !filter !diff\n',
  );
});

test('a directory removal overrides a broad rule for all descendants', async (t) => {
  const root = await createRepository(t);
  await mkdir(path.join(root, 'public'), { recursive: true });
  const attributes = updateGitAttributes(
    '*.secret filter=git-crypt diff=git-crypt\n',
    'public',
    'unprotect',
    'directory',
  ).contents;
  await writeFile(path.join(root, '.gitattributes'), attributes, 'utf8');
  await writeFile(path.join(root, 'public', 'visible.secret'), 'public\n', 'utf8');
  await writeFile(path.join(root, 'private.secret'), 'private\n', 'utf8');

  assert.match(await checkFilter(root, 'public/visible.secret'), /filter: unspecified/u);
  assert.match(await checkFilter(root, 'private.secret'), /filter: git-crypt/u);
});

test('reapplying a directory rule does not duplicate its attribute exemption', () => {
  const first = updateGitAttributes('', 'secrets', 'protect', 'directory');
  const second = updateGitAttributes(first.contents, 'secrets', 'protect', 'directory');

  assert.equal(second.changed, false);
  assert.equal(second.contents, first.contents);
});

async function createRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-crypt-attributes-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

async function checkFilter(root: string, filePath: string): Promise<string> {
  const result = await execFileAsync('git', ['check-attr', 'filter', '--', filePath], {
    cwd: root,
  });
  return result.stdout;
}
