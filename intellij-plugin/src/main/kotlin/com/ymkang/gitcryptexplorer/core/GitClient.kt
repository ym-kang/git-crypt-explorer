package com.ymkang.gitcryptexplorer.core

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val MAX_OUTPUT_BYTES = 64L * 1024 * 1024
private const val MAX_ERROR_BYTES = 1024L * 1024
private val GIT_CRYPT_HEADER = byteArrayOf(0, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0)
private val IO_EXECUTOR = Executors.newCachedThreadPool()

/** Git repository queries and initialization. It never invokes git-crypt or reads working-tree file contents. */
class GitClient(private val executable: String = "git") {
    fun initialize(repositoryRoot: Path) {
        run(listOf("-C", repositoryRoot.toString(), "init"), repositoryRoot)
    }

    fun discover(cwd: Path): GitRepositoryLocation {
        val result = run(listOf("-C", cwd.toString(), "rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-prefix"), cwd)
        val lines = result.stdout.toString(StandardCharsets.UTF_8).split(Regex("\\r?\\n"))
        val root = lines.getOrNull(0)?.takeIf { it.isNotBlank() }
            ?: throw GitCommandException("Git returned an incomplete repository location.")
        val gitDir = lines.getOrNull(1)?.takeIf { it.isNotBlank() }
            ?: throw GitCommandException("Git returned an incomplete repository location.")
        return GitRepositoryLocation(Path.of(root).toAbsolutePath().normalize(), Path.of(gitDir).toAbsolutePath().normalize(), lines.getOrNull(2).orEmpty())
    }

    fun listFiles(repositoryRoot: Path): List<String> =
        splitNul(run(listOf("-C", repositoryRoot.toString(), "ls-files", "-z", "--cached", "--others", "--exclude-standard"), repositoryRoot).stdout)

    fun checkFilter(repositoryRoot: Path, paths: List<String>): Map<String, String> {
        if (paths.isEmpty()) return emptyMap()
        val input = (paths.joinToString("\u0000") + "\u0000").toByteArray(StandardCharsets.UTF_8)
        return parseCheckAttrOutput(run(listOf("-C", repositoryRoot.toString(), "check-attr", "-z", "--stdin", "filter"), repositoryRoot, input).stdout)
    }

    fun listIndexEntries(repositoryRoot: Path): List<GitIndexEntry> =
        parseIndexEntries(run(listOf("-C", repositoryRoot.toString(), "ls-files", "--stage", "-z"), repositoryRoot).stdout)

    fun readIndexedBlob(repositoryRoot: Path, relativePath: String): GitIndexedBlob {
        val entry = listIndexEntries(repositoryRoot).firstOrNull { it.path == relativePath && it.stage == 0 }
            ?: throw GitCommandException("The selected file is not present in the Git index.")
        val contents = run(listOf("-C", repositoryRoot.toString(), "cat-file", "blob", entry.objectId), repositoryRoot).stdout
        return GitIndexedBlob(relativePath, entry.objectId, contents)
    }

    fun checkBlobEncryption(repositoryRoot: Path, objectIds: List<String>): Map<String, Boolean> {
        val unique = objectIds.distinct()
        if (unique.isEmpty()) return emptyMap()
        val process = try {
            ProcessBuilder(executable, "-C", repositoryRoot.toString(), "cat-file", "--batch")
                .directory(repositoryRoot.toFile())
                .redirectErrorStream(false)
                .apply {
                    environment()["GIT_OPTIONAL_LOCKS"] = "0"
                    environment()["LC_ALL"] = "C"
                }
                .start()
        } catch (error: java.io.IOException) {
            throw GitCommandException("Git is not installed or is not available on PATH.", error.message?.contains("Cannot run program") == true)
        }

        val stderrFuture = CompletableFuture.supplyAsync({ process.errorStream.readLimited(MAX_ERROR_BYTES) }, IO_EXECUTOR)
        val results = linkedMapOf<String, Boolean>()
        try {
            process.outputStream.use { output ->
                output.write((unique.joinToString("\n") + "\n").toByteArray(StandardCharsets.US_ASCII))
            }
            process.inputStream.use { input ->
                unique.forEach { objectId ->
                    val header = input.readAsciiLine(256)
                        ?: throw GitCommandException("Git returned incomplete batch blob data.")
                    if (header.endsWith(" missing")) {
                        results[objectId] = false
                        return@forEach
                    }
                    val fields = header.split(' ')
                    val type = fields.getOrNull(1)
                    val size = fields.getOrNull(2)?.toLongOrNull()
                    if (type.isNullOrBlank() || size == null || size < 0) {
                        throw GitCommandException("Git returned malformed batch metadata.")
                    }
                    val prefix = input.readNBytes(minOf(size, GIT_CRYPT_HEADER.size.toLong()).toInt())
                    var remaining = size - prefix.size
                    val buffer = ByteArray(8192)
                    while (remaining > 0) {
                        val read = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                        if (read < 0) throw GitCommandException("Git returned incomplete batch blob data.")
                        remaining -= read
                    }
                    if (input.read() != '\n'.code) throw GitCommandException("Git returned malformed batch blob data.")
                    results[objectId] = prefix.contentEquals(GIT_CRYPT_HEADER)
                }
            }
        } finally {
            if (!process.waitFor(30, TimeUnit.SECONDS)) process.destroyForcibly()
        }
        val stderr = try {
            stderrFuture.join()
        } catch (error: CompletionException) {
            throw (error.cause as? GitCommandException ?: GitCommandException(error.message.orEmpty()))
        }
        val exit = process.exitValue()
        if (exit != 0) {
            throw GitCommandException(stderr.toString(StandardCharsets.UTF_8).trim().ifEmpty { "Git cat-file exited with code $exit." }, exitCode = exit)
        }
        return results
    }

