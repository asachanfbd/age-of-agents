import { create } from 'zustand';
import { serverApi } from '../lib/serverApi';
import type { AddResultDto, ClustersDto, KeywordControls, KeywordDetailDto, KeywordRowDto, ProposalsDto, RunDto, SuggestionDto } from '../lib/seoKeywords';
import { clustersParams, expandKey, keywordsParams, mergePage } from '../lib/seoKeywords';
import { failure } from './seoStore';
import type { SeoResult } from './seoStore';

type RunKind = 'cluster' | 'research';
export interface LoadedKeywords { total: number; rows: KeywordRowDto[] }

/**
 * What the Keywords tab shows for each SEO Building: cluster rows, the keywords loaded for each expanded cluster, the open
 * drill-down, the two runs and the review lists. Only the newest request of each kind may change what is shown, so a slow
 * older answer cannot overwrite a newer one. A move is shown at once and put back if the daemon refuses it.
 */
export interface SeoKeywordsState {
  clustersByProject: Record<string, ClustersDto>;
  keywordsByProject: Record<string, Record<string, LoadedKeywords>>;
  detailByProject: Record<string, KeywordDetailDto | null>;
  runsByProject: Record<string, Partial<Record<RunKind, RunDto | null>>>;
  suggestionsByProject: Record<string, SuggestionDto[]>;
  proposalsByProject: Record<string, ProposalsDto>;
  loadClusters: (id: string, controls: KeywordControls, rangeEnd: string | null, offset: number) => Promise<SeoResult>;
  /** Loads one page of a cluster's keywords (offset 0 replaces what was loaded; later offsets append). */
  loadClusterKeywords: (id: string, controls: KeywordControls, rangeEnd: string | null, cluster: string | null, offset: number) => Promise<SeoResult>;
  loadDetail: (id: string, key: string | null, controls: KeywordControls, range: { from: string; to: string } | null) => Promise<SeoResult>;
  loadRun: (id: string, kind: RunKind) => Promise<SeoResult>;
  startRun: (id: string, kind: RunKind, body?: object) => Promise<SeoResult>;
  stopRun: (id: string, kind: RunKind) => Promise<SeoResult>;
  loadSuggestions: (id: string) => Promise<SeoResult>;
  handleSuggestion: (id: string, suggestionId: string, action: 'apply' | 'dismiss') => Promise<SeoResult>;
  loadProposals: (id: string) => Promise<SeoResult>;
  decideProposals: (id: string, action: 'accept' | 'reject', ids: string[], clusterId?: string) => Promise<SeoResult>;
  moveKeywords: (id: string, keys: string[], clusterId: string | null) => Promise<SeoResult>;
  addKeywords: (id: string, keywords: string[]) => Promise<SeoResult<{ result: AddResultDto }>>;
  importCsv: (id: string, csv: string) => Promise<SeoResult<{ result: AddResultDto }>>;
  updateKeyword: (id: string, body: { key: string; status?: string; targetPage?: string | null }) => Promise<SeoResult>;
  clusterAction: (id: string, action: { type: 'create'; name: string } | { type: 'rename'; clusterId: string; name: string } | { type: 'delete'; clusterId: string } | { type: 'merge'; sourceIds: string[]; targetId: string } | { type: 'split'; clusterId: string; keys: string[]; name: string }) => Promise<SeoResult>;
  setMarket: (id: string, languageId: string, locationId: string) => Promise<SeoResult>;
  refreshVolumes: (id: string) => Promise<SeoResult<{ updated: number }>>;
}

