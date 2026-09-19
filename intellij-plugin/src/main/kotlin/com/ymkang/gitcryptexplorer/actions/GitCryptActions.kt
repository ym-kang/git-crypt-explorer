package com.ymkang.gitcryptexplorer.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.ymkang.gitcryptexplorer.core.GitAttributesUpdate
import com.ymkang.gitcryptexplorer.core.GitCryptAttributeMode
import com.ymkang.gitcryptexplorer.core.GitCryptAttributeTarget
import com.ymkang.gitcryptexplorer.core.GitCryptCommandException
import com.ymkang.gitcryptexplorer.core.GitCryptLocalState
import com.ymkang.gitcryptexplorer.core.GitCryptService
import com.ymkang.gitcryptexplorer.core.GitCryptRepositoryStatus
import com.ymkang.gitcryptexplorer.core.GitCryptStatus
import com.ymkang.gitcryptexplorer.core.GitIndexedBlob
import com.ymkang.gitcryptexplorer.core.RepositoryResource
import com.ymkang.gitcryptexplorer.core.RepositorySnapshot
import com.ymkang.gitcryptexplorer.core.WorkspaceStatus
import com.ymkang.gitcryptexplorer.core.updateGitAttributes
import com.ymkang.gitcryptexplorer.core.gitCryptTargetOperationError
import com.ymkang.gitcryptexplorer.ui.chooseOpenFile
import com.ymkang.gitcryptexplorer.ui.chooseSaveFile
import com.ymkang.gitcryptexplorer.ui.contextFiles
import com.ymkang.gitcryptexplorer.ui.runInBackground
import com.ymkang.gitcryptexplorer.ui.withSelectedRepository
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.JTextArea

private const val TITLE = "Git Crypt Explorer"

class RefreshGitCryptAction : AnAction("Refresh Git Crypt") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.getService(GitCryptService::class.java)
        runInBackground(project, "Refreshing git-crypt decorations", { service.refreshNow().join() }) {
            Messages.showInfoMessage(project, "Git Crypt decorations refreshed.", TITLE)
        }
    }
}

class ShowStatusAction : AnAction("Show Status") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.getService(GitCryptService::class.java)
        val snapshot = service.workspaceStatus()
        runInBackground(project, "Collecting git-crypt status", {
            val operations = snapshot.repositories.associate { repository ->
                repository.root to runCatching { service.cli.inspect(repository.root, repository.gitDir, repository.gitCryptDetected) }
            }
            val report = formatWorkspaceStatus(snapshot, operations)
            ApplicationManager.getApplication().invokeLater {
                val area = JTextArea(report, 20, 80)
                area.isEditable = false
                area.lineWrap = false
                Messages.showMessageDialog(project, area.text, "Git Crypt Status", Messages.getInformationIcon())
            }
        })
    }
}

class InitializeWithKeyAction : AnAction("Initialize/Unlock with Existing Key") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.getService(GitCryptService::class.java)
        withSelectedRepository(project, service, event) { repository ->
            val status = inspectOrShowError(project, repository, service) ?: return@withSelectedRepository
            if (!ensureAvailable(project, status)) return@withSelectedRepository
            if (status.localState == GitCryptLocalState.UNLOCKED) {
                Messages.showInfoMessage(project, "This repository is already initialized and unlocked locally.", TITLE)
                return@withSelectedRepository
            }
            val keyFile = chooseOpenFile(project, "Select an existing git-crypt symmetric key") ?: return@withSelectedRepository
            if (!confirm(project, "git-crypt unlock requires a clean tracked working tree and may decrypt protected files in place. Continue?", "Unlock Repository")) return@withSelectedRepository
            runInBackground(project, "Unlocking repository with git-crypt", {
                service.cli.unlockWithKey(repository.root, keyFile)
                service.refreshNow().join()
            }) { Messages.showInfoMessage(project, "Repository initialized and unlocked with the selected git-crypt key.", TITLE) }
        }
    }
}

