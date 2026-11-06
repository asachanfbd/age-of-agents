import { claimProjectPull, currentBranch, detectGitOperationInProgress, git } from './git.ts';
import { checkBlockingChanges, describeFiles, NO_BLOCKING_CHANGES, overwriteRefusalMessage } from './incomingOverlap.ts';
import type { BlockingChanges, IncomingPaths } from './incomingOverlap.ts';
import type { GitOperation } from './git.ts';
import { projectAbsolutePath } from './projectService.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import type { CommandRunRecord, GitSyncStatus, NotificationSubject, ProjectRecord } from '../domain/types.ts';

/** A missing setting reads as on, so Projects stored before it existed keep pulling. */
export function isAutoPullEnabled(project: Pick<ProjectRecord, 'autoPullEnabled'>): boolean {
  return project.autoPullEnabled !== false;
}

/** What is true of the Project's main folder right now; each field that is true blocks a pull. */
export interface AutoPullBlockers {
  disabled: boolean;
  detachedHead: boolean;
  operation: GitOperation | null;
  folderBusy: boolean;
  /** Local changes that collide with the incoming commits; `total` 0 when none do. */
  blockingChanges: BlockingChanges;
}

export type AutoPullDecision = { action: 'pull' } | { action: 'defer'; reason: string | null; blocking?: BlockingChanges };

/** How many blocking files the deferral message names before "and N more". */
const NAMED_FILES = 3;

function overlapReason({ files, total, fallbackReason }: BlockingChanges): string {
  if (fallbackReason) return `not pulled: you have uncommitted changes to tracked files, and ${fallbackReason}`;
  return `not pulled: you have uncommitted changes to files the update also changes: ${describeFiles(files.map((file) => file.path), total, NAMED_FILES)}`;
}

const OPERATION_REASON: Record<GitOperation, string> = {
  merge: 'not pulled: a merge is in progress',
  rebase: 'not pulled: a rebase is in progress',
  'cherry-pick': 'not pulled: a cherry-pick is in progress',
  revert: 'not pulled: a revert is in progress',
};

export const DIVERGED_REASON = 'not pulled: your branch has diverged from origin';
export const GIT_ACTION_REASON = 'not pulled: another git action is running on this project';
export const DISABLED_REASON = 'auto-pull is off for this project';

/**
 * Whether the branch can be fast-forwarded now, and when not, why. Only a `behind` reading ever
 * pulls (the local branch has no commits of its own, so the merge is a fast-forward). A reason is
 * null when there is nothing to explain (nothing to pull). When several blockers apply the first
 * of this fixed order is reported.
 */
export function decideAutoPull(status: GitSyncStatus, blockers: AutoPullBlockers): AutoPullDecision {
  if (status === 'diverged') return { action: 'defer', reason: DIVERGED_REASON };
  if (status !== 'behind') return { action: 'defer', reason: null };
  if (blockers.disabled) return { action: 'defer', reason: DISABLED_REASON };
  if (blockers.detachedHead) return { action: 'defer', reason: 'not pulled: no branch is checked out' };
  if (blockers.operation) return { action: 'defer', reason: OPERATION_REASON[blockers.operation] };
  if (blockers.folderBusy) return { action: 'defer', reason: 'not pulled: a task is running in the main folder' };
  if (blockers.blockingChanges.total > 0) return { action: 'defer', reason: overlapReason(blockers.blockingChanges), blocking: blockers.blockingChanges };
  return { action: 'pull' };
}

export type AutoPullOutcome =
  | { kind: 'none' }
  | { kind: 'deferred'; reason: string; blocking?: BlockingChanges }
  | { kind: 'pulled'; commits: number; at: string };

export interface AutoPullDeps {
  isFolderBusy(project: ProjectRecord): Promise<boolean>;
  /** Runs the fetch and fast-forward as a tracked, automatic command run, resolving once it has settled. */
  runPull(project: ProjectRecord, branch: string): Promise<CommandRunRecord>;
  now?: () => Date;
  /** Where the paths an incoming pull changes come from; defaults to `git diff`. */
  incomingPaths?: IncomingPaths;
}

const MAX_REASON_LENGTH = 400;

