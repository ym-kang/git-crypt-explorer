# Architecture

The extension has a small read-only pipeline:

```text
VS Code events / commands
        |
        v
WorkspaceController (debounce + repository lifecycle)
        |
        v
GitCryptService (one immutable-style snapshot per repository)
        |
        v
GitClient: file list + index entries -> batched attributes + batched blob-header inspection

Explorer render -> FileDecorationProvider -> synchronous snapshot Map lookup
Activity Bar render -> TreeDataProvider -> repository snapshots and protected-file groups

Explicit repository/key command -> modal confirmation -> GitCryptCli -> git-crypt child process
```

## Boundaries

- `src/git/gitClient.ts` owns child processes, NUL-delimited Git protocol parsing, and streaming
  `git cat-file --batch` framing.
- `src/gitCrypt/gitCryptService.ts` owns repository discovery, multi-root path mapping, status
  classification, and atomic cache replacement.
- `src/gitCrypt/gitCryptCli.ts` owns installation/local-key-state inspection plus explicitly
  requested `init`, lock/unlock, GPG-user, and `export-key` process execution. It never loads key
  bytes itself and does not invoke a shell.
- `src/decorations/gitCryptDecorationProvider.ts` maps statuses to VS Code UI metadata.
- `src/views/gitCryptExplorerTree.ts` renders repository snapshots in the Activity Bar without
  starting additional Git processes.
- `src/workspaceController.ts` owns watchers, 300 ms debounce, serialized refreshes, and Git-dir
  watcher lifecycle, then signals both UI providers after a refresh.
- `src/commands` contains user-facing command adapters.
- `src/extension.ts` is composition and registration only.

## Refresh cost

A full cold refresh starts at most four Git processes per repository regardless of the number of
files: file-list and index-list queries run in parallel, followed by one attribute query and one
`cat-file --batch` query for uncached protected object IDs. If all relevant object IDs are cached,
the blob query is skipped. Rendering files starts no processes. The status cache holds entries
only for protected targets, keeping the common `none` state implicit; blob classifications are
cached separately by immutable Git object ID.

The full repository is not periodically scanned. Refreshes are event-driven and coalesced. A
successful result replaces the previous map in one assignment; a failed refresh retains the last
known-good map and records the error for the status command.

## Extension points

`GitCryptStatus.warning` currently represents a target that has no stage-0 regular index blob, has
unmerged stages, or whose blob lacks the git-crypt header. Additional checks can be added as a
separate post-processing stage. Encryption/decryption remains restricted to explicit git-crypt
CLI operations confirmed by the user.
