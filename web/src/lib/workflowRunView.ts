import { formatCompactDuration, formatRelativeTime } from './sessionTiming';
import { startupView } from './runStartup';
import type { EarlierStepRun, StepProgressItem, StepRunRecord, WorkflowRunDetail, WorkflowRunRecord, WorkflowRunStatus, WorkflowStep } from './serverApi';

/**
 * One row of the run detail view's full Stepper: one per configured `detail.steps[]` entry, with its
 * whole round history so far, then a synthetic Complete (never a `WorkflowStep` of its own).
 */
export interface RunStage {
  /** A `WorkflowStep.id` / `'complete'` — stable across renders, used as the selection key. */
  id: string;
  name: string;
  kind: 'step' | 'complete';
  /** Set only for `kind: 'step'`. */
  step?: WorkflowStep;
  /** Every `StepRunRecord` this step has had so far, in order — empty for Complete. */
  rounds: StepRunRecord[];
  /** Set only on a reopened bug's run: the step's rounds from its earlier runs, oldest first, shown read-only before `rounds`. */
  earlierRounds?: EarlierStepRun[];
}

const COMPLETE_STAGE_ID = 'complete';

/** The Stepper's full stage list, in order — see `RunStage`'s doc comment. */
export function buildRunStages(detail: Pick<WorkflowRunDetail, 'steps'>): RunStage[] {
  return [
    ...detail.steps.map(({ step, rounds, earlierRounds }): RunStage => ({ id: step.id, name: step.name, kind: 'step', step, rounds, ...(earlierRounds?.length ? { earlierRounds } : {}) })),
    { id: COMPLETE_STAGE_ID, name: 'Complete', kind: 'complete', rounds: [] },
  ];
}

/**
 * The index of the stage the run is on: the step matching `run.currentStepId`; otherwise — the id is
 * null both before the first step starts and once every step is past, or stale after a Catalog edit —
 * the first stage when the run failed (the likeliest way to fail before any step starts), else Complete.
 */
function currentStageIndex(stages: RunStage[], run: Pick<WorkflowRunRecord, 'currentStepId' | 'status'>): number {
  const stepIndex = run.currentStepId ? stages.findIndex((stage) => stage.kind === 'step' && stage.step?.id === run.currentStepId) : -1;
  if (stepIndex >= 0) return stepIndex;
  return run.status === 'failed' ? 0 : stages.length - 1;
}

/** Which stage the run detail view opens on — the one the run is on (see `currentStageIndex`). */
export function defaultSelectedStageId(detail: Pick<WorkflowRunDetail, 'steps' | 'run'>): string {
  const stages = buildRunStages(detail);
  return stages[currentStageIndex(stages, detail.run)]!.id;
}

export type StageState = 'done' | 'current' | 'pending' | 'skipped';

/**
 * A done/current/pending reading for every stage in `stages`, from the run's summary fields, except
 * that a step whose latest round was skipped reads 'skipped' wherever it sits — whether it was left
 * out when the task was started or the agent skipped it.
 */
export function stageStates(stages: RunStage[], run: Pick<WorkflowRunRecord, 'currentStepId' | 'status'>): StageState[] {
  const currentIndex = currentStageIndex(stages, run);
  return stages.map((stage, index) => {
    if (index === currentIndex) return 'current';
    if (stage.rounds.at(-1)?.status === 'skipped') return 'skipped';
    return index < currentIndex ? 'done' : 'pending';
  });
}

/**
 * The Stepper's "Round n/N" badge for a step stage with more than one round — n and N are both just
 * how many rounds this step has had so far (the most recent one is always what's shown by default; see
 * `defaultRoundIndex`), since `loopBack.maxRounds` is a cap on rounds, never a fixed count to divide by.
 * Null for a step on its first round, and always null for Complete (empty `rounds`).
 */
export function stageRoundBadge(rounds: StepRunRecord[], roundOffset = 0): string | null {
  if (roundOffset > 0 && rounds.length > 0) return `Round ${roundOffset + rounds.length}`;
  return rounds.length > 1 ? `Round ${rounds.length}/${rounds.length}` : null;
}

