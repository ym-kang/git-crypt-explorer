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

    const status = this.service.getPathDecoration(uri.fsPath);
    if (status === 'encrypted' || status === 'partial') {
      const encryptedCount = this.service.getEncryptedFileCount(uri.fsPath);
      const badge = status === 'partial' ? partialBadge(encryptedCount) : '🔒';
      const tooltip =
        status === 'partial'
          ? `Partially protected folder: ${encryptedCount} encrypted file${encryptedCount === 1 ? '' : 's'} below this folder`
          : 'Protected by git-crypt (encrypted in Git index)';
      const decoration = new vscode.FileDecoration(
        badge,
        tooltip,
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      );
      return decoration;
    }

    if (status === 'warning') {
      const decoration = new vscode.FileDecoration(
        '!',
        this.service.getStatusDetail(uri.fsPath) ?? 'git-crypt protection warning',
        new vscode.ThemeColor('list.warningForeground'),
      );
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

function partialBadge(encryptedCount: number): string {
  return encryptedCount < 10 ? `🔒${encryptedCount}` : '🔒+';
}
