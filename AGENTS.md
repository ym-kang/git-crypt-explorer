# Agent Instructions

## Release and versioning

- When creating a new version or distribution artifact, update `CHANGELOG.md` automatically even if the user does not explicitly request a change log entry.
- Add a new version section at the top of `CHANGELOG.md` with concise, user-visible changes. Preserve existing historical entries.
- Keep the requested product manifest version synchronized with the release:
  - IntelliJ/PyCharm plugin: `intellij-plugin/gradle.properties` and `intellij-plugin/build.gradle.kts`.
  - VS Code extension: `package.json` and `package-lock.json`.
- Build the relevant distribution artifact after changing the version and report its path and build result.