export const useSeoKeywordsStore = create<SeoKeywordsState>((set, get) => {
  const attempt = async <T extends object>(work: () => Promise<T>): Promise<SeoResult<T>> => {
    try { return { ok: true, ...(await work()) }; } catch (error) { return failure(error); }
  };
  const counters = new Map<string, number>();
  const newest = (kind: string) => { const n = (counters.get(kind) ?? 0) + 1; counters.set(kind, n); return () => counters.get(kind) === n; };
  const put = <K extends keyof SeoKeywordsState>(field: K, id: string, value: SeoKeywordsState[K] extends Record<string, infer V> ? V : never) =>
    set((s) => ({ [field]: { ...(s[field] as Record<string, unknown>), [id]: value } }) as Partial<SeoKeywordsState>);

  return {
    clustersByProject: {}, keywordsByProject: {}, detailByProject: {}, runsByProject: {}, suggestionsByProject: {}, proposalsByProject: {},
    loadClusters: (id, controls, rangeEnd, offset) => {
      const isNewest = newest(`clusters:${id}`);
      return attempt(async () => { const data = await serverApi.seoClusters(id, clustersParams(controls, rangeEnd, offset)); if (isNewest()) put('clustersByProject', id, data); return {}; });
    },
    loadClusterKeywords: (id, controls, rangeEnd, cluster, offset) => {
      const key = expandKey(cluster);
      const isNewest = newest(`keywords:${id}:${key}`);
      return attempt(async () => {
        const data = await serverApi.seoKeywords(id, keywordsParams(controls, rangeEnd, key, offset));
        if (!isNewest()) return {};
        const loaded = get().keywordsByProject[id]?.[key]?.rows ?? [];
        set((s) => ({ keywordsByProject: { ...s.keywordsByProject, [id]: { ...s.keywordsByProject[id], [key]: { total: data.total, rows: offset === 0 ? data.rows : mergePage(loaded, data.rows, offset) } } } }));
        return {};
      });
    },
    loadDetail: (id, key, controls, range) => {
      const isNewest = newest(`detail:${id}`);
      if (!key) { put('detailByProject', id, null); return Promise.resolve({ ok: true }); }
      const params = new URLSearchParams({ compare: controls.compare ? 'previous' : 'none', ...(range ?? {}) });
      return attempt(async () => { const data = await serverApi.seoKeywordDetail(id, key, params); if (isNewest()) put('detailByProject', id, data); return {}; });
    },
    loadRun: (id, kind) => attempt(async () => { const run = await serverApi.seoKeywordRun(id, kind); set((s) => ({ runsByProject: { ...s.runsByProject, [id]: { ...s.runsByProject[id], [kind]: run } } })); return {}; }),
    startRun: (id, kind, body) => attempt(async () => { const run = await serverApi.seoStartKeywordRun(id, kind, body); set((s) => ({ runsByProject: { ...s.runsByProject, [id]: { ...s.runsByProject[id], [kind]: run } } })); return {}; }),
    stopRun: (id, kind) => attempt(async () => { const run = await serverApi.seoStopKeywordRun(id, kind); set((s) => ({ runsByProject: { ...s.runsByProject, [id]: { ...s.runsByProject[id], [kind]: run } } })); return {}; }),
    loadSuggestions: (id) => attempt(async () => { put('suggestionsByProject', id, (await serverApi.seoSuggestions(id)).suggestions); return {}; }),
    handleSuggestion: (id, suggestionId, action) => attempt(async () => { try { await serverApi.seoHandleSuggestion(id, suggestionId, action); } finally { await get().loadSuggestions(id); } return {}; }),
    loadProposals: (id) => attempt(async () => { put('proposalsByProject', id, await serverApi.seoProposals(id, 'all')); return {}; }),
    decideProposals: (id, action, ids, clusterId) => attempt(async () => {
      try { if (action === 'accept') await serverApi.seoAcceptProposals(id, ids, clusterId); else await serverApi.seoRejectProposals(id, ids); } finally { await get().loadProposals(id); }
      return {};
    }),
    moveKeywords: async (id, keys, clusterId) => {
      const before = get().keywordsByProject[id];
      const moving = new Set(keys);
      if (before) {
        const next = Object.fromEntries(Object.entries(before).map(([cluster, loaded]) => [cluster, { total: loaded.rows.filter((r) => !moving.has(r.key)).length === loaded.rows.length ? loaded.total : loaded.total - loaded.rows.filter((r) => moving.has(r.key)).length, rows: loaded.rows.filter((r) => !moving.has(r.key)) }]));
        set((s) => ({ keywordsByProject: { ...s.keywordsByProject, [id]: next } }));
      }
      const result = await attempt(async () => { await serverApi.seoMoveKeywords(id, keys, clusterId); return {}; });
      if (!result.ok && before) set((s) => ({ keywordsByProject: { ...s.keywordsByProject, [id]: before } }));
      return result;
    },
    addKeywords: (id, keywords) => attempt(async () => ({ result: await serverApi.seoAddKeywords(id, keywords) })),
    importCsv: (id, csv) => attempt(async () => ({ result: await serverApi.seoImportKeywords(id, csv) })),
    updateKeyword: (id, body) => attempt(async () => { await serverApi.seoUpdateKeyword(id, body); return {}; }),
    clusterAction: (id, a) => attempt(async () => {
      if (a.type === 'create') await serverApi.seoCreateCluster(id, a.name);
      else if (a.type === 'rename') await serverApi.seoRenameCluster(id, a.clusterId, a.name);
      else if (a.type === 'delete') await serverApi.seoDeleteCluster(id, a.clusterId);
      else if (a.type === 'merge') await serverApi.seoMergeClusters(id, a.sourceIds, a.targetId);
      else await serverApi.seoSplitCluster(id, a.clusterId, a.keys, a.name);
      return {};
    }),
    setMarket: (id, languageId, locationId) => attempt(async () => { await serverApi.seoSetKeywordMarket(id, languageId, locationId); return {}; }),
    refreshVolumes: (id) => attempt(() => serverApi.seoRefreshVolumes(id)),
  };
});
