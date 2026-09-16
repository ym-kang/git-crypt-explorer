import * as path from 'node:path';
import {
  GitClient,
  GitClientLike,
  GitCommandError,
  GitIndexEntry,
  GitRepositoryLocation,
} from '../git/gitClient';
import {
  GitCryptPathDecoration,
  GitCryptStatus,
  RepositorySnapshot,
  WorkspaceStatus,
} from './types';

interface MutableRepository {
  readonly location: GitRepositoryLocation;
  readonly mounts: Map<string, string>;
  blobEncryptionCache: Map<string, boolean>;
  snapshot: RepositorySnapshot;
}

export interface RepositoryResource {
  readonly root: string;
  readonly absolutePath: string;
  readonly relativePath: string;
}

/** Owns repository-level snapshots. Decoration reads never invoke Git. */
export class GitCryptService {
  private repositories = new Map<string, MutableRepository>();
  private workspaceFolders = 0;
  private nonGitFolders = 0;
  private gitUnavailable = false;
  private discoveryErrors: string[] = [];

  public constructor(private readonly git: GitClientLike = new GitClient()) {}

  public async initialize(workspaceFolderPaths: readonly string[]): Promise<void> {
    this.workspaceFolders = workspaceFolderPaths.length;
    this.nonGitFolders = 0;
    this.gitUnavailable = false;
    this.discoveryErrors = [];

    const discoveries = await Promise.all(
      workspaceFolderPaths.map(async (folder) => {
        try {
          return { folder: path.resolve(folder), location: await this.git.discover(folder) };
        } catch (error) {
          this.recordDiscoveryFailure(error);
          return undefined;
        }
      }),
    );

    const next = new Map<string, MutableRepository>();
    for (const discovery of discoveries) {
      if (!discovery) {
        continue;
      }
      const { folder, location } = discovery;
      const key = path.resolve(location.root);
      if (!next.has(key)) {
        const previous = this.repositories.get(key);
        next.set(key, {
          location,
          mounts: new Map(),
          blobEncryptionCache: previous?.blobEncryptionCache ?? new Map(),
          snapshot: previous?.snapshot ?? emptySnapshot(location),
        });
      }
      next.get(key)?.mounts.set(folder, location.workspacePrefix);
    }
    this.repositories = next;
    await this.refreshAll();
  }

  public async refreshAll(): Promise<void> {
    await Promise.all([...this.repositories.values()].map((repository) => this.refresh(repository)));
  }

  public getStatus(filePath: string): GitCryptStatus {
    const match = this.repositoryPathForWorkspacePath(filePath);
    if (!match) {
      return 'none';
    }
    return match.repository.snapshot.statuses.get(match.repositoryPath) ?? 'none';
  }

  public getPathDecoration(filePath: string): GitCryptPathDecoration {
    const match = this.repositoryPathForWorkspacePath(filePath);
    if (!match) {
      return 'none';
    }

    const snapshot = match.repository.snapshot;
    const directStatus = snapshot.statuses.get(match.repositoryPath);
    if (directStatus) {
      return directStatus;
    }

    const descendantFiles = [...snapshot.scannedFiles].filter((scannedFile) =>
      isWithin(match.repositoryPath, scannedFile),
    );
    if (descendantFiles.length === 0) {
      return 'none';
    }

    const descendantStatuses = descendantFiles
      .map((scannedFile) => snapshot.statuses.get(scannedFile))
      .filter((status): status is GitCryptStatus => status !== undefined);
    if (descendantStatuses.some((status) => status === 'warning')) {
      return 'warning';
    }

    const encryptedCount = descendantStatuses.filter((status) => status === 'encrypted').length;
    if (encryptedCount === descendantFiles.length) {
      return 'encrypted';
    }
    return encryptedCount > 0 ? 'partial' : 'none';
  }

  public getEncryptedFileCount(filePath: string): number {
    const match = this.repositoryPathForWorkspacePath(filePath);
    if (!match) {
      return 0;
    }

    const snapshot = match.repository.snapshot;
    if (snapshot.statuses.get(match.repositoryPath) === 'encrypted') {
      return 1;
    }
    return [...snapshot.scannedFiles].filter(
      (scannedFile) =>
        isWithin(match.repositoryPath, scannedFile) &&
        snapshot.statuses.get(scannedFile) === 'encrypted',
    ).length;
  }

  public getStatusDetail(filePath: string): string | undefined {
    const match = this.repositoryPathForWorkspacePath(filePath);
    return match?.repository.snapshot.statusDetails.get(match.repositoryPath);
  }

  public getWorkspaceStatus(): WorkspaceStatus {
    return {
      workspaceFolders: this.workspaceFolders,
      nonGitFolders: this.nonGitFolders,
      gitUnavailable: this.gitUnavailable,
      repositories: [...this.repositories.values()].map((repository) => repository.snapshot),
      discoveryErrors: [...this.discoveryErrors],
    };
  }

  public getRepositorySnapshotForPath(filePath: string): RepositorySnapshot | undefined {
    return this.repositoryPathForWorkspacePath(filePath)?.repository.snapshot;
  }

  public getRepositoryLocations(): readonly GitRepositoryLocation[] {
    return [...this.repositories.values()].map((repository) => repository.location);
  }

  public getRepositoryResource(filePath: string): RepositoryResource | undefined {
    const match = this.repositoryPathForWorkspacePath(filePath);
    if (!match) {
      return undefined;
    }
    const root = match.repository.location.root;
    return {
      root,
      absolutePath: match.repositoryPath,
      relativePath: toGitPath(path.relative(root, match.repositoryPath)),
    };
  }

