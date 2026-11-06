/**
 * The daemon's 409 refusals for starting a task or acting on a planning session, recognised by the
 * `code` it sends (never by message text) and turned into the title, body and task list the message
 * shows. Pure so the wording and live updating can be tested without a component.
 */
import { ApiError } from './serverApi';
import type { TaskData } from '../types';

export type SlotState = 'starting' | 'running' | 'waiting_input';

/** One task holding a concurrency slot, as the daemon reports it. */
export interface SlotOccupant {
  taskId: string | null;
  planItemId: string | null;
  number: string | null;
  title: string;
  state: SlotState;
}

export interface TaskLimitDetails {
  projectName: string;
  limit: number;
  inUse: number;
  hasRepository: boolean;
  occupants: SlotOccupant[];
}

export interface SessionRunningDetails {
  taskId: string;
  title: string;
}

export type TaskConflict =
  | { kind: 'limit'; details: TaskLimitDetails }
  | { kind: 'session'; details: SessionRunningDetails };

/** The conflict a failed request carries, or null for any other failure. */
export function taskConflictOf(error: unknown): TaskConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const { code, details } = error.details as { code?: string; details?: unknown };
  if (code === 'task_limit_reached' && details) return { kind: 'limit', details: details as TaskLimitDetails };
  if (code === 'session_still_running' && details) return { kind: 'session', details: details as SessionRunningDetails };
  return null;
}

const STATE_LABEL: Record<SlotState, string> = { starting: 'Starting', running: 'Running', waiting_input: 'Waiting for your input' };

export interface ConflictRow {
  key: string;
  label: string;
  stateLabel: string;
  /** What "Open" goes to. */
  target: { taskId: string | null; planItemId: string | null };
}

export interface ConflictView {
  title: string;
  body: string;
  rows: ConflictRow[];
  /** True once a listed slot has freed, so starting again can work. */
  retryable: boolean;
}

/**
 * An occupant as it stands now: still holding a slot while its task is developing or blocked, with
 * the state read from the live task. A task that is no longer in the store is kept as reported; a
 * settled one drops out.
 */
function liveOccupant(occupant: SlotOccupant, tasksById: Record<string, Pick<TaskData, 'status'>>): SlotOccupant | null {
  const task = occupant.taskId ? tasksById[occupant.taskId] : undefined;
  if (!task) return occupant;
  if (task.status === 'developing') return { ...occupant, state: occupant.state === 'starting' ? 'starting' : 'running' };
  if (task.status === 'blocked') return { ...occupant, state: 'waiting_input' };
  return null;
}

function limitView(details: TaskLimitDetails, tasksById: Record<string, Pick<TaskData, 'status'>>): ConflictView {
  const occupants = details.occupants.flatMap((occupant) => liveOccupant(occupant, tasksById) ?? []);
  const rows = occupants.map((occupant, index) => ({
    key: occupant.taskId ?? occupant.planItemId ?? `slot-${index}`,
    label: [occupant.number, occupant.title].filter(Boolean).join(' '),
    stateLabel: STATE_LABEL[occupant.state],
    target: { taskId: occupant.taskId, planItemId: occupant.planItemId },
  }));
  if (!details.hasRepository) {
    return {
      title: `${details.projectName} can run only one task at a time`,
      body: 'This project has no linked repository, and running tasks side by side needs a separate working copy for each one. Wait for the running task to finish or stop it, or link a repository to run more.',
      rows,
      retryable: rows.length < details.limit,
    };
  }
  return {
    title: `${details.projectName} is running its maximum of ${details.limit} tasks`,
    body: 'Tasks waiting for your input still count. Wait for one to finish, stop one, or answer a waiting one, then start again.',
    rows,
    retryable: rows.length < details.limit,
  };
}

function sessionView(details: SessionRunningDetails): ConflictView {
  return {
    title: 'This planning session is still running',
    body: `${details.title ? `"${details.title}" is` : 'The session is'} still running. Let it finish or stop it first.`,
    rows: [{ key: details.taskId, label: details.title, stateLabel: 'Running', target: { taskId: details.taskId, planItemId: null } }],
    retryable: false,
  };
}

/** The message for a conflict, with its task list brought up to date from the live tasks. */
export function conflictView(conflict: TaskConflict, tasksById: Record<string, Pick<TaskData, 'status'>>): ConflictView {
  return conflict.kind === 'limit' ? limitView(conflict.details, tasksById) : sessionView(conflict.details);
}
