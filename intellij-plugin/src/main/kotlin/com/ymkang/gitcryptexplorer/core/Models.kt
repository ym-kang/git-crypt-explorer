package com.ymkang.gitcryptexplorer.core

import java.nio.file.Path

enum class GitCryptStatus {
    ENCRYPTED,
    WARNING,
    NONE,
}

enum class GitCryptPathDecoration {
    NONE,
    ENCRYPTED,
    PARTIAL,
    WARNING,
}

enum class GitCryptLocalState {
    UNLOCKED,
    LOCKED,
    NOT_INITIALIZED,
}

data class GitCryptRepositoryStatus(
    val available: Boolean,
    val version: String? = null,
    val localState: GitCryptLocalState,
    val installedKeyCount: Int,
)

data class GitRepositoryLocation(
    val root: Path,
    val gitDir: Path,
    val workspacePrefix: String,
)

data class GitIndexEntry(
    val path: String,
    val mode: String,
    val objectId: String,
    val stage: Int,
)

data class RepositorySnapshot(
    val root: Path,
    val gitDir: Path,
    val scannedFiles: Set<Path> = emptySet(),
    val statuses: Map<Path, GitCryptStatus> = emptyMap(),
    val statusDetails: Map<Path, String> = emptyMap(),
    val protectedFiles: Int = 0,
    val encryptedIndexFiles: Int = 0,
    val warnings: Int = 0,
    val gitCryptDetected: Boolean = false,
    val error: String? = null,
)

data class WorkspaceStatus(
    val workspaceFolders: Int,
    val nonGitFolders: Int,
    val gitUnavailable: Boolean,
    val repositories: List<RepositorySnapshot>,
    val discoveryErrors: List<String>,
)

data class RepositoryResource(
    val root: Path,
    val absolutePath: Path,
    val relativePath: String,
)

class GitCommandException(
    message: String,
    val unavailable: Boolean = false,
    val exitCode: Int? = null,
) : Exception(message)

class GitCryptCommandException(
    message: String,
    val unavailable: Boolean = false,
    val exitCode: Int? = null,
) : Exception(message)
