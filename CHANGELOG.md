# Change Log

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
