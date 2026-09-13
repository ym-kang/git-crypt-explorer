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
GitClient: git ls-files -z -> git check-attr -z --stdin filter

Explorer render -> FileDecorationProvider -> synchronous snapshot Map lookup
```

## Boundaries

- `src/git/gitClient.ts` owns child processes and NUL-delimited Git protocol parsing.
- `src/gitCrypt/gitCryptService.ts` owns repository discovery, multi-root path mapping, status
  classification, and atomic cache replacement.
- `src/decorations/gitCryptDecorationProvider.ts` maps statuses to VS Code UI metadata.
- `src/workspaceController.ts` owns watchers, 300 ms debounce, serialized refreshes, and Git-dir
  watcher lifecycle.
- `src/commands` contains user-facing command adapters.
- `src/extension.ts` is composition and registration only.

## Refresh cost

A refresh starts at most two Git processes per repository regardless of the number of files: one
file-list query and, for a non-empty repository, one attribute query. Rendering files starts no
processes. The cache holds entries only for protected files, keeping the common `none` state
implicit.

The full repository is not periodically scanned. Refreshes are event-driven and coalesced. A
successful result replaces the previous map in one assignment; a failed refresh retains the last
known-good map and records the error for the status command.

## Extension points

`GitCryptStatus` already includes `warning`. Future warning analysis should run as a separate
post-processing stage after Git attribute resolution, then merge results into the new snapshot.
It must not inspect secret contents or perform encryption/decryption.
