import * as path from 'node:path';
import { lstatSync } from 'node:fs';
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
  let repositories = service.getWorkspaceStatus().repositories;
  if (repositories.length === 0) {
    const folder = initializationFolder(resource);
    if (!folder) {
      void vscode.window.showErrorMessage('Open a local project folder before initializing Git.');
      return undefined;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `No Git repository was detected in ${path.basename(folder)}. Initialize Git in this folder first?`,
      { modal: true },
      'Initialize Git',
    );
    if (confirmation !== 'Initialize Git') {
      return undefined;
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Initializing Git repository',
          cancellable: false,
        },
        () => service.initializeGitRepository(folder),
      );
      await service.initialize(workspaceFolderPaths(folder));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Git initialization error.';
      void vscode.window.showErrorMessage(`Git initialization failed: ${message}`);
      return undefined;
    }
    repositories = service.getWorkspaceStatus().repositories;
    if (repositories.length === 0) {
      void vscode.window.showErrorMessage('Git was initialized, but the repository could not be discovered yet.');
      return undefined;
    }
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

function initializationFolder(resource?: vscode.Uri): string | undefined {
  const workspaceFolder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
  const workspacePath = workspaceFolder?.uri.scheme === 'file'
    ? workspaceFolder.uri.fsPath
    : vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')?.uri.fsPath;
  if (workspacePath) {
    return workspacePath;
  }
  if (resource?.scheme !== 'file') {
    return undefined;
  }
  try {
    return lstatSync(resource.fsPath).isDirectory() ? resource.fsPath : path.dirname(resource.fsPath);
  } catch {
    return path.dirname(resource.fsPath);
  }
}

function workspaceFolderPaths(fallback?: string): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
  return folders.length > 0 ? folders : fallback ? [fallback] : [];
}
