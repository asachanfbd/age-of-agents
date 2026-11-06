/**
 * Pure logic deciding when the Age-of-Empires sound cues play (`ui/TaskSounds.tsx`):
 * the "under attack" horn when a Task or WorkflowRun needs the user's attention, and the "create"
 * chime when one finishes. Kept out of the component so it's testable without audio or React, same
 * as `lib/notificationToasts.ts`.
 *
 * Both cues are driven entirely by Task/WorkflowRun status (never by Notifications — see below),
 * comparing a live status against a prior snapshot so only a genuine transition into the target
 * status plays a sound. `web/src/store/worldStore.ts`'s `isStale` guard on `loadProjectTasks` and
 * `loadWorkflowRunsForProject` is the other half of this: without it, an out-of-order bulk fetch
 * could regress a Task/WorkflowRun's status in the store and a later correction would look like a
 * second, brand-new transition here.
 *
 * This intentionally covers the exact same set of moments the server itself raises a `task`/
 * `workflow` Notification for (server/src/worker/workerManager.ts): a Task blocked
 * (`settleBlocked`), failed (`settleFailed`), or a terminal Task waiting for CLI input
 * (`applyTerminalRuntimeUpdate`'s `runtimeStatus`), and a WorkflowRun entering `awaiting-approval`/
 * `needs-attention` (`setWorkflowRunAwaitingApproval`/`setWorkflowRunNeedsAttention`) — plus
 * `WorkflowRunStatus`'s `failed`, which the server doesn't raise today but the type allows for.
 * Auto-merge moves the completion chime to the merge: see the Auto-merge section at the end.
 * Deriving the sound from status directly (rather than from those Notifications) means one signal
 * decides both, so there's no risk of the two racing or double-firing for the same real event.
 */
import type { PlanItemData, TaskData } from '../types';
import type { WorkflowRunRecord } from './serverApi';

export type TaskSound = 'attention' | 'complete';

/** Served from `web/public/sounds/`. */
export const TASK_SOUND_URLS: Record<TaskSound, string> = {
  attention: '/sounds/task-attention.mp3',
  complete: '/sounds/task-complete.mp3',
};

/** A Task's WorkflowRun step is the run's own concern — routing it through `finalizeWorkflowStepTask`
 * on the server (see `settleFailed`/`settleDone`) rather than a Task-level Notification. Excluding it
 * here avoids double-counting the same real event once as the step Task and once as the run. */
function isOwnTask(task: Pick<TaskData, 'workflowRunId'>): boolean {
  return !task.workflowRunId;
}

/**
 * A Task counts as "completed" for the chime only when it's real coding work settling on its own: a
 * planning chat settles `done` after every reply, which would chime on every turn if counted.
 */
function isChimeableTask(task: TaskData): boolean {
  return task.kind === 'execute' && isOwnTask(task);
}

/**
 * The single value that matters for a Task's sound: a terminal Task's `status` stays `'developing'`
 * for as long as its PTY is alive, so a live CLI pause only ever shows up in `runtimeStatus` (see
 * `applyTerminalRuntimeUpdate`) — folding it in here lets one transition check catch both shapes of
 * "this Task needs you".
 */
function taskSoundState(task: Pick<TaskData, 'status' | 'runtimeStatus'>): string {
  return task.runtimeStatus === 'waiting_input' ? 'waiting_input' : task.status;
}

function isTaskAttentionState(state: string): boolean {
  return state === 'blocked' || state === 'failed' || state === 'waiting_input';
}

function isTaskDoneState(state: string): boolean {
  return state === 'done';
}

function isRunAttentionState(status: string): boolean {
  return status === 'awaiting-approval' || status === 'needs-attention' || status === 'failed';
}

function isRunDoneState(status: string): boolean {
  return status === 'completed';
}

const NO_ITEMS: ReadonlySet<string> = new Set();

/** Id → sound-relevant state, so the next render can tell a transition from a replay of history. */
export type StatusSnapshot = Record<string, string>;

export function snapshotTaskStates(tasksById: Record<string, TaskData>): StatusSnapshot {
  const snapshot: StatusSnapshot = {};
  for (const task of Object.values(tasksById)) snapshot[task.id] = taskSoundState(task);
  return snapshot;
}

export function snapshotRunStates(runs: Iterable<WorkflowRunRecord>): StatusSnapshot {
  const snapshot: StatusSnapshot = {};
  for (const run of runs) snapshot[run.id] = run.status;
  return snapshot;
}

