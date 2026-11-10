import { isBugItem, startWorkflowChoice } from './bugs';
import { dependencyLabel } from './dependencies';
import type { StartConfirmParent } from './dependencies';
import { bulkEarlyNote, uiPlansComing } from './earlyUiPlanning';
import { isExecutorAvailable } from './executorAvailability';
import { pendingTaskRows } from './projectTasks';
import type { PlanningQueueEntry } from './projectTasks';
import type { ExecutePlanItemOptions, ExecutorProfile, PlanItemQueueEntry } from './serverApi';
import { startOptions } from './startTaskDialog';
import { plural } from './text';
import { queuePlaces } from './waitingList';
import type { PlanItemData } from '../types';

/**
 * The Planning column's "Start pending tasks" dialog: which cards it lists, which coding agent each
 * row uses, the options each start sends, and the per-row results of a batch sent one by one. Pure,
 * so the rules are testable without a component; `BulkStartDialog.tsx` only renders them.
 */

/** One startable card, in the column's display order. */
export interface BulkRow {
  id: string;
  title: string;
  kind: 'Task' | 'Bug';
  /** The number the card's title starts with ("#37.003"), or null for a title with none. */
  number: string | null;
  /** A bug marked "Needs more info"; never set on a task. */
  needsMoreInfo: boolean;
  /** The task has parents, so the dialog asks the daemon which of them are not merged yet. */
  hasParents: boolean;
  /** The workflow the single Start task dialog would preselect; '' when none applies. */
  workflowId: string;
  /** Workflows are enabled but none is the default for this card: it cannot start from here and is never sent. */
  locked: boolean;
  /** Its stored "UI planning waits for parent", which the row's switch opens in. */
  uiPlanningWaitsForParent: boolean;
  /** Its workflow starts with the UI Planning step that can run before the parents are merged. */
  earlyStep: boolean;
}

/** What the single Start task dialog preselects a workflow from (`startWorkflowChoice`). */
export interface WorkflowDefaults {
  projectDefaultId: string;
  enabledIds: string[];
  bugWorkflowId: string;
  /** The enabled workflows that start with an early UI Planning step. */
  earlyStepWorkflowIds?: string[];
}

export const NO_WORKFLOW_NOTE = 'No default workflow · open the task to choose one';
export const DEFAULTS_NOTE = 'Each task runs its default workflow with every step. Open a task to change them.';
export const PLAY_BUTTON_LABEL = 'Start pending tasks';
export const NOTHING_TO_START = 'No pending task can be started from this column';

/** Every card the column can start, sessions left out: pending tasks and bugs whose card offers Start, including those inside collapsed groups. */
export function buildBulkRows(queue: readonly PlanningQueueEntry[], items: readonly PlanItemData[], defaults: WorkflowDefaults): BulkRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return pendingTaskRows(queue)
    .filter((row) => row.primary === 'start' && !row.waiting && !row.queued)
    .map((row) => {
      const item = byId.get(row.id);
      const bug = !!item && isBugItem(item);
      const { workflowId } = startWorkflowChoice({ bug, ...defaults });
      const label = dependencyLabel(row);
      return {
        id: row.id,
        title: row.title,
        kind: bug ? 'Bug' : 'Task',
        number: label === row.title ? null : label,
        needsMoreInfo: bug && row.bug?.needsMoreInfo === true,
        hasParents: !!item?.dependsOn?.length,
        workflowId,
        locked: defaults.enabledIds.length > 0 && !workflowId,
        uiPlanningWaitsForParent: item?.uiPlanningWaitsForParent === true,
        earlyStep: !!workflowId && (defaults.earlyStepWorkflowIds ?? []).includes(workflowId),
      };
    });
}

/** "Waits for #37.004, #37.006" for the parents not merged yet; null when every parent is satisfied or the lookup gave nothing. */
export function waitsForText(parents: readonly StartConfirmParent[] | undefined): string | null {
  return parents?.length ? `Waits for ${parents.map((parent) => parent.label).join(', ')}` : null;
}

// ---- Selection ----

/** The rows that can be checked: every one but those locked for want of a default workflow. */
export const selectableIds = (rows: readonly BulkRow[]): string[] => rows.filter((row) => !row.locked).map((row) => row.id);

