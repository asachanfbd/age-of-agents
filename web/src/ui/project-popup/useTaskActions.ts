import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { bulkFailureMessage, interimCommitNotice } from '../../lib/projectTasks';
import type { OpenTaskRow } from '../../lib/projectTasks';
import { queuedNoticeFor } from '../../lib/waitingList';
import { taskConflictOf, type TaskConflict } from '../../lib/taskConflicts';
import type { ExecutePlanItemOptions } from '../../lib/serverApi';
import { serverApi } from '../../lib/serverApi';
import type { ErrorScope } from '../../lib/errorNotifications';
import { useWorldStore } from '../../store/worldStore';
import { useErrorScope } from '../useErrorScope';
import type { ProjectData } from '../../types';
import type { BugInfoStatus } from '../../lib/bugs';

/**
 * Everything a Tasks-tab card or drop does, against the store and daemon. Failures from direct
 * daemon calls land in `error` (shown as an alert by the panel); store actions report through the
 * store, which hands a failure back through the action's error scope while this hook is mounted.
 *
 * Resuming opens the session view (`openSession`), which for a terminal Task is the live PTY panel —
 * a Task can only be driven from there.
 */
export function useTaskActions(project: ProjectData, openSession: (taskId: string) => void) {
  const startPlanItem = useWorldStore((s) => s.startPlanItem);
  const removeFromWaitingList = useWorldStore((s) => s.removeFromWaitingList);
  const stopTask = useWorldStore((s) => s.stopTask);
  const stopWorkflowRun = useWorldStore((s) => s.stopWorkflowRun);
  const resumeWorkflowRun = useWorldStore((s) => s.resumeWorkflowRun);
  const updatePlanItem = useWorldStore((s) => s.updatePlanItem);
  const deletePlanItem = useWorldStore((s) => s.deletePlanItem);
  const reorderPlanItems = useWorldStore((s) => s.reorderPlanItems);
  const createPlanItem = useWorldStore((s) => s.createPlanItem);
  const loadProjectTasks = useWorldStore((s) => s.loadProjectTasks);
  const loadPlan = useWorldStore((s) => s.loadPlan);
  const setBugInfoStatus = useWorldStore((s) => s.setBugInfoStatus);
  const reportRegression = useWorldStore((s) => s.reportRegression);
  const updateSessionDescription = useWorldStore((s) => s.updateSessionDescription);
  const startDeferredSession = useWorldStore((s) => s.startDeferredSession);
  useErrorScope('taskActions');
  useErrorScope('workflowRun');
  const [error, setError] = useState('');
  /** A refusal because the Project is at its task limit or a planning session is still running; shown as its own message. */
  const [conflict, setConflict] = useState<TaskConflict | null>(null);
  /** A success message from a direct daemon call — currently only an interim commit's outcome. */
  const [notice, setNotice] = useState('');

  /** Runs an action, surfacing a failure as `error`; resolves whether it succeeded. */
  const guard = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    setError('');
    setConflict(null);
    setNotice('');
    try {
      await action();
      return true;
    } catch (failure) {
      const refused = taskConflictOf(failure);
      if (refused) setConflict(refused);
      else setError((failure as Error).message);
      return false;
    }
  }, []);

  /** A store action reports failure by resolving false and setting its scope's error; this rejects with that message instead, for `guard`. */
  const storeCall = useCallback(async (scope: ErrorScope, call: () => Promise<boolean>) => {
    if (!(await call())) throw new Error(useWorldStore.getState().formErrors[scope] ?? 'Something went wrong.');
  }, []);

  const refresh = useCallback(() => Promise.all([loadProjectTasks(project.id), loadPlan(project.id)]), [loadProjectTasks, loadPlan, project.id]);

  /** Reopens a paused (settled) terminal session as its next linked Task and lands on it. */
  const reopenSession = useCallback(async (taskId: string) => {
    const next = await serverApi.resumeTerminalTask(taskId);
    await refresh();
    openSession(next.id);
  }, [refresh, openSession]);

  return {
    error,
    conflict,
    clearError: () => setError(''),
    reportError: (failure: unknown) => setError((failure as Error).message),
    notice,
    clearNotice: () => setNotice(''),

    /** Flips a not-started bug's advisory Info status; a refusal (the bug started meanwhile) shows as an alert and leaves the flag. */
    setInfoStatus: (itemId: string, infoStatus: BugInfoStatus) => guard(() => setBugInfoStatus(project.id, itemId, infoStatus)),

    /** Reports a regression on a completed bug and starts round 2. Unguarded: a refusal rejects, so the dialog can show it and stay open. */
    reportRegression: (itemId: string, reason: string) => reportRegression(project.id, itemId, reason),

    /** Saves a not-started bug report session's description as the person edits it. */
    saveSessionDescription: (taskId: string, description: string) => guard(() => updateSessionDescription(taskId, description)),

    /** Starts a not-started session's CLI on the agent the person picked. */
    startSession: (taskId: string, executorId: string) => guard(() => startDeferredSession(taskId, executorId)),

    /**
     * Starts a task with the start dialog's options. Unguarded: a refusal rejects, so the dialog can
     * show it and stay open. The board picks the new run up live, so nothing is opened here.
     * Resolves to the new run's id, or '' when the task joined the waiting list or waits for its parents.
     */
    start: async (row: Pick<OpenTaskRow, 'id' | 'title'>, options: ExecutePlanItemOptions): Promise<string> => {
      // The store picks start-when-ready for a task with parents from its own plan item; the daemon then starts it now or makes it wait.
      const runId = await startPlanItem(project.id, row.id, options);
      // A start at the task limit waits in line; say so, since nothing new appears on the board's Running side.
      const notice = queuedNoticeFor(row.title, useWorldStore.getState().planItemQueueByProject[project.id], row.id);
      if (notice) toast(notice);
      return runId;
    },

    /** Takes a queued task off the waiting list; it goes back to unstarted. */
    removeFromWaitingList: (entryId: string) => removeFromWaitingList(project.id, entryId),

    /**
     * Resumes a card: a stopped WorkflowRun continues in its own session (`resumeRun`); a paused
     * (stopped/failed) pre-workflow terminal session reopens and lands on its PTY panel.
     */
    resume: (row: OpenTaskRow) => guard(async () => {
      if (row.workflowRunId) return storeCall('workflowRun', () => resumeWorkflowRun(row.workflowRunId!));
      if (row.latestTaskId) await reopenSession(row.latestTaskId);
    }),

    /** Resumes a session view's paused terminal session. */
    resumeSession: (taskId: string) => guard(() => reopenSession(taskId)),

    /** Exits a session view's live CLI, leaving a resumable session. */
    stopSession: (taskId: string) => guard(() => storeCall('taskActions', () => stopTask(taskId))),

    /** Marks a session view's paused terminal session done, the way a paused card's "Mark complete" does. */
    completeSession: (taskId: string) => guard(async () => {
      await serverApi.completeTerminalTask(taskId);
      await refresh();
    }),

    /** Stops a card: its WorkflowRun (`stopRun`), or a pre-workflow Task — for a terminal Task that exits its CLI, leaving a resumable session ("Paused"). */
    pause: (row: OpenTaskRow) => guard(async () => {
      if (row.workflowRunId) return storeCall('workflowRun', () => stopWorkflowRun(row.workflowRunId!));
      if (row.latestTaskId) await storeCall('taskActions', () => stopTask(row.latestTaskId!));
    }),

    /** Stops a WorkflowRun's live CLI (run `stopped`, item `blocked`), keeping its session to resume. */
    stopRun: (runId: string) => guard(() => storeCall('workflowRun', () => stopWorkflowRun(runId))),

    /** Resumes a stopped WorkflowRun in the same session with "Continue.". */
    resumeRun: (runId: string) => guard(() => storeCall('workflowRun', () => resumeWorkflowRun(runId))),

    /** Commits and pushes a running task's work so far, leaving the task running. */
    interimCommit: (row: Pick<OpenTaskRow, 'latestTaskId'>) => guard(async () => {
      if (row.latestTaskId) setNotice(interimCommitNotice(await serverApi.interimCommitTask(row.latestTaskId)));
    }),

    /**
     * Marks rows done. A paused terminal session completes through the daemon exactly as its session
     * view's "Mark Completed" does, which settles it done directly. Anything else — including a
     * WorkflowRun-backed item, whose run the daemon commits and completes — is marked done on its plan item.
     */
    complete: (rows: Pick<OpenTaskRow, 'id' | 'completesViaSession' | 'latestTaskId'>[]) => guard(async () => {
      for (const row of rows) {
        if (row.completesViaSession && row.latestTaskId) {
          await serverApi.completeTerminalTask(row.latestTaskId);
        } else {
          await storeCall('taskActions', () => updatePlanItem(project.id, row.id, { status: 'done' }));
        }
      }
      if (rows.some((row) => row.completesViaSession)) await refresh();
    }),

    /** Archives (or restores) planning sessions; their archive state lives on the Task itself. */
    archiveTasks: (taskIds: string[], archived: boolean) => guard(async () => {
      for (const taskId of taskIds) await serverApi.archiveSession(taskId, archived);
      await loadProjectTasks(project.id);
    }),

    completePlanning: (taskId: string) => guard(async () => {
      await serverApi.completePlanningSession(taskId);
      await loadProjectTasks(project.id);
    }),

    /** Renames a session; the daemon's 'task' events carry the new title to every view. */
    renameSession: (taskId: string, title: string) => guard(() => serverApi.renameSession(taskId, title)),

    /** Deletes a settled session with its follow-ups; the daemon refuses (409) while any turn is live. */
    deleteSession: (taskId: string) => guard(async () => {
      await serverApi.deleteSession(taskId);
      await loadProjectTasks(project.id);
    }),

    /** Archives a plan item, hiding it from every board column; the daemon refuses (409) while it's developing. */
    archive: (id: string) => guard(() => storeCall('taskActions', () => updatePlanItem(project.id, id, { archived: true }))),

    /**
     * Archives several plan items (the Completed column's "Archive all"), one PATCH each. Every item is
     * tried; the failures are reported together in one alert (`bulkFailureMessage`).
     */
    archiveItems: (ids: string[]) => guard(async () => {
      const failures: string[] = [];
      for (const id of ids) {
        try {
          await storeCall('taskActions', () => updatePlanItem(project.id, id, { archived: true }));
        } catch (failure) {
          failures.push((failure as Error).message);
        }
      }
      if (failures.length > 0) throw new Error(bulkFailureMessage('archive', failures, ids.length));
    }),

    /** Puts an archived plan item back on the board. */
    unarchive: (id: string) => guard(() => storeCall('taskActions', () => updatePlanItem(project.id, id, { archived: false }))),

    deleteItems: (ids: string[]) => guard(async () => {
      for (const id of ids) await storeCall('taskActions', () => deletePlanItem(project.id, id));
    }),

    duplicate: (row: Pick<OpenTaskRow, 'title' | 'description'>) => guard(async () => {
      await storeCall('taskActions', async () => (await createPlanItem(project.id, { title: row.title, description: row.description })) !== undefined);
    }),

    edit: (id: string, patch: { title: string; description: string }) => guard(() => storeCall('taskActions', () => updatePlanItem(project.id, id, patch))),

    /** Saves a column's new card order after a drop. */
    reorder: (ids: string[]) => guard(() => storeCall('taskActions', () => reorderPlanItems(project.id, ids))),
  };
}

/** Everything `useTaskActions` offers — what the task detail views act through. */
export type TaskActions = ReturnType<typeof useTaskActions>;
