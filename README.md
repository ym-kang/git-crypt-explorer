# Git Crypt Explorer

Git Crypt Explorer makes files protected by
[git-crypt](https://github.com/AGWA/git-crypt) visible directly in the VS Code Explorer. Passive
decoration and status scanning is read-only. Explicit commands can initialize/unlock a repository
with an existing symmetric key and export the currently installed key.

## Features

- Shows a `🔒` badge when a file or folder is fully protected by `git-crypt`, and a compact `🔒n`
  badge on a folder containing `n` encrypted files alongside unprotected files (`🔒+` for 10 or
  more).
- Shows a `!` warning when a target is untracked, conflicted, non-regular in the index, or has a
  plaintext index blob.
- Adds a dedicated Activity Bar view with repository summaries, protected files, and warnings.
- Adds or removes file and folder encryption targets from the Explorer context menu.
- Adds a `Show Indexed Ciphertext` context-menu command for encrypted files, displaying a bounded
  read-only hex preview of the Git index blob.
- Decorates folders directly so full and partial protection can be distinguished.
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

The repository also contains an IntelliJ Platform implementation in
[`intellij-plugin/`](intellij-plugin/). It is designed as a shared JetBrains IDE plugin and
supports PyCharm without requiring Python-specific APIs.

## Use in a git-crypt repository

Keep the repository's normal `.gitattributes` rules, for example:

```gitattributes
*.env filter=git-crypt diff=git-crypt
secrets/** filter=git-crypt diff=git-crypt
public.env !filter !diff
```

No extension-specific configuration file is required. The effective attribute is resolved by
Git, including nested `.gitattributes` files and override rules.

## Activity Bar

Open **Git Crypt Explorer** from the Activity Bar to inspect every repository in the workspace.

Use the view action in the panel header to switch between **List View** (repository → file list)
and **Tree View** (repository → folder hierarchy → file). The selected view is remembered per VS
Code workspace. List View shows encrypted files directly under each repository and keeps warnings
in a separate group. Tree View opens with all repositories and folders expanded; use the **Expand
All** and **Collapse All** header actions to change the expansion state.
Each repository shows files whose Git index blobs are encrypted and files that need attention.
Select a file to open it, use the title buttons to refresh or show the detailed status report, and
use the **...** menu for initialization, lock/unlock, key export, and GPG commands. The Activity Bar
badge shows the total warning count.

Startup and refresh diagnostics are written to the `Git Crypt Decorations` log channel. If the
panel causes a problem while a project is opening, check that channel in **View → Output**, or use
`Developer: Open Logs Folder` and inspect the current Extension Host log.

## Explorer decorations

| Decoration | Meaning | Tooltip |
| --- | --- | --- |
| `🔒` | `filter=git-crypt` and the stage-0 index blob has the git-crypt header | Protected by git-crypt (encrypted in Git index) |
| `🔒n` / `🔒+` | Folder contains encrypted files and at least one unprotected file | Exact number of encrypted files below this folder |
| `!` | git-crypt target, but its index entry is missing, conflicted, non-regular, or plaintext | The detected index problem |
| none | File is not a git-crypt target | — |

The check concerns the staged/index copy, which is what a commit would contain. In an unlocked
repository the working-tree file can remain plaintext while still showing `🔒`, because its index
blob is encrypted. VS Code's `FileDecoration` badge is intended for very short strings, so the
lock/count badge is kept compact rather than using a full custom icon.

## Screenshots

The Explorer shows lock decorations for protected files and folders:

![VS Code Explorer showing git-crypt lock decorations](images/screenshots/Screenshot%202026-09-19%20at%2009.34.30.png)

The Git Crypt Explorer panel summarizes repositories, encrypted files, and warnings:

![Git Crypt Explorer panel showing encrypted files and repository status](images/screenshots/Screenshot%202026-09-19%20at%2009.34.41.png)

## Commands

- **Git Crypt: Add to Encryption Targets** — available from the Explorer context menu; adds an
  exact file rule or a recursive folder rule to the nearest `.gitattributes` file. Nested
  `.gitattributes` files are excluded from recursive encryption.
- **Git Crypt: Remove from Encryption Targets** — adds an exact file or recursive folder override,
  leaving broader rules intact while restoring normal attributes for the selected path.
- **Git Crypt: Refresh Decorations** — rediscovers the workspace and rebuilds every repository
  cache.
- **Git Crypt: Show Status** — opens an output report with Git detection, git-crypt detection,
  CLI availability, local initialization state, target count, encrypted-index count, and warning
  count.
- **Git Crypt: Show Indexed Ciphertext** — available for encrypted files; opens a read-only hex
  preview of the stage-0 Git index blob without changing the working-tree file.
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

The context-menu commands update and save `.gitattributes`, but do not stage files. Stage both the
affected files and `.gitattributes` when you are ready to update the Git index and commit the rule.

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
git ls-files --stage -z
git cat-file --batch
```

The first command lists tracked and non-ignored untracked files. All paths are sent to one
`git check-attr` process using NUL delimiters. A file is protected only when Git reports the exact
value `git-crypt`. For matching paths, stage-0 regular-file object IDs are collected from the
index. Missing object IDs are sent together to one `git cat-file --batch` process. A blob is shown
as encrypted when its first 10 bytes equal git-crypt's `00 47 49 54 43 52 59 50 54 00` magic
header. Explorer rendering only performs an in-memory map lookup; it never starts a process per
file.

The cache is atomically replaced after a successful scan; the last good snapshot is retained if
Git temporarily fails. Blob results are cached by immutable Git object ID and pruned to object IDs
used by the current protected targets. Changes are debounced for 300 ms.
Watchers cover `.gitattributes`, file creation/deletion, and Git `HEAD`, index, packed refs, and
refs. The manual refresh also rediscovers workspace repositories.

## Limitations

- The encrypted check recognizes the same 10-byte header used by git-crypt's own status logic. It
  detects whether an index blob looks encrypted; it does not authenticate the ciphertext or prove
  that it can be decrypted with the locally installed key.
- Only the index blob is checked. Unstaged working-tree changes do not affect the badge until the
  index changes, such as after `git add`.
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
- File-list and attribute output are bounded by a 64 MiB safety limit. Initial inspection of new
  protected object IDs streams each complete blob from `git cat-file`; only its first 10 bytes are
  retained for comparison, and later refreshes reuse the object-ID cache.

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

Decoration and status scans process repository paths, Git attribute values, index metadata, CLI
version, and the presence/count of locally installed key entries. They never open working-tree
secret files or key files. Index inspection streams blob data from Git, retains only the first 10
bytes long enough to compare the git-crypt header, clears that temporary prefix buffer, and does
not log blob data. The explicit `Show Indexed Ciphertext` command can display a bounded hex
preview of the indexed blob (up to 64 KiB) in a temporary read-only view; it does not modify the
working tree or log the blob contents.

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
