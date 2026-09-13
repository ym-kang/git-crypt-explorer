import * as vscode from 'vscode';
import { GitCryptCli } from '../gitCrypt/gitCryptCli';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { selectRepository } from './selectRepository';

export function registerLockRepositoryCommand(
  service: GitCryptService,
  cli: GitCryptCli,
  refresh: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'gitCryptDecorations.lockRepository',
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
        if (status.localState !== 'unlocked') {
          void vscode.window.showInformationMessage('This repository is already locked.');
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          'This re-encrypts protected working-tree files and removes all locally installed git-crypt keys. The command will refuse a dirty tracked working tree.',
          { modal: true },
          'Lock Repository',
        );
        if (confirmation !== 'Lock Repository') {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Locking git-crypt repository',
            cancellable: false,
          },
          () => cli.lockRepository(repository.root),
        );
        await refresh();
        void vscode.window.showInformationMessage('Repository locked.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown git-crypt error.';
        void vscode.window.showErrorMessage(`git-crypt lock failed: ${message}`);
      }
    },
  );
}
