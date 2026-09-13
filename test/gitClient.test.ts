import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitCommandError, parseCheckAttrOutput } from '../src/git/gitClient';

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
