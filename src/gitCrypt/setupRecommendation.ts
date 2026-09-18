import { GitCryptLocalState, GitCryptRepositoryStatus } from './types';

export type GitCryptSetupRecommendation =
  | 'initialize-git'
  | 'unlock'
  | 'initialize-git-crypt'
  | 'none';

/** Chooses the first setup question without invoking Git or git-crypt. */
export function recommendGitCryptSetup(
  repositoryExists: boolean,
  protectedFileCount = 0,
  localState?: GitCryptLocalState,
): GitCryptSetupRecommendation {
  if (!repositoryExists) {
    return 'initialize-git';
  }
  if (protectedFileCount > 0 && localState === 'locked') {
    return 'unlock';
  }
  if (protectedFileCount === 0 && localState === 'not-initialized') {
    return 'initialize-git-crypt';
  }
  return 'none';
}

export function gitCryptTargetOperationError(
  status: GitCryptRepositoryStatus,
): string | undefined {
  if (!status.available) {
    return 'git-crypt is not installed or is not available on PATH.';
  }
  if (status.localState === 'locked') {
    return 'git-crypt is locked. Unlock the repository before changing encryption targets.';
  }
  if (status.localState === 'not-initialized') {
    return 'git-crypt is not initialized locally. Initialize or unlock the repository before changing encryption targets.';
  }
  return undefined;
}
