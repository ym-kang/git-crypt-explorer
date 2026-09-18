package com.ymkang.gitcryptexplorer.core

import com.intellij.openapi.Disposable
import com.intellij.ide.projectView.ProjectView
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.wm.impl.TitleInfoProvider
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import java.nio.file.LinkOption
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

private const val REFRESH_DEBOUNCE_MS = 300L

@Service(Service.Level.PROJECT)
class GitCryptService(private val project: Project) : Disposable {
    private val git = GitClient()
    val cli = GitCryptCli()
    private val worker = Executors.newSingleThreadExecutor()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var scheduledRefresh: ScheduledFuture<*>? = null
    private var repositories: Map<Path, MutableRepository> = emptyMap()
    private var workspaceFolderCount = 0
    private var nonGitFolderCount = 0
    private var gitUnavailable = false
    private var discoveryErrors: List<String> = emptyList()

    init {
        project.messageBus.connect(this).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (events.any { event -> event.file?.path?.let(::isProjectPath) == true }) scheduleRefresh()
            }
        })
        initializeAsync()
    }

    fun addRefreshListener(listener: () -> Unit): Disposable {
        listeners.add(listener)
        return Disposable { listeners.remove(listener) }
    }

    fun initializeAsync(): CompletableFuture<Void> = CompletableFuture.runAsync({
        val folders = workspaceFolders()
        val nextRepositories = linkedMapOf<Path, MutableRepository>()
        var nextNonGit = 0
        var nextGitUnavailable = false
        val nextErrors = mutableListOf<String>()
        folders.forEach { folder ->
            try {
                val location = git.discover(folder)
                val root = location.root
                val repository = nextRepositories.getOrPut(root) {
                    MutableRepository(location, mutableMapOf(), repositories[root]?.blobEncryptionCache?.toMutableMap() ?: mutableMapOf(), repositories[root]?.snapshot ?: emptySnapshot(location))
                }
                repository.mounts[folder.toAbsolutePath().normalize()] = location.workspacePrefix
            } catch (error: GitCommandException) {
                nextNonGit++
                if (error.unavailable) nextGitUnavailable = true
                else if (error.exitCode != 128) nextErrors += error.message.orEmpty()
            } catch (error: Exception) {
                nextNonGit++
                nextErrors += error.message ?: "Unknown Git discovery error."
            }
        }
        synchronized(this) {
            workspaceFolderCount = folders.size
            nonGitFolderCount = nextNonGit
            gitUnavailable = nextGitUnavailable
            discoveryErrors = nextErrors
            repositories = nextRepositories
        }
        refreshAllInternal()
    }, worker).also { future -> future.whenComplete { _, _ -> notifyRefreshListeners() } }

    fun refreshNow(): CompletableFuture<Void> = CompletableFuture.runAsync({
        refreshAllInternal()
    }, worker).also { future -> future.whenComplete { _, _ -> notifyRefreshListeners() } }

    fun workspaceStatus(): WorkspaceStatus = synchronized(this) {
        WorkspaceStatus(workspaceFolderCount, nonGitFolderCount, gitUnavailable, repositories.values.map { it.snapshot }, discoveryErrors)
    }

    fun repositorySnapshotForPath(filePath: Path): RepositorySnapshot? = repositoryPathForWorkspacePath(filePath)?.first?.snapshot

    fun repositoryLocations(): List<GitRepositoryLocation> = synchronized(this) { repositories.values.map { it.location } }

    fun initializeGitRepository(folder: Path) {
        git.initialize(folder.toAbsolutePath().normalize())
    }

    fun statusForPath(filePath: Path): GitCryptStatus {
        val normalized = filePath.toAbsolutePath().normalize()
        val match = repositoryPathForWorkspacePath(normalized) ?: return GitCryptStatus.NONE
        val direct = match.first.snapshot.statuses[match.second]
        if (direct != null) return direct
        return when (pathDecorationForPath(normalized)) {
            GitCryptPathDecoration.WARNING -> GitCryptStatus.WARNING
            GitCryptPathDecoration.ENCRYPTED, GitCryptPathDecoration.PARTIAL -> GitCryptStatus.ENCRYPTED
            GitCryptPathDecoration.NONE -> GitCryptStatus.NONE
        }
    }

    fun pathDecorationForPath(filePath: Path): GitCryptPathDecoration {
        val normalized = filePath.toAbsolutePath().normalize()
        val match = repositoryPathForDecorationPath(normalized) ?: return GitCryptPathDecoration.NONE
        val direct = match.first.snapshot.statuses[match.second]
        if (direct != null) return direct.toPathDecoration()
        if (!Files.isDirectory(match.second)) return GitCryptPathDecoration.NONE

        val snapshot = match.first.snapshot
        val descendantFiles = snapshot.scannedFiles.filter { it.startsWith(match.second) }
        if (descendantFiles.isEmpty()) return GitCryptPathDecoration.NONE
        val descendantStatuses = descendantFiles.mapNotNull(snapshot.statuses::get)
        return when {
            descendantStatuses.any { it == GitCryptStatus.WARNING } -> GitCryptPathDecoration.WARNING
            descendantStatuses.isNotEmpty() && descendantStatuses.size == descendantFiles.size && descendantStatuses.all { it == GitCryptStatus.ENCRYPTED } -> GitCryptPathDecoration.ENCRYPTED
            descendantStatuses.any { it == GitCryptStatus.ENCRYPTED } -> GitCryptPathDecoration.PARTIAL
            else -> GitCryptPathDecoration.NONE
        }
    }

    fun encryptedFileCountForPath(filePath: Path): Int {
        val normalized = filePath.toAbsolutePath().normalize()
        val match = repositoryPathForDecorationPath(normalized) ?: return 0
        val snapshot = match.first.snapshot
        val directStatus = snapshot.statuses[match.second]
        if (directStatus != null) return if (directStatus == GitCryptStatus.ENCRYPTED) 1 else 0
        if (!Files.isDirectory(match.second)) return 0
        return snapshot.scannedFiles.count { scannedFile ->
            scannedFile.startsWith(match.second) && snapshot.statuses[scannedFile] == GitCryptStatus.ENCRYPTED
        }
    }

    fun encryptedFileCountForProject(): Int {
        val roots = workspaceFolders().map { it.toAbsolutePath().normalize() }
        return synchronized(this) {
            repositories.values
                .flatMap { repository ->
                    repository.snapshot.statuses.asSequence()
                        .filter { (path, status) ->
                            status == GitCryptStatus.ENCRYPTED && roots.any(path::startsWith)
                        }
                        .map { (path, _) -> path }
                        .toList()
                }
                .distinct()
                .count()
        }
    }

    fun projectHasWarning(): Boolean {
        val roots = workspaceFolders().map { it.toAbsolutePath().normalize() }
        return synchronized(this) {
            repositories.values.any { repository ->
                repository.snapshot.statuses.any { (path, status) ->
                    status == GitCryptStatus.WARNING && roots.any(path::startsWith)
                }
            }
        }
    }

    fun statusDetailForPath(filePath: Path): String? {
        val match = repositoryPathForDecorationPath(filePath) ?: return null
        return match.first.snapshot.statusDetails[match.second]
    }

    fun repositoryResource(filePath: Path): RepositoryResource? {
        val match = repositoryPathForWorkspacePath(filePath.toAbsolutePath().normalize()) ?: return null
        return RepositoryResource(match.first.location.root, match.second, toGitPath(match.first.location.root.relativize(match.second).toString()))
    }

    fun isProtectedFile(filePath: Path): Boolean? {
        val resource = repositoryResource(filePath) ?: return null
        return git.checkFilter(resource.root, listOf(resource.relativePath))[resource.relativePath] == "git-crypt"
    }

    override fun dispose() {
        scheduledRefresh?.cancel(false)
        scheduler.shutdownNow()
        worker.shutdownNow()
        listeners.clear()
    }

    private fun refreshAllInternal() {
        synchronized(this) { repositories.values.toList() }.forEach(::refreshRepository)
    }

    private fun refreshRepository(repository: MutableRepository) {
        try {
            val files = git.listFiles(repository.location.root)
            val indexEntries = git.listIndexEntries(repository.location.root)
            val filters = git.checkFilter(repository.location.root, files)
            val entriesByPath = indexEntries.groupBy { it.path }
            val targets = files.filter { filters[it] == "git-crypt" }
            val targetObjectIds = targets.mapNotNull { file ->
                val stageZero = entriesByPath[file].orEmpty().firstOrNull { it.stage == 0 }
                if (stageZero != null && isRegularFileMode(stageZero.mode)) file to stageZero.objectId else null
            }.toMap()
            val objectIds = targetObjectIds.values.distinct()
            val inspected = git.checkBlobEncryption(repository.location.root, objectIds.filterNot(repository.blobEncryptionCache::containsKey))
            val nextCache = objectIds.associateWith { objectId -> repository.blobEncryptionCache[objectId] ?: inspected[objectId] ?: false }.toMutableMap()
            val statuses = linkedMapOf<Path, GitCryptStatus>()
            val details = linkedMapOf<Path, String>()
            var encryptedCount = 0
            var warningCount = 0
            targets.forEach { file ->
                val absolute = repository.location.root.resolve(file).normalize()
                val objectId = targetObjectIds[file]
                if (objectId != null && nextCache[objectId] == true) {
                    statuses[absolute] = GitCryptStatus.ENCRYPTED
                    encryptedCount++
                } else {
                    statuses[absolute] = GitCryptStatus.WARNING
                    warningCount++
                    details[absolute] = warningDetail(entriesByPath[file].orEmpty(), objectId)
                }
            }
            repository.blobEncryptionCache = nextCache
            repository.snapshot = RepositorySnapshot(
                root = repository.location.root,
                gitDir = repository.location.gitDir,
                scannedFiles = files.map { repository.location.root.resolve(it).normalize() }.toSet(),
                statuses = statuses,
                statusDetails = details,
                protectedFiles = targets.size,
                encryptedIndexFiles = encryptedCount,
                warnings = warningCount,
                gitCryptDetected = targets.isNotEmpty(),
            )
        } catch (error: Exception) {
            repository.snapshot = repository.snapshot.copy(error = error.message ?: "Unknown Git error.")
        }
    }

    private fun repositoryPathForWorkspacePath(filePath: Path): Pair<MutableRepository, Path>? {
        val absolute = filePath.toAbsolutePath().normalize()
        var best: Triple<MutableRepository, Path, Int>? = null
        synchronized(this) {
            repositories.values.forEach { repository ->
                repository.mounts.forEach { (mount, prefix) ->
                    if (absolute.startsWith(mount) && (best == null || mount.nameCount > best!!.third)) {
                        val relative = mount.relativize(absolute)
                        val repositoryPath = repository.location.root.resolve(prefix).resolve(relative).normalize()
                        best = Triple(repository, repositoryPath, mount.nameCount)
                    }
                }
            }
        }
        return best?.let { it.first to it.second }
    }

    private fun repositoryPathForDecorationPath(filePath: Path): Pair<MutableRepository, Path>? {
        val originalMatch = repositoryPathForWorkspacePath(filePath) ?: return null
        val originalPath = filePath.toAbsolutePath().normalize()
        val resolvedPath = resolveSymlinkPath(originalPath)
        if (resolvedPath == originalPath) return originalMatch

        repositoryPathForWorkspacePath(resolvedPath)?.let { return it }

        val targetRelativePath = originalPath.parent?.relativize(resolvedPath) ?: return originalMatch
        val repositoryPath = originalMatch.second.parent.resolve(targetRelativePath).normalize()
        return if (repositoryPath.startsWith(originalMatch.first.location.root)) {
            originalMatch.first to repositoryPath
        } else {
            originalMatch
        }
    }

    private fun scheduleRefresh() {
        synchronized(this) {
            scheduledRefresh?.cancel(false)
            scheduledRefresh = scheduler.schedule({ refreshNow() }, REFRESH_DEBOUNCE_MS, TimeUnit.MILLISECONDS)
        }
    }

    private fun notifyRefreshListeners() {
        ApplicationManager.getApplication().invokeLater {
            ProjectView.getInstance(project).refresh()
            val fileEditorManager = FileEditorManager.getInstance(project)
            fileEditorManager.openFiles.forEach(fileEditorManager::updateFilePresentation)
            TitleInfoProvider.fireConfigurationChanged()
            listeners.forEach { listener ->
                try { listener() } catch (_: Exception) { /* UI listeners must not break refreshes. */ }
            }
        }
    }

    private fun workspaceFolders(): List<Path> {
        val roots = ProjectRootManager.getInstance(project).contentRoots.map { Path.of(it.path) }
        if (roots.isNotEmpty()) return roots
        return project.basePath?.let { listOf(Path.of(it)) }.orEmpty()
    }

    private fun isProjectPath(path: String): Boolean {
        val candidate = Path.of(path).toAbsolutePath().normalize()
        return workspaceFolders().any { candidate.startsWith(it.toAbsolutePath().normalize()) }
    }

    private data class MutableRepository(
        val location: GitRepositoryLocation,
        val mounts: MutableMap<Path, String>,
        var blobEncryptionCache: MutableMap<String, Boolean>,
        var snapshot: RepositorySnapshot,
    )
}

