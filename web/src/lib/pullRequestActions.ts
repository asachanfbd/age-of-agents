import type { PullRequestCheckout } from '../types';
import { prRowLabel, sortNewestFirst } from './pullRequests';
import type { PullRequest } from './pullRequests';
import type { TaskStatus, TerminalRuntimeStatus, WorkflowRunRecord } from './serverApi';

/**
 * Everything the PR tab decides about a row: what Check out and Merge show, what a click opens, how
 * a conflict-resolution run reads, and the state the store keeps per Project while actions are in
 * flight. Pure, so each decision has its own test; `PrPanel.tsx` only renders the result.
 */

export type MergeStateStatus = 'clean' | 'conflicts' | 'blocked' | 'unmergeable';

/** Mirrors server/src/projects/pullRequestMerge.ts's PullRequestMergeState. */
export interface PullRequestMergeState {
  number: number;
  title: string;
  status: MergeStateStatus;
  blockers: string[];
  /** Failing or running checks the base branch doesn't require; they never block the merge. */
  warnings?: string[];
  reason: string | null;
  headBranch: string;
  baseBranch: string;
  headBranchExists: boolean;
  isFork: boolean;
}

/** `GET …/pull-requests/:number/merge-state`; `mergeState` is null (with `error`) when the provider couldn't be read. */
export interface MergeStateResponse {
  number: number;
  checkedAt: string;
  mergeState: PullRequestMergeState | null;
  error?: string;
}

export interface MergeRequestOptions {
  confirmBlockers?: boolean;
  executorId?: string;
}

export interface MergedResult {
  outcome: 'merged';
  branchDeleted: boolean;
  branchWarning: string | null;
  branchNote: string | null;
}

/** `POST …/pull-requests/:number/merge`. */
export type MergeResponse =
  | MergedResult
  | { outcome: 'needs-confirmation'; blockers: string[] }
  | { outcome: 'resolving'; run: WorkflowRunRecord; existing: boolean };

/** One row's merge state as the store holds it. `key` is the PR's `updatedAt` it was read for, so an unchanged PR isn't read again on every poll. */
export interface MergeReading {
  key: string;
  loading: boolean;
  state: PullRequestMergeState | null;
  error: string | null;
}

export type RowBusy = 'merging' | 'checking-out';
export type RowRetry = 'merge' | 'checkout';

export interface RowError {
  message: string;
  retry: RowRetry;
}

export interface MergeNotice {
  tone: 'success' | 'warning';
  text: string;
}

/** The PR tab's action state for one Project. */
export interface PrActionState {
  mergeStates: Record<number, MergeReading>;
  busy: Record<number, RowBusy>;
  rowErrors: Record<number, RowError>;
  /** Rows as they were when their merge started, shown unchanged until it finishes — see `withHeldRows`. */
  held: Record<number, PullRequest>;
  notice: MergeNotice | null;
  returning: boolean;
  /** Why Return failed; `defaultBranch` is set when the previous branch is gone and that branch is offered instead. */
  returnError: { message: string; defaultBranch: string | null } | null;
}

export const EMPTY_PR_ACTIONS: PrActionState = {
  mergeStates: {}, busy: {}, rowErrors: {}, held: {}, notice: null, returning: false, returnError: null,
};

export function without<T>(record: Record<number, T>, number: number): Record<number, T> {
  const { [number]: _removed, ...rest } = record;
  return rest;
}

/** The pull requests whose merge state should be read now: new ones, ones that changed since their reading, and (with `force`, the Refresh button) all of them. Rows already loading are left alone. */
export function mergeStatesToLoad(pullRequests: Pick<PullRequest, 'number' | 'updatedAt'>[], readings: Record<number, MergeReading>, force: boolean): number[] {
  return pullRequests
    .filter((pr) => {
      const reading = readings[pr.number];
      if (reading?.loading) return false;
      return force || !reading || reading.key !== pr.updatedAt;
    })
    .map((pr) => pr.number);
}

