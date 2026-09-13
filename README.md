# Git Crypt Explorer Decorations

Git Crypt Explorer Decorations makes files protected by
[git-crypt](https://github.com/AGWA/git-crypt) visible directly in the VS Code Explorer.
It is a read-only visualization extension: it never reads secret file contents, accesses keys,
or encrypts/decrypts files.

## Features

- Shows a `🔒` badge on files whose effective Git `filter` attribute is `git-crypt`.
- Shows the tooltip **Protected by git-crypt**.
- Propagates the decoration to parent folders so protected content is easier to find.
- Supports multiple workspace folders and deduplicates folders belonging to the same repository.
- Refreshes after `.gitattributes`, file-list, branch, checkout, or index changes.
- Uses a repository-level cache, debounce, and batched Git calls.
- Fails quietly in non-Git folders and when Git or git-crypt is not installed.

The extension does not need the `git-crypt` executable. Git itself resolves the attributes;
`git-crypt` is only needed by your normal repository workflow.

## Installation

From a packaged VSIX:

1. Open **Extensions: Install from VSIX...** in the Command Palette.
2. Select the generated `.vsix` file.
3. Open a local git-crypt repository.

For development, see [Development](#development).

## Use in a git-crypt repository

Keep the repository's normal `.gitattributes` rules, for example:

```gitattributes
*.env filter=git-crypt diff=git-crypt
secrets/** filter=git-crypt diff=git-crypt
public.env -filter -diff
```

No extension-specific configuration file is required. The effective attribute is resolved by
Git, including nested `.gitattributes` files and override rules.

## Explorer decorations

| Decoration | Meaning | Tooltip |
| --- | --- | --- |
| `🔒` | Effective `filter` value is `git-crypt` | Protected by git-crypt |
| none | File is not a git-crypt target | — |

The internal status model also reserves `warning`, but warning detection is not enabled in the
MVP. VS Code's `FileDecoration` badge accepts a very short string, not a `ThemeIcon`, so a lock
character is used instead of a Codicon.

## Screenshot

Add an Explorer screenshot here before publishing:

<!-- Suggested file: images/git-crypt-explorer.png -->

> Screenshot placeholder: Explorer showing lock badges next to protected files.

## Commands

- **Git Crypt: Refresh Decorations** — rediscovers the workspace and rebuilds every repository
  cache.
- **Git Crypt: Show Status** — opens an output report with Git detection, git-crypt detection,
  protected file count, and warning count.

## Settings

```json
{
  "gitCryptDecorations.enabled": true
}
```

Disabling the setting hides decorations. It does not modify the repository.

## How detection works

At refresh time, each repository is queried with:

```text
git ls-files -z --cached --others --exclude-standard
git check-attr -z --stdin filter
```

The first command lists tracked and non-ignored untracked files. All paths are sent to one
`git check-attr` process using NUL delimiters. A file is protected only when Git reports the exact
value `git-crypt`. Explorer rendering only performs an in-memory map lookup; it never starts a
process per file.

The cache is atomically replaced after a successful scan; the last good snapshot is retained if
Git temporarily fails. Changes are debounced for 300 ms.
Watchers cover `.gitattributes`, file creation/deletion, and Git `HEAD`, index, packed refs, and
refs. The manual refresh also rediscovers workspace repositories.

## Limitations

- Warning detection is reserved for a later release and currently reports zero warnings.
- `git-crypt detected` means at least one scanned file currently resolves to
  `filter=git-crypt`; a rule that matches no files cannot be detected without parsing attributes.
- Ignored, untracked files are not scanned. Tracked ignored files are scanned.
- A workspace folder is associated with its containing Git repository. Independently nested Git
  repositories are not auto-discovered unless opened as their own workspace folder.
- Only local/file-scheme workspaces are supported because Git CLI execution requires filesystem
  paths. In Remote Development, the extension runs in the workspace extension host.
- The badge glyph depends on the UI font and platform rendering.
- Very large repositories are bounded by a 64 MiB Git output safety limit.

## Development

Requirements: Node.js 20 or later, npm, Git, and VS Code.

```bash
npm install
npm run compile
npm test
```

Press `F5` in VS Code and choose **Run Extension** to launch an Extension Development Host.
Open a test git-crypt repository there.

For continuous compilation:

```bash
npm run watch
```

## Packaging a VSIX

The project includes `@vscode/vsce` as a development dependency:

```bash
npm install
npx @vscode/vsce package
```

The equivalent npm script is `npm run package`. The resulting `.vsix` is created in the project
root.

## Security

Only repository paths and Git attribute values are processed. File contents, git-crypt keys, and
GPG keys are never read or logged. The extension issues only read-only Git inspection commands.
