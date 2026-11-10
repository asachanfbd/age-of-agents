import { isBugItem, startWorkflowChoice } from './bugs';
import { canEditDependencies, START_WHEN_MERGED_LABEL } from './dependencies';
import { enabledWorkflows, initialStartWorkflowId } from './workflowSettings';
import type { OpenTaskRow } from './projectTasks';
import type { PlanItemQueueEntry, WorkflowRecord, WorkflowRunRecord, WorkflowStep } from './serverApi';
import type { ProjectData } from '../types';
import { plural } from './text';
import type { PlanItemData } from '../types';

/**
 * "UI planning waits for parent" and the early UI Planning it controls (server: projects/dependencies.ts
 * and the early run in worker/workerManager.ts): a waiting task's UI Planning runs before its parents are
 * merged unless the setting is on. Pure wording and rules for the card, the details panel, the Start task
 * dialog and "Start pending tasks".
 */

export const UI_WAITS_LABEL = 'UI planning waits for parent';
export const UI_WAITS_HELP_OFF = 'Off: UI Planning runs as soon as the task is started and asks for your approval. Later steps wait for the parents.';
export const UI_WAITS_HELP_ON = 'On: nothing runs until the parents are merged. Use this when this task\'s UI builds on UI a parent adds.';
export const UI_WAITS_LOCKED_NOTE = 'UI Planning has already started, so this can\'t change now.';
export const UI_WAITS_NO_STEP_NOTE = 'This task\'s workflow has no UI Planning step, so this setting has no effect.';
export const UI_WAITS_SAVE_ERROR = 'Couldn\'t save the setting. Try again.';

const EARLY_STEP_ID = 'ui-planning';

/** The workflow's early step: a first, read-only, manual-approval `ui-planning` step (the daemon's `earlyStepOf`). */
export const hasEarlyStep = (steps: readonly Pick<WorkflowStep, 'id' | 'requiresApproval' | 'canEditCode'>[]): boolean => {
  const first = steps[0];
  return !!first && first.id === EARLY_STEP_ID && first.requiresApproval && !first.canEditCode;
};

/** A waiting task that already has a run: that run is its early UI Planning run. */
export const hasEarlyRun = (item: Pick<PlanItemData, 'waiting' | 'workflowRunId'>): boolean => !!item.waiting && !!item.workflowRunId;

const hasParents = (item: Pick<PlanItemData, 'dependsOn'>): boolean => !!item.dependsOn?.length;

/** Whether the setting can change now: a task with parents that is ready, or waiting with nothing started yet. */
export const uiWaitsEditable = (item: PlanItemData): boolean => hasParents(item) && canEditDependencies(item);

export interface UiWaitsSwitchView {
  shown: boolean;
  disabled: boolean;
  checked: boolean;
  /** Why it is disabled; null while it can change. */
  note: string | null;
}

/**
 * The switch on the card or in the details. Only a task with parents has it. The card shows it only
 * while it can change; the details also show it locked, with the reason.
 */
export function uiWaitsSwitch(input: {
  item: PlanItemData;
  surface: 'card' | 'detail';
  /** The steps of the workflow the task would run; left out when unknown. */
  workflowSteps?: readonly Pick<WorkflowStep, 'id' | 'requiresApproval' | 'canEditCode'>[];
}): UiWaitsSwitchView {
  const { item, surface } = input;
  const checked = item.uiPlanningWaitsForParent === true;
  const hidden = { shown: false, disabled: true, checked, note: null };
  if (!hasParents(item) || item.archived) return hidden;
  if (hasEarlyRun(item)) return surface === 'card' ? hidden : { shown: true, disabled: true, checked, note: UI_WAITS_LOCKED_NOTE };
  if (!uiWaitsEditable(item)) return hidden;
  if (input.workflowSteps && !hasEarlyStep(input.workflowSteps)) {
    return surface === 'card' ? hidden : { shown: true, disabled: true, checked, note: UI_WAITS_NO_STEP_NOTE };
  }
  return { shown: true, disabled: false, checked, note: null };
}

/**
 * The steps of the workflow the task's start runs: the one a waiting task was started with, else what the Start
 * task dialog preselects (`startWorkflowChoice`: a bug's Bug Fix workflow, else the Project's default). Undefined
 * when it is not known (no enabled workflow matches), so the switch makes no claim about it.
 */
