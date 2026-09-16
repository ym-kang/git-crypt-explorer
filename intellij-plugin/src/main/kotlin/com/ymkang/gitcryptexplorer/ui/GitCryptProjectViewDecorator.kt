package com.ymkang.gitcryptexplorer.ui

import com.intellij.ide.projectView.PresentationData
import com.intellij.ide.projectView.ProjectViewNode
import com.intellij.ide.projectView.ProjectViewNodeDecorator
import com.intellij.openapi.project.Project
import com.intellij.ui.SimpleTextAttributes
import com.ymkang.gitcryptexplorer.core.GitCryptService
import com.ymkang.gitcryptexplorer.core.GitCryptPathDecoration

class GitCryptProjectViewDecorator(private val project: Project) : ProjectViewNodeDecorator {
    private val service get() = project.getService(GitCryptService::class.java)

    override fun decorate(node: ProjectViewNode<*>, data: PresentationData) {
        val virtualFile = node.virtualFile ?: return
        val path = java.nio.file.Path.of(virtualFile.path)
        when (service.pathDecorationForPath(path)) {
            GitCryptPathDecoration.ENCRYPTED -> decorateWithSuffix(data, virtualFile.name, "  🔒", SimpleTextAttributes.REGULAR_ATTRIBUTES)
            GitCryptPathDecoration.PARTIAL -> {
                val encryptedCount = service.encryptedFileCountForPath(path)
                decorateWithSuffix(data, virtualFile.name, "  🔒 × $encryptedCount", SimpleTextAttributes.REGULAR_ATTRIBUTES)
            }
            GitCryptPathDecoration.WARNING -> decorateWithSuffix(data, virtualFile.name, "  !", SimpleTextAttributes.ERROR_ATTRIBUTES)
            GitCryptPathDecoration.NONE -> Unit
        }
    }

    private fun decorateWithSuffix(data: PresentationData, fileName: String, suffix: String, suffixAttributes: SimpleTextAttributes) {
        data.clearText()
        data.addText(fileName, SimpleTextAttributes.REGULAR_ATTRIBUTES)
        data.addText(suffix, suffixAttributes)
    }
}
