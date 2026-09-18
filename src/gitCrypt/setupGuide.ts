import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitCryptCli } from './gitCryptCli';
import { GitCryptService } from './gitCryptService';
import { recommendGitCryptSetup } from './setupRecommendation';
import { RepositorySnapshot } from './types';

export class GitCryptSetupGuide {
  private promptedGitInitialization = false;
  private readonly promptedRepositories = new Set<string>();
  private running = false;

  public constructor(
    private readonly service: GitCryptService,
    private readonly cli: GitCryptCli,
    private readonly refresh: () => Promise<void>,
  ) {}

  public async offer(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const workspace = this.service.getWorkspaceStatus();
      if (workspace.repositories.length === 0) {
        await this.offerGitInitialization(workspace.nonGitFolders > 0 && !workspace.gitUnavailable);
        return;
      }
      await this.offerRepositories(workspace.repositories);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Git Crypt setup error.';
      void vscode.window.showErrorMessage(`Git Crypt setup failed: ${message}`);
    } finally {
      this.running = false;
    }
  }

  private async offerGitInitialization(shouldOffer: boolean): Promise<void> {
    if (this.promptedGitInitialization || !shouldOffer) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === 'file');
    if (!folder) {
      return;
    }
    this.promptedGitInitialization = true;
    const confirmation = await vscode.window.showWarningMessage(
      `No Git repository was detected in ${path.basename(folder.uri.fsPath)}. Initialize Git in this folder first?`,
      { modal: true },
      'Initialize Git',
    );
    if (confirmation !== 'Initialize Git') {
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Initializing Git repository',
        cancellable: false,
      },
      () => this.service.initializeGitRepository(folder.uri.fsPath),
    );
    await this.service.initialize([folder.uri.fsPath]);
    await this.refresh();
  }

  private async offerRepositories(repositories: readonly RepositorySnapshot[]): Promise<void> {
    for (const repository of repositories) {
      if (this.promptedRepositories.has(repository.root)) {
        continue;
      }
      this.promptedRepositories.add(repository.root);
      let status;
      try {
        status = await this.cli.inspect(repository.root, repository.gitDir, repository.protectedFiles > 0);
      } catch {
        continue;
      }
      if (!status.available) {
        continue;
      }
      switch (recommendGitCryptSetup(true, repository.protectedFiles, status.localState)) {
        case 'unlock':
          await this.offerUnlock(repository);
          break;
        case 'initialize-git-crypt':
          await this.offerGitCryptInitialization(repository);
          break;
        case 'initialize-git':
        case 'none':
          break;
      }
    }
  }

  private async offerGitCryptInitialization(repository: RepositorySnapshot): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      `No git-crypt targets or local key were found in ${path.basename(repository.root)}. Initialize it with a new key?`,
      { modal: true },
      'Initialize',
    );
    if (confirmation !== 'Initialize') {
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Initializing repository with git-crypt',
        cancellable: false,
      },
      () => this.cli.initializeRepository(repository.root),
    );
    await this.refresh();
    void vscode.window.showInformationMessage(
      'Repository initialized with a new git-crypt key. Export the key or add a GPG user before sharing it.',
    );
  }

  private async offerUnlock(repository: RepositorySnapshot): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      ['Unlock with GPG', 'Use an existing key', 'Later'],
      { title: 'Protected git-crypt files were found, but this repository is locked. Unlock now?' },
    );
    if (choice === 'Unlock with GPG') {
      const confirmation = await vscode.window.showWarningMessage(
        'git-crypt will use an authorized GPG key and decrypt protected files in the working tree.',
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
        () => this.cli.unlockWithGpg(repository.root),
      );
      await this.refresh();
      void vscode.window.showInformationMessage('Repository unlocked with GPG.');
    } else if (choice === 'Use an existing key') {
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
        'git-crypt will use the selected key and decrypt protected files in the working tree.',
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
        () => this.cli.unlockWithKey(repository.root, keyFile.fsPath),
      );
      await this.refresh();
      void vscode.window.showInformationMessage('Repository unlocked with the selected git-crypt key.');
    }
  }
}