    private fun run(args: List<String>, cwd: Path, input: ByteArray? = null): CommandResult {
        val process = try {
            ProcessBuilder(executable, *args.toTypedArray())
                .directory(cwd.toFile())
                .redirectErrorStream(false)
                .apply {
                    environment()["GIT_OPTIONAL_LOCKS"] = "0"
                    environment()["LC_ALL"] = "C"
                }
                .start()
        } catch (error: java.io.IOException) {
            throw GitCommandException("Git is not installed or is not available on PATH.", error.message?.contains("Cannot run program") == true)
        }
        val stdoutFuture = CompletableFuture.supplyAsync({ process.inputStream.readLimited(MAX_OUTPUT_BYTES) }, IO_EXECUTOR)
        val stderrFuture = CompletableFuture.supplyAsync({ process.errorStream.readLimited(MAX_OUTPUT_BYTES) }, IO_EXECUTOR)
        process.outputStream.use { output -> input?.let(output::write) }
        if (!process.waitFor(30, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            throw GitCommandException("Git command timed out.")
        }
        val stdout = joinOutput(stdoutFuture)
        val stderr = joinOutput(stderrFuture)
        val exit = process.exitValue()
        if (exit != 0) throw GitCommandException(stderr.toString(StandardCharsets.UTF_8).trim().ifEmpty { "Git exited with code $exit." }, exitCode = exit)
        return CommandResult(stdout, stderr)
    }

    private fun joinOutput(future: CompletableFuture<ByteArray>): ByteArray = try {
        future.join()
    } catch (error: CompletionException) {
        throw (error.cause as? GitCommandException ?: GitCommandException(error.message.orEmpty()))
    }

    data class CommandResult(val stdout: ByteArray, val stderr: ByteArray)
}

private fun InputStream.readLimited(limit: Long): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var total = 0L
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        if (total > limit) throw GitCommandException("Git output exceeded the safety limit.")
        output.write(buffer, 0, read)
    }
    return output.toByteArray()
}

private fun InputStream.readAsciiLine(maxLength: Int): String? {
    val output = ByteArrayOutputStream()
    while (true) {
        val value = read()
        if (value < 0) return if (output.size() == 0) null else output.toString(StandardCharsets.US_ASCII)
        if (value == '\n'.code) return output.toString(StandardCharsets.US_ASCII)
        output.write(value)
        if (output.size() > maxLength) throw GitCommandException("Git returned an oversized batch header.")
    }
}

private fun splitNul(bytes: ByteArray): List<String> {
    val text = bytes.toString(StandardCharsets.UTF_8)
    return text.split('\u0000').dropLastWhile { it.isEmpty() }
}

private fun parseCheckAttrOutput(bytes: ByteArray): Map<String, String> {
    val fields = splitNul(bytes)
    if (fields.size % 3 != 0) throw GitCommandException("Git returned malformed attribute data.")
    return buildMap {
        fields.chunked(3).forEach { fields3 ->
            if (fields3[1] == "filter") put(fields3[0], fields3[2])
        }
    }
}

private fun parseIndexEntries(bytes: ByteArray): List<GitIndexEntry> = buildList {
    splitNul(bytes).forEach { record ->
        val tab = record.indexOf('\t')
        if (tab < 0) throw GitCommandException("Git returned malformed index data.")
        val metadata = record.substring(0, tab).split(' ')
        val stage = metadata.getOrNull(2)?.toIntOrNull()
        if (metadata.size < 3 || metadata[0].isBlank() || metadata[1].isBlank() || stage == null) {
            throw GitCommandException("Git returned malformed index metadata.")
        }
        add(GitIndexEntry(record.substring(tab + 1), metadata[0], metadata[1], stage))
    }
}