class InitializeRepositoryAction : AnAction("Initialize New Repository") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.getService(GitCryptService::class.java)
        withSelectedRepository(project, service, event) { repository ->
            val status = inspectOrShowError(project, repository, service) ?: return@withSelectedRepository
            if (!ensureAvailable(project, status)) return@withSelectedRepository
            if (status.localState == GitCryptLocalState.UNLOCKED) {
                Messages.showInfoMessage(project, "This repository is already initialized and unlocked locally.", TITLE)
                return@withSelectedRepository
            }
            if (!confirm(project, "This generates a brand-new git-crypt key. Use it only for a new repository; it will not unlock files encrypted with an existing key.", "Generate New Key")) return@withSelectedRepository
            runInBackground(project, "Initializing repository with git-crypt", {
                service.cli.initializeRepository(repository.root)
                service.refreshNow().join()
            }) { Messages.showInfoMessage(project, "Repository initialized. Export the new key or add a GPG user before sharing it.", TITLE) }
        }
    }
}

class UnlockWithGpgAction : AnAction("Unlock with GPG") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.getService(GitCryptService::class.java)
        withSelectedRepository(project, service, event) { repository ->
            val status = inspectOrShowError(project, repository, service) ?: return@withSelectedRepository
            if (!ensureAvailable(project, status)) return@withSelectedRepository
            if (status.localState == GitCryptLocalState.UNLOCKED) {
                Messages.showInfoMessage(project, "This repository is already unlocked.", TITLE)
                return@withSelectedRepository
            }
            if (!confirm(project, "git-crypt will use an authorized GPG secret key and decrypt protected working-tree files. A clean tracked working tree is required.", "Unlock with GPG")) return@withSelectedRepository
            runInBackground(project, "Unlocking repository with GPG", {
                service.cli.unlockWithGpg(repository.root)
                service.refreshNow().join()
            }) { Messages.showInfoMessage(project, "Repository unlocked with GPG.", TITLE) }
        }
    }
}

class LockRepositoryAction : AnAction("Lock Repository") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.getService(GitCryptService::class.java)
        withSelectedRepository(project, service, event) { repository ->
            val status = inspectOrShowError(project, repository, service) ?: return@withSelectedRepository
            if (!ensureAvailable(project, status)) return@withSelectedRepository
            if (status.localState != GitCryptLocalState.UNLOCKED) {
                Messages.showInfoMessage(project, "This repository is already locked.", TITLE)
                return@withSelectedRepository
            }
            if (!confirm(project, "This re-encrypts protected working-tree files and removes all locally installed git-crypt keys. The command will refuse a dirty tracked working tree.", "Lock Repository")) return@withSelectedRepository
            runInBackground(project, "Locking git-crypt repository", {
                service.cli.lockRepository(repository.root)
                service.refreshNow().join()
            }) { Messages.showInfoMessage(project, "Repository locked.", TITLE) }
        }
    }
}

class AddGpgUserAction : AnAction("Add GPG User (No Auto-Commit)") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.getService(GitCryptService::class.java)
        withSelectedRepository(project, service, event) { repository ->
            val status = inspectOrShowError(project, repository, service) ?: return@withSelectedRepository
            if (!ensureAvailable(project, status)) return@withSelectedRepository
            if (status.localState != GitCryptLocalState.UNLOCKED) {
                Messages.showErrorDialog(project, "Unlock or initialize this repository before adding a GPG user.", TITLE)
                return@withSelectedRepository
            }
            val userId = Messages.showInputDialog(project, "GPG fingerprint, key ID, or email address", "Add a git-crypt GPG collaborator", Messages.getQuestionIcon()) ?: return@withSelectedRepository
            if (userId.trim().isEmpty() || userId.trim().startsWith("-") || userId.any { it == '\u0000' || it == '\r' || it == '\n' }) {
                Messages.showErrorDialog(project, "The GPG user ID is invalid.", TITLE)
                return@withSelectedRepository
            }
            if (!confirm(project, "This grants the selected GPG identity access to the repository key. Generated .git-crypt files will be left uncommitted for your review.", "Add GPG User")) return@withSelectedRepository
            runInBackground(project, "Adding git-crypt GPG user", { service.cli.addGpgUser(repository.root, userId) }) {
                Messages.showInfoMessage(project, "GPG user added. Review and commit the generated .git-crypt files manually.", TITLE)
            }
        }
    }
}

