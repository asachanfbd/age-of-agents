import { ApiError, serverApi } from '../lib/serverApi';
import { activityQuery, activityRangeProblem, describeConnectionError } from '../lib/connections';
import type { ActivityEntry, ActivityFilters, CallOutcome, LinkRequest, LinksResponse, LinkView, SubscriptionView } from '../lib/connections';

/**
 * The connections part of the world store: each Building's links, subscriptions and Activity log, every link for the
 * 3D scene, and the actions the Connections view and the Activity log call. A refused change is handed back to the
 * caller with its reason (and the field, for a 400), so it shows where it happened and is never a notification.
 */

export type ConnectionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string; field: string | null };

export interface ConnectionsState {
  linksByProject: Record<string, LinksResponse>;
  /** Every link, for the lines between Buildings in the 3D scene. */
  allLinks: LinkView[];
  subscriptionsByProject: Record<string, SubscriptionView[]>;
  activityByProject: Record<string, ActivityEntry[]>;
  connectionLoadErrorByProject: Record<string, string>;
  loadLinks: (projectId: string) => Promise<void>;
  loadAllLinks: () => Promise<void>;
  createLink: (projectId: string, link: LinkRequest) => Promise<ConnectionResult>;
  updateLink: (projectId: string, linkId: string, patch: LinkRequest) => Promise<ConnectionResult>;
  deleteLink: (projectId: string, linkId: string) => Promise<ConnectionResult>;
  loadSubscriptions: (projectId: string) => Promise<void>;
  createSubscription: (projectId: string, subscription: { sourceBuildingId: string; eventId: string; jobId: string }) => Promise<ConnectionResult>;
  setSubscriptionEnabled: (projectId: string, subscriptionId: string, enabled: boolean) => Promise<ConnectionResult>;
  deleteSubscription: (projectId: string, subscriptionId: string) => Promise<ConnectionResult>;
  callCapability: (projectId: string, call: { targetBuildingId: string; capabilityId: string; inputs: Record<string, unknown> }) => Promise<ConnectionResult<{ outcome: CallOutcome }>>;
  decideCapabilityCall: (projectId: string, callId: string, decision: 'approve' | 'request-changes' | 'stop') => Promise<ConnectionResult>;
  loadActivity: (projectId: string, filters?: ActivityFilters) => Promise<ConnectionResult>;
  /** Forgets everything stored about a Building that no longer exists, including the links other Buildings had to it. */
}

type Set = (partial: Partial<ConnectionsState> | ((state: ConnectionsState) => Partial<ConnectionsState>)) => void;

function failure(error: unknown): ConnectionResult & { ok: false } {
  const status = error instanceof ApiError ? error.status : 0;
  const field = error instanceof ApiError && typeof error.details.field === 'string' ? error.details.field : null;
  return { ok: false, status, error: describeConnectionError(status, error instanceof Error ? error.message : null), field };
}

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export function createConnectionsSlice(set: Set, get: () => ConnectionsState): ConnectionsState {
  const storeLinks = (projectId: string, links: LinksResponse) => set((state) => ({
    linksByProject: { ...state.linksByProject, [projectId]: links },
    connectionLoadErrorByProject: without(state.connectionLoadErrorByProject, projectId),
  }));
  /** Runs one change, then re-reads what it can have changed. */
  const change = async (call: () => Promise<unknown>, reload: Array<() => Promise<void>>): Promise<ConnectionResult> => {
    try {
      await call();
      await Promise.all(reload.map((read) => read()));
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  };
  const reloadLinks = (projectId: string) => async () => { await get().loadLinks(projectId); await get().loadAllLinks(); };

  return {
    linksByProject: {},
    allLinks: [],
    subscriptionsByProject: {},
    activityByProject: {},
    connectionLoadErrorByProject: {},

    loadLinks: async (projectId) => {
      try {
        storeLinks(projectId, await serverApi.getLinks(projectId));
      } catch (error) {
        set((state) => ({ connectionLoadErrorByProject: { ...state.connectionLoadErrorByProject, [projectId]: failure(error).error } }));
      }
    },

    loadAllLinks: async () => {
      try {
        set({ allLinks: await serverApi.listAllLinks() });
      } catch {
        // The scene keeps the lines it has; the Connections view reports its own load errors.
      }
    },

    createLink: (projectId, link) => change(() => serverApi.createLink(link), [reloadLinks(projectId)]),
    updateLink: (projectId, linkId, patch) => change(() => serverApi.updateLink(linkId, patch), [reloadLinks(projectId), () => get().loadSubscriptions(projectId)]),
    deleteLink: (projectId, linkId) => change(() => serverApi.deleteLink(linkId), [reloadLinks(projectId), () => get().loadSubscriptions(projectId)]),

    loadSubscriptions: async (projectId) => {
      try {
        const subscriptions = await serverApi.getSubscriptions(projectId);
        set((state) => ({ subscriptionsByProject: { ...state.subscriptionsByProject, [projectId]: subscriptions } }));
      } catch (error) {
        set((state) => ({ connectionLoadErrorByProject: { ...state.connectionLoadErrorByProject, [projectId]: failure(error).error } }));
      }
    },

    createSubscription: (projectId, subscription) => change(() => serverApi.createSubscription({ subscriberBuildingId: projectId, ...subscription }), [() => get().loadSubscriptions(projectId)]),
    setSubscriptionEnabled: (projectId, subscriptionId, enabled) => change(() => serverApi.setSubscriptionEnabled(subscriptionId, enabled), [() => get().loadSubscriptions(projectId)]),
    deleteSubscription: (projectId, subscriptionId) => change(() => serverApi.deleteSubscription(subscriptionId), [() => get().loadSubscriptions(projectId)]),

    callCapability: async (projectId, call) => {
      try {
        const outcome = await serverApi.callCapability(projectId, call);
        await get().loadActivity(projectId);
        return { ok: true, outcome };
      } catch (error) {
        return failure(error);
      }
    },

    decideCapabilityCall: (projectId, callId, decision) => change(() => serverApi.decideCapabilityCall(callId, decision), [async () => { await get().loadActivity(projectId); }]),

    loadActivity: async (projectId, filters = {}) => {
      const problem = activityRangeProblem(filters);
      if (problem) return { ok: false, status: 400, error: problem, field: 'from' };
      try {
        const { entries } = await serverApi.getActivity(projectId, activityQuery(filters));
        set((state) => ({ activityByProject: { ...state.activityByProject, [projectId]: entries } }));
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },

  };
}
