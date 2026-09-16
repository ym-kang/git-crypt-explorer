import * as vscode from 'vscode';
import { registerAddGpgUserCommand } from './commands/addGpgUser';
import { registerExportKeyCommand } from './commands/exportKey';
import { registerInitializeWithKeyCommand } from './commands/initializeWithKey';
import { registerInitializeRepositoryCommand } from './commands/initializeRepository';
import { registerLockRepositoryCommand } from './commands/lockRepository';
import { registerRefreshCommand } from './commands/refresh';
import { registerShowStatusCommand } from './commands/showStatus';
import { registerUnlockWithGpgCommand } from './commands/unlockWithGpg';
import { registerFileProtectionCommands } from './commands/updateFileProtection';
import { GitCryptDecorationProvider } from './decorations/gitCryptDecorationProvider';
import { GitCryptCli } from './gitCrypt/gitCryptCli';
import { GitCryptService } from './gitCrypt/gitCryptService';
import {
  ExplorerViewMode,
  GitCryptExplorerTreeProvider,
  TreeNode,
  updateGitCryptExplorerView,
} from './views/gitCryptExplorerTree';
import { WorkspaceController } from './workspaceController';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Crypt Decorations', { log: true });
  output.info('Activation started.');
  const service = new GitCryptService();
  const cli = new GitCryptCli();
  const decorations = new GitCryptDecorationProvider(service);
  const controller = new WorkspaceController(service, decorations, output);
  const initialViewMode = context.workspaceState.get<ExplorerViewMode>(
    'gitCryptExplorer.viewMode',
    'grouped',
  );
  const treeProvider = new GitCryptExplorerTreeProvider(service, initialViewMode);
  const treeView = vscode.window.createTreeView('gitCryptExplorer.repositories', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  output.info(`Tree view created. Initial view mode: ${initialViewMode}.`);
  const refreshTreeView = (): void => {
    try {
      output.info('Tree refresh started.');
      treeProvider.refresh();
      updateGitCryptExplorerView(treeView, service);
      output.info('Tree refresh completed.');
    } catch (error) {
      output.error(`[tree] ${formatError(error)}`);
    }
  };
  const updateViewModeContext = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'gitCryptExplorer.viewMode',
      treeProvider.currentViewMode,
    );
  };
  const expandAllExplorerTree = async (): Promise<void> => {
    output.info('Tree expansion started.');
    treeProvider.setTreeExpanded(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const expandNode = async (node: TreeNode): Promise<void> => {
      const children = treeProvider.getChildren(node);
      if (children.length === 0) {
        return;
      }

      try {
        await treeView.reveal(node, {
          select: false,
          focus: false,
          expand: true,
        });
      } catch (error) {
        output.error(`[tree] Failed to expand ${node.kind} node: ${formatError(error)}`);
        return;
      }

      for (const child of children) {
        await expandNode(child);
      }
    };

    for (const root of treeProvider.getChildren()) {
      await expandNode(root);
    }
    output.info('Tree expansion completed.');
  };
  let initializationComplete = false;

  context.subscriptions.push(
    output,
    decorations,
    controller,
    treeProvider,
    treeView,
    controller.onDidRefresh(refreshTreeView),
    vscode.window.registerFileDecorationProvider(decorations),
    registerRefreshCommand(() => controller.refreshNow()),
    registerShowStatusCommand(() => service.getWorkspaceStatus(), cli, output),
    registerInitializeWithKeyCommand(service, cli, () => controller.refreshNow()),
    registerExportKeyCommand(service, cli),
    registerInitializeRepositoryCommand(service, cli, () => controller.refreshNow()),
    registerUnlockWithGpgCommand(service, cli, () => controller.refreshNow()),
    registerLockRepositoryCommand(service, cli, () => controller.refreshNow()),
    registerAddGpgUserCommand(service, cli),
    registerFileProtectionCommands(service, () => controller.refreshNow()),
    vscode.commands.registerCommand('gitCryptDecorations.toggleExplorerView', () => {
      const nextViewMode = treeProvider.toggleViewMode(initializationComplete);
      updateViewModeContext();
      void context.workspaceState.update('gitCryptExplorer.viewMode', nextViewMode);
    }),
    vscode.commands.registerCommand('gitCryptDecorations.expandExplorerTree', () => {
      return expandAllExplorerTree();
    }),
    vscode.commands.registerCommand('gitCryptDecorations.collapseExplorerTree', () => {
      treeProvider.setTreeExpanded(false);
    }),
  );

  updateViewModeContext();
  output.info('Workspace initialization started.');
  void controller.initialize()
    .then(() => {
      output.info('Workspace initialization completed.');
      initializationComplete = true;
      if (treeProvider.currentViewMode !== 'tree') {
        return;
      }
      return new Promise<void>((resolve) => setTimeout(resolve, 250))
        .then(() => expandAllExplorerTree());
    })
    .catch((error: unknown) => {
      output.error(`[startup] ${formatError(error)}`);
    });
}

export function deactivate(): void {
  // Resources registered in ExtensionContext are disposed by VS Code.
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}