class ExportKeyAction : AnAction("Export Key") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.getService(GitCryptService::class.java)
        withSelectedRepository(project, service, event) { repository ->
            val status = inspectOrShowError(project, repository, service) ?: return@withSelectedRepository
            if (!ensureAvailable(project, status)) return@withSelectedRepository
            if (status.localState != GitCryptLocalState.UNLOCKED) {
                Messages.showErrorDialog(project, "Unlock or initialize this repository before exporting its key.", TITLE)
                return@withSelectedRepository
            }
            val defaultName = "${repository.root.fileName ?: "repository"}.git-crypt.key"
            val destination = chooseSaveFile(project, "Export git-crypt symmetric key", (repository.root.parent ?: repository.root).resolve(defaultName)) ?: return@withSelectedRepository
            val inside = destination.toAbsolutePath().normalize().startsWith(repository.root.toAbsolutePath().normalize())
            val warning = if (inside) "The selected destination is inside the repository and could be committed accidentally. This key grants access to every protected file." else "The exported symmetric key grants access to every protected file. Store and transfer it securely."
            if (!confirm(project, warning, "Export Key")) return@withSelectedRepository
            runInBackground(project, "Exporting git-crypt key", {
                val restricted = service.cli.exportKey(repository.root, destination)
                if (!restricted) throw GitCryptCommandException("Key exported, but restrictive file permissions could not be guaranteed. Secure the file manually.")
            }) { Messages.showInfoMessage(project, "git-crypt key exported successfully.", TITLE) }
        }
    }
}

class ProtectFileAction : AnAction("Add to Encryption Targets") {
    override fun actionPerformed(event: AnActionEvent) = updateProtection(event, GitCryptAttributeMode.PROTECT)
}

class UnprotectFileAction : AnAction("Remove from Encryption Targets") {
    override fun actionPerformed(event: AnActionEvent) = updateProtection(event, GitCryptAttributeMode.UNPROTECT)
}

class ShowIndexedCiphertextAction : AnAction("Show Indexed Ciphertext") {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val project = event.project
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        event.presentation.isEnabledAndVisible = project != null && file != null &&
            project.getService(GitCryptService::class.java).statusForPath(Path.of(file.path)) == GitCryptStatus.ENCRYPTED
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val service = project.getService(GitCryptService::class.java)
        var blob: GitIndexedBlob? = null
        runInBackground(project, "Reading indexed ciphertext", {
            blob = service.readIndexedCiphertext(Path.of(file.path))
                ?: throw IllegalStateException("The selected file is not an encrypted Git index blob.")
        }) {
            val indexedBlob = blob ?: return@runInBackground
            Messages.showMessageDialog(project, formatIndexedCiphertext(indexedBlob), "Indexed Ciphertext", Messages.getInformationIcon())
        }
    }
}

