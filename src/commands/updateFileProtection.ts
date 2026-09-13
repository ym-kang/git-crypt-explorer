import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  GitCryptAttributeMode,
  GitCryptAttributeTarget,
  updateGitAttributes,
} from '../gitCrypt/gitAttributes';
import { GitCryptService, RepositoryResource } from '../gitCrypt/gitCryptService';

export function registerFileProtectionCommands(
  service: GitCryptService,
  refresh: () => Promise<void>,
): vscode.Disposable {
  const protect = vscode.commands.registerCommand(
    'gitCryptDecorations.protectFile',
    (resource?: vscode.Uri, selectedResources?: readonly vscode.Uri[]) =>
      updateProtection('protect', service, refresh, resource, selectedResources),
  );
  const unprotect = vscode.commands.registerCommand(
    'gitCryptDecorations.unprotectFile',
    (resource?: vscode.Uri, selectedResources?: readonly vscode.Uri[]) =>
      updateProtection('unprotect', service, refresh, resource, selectedResources),
  );
  return vscode.Disposable.from(protect, unprotect);
}

async function updateProtection(
  mode: GitCryptAttributeMode,
  service: GitCryptService,
  refresh: () => Promise<void>,
  resource?: vscode.Uri,
  selectedResources?: readonly vscode.Uri[],
): Promise<void> {
  const resources = commandResources(resource, selectedResources);
  if (resources.length === 0) {
    void vscode.window.showErrorMessage('Select a local file in a Git repository first.');
    return;
  }

  const changedResources: string[] = [];
  const skippedResources: string[] = [];
  try {
    for (const uri of resources) {
      const repositoryResource = service.getRepositoryResource(uri.fsPath);
      if (!repositoryResource) {
        throw new Error(`${uri.fsPath} is not in a discovered Git repository.`);
      }
      const target = await validateResource(uri, repositoryResource);

      const shouldProtect = mode === 'protect';
      if (target === 'file') {
        const protectedByGitCrypt = await service.isProtectedFile(uri.fsPath);
        if (protectedByGitCrypt === shouldProtect) {
          skippedResources.push(path.basename(uri.fsPath));
          continue;
        }
      }

      const changed = await editNearestAttributesFile(repositoryResource, mode, target);
      if (changed) {
        changedResources.push(path.basename(uri.fsPath));
      } else {
        skippedResources.push(path.basename(uri.fsPath));
      }
    }

    if (changedResources.length > 0) {
      await refresh();
    }

    const action = mode === 'protect' ? 'Added' : 'Removed';
    const detail =
      changedResources.length === 1
        ? changedResources[0]
        : `${changedResources.length} items`;
    if (changedResources.length > 0) {
      void vscode.window.showInformationMessage(
        `${action} ${detail} ${mode === 'protect' ? 'to' : 'from'} git-crypt targets. Stage affected files and .gitattributes to update the Git index.`,
      );
    } else if (skippedResources.length > 0) {
      void vscode.window.showInformationMessage(
        mode === 'protect'
          ? 'The selected item is already a git-crypt target.'
          : 'The selected item is not a git-crypt target.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown .gitattributes error.';
    void vscode.window.showErrorMessage(`Could not update git-crypt target: ${message}`);
  }
}

function commandResources(
  resource?: vscode.Uri,
  selectedResources?: readonly vscode.Uri[],
): readonly vscode.Uri[] {
  const candidates =
    selectedResources && selectedResources.length > 0
      ? selectedResources
      : resource
        ? [resource]
        : vscode.window.activeTextEditor
          ? [vscode.window.activeTextEditor.document.uri]
          : [];
  const unique = new Map<string, vscode.Uri>();
  for (const candidate of candidates) {
    if (candidate.scheme === 'file') {
      unique.set(candidate.fsPath, candidate);
    }
  }
  return [...unique.values()];
}

async function validateResource(
  uri: vscode.Uri,
  repositoryResource: RepositoryResource,
): Promise<GitCryptAttributeTarget> {
  const stat = await vscode.workspace.fs.stat(uri);
  const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
  if (
    isDirectory &&
    path.resolve(repositoryResource.absolutePath) === path.resolve(repositoryResource.root)
  ) {
    throw new Error('The repository root cannot be added as a recursive git-crypt target.');
  }
  if (!isDirectory && path.basename(repositoryResource.absolutePath) === '.gitattributes') {
    throw new Error('.gitattributes cannot itself be a git-crypt target.');
  }
  return isDirectory ? 'directory' : 'file';
}

async function editNearestAttributesFile(
  repositoryResource: RepositoryResource,
  mode: GitCryptAttributeMode,
  target: GitCryptAttributeTarget,
): Promise<boolean> {
  const attributesPath = await nearestAttributesFile(
    repositoryResource.absolutePath,
    repositoryResource.root,
  );
  const attributesUri = vscode.Uri.file(attributesPath);
  if (!(await exists(attributesUri))) {
    await vscode.workspace.fs.writeFile(attributesUri, new Uint8Array());
  }

  const document = await vscode.workspace.openTextDocument(attributesUri);
  const relativePath = path
    .relative(path.dirname(attributesPath), repositoryResource.absolutePath)
    .split(path.sep)
    .join('/');
  const update = updateGitAttributes(document.getText(), relativePath, mode, target);
  if (!update.changed) {
    return false;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    attributesUri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    update.contents,
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error(`VS Code rejected the edit to ${attributesPath}.`);
  }
  if (!(await document.save())) {
    throw new Error(`Could not save ${attributesPath}.`);
  }
  return true;
}

async function nearestAttributesFile(filePath: string, repositoryRoot: string): Promise<string> {
  const root = path.resolve(repositoryRoot);
  let directory = path.dirname(path.resolve(filePath));
  while (isWithin(root, directory)) {
    const candidate = vscode.Uri.file(path.join(directory, '.gitattributes'));
    if (await exists(candidate)) {
      return candidate.fsPath;
    }
    if (directory === root) {
      break;
    }
    directory = path.dirname(directory);
  }
  return path.join(root, '.gitattributes');
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
      return false;
    }
    throw error;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
