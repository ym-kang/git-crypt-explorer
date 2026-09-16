package com.ymkang.gitcryptexplorer.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.impl.TitleInfoProvider
import com.ymkang.gitcryptexplorer.core.GitCryptService

/** Adds the project-wide git-crypt count to IntelliJ project window tabs. */
class GitCryptTitleInfoProvider : TitleInfoProvider {
    override fun isActive(project: Project): Boolean {
        val service = project.getService(GitCryptService::class.java)
        return service.encryptedFileCountForProject() > 0 || service.projectHasWarning()
    }

    override fun getValue(project: Project): String {
        val service = project.getService(GitCryptService::class.java)
        val encryptedCount = service.encryptedFileCountForProject()
        return when {
            encryptedCount > 0 -> "🔒 × $encryptedCount"
            service.projectHasWarning() -> "!"
            else -> ""
        }
    }

    override val borderlessSuffix: String = ""
    override val borderlessPrefix: String = " "

    override fun addUpdateListener(project: Project, disp: Disposable, value: (TitleInfoProvider) -> Unit) {
        // GitCryptService broadcasts TitleInfoProvider.fireConfigurationChanged() after each scan.
    }
}
