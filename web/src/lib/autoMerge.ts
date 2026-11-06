import type { AutoMergeData, AutoMergeState, PlanItemData } from '../types';

/**
 * What a task's Auto-merge looks like: the header switch, the status panel under it, the board
 * card's chip and the PR tab's tag. Pure, so the wording and the rules live in one place; the
 * daemon owns the states themselves (server/src/projects/autoMergeService.ts).
 */

export type AutoMergeTone = 'info' | 'warn' | 'ok' | 'bad';

interface StateView { title: string; chip: string; tone: AutoMergeTone; live: boolean }

const STATE_VIEWS: Record<AutoMergeState, StateView> = {
  waiting: { title: 'Auto-merge on, waiting for the task to complete', chip: 'Auto-merge on', tone: 'info', live: false },
  merging: { title: 'Merging', chip: 'Merging', tone: 'info', live: true },
  resolving: { title: 'Resolving conflicts', chip: 'Resolving conflicts', tone: 'info', live: true },
  blocked: { title: 'Awaiting merge: blocked', chip: 'Merge blocked', tone: 'warn', live: false },
  provider: { title: 'Awaiting merge: can\'t reach the provider', chip: 'Provider unreachable', tone: 'warn', live: false },
  agent: { title: 'Awaiting merge: agent unavailable', chip: 'Agent unavailable', tone: 'warn', live: false },
  merged: { title: 'Merged', chip: 'Merged', tone: 'ok', live: false },
  failed: { title: 'Auto-merge failed', chip: 'Auto-merge failed', tone: 'bad', live: false },
  'no-pr': { title: 'No PR to merge', chip: 'No PR to merge', tone: 'bad', live: false },
  'cannot-merge': { title: 'Can\'t be merged', chip: 'Can\'t be merged', tone: 'bad', live: false },
};

/** Auto-merge applies to a task of the project's own workflow, not to a conflict run or a testing setup. */
export const hasAutoMerge = (item: PlanItemData | undefined): item is PlanItemData => !!item && !item.prConflict && !item.testingSetup;

export type HoldableItem = Pick<PlanItemData, 'status' | 'autoMerge' | 'pullRequest' | 'workflowRunId' | 'prConflict' | 'testingSetup'>;

/**
 * Where a finished task with Auto-merge on sits until its pull request is merged. `awaiting-merge`:
 * the PR is open or being merged (the board's "PR not merged yet" row). `needs-you`: auto-merge gave up
 * and the person must act (the upper Needs you row). Null: nothing holds the task back from Completed.
 * A task without Auto-merge is held (`awaiting-merge`) only while the provider says its own pull request is open.
 */
export type AutoMergeHold = 'awaiting-merge' | 'needs-you';

const AWAITING_MERGE_STATES: ReadonlySet<AutoMergeState> = new Set(['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent']);
const NEEDS_YOU_STATES: ReadonlySet<AutoMergeState> = new Set(['failed', 'cannot-merge', 'no-pr']);

/** The hold for an auto-merge state alone; null once merged or while the toggle is off. */
export function autoMergeHoldOf(autoMerge: AutoMergeData | undefined): AutoMergeHold | null {
  if (!autoMerge?.enabled) return null;
  if (AWAITING_MERGE_STATES.has(autoMerge.state)) return 'awaiting-merge';
  return NEEDS_YOU_STATES.has(autoMerge.state) ? 'needs-you' : null;
}

/**
 * The hold on a task that the daemon has already finished (its run completed, which is when its PR is
 * raised): with Auto-merge on it is Completed only once the PR is merged (the daemon's auto-merge state
 * decides); with it off, once the last reading of the PR no longer says open. Only a task with its own run
 * has a PR, so a hand-completed task is never held. A failed reading leaves the stored one in place.
 */
export function completedAutoMergeHold(item: HoldableItem | undefined, run: { status: string } | null | undefined): AutoMergeHold | null {
  if (!item || item.prConflict || item.testingSetup || !item.workflowRunId) return null;
  const finished = item.status === 'done' || run?.status === 'completed';
  if (!finished) return null;
  if (item.autoMerge?.enabled) return autoMergeHoldOf(item.autoMerge);
  return item.pullRequest?.state === 'open' ? 'awaiting-merge' : null;
}

export const AUTO_MERGE_STATES = Object.keys(STATE_VIEWS) as AutoMergeState[];

export const AUTO_MERGE_RULE_TEXT = 'Conflicts are resolved by the Development step\'s agent, else the first step that edits code, else the task\'s own agent. Other blockers are never overridden: fix the cause, or merge from the PR tab.';
const BLOCKED_FALLBACK = 'The pull request can\'t be merged yet.';
const CHIP_TOOLTIP_LIMIT = 160;

export interface AutoMergeToggleView {
  checked: boolean;
  disabled: boolean;
  /** Why the switch is unavailable (shown as its tooltip and as a line under the header), or null. */
  reason: string | null;
  tooltip: string;
}

/** The header switch: unavailable, with the reason, for a project with no linked repository or a run without its own branch. */
export function autoMergeToggle(input: { repositoryUrl: string | null | undefined; run: { branch?: string; baseBranch?: string } | null; autoMerge: AutoMergeData | undefined }): AutoMergeToggleView {
  const checked = input.autoMerge?.enabled === true;
  const reason = !input.repositoryUrl ? 'This project has no linked repository, so its tasks never raise a pull request.'
    : input.run && !(input.run.branch && input.run.baseBranch) ? 'This run works on the project\'s own branch, so it has no pull request of its own to merge.'
      : null;
  return { checked, disabled: reason !== null && !checked, reason, tooltip: reason ?? 'Merge this task\'s pull request automatically once the task completes' };
}

