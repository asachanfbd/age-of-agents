import { create } from 'zustand';
import { contentApi } from '../lib/contentApi';
import type { Platform } from '../lib/contentRules';
import type { TargetField } from '../lib/contentTargets';
import type { InsightsDto, InsightsVersionDto, TargetHistoryDto, TargetsResponseDto } from '../lib/contentTypes';
import { ApiError } from '../lib/serverApi';

export type InsightsResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string; field?: string };

function failure(error: unknown): InsightsResult & { ok: false } {
  if (error instanceof ApiError) {
    const field = (error.details as { field?: unknown } | undefined)?.field;
    return { ok: false, status: error.status, error: error.message, ...(typeof field === 'string' && { field }) };
  }
  return { ok: false, status: 0, error: error instanceof Error ? error.message : 'The request failed' };
}

/** The version the server holds now, from a refused notes save (409 `details.current`). */
const currentVersion = (error: unknown): string | null => {
  const current = ((error as ApiError | undefined)?.details as { details?: { current?: unknown } } | undefined)?.details?.current;
  return typeof current === 'string' ? current : null;
};

export interface ContentInsightsState {
  targetsByProject: Record<string, TargetsResponseDto>;
  targetHistoryByProject: Record<string, TargetHistoryDto[]>;
  insightsByProject: Record<string, InsightsDto>;
  insightsHistoryByProject: Record<string, InsightsVersionDto[]>;
  /** The notes version the server holds when a save was refused as stale, per Building. */
  notesConflictByProject: Record<string, string>;
  loadTargets: (id: string) => Promise<InsightsResult>;
  /** Saves one platform's fields (an empty one as null); a refused field is named in the failure. */
  saveTargets: (id: string, platform: Platform, body: Record<TargetField, number | null>) => Promise<InsightsResult>;
  loadTargetHistory: (id: string) => Promise<InsightsResult>;
  loadInsights: (id: string) => Promise<InsightsResult>;
  refreshInsights: (id: string) => Promise<InsightsResult>;
  stopInsights: (id: string) => Promise<InsightsResult>;
  loadInsightsHistory: (id: string) => Promise<InsightsResult>;
  saveNotes: (id: string, content: string, version: string) => Promise<InsightsResult>;
  clearNotesConflict: (id: string) => void;
}

export const useContentInsightsStore = create<ContentInsightsState>((set, get) => {
  const keep = <K extends keyof ContentInsightsState>(key: K, id: string, value: ContentInsightsState[K] extends Record<string, infer V> ? V : never) =>
    set((s) => ({ [key]: { ...(s[key] as Record<string, unknown>), [id]: value } }) as Partial<ContentInsightsState>);
  const run = async <T extends object>(work: () => Promise<T>): Promise<InsightsResult<T>> => {
    try { return { ok: true, ...(await work()) }; } catch (error) { return failure(error); }
  };
  return {
    targetsByProject: {}, targetHistoryByProject: {}, insightsByProject: {}, insightsHistoryByProject: {}, notesConflictByProject: {},
    loadTargets: (id) => run(async () => { keep('targetsByProject', id, await contentApi.targets(id)); return {}; }),
    saveTargets: (id, platform, body) => run(async () => {
      const saved = await contentApi.saveTargets(id, platform, body);
      const current = get().targetsByProject[id];
      if (current) keep('targetsByProject', id, { ...current, targets: { ...current.targets, [platform]: saved.targets } });
      void get().loadTargetHistory(id);
      return {};
    }),
    loadTargetHistory: (id) => run(async () => { keep('targetHistoryByProject', id, (await contentApi.targetHistory(id)).entries); return {}; }),
    loadInsights: (id) => run(async () => { keep('insightsByProject', id, await contentApi.insights(id)); return {}; }),
    refreshInsights: (id) => run(async () => { await contentApi.refreshInsights(id); await get().loadInsights(id); return {}; }),
    stopInsights: (id) => run(async () => { await contentApi.stopInsights(id); await get().loadInsights(id); return {}; }),
    loadInsightsHistory: (id) => run(async () => { keep('insightsHistoryByProject', id, (await contentApi.insightsHistory(id)).entries); return {}; }),
    saveNotes: async (id, content, version) => {
      try {
        await contentApi.saveInsightsNotes(id, { content, version });
        set((s) => ({ notesConflictByProject: Object.fromEntries(Object.entries(s.notesConflictByProject).filter(([k]) => k !== id)) }));
        await get().loadInsights(id);
        return { ok: true };
      } catch (error) {
        const current = currentVersion(error);
        if (current) set((s) => ({ notesConflictByProject: { ...s.notesConflictByProject, [id]: current } }));
        return failure(error);
      }
    },
    clearNotesConflict: (id) => set((s) => ({ notesConflictByProject: Object.fromEntries(Object.entries(s.notesConflictByProject).filter(([k]) => k !== id)) })),
  };
});