/** One entry of a step's round list: the round, the number it is shown as and whether it belongs to an earlier run (read-only). */
export interface RoundEntry {
  round: StepRunRecord;
  label: string;
  earlier: boolean;
}

/** A step's round list: rounds from the bug's earlier runs first, then this run's, numbered after them. */
export function roundEntries(stage: Pick<RunStage, 'rounds' | 'earlierRounds'>, roundOffset: number): RoundEntry[] {
  return [
    ...(stage.earlierRounds ?? []).map((round): RoundEntry => ({ round, label: `Round ${round.displayRound}`, earlier: true })),
    ...stage.rounds.map((round, index): RoundEntry => ({ round, label: `Round ${roundOffset + index + 1}`, earlier: false })),
  ];
}

/**
 * The rounds a step had in the bug's earlier runs. A run that re-runs a completed bug after a
 * regression numbers its first round of each step after those, so attempt 2 reads "Round 2".
 */
export const stepRoundOffset = (run: Pick<WorkflowRunRecord, 'regression'>, stepId: string): number => run.regression?.roundOffsets[stepId] ?? 0;

/**
 * Time spent on a stage, in ms, summed over every round: each round's `completedAt` (or `now` while
 * it is still running) minus its `createdAt`. A settled round with no `completedAt` adds nothing
 * rather than growing forever.
 */
export function stageSpentMs(rounds: Pick<StepRunRecord, 'status' | 'createdAt' | 'completedAt'>[], now: number): number {
  return rounds.reduce((sum, round) => {
    const end = round.completedAt ? new Date(round.completedAt).getTime() : round.status === 'running' ? now : null;
    return end === null ? sum : sum + Math.max(0, end - new Date(round.createdAt).getTime());
  }, 0);
}

/** Run statuses where nothing is actively working — see `liveOrFrozenNow`. */
const FROZEN_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['awaiting-approval', 'needs-attention', 'stopped', 'failed']);

/**
 * The "now" a step's live timer measures against: the real current time while the run is actively
 * working, or the instant it stopped (`run.updatedAt`, stamped by every transition into one of
 * `FROZEN_RUN_STATUSES`) once it isn't — so the timer freezes the moment a run starts waiting on a
 * person instead of its agent (task 5.003), rather than keep counting time spent waiting. Has no
 * effect on an already-settled round (its own `completedAt` already fixes its span, regardless of
 * `now`) — only a round still genuinely mid-session (no `completedAt` yet, e.g. an open question
 * mid-round) is ever affected.
 */
function liveOrFrozenNow(run: Pick<WorkflowRunRecord, 'status' | 'updatedAt'>, now: number): number {
  return FROZEN_RUN_STATUSES.has(run.status) ? new Date(run.updatedAt).getTime() : now;
}

/**
 * The Stepper's muted time suffix ("45s", "2m 10s", "1h 5m") for a step stage that has had a round:
 * fixed once the stage is `done`, and — the live timer (task 5.003) — ticking while it's `current`,
 * summed the same way (`stageSpentMs`) across every round so a step's second round continues the
 * first's total instead of restarting at zero. Null for `pending`/`skipped`, and always null for
 * Complete (deliberately excluded from timing).
 */
export function stageTimeLabel(stage: RunStage, state: StageState, run: Pick<WorkflowRunRecord, 'status' | 'updatedAt'>, now: number): string | null {
  if ((state !== 'done' && state !== 'current') || stage.kind !== 'step' || stage.rounds.length === 0) return null;
  return formatCompactDuration(stageSpentMs(stage.rounds, liveOrFrozenNow(run, now)), { seconds: true });
}

/** Whether a round has anything for its Summary column: a verdict, skip reason, summary or approval. */
export function hasRoundSummary(round: Pick<StepRunRecord, 'verdict' | 'skippedReason' | 'summary' | 'approval'>): boolean {
  return !!(round.verdict || round.skippedReason || round.summary || round.approval);
}

