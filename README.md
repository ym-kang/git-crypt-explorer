# Git Crypt Explorer Decorations

Git Crypt Explorer Decorations makes files protected by
[git-crypt](https://github.com/AGWA/git-crypt) visible directly in the VS Code Explorer. Passive
decoration and status scanning is read-only. Explicit commands can initialize/unlock a repository
with an existing symmetric key and export the currently installed key.

## Features

- Shows a `🔒` badge on files whose effective Git `filter` attribute is `git-crypt`.
- Shows the tooltip **Protected by git-crypt**.
- Propagates the decoration to parent folders so protected content is easier to find.
- Supports multiple workspace folders and deduplicates folders belonging to the same repository.
- Refreshes after `.gitattributes`, file-list, branch, checkout, or index changes.
- Uses a repository-level cache, debounce, and batched Git calls.
- Fails quietly in non-Git folders and when Git or git-crypt is not installed.
- Reports whether git-crypt is installed and whether each repository is locally unlocked, locked,
  or not initialized.
- Initializes/unlocks a repository using a user-selected existing key.
- Exports a symmetric key to a user-selected destination with an explicit security warning.
- Initializes new repositories, locks all local keys, unlocks with GPG, and adds GPG users without
  automatic commits.

Decoration detection does not need the `git-crypt` executable because Git resolves the attributes.
The explicit initialization, lock/unlock, key export, and GPG commands do require `git-crypt`.

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
  CLI availability, local initialization state, protected file count, and warning count.
- **Git Crypt: Initialize/Unlock with Existing Key** — selects an existing symmetric key and runs
  `git-crypt unlock KEY_FILE`. This can decrypt protected working-tree files and requires a clean
  tracked working tree.
- **Git Crypt: Export Key** — runs `git-crypt export-key DESTINATION`. The exported key grants
  access to protected files and must be stored and transferred securely.
- **Git Crypt: Initialize New Repository** — generates a new default key with `git-crypt init`.
  This is only for a new repository and does not unlock data encrypted with another key.
- **Git Crypt: Unlock with GPG** — runs `git-crypt unlock` without a key-file argument, using an
  authorized GPG secret key available on the machine.
- **Git Crypt: Lock Repository** — runs `git-crypt lock --all`, re-encrypting protected working-tree
  files and removing all locally installed keys. The unsafe `--force` option is not used.
- **Git Crypt: Add GPG User (No Auto-Commit)** — grants a GPG identity access using
  `git-crypt add-gpg-user --no-commit`. Review and commit the generated `.git-crypt` files manually.

Low-level filter commands (`clean`, `smudge`, `diff`, and `cat`), legacy key commands, automatic
`status --fix`, and destructive `lock --force` are intentionally not exposed.

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
- Decoration and key-management UI currently target the default `git-crypt` filter/key. Named-key
  initialization, export, and GPG grants remain CLI-only; repository lock uses `--all` and unlock
  lets git-crypt determine the key automatically.
- Local state is inferred from git-crypt's local key store. Without an installed local key, a
  repository with matching protected files is reported as `locked`; a repository with no matching
  files is reported as `not initialized`.
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

Decoration and status scans process only repository paths, Git attribute values, CLI version, and
the presence/count of locally installed key entries. They do not read protected file or key bytes.

Key operations run only from explicit Command Palette actions after file selection and a modal
confirmation:

- Key paths are passed directly to `git-crypt` as process arguments without a shell.
- Selected key paths are masked from displayed CLI errors.
- `unlock` may decrypt protected working-tree files; git-crypt itself requires a clean tracked
  working tree before doing so.
- Exported files are changed to owner-only `0600` permissions on supported POSIX filesystems. A
  warning is shown if restrictive permissions cannot be guaranteed.
- Exporting inside the repository triggers an additional warning because the key could be
  committed accidentally.
- The extension never sends key material over the network and does not support exporting to
  standard output.
- New-key initialization, GPG access grants, lock, and unlock each require an explicit modal
  confirmation. GPG access grants always use `--no-commit` so the extension never creates commits.
