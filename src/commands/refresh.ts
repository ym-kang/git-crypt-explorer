import * as vscode from 'vscode';

export function registerRefreshCommand(refresh: () => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand('gitCryptDecorations.refresh', async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Refreshing git-crypt decorations',
      },
      refresh,
    );
    void vscode.window.showInformationMessage('Git Crypt decorations refreshed.');
  });
}