/**
 * Whether a round's skip reason needs its own line in the Summary column. Skipping a step also
 * records the reason in the summary ("Skipped: <reason>"), so the line shows only when the summary
 * doesn't already carry it — e.g. a step unchecked at task start with no summary.
 */
export function showsSkipReasonLine(round: Pick<StepRunRecord, 'skippedReason' | 'summary'>): boolean {
  return !!round.skippedReason && !round.summary?.includes(round.skippedReason);
}

/**
 * Which columns a round's Summary mode shows. Both side by side when it has both; otherwise the one
 * it has takes the full width, and a round with neither still shows Summary (as "No summary yet").
 */
export function roundPanes(round: Pick<StepRunRecord, 'verdict' | 'skippedReason' | 'summary' | 'approval' | 'outputs'>): { summary: boolean; output: boolean } {
  const output = round.outputs.length > 0;
  return { summary: hasRoundSummary(round) || !output, output };
}

/** The round a stage's detail opens on: the requested round number when the stage has it, else its latest, or 0 for a stage with no rounds yet. */
export function defaultRoundIndex(rounds: Pick<StepRunRecord, 'round'>[], requestedRound: number | null = null): number {
  const requested = requestedRound === null ? -1 : rounds.findIndex((round) => round.round === requestedRound);
  return requested === -1 ? Math.max(0, rounds.length - 1) : requested;
}

/**
 * Which view a round's detail would open on for its current data (task 5.017, Part 2). A finished
 * round with neither summary content nor a session (a step skipped at start) falls back to 'summary',
 * same as today's "Not started yet."/skip-reason view. `roundStartMode` turns this into the shown mode
 * and `followRoundMode` re-applies it whenever the round's status changes while it is open.
 */
export type InitialRoundMode = 'split' | 'summary' | 'session';

export function initialRoundMode(round: Pick<StepRunRecord, 'status' | 'verdict' | 'skippedReason' | 'summary' | 'approval' | 'outputs' | 'taskId'>): InitialRoundMode {
  if (round.status === 'running') return 'split';
  if (hasRoundSummary(round) || round.outputs.length > 0) return 'summary';
  return round.taskId ? 'session' : 'summary';
}

/** The modes a round's detail can show: Summary, Session (bare or as the progress split), or the step's Quick look view. */
export type RoundViewMode = 'summary' | 'session' | 'quickLook';

type RoundModeFields = Pick<StepRunRecord, 'status' | 'verdict' | 'skippedReason' | 'summary' | 'approval' | 'outputs' | 'taskId'>;

/** The mode a round's detail shows for its current data: an earlier run's round is always Summary; otherwise `initialRoundMode`, with its split shown as Session. */
export function roundStartMode(round: RoundModeFields, earlier: boolean): 'summary' | 'session' {
  return earlier || initialRoundMode(round) === 'summary' ? 'summary' : 'session';
}

/**
 * The mode an open round's detail moves to after a live update. When the round's status changed
 * (e.g. running → awaiting-approval or done) and the owner hasn't picked a mode for this round, it
 * moves to `roundStartMode` for the new data, the same view a reopen would show. Otherwise it keeps
 * `current`. Never chooses Quick look: that view opens only from the owner's toggle.
 */
export function followRoundMode({ prevStatus, round, earlier, current, manual }: {
  prevStatus: StepRunRecord['status'];
  round: RoundModeFields;
  earlier: boolean;
  current: RoundViewMode;
  manual: boolean;
}): RoundViewMode {
  if (manual || prevStatus === round.status) return current;
  return roundStartMode(round, earlier);
}

/**
 * The round a stage's open detail selects after its round list changes: the latest round when a
 * round was added and the owner hasn't pinned another one, else the current selection. Counts and
 * indexes include an earlier run's rounds (`roundEntries`).
 */
export function followRoundIndex({ prevCount, nextCount, index, manual }: { prevCount: number; nextCount: number; index: number; manual: boolean }): number {
  return !manual && nextCount > prevCount ? nextCount - 1 : index;
}

