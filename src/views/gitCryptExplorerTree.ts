import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitCryptService } from '../gitCrypt/gitCryptService';
import { GitCryptStatus, RepositorySnapshot } from '../gitCrypt/types';

export type TreeNode = RepositoryNode | FileGroupNode | DirectoryNode | FileNode | MessageNode;

export type ExplorerViewMode = 'grouped' | 'tree';

interface RepositoryNode {
  readonly kind: 'repository';
  readonly snapshot: RepositorySnapshot;
  readonly expanded: boolean;
}

interface FileGroupNode {
  readonly kind: 'file-group';
  readonly snapshot: RepositorySnapshot;
  readonly status: 'warning';
}

interface DirectoryNode {
  readonly kind: 'directory';
  readonly snapshot: RepositorySnapshot;
  readonly directoryPath: string;
  readonly expanded: boolean;
}

interface FileNode {
  readonly kind: 'file';
  readonly snapshot: RepositorySnapshot;
  readonly filePath: string;
  readonly status: Exclude<GitCryptStatus, 'none'>;
  readonly displayName?: string;
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
  private childrenCache = new WeakMap<TreeNode, TreeNode[]>();
  private parentCache = new WeakMap<TreeNode, TreeNode>();
  private rootNodes: TreeNode[] | undefined;
  private disposed = false;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  private viewMode: ExplorerViewMode;
  // Keep the first render lightweight. The extension expands the tree after the
  // initial repository scan has completed.
  private treeExpanded = false;

  public constructor(
    private readonly service: GitCryptService,
    initialViewMode: ExplorerViewMode = 'grouped',
  ) {
    this.viewMode = initialViewMode;
  }

  public get currentViewMode(): ExplorerViewMode {
    return this.viewMode;
  }

  public toggleViewMode(expandTree = true): ExplorerViewMode {
    this.viewMode = this.viewMode === 'grouped' ? 'tree' : 'grouped';
    if (this.viewMode === 'tree' && expandTree) {
      this.treeExpanded = true;
    }
    this.refresh();
    return this.viewMode;
  }

  public setTreeExpanded(expanded: boolean): void {
    this.treeExpanded = expanded;
    this.refresh();
  }

  public refresh(): void {
    if (this.disposed) {
      return;
    }
    this.rootNodes = undefined;
    this.childrenCache = new WeakMap<TreeNode, TreeNode[]>();
    this.parentCache = new WeakMap<TreeNode, TreeNode>();
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.disposed = true;
    this.changeEmitter.dispose();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'repository':
        return repositoryTreeItem(element);
      case 'file-group':
        return fileGroupTreeItem(element);
      case 'directory':
        return directoryTreeItem(element);
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

    const cached = this.childrenCache.get(element);
    if (cached) {
      return cached;
    }

    let children: TreeNode[];
    switch (element.kind) {
      case 'repository':
        children = this.viewMode === 'tree'
          ? treeRepositoryChildren(element.snapshot, this.treeExpanded)
          : repositoryChildren(element.snapshot);
        break;
      case 'file-group':
        children = fileGroupChildren(element);
        break;
      case 'directory':
        children = treeDirectoryChildren(element.snapshot, element.directoryPath, this.treeExpanded);
        break;
      case 'file':
      case 'message':
        children = [];
        break;
    }

    this.childrenCache.set(element, children);
    for (const child of children) {
      this.parentCache.set(child, element);
    }
    return children;
  }

  public getParent(element: TreeNode): TreeNode | undefined {
    return this.parentCache.get(element);
  }

  private getRootNodes(): TreeNode[] {
    if (this.rootNodes) {
      return this.rootNodes;
    }

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
      this.rootNodes = messages;
      return messages;
    }

