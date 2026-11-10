import { buildOpenTaskRows, itemCompletedAt, latestItemTask } from './projectTasks';
import { autoMergeHoldOf, completedAutoMergeHold } from './autoMerge';
import type { Attention, OpenTaskRow } from './projectTasks';
import { taskPrView } from './taskPullRequest';
import { startupCardProgress } from './runStartup';
import { earlyPhaseOf } from './earlyUiPlanning';
import { stepCardProgress } from './taskBoard';
import type { PlanItemQueueEntry, WorkflowRunRecord } from './serverApi';
import type { PlanItemData, TaskData } from '../types';

/**
 * Splits what `buildOpenTaskRows` returns three ways by each row's *WorkflowRun* status (not just its
 * PlanItem/Task status, which is all `buildOpenTaskRows` itself knows about): rows whose run needs a
 * human (awaiting approval, needs attention, failed, or stopped by hand) or — for a row with no run at all — is a plain
 * blocked Task waiting on an answer, the pre-workflow case `openState`/`openAttention` already handled;
 * rows whose run is actively `starting`/`running`/`completing`, or that have no run but whose Task is
 * executing (no step progress to show); started tasks waiting for their parents
 * (`row.waiting`, with no run yet or a `held` early run) in their own `waiting` group, which the board shows in its Running column
 * but which is not live work (see `isBlockedWaiting`); and everything else (the board's Planning column). A
 * row is matched to its run by id within the *project's* run list (`workflowRunsByProject[projectId]`)
 * — a project can have many runs across many plan items, so this never just grabs "the project's runs"
 * at large.
 *
 * A finished task is not Completed until its PR is merged. With Auto-merge on, the daemon's auto-merge
 * state decides: while the PR is open or being merged its row goes to `prNotMerged` (the lower Needs-you
 * row); once auto-merge failed, can't merge or has no PR it needs the person, so it goes to `needsYou`.
 * With Auto-merge off the daemon's last reading of the task's own PR decides: open means `prNotMerged`.
 * Inside `prNotMerged` the Auto-merge rows come first in plan order, then the rows held only by an open PR,
 * newest completion first, ties by task number.
 */
export function buildTaskGroups(input: {
  items: PlanItemData[];
  tasksById: Record<string, TaskData>;
  workflowRunsByProject: Record<string, WorkflowRunRecord[]>;
  projectId: string;
  showArchived: boolean;
  now: number;
  /** The Project's waiting list; its tasks join the waiting group. */
  queue?: readonly PlanItemQueueEntry[];
}): { needsYou: OpenTaskRow[]; prNotMerged: OpenTaskRow[]; running: OpenTaskRow[]; waiting: OpenTaskRow[]; open: OpenTaskRow[] } {
  const runsForProject = input.workflowRunsByProject[input.projectId] ?? [];
  const runsById = new Map(runsForProject.map((run) => [run.id, run]));
  const heldOf = (item: PlanItemData) => completedAutoMergeHold(item, item.workflowRunId ? runsById.get(item.workflowRunId) : undefined);
  const rows = buildOpenTaskRows({ items: input.items, tasksById: input.tasksById, showArchived: input.showArchived, now: input.now, keepDone: (item) => heldOf(item) !== null, queue: input.queue });
  const itemsById = new Map(input.items.map((item) => [item.id, item]));

  const needsYou: OpenTaskRow[] = [];
  const prNotMerged: OpenTaskRow[] = [];
  const running: OpenTaskRow[] = [];
  const waiting: OpenTaskRow[] = [];
  const open: OpenTaskRow[] = [];

  for (const listed of rows) {
    const run = findWorkflowRun(listed, runsForProject);
    const earlyPhase = earlyPhaseOf(listed, run, input.queue);
    const row: OpenTaskRow = earlyPhase ? { ...listed, earlyPhase } : listed;
    const held = heldOf(itemsById.get(row.id)!);
    if (held) {
      // Finished, so nothing to start, pause, edit or complete; only opening it and archiving apply.
      // The row was built without its run, so a task whose item status lags behind a completed run still gets its PR tag here.
      const item = itemsById.get(row.id)!;
      const pr = taskPrView(item, run);
      const settled: OpenTaskRow = { ...row, primary: 'none', canEdit: false, canComplete: false, ...(pr ? { pr } : {}) };
      (held === 'awaiting-merge' ? prNotMerged : needsYou).push(settled);
    } else if (run) {
      // A finished run's card belongs in Completed (`buildCompletedRows`) even if its item's own status
      // lags behind — never in Planning.
      if (run.status === 'completed') continue;
      // A stopped run waits for you to resume it (or complete/delete it) — its card resumes the run.
      if (run.status === 'stopped') needsYou.push({ ...row, primary: 'resume' });
      else if (run.status === 'awaiting-approval' || run.status === 'needs-attention' || run.status === 'failed') needsYou.push(startupCardProgress(run) ? { ...row, progress: startupCardProgress(run) } : row);
      else if (run.status === 'starting') running.push({ ...row, progress: startupCardProgress(run) });
      else if (run.status === 'running' || run.status === 'completing') running.push({ ...row, progress: stepCardProgress(run) });
      // An early run after its UI Planning: it waits for the parents (or a slot), like a task with no run yet.
      else if (run.status === 'held') waiting.push(row);
      else open.push(row);
    } else if (row.attention === 'input') {
      needsYou.push(row);
    } else if (row.waiting || row.queued) {
      waiting.push(row);
    } else if (row.state === 'executing' && !itemsById.get(row.id)!.workflowRunId) {
      // A Task started without any WorkflowRun (the docs bootstrap, a freeform or run-less follow-up) is live
      // work too. A row whose run exists but is not loaded yet stays put rather than guessing.
      running.push(row);
    } else {
      open.push(row);
    }
  }

  return { needsYou, prNotMerged: orderPrNotMerged(prNotMerged, itemsById, input.tasksById, runsById), running, waiting, open };
}

