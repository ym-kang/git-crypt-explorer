package com.ymkang.gitcryptexplorer.ui

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import com.ymkang.gitcryptexplorer.core.GitCryptService
import com.ymkang.gitcryptexplorer.core.RepositorySnapshot
import java.awt.Component
import java.nio.file.Path
import javax.swing.JFileChooser

fun contextFiles(event: AnActionEvent): List<VirtualFile> =
    (event.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList()
        ?: event.getData(CommonDataKeys.VIRTUAL_FILE)?.let(::listOf)
        ?: emptyList()).distinctBy { it.path }

fun selectRepository(project: Project, service: GitCryptService, event: AnActionEvent): RepositorySnapshot? {
    val repositories = service.workspaceStatus().repositories
    if (repositories.isEmpty()) {
        Messages.showErrorDialog(project, "No Git repository was detected in this project.", "Git Crypt Explorer")
        return null
    }
    contextFiles(event).firstNotNullOfOrNull { service.repositorySnapshotForPath(Path.of(it.path)) }?.let { return it }
    if (repositories.size == 1) return repositories.first()
    val names = repositories.map { it.root.fileName?.toString() ?: it.root.toString() }.toTypedArray()
    val index = Messages.showChooseDialog(project, "Repository for the git-crypt operation", "Select a Git Repository", Messages.getQuestionIcon(), names, names.first())
    return repositories.getOrNull(index)
}

fun runInBackground(project: Project, title: String, work: () -> Unit, success: () -> Unit = {}) {
    var failure: Throwable? = null
    ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, true) {
        override fun run(indicator: ProgressIndicator) {
            try { work() } catch (error: Throwable) { failure = error }
        }

        override fun onSuccess() {
            failure?.let { Messages.showErrorDialog(project, it.message ?: "Unknown error.", title) } ?: success()
        }
    })
}

fun chooseOpenFile(project: Project, title: String): Path? {
    val chooser = JFileChooser(project.basePath ?: System.getProperty("user.dir"))
    chooser.dialogTitle = title
    return if (chooser.showOpenDialog(parentComponent(project)) == JFileChooser.APPROVE_OPTION) chooser.selectedFile.toPath() else null
}

fun chooseSaveFile(project: Project, title: String, defaultFile: Path): Path? {
    val chooser = JFileChooser(defaultFile.parent?.toFile())
    chooser.selectedFile = defaultFile.toFile()
    chooser.dialogTitle = title
    return if (chooser.showSaveDialog(parentComponent(project)) == JFileChooser.APPROVE_OPTION) chooser.selectedFile.toPath() else null
}

private fun parentComponent(project: Project): Component? = WindowManager.getInstance().suggestParentWindow(project)

fun openFile(project: Project, path: Path) {
    val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(path.toFile()) ?: return
    OpenFileDescriptor(project, virtualFile).navigate(true)
}