/** What a stepper click stores as the selected stage: `null` (follow the run) for the run's current stage, otherwise the clicked stage, pinned. */
export function stageSelectionFor(clickedId: string, currentId: string): string | null {
  return clickedId === currentId ? null : clickedId;
}

/** Whether a round has anything worth showing in the progress panel/disclosure — a checklist item, a current-activity line, or an estimate. False for `progress` absent/null (the split's pre-first-report placeholder, and the finished view's missing Progress section). */
export function hasProgress(round: Pick<StepRunRecord, 'progress'>): boolean {
  const progress = round.progress;
  return !!progress && (progress.checklist.length > 0 || !!progress.currentActivity || !!progress.estimate);
}

export interface ChecklistCounts {
  /** Every checklist item, skipped ones included. */
  total: number;
  /** Items marked 'done' — never includes a 'skipped' item. */
  done: number;
  skipped: number;
}

/** "N of M done [· K skipped]" counts for a checklist — `total` includes skipped items, `done` never does. Safe on an empty checklist (0 of 0). */
export function checklistCounts(checklist: StepProgressItem[]): ChecklistCounts {
  return {
    total: checklist.length,
    done: checklist.filter((item) => item.state === 'done').length,
    skipped: checklist.filter((item) => item.state === 'skipped').length,
  };
}

/** The progress bar's fill, 0–100 — 0 for an empty checklist rather than dividing by zero. */
export function checklistPercent(counts: Pick<ChecklistCounts, 'done' | 'total'>): number {
  return counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);
}

/** "estimated 2m ago"-style staleness for a reported time estimate, so a stale one is obvious — null when the agent never gave one (`estimatedAt` is null right along with `estimate`). */
export function estimateStalenessLabel(estimatedAt: string | null, now: Date = new Date()): string | null {
  return estimatedAt ? `estimated ${formatRelativeTime(estimatedAt, now)}` : null;
}

export type RunStatusVariant = 'secondary' | 'success' | 'warning' | 'soft-destructive';

const RUN_STATUS_PRESENTATION: Record<WorkflowRunStatus, { label: string; variant: RunStatusVariant }> = {
  starting: { label: 'Starting', variant: 'secondary' },
  running: { label: 'Running', variant: 'success' },
  held: { label: 'Waiting', variant: 'secondary' },
  'awaiting-approval': { label: 'Awaiting approval', variant: 'warning' },
  'needs-attention': { label: 'Needs attention', variant: 'warning' },
  completing: { label: 'Completing', variant: 'success' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'soft-destructive' },
  stopped: { label: 'Stopped', variant: 'secondary' },
};

/** The header status badge's text and color — same soft-tint variant vocabulary as `AttentionTag`. */
export function runStatusBadge(status: WorkflowRunStatus): { label: string; variant: RunStatusVariant } {
  return RUN_STATUS_PRESENTATION[status];
}

/** A Reject needs a reason: blank or whitespace-only text can't be submitted. */
export function isRejectReasonValid(reason: string): boolean {
  return reason.trim() !== '';
}

/** Whether a saved rejection reason counts as a draft: blank text is no draft, so the bar opens collapsed. */
export function hasRejectDraft(draft: string): boolean {
  return isRejectReasonValid(draft);
}

/** Whether "Send rejection" can be pressed: a non-blank reason, and no decision already in flight. */
export function canSendRejection(reason: string, sending: boolean): boolean {
  return !sending && isRejectReasonValid(reason);
}

/** A saved rejection reason only makes sense while the run is waiting for approval; any other status makes it stale. */
export function isRejectDraftStale(status: WorkflowRunStatus): boolean {
  return status !== 'awaiting-approval';
}

export interface RejectKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

/**
 * What a key press in the rejection textarea does: Ctrl/Cmd+Enter sends (when allowed), Escape
 * collapses the textarea; plain Enter, Shift+Enter and IME composition are left to type text, and
 * nothing happens while a send is in flight.
 */
export function rejectKeyAction(event: RejectKeyEvent, state: { reason: string; sending: boolean }): 'send' | 'collapse' | null {
  if (state.sending || event.isComposing) return null;
  if (event.key === 'Escape') return 'collapse';
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) return canSendRejection(state.reason, false) ? 'send' : null;
  return null;
}

