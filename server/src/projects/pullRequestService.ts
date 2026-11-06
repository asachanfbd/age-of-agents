import type { ProjectRecord, PullRequestCheckout, WorkflowRunRecord } from '../domain/types.ts';
import { assertProjectFolderFree, defaultSessionRegistry, type SessionRegistry } from '../worker/projectFolderGuard.ts';
import { GitError, currentBranch, git, localBranchExists, withProjectLock } from './git.ts';
import { gitSyncPoller } from './gitSyncPoller.ts';
import { fetchPullRequestHead, mergePullRequest, pullRequestContext, readPullRequest } from './pullRequestActions.ts';
import { PullRequestHeadGoneError, UNMERGEABLE_REASONS, classifyMergeState } from './pullRequestMerge.ts';
import type { PullRequestMergeResult, PullRequestMergeState, PullRequestReading } from './pullRequestMerge.ts';
import { withProjectGithub } from '../github/accounts.ts';
import { assertCleanForSwitch, getProject, patchProject, projectAbsolutePath, switchProjectBranch } from './projectService.ts';

/** The PR is being merged, or the Project's working copy is being switched, right now. */
export class PullRequestBusyError extends Error {
  constructor(message: string) { super(message); this.name = 'PullRequestBusyError'; }
}

export class PullRequestNotMergeableError extends Error {
  constructor(reason: string) { super(reason); this.name = 'PullRequestNotMergeableError'; }
}

/** Check out was asked for a pull request that is closed or already merged. */
export class PullRequestNotOpenError extends Error {
  constructor(state: 'closed' | 'merged') {
    super(`${UNMERGEABLE_REASONS[state]}, so it can't be checked out.`);
    this.name = 'PullRequestNotOpenError';
  }
}

export class ConflictAgentRequiredError extends Error {
  constructor() { super('Choose a coding agent to resolve this pull request\'s conflicts.'); this.name = 'ConflictAgentRequiredError'; }
}

export class PullRequestBranchDivergedError extends Error {
  constructor(branch: string, number: number) {
    super(`Your local branch "${branch}" has commits that pull request #${number} doesn't have, and the pull request has commits your branch doesn't. Nothing was changed; reconcile or rename the local branch, then check out again.`);
    this.name = 'PullRequestBranchDivergedError';
  }
}

export class NoPullRequestCheckoutError extends Error {
  constructor() { super('This project has no pull request checked out to return from.'); this.name = 'NoPullRequestCheckoutError'; }
}

/** Return's target branch is gone; `defaultBranch` is what the person is offered instead. */
export class PreviousBranchGoneError extends Error {
  readonly defaultBranch: string;
  constructor(branch: string, defaultBranch: string) {
    super(`The branch "${branch}" you were on before no longer exists. Return to "${defaultBranch}" instead.`);
    this.name = 'PreviousBranchGoneError';
    this.defaultBranch = defaultBranch;
  }
}

export type MergeOutcome =
  | ({ outcome: 'merged' } & PullRequestMergeResult)
  | { outcome: 'needs-confirmation'; blockers: string[] }
  | { outcome: 'resolving'; run: WorkflowRunRecord; existing: boolean };

export interface PullRequestServiceDeps {
  /** The conflict-resolution run engine — workerManager.ts's functions of the same names. */
  startConflictRun(projectId: string, reading: PullRequestReading, executorId: string): Promise<{ run: WorkflowRunRecord; existing: boolean }>;
  activeConflictRun(projectId: string, number: number): Promise<WorkflowRunRecord | null>;
  sessions?: SessionRegistry;
}

/** The local branch a pull request is checked out as: its head branch's own name, or a PR-specific one for a fork, whose branch name (often `main`) would collide with a local branch. */
export function localBranchFor(reading: Pick<PullRequestReading, 'number' | 'headBranch' | 'isFork'>): string {
  return reading.isFork ? `pr-${reading.number}/${reading.headBranch}` : reading.headBranch;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try { await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]); return true; } catch { return false; }
}

