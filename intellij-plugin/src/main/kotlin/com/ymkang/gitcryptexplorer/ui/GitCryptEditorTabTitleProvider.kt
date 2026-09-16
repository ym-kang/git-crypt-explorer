package com.ymkang.gitcryptexplorer.ui

import com.intellij.openapi.fileEditor.impl.EditorTabTitleProvider
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.ymkang.gitcryptexplorer.core.GitCryptPathDecoration
import com.ymkang.gitcryptexplorer.core.GitCryptService
import java.nio.file.Path

/** Adds the same git-crypt status suffix used by Project View to editor tabs. */
class GitCryptEditorTabTitleProvider : EditorTabTitleProvider {
    override fun getEditorTabTitle(project: Project, file: VirtualFile): String? {
        val service = project.getService(GitCryptService::class.java)
        val path = Path.of(file.path)
        return when (service.pathDecorationForPath(path)) {
            GitCryptPathDecoration.ENCRYPTED -> "${file.name} 🔒"
            GitCryptPathDecoration.PARTIAL -> {
                "${file.name} 🔒 × ${service.encryptedFileCountForPath(path)}"
            }
            GitCryptPathDecoration.WARNING -> "${file.name} !"
            GitCryptPathDecoration.NONE -> null
        }
    }
}
