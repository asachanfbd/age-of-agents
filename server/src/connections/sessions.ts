import { chainDepthsDb, tasksDb, workflowRunsDb } from '../db/collections.ts';
import type { TaskRecord } from '../domain/types.ts';
import { ConnectionError } from './rules.ts';
import type { SessionKind } from './rules.ts';
import type { CallerRef } from './types.ts';

/** What a session's capability tools are allowed to do, worked out from the session itself and never from what the agent sends. */
export interface ConnectionSession {
  caller: CallerRef;
  session: SessionKind;
  /** The depth of the call that started this session's run, 0 when a person started it. */
  depth: number;
  chainId: string | undefined;
}

const ENDED_RUN_STATUSES = ['completed', 'failed', 'stopped'];

/** The kind of session a task is: planning sessions read only, a workflow step reads only unless its step may edit code. */
export async function sessionKindOf(task: TaskRecord, stepCanEditCode: (task: TaskRecord) => Promise<boolean>): Promise<SessionKind> {
  if (task.kind === 'plan') return 'planning';
  if (!task.workflowRunId) return 'execute';
  return (await stepCanEditCode(task)) ? 'writable-step' : 'readonly-step';
}

/** Whether a session still has a live run: a finished or stopped one may not call anything. */
async function isActive(task: TaskRecord): Promise<boolean> {
  if (task.status !== 'developing' && task.status !== 'blocked') return false;
  if (!task.workflowRunId) return true;
  const run = await workflowRunsDb.get(task.workflowRunId);
  return run !== undefined && !ENDED_RUN_STATUSES.includes(run.status);
}

export async function resolveConnectionSession(taskId: string, stepCanEditCode: (task: TaskRecord) => Promise<boolean>): Promise<ConnectionSession> {
  const task = await tasksDb.get(taskId);
  if (!task) throw new ConnectionError(404, 'Session not found');
  if (!(await isActive(task))) throw new ConnectionError(403, 'This session is no longer running, so it cannot call other Buildings.');
  const depthRecord = (await chainDepthsDb.get(task.id)) ?? (task.workflowRunId ? await chainDepthsDb.get(task.workflowRunId) : undefined);
  return {
    caller: { kind: task.workflowRunId ? 'step' : 'agent', buildingId: task.projectId, refId: task.id },
    session: await sessionKindOf(task, stepCanEditCode),
    depth: depthRecord?.depth ?? 0,
    chainId: depthRecord?.chainId,
  };
}
