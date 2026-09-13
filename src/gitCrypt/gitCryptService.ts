import * as path from 'node:path';
import {
  GitClient,
  GitClientLike,
  GitCommandError,
  GitRepositoryLocation,
} from '../git/gitClient';
import { GitCryptStatus, RepositorySnapshot, WorkspaceStatus } from './types';

interface MutableRepository {
  readonly location: GitRepositoryLocation;
  readonly mounts: Map<string, string>;
  snapshot: RepositorySnapshot;
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

  private async refresh(repository: MutableRepository): Promise<void> {
    try {
      const files = await this.git.listFiles(repository.location.root);
      const filters = await this.git.checkFilter(repository.location.root, files);
      const statuses = new Map<string, GitCryptStatus>();
      let protectedFiles = 0;

      for (const file of files) {
        if (filters.get(file) === 'git-crypt') {
          statuses.set(path.resolve(repository.location.root, file), 'encrypted');
          protectedFiles += 1;
        }
      }

      repository.snapshot = {
        root: repository.location.root,
        gitDir: repository.location.gitDir,
        statuses,
        protectedFiles,
        warnings: 0,
        gitCryptDetected: protectedFiles > 0,
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
    statuses: new Map(),
    protectedFiles: 0,
    warnings: 0,
    gitCryptDetected: false,
  };
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
