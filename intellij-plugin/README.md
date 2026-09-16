# Git Crypt Explorer for IntelliJ Platform

This directory contains the IntelliJ Platform implementation of Git Crypt Explorer.
The TypeScript implementation in the repository root remains the VS Code extension.

The plugin intentionally depends on the shared IntelliJ Platform and VCS APIs, not on
Python APIs. As a result, the same plugin can be installed in PyCharm and other compatible
JetBrains IDEs. Python-specific dependencies should only be added if the feature later
needs Python PSI or Python inspections.

## Requirements

- JDK 21
- Gradle 9 or newer
- IntelliJ IDEA for plugin development
- Git, `git-crypt`, and GPG for repository operations

## Development

Open this directory as a Gradle project in IntelliJ IDEA. Run the `runIde` Gradle task to
launch a development IDE with the plugin installed, or use `buildPlugin` to create a ZIP
distribution under `build/distributions/`.

The plugin provides a **Git Crypt Explorer** tool window, repository snapshots, encrypted/warning
file groups, project-view decorations, automatic refreshes, status reporting, key export,
initialization, GPG unlock/user management, lock, and `.gitattributes` target editing.

Project View decorations use `🔒` when every scanned file below a folder is encrypted, `🔒 × n`
when the folder contains `n` encrypted files alongside unprotected files, and `!` when a warning
exists below the folder.

Each open project window appends the project-wide count to its window/tab title, such as `🔒 × 3`.
The count is shown independently for every project tab when multiple projects are open together.
