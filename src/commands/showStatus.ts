import * as vscode from 'vscode';
import { WorkspaceStatus } from '../gitCrypt/types';

export function registerShowStatusCommand(
  getStatus: () => WorkspaceStatus,
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('gitCryptDecorations.showStatus', () => {
    const status = getStatus();
    const report = formatWorkspaceStatus(status);
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
    void vscode.window.showInformationMessage(
      `Git repositories: ${status.repositories.length} · Protected files: ${protectedFiles} · Warnings: ${warnings}`,
    );
  });
}

export function formatWorkspaceStatus(status: WorkspaceStatus): string {
  const protectedFiles = status.repositories.reduce(
    (total, repository) => total + repository.protectedFiles,
    0,
  );
  const warnings = status.repositories.reduce(
    (total, repository) => total + repository.warnings,
    0,
  );
  const lines = [
    `Git repository: ${status.repositories.length > 0 ? 'yes' : 'no'}`,
    `git-crypt detected: ${status.repositories.some((repository) => repository.gitCryptDetected) ? 'yes' : 'no'}`,
    `Protected files: ${protectedFiles}`,
    `Warnings: ${warnings}`,
  ];

  if (status.gitUnavailable) {
    lines.push('Git available: no');
  }
  if (status.repositories.length > 1) {
    lines.push('', `Repositories: ${status.repositories.length}`);
  }
  for (const repository of status.repositories) {
    if (status.repositories.length > 1 || repository.error) {
      lines.push(
        '',
        repository.root,
        `  git-crypt detected: ${repository.gitCryptDetected ? 'yes' : 'no'}`,
        `  Protected files: ${repository.protectedFiles}`,
        `  Warnings: ${repository.warnings}`,
      );
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