export function startWorkflowSteps(
  item: PlanItemData,
  context: { workflows: Pick<WorkflowRecord, 'id' | 'enabled' | 'steps'>[]; project: Pick<ProjectData, 'workflowId'> | undefined; bugWorkflowId: string },
): WorkflowStep[] | undefined {
  const enabled = enabledWorkflows(context.workflows);
  const chosen = item.waiting?.options.workflowId ?? startWorkflowChoice({
    bug: isBugItem(item), projectDefaultId: context.project ? initialStartWorkflowId(context.project, enabled) : '', enabledIds: enabled.map((workflow) => workflow.id), bugWorkflowId: context.bugWorkflowId,
  }).workflowId;
  return enabled.find((workflow) => workflow.id === chosen)?.steps;
}

// ---- Where an early run stands ----

export type EarlyPhase =
  | { kind: 'queued'; place: number }
  | { kind: 'running' }
  | { kind: 'awaiting-approval' }
  | { kind: 'revising' }
  | { kind: 'approved'; queued: boolean };

/**
 * How far a waiting task's early UI Planning has got, from its run and its place in the slot line; null
 * for a task with no early UI Planning (the setting is on, it skipped UI Planning, or it never waited).
 */
export function earlyPhaseOf(
  item: Pick<PlanItemData, 'id' | 'waiting'>,
  run: Pick<WorkflowRunRecord, 'status' | 'early'> | null | undefined,
  queue: readonly Pick<PlanItemQueueEntry, 'planItemId' | 'early' | 'resumeRunId' | 'position'>[] | undefined,
): EarlyPhase | null {
  const entries = [...(queue ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const index = entries.findIndex((entry) => entry.planItemId === item.id);
  const entry = index === -1 ? undefined : entries[index];
  if (!run?.early) return item.waiting && entry?.early ? { kind: 'queued', place: index + 1 } : null;
  if (run.early.skipped) return null;
  if (run.status === 'starting' || run.status === 'running') return run.early.revisions > 0 ? { kind: 'revising' } : { kind: 'running' };
  if (run.status === 'awaiting-approval') return { kind: 'awaiting-approval' };
  if (run.status !== 'held') return null;
  if (run.early.pendingRevision) return { kind: 'queued', place: index + 1 };
  return { kind: 'approved', queued: !!run.early.released };
}

/** The card's and details' phase line; each carries a glyph so the meaning never depends on colour alone. */
export function earlyPhaseLine(phase: EarlyPhase | null): string | null {
  switch (phase?.kind) {
    case 'queued': return `◷ UI planning waits for a free slot · #${phase.place}`;
    case 'running': return '● UI planning running early';
    case 'awaiting-approval': return '! UI plan needs your approval';
    case 'revising': return '● UI plan revision running';
    case 'approved': return phase.queued ? '✓ UI plan approved' : '✓ UI plan approved, waiting for parents';
    default: return null;
  }
}

export type OpenCardBadge = 'Running' | 'Needs you' | 'Waiting' | 'Blocked';

/** The card's badge while an early run exists: Running while the agent works, Needs you for the approval, else Waiting (Blocked when a parent blocks it). */
export function earlyCardBadge(phase: EarlyPhase | null, waitingState: 'waiting' | 'blocked' | undefined): OpenCardBadge | null {
  if (!phase) return null;
  if (phase.kind === 'running' || phase.kind === 'revising') return 'Running';
  if (phase.kind === 'awaiting-approval') return 'Needs you';
  return waitingState === 'blocked' ? 'Blocked' : 'Waiting';
}

// ---- The details' waiting panel ----

export const CANCEL_CONFIRM_TEXT = 'Cancel waiting? The UI plan made so far is discarded.';
export const KEEP_WAITING_LABEL = 'Keep waiting';
export const CANCEL_AND_DISCARD_LABEL = 'Cancel and discard';
export const REVIEW_UI_PLAN_LABEL = 'Review UI plan';

/** The waiting panel's early-run extras: Review UI plan while the approval is pending, Open run while it runs, and whether Cancel waiting asks first. */
export function earlyWaitingActions(phase: EarlyPhase | null): { reviewUiPlan: boolean; openRun: boolean; confirmCancel: boolean } {
  return {
    reviewUiPlan: phase?.kind === 'awaiting-approval',
    openRun: phase?.kind === 'running' || phase?.kind === 'revising',
    // Only once a run exists: a start still in the slot line made no UI plan yet.
    confirmCancel: !!phase && phase.kind !== 'queued',
  };
}

// ---- The Start task dialog's parents step ----

export const START_EARLY_LABEL = 'Start UI planning now';
export const CONFIRM_BODY_WAITS = 'This task starts by itself once these parent tasks are merged into the checked-out branch. Until then it shows in Running as Waiting, and you can cancel waiting at any time.';
export const CONFIRM_BODY_EARLY = 'UI Planning runs now and asks for your approval. Test Case Planning and the later steps start by themselves once these parent tasks are merged into the checked-out branch. Until then the task shows in Running as Waiting, and you can cancel waiting at any time.';
export const NO_EARLY_STEP_NOTE = 'This workflow has no UI Planning step, so nothing runs before the parents are merged.';
export const EARLY_STEP_UNSELECTED_NOTE = 'UI Planning isn\'t selected for this run, so nothing runs before the parents are merged.';

export interface StartParentsView {
  /** The switch shows; otherwise `note` says why nothing runs early. */
  switchShown: boolean;
  note: string | null;
  body: string;
  primaryLabel: string;
  /** Shown under the footer when UI Planning would wait in line. */
  fullNote: string | null;
}

/** The parents step of the Start task dialog for the chosen workflow, step selection, branch choice and switch value. */
export function startParentsView(input: {
  steps: readonly Pick<WorkflowStep, 'id' | 'requiresApproval' | 'canEditCode'>[];
  skippedStepIds: readonly string[];
  createBranch: boolean;
  waits: boolean;
  slotsInUse: number;
  cap: number;
}): StartParentsView {
  const waitsView = (note: string | null): StartParentsView => ({ switchShown: note === null, note, body: CONFIRM_BODY_WAITS, primaryLabel: START_WHEN_MERGED_LABEL, fullNote: null });
  if (!hasEarlyStep(input.steps) || !input.createBranch) return waitsView(NO_EARLY_STEP_NOTE);
  if (input.skippedStepIds.includes(EARLY_STEP_ID)) return waitsView(EARLY_STEP_UNSELECTED_NOTE);
  if (input.waits) return waitsView(null);
  const full = input.slotsInUse >= input.cap;
  return {
    switchShown: true, note: null, body: CONFIRM_BODY_EARLY, primaryLabel: START_EARLY_LABEL,
    fullNote: full ? `All ${input.cap} ${input.cap === 1 ? 'slot is' : 'slots are'} in use; UI Planning will wait in line and start on its own.` : null,
  };
}

// ---- "Start pending tasks" ----

/** The note under the defaults note: how many checked rows with parents run UI Planning now; null for none. */
export function bulkEarlyNote(count: number): string | null {
  if (count === 0) return null;
  if (count === 1) return 'UI Planning of the task that waits for parents runs now, so you can approve its UI plan right away.';
  return `UI Planning of the ${count} tasks that wait for parents runs now, so you can approve those UI plans together.`;
}

/** "N UI plans coming for approval" for the batch summary; null at 0. */
export const uiPlansComing = (count: number): string | null => (count > 0 ? `${plural(count, 'UI plan')} coming for approval` : null);

/**
 * Saves a switch change shown at once (optimistically): resolves to the value the switch should now show — the new one,
 * or the previous one back with the inline error when the save was refused.
 */
export async function saveUiWaits(previous: boolean, next: boolean, save: (value: boolean) => Promise<boolean>): Promise<{ value: boolean; error: string | null }> {
  return (await save(next)) ? { value: next, error: null } : { value: previous, error: UI_WAITS_SAVE_ERROR };
}

/** An open card's status badge; an early run's own badge wins over the plain waiting one. */
export function openCardStatus(row: Pick<OpenTaskRow, 'queued' | 'waiting' | 'state' | 'earlyPhase'>): string | null {
  const early = earlyCardBadge(row.earlyPhase ?? null, row.waiting?.state);
  if (early) return early;
  if (row.queued) return null;
  if (row.waiting) return row.waiting.state === 'blocked' ? 'Blocked' : 'Waiting';
  switch (row.state) {
    case 'executing': return 'Running';
    case 'blocked': return 'Needs you';
    case 'failed': return 'Failed';
    case 'stopped': case 'paused': return 'Stopped';
    default: return null;
  }
}