/** Toggles one row; a locked row never changes. The result keeps the column order. */
export function toggleChecked(rows: readonly BulkRow[], checked: readonly string[], id: string): string[] {
  const set = new Set(checked);
  if (set.has(id)) set.delete(id);
  else if (selectableIds(rows).includes(id)) set.add(id);
  return rows.filter((row) => set.has(row.id)).map((row) => row.id);
}

/** The checked rows still listed, in column order. */
export const checkedRows = (rows: readonly BulkRow[], checked: readonly string[]): BulkRow[] => rows.filter((row) => !row.locked && checked.includes(row.id));

export interface SelectionSummary {
  /** "5 of 7 selected"; locked rows count in neither number. */
  text: string;
  count: number;
  canSelectAll: boolean;
  canSelectNone: boolean;
}

export function selectionSummary(rows: readonly BulkRow[], checked: readonly string[]): SelectionSummary {
  const total = selectableIds(rows).length;
  const count = checkedRows(rows, checked).length;
  return { text: `${count} of ${total} selected`, count, canSelectAll: count < total, canSelectNone: count > 0 };
}

/** The column header's play button: disabled, with the reason as its title, while no card can start. */
export function playButtonState(rows: readonly BulkRow[]): { disabled: boolean; title: string } {
  const disabled = selectableIds(rows).length === 0;
  return { disabled, title: disabled ? NOTHING_TO_START : PLAY_BUTTON_LABEL };
}

// ---- Coding agents ----

/** The row picker's "Same as all" entry. Radix Select refuses an empty value, so it has a value of its own. */
export const SAME_AS_ALL = '__same-as-all__';

/** A row's own agent, kept only while it is still configured and available; otherwise the row follows the common agent. */
export function liveOverride(executors: readonly ExecutorProfile[], override: string | undefined, now: number): string | null {
  const executor = override ? executors.find((candidate) => candidate.id === override) : undefined;
  return executor && isExecutorAvailable(executor, now) ? executor.id : null;
}

/** The agent a row starts with: its own while usable, else the common one ('' when there is none). */
export const rowAgentId = (executors: readonly ExecutorProfile[], commonId: string, override: string | undefined, now: number): string =>
  liveOverride(executors, override, now) ?? commonId;

/** Sets or clears ("Same as all") one row's own agent. An override equal to the common agent stays an override. */
export function setOverride(overrides: Readonly<Record<string, string>>, rowId: string, value: string): Record<string, string> {
  const next = { ...overrides };
  if (value === SAME_AS_ALL) delete next[rowId];
  else next[rowId] = value;
  return next;
}

const agentName = (executors: readonly ExecutorProfile[], id: string): string => executors.find((executor) => executor.id === id)?.label ?? '';

/** The row picker's first entry, naming the agent it follows. */
export const sameAsAllLabel = (executors: readonly ExecutorProfile[], commonId: string): string => `Same as all · ${agentName(executors, commonId) || 'No agent'}`;

/** A row's agent as plain text once its picker is locked: "Codex (chosen for this task)" for its own pick, else the common agent's name. */
export function lockedAgentLabel(executors: readonly ExecutorProfile[], commonId: string, override: string | undefined, now: number): string {
  const own = liveOverride(executors, override, now);
  if (own) return `${agentName(executors, own)} (chosen for this task)`;
  return agentName(executors, commonId) || 'No agent';
}

// ---- Auto-merge ----

/** "Auto-merge for all" on every open; a task's own saved setting is not the default here. */
export const AUTO_MERGE_ALL_DEFAULT = true;

/** Sets or clears (null, "Same as all") one row's own Auto-merge. A value equal to the common one stays an override. */
export function setAutoMergeOverride(overrides: Readonly<Record<string, boolean>>, rowId: string, value: boolean | null): Record<string, boolean> {
  const next = { ...overrides };
  if (value === null) delete next[rowId];
  else next[rowId] = value;
  return next;
}

/** The Auto-merge a row starts with: its own while set, else the common switch. */
export const rowAutoMerge = (common: boolean, override: boolean | undefined): boolean => override ?? common;

/** A row's Auto-merge as plain text once its switch is locked: "Auto-merge off (chosen for this task)" for its own value. */
export function lockedAutoMergeLabel(common: boolean, override: boolean | undefined): string {
  const text = `Auto-merge ${rowAutoMerge(common, override) ? 'on' : 'off'}`;
  return override === undefined ? text : `${text} (chosen for this task)`;
}

// ---- Start options and footer ----

