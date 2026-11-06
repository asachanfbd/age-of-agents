import { ApiError, serverApi } from '../lib/serverApi';
import { mergeAgentSessionEvent } from '../lib/agentSessions';
import type { AgentSession, AgentSessionEvent } from '../lib/agentSessions';

/**
 * The Agent terminal sessions part of the world store. Actions hand a refusal back to their caller (the
 * start dialog shows it where it happened) instead of raising a notification.
 */

export type AgentSessionResult = { ok: true; session: AgentSession } | { ok: false; error: string };

export interface AgentSessionsState {
  /** Keyed by Project id; absent until `loadAgentSessions` has answered for that Project. */
  agentSessionsByProject: Record<string, AgentSession[]>;
  loadAgentSessions: (projectId: string) => Promise<void>;
  startAgentSession: (projectId: string, executorId: string) => Promise<AgentSessionResult>;
  resumeAgentSession: (session: AgentSession) => Promise<AgentSessionResult>;
  renameAgentSession: (session: AgentSession, name: string) => Promise<AgentSessionResult>;
  endAgentSession: (session: AgentSession) => Promise<AgentSessionResult>;
  deleteAgentSession: (session: AgentSession) => Promise<boolean>;
}

type Set = (partial: Partial<AgentSessionsState> | ((state: AgentSessionsState) => Partial<AgentSessionsState>)) => void;

const errorMessage = (error: unknown): string => (error instanceof ApiError || error instanceof Error ? error.message : 'The request failed');

export const mergeAgentSessionStoreEvent = (state: Partial<Pick<AgentSessionsState, 'agentSessionsByProject'>>, event: AgentSessionEvent): Partial<AgentSessionsState> => {
  const merged = mergeAgentSessionEvent(state.agentSessionsByProject ?? {}, event);
  return merged ? { agentSessionsByProject: merged } : {};
};

export function createAgentSessionsSlice(set: Set): AgentSessionsState {
  const store = (session: AgentSession) => set((state) => mergeAgentSessionStoreEvent(state, { type: 'agentSession', session }));
  const run = async (call: () => Promise<AgentSession>): Promise<AgentSessionResult> => {
    try {
      const session = await call();
      store(session);
      return { ok: true, session };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };

  return {
    agentSessionsByProject: {},

    loadAgentSessions: async (projectId) => {
      try {
        const sessions = await serverApi.listAgentSessions(projectId);
        set((state) => ({ agentSessionsByProject: { ...state.agentSessionsByProject, [projectId]: sessions } }));
      } catch {
        // The dropdown keeps what it has; a failed refresh is not worth a notification.
      }
    },

    startAgentSession: async (projectId, executorId) => {
      // A just-started session may arrive over the live connection before its list has ever loaded.
      set((state) => ({ agentSessionsByProject: { ...state.agentSessionsByProject, [projectId]: state.agentSessionsByProject[projectId] ?? [] } }));
      return run(() => serverApi.startAgentSession(projectId, executorId));
    },
    resumeAgentSession: (session) => run(() => serverApi.resumeAgentSession(session.id)),
    renameAgentSession: (session, name) => run(() => serverApi.renameAgentSession(session.id, name)),
    endAgentSession: (session) => run(() => serverApi.endAgentSession(session.id)),

    deleteAgentSession: async (session) => {
      try {
        await serverApi.deleteAgentSession(session.id);
        set((state) => mergeAgentSessionStoreEvent(state, { type: 'agentSessionDeleted', id: session.id, projectId: session.projectId }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
