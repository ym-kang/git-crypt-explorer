import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitCryptCli } from '../gitCrypt/gitCryptCli';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { selectRepository } from './selectRepository';

export function registerExportKeyCommand(
  service: GitCryptService,
  cli: GitCryptCli,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'gitCryptDecorations.exportKey',
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
            'Unlock or initialize this repository before exporting its key.',
          );
          return;
        }

        const defaultName = `${path.basename(repository.root)}.git-crypt.key`;
        const destination = await vscode.window.showSaveDialog({
          title: 'Export git-crypt symmetric key',
          saveLabel: 'Export Key',
          defaultUri: vscode.Uri.file(path.join(path.dirname(repository.root), defaultName)),
          filters: { 'git-crypt key': ['key'], 'All files': ['*'] },
        });
        if (!destination) {
          return;
        }

        const insideRepository = isWithin(repository.root, destination.fsPath);
        const warning = insideRepository
          ? 'The selected destination is inside the repository and could be committed accidentally. This key grants access to every protected file.'
          : 'The exported symmetric key grants access to every protected file. Store and transfer it securely.';
        const confirmation = await vscode.window.showWarningMessage(
          warning,
          { modal: true },
          'Export Key',
        );
        if (confirmation !== 'Export Key') {
          return;
        }

        const permissionsRestricted = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Exporting git-crypt key',
            cancellable: false,
          },
          () => cli.exportKey(repository.root, destination.fsPath),
        );
        if (!permissionsRestricted) {
          void vscode.window.showWarningMessage(
            'Key exported, but restrictive file permissions could not be guaranteed. Secure the file manually.',
          );
          return;
        }
        void vscode.window.showInformationMessage('git-crypt key exported successfully.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown git-crypt error.';
        void vscode.window.showErrorMessage(`git-crypt key export failed: ${message}`);
      }
    },
  );
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