/** The store actions an approval decision goes through (`approveWorkflowRun`/`requestChangesWorkflowRun`). */
export interface ApprovalCalls {
  approve: (runId: string) => Promise<boolean>;
  requestChanges: (runId: string, comment: string) => Promise<boolean>;
}

/** Approve (`rejectReason` null) with no comment, or request changes with the trimmed reason as the comment. */
export function sendApprovalDecision(runId: string, rejectReason: string | null, calls: ApprovalCalls): Promise<boolean> {
  return rejectReason === null ? calls.approve(runId) : calls.requestChanges(runId, rejectReason.trim());
}

/**
 * Runs one run action and returns its failure message, or '' on success. Store actions resolve false
 * and report a failure to the run's form scope, so `lastError` (that scope's message) is read only after a failure.
 */
export async function runActionError(action: () => Promise<boolean>, lastError: () => string | null): Promise<string> {
  return (await action()) ? '' : (lastError() ?? 'Something went wrong.');
}

export interface RunActionVisibility {
  /** The one-row approval bar: Reject (expands a reason box in the bar) and Approve. */
  approveRequestChanges: boolean;
  /** "Run another round" / "Continue anyway", after a loop-origin step exhausts its rounds. */
  loopDecision: boolean;
  /** "Retry step" — offered any time the run needs attention (or failed while starting), regardless of which stage is selected. */
  retryStep: boolean;
}

/**
 * Which of the run detail view's contextual actions apply, given the run's status and which stage is
 * selected. `approveRequestChanges`/`loopDecision` only show while the *selected* stage is the one the
 * run is actually paused on (`run.currentStepId`) — picking another stage to look at its history
 * shouldn't offer to decide *its* fate. `loopDecision`'s `loopBack` check is a heuristic proxy for "a
 * loop maxed out its rounds": the backend has no separate structured flag for that on
 * `WorkflowRunRecord.attentionReason` (a plain string), so any loop-origin step that's `needs-attention`
 * is treated as a candidate for it — see this module's doc comment in the run view component for the
 * full reasoning. `retryStep` is deliberately stage-independent per the task spec.
 */
export function visibleRunActions(run: Pick<WorkflowRunRecord, 'status' | 'currentStepId' | 'startup'>, selectedStage: RunStage): RunActionVisibility {
  const isCurrentStage = selectedStage.kind === 'step' && selectedStage.step?.id === run.currentStepId;
  return {
    approveRequestChanges: run.status === 'awaiting-approval' && isCurrentStage,
    loopDecision: run.status === 'needs-attention' && isCurrentStage && !!selectedStage.step?.loopBack,
    retryStep: run.status === 'needs-attention' || (run.status === 'failed' && startupView(run) !== null),
  };
}

/**
 * Whether `run.completionReport` looks like it recorded a failed PR creation — see
 * `server/src/worker/workflowSummarizer.ts`'s `buildCompletionReport`, the only place that ever writes
 * this exact "Could not be created automatically" phrasing into the report. The backend doesn't keep a
 * PR body separate from the stitched report, so the Complete stage's copy button just copies the whole
 * `completionReport` text — this only decides *whether* to show that button, not what it copies.
 */
export function hasPrCreationError(completionReport: string | null): boolean {
  return !!completionReport && completionReport.includes('Could not be created automatically');
}

/** Appended last so it wins the cascade: drops the output page's own backdrop and outer spacing so it reads as part of the Output pane rather than a page in a box. */
const EMBEDDED_HTML_RESET = '<style>html,body{background:transparent!important;margin:0!important;padding:0!important}</style>';

/**
 * An HTML output's `srcDoc`, adjusted to sit flush in the Output pane. The iframe is sandboxed without
 * `allow-same-origin`, so its document can't be restyled from outside — the reset has to travel in the markup.
 */
export function embeddedHtmlOutput(content: string): string {
  return content + EMBEDDED_HTML_RESET;
}