/**
 * The options one row starts with: its workflow as the single Start task dialog preselects it, every
 * step, and the agent and Auto-merge chosen in this dialog, plus the row's "UI planning waits for parent"
 * for a task with parents. Auto-merge is sent only with a repository.
 */
export function rowStartOptions(
  row: Pick<BulkRow, 'workflowId' | 'hasParents'>, executorId: string, autoMerge: boolean, hasRepository: boolean, uiPlanningWaitsForParent = false,
): ReturnType<typeof startOptions> & { uiPlanningWaitsForParent?: boolean } {
  const options = startOptions({ executorId, createBranch: hasRepository, hasRepository, autoMerge, workflowId: row.workflowId, skippedStepIds: [] });
  return row.hasParents ? { ...options, uiPlanningWaitsForParent } : options;
}

/** Whether a row's start runs UI Planning now: it waits for parents, its workflow has the step, and its switch is off. */
export const rowRunsEarly = (row: Pick<BulkRow, 'earlyStep'>, waits: boolean, waitingParents: readonly unknown[] | undefined): boolean =>
  row.earlyStep && !waits && !!waitingParents?.length;

/** The note under the defaults note, counting the checked rows that run UI Planning now. */
export function bulkEarlyRowsNote(
  rows: readonly BulkRow[], checked: readonly string[], waits: Readonly<Record<string, boolean>>, parents: Readonly<Record<string, readonly unknown[]>>,
): string | null {
  return bulkEarlyNote(checkedRows(rows, checked).filter((row) => rowRunsEarly(row, waits[row.id] ?? row.uiPlanningWaitsForParent, parents[row.id])).length);
}

/** The dialog's choices at the moment a start is sent. */
export interface BulkSendSnapshot {
  shown: readonly BulkRow[];
  overrides: Readonly<Record<string, string>>;
  commonId: string;
  executors: readonly ExecutorProfile[];
  now: number;
  hasRepository: boolean;
  autoMergeAll: boolean;
  autoMergeOverrides: Readonly<Record<string, boolean>>;
  /** Rows whose "UI planning waits for parent" was changed in the dialog; the others keep their stored value. */
  waits?: Readonly<Record<string, boolean>>;
}

/** One listed row and the options its start sends, read from the latest choices, so a retry uses what the row shows now. */
export function rowSendOptions(snapshot: BulkSendSnapshot, id: string): { row: BulkRow; options: ExecutePlanItemOptions } {
  const row = snapshot.shown.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`Row ${id} is not listed.`);
  const agent = rowAgentId(snapshot.executors, snapshot.commonId, snapshot.overrides[id], snapshot.now);
  const autoMerge = rowAutoMerge(snapshot.autoMergeAll, snapshot.autoMergeOverrides[id]);
  const waits = snapshot.waits?.[id] ?? row.uiPlanningWaitsForParent;
  return { row, options: rowStartOptions(row, agent, autoMerge, snapshot.hasRepository, waits) };
}

export const startButtonLabel = (count: number): string => (count === 0 ? 'Start tasks' : `Start ${plural(count, 'task')}`);

export const NO_AGENT_REASON = 'Add a coding agent to start tasks.';
export const NOTHING_SELECTED_REASON = 'Select at least one task.';

/** Why Start is disabled, shown under it; null when it can be pressed. */
export function startBlockReason(input: { selected: number; commonAgentId: string }): string | null {
  if (!input.commonAgentId) return NO_AGENT_REASON;
  return input.selected === 0 ? NOTHING_SELECTED_REASON : null;
}

/** The line shown while the Project is at its task limit: the started tasks wait in line in column order. */
export function bulkLimitNote(inUse: number, cap: number): string | null {
  if (inUse < cap) return null;
  return `All ${cap} ${cap === 1 ? 'slot is' : 'slots are'} in use; the started tasks will wait in line in this order and start on their own.`;
}

// ---- Running a batch ----

export type RowResult =
  | { status: 'next' }
  | { status: 'starting' }
  | { status: 'started' }
  | { status: 'queued'; position: number }
  /** Waits for its parents; `early` when its UI Planning runs now, with its place while that waits for a slot. */
  | { status: 'waiting'; early?: { place: number | null } }
  | { status: 'failed'; message: string };

/**
 * What an accepted start did: a run id means it started; otherwise it joined the waiting list (with its Project-wide place)
 * or waits for its parents — running its UI Planning now (`early`), or in line for a slot to do so.
 */
