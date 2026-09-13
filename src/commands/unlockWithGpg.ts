import * as vscode from 'vscode';
import { GitCryptCli } from '../gitCrypt/gitCryptCli';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { selectRepository } from './selectRepository';

export function registerUnlockWithGpgCommand(
   service: GitCryptService,
  cli: GitCryptCli,
  refresh: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'gitCryptDecorations.unlockWithGpg',
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
          void vscode.window.showInformationMessage('This repository is already unlocked.');
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          'git-crypt will use an authorized GPG secret key and decrypt protected working-tree files. A clean tracked working tree is required.',
          { modal: true },
          'Unlock with GPG',
        );
        if (confirmation !== 'Unlock with GPG') {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Unlocking repository with GPG',
            cancellable: false,
          },
          () => cli.unlockWithGpg(repository.root),
        );
        await refresh();
        void vscode.window.showInformationMessage('Repository unlocked with GPG.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown git-crypt error.';
        void vscode.window.showErrorMessage(`git-crypt GPG unlock failed: ${message}`);
      }
    },
  );
}
