import * as vscode from 'vscode';
import { GitCryptCli } from '../gitCrypt/gitCryptCli';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { selectRepository } from './selectRepository';

export function registerAddGpgUserCommand(
  service: GitCryptService,
  cli: GitCryptCli,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'gitCryptDecorations.addGpgUser',
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
          void vscode.window.showErrorMessage(
            'Unlock or initialize this repository before adding a GPG user.',
          );
          return;
        }

        const userId = await vscode.window.showInputBox({
          title: 'Add a git-crypt GPG collaborator',
          prompt: 'GPG fingerprint, key ID, or email address',
          placeHolder: 'user@example.com',
          ignoreFocusOut: true,
          validateInput: (value) => {
            const normalized = value.trim();
            if (normalized.length === 0) {
              return 'Enter a GPG user ID.';
            }
            if (normalized.startsWith('-') || /[\0\r\n]/u.test(normalized)) {
              return 'The GPG user ID contains unsupported characters.';
            }
            return undefined;
          },
        });
        if (!userId) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          'This grants the selected GPG identity access to the repository key. Generated .git-crypt files will be left uncommitted for your review.',
          { modal: true },
          'Add GPG User',
        );
        if (confirmation !== 'Add GPG User') {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Adding git-crypt GPG user',
            cancellable: false,
          },
          () => cli.addGpgUser(repository.root, userId),
        );
        void vscode.window.showInformationMessage(
          'GPG user added. Review and commit the generated .git-crypt files manually.',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown git-crypt error.';
        void vscode.window.showErrorMessage(`Adding git-crypt GPG user failed: ${message}`);
      }
    },
  );
}