/** A reading answered. An unreadable one holds no state, so the row offers Retry instead of a Merge it can't vouch for. */
export function applyMergeStateResponse(key: string, response: MergeStateResponse): MergeReading {
  if (!response.mergeState) return { key, loading: false, state: null, error: response.error ?? 'Could not read the merge state.' };
  return { key, loading: false, state: response.mergeState, error: null };
}

/**
 * The list to show: a poll that lands while a row's merge is in flight must not change or drop that
 * row, so each held row replaces (or restores) its entry. Once the merge finishes the hold is
 * released and the next response shows as it is.
 */
export function withHeldRows(pullRequests: PullRequest[], held: Record<number, PullRequest>): PullRequest[] {
  const heldRows = Object.values(held);
  if (heldRows.length === 0) return pullRequests;
  const heldNumbers = new Set(heldRows.map((pr) => pr.number));
  return sortNewestFirst([...pullRequests.filter((pr) => !heldNumbers.has(pr.number)), ...heldRows]);
}

// ---- Conflict-resolution run status ----

export type RunPhase = 'starting' | 'resolving' | 'waiting' | 'merging' | 'merged' | 'resolved' | 'failed' | 'stopped';

type ConflictRun = Pick<WorkflowRunRecord, 'id' | 'status' | 'executorId' | 'attentionReason' | 'createdAt' | 'prConflict'>;

/** A row's run: the newest conflict-resolution run for that PR number, so a fresh run wins over an older failed one. */
export function conflictRunFor<T extends Pick<WorkflowRunRecord, 'createdAt' | 'prConflict'>>(runs: T[], number: number): T | null {
  return runs.reduce<T | null>((newest, run) => {
    if (run.prConflict?.number !== number) return newest;
    return !newest || run.createdAt > newest.createdAt ? run : newest;
  }, null);
}

type RunSession = { status: TaskStatus; runtimeStatus?: TerminalRuntimeStatus } | null;

/** Where the run is, from its record and its step's CLI session (`session`: the run's latest Task, when the store has it). */
export function runPhase(run: Pick<WorkflowRunRecord, 'status' | 'prConflict'>, session: RunSession = null): RunPhase {
  switch (run.status) {
    case 'starting': return 'starting';
    case 'running': return session?.runtimeStatus === 'starting' || !session ? 'starting' : 'resolving';
    case 'completing': return 'merging';
    case 'completed': return run.prConflict?.outcome === 'merged' ? 'merged' : 'resolved';
    case 'stopped': return 'stopped';
    case 'failed': return 'failed';
    // A question from a session that is still alive is a pause; anything else that needs attention is a failure.
    default: return session?.status === 'developing' || session?.status === 'blocked' ? 'waiting' : 'failed';
  }
}

export const isActivePhase = (phase: RunPhase) => phase === 'starting' || phase === 'resolving' || phase === 'waiting' || phase === 'merging';