private fun emptySnapshot(location: GitRepositoryLocation) = RepositorySnapshot(location.root, location.gitDir)

private fun resolveSymlinkPath(filePath: Path): Path {
    val originalPath = filePath.toAbsolutePath().normalize()
    var currentPath = originalPath
    val visited = mutableSetOf<Path>()

    while (visited.add(currentPath)) {
        if (!Files.exists(currentPath, LinkOption.NOFOLLOW_LINKS)) return originalPath
        if (!Files.isSymbolicLink(currentPath)) return currentPath
        currentPath = currentPath.parent.resolve(Files.readSymbolicLink(currentPath)).toAbsolutePath().normalize()
    }

    return originalPath
}

private fun GitCryptStatus.toPathDecoration() = when (this) {
    GitCryptStatus.ENCRYPTED -> GitCryptPathDecoration.ENCRYPTED
    GitCryptStatus.WARNING -> GitCryptPathDecoration.WARNING
    GitCryptStatus.NONE -> GitCryptPathDecoration.NONE
}

private fun isRegularFileMode(mode: String) = (mode.toIntOrNull(8)?.and(49152) ?: 0) == 32768

private fun warningDetail(entries: List<GitIndexEntry>, objectId: String?): String = when {
    entries.isEmpty() -> "git-crypt target is not present in the Git index."
    objectId == null && entries.any { it.stage != 0 } -> "git-crypt target has unresolved index stages."
    objectId == null -> "git-crypt target is not a regular file in the Git index."
    else -> "git-crypt target has an unencrypted Git index blob."
}

private fun toGitPath(path: String) = path.replace(java.io.File.separatorChar, '/')
