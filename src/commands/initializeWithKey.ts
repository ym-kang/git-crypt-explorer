import * as vscode from 'vscode';
import { GitCryptCli } from '../gitCrypt/gitCryptCli';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { selectRepository } from './selectRepository';

export function registerInitializeWithKeyCommand(
  service: GitCryptService,
  cli: GitCryptCli,
  refresh: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'gitCryptDecorations.initializeWithKey',
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
          void vscode.window.showErrorMessage(
            'git-crypt is not installed or is not available on PATH.',
          );
          return;
        }
        if (status.localState === 'unlocked') {
          void vscode.window.showInformationMessage(
            'This repository is already initialized and unlocked locally.',
          );
          return;
        }

        const selection = await vscode.window.showOpenDialog({
          title: 'Select an existing git-crypt symmetric key',
          openLabel: 'Use This Key',
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
        });
        const keyFile = selection?.[0];
        if (!keyFile) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          'git-crypt unlock requires a clean tracked working tree and may decrypt protected files in place. Continue?',
          { modal: true },
          'Unlock Repository',
        );
        if (confirmation !== 'Unlock Repository') {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Unlocking repository with git-crypt',
            cancellable: false,
          },
          () => cli.unlockWithKey(repository.root, keyFile.fsPath),
        );
        await refresh();
        void vscode.window.showInformationMessage(
          'Repository initialized and unlocked with the selected git-crypt key.',
        );
      } catch (error) {
        void vscode.window.showErrorMessage(userFacingError(error));
      }
    },
  );
}

function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown git-crypt error.';
  return `git-crypt unlock failed: ${message}`;
}