/**
 * Ids whose sound-relevant state just transitioned into one matching `isTarget`, per `previous`
 * (from `snapshotTaskStates`/`snapshotRunStates`). An id missing from `previous` is never a
 * transition — it's history arriving (initial load, a bulk history fetch), not a live change — and
 * an id already in the target state doesn't re-fire just because another event touched it while it
 * sat there (a duplicate WS push, an unrelated field changing).
 */
function transitionedInto(previous: StatusSnapshot, ids: string[], stateOf: (id: string) => string, isTarget: (state: string) => boolean): string[] {
  return ids.filter((id) => {
    const before = previous[id];
    return before !== undefined && !isTarget(before) && isTarget(stateOf(id));
  });
}

export function completedTaskIds(previous: StatusSnapshot, tasksById: Record<string, TaskData>, autoMergeItemIds: ReadonlySet<string> = NO_ITEMS): string[] {
  const chimeable = Object.values(tasksById).filter((task) => isChimeableTask(task) && !(task.planItemId && autoMergeItemIds.has(task.planItemId)));
  return transitionedInto(previous, chimeable.map((t) => t.id), (id) => taskSoundState(tasksById[id]!), isTaskDoneState);
}

export function attentionTaskIds(previous: StatusSnapshot, tasksById: Record<string, TaskData>): string[] {
  const owned = Object.values(tasksById).filter(isOwnTask);
  return transitionedInto(previous, owned.map((t) => t.id), (id) => taskSoundState(tasksById[id]!), isTaskAttentionState);
}

export function allWorkflowRuns(workflowRunsByProject: Record<string, WorkflowRunRecord[]>): WorkflowRunRecord[] {
  return Object.values(workflowRunsByProject).flat();
}

export function completedWorkflowRunIds(previous: StatusSnapshot, runs: WorkflowRunRecord[], autoMergeItemIds: ReadonlySet<string> = NO_ITEMS): string[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const chimeable = runs.filter((run) => !(run.planItemId && autoMergeItemIds.has(run.planItemId)));
  return transitionedInto(previous, chimeable.map((r) => r.id), (id) => byId.get(id)!.status, isRunDoneState);
}

export function attentionWorkflowRunIds(previous: StatusSnapshot, runs: WorkflowRunRecord[]): string[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  return transitionedInto(previous, runs.map((r) => r.id), (id) => byId.get(id)!.status, isRunAttentionState);
}

// ---- Auto-merge ----
//
// With a task's Auto-merge on, "done" is the merge, not the end of its run: the chime waits for the
// PR to be merged (`mergedAutoMergeItemIds`), and the horn sounds when Auto-merge needs the person
// (`attentionAutoMergeItemIds`) — the same states the server raises `automerge.blocked`, `.failed` and
// `.conflict_failed` for. Both read a snapshot of plan items taken before the update.

const AUTO_MERGE_ATTENTION_STATES: ReadonlySet<string> = new Set(['blocked', 'failed', 'cannot-merge', 'no-pr']);

/** Plan item id → `none` (no record), `off:<state>` (toggle off) or `on:<state>`, so a toggle flip is a change of its own. */
export function snapshotAutoMergeStates(planByProject: Record<string, { items: PlanItemData[] } | undefined>): StatusSnapshot {
  const snapshot: StatusSnapshot = {};
  for (const plan of Object.values(planByProject)) {
    for (const item of plan?.items ?? []) {
      snapshot[item.id] = item.autoMerge ? `${item.autoMerge.enabled ? 'on' : 'off'}:${item.autoMerge.state}` : 'none';
    }
  }
  return snapshot;
}

/** Ids of plan items whose Auto-merge is on right now: their run's end does not chime. */
export function autoMergeOnItemIds(planByProject: Record<string, { items: PlanItemData[] } | undefined>): Set<string> {
  const ids = new Set<string>();
  for (const plan of Object.values(planByProject)) {
    for (const item of plan?.items ?? []) if (item.autoMerge?.enabled) ids.add(item.id);
  }
  return ids;
}

/** Items whose Auto-merge, on, just became Merged. A Merged record merely switched back on is not a new merge. */
export function mergedAutoMergeItemIds(previous: StatusSnapshot, current: StatusSnapshot): string[] {
  return Object.keys(current).filter((id) => {
    const before = previous[id];
    return before !== undefined && current[id] === 'on:merged' && !before.endsWith(':merged');
  });
}

/** Items whose Auto-merge, on, just entered a state that needs the person (not a repeat of the same state). */
export function attentionAutoMergeItemIds(previous: StatusSnapshot, current: StatusSnapshot): string[] {
  return Object.keys(current).filter((id) => {
    const before = previous[id];
    const now = current[id]!;
    return before !== undefined && before !== now && now.startsWith('on:') && AUTO_MERGE_ATTENTION_STATES.has(now.slice(3));
  });
}
