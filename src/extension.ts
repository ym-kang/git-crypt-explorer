import * as vscode from 'vscode';
import { registerAddGpgUserCommand } from './commands/addGpgUser';
import { registerExportKeyCommand } from './commands/exportKey';
import { registerInitializeWithKeyCommand } from './commands/initializeWithKey';
import { registerInitializeRepositoryCommand } from './commands/initializeRepository';
import { registerLockRepositoryCommand } from './commands/lockRepository';
import { registerRefreshCommand } from './commands/refresh';
import { registerShowStatusCommand } from './commands/showStatus';
import { registerUnlockWithGpgCommand } from './commands/unlockWithGpg';
import { GitCryptDecorationProvider } from './decorations/gitCryptDecorationProvider';
import { GitCryptCli } from './gitCrypt/gitCryptCli';
import { GitCryptService } from './gitCrypt/gitCryptService';
import { WorkspaceController } from './workspaceController';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Crypt Decorations');
  const service = new GitCryptService();
  const cli = new GitCryptCli();
  const decorations = new GitCryptDecorationProvider(service);
  const controller = new WorkspaceController(service, decorations, output);

  context.subscriptions.push(
    output,
    decorations,
    controller,
    vscode.window.registerFileDecorationProvider(decorations),
    registerRefreshCommand(() => controller.refreshNow()),
    registerShowStatusCommand(() => service.getWorkspaceStatus(), cli, output),
    registerInitializeWithKeyCommand(service, cli, () => controller.refreshNow()),
    registerExportKeyCommand(service, cli),
    registerInitializeRepositoryCommand(service, cli, () => controller.refreshNow()),
    registerUnlockWithGpgCommand(service, cli, () => controller.refreshNow()),
    registerLockRepositoryCommand(service, cli, () => controller.refreshNow()),
    registerAddGpgUserCommand(service, cli),
  );

  void controller.initialize();
}

export function deactivate(): void {
  // Resources registered in ExtensionContext are disposed by VS Code.
}