  public async isProtectedFile(filePath: string): Promise<boolean | undefined> {
    const repositoryFile = this.getRepositoryResource(filePath);
    if (!repositoryFile) {
      return undefined;
    }
    const filters = await this.git.checkFilter(repositoryFile.root, [repositoryFile.relativePath]);
    return filters.get(repositoryFile.relativePath) === 'git-crypt';
  }

  private async refresh(repository: MutableRepository): Promise<void> {
    try {
      const [files, indexEntries] = await Promise.all([
        this.git.listFiles(repository.location.root),
        this.git.listIndexEntries(repository.location.root),
      ]);
      const filters = await this.git.checkFilter(repository.location.root, files);
      const statuses = new Map<string, GitCryptStatus>();
      const statusDetails = new Map<string, string>();
      const entriesByPath = groupIndexEntries(indexEntries);
      const targets = files.filter((file) => filters.get(file) === 'git-crypt');
      const targetObjectIds = new Map<string, string>();

      for (const file of targets) {
        const entries = entriesByPath.get(file) ?? [];
        const stageZero = entries.find((entry) => entry.stage === 0);
        if (stageZero && isRegularFileMode(stageZero.mode)) {
          targetObjectIds.set(file, stageZero.objectId);
        }
      }

      const objectIds = [...new Set(targetObjectIds.values())];
      const missingObjectIds = objectIds.filter(
        (objectId) => !repository.blobEncryptionCache.has(objectId),
      );
      const inspected = await this.git.checkBlobEncryption(
        repository.location.root,
        missingObjectIds,
      );
      const nextBlobCache = new Map<string, boolean>();
      for (const objectId of objectIds) {
        const encrypted =
          repository.blobEncryptionCache.get(objectId) ?? inspected.get(objectId) ?? false;
        nextBlobCache.set(objectId, encrypted);
      }

      let encryptedIndexFiles = 0;
      let warnings = 0;
      for (const file of targets) {
        const absolutePath = path.resolve(repository.location.root, file);
        const entries = entriesByPath.get(file) ?? [];
        const objectId = targetObjectIds.get(file);
        if (objectId && nextBlobCache.get(objectId) === true) {
          statuses.set(absolutePath, 'encrypted');
          encryptedIndexFiles += 1;
          continue;
        }

        statuses.set(absolutePath, 'warning');
        warnings += 1;
        statusDetails.set(absolutePath, warningDetail(entries, objectId));
      }

      repository.blobEncryptionCache = nextBlobCache;

      repository.snapshot = {
        root: repository.location.root,
        gitDir: repository.location.gitDir,
        scannedFiles: new Set(
          files.map((file) => path.resolve(repository.location.root, file)),
        ),
        statuses,
        statusDetails,
        protectedFiles: targets.length,
        encryptedIndexFiles,
        warnings,
        gitCryptDetected: targets.length > 0,
      };
    } catch (error) {
      repository.snapshot = {
        ...repository.snapshot,
        error: safeErrorMessage(error),
      };
    }
  }

  private repositoryPathForWorkspacePath(
    filePath: string,
  ): { repository: MutableRepository; repositoryPath: string } | undefined {
    const absolute = path.resolve(filePath);
    let best:
      | { repository: MutableRepository; repositoryPath: string; mountLength: number }
      | undefined;

    for (const repository of this.repositories.values()) {
      for (const [mount, prefix] of repository.mounts) {
        if (isWithin(mount, absolute) && (!best || mount.length > best.mountLength)) {
          const relative = path.relative(mount, absolute);
          best = {
            repository,
            repositoryPath: path.resolve(repository.location.root, prefix, relative),
            mountLength: mount.length,
          };
        }
      }
    }
    return best;
  }

  private recordDiscoveryFailure(error: unknown): void {
    this.nonGitFolders += 1;
    if (error instanceof GitCommandError && error.unavailable) {
      this.gitUnavailable = true;
      return;
    }
    if (error instanceof GitCommandError && error.exitCode === 128) {
      return;
    }
    this.discoveryErrors.push(safeErrorMessage(error));
  }
}

function emptySnapshot(location: GitRepositoryLocation): RepositorySnapshot {
  return {
    root: location.root,
    gitDir: location.gitDir,
    scannedFiles: new Set(),
    statuses: new Map(),
    statusDetails: new Map(),
    protectedFiles: 0,
    encryptedIndexFiles: 0,
    warnings: 0,
    gitCryptDetected: false,
  };
}

function groupIndexEntries(
  entries: readonly GitIndexEntry[],
): ReadonlyMap<string, readonly GitIndexEntry[]> {
  const grouped = new Map<string, GitIndexEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.path) ?? [];
    current.push(entry);
    grouped.set(entry.path, current);
  }
  return grouped;
}

function isRegularFileMode(mode: string): boolean {
  return (Number.parseInt(mode, 8) & 0o170000) === 0o100000;
}

function warningDetail(entries: readonly GitIndexEntry[], objectId?: string): string {
  if (entries.length === 0) {
    return 'git-crypt target is not present in the Git index.';
  }
  if (!objectId) {
    return entries.some((entry) => entry.stage !== 0)
      ? 'git-crypt target has unresolved index stages.'
      : 'git-crypt target is not a regular file in the Git index.';
  }
  return 'git-crypt target has an unencrypted Git index blob.';
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown Git error.';
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