    this.rootNodes = [
      ...messages,
      ...status.repositories.map(
        (snapshot): RepositoryNode => ({
          kind: 'repository',
          snapshot,
          expanded: this.viewMode === 'tree'
            ? this.treeExpanded
            : status.repositories.length === 1,
        }),
      ),
    ];
    return this.rootNodes;
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
    : `${snapshot.protectedFiles} encrypted · ${snapshot.warnings} warnings`;
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
    children.push(...statusFileChildren(snapshot, 'encrypted'));
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

function treeRepositoryChildren(snapshot: RepositorySnapshot, expanded: boolean): TreeNode[] {
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

  return [...children, ...treeDirectoryChildren(snapshot, snapshot.root, expanded)];
}

function treeDirectoryChildren(
  snapshot: RepositorySnapshot,
  directoryPath: string,
  expanded: boolean,
): TreeNode[] {
  const directories = new Map<string, DirectoryNode>();
  const files: FileNode[] = [];

  for (const [filePath, status] of [...snapshot.statuses.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (status === 'none') {
      continue;
    }
    const relativePath = path.relative(directoryPath, filePath);
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      continue;
    }

    const segments = relativePath.split(path.sep);
    const firstSegment = segments[0];
    if (!firstSegment) {
      continue;
    }
    if (segments.length === 1) {
      files.push({
        kind: 'file',
        snapshot,
        filePath,
        status,
        displayName: path.basename(filePath),
      });
      continue;
    }

    const childPath = path.join(directoryPath, firstSegment);
    directories.set(childPath, {
      kind: 'directory',
      snapshot,
      directoryPath: childPath,
      expanded,
    });
  }

  return [
    ...[...directories.values()].sort((left, right) =>
      path.basename(left.directoryPath).localeCompare(path.basename(right.directoryPath)),
    ),
    ...files.sort((left, right) => left.filePath.localeCompare(right.filePath)),
  ];
}

function directoryTreeItem(node: DirectoryNode): vscode.TreeItem {
  const prefix = `${node.directoryPath}${path.sep}`;
  const encryptedCount = [...node.snapshot.statuses.entries()].filter(
    ([filePath, status]) => filePath.startsWith(prefix) && status === 'encrypted',
  ).length;
  const warningCount = [...node.snapshot.statuses.entries()].filter(
    ([filePath, status]) => filePath.startsWith(prefix) && status === 'warning',
  ).length;
  const item = new vscode.TreeItem(
    path.basename(node.directoryPath),
    node.expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.description = warningCount > 0
    ? `${warningCount} warning${warningCount === 1 ? '' : 's'}`
    : `${encryptedCount} encrypted`;
  item.tooltip = `${node.directoryPath}\nEncrypted: ${encryptedCount}\nWarnings: ${warningCount}`;
  item.iconPath = new vscode.ThemeIcon(warningCount > 0 ? 'warning' : 'folder');
  item.id = `directory:${node.directoryPath}`;
  item.contextValue = warningCount > 0 ? 'gitCryptWarningDirectory' : 'gitCryptDirectory';
  return item;
}

function fileGroupTreeItem(node: FileGroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    'Warnings',
    vscode.TreeItemCollapsibleState.Expanded,
  );
  item.description = String(node.snapshot.warnings);
  item.iconPath = new vscode.ThemeIcon('warning');
  item.id = `group:${node.snapshot.root}:warning`;
  item.contextValue = 'gitCryptWarningGroup';
  return item;
}

function fileGroupChildren(group: FileGroupNode): FileNode[] {
  return statusFileChildren(group.snapshot, group.status);
}

function statusFileChildren(
  snapshot: RepositorySnapshot,
  status: Exclude<GitCryptStatus, 'none'>,
): FileNode[] {
  return [...snapshot.statuses.entries()]
    .filter(([, fileStatus]) => fileStatus === status)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath]) => ({
      kind: 'file',
      snapshot,
      filePath,
      status,
    }));
}

function fileTreeItem(node: FileNode): vscode.TreeItem {
  const relativePath = path.relative(node.snapshot.root, node.filePath) || node.filePath;
  const displayPath = node.displayName ?? relativePath;
  const detail =
    node.status === 'warning'
      ? node.snapshot.statusDetails.get(node.filePath) ?? 'git-crypt protection warning'
      : 'Protected by git-crypt (encrypted in Git index)';
  const item = new vscode.TreeItem(displayPath, vscode.TreeItemCollapsibleState.None);
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