const timeOrNegative = (iso: string | null): number => {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? -Infinity : time;
};

const compare = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

/** The task's planning number as one sortable value; a hand-typed task sorts after the numbered ones. */
const NUMBER_STRIDE = 1_000_000;
const taskNumberOf = (item: PlanItemData): number => (item.planningRef ? item.planningRef.session * NUMBER_STRIDE + item.planningRef.task : Infinity);

function orderPrNotMerged(rows: OpenTaskRow[], itemsById: Map<string, PlanItemData>, tasksById: Record<string, TaskData>, runsById: Map<string, WorkflowRunRecord>): OpenTaskRow[] {
  const byAutoMerge = rows.filter((row) => row.autoMerge?.enabled);
  const byPullRequest = rows.filter((row) => !row.autoMerge?.enabled).map((row) => {
    const item = itemsById.get(row.id)!;
    const completedAt = itemCompletedAt(item, latestItemTask(item, tasksById) ?? undefined, item.workflowRunId ? runsById.get(item.workflowRunId) : undefined);
    return { row, item, at: timeOrNegative(completedAt) };
  });
  byPullRequest.sort((a, b) => compare(b.at, a.at) || compare(taskNumberOf(a.item), taskNumberOf(b.item)) || compare(a.item.order, b.item.order));
  return [...byAutoMerge, ...byPullRequest.map((entry) => entry.row)];
}

/** A task waiting for its parents that cannot proceed by itself (a parent failed or needs a decision). */
export function isBlockedWaiting(row: Pick<OpenTaskRow, 'waiting'>): boolean {
  return row.waiting?.state === 'blocked';
}

/** The row's own WorkflowRun, found by id within `runsForProject` — null when the row has never run one. */
export function findWorkflowRun(row: Pick<OpenTaskRow, 'workflowRunId'>, runsForProject: WorkflowRunRecord[]): WorkflowRunRecord | null {
  if (!row.workflowRunId) return null;
  return runsForProject.find((run) => run.id === row.workflowRunId) ?? null;
}

/**
 * The Needs-you sidebar dot's severity: red for a run that failed or whose Auto-merge gave up, amber for one merely waiting on a
 * decision, or — for the pre-workflow fallback case, which has no run — whatever `buildOpenTaskRows`
 * already decided (always 'input' for a row that lands in Needs-you that way).
 */
export function needsYouSeverity(row: Pick<OpenTaskRow, 'attention' | 'autoMerge'>, run: WorkflowRunRecord | null): Attention {
  if (run) return run.status === 'failed' || autoMergeHoldOf(row.autoMerge) === 'needs-you' ? 'failed' : 'input';
  return row.attention;
}
