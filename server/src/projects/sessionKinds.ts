import type { TaskRecord } from '../domain/types.ts';

type SessionKind = Pick<TaskRecord, 'kind' | 'planningPurpose'>;

/** A session that files tasks and bugs together and sets their dependencies (see terminal/bugReportTool.ts). */
export const isPlanAndBugsSession = (task: SessionKind): boolean => task.kind === 'plan' && task.planningPurpose === 'plan-and-bugs';

/** A session from before the combined one: files bugs, plus a few tasks, and sets no dependencies. */
export const isBugReportSession = (task: SessionKind): boolean => task.kind === 'plan' && task.planningPurpose === 'bug-report';

/** Whether the session uses the bug-filing tools (`/api/agent-bugs`): the combined session and the earlier bug report session. */
export const filesBugs = (task: SessionKind): boolean => isPlanAndBugsSession(task) || isBugReportSession(task);
