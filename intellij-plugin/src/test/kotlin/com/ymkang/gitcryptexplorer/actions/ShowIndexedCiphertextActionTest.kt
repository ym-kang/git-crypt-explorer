package com.ymkang.gitcryptexplorer.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame

class ShowIndexedCiphertextActionTest : BasePlatformTestCase() {
    fun testIndexedCiphertextActionUpdatesInTheBackground() {
        assertSame(ActionUpdateThread.BGT, ShowIndexedCiphertextAction().getActionUpdateThread())
    }

    fun testIndexedCiphertextActionIsHiddenWithoutAProjectFileContext() {
        val action = ShowIndexedCiphertextAction()
        val event = AnActionEvent.createFromAnAction(
            action,
            null,
            "ProjectViewPopup",
            SimpleDataContext.getProjectContext(project),
        )

        action.update(event)

        assertFalse(event.presentation.isEnabledAndVisible)
    }
}