/**
 * The repository's default branch: the local record of `origin/HEAD` when there is one (a clone sets
 * it), otherwise asked of the remote, since a repository that wasn't cloned has no such record and
 * its default branch need not be `main`.
 */
async function defaultBranchOf(cwd: string): Promise<string> {
  try { return (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, ''); } catch { /* Not recorded locally. */ }
  try {
    const advertised = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(await git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD']));
    if (advertised) return advertised[1]!;
  } catch { /* The remote can't be reached. */ }
  return 'main';
}

async function branchExistsAnywhere(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ['for-each-ref', `refs/heads/${branch}`, `refs/remotes/origin/${branch}`])).length > 0;
}

/**
 * The PR tab's actions for one Project: read a pull request's merge state, merge it (starting a
 * conflict-resolution run when it conflicts), check its branch out in the Project's own folder, and
 * return to the branch the person was on before.
 */
export function createPullRequestService(deps: PullRequestServiceDeps) {
  const sessions = deps.sessions ?? defaultSessionRegistry();
  /** Pull requests with a merge request in flight, per Project. */
  const merging = new Map<string, Set<number>>();
  /** Projects whose working copy a checkout or Return is switching. */
  const switching = new Set<string>();

  async function mergeState(projectId: string, number: number): Promise<PullRequestMergeState> {
    return classifyMergeState(await readPullRequest(await getProject(projectId), number));
  }

  /**
   * The Merge click. Reads the merge state afresh (never trusting what the list showed) and acts on
   * its class: clean merges now; blocked merges only with `confirmBlockers`, otherwise the blockers
   * come back to be confirmed; conflicts start the resolution run with the chosen agent; unmergeable
   * is refused with the reason. A second request for the same PR while one is in flight is refused.
   */
  async function merge(projectId: string, number: number, options: { confirmBlockers?: boolean; executorId?: string } = {}): Promise<MergeOutcome> {
    const project = await getProject(projectId);
    pullRequestContext(project);
    const inFlight = merging.get(projectId) ?? new Set<number>();
    if (inFlight.has(number)) throw new PullRequestBusyError(`Pull request #${number} is already being merged.`);
    merging.set(projectId, inFlight.add(number));
    try {
      const active = await deps.activeConflictRun(projectId, number);
      if (active) return { outcome: 'resolving', run: active, existing: true };
      const reading = await readPullRequest(project, number);
      const state = classifyMergeState(reading);
      if (state.status === 'unmergeable') throw new PullRequestNotMergeableError(state.reason ?? 'This pull request can\'t be merged.');
      if (state.status === 'conflicts') {
        if (!options.executorId) throw new ConflictAgentRequiredError();
        return { outcome: 'resolving', ...(await withProjectGithub(project, 'start the conflict resolution', () => deps.startConflictRun(projectId, reading, options.executorId!))) };
      }
      if (state.status === 'blocked' && !options.confirmBlockers) return { outcome: 'needs-confirmation', blockers: state.blockers };
      // Only a merge the person confirmed over its blockers may use the account's right to bypass protection.
      return { outcome: 'merged', ...(await mergePullRequest(project, reading, { bypassProtection: state.status === 'blocked' })) };
    } finally {
      inFlight.delete(number);
    }
  }

  /** Holds the Project's working copy for one checkout or Return; refused while another is running or any of its pull requests is being merged. */
  async function whileSwitching<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    if (switching.has(projectId) || (merging.get(projectId)?.size ?? 0) > 0) {
      throw new PullRequestBusyError('Another merge or checkout is in progress for this project. Try again in a moment.');
    }
    switching.add(projectId);
    try { return await action(); } finally { switching.delete(projectId); }
  }

  /**
   * Moves the working copy onto `branch` at the PR's head commit without overwriting anything: a new
   * branch is created there; an existing one is switched to and fast-forwarded when it is behind,
   * kept as it is when it is ahead, and refused (before any switch) when it has diverged.
   */
  async function switchToPullRequestHead(cwd: string, branch: string, headSha: string, number: number): Promise<void> {
    if (!(await localBranchExists(cwd, branch))) {
      await git(cwd, ['switch', '-c', branch, headSha]);
      return;
    }
    const localSha = await git(cwd, ['rev-parse', `refs/heads/${branch}`]);
    const behind = localSha !== headSha && await isAncestor(cwd, localSha, headSha);
    if (localSha !== headSha && !behind && !(await isAncestor(cwd, headSha, localSha))) throw new PullRequestBranchDivergedError(branch, number);
    await git(cwd, ['switch', branch]);
    if (behind) await git(cwd, ['merge', '--ff-only', headSha]);
  }

  /** Points a same-repository PR branch at its remote branch, so the sync indicator can compare them. Best effort: the checkout stands without it. */
  async function trackRemoteBranch(cwd: string, branch: string): Promise<void> {
    try {
      await git(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      await git(cwd, ['branch', '--set-upstream-to', `origin/${branch}`, branch]);
    } catch { /* The branch may exist only as the PR's head ref. */ }
  }

  /**
   * The Check out click: switches the Project's own folder to the pull request's branch, under the
   * branch switcher's rules (clean tree, folder not in use). It never merges, pushes, changes the
   * pull request or starts an agent. Like any switch to an existing branch it leaves paused tasks on
   * the branch they were started on: moving them would make a later resume commit onto the PR.
   */
  function checkout(projectId: string, number: number): Promise<ProjectRecord> {
    return whileSwitching(projectId, async () => {
      const project = await getProject(projectId);
      pullRequestContext(project);
      const updated = await withProjectGithub(project, 'check out the pull request', () => withProjectLock(projectId, async () => {
        const cwd = projectAbsolutePath(project);
        await assertProjectFolderFree(project, sessions, 'git');
        await assertCleanForSwitch(cwd);
        const reading = await readPullRequest(project, number);
        if (reading.state !== 'open') throw new PullRequestNotOpenError(reading.state);
        if (!reading.headBranchExists) throw new PullRequestHeadGoneError(number);
        const headSha = await fetchPullRequestHead(project, number);
        const branch = localBranchFor(reading);
        const from = await currentBranch(cwd);
        await switchToPullRequestHead(cwd, branch, headSha, number);
        if (!reading.isFork) await trackRemoteBranch(cwd, branch);
        // Return goes to wherever the person was just before this checkout: another PR's branch
        // counts. Already being on this PR's branch keeps the earlier answer, or the default branch.
        const previousBranch = from !== branch ? from : project.prCheckout?.previousBranch ?? await defaultBranchOf(cwd);
        const prCheckout: PullRequestCheckout = { number, branch, previousBranch };
        return patchProject(projectId, { prCheckout });
      }));
      await gitSyncPoller.refreshOne(updated);
      return updated;
    });
  }

  /**
   * The Return action: back to the branch the person was on before the checkout, or to `branch`
   * when they chose the offered default branch because that one is gone.
   */
  function returnFromCheckout(projectId: string, branch?: string): Promise<ProjectRecord> {
    return whileSwitching(projectId, async () => {
      const project = await getProject(projectId);
      pullRequestContext(project);
      if (!project.prCheckout) throw new NoPullRequestCheckoutError();
      const cwd = projectAbsolutePath(project);
      const defaultBranch = await withProjectGithub(project, 'look up the default branch', () => defaultBranchOf(cwd));
      if (branch !== undefined && branch !== defaultBranch) throw new GitError(`Return can only go to the branch you were on, or to "${defaultBranch}".`);
      const target = branch ?? project.prCheckout.previousBranch;
      if (!(await branchExistsAnywhere(cwd, target))) throw new PreviousBranchGoneError(target, defaultBranch);
      await switchProjectBranch(projectId, target, sessions);
      const updated = await getProject(projectId);
      await gitSyncPoller.refreshOne(updated);
      return updated;
    });
  }

  return { mergeState, merge, checkout, returnFromCheckout };
}

export type PullRequestService = ReturnType<typeof createPullRequestService>;