const PHASE_LABELS: Record<RunPhase, string> = {
  starting: 'Starting',
  resolving: 'Resolving conflicts',
  waiting: 'Waiting for your answer',
  merging: 'Resolved, merging',
  merged: 'Merged',
  resolved: 'Conflicts resolved',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** "Resolving conflicts · Claude (work)": the phase, then the agent doing it when its name is known. */
export function runStatusLabel(phase: RunPhase, agentLabel: string | null): string {
  return agentLabel ? `${PHASE_LABELS[phase]} · ${agentLabel}` : PHASE_LABELS[phase];
}

// ---- Row model ----

export const CONFLICT_NOTE = 'This PR conflicts with its base';

export type MergeControl =
  /** `opens`: what a click does — merge at once, the "merge anyway" confirmation, or the agent dialog. */
  | { kind: 'button'; label: 'Merge' | 'Retry'; opens: 'merge' | 'confirm' | 'agent' }
  | { kind: 'loading' }
  | { kind: 'merging' }
  /** A run is working on this PR: its status shows instead, and a click does nothing. */
  | { kind: 'run' }
  /** Not rendered at all; `reason` takes its place when the PR can't be merged. */
  | { kind: 'hidden'; reason: string | null };

export type CheckoutControl =
  | { kind: 'button'; disabled: boolean; pending: boolean; reason: string | null }
  /**
   * `returnBranch` is set only when the previous branch is gone and Return goes to the offered
   * default branch instead; `returnError` is why the last Return was refused.
   */
  | { kind: 'checked-out'; returnLabel: string; returnBranch?: string; returnError: string | null };

export interface RowNote {
  tone: 'muted' | 'warning' | 'error';
  text: string;
}

export interface RowRunStatus {
  runId: string;
  phase: RunPhase;
  label: string;
  /** Why it failed or stopped; null while it works or once it succeeded. */
  reason: string | null;
}

export interface PrRowModel {
  checkout: CheckoutControl;
  merge: MergeControl;
  badges: string[];
  notes: RowNote[];
  run: RowRunStatus | null;
  /** A failed action or an unreadable merge state, with what Retry repeats. */
  error: { message: string; retry: RowRetry | 'merge-state' } | null;
}

export interface PrRowInput {
  pr: Pick<PullRequest, 'number'>;
  reading: MergeReading | undefined;
  run: ConflictRun | null;
  runSession?: RunSession;
  agentLabel?: string | null;
  checkout: PullRequestCheckout | null | undefined;
  /** The branch the Project's folder is on, as last read. */
  currentBranch: string | null;
  busy: RowBusy | undefined;
  rowError: RowError | undefined;
  /** Why the Project's last Return was refused, if it was — shown on the checked-out row. */
  returnError?: PrActionState['returnError'];
}

/** Checked out means this PR's number and the branch it was checked out as are both current — never the branch name alone, which two PRs can share. */
export function isCheckedOut(pr: Pick<PullRequest, 'number'>, checkout: PullRequestCheckout | null | undefined, currentBranch: string | null): boolean {
  return !!checkout && checkout.number === pr.number && checkout.branch === currentBranch;
}

export const returnLabel = (branch: string) => `Return to ${branch}`;

function checkoutControl(input: PrRowInput): CheckoutControl {
  if (isCheckedOut(input.pr, input.checkout, input.currentBranch)) {
    // The row and the branch menu offer the same Return, including the default branch when the previous one is gone.
    const item = returnMenuItem(input.checkout, input.currentBranch, input.returnError)!;
    return { kind: 'checked-out', returnLabel: item.label, ...(item.branch ? { returnBranch: item.branch } : {}), returnError: item.explanation };
  }
  const headGone = input.reading?.state?.headBranchExists === false;
  return {
    kind: 'button',
    disabled: headGone || input.busy !== undefined,
    pending: input.busy === 'checking-out',
    reason: headGone ? 'The head branch no longer exists' : null,
  };
}

function runStatus(input: PrRowInput): RowRunStatus | null {
  if (!input.run) return null;
  const phase = runPhase(input.run, input.runSession ?? null);
  const settledBadly = phase === 'failed' || phase === 'stopped';
  return {
    runId: input.run.id,
    phase,
    label: runStatusLabel(phase, input.agentLabel ?? null),
    reason: phase === 'failed' ? input.run.attentionReason ?? input.run.prConflict?.detail ?? 'The run did not finish.'
      : settledBadly ? 'The run was stopped before it finished. Nothing was merged.' : null,
  };
}

function mergeControl(input: PrRowInput, run: RowRunStatus | null): MergeControl {
  if (input.busy === 'merging') return { kind: 'merging' };
  if (run && isActivePhase(run.phase)) return { kind: 'run' };
  const state = input.reading?.state;
  if (!state) return input.reading && !input.reading.loading ? { kind: 'hidden', reason: null } : { kind: 'loading' };
  if (state.status === 'unmergeable') return { kind: 'hidden', reason: state.reason };
  if (state.status === 'conflicts') {
    const retry = run?.phase === 'failed' || run?.phase === 'stopped';
    return { kind: 'button', label: retry ? 'Retry' : 'Merge', opens: 'agent' };
  }
  return { kind: 'button', label: 'Merge', opens: state.status === 'blocked' ? 'confirm' : 'merge' };
}

function rowNotes(input: PrRowInput, run: RowRunStatus | null): RowNote[] {
  const state = input.reading?.state;
  if (!state || state.status === 'unmergeable') return [];
  return [
    ...(state.status === 'conflicts' && !(run && isActivePhase(run.phase)) ? [{ tone: 'warning' as const, text: CONFLICT_NOTE }] : []),
    ...(state.blockers.length > 0 ? [{ tone: 'warning' as const, text: state.blockers.join(' · ') }] : []),
    ...(state.warnings ?? []).map((text) => ({ tone: 'warning' as const, text })),
  ];
}

export function prRowModel(input: PrRowInput): PrRowModel {
  const run = runStatus(input);
  const state = input.reading?.state;
  const unreadable = input.reading && !input.reading.loading && input.reading.error ? { message: input.reading.error, retry: 'merge-state' as const } : null;
  return {
    checkout: checkoutControl(input),
    merge: mergeControl(input, run),
    // The run cleared the conflicts but left blockers for the person to confirm: say so until the PR is merged.
    badges: run?.phase === 'resolved' && state && state.status !== 'conflicts' ? ['Conflicts resolved'] : [],
    notes: rowNotes(input, run),
    run,
    error: input.rowError ?? unreadable,
  };
}

/** What a Merge click opens: nothing while it is merging, loading, hidden or a run is already working on the PR. */
export function mergeClickTarget(model: Pick<PrRowModel, 'merge'>): 'merge' | 'confirm' | 'agent' | 'none' {
  return model.merge.kind === 'button' ? model.merge.opens : 'none';
}

// ---- Dialogs and notices ----

export interface MergeConfirmation {
  title: string;
  description: string;
  blockers: string[];
  confirmLabel: 'Merge anyway';
}

export function mergeConfirmation(pr: Pick<PullRequest, 'number' | 'title'>, blockers: string[]): MergeConfirmation {
  return {
    title: `Merge ${prRowLabel(pr)}?`,
    description: blockers.length === 1 ? 'This pull request has a problem. You can merge it anyway.' : 'This pull request has problems. You can merge it anyway.',
    blockers,
    confirmLabel: 'Merge anyway',
  };
}

/** The merge request a dialog's decision makes: the confirmation flag on "Merge anyway", the chosen agent on Start. Cancel makes none, so it has no entry here. */
export function mergeRequestFor(decision: { kind: 'confirm' } | { kind: 'agent'; executorId: string }): MergeRequestOptions {
  return decision.kind === 'confirm' ? { confirmBlockers: true } : { executorId: decision.executorId };
}

/** The strip above the list after a merge: a warning (never an error) when the branch could not be deleted. */
export function mergeNotice(pr: Pick<PullRequest, 'number' | 'title' | 'headBranch'>, result: Pick<MergedResult, 'branchDeleted' | 'branchWarning' | 'branchNote'>): MergeNotice {
  const merged = `Merged ${prRowLabel(pr)}.`;
  if (result.branchWarning) return { tone: 'warning', text: `${merged} ${result.branchWarning}` };
  if (result.branchDeleted) return { tone: 'success', text: `${merged} The branch "${pr.headBranch}" was deleted.` };
  return { tone: 'success', text: result.branchNote ? `${merged} ${result.branchNote}` : merged };
}

// ---- Branch menu ----

export interface ReturnMenuItem {
  label: string;
  /** Undefined returns to the remembered branch; set when the offered default branch is the target. */
  branch?: string;
  /** Why the remembered branch can't be returned to, shown beside the offer. */
  explanation: string | null;
}

/**
 * The branch menu's first item while a PR checkout is remembered and still current — including
 * after that PR was merged and its row left the list. Absent otherwise. When Return failed because
 * the previous branch is gone, it offers the default branch instead.
 */
export function returnMenuItem(
  checkout: PullRequestCheckout | null | undefined,
  currentBranch: string | null,
  returnError: PrActionState['returnError'] = null,
): ReturnMenuItem | null {
  if (!checkout || checkout.branch !== currentBranch) return null;
  if (returnError?.defaultBranch) return { label: returnLabel(returnError.defaultBranch), branch: returnError.defaultBranch, explanation: returnError.message };
  return { label: returnLabel(checkout.previousBranch), explanation: returnError?.message ?? null };
}
