export type GitCryptStatus = 'encrypted' | 'warning' | 'none';

export type GitCryptLocalState = 'unlocked' | 'locked' | 'not-initialized';

export interface GitCryptRepositoryStatus {
  readonly available: boolean;
  readonly version?: string;
  readonly localState: GitCryptLocalState;
  readonly installedKeyCount: number;
}

export interface RepositorySnapshot {
  readonly root: string;
  readonly gitDir: string;
  readonly statuses: ReadonlyMap<string, GitCryptStatus>;
  readonly statusDetails: ReadonlyMap<string, string>;
  readonly protectedFiles: number;
  readonly encryptedIndexFiles: number;
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
