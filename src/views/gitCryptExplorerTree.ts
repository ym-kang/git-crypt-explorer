import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { GitCryptStatus, RepositorySnapshot } from '../gitCrypt/types';

type TreeNode = RepositoryNode | FileGroupNode | FileNode | MessageNode;

interface RepositoryNode {
  readonly kind: 'repository';
  readonly snapshot: RepositorySnapshot;
  readonly expanded: boolean;
}

interface FileGroupNode {
  readonly kind: 'file-group';
  readonly snapshot: RepositorySnapshot;
  readonly status: Exclude<GitCryptStatus, 'none'>;
}

interface FileNode {
  readonly kind: 'file';
  readonly snapshot: RepositorySnapshot;
  readonly filePath: string;
  readonly status: Exclude<GitCryptStatus, 'none'>;
}

interface MessageNode {
  readonly kind: 'message';
  readonly label: string;
  readonly description?: string;
  readonly icon: string;
}

export class GitCryptExplorerTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly service: GitCryptService) {}

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'repository':
        return repositoryTreeItem(element);
      case 'file-group':
        return fileGroupTreeItem(element);
      case 'file':
        return fileTreeItem(element);
      case 'message':
        return messageTreeItem(element);
    }
  }

  public getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.getRootNodes();
    }

    switch (element.kind) {
      case 'repository':
        return repositoryChildren(element.snapshot);
      case 'file-group':
        return fileGroupChildren(element);
      case 'file':
      case 'message':
        return [];
    }
  }

  private getRootNodes(): TreeNode[] {
    const status = this.service.getWorkspaceStatus();
    const messages: MessageNode[] = status.discoveryErrors.map((error) => ({
      kind: 'message',
      label: 'Repository discovery failed',
      description: error,
      icon: 'error',
    }));

    if (status.repositories.length === 0) {
      if (status.workspaceFolders === 0) {
        messages.push({
          kind: 'message',
          label: 'Open a local folder to inspect git-crypt status.',
          icon: 'folder-opened',
        });
      } else if (status.gitUnavailable) {
        messages.push({
          kind: 'message',
          label: 'Git is not available on PATH.',
          icon: 'error',
        });
      } else {
        messages.push({
          kind: 'message',
          label: 'No Git repositories found in this workspace.',
          icon: 'info',
        });
      }
      return messages;
    }

    return [
      ...messages,
      ...status.repositories.map(
        (snapshot): RepositoryNode => ({
          kind: 'repository',
          snapshot,
          expanded: status.repositories.length === 1,
        }),
      ),
    ];
  }
}

export function updateGitCryptExplorerView(
  view: vscode.TreeView<TreeNode>,
  service: GitCryptService,
): void {
  const status = service.getWorkspaceStatus();
  const protectedFiles = status.repositories.reduce(
    (total, repository) => total + repository.protectedFiles,
    0,
  );
  const warnings = status.repositories.reduce(
    (total, repository) => total + repository.warnings,
    0,
  );

  view.description =
    status.repositories.length > 0
      ? `${protectedFiles} protected · ${warnings} warnings`
      : undefined;
  view.badge =
    warnings > 0
      ? {
          value: warnings,
          tooltip: `${warnings} git-crypt warning${warnings === 1 ? '' : 's'}`,
        }
      : undefined;
}

function repositoryTreeItem(node: RepositoryNode): vscode.TreeItem {
  const { snapshot } = node;
  const item = new vscode.TreeItem(
    path.basename(snapshot.root) || snapshot.root,
    node.expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.description = snapshot.error
    ? 'Scan failed'
    : `${snapshot.protectedFiles} protected · ${snapshot.warnings} warnings`;
  item.tooltip = [
    snapshot.root,
    `Protected files: ${snapshot.protectedFiles}`,
    `Encrypted index blobs: ${snapshot.encryptedIndexFiles}`,
    `Warnings: ${snapshot.warnings}`,
    ...(snapshot.error ? [`Error: ${snapshot.error}`] : []),
  ].join('\n');
  item.iconPath = new vscode.ThemeIcon(snapshot.error ? 'error' : 'repo');
  item.id = `repository:${snapshot.root}`;
  item.contextValue = 'gitCryptRepository';
  return item;
}

function repositoryChildren(snapshot: RepositorySnapshot): TreeNode[] {
  const children: TreeNode[] = [];

  if (snapshot.error) {
    children.push({
      kind: 'message',
      label: 'Scan failed',
      description: snapshot.error,
      icon: 'error',
    });
  }

  if (!snapshot.gitCryptDetected) {
    children.push({
      kind: 'message',
      label: 'No git-crypt targets detected.',
      icon: 'unlock',
    });
    return children;
  }

  if (snapshot.encryptedIndexFiles > 0) {
    children.push({
      kind: 'file-group',
      snapshot,
      status: 'encrypted',
    });
  }
  if (snapshot.warnings > 0) {
    children.push({
      kind: 'file-group',
      snapshot,
      status: 'warning',
    });
  }
  return children;
}

function fileGroupTreeItem(node: FileGroupNode): vscode.TreeItem {
  const warning = node.status === 'warning';
  const count = warning ? node.snapshot.warnings : node.snapshot.encryptedIndexFiles;
  const item = new vscode.TreeItem(
    warning ? 'Warnings' : 'Encrypted in Git index',
    warning
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.description = String(count);
  item.iconPath = new vscode.ThemeIcon(warning ? 'warning' : 'lock');
  item.id = `group:${node.snapshot.root}:${node.status}`;
  item.contextValue = warning ? 'gitCryptWarningGroup' : 'gitCryptEncryptedGroup';
  return item;
}

function fileGroupChildren(group: FileGroupNode): FileNode[] {
  return [...group.snapshot.statuses.entries()]
    .filter(([, status]) => status === group.status)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath]) => ({
      kind: 'file',
      snapshot: group.snapshot,
      filePath,
      status: group.status,
    }));
}

function fileTreeItem(node: FileNode): vscode.TreeItem {
  const relativePath = path.relative(node.snapshot.root, node.filePath) || node.filePath;
  const detail =
    node.status === 'warning'
      ? node.snapshot.statusDetails.get(node.filePath) ?? 'git-crypt protection warning'
      : 'Protected by git-crypt (encrypted in Git index)';
  const item = new vscode.TreeItem(relativePath, vscode.TreeItemCollapsibleState.None);
  item.description = node.status === 'warning' ? detail : undefined;
  item.tooltip = `${relativePath}\n${detail}`;
  item.iconPath = new vscode.ThemeIcon(node.status === 'warning' ? 'warning' : 'lock');
  item.resourceUri = vscode.Uri.file(node.filePath);
  item.id = `file:${node.filePath}`;
  item.contextValue = node.status === 'warning' ? 'gitCryptWarningFile' : 'gitCryptEncryptedFile';
  item.command = {
    command: 'vscode.open',
    title: 'Open File',
    arguments: [item.resourceUri],
  };
  return item;
}

function messageTreeItem(node: MessageNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.description = node.description;
  item.tooltip = node.description ? `${node.label}\n${node.description}` : node.label;
  item.iconPath = new vscode.ThemeIcon(node.icon);
  return item;
}
