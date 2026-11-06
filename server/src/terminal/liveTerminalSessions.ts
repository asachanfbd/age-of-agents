import { agentSessionsDb, importSessionsDb, studioSessionsDb, tasksDb } from '../db/collections.ts';
import type { LiveTerminalSessionDto } from '../domain/types.ts';
import { sessionDisplayName } from './agentSessions.ts';
import type { TerminalSessionManager } from './terminalSessionManager.ts';

const TASK_TITLE_LENGTH = 60;

/**
 * The footer's view of the terminal registry: every live PTY becomes exactly one row, so the list's length
 * always equals `host.count()` (what blocks an app update). A PTY whose record cannot be found still gets
 * a fallback row rather than being dropped.
 */
export function createLiveTerminalSessions(host: Pick<TerminalSessionManager, 'liveIds'>) {
  async function resolve(id: string): Promise<LiveTerminalSessionDto> {
    const agent = await agentSessionsDb.get(id);
    if (agent) return { id, kind: 'agent', projectId: agent.projectId, title: sessionDisplayName(agent) };
    const studio = await studioSessionsDb.get(id);
    if (studio) return { id, kind: 'content-studio', projectId: studio.buildingId, title: 'Content Studio session' };
    const imported = await importSessionsDb.get(id);
    if (imported) return { id, kind: 'content-studio', projectId: imported.buildingId, title: 'Content Studio import session' };
    const task = await tasksDb.get(id);
    if (!task) return { id, kind: 'task', projectId: null, title: id };
    const kind = task.kind !== 'plan' ? 'task' : task.planningPurpose ? 'bug-report' : 'planning';
    const title = task.title ?? task.description.slice(0, TASK_TITLE_LENGTH);
    return { id, kind, projectId: task.projectId, title };
  }

  return { list: (): Promise<LiveTerminalSessionDto[]> => Promise.all(host.liveIds().map(resolve)) };
}

export type LiveTerminalSessions = ReturnType<typeof createLiveTerminalSessions>;
