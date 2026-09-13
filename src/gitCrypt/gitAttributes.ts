export type GitCryptAttributeMode = 'protect' | 'unprotect';
export type GitCryptAttributeTarget = 'file' | 'directory';

export interface GitAttributesUpdate {
  readonly contents: string;
  readonly changed: boolean;
  readonly rule: string;
}

/** Builds an exact, repository-local rule without treating path characters as globs. */
export function updateGitAttributes(
  contents: string,
  relativePath: string,
  mode: GitCryptAttributeMode,
  target: GitCryptAttributeTarget = 'file',
): GitAttributesUpdate {
  const escapedPath = escapeWildmatch(relativePath.replace(/\/$/u, ''));
  const pattern = quotePattern(`/${escapedPath}${target === 'directory' ? '/**' : ''}`);
  const protectRule = `${pattern} filter=git-crypt diff=git-crypt`;
  const unprotectRule = `${pattern} !filter !diff`;
  const desiredRule = mode === 'protect' ? protectRule : unprotectRule;
  const eol = contents.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalEol = contents.endsWith('\n');
  const lines = contents.length === 0 ? [] : contents.split(/\r?\n/u);
  let appended = false;
  let changed = false;

  if (hasFinalEol) {
    lines.pop();
  }

  let lastMatchingRule = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && [protectRule, unprotectRule].includes(line.trim())) {
      lastMatchingRule = index;
    }
  }

  if (lastMatchingRule >= 0) {
    const current = lines[lastMatchingRule];
    if (current?.trim() !== desiredRule) {
      lines[lastMatchingRule] = desiredRule;
      changed = true;
    }
  } else {
    lines.push(desiredRule);
    appended = true;
    changed = true;
  }

  if (mode === 'protect' && target === 'directory') {
    const attributesPattern = quotePattern(`/${escapedPath}/**/.gitattributes`);
    const attributesExemption = `${attributesPattern} !filter !diff`;
    const mainRuleIndex = lastLineIndex(lines, desiredRule);
    const exemptionIndex = lastLineIndex(lines, attributesExemption);
    if (exemptionIndex < mainRuleIndex) {
      lines.push(attributesExemption);
      appended = true;
      changed = true;
    }
  }

  if (!changed) {
    return { contents, changed: false, rule: desiredRule };
  }
  return {
    contents: `${lines.join(eol)}${appended || hasFinalEol ? eol : ''}`,
    changed: true,
    rule: desiredRule,
  };
}

function lastLineIndex(lines: readonly string[], rule: string): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() === rule) {
      return index;
    }
  }
  return -1;
}

function escapeWildmatch(filePath: string): string {
  return filePath.replace(/[\\*?[\]]/gu, '\\$&');
}

function quotePattern(pattern: string): string {
  let quoted = '"';
  for (const character of pattern) {
    const codePoint = character.codePointAt(0);
    if (character === '"' || character === '\\') {
      quoted += `\\${character}`;
    } else if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      quoted += `\\${codePoint.toString(8).padStart(3, '0')}`;
    } else {
      quoted += character;
    }
  }
  return `${quoted}"`;
}
