import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { RepositorySnapshot } from '../gitCrypt/types';

interface RepositoryQuickPickItem extends vscode.QuickPickItem {
  readonly repository: RepositorySnapshot;
}

export async function selectRepository(
  service: GitCryptService,
  resource?: vscode.Uri,
): Promise<RepositorySnapshot | undefined> {
  const repositories = service.getWorkspaceStatus().repositories;
  if (repositories.length === 0) {
    void vscode.window.showErrorMessage('No Git repository was detected in this workspace.');
    return undefined;
  }

  const contextualUri = resource?.scheme === 'file' ? resource : vscode.window.activeTextEditor?.document.uri;
  if (contextualUri?.scheme === 'file') {
    const contextualRepository = service.getRepositorySnapshotForPath(contextualUri.fsPath);
    if (contextualRepository) {
      return contextualRepository;
    }
  }

  if (repositories.length === 1) {
    return repositories[0];
  }

  const selected = await vscode.window.showQuickPick<RepositoryQuickPickItem>(
    repositories.map((repository) => ({
      label: path.basename(repository.root),
      description: repository.root,
      repository,
    })),
    {
      title: 'Select a Git repository',
      placeHolder: 'Repository for the git-crypt operation',
    },
  );
  return selected?.repository;
}
