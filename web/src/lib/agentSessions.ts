/**
 * The Agent terminal sessions of a Project (the header's "Agent" dropdown): what the daemon sends, and the
 * pure view logic the dropdown and the full-area terminal view are built on.
 */

/** Mirrors server/src/terminal/agentSessions.ts's AgentSessionDto. */
export interface AgentSession {
  id: string;
  projectId: string;
  executorId: string;
  /** The name the agent or the person chose, or the default "Terminal <n>". */
  name: string;
  state: 'running' | 'ended';
  createdAt: string;
  updatedAt: string;
}

export type AgentSessionEvent =
  | { type: 'agentSession'; session: AgentSession }
  | { type: 'agentSessionDeleted'; id: string; projectId: string };

/** Running sessions first, then ended ones; newest first within each group. */
export function orderAgentSessions(sessions: readonly AgentSession[]): AgentSession[] {
  return [...sessions].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'running' ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export type AgentMenuItem = { kind: 'start' } | { kind: 'session'; session: AgentSession };

/** The dropdown's rows: "Start new" is always first, then the Project's sessions in `orderAgentSessions` order. */
export function agentMenuItems(sessions: readonly AgentSession[]): AgentMenuItem[] {
  return [{ kind: 'start' }, ...orderAgentSessions(sessions).map((session) => ({ kind: 'session' as const, session }))];
}

/** More sessions than this and the menu's list scrolls. */
export const AGENT_MENU_VISIBLE_ROWS = 8;

export const agentSessionStateLabel = (session: Pick<AgentSession, 'state'>): string => (session.state === 'running' ? 'Running' : 'Ended');

/** Folds a live session event into one Project's list; a Project whose list was never loaded ignores it. */
export function mergeAgentSessionEvent(
  byProject: Record<string, AgentSession[]>,
  event: AgentSessionEvent,
): Record<string, AgentSession[]> | null {
  const list = event.type === 'agentSession' ? byProject[event.session.projectId] : byProject[event.projectId];
  if (!list) return null;
  if (event.type === 'agentSessionDeleted') return { ...byProject, [event.projectId]: list.filter((s) => s.id !== event.id) };
  const { session } = event;
  const next = list.some((s) => s.id === session.id) ? list.map((s) => (s.id === session.id ? session : s)) : [...list, session];
  return { ...byProject, [session.projectId]: next };
}

/** Which Agent session fills the popup body: none means the ordinary tabs show. */
export interface AgentViewState {
  openSessionId: string | null;
}

export const NO_AGENT_VIEW: AgentViewState = { openSessionId: null };

export const openAgentView = (sessionId: string): AgentViewState => ({ openSessionId: sessionId });

/** Back returns to the tabs. The session itself is never touched: ending or deleting is a separate, explicit action. */
export const closeAgentView = (): AgentViewState => NO_AGENT_VIEW;

/** The view to show after a session is deleted: its own terminal closes, another one stays. */
export const afterAgentSessionDeleted = (view: AgentViewState, deletedId: string): AgentViewState =>
  view.openSessionId === deletedId ? NO_AGENT_VIEW : view;
