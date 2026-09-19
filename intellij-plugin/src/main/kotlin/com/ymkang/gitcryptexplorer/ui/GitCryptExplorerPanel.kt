package com.ymkang.gitcryptexplorer.ui

import com.intellij.ide.util.PropertiesComponent
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.CustomizedDataContext
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.actionSystem.DataProvider
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import com.ymkang.gitcryptexplorer.core.GitCryptService
import com.ymkang.gitcryptexplorer.core.GitCryptRepositoryStatus
import com.ymkang.gitcryptexplorer.core.GitCryptStatus
import com.ymkang.gitcryptexplorer.core.GitCryptSetupRecommendation
import com.ymkang.gitcryptexplorer.core.RepositorySnapshot
import com.ymkang.gitcryptexplorer.core.recommendGitCryptSetup
import java.awt.BorderLayout
import java.awt.FlowLayout
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
    private companion object {
        const val TREE_VIEW_KEY = "gitCryptExplorer.treeView"
        val MANAGEMENT_ACTION_IDS = listOf(
            "com.ymkang.gitcryptexplorer.ShowStatus",
            "com.ymkang.gitcryptexplorer.InitializeWithKey",
            "com.ymkang.gitcryptexplorer.InitializeRepository",
            "com.ymkang.gitcryptexplorer.UnlockWithGpg",
            "com.ymkang.gitcryptexplorer.LockRepository",
            "com.ymkang.gitcryptexplorer.ExportKey",
            "com.ymkang.gitcryptexplorer.AddGpgUser",
        )
    }

    private val service = project.getService(GitCryptService::class.java)
    private val summary = JBLabel()
    private val rootNode = DefaultMutableTreeNode("Git Crypt Explorer")
    private val tree = JTree(DefaultTreeModel(rootNode))
    private var isTreeView = PropertiesComponent.getInstance(project).getBoolean(TREE_VIEW_KEY, false)
    private var treeExpanded = true
    private var promptedGitInitialization = false
    private val promptedSetupRepositories = mutableSetOf<Path>()

    private sealed interface ExplorerNode
    private data class RepositoryNode(val snapshot: RepositorySnapshot) : ExplorerNode
    private data class GroupNode(val snapshot: RepositorySnapshot, val status: GitCryptStatus) : ExplorerNode
    private data class DirectoryNode(val snapshot: RepositorySnapshot, val path: Path) : ExplorerNode
    private data class FileNode(val snapshot: RepositorySnapshot, val path: Path, val status: GitCryptStatus) : ExplorerNode
    private data class MessageNode(val text: String) : ExplorerNode

    init {
        border = JBUI.Borders.empty(8)
        val toolbar = JPanel(BorderLayout())
        toolbar.add(summary, BorderLayout.CENTER)
        val viewButton = JButton()
        configureIconButton(viewButton)
        val expandButton = JButton(AllIcons.Actions.Expandall)
        configureIconButton(expandButton)
        expandButton.toolTipText = "Expand all"
        expandButton.addActionListener {
            treeExpanded = true
            expandAll()
        }
        val collapseButton = JButton(AllIcons.Actions.Collapseall)
        configureIconButton(collapseButton)
        collapseButton.toolTipText = "Collapse all"
        collapseButton.addActionListener {
            treeExpanded = false
            collapseAll()
        }
        viewButton.addActionListener {
            isTreeView = !isTreeView
            if (isTreeView) treeExpanded = true
            PropertiesComponent.getInstance(project).setValue(TREE_VIEW_KEY, isTreeView)
            updateViewButton(viewButton)
            updateTreeActionButtons(expandButton, collapseButton)
            refresh()
        }
        updateViewButton(viewButton)
        updateTreeActionButtons(expandButton, collapseButton)
        val refreshButton = JButton(AllIcons.Actions.Refresh)
        configureIconButton(refreshButton)
        refreshButton.toolTipText = "Refresh"
        refreshButton.addActionListener { service.refreshNow() }
        val actionsButton = JButton(AllIcons.Actions.MoreHorizontal)
        configureIconButton(actionsButton)
        actionsButton.toolTipText = "Git Crypt actions"
        actionsButton.accessibleContext.accessibleName = actionsButton.toolTipText
        actionsButton.addActionListener { showManagementActions(actionsButton) }
        val actions = JPanel(FlowLayout(FlowLayout.RIGHT, 4, 0))
        actions.add(viewButton)
        actions.add(expandButton)
        actions.add(collapseButton)
        actions.add(actionsButton)
        actions.add(refreshButton)
        toolbar.add(actions, BorderLayout.EAST)
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

    private fun showManagementActions(anchor: JButton) {
        val actionManager = ActionManager.getInstance()
        val group = DefaultActionGroup()
        MANAGEMENT_ACTION_IDS.mapNotNull(actionManager::getAction).forEach(group::add)
        val parentContext = com.intellij.ide.DataManager.getInstance().getDataContext(this)
        val context = CustomizedDataContext.withProvider(parentContext, DataProvider { dataId ->
            if (dataId == CommonDataKeys.PROJECT.name) project else DataKey.create<Any>(dataId).getData(parentContext)
        })
        JBPopupFactory.getInstance()
            .createActionGroupPopup(
                "Git Crypt Actions",
                group,
                context,
                JBPopupFactory.ActionSelectionAid.MNEMONICS,
                true,
            )
            .showUnderneathOf(anchor)
    }

    fun refresh() {
        ApplicationManager.getApplication().invokeLater {
            val status = service.workspaceStatus()
            val encrypted = status.repositories.sumOf { it.protectedFiles }
            val warnings = status.repositories.sumOf { it.warnings }
            summary.text = if (status.repositories.isEmpty()) "No Git repositories" else "$encrypted encrypted · $warnings warnings"
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
                    } else if (isTreeView) {
                        addTreeChildren(repo, snapshot, snapshot.root)
                    } else {
                        addListChildren(repo, snapshot)
                    }
                    rootNode.add(repo)
                }
            }
            (tree.model as DefaultTreeModel).reload()
            if (isTreeView && treeExpanded) {
                expandAll()
            } else if (!isTreeView && status.repositories.size == 1) {
                tree.expandRow(0)
            }
            offerGuidedSetup(status)
        }
    }

    private fun offerGuidedSetup(status: com.ymkang.gitcryptexplorer.core.WorkspaceStatus) {
        if (status.repositories.isEmpty()) {
            if (!promptedGitInitialization && status.nonGitFolders > 0 && !status.gitUnavailable) {
                promptedGitInitialization = true
                project.basePath?.let { basePath ->
                    initializeGitRepositoryWithPrompt(project, service, Path.of(basePath))
                }
            }
            return
        }

        status.repositories
            .filter { it.root !in promptedSetupRepositories }
            .forEach { repository ->
                promptedSetupRepositories.add(repository.root)
                var inspected: GitCryptRepositoryStatus? = null
                runInBackground(project, "Checking git-crypt setup", {
                    inspected = service.cli.inspect(repository.root, repository.gitDir, repository.protectedFiles > 0)
                }) {
                    inspected?.let { offerRepositorySetup(repository, it) }
                }
            }
    }

    private fun offerRepositorySetup(repository: RepositorySnapshot, status: GitCryptRepositoryStatus) {
        if (!status.available) return

        when (recommendGitCryptSetup(true, repository.protectedFiles, status.localState)) {
            GitCryptSetupRecommendation.UNLOCK -> offerUnlock(repository)
            GitCryptSetupRecommendation.INITIALIZE_GIT_CRYPT -> offerGitCryptInitialization(repository)
            else -> Unit
        }
    }

    private fun offerGitCryptInitialization(repository: RepositorySnapshot) {
        if (Messages.showYesNoDialog(
                project,
                "No git-crypt targets or local key were found in ${repository.root.fileName ?: repository.root}. Initialize it with a new key?",
                "Initialize git-crypt",
                "Initialize",
                "Later",
                Messages.getQuestionIcon(),
            ) != Messages.YES) return
        runInBackground(project, "Initializing repository with git-crypt", {
            service.cli.initializeRepository(repository.root)
            service.refreshNow().join()
        }) {
            Messages.showInfoMessage(project, "Repository initialized with a new git-crypt key. Export the key or add a GPG user before sharing it.", "Git Crypt Explorer")
        }
    }

    private fun offerUnlock(repository: RepositorySnapshot) {
        val choice = Messages.showChooseDialog(
            project,
            "Protected git-crypt files were found, but this repository is locked. Unlock now?",
            "Unlock git-crypt repository",
            Messages.getQuestionIcon(),
            arrayOf("Unlock with GPG", "Use an existing key", "Later"),
            "Unlock with GPG",
        )
        when (choice) {
            0 -> if (confirmGuidedAction("git-crypt will use an authorized GPG key and decrypt protected files in the working tree.", "Unlock with GPG")) {
                runInBackground(project, "Unlocking repository with GPG", {
                    service.cli.unlockWithGpg(repository.root)
                    service.refreshNow().join()
                }) { Messages.showInfoMessage(project, "Repository unlocked with GPG.", "Git Crypt Explorer") }
            }
            1 -> {
                val keyFile = chooseOpenFile(project, "Select an existing git-crypt symmetric key") ?: return
                if (confirmGuidedAction("git-crypt will use the selected key and decrypt protected files in the working tree.", "Unlock Repository")) {
                    runInBackground(project, "Unlocking repository with git-crypt", {
                        service.cli.unlockWithKey(repository.root, keyFile)
                        service.refreshNow().join()
                    }) { Messages.showInfoMessage(project, "Repository unlocked with the selected git-crypt key.", "Git Crypt Explorer") }
                }
            }
        }
    }

    private fun confirmGuidedAction(message: String, action: String) =
        Messages.showYesNoDialog(project, message, "Git Crypt Explorer", action, "Cancel", Messages.getWarningIcon()) == Messages.YES

    private fun updateViewButton(button: JButton) {
        button.text = null
        button.icon = if (isTreeView) AllIcons.Actions.ListFiles else AllIcons.Actions.ShowAsTree
        button.toolTipText = if (isTreeView) "Switch to list view" else "Switch to tree view"
        button.accessibleContext.accessibleName = button.toolTipText
    }

    private fun configureIconButton(button: JButton) {
        val size = JBUI.size(24, 24)
        button.margin = JBUI.insets(2)
        button.preferredSize = size
        button.minimumSize = size
        button.maximumSize = size
        button.isFocusable = false
    }

    private fun updateTreeActionButtons(expandButton: JButton, collapseButton: JButton) {
        expandButton.isVisible = isTreeView
        collapseButton.isVisible = isTreeView
    }

    private fun expandAll() {
        var row = 0
        while (row < tree.rowCount) {
            tree.expandRow(row)
            row++
        }
    }

    private fun collapseAll() {
        for (row in tree.rowCount - 1 downTo 0) {
            tree.collapseRow(row)
        }
    }

    private fun addListChildren(repo: DefaultMutableTreeNode, snapshot: RepositorySnapshot) {
        val encryptedPaths = snapshot.statuses
            .filterValues { it == GitCryptStatus.ENCRYPTED }
            .keys
            .sortedBy { it.toString() }
        encryptedPaths.forEach { path ->
            repo.add(DefaultMutableTreeNode(FileNode(snapshot, path, GitCryptStatus.ENCRYPTED)))
        }

        val warningPaths = snapshot.statuses
            .filterValues { it == GitCryptStatus.WARNING }
            .keys
            .sortedBy { it.toString() }
        if (warningPaths.isNotEmpty()) {
            val group = DefaultMutableTreeNode(GroupNode(snapshot, GitCryptStatus.WARNING))
            warningPaths.forEach { path ->
                group.add(DefaultMutableTreeNode(FileNode(snapshot, path, GitCryptStatus.WARNING)))
            }
            repo.add(group)
        }
    }

    private fun addTreeChildren(parent: DefaultMutableTreeNode, snapshot: RepositorySnapshot, parentPath: Path) {
        val directories = linkedMapOf<Path, DefaultMutableTreeNode>()
        val files = mutableListOf<FileNode>()
        snapshot.statuses.entries
            .sortedBy { it.key.toString() }
            .forEach { (filePath, status) ->
                if (!filePath.startsWith(parentPath)) return@forEach
                val relative = parentPath.relativize(filePath)
                if (relative.nameCount == 0) return@forEach
                if (relative.nameCount == 1) {
                    files += FileNode(snapshot, filePath, status)
                } else {
                    val directoryPath = parentPath.resolve(relative.getName(0).toString())
                    directories.getOrPut(directoryPath) {
                        DefaultMutableTreeNode(DirectoryNode(snapshot, directoryPath))
                    }
                }
            }

        directories.toSortedMap(compareBy { it.fileName.toString() }).forEach { (directoryPath, node) ->
            parent.add(node)
            addTreeChildren(node, snapshot, directoryPath)
        }
        files.sortedBy { it.path.toString() }.forEach { file ->
            parent.add(DefaultMutableTreeNode(file))
        }
    }

    private inner class ExplorerTreeCellRenderer : DefaultTreeCellRenderer() {
        override fun getTreeCellRendererComponent(tree: JTree, value: Any, selected: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean): java.awt.Component {
            super.getTreeCellRendererComponent(tree, value, selected, expanded, leaf, row, hasFocus)
            val node = (value as? DefaultMutableTreeNode)?.userObject
            text = when (node) {
                is RepositoryNode -> "${node.snapshot.root.fileName ?: node.snapshot.root}  (${node.snapshot.protectedFiles} encrypted · ${node.snapshot.warnings} warnings)"
                is GroupNode -> "Warnings (${node.snapshot.warnings})"
                is DirectoryNode -> {
                    val prefix = node.path.toString() + java.io.File.separator
                    val encrypted = node.snapshot.statuses.count { (path, status) -> path.toString().startsWith(prefix) && status == GitCryptStatus.ENCRYPTED }
                    val warnings = node.snapshot.statuses.count { (path, status) -> path.toString().startsWith(prefix) && status == GitCryptStatus.WARNING }
                    "${node.path.fileName}  (${encrypted} encrypted${if (warnings > 0) ", $warnings warnings" else ""})"
                }
                is FileNode -> "${if (isTreeView) node.path.fileName else node.snapshot.root.relativize(node.path)} ${if (node.status == GitCryptStatus.WARNING) "!" else "🔒"}${if (node.status == GitCryptStatus.WARNING) " — ${node.snapshot.statusDetails[node.path].orEmpty()}" else ""}"
                is MessageNode -> node.text
                else -> node?.toString().orEmpty()
            }
            return this
        }
    }
}
