import * as vscode from 'vscode';
import { registerRefreshCommand } from './commands/refresh';
import { registerShowStatusCommand } from './commands/showStatus';
import { GitCryptDecorationProvider } from './decorations/gitCryptDecorationProvider';
import { GitCryptService } from './gitCrypt/gitCryptService';
import { WorkspaceController } from './workspaceController';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Crypt Decorations');
  const service = new GitCryptService();
  const decorations = new GitCryptDecorationProvider(service);
  const controller = new WorkspaceController(service, decorations, output);

  context.subscriptions.push(
    output,
    decorations,
    controller,
    vscode.window.registerFileDecorationProvider(decorations),
    registerRefreshCommand(() => controller.refreshNow()),
    registerShowStatusCommand(() => service.getWorkspaceStatus(), output),
  );

  void controller.initialize();
}

export function deactivate(): void {
  // Resources registered in ExtensionContext are disposed by VS Code.
}