private fun updateProtection(event: AnActionEvent, mode: GitCryptAttributeMode) {
    val project = event.project ?: return
    val service = project.getService(GitCryptService::class.java)
    val files = contextFiles(event)
    if (files.isEmpty()) {
        Messages.showErrorDialog(project, "Select a local file in a Git repository first.", TITLE)
        return
    }
    runInBackground(project, "Updating git-crypt targets", {
        val resources = files.map { virtualFile ->
            val resource = service.repositoryResource(Path.of(virtualFile.path))
                ?: throw IllegalStateException("${virtualFile.path} is not in a discovered Git repository.")
            resource to validateResource(virtualFile, resource)
        }
        val statusByRoot = mutableMapOf<Path, GitCryptRepositoryStatus>()
        resources.forEach { (resource, _) ->
            if (resource.root !in statusByRoot) {
                val snapshot = service.repositorySnapshotForPath(resource.absolutePath)
                    ?: throw IllegalStateException("Could not inspect repository ${resource.root}.")
                statusByRoot[resource.root] = service.cli.inspect(resource.root, snapshot.gitDir, snapshot.protectedFiles > 0)
            }
        }
        statusByRoot.values.mapNotNull(::gitCryptTargetOperationError).firstOrNull()?.let { throw GitCryptCommandException(it) }

        val changed = mutableListOf<String>()
        val skipped = mutableListOf<String>()
        files.zip(resources).forEach { (virtualFile, resourceWithTarget) ->
            val (resource, target) = resourceWithTarget
            val shouldProtect = mode == GitCryptAttributeMode.PROTECT
            if (target == GitCryptAttributeTarget.FILE && service.isProtectedFile(resource.absolutePath) == shouldProtect) {
                skipped += virtualFile.name
            } else if (editNearestAttributesFile(project, resource, mode, target)) {
                changed += virtualFile.name
            } else skipped += virtualFile.name
        }
        if (changed.isNotEmpty()) service.refreshNow().join()
        ApplicationManager.getApplication().invokeLater {
            if (changed.isNotEmpty()) Messages.showInfoMessage(project, "${if (mode == GitCryptAttributeMode.PROTECT) "Added" else "Removed"} ${changed.size} item(s) ${if (mode == GitCryptAttributeMode.PROTECT) "to" else "from"} git-crypt targets. Stage affected files and .gitattributes to update the Git index.", TITLE)
            else if (skipped.isNotEmpty()) Messages.showInfoMessage(project, if (mode == GitCryptAttributeMode.PROTECT) "The selected item is already a git-crypt target." else "The selected item is not a git-crypt target.", TITLE)
        }
    })
}

private fun validateResource(file: VirtualFile, resource: RepositoryResource): GitCryptAttributeTarget {
    if (file.isDirectory && resource.absolutePath.toAbsolutePath().normalize() == resource.root.toAbsolutePath().normalize()) throw IllegalStateException("The repository root cannot be added as a recursive git-crypt target.")
    if (!file.isDirectory && file.name == ".gitattributes") throw IllegalStateException(".gitattributes cannot itself be a git-crypt target.")
    return if (file.isDirectory) GitCryptAttributeTarget.DIRECTORY else GitCryptAttributeTarget.FILE
}

private fun formatIndexedCiphertext(blob: GitIndexedBlob): String {
    val previewLimit = 64 * 1024
    val preview = blob.contents.copyOf(minOf(blob.contents.size, previewLimit))
    val lines = mutableListOf(
        "Path: ${blob.path}",
        "Object: ${blob.objectId}",
        "Size: ${blob.contents.size} bytes",
        if (blob.contents.size > preview.size) "Preview: first ${preview.size} bytes" else "Preview: complete blob",
        "",
    )
    preview.asList().chunked(16).forEachIndexed { index, bytes ->
        val offset = "%08x".format(index * 16)
        val hex = bytes.joinToString(" ") { "%02x".format(it.toInt() and 0xff) }.padEnd(47)
        val text = bytes.joinToString("") { byte ->
            val value = byte.toInt() and 0xff
            if (value in 32..126) value.toChar().toString() else "."
        }
        lines += "$offset  $hex  |$text|"
    }
    return lines.joinToString("\n")
}

