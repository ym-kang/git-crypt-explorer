import * as vscode from 'vscode';
import { GitCryptService } from '../gitCrypt/gitCryptService';

export class GitCryptDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

  public readonly onDidChangeFileDecorations = this.changeEmitter.event;

  public constructor(private readonly service: GitCryptService) {}

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (
      uri.scheme !== 'file' ||
      !vscode.workspace.getConfiguration('gitCryptDecorations').get('enabled', true)
    ) {
      return undefined;
    }

    const status = this.service.getStatus(uri.fsPath);
    if (status === 'encrypted') {
      const decoration = new vscode.FileDecoration(
        '🔒',
        'Protected by git-crypt',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      );
      decoration.propagate = true;
      return decoration;
    }

    if (status === 'warning') {
      const decoration = new vscode.FileDecoration(
        '!',
        'git-crypt protection warning',
        new vscode.ThemeColor('list.warningForeground'),
      );
      decoration.propagate = true;
      return decoration;
    }

    return undefined;
  }

  public refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}
