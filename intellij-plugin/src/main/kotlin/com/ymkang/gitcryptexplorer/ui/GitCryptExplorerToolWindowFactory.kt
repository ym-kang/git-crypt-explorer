package com.ymkang.gitcryptexplorer.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class GitCryptExplorerToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        toolWindow.setIcon(GitCryptIcons.Explorer)

        val content = ContentFactory.getInstance().createContent(
            GitCryptExplorerPanel(project),
            "",
            false,
        )
        toolWindow.contentManager.addContent(content)
    }
}