private fun editNearestAttributesFile(project: Project, resource: RepositoryResource, mode: GitCryptAttributeMode, target: GitCryptAttributeTarget): Boolean {
    val attributesPath = nearestAttributesFile(resource.absolutePath, resource.root)
    attributesPath.parent?.let { Files.createDirectories(it) }
    if (!Files.exists(attributesPath)) Files.createFile(attributesPath)
    val attributesFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(attributesPath.toFile()) ?: throw IllegalStateException("Could not open $attributesPath.")
    val update: GitAttributesUpdate = updateGitAttributes(VfsUtil.loadText(attributesFile), attributesPath.parent.relativize(resource.absolutePath).toString().replace(java.io.File.separatorChar, '/'), mode, target)
    if (!update.changed) return false
    WriteCommandAction.runWriteCommandAction(project) { VfsUtil.saveText(attributesFile, update.contents) }
    return true
}

private fun nearestAttributesFile(filePath: Path, root: Path): Path {
    val normalizedRoot = root.toAbsolutePath().normalize()
    var directory = filePath.toAbsolutePath().normalize().parent ?: normalizedRoot
    while (directory.startsWith(normalizedRoot)) {
        val candidate = directory.resolve(".gitattributes")
        if (Files.exists(candidate)) return candidate
        if (directory == normalizedRoot) break
        directory = directory.parent ?: break
    }
    return normalizedRoot.resolve(".gitattributes")
}

private fun inspectOrShowError(project: Project, repository: RepositorySnapshot, service: GitCryptService) = try {
    service.cli.inspect(repository.root, repository.gitDir, repository.gitCryptDetected)
} catch (error: Exception) {
    Messages.showErrorDialog(project, error.message ?: "Unknown git-crypt status error.", TITLE)
    null
}

private fun ensureAvailable(project: Project, status: com.ymkang.gitcryptexplorer.core.GitCryptRepositoryStatus): Boolean {
    if (status.available) return true
    Messages.showErrorDialog(project, "git-crypt is not installed or is not available on PATH.", TITLE)
    return false
}

private fun confirm(project: Project, message: String, action: String) = Messages.showYesNoDialog(project, message, TITLE, action, "Cancel", Messages.getWarningIcon()) == Messages.YES

private fun formatWorkspaceStatus(status: WorkspaceStatus, operations: Map<Path, Result<com.ymkang.gitcryptexplorer.core.GitCryptRepositoryStatus>>): String {
    val protected = status.repositories.sumOf { it.protectedFiles }
    val encrypted = status.repositories.sumOf { it.encryptedIndexFiles }
    val warnings = status.repositories.sumOf { it.warnings }
    val lines = mutableListOf("Git repository: ${if (status.repositories.isNotEmpty()) "yes" else "no"}", "git-crypt detected: ${if (status.repositories.any { it.gitCryptDetected }) "yes" else "no"}", "Protected files: $protected", "Encrypted index blobs: $encrypted", "Warnings: $warnings")
    if (status.gitUnavailable) lines += "Git available: no"
    if (status.repositories.size > 1) lines += listOf("", "Repositories: ${status.repositories.size}")
    status.repositories.forEach { repository ->
        if (status.repositories.size > 1 || repository.error != null) {
            lines += listOf("", repository.root.toString(), "  git-crypt detected: ${if (repository.gitCryptDetected) "yes" else "no"}", "  Protected files: ${repository.protectedFiles}", "  Encrypted index blobs: ${repository.encryptedIndexFiles}", "  Warnings: ${repository.warnings}")
        }
        operations[repository.root]?.onSuccess { operation -> lines += listOf("  git-crypt CLI: ${operation.version ?: if (operation.available) "available" else "unavailable"}", "  Local state: ${operation.localState}", "  Installed local keys: ${operation.installedKeyCount}") }?.onFailure { lines += "  git-crypt status error: ${it.message}" }
        repository.error?.let { lines += "  Error: $it" }
    }
    if (status.discoveryErrors.isNotEmpty()) lines += listOf("", *status.discoveryErrors.map { "Discovery error: $it" }.toTypedArray())
    return lines.joinToString("\n")
}
