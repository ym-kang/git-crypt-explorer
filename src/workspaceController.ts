import * as vscode from 'vscode';
import { GitCryptDecorationProvider } from './decorations/gitCryptDecorationProvider';
import { GitCryptService } from './gitCrypt/gitCryptService';

const REFRESH_DEBOUNCE_MS = 300;

export class WorkspaceController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly refreshEmitter = new vscode.EventEmitter<void>();
  private gitWatchers: vscode.FileSystemWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private operation: Promise<void> = Promise.resolve();
  private reinitializeOnNextRefresh = false;
  private disposed = false;

  public readonly onDidRefresh = this.refreshEmitter.event;

  public constructor(
    private readonly service: GitCryptService,
    private readonly decorations: GitCryptDecorationProvider,
    private readonly output: vscode.LogOutputChannel,
  ) {
    const attributes = vscode.workspace.createFileSystemWatcher('**/.gitattributes');
    this.disposables.push(
      this.refreshEmitter,
      attributes,
      attributes.onDidCreate(() => this.scheduleRefresh()),
      attributes.onDidChange(() => this.scheduleRefresh()),
      attributes.onDidDelete(() => this.scheduleRefresh()),
    );

    const files = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    this.disposables.push(
      files,
      files.onDidCreate(() => this.scheduleRefresh()),
      files.onDidDelete(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh(true)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gitCryptDecorations.enabled')) {
          this.decorations.refresh();
        }
      }),
    );
  }

  public async initialize(): Promise<void> {
    this.output.info('WorkspaceController.initialize() started.');
    await this.enqueue(true);
    this.output.info('WorkspaceController.initialize() completed.');
  }

  public async refreshNow(): Promise<void> {
    this.output.info('WorkspaceController.refreshNow() started.');
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    await this.enqueue(true);
    this.output.info('WorkspaceController.refreshNow() completed.');
  }

  public dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    for (const disposable of [...this.gitWatchers, ...this.disposables]) {
      disposable.dispose();
    }
  }

  private scheduleRefresh(reinitialize = false): void {
    this.reinitializeOnNextRefresh ||= reinitialize;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const shouldReinitialize = this.reinitializeOnNextRefresh;
      this.reinitializeOnNextRefresh = false;
      void this.enqueue(shouldReinitialize);
    }, REFRESH_DEBOUNCE_MS);
  }

  private enqueue(reinitialize: boolean): Promise<void> {
    const next = this.operation
      .catch(() => undefined)
      .then(async () => {
        try {
          this.output.info(`Refresh operation started (reinitialize=${reinitialize}).`);
          if (reinitialize) {
            await this.service.initialize(workspaceFolderPaths());
            this.rebuildGitWatchers();
          } else {
            await this.service.refreshAll();
          }
        } catch (error) {
          this.output.error(`[refresh] ${formatError(error)}`);
        } finally {
          if (this.disposed) {
            this.output.info('Refresh operation ended after disposal.');
            return;
          }
          this.decorations.refresh();
          this.refreshEmitter.fire();
          this.output.info('Refresh operation completed.');
        }
      });
    this.operation = next;
    return next;
  }

  private rebuildGitWatchers(): void {
    for (const watcher of this.gitWatchers) {
      watcher.dispose();
    }
    this.gitWatchers = [];

    for (const repository of this.service.getRepositoryLocations()) {
      for (const pattern of ['HEAD', 'index', 'packed-refs', 'refs/**']) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(repository.gitDir), pattern),
        );
        watcher.onDidCreate(() => this.scheduleRefresh());
        watcher.onDidChange(() => this.scheduleRefresh());
        watcher.onDidDelete(() => this.scheduleRefresh());
        this.gitWatchers.push(watcher);
      }
    }
  }
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}
