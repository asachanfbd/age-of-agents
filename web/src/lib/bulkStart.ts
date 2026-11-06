import { isBugItem, startWorkflowChoice } from './bugs';
import { dependencyLabel } from './dependencies';
import type { StartConfirmParent } from './dependencies';
import { isExecutorAvailable } from './executorAvailability';
import { pendingTaskRows } from './projectTasks';
import type { PlanningQueueEntry } from './projectTasks';
import type { ExecutorProfile, PlanItemQueueEntry } from './serverApi';
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
  /** The task's own Auto-merge setting, which its start keeps. */
  autoMerge: boolean;
}

/** What the single Start task dialog preselects a workflow from (`startWorkflowChoice`). */
export interface WorkflowDefaults {
  projectDefaultId: string;
  enabledIds: string[];
  bugWorkflowId: string;
}

export const NO_WORKFLOW_NOTE = 'No default workflow · open the task to choose one';
export const DEFAULTS_NOTE = 'Each task starts with its default workflow and options. Open a task to change them.';
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
        autoMerge: item?.autoMerge?.enabled === true,
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

// ---- Start options and footer ----

/** The options one row starts with: exactly what the single Start task dialog preselects for it, with every step. */
export function rowStartOptions(row: Pick<BulkRow, 'workflowId' | 'autoMerge'>, executorId: string, hasRepository: boolean): ReturnType<typeof startOptions> {
  return startOptions({ executorId, createBranch: hasRepository, hasRepository, autoMerge: row.autoMerge, workflowId: row.workflowId, skippedStepIds: [] });
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
  | { status: 'waiting' }
  | { status: 'failed'; message: string };

/** What an accepted start did: a run id means it started; otherwise it joined the waiting list (with its Project-wide place) or waits for its parents. */
export function classifyStart(runId: string, queue: readonly PlanItemQueueEntry[] | undefined, itemId: string): RowResult {
  if (runId) return { status: 'started' };
  const place = queuePlaces(queue).get(itemId);
  return place ? { status: 'queued', position: place.position } : { status: 'waiting' };
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
    case 'waiting': return 'Waiting · starts by itself once its parents are merged';
    case 'failed': return `✕ Not started: ${result.message}`;
    default: return null;
  }
}

/** "2 started · 1 queued · 2 waiting for parents · 1 not started", leaving out what is zero. */
export function summaryLine(results: Readonly<Record<string, RowResult>>): string {
  const count = (status: RowResult['status']) => Object.values(results).filter((result) => result.status === status).length;
  return [
    [count('started'), 'started'],
    [count('queued'), 'queued'],
    [count('waiting'), 'waiting for parents'],
    [count('failed'), 'not started'],
  ].filter(([n]) => (n as number) > 0).map(([n, words]) => `${n} ${words}`).join(' · ');
}

/** "Starting 3 of 6…" while a batch runs; null when nothing is being sent. */
export function progressLine(sent: readonly string[], results: Readonly<Record<string, RowResult>>): string | null {
  const index = sent.findIndex((id) => results[id]?.status === 'starting');
  return index === -1 ? null : `Starting ${index + 1} of ${sent.length}…`;
}

/** The refused rows, in column order: what "Retry failed" sends again. */
export const failedIds = (rows: readonly BulkRow[], results: Readonly<Record<string, RowResult>>): string[] =>
  rows.filter((row) => results[row.id]?.status === 'failed').map((row) => row.id);

/** Before a batch, a checked row's picker is editable; after one, only a refused row's is, so Retry can use another agent. */
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
