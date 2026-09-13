import * as vscode from 'vscode';
import { GitCryptCli } from '../gitCrypt/gitCryptCli';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { selectRepository } from './selectRepository';

export function registerInitializeRepositoryCommand(
  service: GitCryptService,
  cli: GitCryptCli,
  refresh: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'gitCryptDecorations.initializeRepository',
    async (resource?: vscode.Uri) => {
      const repository = await selectRepository(service, resource);
      if (!repository) {
        return;
      }

      try {
        const status = await cli.inspect(
          repository.root,
          repository.gitDir,
          repository.gitCryptDetected,
        );
        if (!status.available) {
          showMissingCli();
          return;
        }
        if (status.localState === 'unlocked') {
          void vscode.window.showInformationMessage(
            'This repository is already initialized and unlocked locally.',
          );
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          'This generates a brand-new git-crypt key. Use it only for a new repository; it will not unlock files encrypted with an existing key.',
          { modal: true },
          'Generate New Key',
        );
        if (confirmation !== 'Generate New Key') {
          return;
        }

        await runWithProgress('Initializing repository with git-crypt', () =>
          cli.initializeRepository(repository.root),
        );
        await refresh();
        void vscode.window.showInformationMessage(
          'Repository initialized. Export the new key or add a GPG user before sharing it.',
        );
      } catch (error) {
        showCommandError('initialization', error);
      }
    },
  );
}

function showMissingCli(): void {
  void vscode.window.showErrorMessage('git-crypt is not installed or is not available on PATH.');
}

function runWithProgress(title: string, task: () => Promise<void>): Thenable<void> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    task,
  );
}

function showCommandError(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown git-crypt error.';
  void vscode.window.showErrorMessage(`git-crypt ${operation} failed: ${message}`);
}
