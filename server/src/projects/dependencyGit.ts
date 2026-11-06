import { withProjectGithub } from '../github/accounts.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { currentBranch, gh, git } from './git.ts';
import { projectAbsolutePath } from './projectService.ts';

/** What the dependency check reads from git and the provider. Injected so tests use a fake. */
export interface DependencyGit {
  /** The branch checked out in the project's own folder; null when none is (detached HEAD). */
  checkedOutBranch(project: ProjectRecord): Promise<string | null>;
  /** The commit a local branch points at; null when the branch does not exist locally. */
  branchHead(project: ProjectRecord, branch: string): Promise<string | null>;
  /** Whether `commit` is part of `branch`'s history. False when the commit is not known locally. */
  isAncestor(project: ProjectRecord, commit: string, branch: string): Promise<boolean>;
  /** How many commits `branch` has that `base` lacks; null when either is unknown. */
  commitsAhead(project: ProjectRecord, branch: string, base: string): Promise<number | null>;
  /** The provider's view of the pull request raised from `branch`; null when there is none or the provider cannot be reached. */
  pullRequest(project: ProjectRecord, branch: string): Promise<{ state: 'open' | 'closed' | 'merged'; mergeCommit: string | null } | null>;
}

const attempt = async <T>(action: () => Promise<T>, fallback: T): Promise<T> => {
  try { return await action(); } catch { return fallback; }
};

export const realDependencyGit: DependencyGit = {
  checkedOutBranch: (project) => attempt(() => currentBranch(projectAbsolutePath(project)), null),
  branchHead: (project, branch) => attempt(async () => (await git(projectAbsolutePath(project), ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) || null, null),
  isAncestor: (project, commit, branch) => attempt(async () => {
    await git(projectAbsolutePath(project), ['merge-base', '--is-ancestor', commit, `refs/heads/${branch}`]);
    return true;
  }, false),
  commitsAhead: (project, branch, base) => attempt(async () => {
    const count = await git(projectAbsolutePath(project), ['rev-list', '--count', `${base}..${branch}`]);
    return Number.parseInt(count, 10);
  }, null),
  pullRequest: (project, branch) => attempt(async () => {
    const out = await withProjectGithub(project, 'read the parent task\'s pull request', () => gh(projectAbsolutePath(project), ['pr', 'view', branch, '--json', 'state,mergeCommit']));
    const parsed = JSON.parse(out) as { state?: string; mergeCommit?: { oid?: string } | null };
    const state = parsed.state?.toLowerCase();
    return state === 'open' || state === 'closed' || state === 'merged' ? { state, mergeCommit: parsed.mergeCommit?.oid ?? null } : null;
  }, null),
};
