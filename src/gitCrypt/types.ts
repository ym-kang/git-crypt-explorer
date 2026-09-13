export type GitCryptStatus = 'encrypted' | 'warning' | 'none';

export interface RepositorySnapshot {
  readonly root: string;
  readonly gitDir: string;
  readonly statuses: ReadonlyMap<string, GitCryptStatus>;
  readonly protectedFiles: number;
  readonly warnings: number;
  readonly gitCryptDetected: boolean;
  readonly error?: string;
}

export interface WorkspaceStatus {
  readonly workspaceFolders: number;
  readonly nonGitFolders: number;
  readonly gitUnavailable: boolean;
  readonly repositories: readonly RepositorySnapshot[];
  readonly discoveryErrors: readonly string[];
}