/** The newest non-empty lines of a failed run's output, as a short reason. */
function failureReason(run: CommandRunRecord): string {
  const refusal = overwriteRefusalMessage(run.output);
  if (refusal) return refusal;
  const lines = run.output.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.slice(-6).join(' ').slice(-MAX_REASON_LENGTH) || (run.status === 'stopped' ? 'the pull was stopped' : `git exited with code ${run.exitCode}`);
}

/**
 * Decides and performs the automatic fast-forward of a Project's checked-out branch (see
 * docs/architecture.md, "Automatic pull"). `evaluate` is safe to call at any time and as often as
 * wanted: it claims the Project (so a task start waits instead of racing the pull), re-reads every
 * condition after the claim, and pulls only when all of them hold.
 *
 * A failed pull is remembered with the remote commit it failed against and is not retried until
 * `origin/<branch>` moves; the person sees one notification per distinct reason.
 */
export function createAutoPuller(deps: AutoPullDeps) {
  const now = deps.now ?? (() => new Date());
  const failures = new Map<string, { remoteSha: string; reason: string }>();

  async function blockersOf(project: ProjectRecord, cwd: string, branch: string): Promise<AutoPullBlockers> {
    const detachedHead = await currentBranch(cwd).then((current) => current !== branch, () => true);
    return {
      disabled: !isAutoPullEnabled(project),
      detachedHead,
      operation: detachedHead ? null : await detectGitOperationInProgress(cwd),
      folderBusy: await deps.isFolderBusy(project),
      blockingChanges: detachedHead ? NO_BLOCKING_CHANGES : (await checkBlockingChanges(cwd, `refs/remotes/origin/${branch}`, { incomingPaths: deps.incomingPaths })).blocking,
    };
  }

  async function reportFailure(project: ProjectRecord, branch: string, remoteSha: string, reason: string): Promise<void> {
    const previous = failures.get(project.id);
    failures.set(project.id, { remoteSha, reason });
    if (previous?.reason === reason) return;
    await raiseNotification({
      kind: 'git.auto_pull_failed',
      subject: subjectOf(project),
      title: `Automatic pull of "${project.name}" from origin/${branch} failed`,
      description: reason,
    });
  }

  async function evaluate(project: ProjectRecord, sync: { status: GitSyncStatus; branch: string; behindBy: number }): Promise<AutoPullOutcome> {
    if (sync.status !== 'behind') {
      failures.delete(project.id);
      await resolveNotifications(subjectOf(project), ['git.auto_pull_failed']);
      return sync.status === 'diverged' ? { kind: 'deferred', reason: DIVERGED_REASON } : { kind: 'none' };
    }
    const release = claimProjectPull(project.id);
    if (!release) return { kind: 'deferred', reason: GIT_ACTION_REASON };
    try {
      return await pullIfSafe(project, sync);
    } catch (error) {
      return { kind: 'deferred', reason: `not pulled: ${error instanceof Error ? error.message : 'unexpected error'}` };
    } finally {
      release();
    }
  }

  async function pullIfSafe(project: ProjectRecord, sync: { branch: string; behindBy: number }): Promise<AutoPullOutcome> {
    const cwd = projectAbsolutePath(project);
    const decision = decideAutoPull('behind', await blockersOf(project, cwd, sync.branch));
    if (decision.action === 'defer') return { kind: 'deferred', reason: decision.reason as string, blocking: decision.blocking };

    const remoteSha = await git(cwd, ['rev-parse', `refs/remotes/origin/${sync.branch}`]);
    const failed = failures.get(project.id);
    if (failed?.remoteSha === remoteSha) return { kind: 'deferred', reason: `not pulled: the last automatic pull failed (${failed.reason})` };

    const run = await deps.runPull(project, sync.branch);
    if (run.status !== 'success') {
      const reason = failureReason(run);
      await reportFailure(project, sync.branch, remoteSha, reason);
      return { kind: 'deferred', reason: `not pulled: ${reason}` };
    }
    failures.delete(project.id);
    await resolveNotifications(subjectOf(project), ['git.auto_pull_failed']);
    return { kind: 'pulled', commits: sync.behindBy, at: now().toISOString() };
  }

  return { evaluate };
}

export type AutoPuller = ReturnType<typeof createAutoPuller>;

function subjectOf(project: ProjectRecord): NotificationSubject {
  return { type: 'project', projectId: project.id };
}
