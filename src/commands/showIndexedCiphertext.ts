import * as vscode from 'vscode';
import { GitCryptService } from '../gitCrypt/gitCryptService';

interface ResourceTreeItem {
  readonly resourceUri?: vscode.Uri;
}

const indexedCiphertextScheme = 'git-crypt-index';

export function registerShowIndexedCiphertextCommand(
  service: GitCryptService,
): vscode.Disposable {
  const provider = new IndexedCiphertextFileSystemProvider();
  const command = vscode.commands.registerCommand(
    'gitCryptDecorations.showIndexedCiphertext',
    async (resource?: vscode.Uri | ResourceTreeItem) => {
      const uri = resource instanceof vscode.Uri
        ? resource
        : resource?.resourceUri ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') {
        void vscode.window.showErrorMessage('Select a local encrypted file first.');
        return;
      }
      if (service.getStatus(uri.fsPath) !== 'encrypted') {
        void vscode.window.showErrorMessage('The selected file does not have an encrypted Git index blob.');
        return;
      }

      try {
        const blob = await service.readIndexedCiphertext(uri.fsPath);
        if (!blob) {
          void vscode.window.showErrorMessage('The selected file does not have an encrypted Git index blob.');
          return;
        }
        const document = await vscode.workspace.openTextDocument(
          provider.addDocument(blob.path, formatIndexedCiphertext(blob)),
        );
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Git index read error.';
        void vscode.window.showErrorMessage(`Could not read indexed ciphertext: ${message}`);
      }
    },
  );
  const registration = vscode.workspace.registerFileSystemProvider(indexedCiphertextScheme, provider, {
    isCaseSensitive: true,
    isReadonly: true,
  });
  return vscode.Disposable.from(command, registration, provider);
}

class IndexedCiphertextFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly documents = new Map<string, Uint8Array>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private nextDocumentId = 1;

  public readonly onDidChangeFile = this.changeEmitter.event;

  public addDocument(sourcePath: string, contents: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: indexedCiphertextScheme,
      path: `/indexed-ciphertext-${this.nextDocumentId++}-${basename(sourcePath)}.txt`,
    });
    this.documents.set(uri.toString(), Buffer.from(contents, 'utf8'));
    return uri;
  }

  public watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  public stat(uri: vscode.Uri): vscode.FileStat {
    const contents = this.contentsFor(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: contents.byteLength,
    };
  }

  public readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  public createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public readFile(uri: vscode.Uri): Uint8Array {
    return this.contentsFor(uri);
  }

  public writeFile(uri: vscode.Uri, _content: Uint8Array, _options: { readonly create: boolean; readonly overwrite: boolean }): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public delete(uri: vscode.Uri, _options: { readonly recursive: boolean }): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public rename(oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean }): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  public dispose(): void {
    this.documents.clear();
    this.changeEmitter.dispose();
  }

  private contentsFor(uri: vscode.Uri): Uint8Array {
    const contents = this.documents.get(uri.toString());
    if (!contents) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return contents;
  }
}

function formatIndexedCiphertext(blob: { path: string; objectId: string; contents: Buffer }): string {
  const previewLimit = 64 * 1024;
  const preview = blob.contents.subarray(0, previewLimit);
  const lines = [
    `Path: ${blob.path}`,
    `Object: ${blob.objectId}`,
    `Size: ${blob.contents.length} bytes`,
    preview.length < blob.contents.length
      ? `Preview: first ${preview.length} bytes`
      : 'Preview: complete blob',
    '',
  ];
  for (let offset = 0; offset < preview.length; offset += 16) {
    const bytes = preview.subarray(offset, offset + 16);
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const text = [...bytes]
      .map((value) => value >= 32 && value <= 126 ? String.fromCharCode(value) : '.')
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${text}|`);
  }
  return lines.join('\n');
}

function basename(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return filePath.slice(separator + 1).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
}
