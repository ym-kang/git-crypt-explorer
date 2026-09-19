package com.ymkang.gitcryptexplorer.scenarios

import com.ymkang.gitcryptexplorer.core.GitClient
import com.ymkang.gitcryptexplorer.core.GitCryptLocalState
import com.ymkang.gitcryptexplorer.core.GitCryptRepositoryStatus
import com.ymkang.gitcryptexplorer.core.GitCryptSetupRecommendation
import com.ymkang.gitcryptexplorer.core.gitCryptTargetOperationError
import com.ymkang.gitcryptexplorer.core.recommendGitCryptSetup
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class GitCryptSetupScenarioTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun emptyFolderCanBeInitializedAndDiscoveredAsGitRepository() {
        val folder = temporaryFolder.newFolder("empty-project").toPath()
        val git = GitClient()

        assertEquals(
            GitCryptSetupRecommendation.INITIALIZE_GIT,
            recommendGitCryptSetup(repositoryExists = false),
        )

        git.initialize(folder)
        val location = git.discover(folder)

        assertEquals(folder.toRealPath(), location.root)
        assertTrue(java.nio.file.Files.isDirectory(location.gitDir))
    }

    @Test
    fun protectedFilesInLockedRepositoryRecommendUnlock() {
        assertEquals(
            GitCryptSetupRecommendation.UNLOCK,
            recommendGitCryptSetup(
                repositoryExists = true,
                protectedFileCount = 1,
                localState = GitCryptLocalState.LOCKED,
            ),
        )
    }

    @Test
    fun repositoryWithoutTargetsOrLocalKeyRecommendsNewGitCryptKey() {
        assertEquals(
            GitCryptSetupRecommendation.INITIALIZE_GIT_CRYPT,
            recommendGitCryptSetup(
                repositoryExists = true,
                protectedFileCount = 0,
                localState = GitCryptLocalState.NOT_INITIALIZED,
            ),
        )
    }

    @Test
    fun encryptionTargetChangesRequireAnInstalledUnlockedKey() {
        assertEquals(
            "git-crypt is locked. Unlock the repository before changing encryption targets.",
            gitCryptTargetOperationError(
                GitCryptRepositoryStatus(
                    available = true,
                    localState = GitCryptLocalState.LOCKED,
                    installedKeyCount = 0,
                ),
            ),
        )
        assertEquals(
            "git-crypt is not initialized locally. Initialize or unlock the repository before changing encryption targets.",
            gitCryptTargetOperationError(
                GitCryptRepositoryStatus(
                    available = true,
                    localState = GitCryptLocalState.NOT_INITIALIZED,
                    installedKeyCount = 0,
                ),
            ),
        )
        assertNull(
            gitCryptTargetOperationError(
                GitCryptRepositoryStatus(
                    available = true,
                    localState = GitCryptLocalState.UNLOCKED,
                    installedKeyCount = 1,
                ),
            ),
        )
    }

    @Test
    fun encryptedIndexContentCanBeReadWithoutChangingTheWorkingTree() {
        val folder = temporaryFolder.newFolder("indexed-ciphertext").toPath()
        val encryptedContents = byteArrayOf(0, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0, 1)
        val git = GitClient()
        git.initialize(folder)
        Files.write(folder.resolve("secret.py"), encryptedContents)
        runGit(folder, "add", "--", "secret.py")
        val statusBefore = runGit(folder, "status", "--short", "--", "secret.py")

        val blob = git.readIndexedBlob(folder, "secret.py")

        assertEquals("secret.py", blob.path)
        assertArrayEquals(encryptedContents, blob.contents)
        assertEquals(statusBefore, runGit(folder, "status", "--short", "--", "secret.py"))
    }

    private fun runGit(folder: java.nio.file.Path, vararg arguments: String): String {
        val process = ProcessBuilder(listOf("git", "-C", folder.toString()) + arguments).start()
        val output = process.inputStream.bufferedReader().readText()
        check(process.waitFor() == 0) { process.errorStream.bufferedReader().readText() }
        return output
    }
}
