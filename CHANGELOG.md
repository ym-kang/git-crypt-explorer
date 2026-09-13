# Change Log

## 0.4.1

- Added a dedicated Git Crypt Explorer Activity Bar view.
- Added repository summaries and expandable encrypted-file and warning groups.
- Added Activity Bar warning badges and view-title actions for refresh, status, and key management.
- Improved Marketplace metadata and added Marketplace and Activity Bar icons.

## 0.4.0

- Added batched Git index blob inspection using `git ls-files --stage -z` and
  `git cat-file --batch`.
- The lock badge now requires both `filter=git-crypt` and a git-crypt header in the stage-0 index
  blob.
- Added warning decorations for missing, conflicted, non-regular, and plaintext index entries.
- Added immutable object-ID caching and encrypted-index counts to **Git Crypt: Show Status**.
- Added parser, plaintext, empty-blob, cache, path, and real git-crypt integration tests.

## 0.3.0

- Added new-repository initialization and GPG-based unlock.
- Added safe all-key locking without exposing `--force`.
- Added GPG collaborator setup with `--no-commit` and input validation.
- Documented which low-level, legacy, and destructive commands remain intentionally unavailable.

## 0.2.0

- Added git-crypt CLI availability and local initialization/lock status.
- Added initialization/unlock using an existing symmetric key.
- Added symmetric key export with path masking, confirmation, and POSIX permission hardening.
- Added multi-root repository selection and real git-crypt lifecycle tests.

## 0.1.0

- Initial MVP with batched Git attribute detection, Explorer decorations, multi-root caches,
  automatic refresh, status/refresh commands, and unit tests.
