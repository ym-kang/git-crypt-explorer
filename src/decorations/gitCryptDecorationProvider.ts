import * as vscode from 'vscode';
import { GitCryptService } from '../gitCrypt/gitCryptService';

export class GitCryptDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  private readonly decorationCache = new Map<string, vscode.FileDecoration | null>();
  private decorationEnabled: boolean | undefined;

  public readonly onDidChangeFileDecorations = this.changeEmitter.event;

  public constructor(private readonly service: GitCryptService) {}

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }

    const enabled = this.isEnabled();
    this.decorationEnabled = enabled;
    if (!enabled) {
      return undefined;
    }

    // File decorations are requested again during Explorer focus changes. Keep
    // returning the last resolved object until refresh() announces a completed
    // snapshot update, so a pending evaluation cannot clear or blink the badge.
    if (this.decorationCache.has(uri.fsPath)) {
      return this.decorationCache.get(uri.fsPath) ?? undefined;
    }

    const decoration = this.resolveDecoration(uri.fsPath);
    this.decorationCache.set(uri.fsPath, decoration);
    return decoration ?? undefined;
  }

  public refresh(): void {
    const enabled = this.isEnabled();
    const configurationChanged =
      this.decorationEnabled !== undefined && this.decorationEnabled !== enabled;
    this.decorationEnabled = enabled;
    if (!enabled) {
      const hadDecorations = this.decorationCache.size > 0 || configurationChanged;
      this.decorationCache.clear();
      if (hadDecorations) {
        this.changeEmitter.fire(undefined);
      }
      return;
    }

    if (configurationChanged) {
      this.decorationCache.clear();
      this.changeEmitter.fire(undefined);
      return;
    }

    // Resolve already-rendered paths before notifying VS Code. This avoids an
    // empty decoration window between invalidation and the next provider call.
    const changedPaths: vscode.Uri[] = [];
    for (const [filePath, previous] of this.decorationCache) {
      const next = this.resolveDecoration(filePath);
      if (sameDecoration(previous, next)) {
        continue;
      }
      this.decorationCache.set(filePath, next);
      changedPaths.push(vscode.Uri.file(filePath));
    }
    if (changedPaths.length > 0) {
      this.changeEmitter.fire(changedPaths);
    }
  }

  public dispose(): void {
    this.decorationCache.clear();
    this.changeEmitter.dispose();
  }

  private resolveDecoration(filePath: string): vscode.FileDecoration | null {
    const status = this.service.getPathDecoration(filePath);
    if (status === 'encrypted' || status === 'partial') {
      const encryptedCount = this.service.getEncryptedFileCount(filePath);
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
        this.service.getStatusDetail(filePath) ?? 'git-crypt protection warning',
        new vscode.ThemeColor('list.warningForeground'),
      );
      return decoration;
    }

    return null;
  }

  private isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('gitCryptDecorations')
      .get('enabled', true);
  }
}

function sameDecoration(
  left: vscode.FileDecoration | null,
  right: vscode.FileDecoration | null,
): boolean {
  return left?.badge === right?.badge
    && left?.tooltip === right?.tooltip
    && left?.color?.id === right?.color?.id
    && left?.propagate === right?.propagate;
}

function partialBadge(encryptedCount: number): string {
  return encryptedCount < 10 ? `🔒${encryptedCount}` : '🔒+';
}
