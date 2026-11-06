import type { AutoMergeRecord, AutoMergeState, NotificationKind, ProjectRecord, WorkflowRunRecord } from '../domain/types.ts';
import { redactSecrets } from '../redaction.ts';
import { classifyMergeState } from './pullRequestMerge.ts';
import type { PullRequestReading } from './pullRequestMerge.ts';

/**
 * The pure rules behind a task's Auto-merge toggle: who may have it, which agent resolves
 * conflicts, what a pull request reading means for it and which notification a state raises.
 * The service that acts on them is `autoMergeService.ts`.
 */

export const DEVELOPMENT_STEP_ID = 'development';

const AUTO_MERGE_STATES: readonly AutoMergeState[] = ['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent', 'merged', 'failed', 'no-pr', 'cannot-merge'];

/** Why a task cannot have Auto-merge, or null when it can. A task that has not started has no run yet and is eligible: its branch is decided at start. */
export function autoMergeIneligibleReason(project: Pick<ProjectRecord, 'repositoryUrl'>, run: Pick<WorkflowRunRecord, 'branch' | 'baseBranch'> | null): string | null {
  if (!project.repositoryUrl) return 'This project has no linked repository, so its tasks never raise a pull request.';
  if (run && !(run.branch && run.baseBranch)) return 'This run works on the project\'s own branch, so it has no pull request of its own to merge.';
  return null;
}

/** The pull request number in a run's `prUrl`, or null when the run raised none. */
export function pullRequestNumberOf(prUrl: string | null | undefined): number | null {
  const match = prUrl ? /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl) : null;
  return match ? Number(match[1]) : null;
}

/**
 * The coding agent (executor id) that resolves this task's merge conflicts: the Development step's,
 * else the first write-capable step's, else the run's own. A step without an agent of its own
 * defers to the run's.
 */
export function conflictExecutorFor(run: Pick<WorkflowRunRecord, 'workflowSnapshot' | 'executorId'>): string | null {
  const steps = run.workflowSnapshot.steps;
  const chosen = steps.find((step) => step.id === DEVELOPMENT_STEP_ID) ?? steps.find((step) => step.canEditCode);
  return chosen?.executorId || run.executorId || null;
}

export type AutoMergeDecision =
  | { action: 'merge'; warnings: string[] }
  | { action: 'resolve'; warnings: string[] }
  | { action: 'merged' }
  | { action: 'blocked'; reasons: string[]; warnings: string[] }
  | { action: 'cannot-merge'; reason: string };

/** What auto-merge does with a pull request as the provider reports it now. A blocker is never overridden. */
export function decideAutoMerge(reading: PullRequestReading): AutoMergeDecision {
  if (reading.state === 'merged') return { action: 'merged' };
  const state = classifyMergeState(reading);
  if (state.status === 'unmergeable') return { action: 'cannot-merge', reason: state.reason ?? 'This pull request can\'t be merged.' };
  if (state.status === 'conflicts') return { action: 'resolve', warnings: state.warnings };
  if (state.status === 'blocked') return { action: 'blocked', reasons: state.blockers, warnings: state.warnings };
  return { action: 'merge', warnings: state.warnings };
}

/** `{ enabled: boolean }`, nothing else. */
export function parseAutoMergeToggle(body: unknown): boolean | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const { enabled } = body as { enabled?: unknown };
  return keys.length === 1 && typeof enabled === 'boolean' ? enabled : null;
}

/** A stored record read back safely: anything missing or malformed reads as "off". */
export function readAutoMerge(value: unknown): AutoMergeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<AutoMergeRecord>;
  if (typeof raw.enabled !== 'boolean') return null;
  const state = AUTO_MERGE_STATES.includes(raw.state as AutoMergeState) ? raw.state as AutoMergeState : 'waiting';
  return {
    enabled: raw.enabled,
    state,
    reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((reason): reason is string => typeof reason === 'string') : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
    prNumber: typeof raw.prNumber === 'number' ? raw.prNumber : null,
    runId: typeof raw.runId === 'string' ? raw.runId : null,
    mergedAt: typeof raw.mergedAt === 'string' ? raw.mergedAt : null,
    branchWarning: typeof raw.branchWarning === 'string' ? raw.branchWarning : null,
    branchNote: typeof raw.branchNote === 'string' ? raw.branchNote : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export function newAutoMerge(enabled: boolean, now: string): AutoMergeRecord {
  return { enabled, state: 'waiting', reasons: [], warnings: [], prNumber: null, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: now };
}

/** A stored reason never carries a credential, nor a URL with one inside. */
export function safeReason(text: string): string {
  return redactSecrets(text).replace(/(https?:\/\/)[^\s/@]+@/g, '$1[secret]@').trim();
}

/** The notification a state raises (one per task, resolved when the state changes), or null. `conflictFailed` tells a failed conflict run from any other failure. */
export function notificationKindFor(state: AutoMergeState, conflictFailed = false): NotificationKind | null {
  if (state === 'blocked') return 'automerge.blocked';
  if (state === 'failed') return conflictFailed ? 'automerge.conflict_failed' : 'automerge.failed';
  if (state === 'cannot-merge' || state === 'no-pr') return 'automerge.failed';
  return null;
}

/** The "merged" notification's description: the PR, then what became of its branch. */
export function autoMergeMergedDescription(record: Pick<AutoMergeRecord, 'prNumber' | 'branchNote' | 'branchWarning'>): string {
  return [record.prNumber === null ? 'Pull request merged.' : `PR #${record.prNumber} merged.`, record.branchNote, record.branchWarning]
    .filter((part): part is string => Boolean(part)).join(' ');
}

/** Kinds raised when Auto-merge needs the person; each is resolved when the state changes. `automerge.merged` is not one of them: it stays until it is read. */
export const AUTO_MERGE_NOTIFICATION_KINDS: NotificationKind[] = ['automerge.blocked', 'automerge.conflict_failed', 'automerge.failed'];

const TITLE_LIMIT = 200;

/** The conflict run's board title: clearly part of the task's auto-merge. */
export function autoMergeConflictTitle(taskTitle: string): string {
  const title = taskTitle.trim().slice(0, TITLE_LIMIT);
  return title ? `Auto-merge conflicts · ${title}` : 'Auto-merge conflicts';
}

const UNREACHABLE = /timed? ?out|network|ECONN|ENET|EAI_AGAIN|could not resolve host|dial tcp|not (?:signed|logged) in|gh auth login|not installed|ENOENT|could not reach/i;

/** Whether a provider failure is the environment's (gh missing or signed out, network) and so worth retrying at the next evaluation. */
export function isProviderUnreachable(message: string): boolean {
  return UNREACHABLE.test(message);
}

/** Runs jobs for one key at a time in the order they came; a job for a key already waiting is not queued twice; a throwing job never stalls the next. */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<void>>();
  const waiting = new Map<string, Set<string>>();
  return {
    enqueue(key: string, jobId: string, job: () => Promise<void>): Promise<void> {
      const pending = waiting.get(key) ?? new Set<string>();
      waiting.set(key, pending);
      if (pending.has(jobId)) return tails.get(key) ?? Promise.resolve();
      pending.add(jobId);
      const run = (tails.get(key) ?? Promise.resolve()).then(async () => {
        pending.delete(jobId);
        try { await job(); } catch (error) { console.error(`Auto-merge job ${jobId} failed:`, error); }
      });
      tails.set(key, run);
      void run.then(() => { if (tails.get(key) === run) tails.delete(key); });
      return run;
    },
  };
}
