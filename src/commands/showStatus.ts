import * as vscode from 'vscode';
import { GitCryptCli } from '../gitCrypt/gitCryptCli';
import { GitCryptRepositoryStatus, WorkspaceStatus } from '../gitCrypt/types';

export interface RepositoryOperationStatus {
  readonly root: string;
  readonly status?: GitCryptRepositoryStatus;
  readonly error?: string;
}

export function registerShowStatusCommand(
  getStatus: () => WorkspaceStatus,
  cli: GitCryptCli,
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('gitCryptDecorations.showStatus', async () => {
    const status = getStatus();
    const operations = await Promise.all(
      status.repositories.map(async (repository): Promise<RepositoryOperationStatus> => {
        try {
          return {
            root: repository.root,
            status: await cli.inspect(
              repository.root,
              repository.gitDir,
              repository.gitCryptDetected,
            ),
          };
        } catch (error) {
          return {
            root: repository.root,
            error: error instanceof Error ? error.message : 'Unknown git-crypt status error.',
          };
        }
      }),
    );
    const report = formatWorkspaceStatus(status, operations);
    output.clear();
    output.appendLine(report);
    output.show(true);

    const protectedFiles = status.repositories.reduce(
      (total, repository) => total + repository.protectedFiles,
      0,
    );
    const warnings = status.repositories.reduce(
      (total, repository) => total + repository.warnings,
      0,
    );
    const encryptedIndexFiles = status.repositories.reduce(
      (total, repository) => total + repository.encryptedIndexFiles,
      0,
    );
    void vscode.window.showInformationMessage(
      `Git repositories: ${status.repositories.length} · Protected targets: ${protectedFiles} · Encrypted index blobs: ${encryptedIndexFiles} · Warnings: ${warnings}`,
    );
  });
}

export function formatWorkspaceStatus(
  status: WorkspaceStatus,
  operations: readonly RepositoryOperationStatus[] = [],
): string {
  const protectedFiles = status.repositories.reduce(
    (total, repository) => total + repository.protectedFiles,
    0,
  );
  const warnings = status.repositories.reduce(
    (total, repository) => total + repository.warnings,
    0,
  );
  const encryptedIndexFiles = status.repositories.reduce(
    (total, repository) => total + repository.encryptedIndexFiles,
    0,
  );
  const lines = [
    `Git repository: ${status.repositories.length > 0 ? 'yes' : 'no'}`,
    `git-crypt detected: ${status.repositories.some((repository) => repository.gitCryptDetected) ? 'yes' : 'no'}`,
    `Protected files: ${protectedFiles}`,
    `Encrypted index blobs: ${encryptedIndexFiles}`,
    `Warnings: ${warnings}`,
  ];

  if (status.gitUnavailable) {
    lines.push('Git available: no');
  }
  if (status.repositories.length > 1) {
    lines.push('', `Repositories: ${status.repositories.length}`);
  }
  for (const repository of status.repositories) {
    const operation = operations.find((candidate) => candidate.root === repository.root);
    if (status.repositories.length > 1 || repository.error || operation) {
      lines.push(
        '',
        repository.root,
        `  git-crypt detected: ${repository.gitCryptDetected ? 'yes' : 'no'}`,
        `  Protected files: ${repository.protectedFiles}`,
        `  Encrypted index blobs: ${repository.encryptedIndexFiles}`,
        `  Warnings: ${repository.warnings}`,
      );
    }
    if (operation?.status) {
      lines.push(
        `  git-crypt CLI: ${operation.status.available ? operation.status.version ?? 'available' : 'unavailable'}`,
        `  Local state: ${formatLocalState(operation.status.localState)}`,
        `  Installed local keys: ${operation.status.installedKeyCount}`,
      );
    }
    if (operation?.error) {
      lines.push(`  git-crypt status error: ${operation.error}`);
    }
    if (repository.error) {
      lines.push(`  Error: ${repository.error}`);
    }
  }
  if (status.discoveryErrors.length > 0) {
    lines.push('', ...status.discoveryErrors.map((error) => `Discovery error: ${error}`));
  }

  return lines.join('\n');
}

function formatLocalState(state: GitCryptRepositoryStatus['localState']): string {
  switch (state) {
    case 'unlocked':
      return 'initialized and unlocked';
    case 'locked':
      return 'locked (not initialized locally)';
    case 'not-initialized':
      return 'not initialized';
  }
}
