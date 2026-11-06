/**
 * The 409 refusals a Task start or a planning-session action can hit, each with its own `code` so the
 * web can tell them apart without reading the message. The message is still a plain sentence for
 * clients that only show text.
 */

/** How many coding Tasks a Project with a linked repository can run at once, each in its own working copy. */
export const MAX_CONCURRENT_TASKS_PER_PROJECT = 6;

/** What an occupant of a slot is doing: `starting` is a run still setting up. */
export type SlotOccupantState = 'starting' | 'running' | 'waiting_input';

/** One Task (or run still starting) holding a concurrency slot. */
export interface SlotOccupant {
  /** The Task holding the slot; null for a run that has no Task yet. */
  taskId: string | null;
  /** The plan item (board card) the web opens; null for a Task with none. */
  planItemId: string | null;
  /** "4.002", or null for a task with no number. */
  number: string | null;
  title: string;
  state: SlotOccupantState;
}

export const TASK_LIMIT_REACHED = 'task_limit_reached';
export const SESSION_STILL_RUNNING = 'session_still_running';

/** The error body's extra fields: the identity and the data the web's message needs. */
export interface ConflictBody {
  code: string;
  details: Record<string, unknown>;
}

/** Base of every conflict below, so existing `instanceof TaskConflictError` checks cover all of them. */
export class TaskConflictError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, body: ConflictBody) {
    super(message);
    this.name = 'TaskConflictError';
    this.code = body.code;
    this.details = body.details;
  }
}

export class TaskLimitReachedError extends TaskConflictError {
  constructor(project: { name: string; repositoryUrl?: string | null }, limit: number, occupants: SlotOccupant[]) {
    const hasRepository = Boolean(project.repositoryUrl);
    const message = hasRepository
      ? `${project.name} is running its maximum of ${limit} tasks. Wait for one to finish, stop one, or answer a task that is waiting for you, then start again.`
      : `${project.name} can run only one task at a time because it has no linked repository. Wait for the running task to finish or stop it, or link a repository to run more.`;
    super(message, {
      code: TASK_LIMIT_REACHED,
      details: { projectName: project.name, limit, inUse: occupants.length, hasRepository, occupants },
    });
  }
}

export class SessionStillRunningError extends TaskConflictError {
  constructor(live: { taskId: string; title: string }) {
    super('This planning session is still running. Let it finish or stop it first.', {
      code: SESSION_STILL_RUNNING,
      details: { taskId: live.taskId, title: live.title },
    });
  }
}