export function classifyStart(runId: string, queue: readonly PlanItemQueueEntry[] | undefined, itemId: string, early = false): RowResult {
  if (runId) return { status: 'started' };
  const place = queuePlaces(queue).get(itemId);
  const earlyEntry = queue?.some((entry) => entry.planItemId === itemId && entry.early);
  if (earlyEntry) return { status: 'waiting', early: { place: place?.position ?? null } };
  if (place) return { status: 'queued', position: place.position };
  return early ? { status: 'waiting', early: { place: null } } : { status: 'waiting' };
}

/** A refused start's row text: the daemon's reason. */
export const refusalMessage = (failure: unknown): string => (failure instanceof Error && failure.message.trim()) || 'Something went wrong.';

export const NOT_SELECTED_STATUS = 'Not selected · left as it is';

/** A row's status line once a batch began; null before (and for a checked row nothing has happened to). */
export function rowStatusText(result: RowResult | undefined): string | null {
  switch (result?.status) {
    case 'next': return 'Next in line…';
    case 'starting': return 'Starting…';
    case 'started': return '✓ Started';
    case 'queued': return `Queued (position ${result.position})`;
    case 'waiting':
      if (!result.early) return 'Waiting · starts by itself once its parents are merged';
      return result.early.place === null
        ? 'Waiting · UI Planning runs now; later steps start once its parents are merged'
        : `Waiting · UI Planning is in line for a free slot (#${result.early.place}); later steps start once its parents are merged`;
    case 'failed': return `✕ Not started: ${result.message}`;
    default: return null;
  }
}

/** "2 started · 1 queued · 2 waiting for parents · 1 not started · 2 UI plans coming for approval", leaving out what is zero. */
export function summaryLine(results: Readonly<Record<string, RowResult>>): string {
  const count = (status: RowResult['status']) => Object.values(results).filter((result) => result.status === status).length;
  const early = Object.values(results).filter((result) => result.status === 'waiting' && result.early).length;
  return [
    ...[
      [count('started'), 'started'],
      [count('queued'), 'queued'],
      [count('waiting'), 'waiting for parents'],
      [count('failed'), 'not started'],
    ].filter(([n]) => (n as number) > 0).map(([n, words]) => `${n} ${words}`),
    ...(uiPlansComing(early) ? [uiPlansComing(early)!] : []),
  ].join(' · ');
}

/** "Starting 3 of 6…" while a batch runs; null when nothing is being sent. */
export function progressLine(sent: readonly string[], results: Readonly<Record<string, RowResult>>): string | null {
  const index = sent.findIndex((id) => results[id]?.status === 'starting');
  return index === -1 ? null : `Starting ${index + 1} of ${sent.length}…`;
}

/** The refused rows, in column order: what "Retry failed" sends again. */
export const failedIds = (rows: readonly BulkRow[], results: Readonly<Record<string, RowResult>>): string[] =>
  rows.filter((row) => results[row.id]?.status === 'failed').map((row) => row.id);

/** Before a batch, a checked row's picker and Auto-merge switch are editable; after one, only a refused row's are, so Retry can use other choices. */
export function rowPickerEnabled(input: { phase: BulkPhase; checked: boolean; result: RowResult | undefined }): boolean {
  if (input.phase === 'idle') return input.checked;
  return input.phase === 'done' && input.result?.status === 'failed';
}

export type BulkPhase = 'idle' | 'running' | 'done';

export interface BulkRunner {
  /** Starts the given rows one by one; ignored while a batch is already running, so a double click sends nothing twice. */
  run: (ids: readonly string[]) => Promise<void>;
  readonly busy: boolean;
}

/**
 * Sends one start per id, in order, each only after the previous one settled, so the waiting list
 * fills in column order. A refusal marks that row and the batch carries on. `busy` is set before the
 * first await, so a second call in the same frame is a no-op.
 */
export function createBulkRunner(start: (id: string) => Promise<RowResult>, onResult: (id: string, result: RowResult) => void): BulkRunner {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(ids) {
      if (busy || ids.length === 0) return;
      busy = true;
      try {
        for (const id of ids) onResult(id, { status: 'next' });
        for (const id of ids) {
          onResult(id, { status: 'starting' });
          let result: RowResult;
          try {
            result = await start(id);
          } catch (failure) {
            result = { status: 'failed', message: refusalMessage(failure) };
          }
          onResult(id, result);
        }
      } finally {
        busy = false;
      }
    },
  };
}
