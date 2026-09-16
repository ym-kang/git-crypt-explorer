package com.ymkang.gitcryptexplorer.core

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val MAX_COMMAND_OUTPUT_BYTES = 1024L * 1024
private val CLI_IO_EXECUTOR = Executors.newCachedThreadPool()

class GitCryptCli(private val executable: String = resolveGitCryptExecutable()) {
    fun inspect(repositoryRoot: Path, gitDir: Path, hasProtectedFiles: Boolean): GitCryptRepositoryStatus {
        val installedKeyCount = countInstalledKeys(gitDir)
        return try {
            val result = run(listOf("--version"), repositoryRoot)
            GitCryptRepositoryStatus(true, result.stdout.trim().ifEmpty { result.stderr.trim() }.ifEmpty { null }, localState(installedKeyCount, hasProtectedFiles), installedKeyCount)
        } catch (error: GitCryptCommandException) {
            if (!error.unavailable) throw error
            GitCryptRepositoryStatus(false, localState = localState(installedKeyCount, hasProtectedFiles), installedKeyCount = installedKeyCount)
        }
    }

    fun unlockWithKey(repositoryRoot: Path, keyFile: Path) = runMasked(listOf("unlock", keyFile.toAbsolutePath().toString()), repositoryRoot, keyFile, "<key file>")
    fun initializeRepository(repositoryRoot: Path) { run(listOf("init"), repositoryRoot) }
    fun unlockWithGpg(repositoryRoot: Path) { run(listOf("unlock"), repositoryRoot) }
    fun lockRepository(repositoryRoot: Path) { run(listOf("lock", "--all"), repositoryRoot) }

    fun addGpgUser(repositoryRoot: Path, userId: String) {
        val normalized = userId.trim()
        if (normalized.isEmpty()) throw GitCryptCommandException("A GPG user ID is required.")
        if (normalized.startsWith('-') || normalized.any { it == '\u0000' || it == '\r' || it == '\n' }) {
            throw GitCryptCommandException("The GPG user ID contains unsupported characters.")
        }
        runMasked(listOf("add-gpg-user", "--no-commit", normalized), repositoryRoot, Path.of(normalized), "<GPG user ID>")
    }

    fun exportKey(repositoryRoot: Path, destination: Path): Boolean {
        val absolute = destination.toAbsolutePath().normalize()
        runMasked(listOf("export-key", absolute.toString()), repositoryRoot, absolute, "<export destination>")
        if (System.getProperty("os.name").contains("win", ignoreCase = true)) return false
        return try {
            Files.setPosixFilePermissions(absolute, PosixFilePermissions.fromString("rw-------"))
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun runMasked(args: List<String>, cwd: Path, sensitive: Path, replacement: String) {
        try {
            run(args, cwd)
        } catch (error: GitCryptCommandException) {
            throw GitCryptCommandException(error.message.orEmpty().replace(sensitive.toString(), replacement), error.unavailable, error.exitCode)
        }
    }

    private fun run(args: List<String>, cwd: Path): CommandResult {
        val process = try {
            ProcessBuilder(executable, *args.toTypedArray()).directory(cwd.toFile()).apply { environment()["LC_ALL"] = "C" }.start()
        } catch (error: java.io.IOException) {
            throw GitCryptCommandException("git-crypt is not installed or is not available on PATH.", error.message?.contains("Cannot run program") == true)
        }
        val stdoutFuture = CompletableFuture.supplyAsync({ process.inputStream.readLimited(MAX_COMMAND_OUTPUT_BYTES) }, CLI_IO_EXECUTOR)
        val stderrFuture = CompletableFuture.supplyAsync({ process.errorStream.readLimited(MAX_COMMAND_OUTPUT_BYTES) }, CLI_IO_EXECUTOR)
        process.outputStream.close()
        if (!process.waitFor(30, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            throw GitCryptCommandException("git-crypt command timed out.")
        }
        val stdout = joinOutput(stdoutFuture).toString(Charsets.UTF_8)
        val stderr = joinOutput(stderrFuture).toString(Charsets.UTF_8)
        val exit = process.exitValue()
        if (exit != 0) throw GitCryptCommandException(stderr.trim().ifEmpty { "git-crypt exited with code $exit." }, exitCode = exit)
        return CommandResult(stdout, stderr)
    }

    private fun joinOutput(future: CompletableFuture<ByteArray>): ByteArray = try {
        future.join()
    } catch (error: CompletionException) {
        throw (error.cause as? GitCryptCommandException ?: GitCryptCommandException(error.message.orEmpty()))
    }

    private fun countInstalledKeys(gitDir: Path): Int = try {
        Files.list(gitDir.resolve("git-crypt").resolve("keys")).use { stream -> stream.count().toInt() }
    } catch (error: java.io.IOException) {
        if (error is java.nio.file.NoSuchFileException || error is java.nio.file.NotDirectoryException) 0 else throw error
    }

    private fun localState(keyCount: Int, hasProtectedFiles: Boolean): GitCryptLocalState = when {
        keyCount > 0 -> GitCryptLocalState.UNLOCKED
        hasProtectedFiles -> GitCryptLocalState.LOCKED
        else -> GitCryptLocalState.NOT_INITIALIZED
    }

    private data class CommandResult(val stdout: String, val stderr: String)
}

/**
 * GUI-launched JetBrains IDEs do not always inherit the user's shell PATH.
 * Prefer the normal PATH lookup, then check the standard Homebrew and system
 * locations so macOS installations work without launching the IDE from a shell.
 */
private fun resolveGitCryptExecutable(): String {
    val candidates = linkedSetOf<String>()
    System.getenv("PATH")
        ?.split(java.io.File.pathSeparator)
        ?.filter(String::isNotBlank)
        ?.forEach { directory ->
            candidates += Path.of(directory).resolve("git-crypt").toString()
            if (System.getProperty("os.name").contains("win", ignoreCase = true)) {
                candidates += Path.of(directory).resolve("git-crypt.exe").toString()
            }
        }
    candidates += listOf(
        "/opt/homebrew/bin/git-crypt",
        "/opt/homebrew/opt/git-crypt/bin/git-crypt",
        "/usr/local/bin/git-crypt",
        "/usr/local/opt/git-crypt/bin/git-crypt",
        "/usr/bin/git-crypt",
        "/bin/git-crypt",
    )
    return candidates.firstOrNull { candidate ->
        val path = Path.of(candidate)
        Files.isRegularFile(path) && Files.isExecutable(path)
    } ?: "git-crypt"
}

private fun java.io.InputStream.readLimited(limit: Long): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var total = 0L
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        if (total > limit) throw GitCryptCommandException("git-crypt output exceeded the safety limit.")
        output.write(buffer, 0, read)
    }
    return output.toByteArray()
}