export type AutoMergeAction = 'retry' | 'open-pr-tab';

export interface AutoMergePanelView {
  state: AutoMergeState;
  title: string;
  tone: AutoMergeTone;
  /** The reasons behind a blocked, unreachable, unavailable or failed state. */
  reasons: string[];
  /** Non-blocking: optional checks failing or running. Shown in every state, never changes the tone. */
  warnings: string[];
  actions: AutoMergeAction[];
  /** The conflict-resolution run to link to, while resolving or after it failed. */
  runId: string | null;
  /** Said only while resolving: switching the toggle off does not stop the run. */
  note: string | null;
  /** The merge time and what became of the remote branch, once merged. */
  merged: { when: string; branch: string } | null;
}

/** The status panel under the header; null while the toggle is off. */
export function autoMergePanel(autoMerge: AutoMergeData | undefined, now: number): AutoMergePanelView | null {
  if (!autoMerge?.enabled) return null;
  const { state } = autoMerge;
  const view = STATE_VIEWS[state];
  const reasons = state === 'blocked' && autoMerge.reasons.length === 0 ? [BLOCKED_FALLBACK] : autoMerge.reasons;
  const actions: AutoMergeAction[] = [
    ...(state === 'failed' || state === 'agent' ? ['retry' as const] : []),
    ...(state === 'blocked' || state === 'agent' || state === 'cannot-merge' ? ['open-pr-tab' as const] : []),
  ];
  return {
    state,
    title: view.title,
    tone: view.tone,
    reasons,
    warnings: autoMerge.warnings ?? [],
    actions,
    runId: (state === 'resolving' || state === 'failed') ? autoMerge.runId : null,
    note: state === 'resolving' ? 'Switching Auto-merge off keeps this run going, but nothing is merged afterwards. You can merge from the PR tab.' : null,
    merged: state === 'merged' ? { when: mergedTimeText(autoMerge.mergedAt, now), branch: branchOutcomeText(autoMerge) } : null,
  };
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; empty for a missing or unreadable time. Never throws. */
export function mergedTimeText(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (60 * 24))} d ago`;
}

/** What the merge did to the remote head branch, in the merge result's own words when it had any. */
export function branchOutcomeText(autoMerge: Pick<AutoMergeData, 'branchWarning' | 'branchNote'>): string {
  return autoMerge.branchWarning ?? autoMerge.branchNote ?? 'The remote branch was deleted.';
}

/** `live` marks a state the daemon is working on right now; the chip shows a still dot (the UI never loops an animation). */
export interface AutoMergeChipView { label: string; tone: AutoMergeTone; live: boolean; title: string }

/** The board card's small status near the completion state; null while the toggle is off. */
export function autoMergeChip(autoMerge: AutoMergeData | undefined): AutoMergeChipView | null {
  if (!autoMerge?.enabled) return null;
  const view = STATE_VIEWS[autoMerge.state];
  const reason = autoMerge.reasons.join('; ');
  const title = reason ? `${view.title}: ${reason}` : view.title;
  return { label: view.chip, tone: view.tone, live: view.live, title: title.length > CHIP_TOOLTIP_LIMIT ? `${title.slice(0, CHIP_TOOLTIP_LIMIT - 1)}…` : title };
}

const TAG_TITLE_LIMIT = 40;
const TAG_VERBS: Record<AutoMergeState, string> = {
  waiting: 'Auto-merge on for task',
  merging: 'Being auto-merged by task',
  resolving: 'Resolving conflicts for task',
  blocked: 'Auto-merge blocked for task',
  provider: 'Auto-merge waiting on the provider for task',
  agent: 'Auto-merge waiting for an agent for task',
  merged: 'Auto-merged by task',
  failed: 'Auto-merge failed for task',
  'no-pr': 'Auto-merge for task',
  'cannot-merge': 'Auto-merge stopped for task',
};

const shortTitle = (title: string): string => (title.length > TAG_TITLE_LIMIT ? `${title.slice(0, TAG_TITLE_LIMIT - 1)}…` : title);

export interface PrRowTag { text: string; tone: AutoMergeTone; itemId: string }

/**
 * The PR tab row's tag for a pull request a task owns: one it is merging automatically, or (Auto-merge
 * off) one the daemon read as the task's own open pull request, which the task waits on. Null when no task owns it.
 */
export function prRowAutoMergeTag(items: readonly Pick<PlanItemData, 'id' | 'title' | 'autoMerge' | 'pullRequest'>[], prNumber: number): PrRowTag | null {
  const owner = items.find((item) => item.autoMerge?.enabled && item.autoMerge.prNumber === prNumber);
  if (!owner?.autoMerge) {
    const waiting = items.find((item) => !item.autoMerge?.enabled && item.pullRequest?.state === 'open' && item.pullRequest.prNumber === prNumber);
    return waiting ? { text: `Waiting to be merged for task "${shortTitle(waiting.title)}"`, tone: 'info', itemId: waiting.id } : null;
  }
  const title = shortTitle(owner.title);
  return { text: `${TAG_VERBS[owner.autoMerge.state]} "${title}"`, tone: STATE_VIEWS[owner.autoMerge.state].tone, itemId: owner.id };
}

/** Tailwind classes per tone, shared by the chip, the panel and the PR tag. */
export const AUTO_MERGE_TONE_CLASSES: Record<AutoMergeTone, string> = {
  info: 'border-info/40 bg-info/10 text-info-foreground',
  warn: 'border-warning/50 bg-warning/10 text-warning-foreground',
  ok: 'border-success/40 bg-success/10 text-success-foreground',
  bad: 'border-destructive/50 bg-destructive/10 text-destructive',
};
