package com.ymkang.gitcryptexplorer.core

enum class GitCryptSetupRecommendation {
    INITIALIZE_GIT,
    UNLOCK,
    INITIALIZE_GIT_CRYPT,
    NONE,
}

/**
 * Chooses the first setup question for a repository without touching the file system or CLI.
 * Keeping this decision pure makes the guided setup flow easy to verify with temporary repos.
 */
fun recommendGitCryptSetup(
    repositoryExists: Boolean,
    protectedFileCount: Int = 0,
    localState: GitCryptLocalState? = null,
): GitCryptSetupRecommendation = when {
    !repositoryExists -> GitCryptSetupRecommendation.INITIALIZE_GIT
    protectedFileCount > 0 && localState == GitCryptLocalState.LOCKED -> GitCryptSetupRecommendation.UNLOCK
    protectedFileCount == 0 && localState == GitCryptLocalState.NOT_INITIALIZED -> GitCryptSetupRecommendation.INITIALIZE_GIT_CRYPT
    else -> GitCryptSetupRecommendation.NONE
}

fun gitCryptTargetOperationError(status: GitCryptRepositoryStatus): String? = when {
    !status.available -> "git-crypt is not installed or is not available on PATH."
    status.localState == GitCryptLocalState.LOCKED -> "git-crypt is locked. Unlock the repository before changing encryption targets."
    status.localState == GitCryptLocalState.NOT_INITIALIZED -> "git-crypt is not initialized locally. Initialize or unlock the repository before changing encryption targets."
    else -> null
}
