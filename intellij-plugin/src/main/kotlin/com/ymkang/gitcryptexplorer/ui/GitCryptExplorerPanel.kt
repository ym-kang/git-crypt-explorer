package com.ymkang.gitcryptexplorer.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import com.ymkang.gitcryptexplorer.core.GitCryptService
import com.ymkang.gitcryptexplorer.core.GitCryptStatus
import com.ymkang.gitcryptexplorer.core.RepositorySnapshot
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.nio.file.Path
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTree
import javax.swing.SwingUtilities
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeCellRenderer
import javax.swing.tree.DefaultTreeModel

class GitCryptExplorerPanel(private val project: Project) : JBPanel<GitCryptExplorerPanel>(BorderLayout()) {
    private val service = project.getService(GitCryptService::class.java)
    private val summary = JBLabel()
    private val rootNode = DefaultMutableTreeNode("Git Crypt Explorer")
    private val tree = JTree(DefaultTreeModel(rootNode))

    private sealed interface ExplorerNode
    private data class RepositoryNode(val snapshot: RepositorySnapshot) : ExplorerNode
    private data class GroupNode(val snapshot: RepositorySnapshot, val status: GitCryptStatus) : ExplorerNode
    private data class FileNode(val snapshot: RepositorySnapshot, val path: Path, val status: GitCryptStatus) : ExplorerNode
    private data class MessageNode(val text: String) : ExplorerNode

    init {
        border = JBUI.Borders.empty(8)
        val toolbar = JPanel(BorderLayout())
        toolbar.add(summary, BorderLayout.CENTER)
        val refreshButton = JButton("Refresh")
        refreshButton.addActionListener { service.refreshNow() }
        toolbar.add(refreshButton, BorderLayout.EAST)
        add(toolbar, BorderLayout.NORTH)
        tree.isRootVisible = false
        tree.cellRenderer = ExplorerTreeCellRenderer()
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(event: MouseEvent) {
                if (event.clickCount != 2 || !SwingUtilities.isLeftMouseButton(event)) return
                val node = tree.lastSelectedPathComponent as? DefaultMutableTreeNode ?: return
                val file = node.userObject as? FileNode ?: return
                openFile(project, file.path)
            }
        })
        add(JScrollPane(tree), BorderLayout.CENTER)
        service.addRefreshListener { refresh() }
        refresh()
    }

    fun refresh() {
        ApplicationManager.getApplication().invokeLater {
            val status = service.workspaceStatus()
            val protected = status.repositories.sumOf { it.protectedFiles }
            val warnings = status.repositories.sumOf { it.warnings }
            summary.text = if (status.repositories.isEmpty()) "No Git repositories" else "$protected protected · $warnings warnings"
            rootNode.removeAllChildren()
            status.discoveryErrors.forEach { rootNode.add(DefaultMutableTreeNode(MessageNode("Discovery failed: $it"))) }
            if (status.repositories.isEmpty()) {
                rootNode.add(DefaultMutableTreeNode(MessageNode(if (status.gitUnavailable) "Git is not available on PATH." else "Open a Git project to inspect git-crypt status.")))
            } else {
                status.repositories.forEach { snapshot ->
                    val repo = DefaultMutableTreeNode(RepositoryNode(snapshot))
                    if (snapshot.error != null) repo.add(DefaultMutableTreeNode(MessageNode("Scan failed: ${snapshot.error}")))
                    if (!snapshot.gitCryptDetected) {
                        repo.add(DefaultMutableTreeNode(MessageNode("No git-crypt targets detected.")))
                    } else {
                        listOf(GitCryptStatus.ENCRYPTED, GitCryptStatus.WARNING).forEach { groupStatus ->
                            val paths = snapshot.statuses.filterValues { it == groupStatus }.keys.sortedBy { it.toString() }
                            if (paths.isNotEmpty()) {
                                val group = DefaultMutableTreeNode(GroupNode(snapshot, groupStatus))
                                paths.forEach { group.add(DefaultMutableTreeNode(FileNode(snapshot, it, groupStatus))) }
                                repo.add(group)
                            }
                        }
                    }
                    rootNode.add(repo)
                }
            }
            (tree.model as DefaultTreeModel).reload()
            if (status.repositories.size == 1) tree.expandRow(0)
        }
    }

    private class ExplorerTreeCellRenderer : DefaultTreeCellRenderer() {
        override fun getTreeCellRendererComponent(tree: JTree, value: Any, selected: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean): java.awt.Component {
            super.getTreeCellRendererComponent(tree, value, selected, expanded, leaf, row, hasFocus)
            val node = (value as? DefaultMutableTreeNode)?.userObject
            text = when (node) {
                is RepositoryNode -> "${node.snapshot.root.fileName ?: node.snapshot.root}  (${node.snapshot.protectedFiles} protected · ${node.snapshot.warnings} warnings)"
                is GroupNode -> if (node.status == GitCryptStatus.WARNING) "Warnings (${node.snapshot.warnings})" else "Encrypted in Git index (${node.snapshot.encryptedIndexFiles})"
                is FileNode -> "${node.snapshot.root.relativize(node.path)} ${if (node.status == GitCryptStatus.WARNING) "!" else "🔒"}${if (node.status == GitCryptStatus.WARNING) " — ${node.snapshot.statusDetails[node.path].orEmpty()}" else ""}"
                is MessageNode -> node.text
                else -> node?.toString().orEmpty()
            }
            return this
        }
    }
}
