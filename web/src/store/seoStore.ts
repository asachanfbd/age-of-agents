import { create } from 'zustand';
import { ApiError, serverApi } from '../lib/serverApi';
import type { PageDetailDto, PagesControls, PagesDto } from '../lib/seoPages';
import { pagesParams } from '../lib/seoPages';
import type { KeyFileDto, LogEntryDto, SitemapsDto, SubmitOutcomeDto, UrlRowDto } from '../lib/seoSitemaps';
import type { ConnectionsViewDto, DataStatusDto, DiscardPreviewDto } from '../lib/seoWorkspace';

/**
 * What the SEO workspace shows for each SEO Building: its connections and its data status. Actions hand a refused change
 * back with its status and reason so it appears where it happened. Secrets are only ever sent, never kept here.
 */
export type SeoResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string; requiresConfirmation: boolean };

export interface SeoState {
  connectionsByProject: Record<string, ConnectionsViewDto>;
  dataByProject: Record<string, DataStatusDto>;
  /** Buildings with a Sync now request in flight, so a double click sends one request. */
  syncRequesting: Record<string, boolean>;
  pagesByProject: Record<string, PagesDto>;
  pageDetailByProject: Record<string, PageDetailDto | null>;
  sitemapsByProject: Record<string, SitemapsDto>;
  urlsByProject: Record<string, { total: number; rows: UrlRowDto[] }>;
  keyFileByProject: Record<string, KeyFileDto>;
  logByProject: Record<string, LogEntryDto[]>;
  /** Buildings with a sitemap read in flight, so the button stays disabled and a second click sends nothing. */
  sitemapBusy: Record<string, boolean>;
  /** Only the newest Pages request may change what is shown; an older answer that arrives late is dropped. */
  loadPages: (id: string, controls: PagesControls, rangeEnd: string | null) => Promise<SeoResult>;
  loadPageDetail: (id: string, url: string | null, compare: boolean, range: { from: string; to: string } | null) => Promise<SeoResult>;
  loadSitemaps: (id: string) => Promise<SeoResult>;
  readSitemaps: (id: string, sitemap?: string) => Promise<SeoResult>;
  loadSitemapUrls: (id: string, params: URLSearchParams) => Promise<SeoResult>;
  inspectUrls: (id: string, urls: string[]) => Promise<SeoResult>;
  checkBing: (id: string, urls: string[], listParams: URLSearchParams) => Promise<SeoResult>;
  loadKeyFile: (id: string, force: boolean) => Promise<SeoResult>;
  /** Submits to IndexNow; the log is reloaded afterwards, and a failed submit changes nothing the caller holds (its selection stays). */
  submitIndexNow: (id: string, body: Parameters<typeof serverApi.seoIndexNowSubmit>[1]) => Promise<SeoResult<{ outcome: SubmitOutcomeDto }>>;
  loadLog: (id: string) => Promise<SeoResult>;
  loadConnections: (id: string) => Promise<SeoResult>;
  loadData: (id: string) => Promise<SeoResult>;
  syncNow: (id: string) => Promise<SeoResult>;
  syncOnOpen: (id: string) => Promise<SeoResult>;
  startConsent: (id: string, service: 'gsc' | 'ga4' | 'ads') => Promise<SeoResult<{ authUrl: string }>>;
  selectProperty: (id: string, service: 'gsc' | 'ga4', property: string, confirm: boolean) => Promise<SeoResult>;
  disconnect: (id: string, service: string) => Promise<SeoResult>;
  connectAds: (id: string, developerToken: string, customerId: string) => Promise<SeoResult<{ volume: 'exact' | 'range' | 'unknown'; message?: string }>>;
  connectBing: (id: string, apiKey: string) => Promise<SeoResult<{ message?: string }>>;
  saveIndexNow: (id: string, key?: string) => Promise<SeoResult>;
  setRetentionMonths: (id: string, months: number) => Promise<SeoResult>;
  setWarningBytes: (id: string, bytes: number) => Promise<SeoResult>;
  previewDiscard: (id: string) => Promise<SeoResult<{ preview: DiscardPreviewDto }>>;
  /** Discarding needs the notice acknowledged first; the acknowledgement is its own request, sent only when the person confirms. */
  acknowledgeAndDiscard: (id: string, acknowledged: boolean) => Promise<SeoResult>;
}

export function failure(error: unknown): SeoResult & { ok: false } {
  if (error instanceof ApiError) return { ok: false, status: error.status, error: error.message, requiresConfirmation: error.details?.requiresConfirmation === true };
  return { ok: false, status: 0, error: error instanceof Error ? error.message : 'The request failed', requiresConfirmation: false };
}

export const useSeoStore = create<SeoState>((set, get) => {
  const setConnections = (id: string, view: ConnectionsViewDto) => set((s) => ({ connectionsByProject: { ...s.connectionsByProject, [id]: view } }));
  const attempt = async <T extends object>(work: () => Promise<T>): Promise<SeoResult<T>> => {
    try { return { ok: true, ...(await work()) }; } catch (error) { return failure(error); }
  };
  const latest = { pages: new Map<string, number>(), detail: new Map<string, number>() };
  const newest = (kind: 'pages' | 'detail', id: string) => { const n = (latest[kind].get(id) ?? 0) + 1; latest[kind].set(id, n); return () => latest[kind].get(id) === n; };
  return {
    pagesByProject: {},
    pageDetailByProject: {},
    sitemapsByProject: {},
    urlsByProject: {},
    keyFileByProject: {},
    logByProject: {},
    sitemapBusy: {},
    loadPages: (id, controls, rangeEnd) => {
      const isNewest = newest('pages', id);
      return attempt(async () => { const data = await serverApi.seoPages(id, pagesParams(controls, rangeEnd)); if (isNewest()) set((s) => ({ pagesByProject: { ...s.pagesByProject, [id]: data } })); return {}; });
    },
    loadPageDetail: (id, url, compare, range) => {
      const isNewest = newest('detail', id);
      if (!url) { set((s) => ({ pageDetailByProject: { ...s.pageDetailByProject, [id]: null } })); return Promise.resolve({ ok: true }); }
      const params = new URLSearchParams({ compare: compare ? 'previous' : 'none', ...(range ?? {}) });
      return attempt(async () => {
        const data = await serverApi.seoPageDetail(id, url, params);
        if (isNewest()) set((s) => ({ pageDetailByProject: { ...s.pageDetailByProject, [id]: data } }));
        return {};
      });
    },
    loadSitemaps: (id) => attempt(async () => { const data = await serverApi.seoSitemaps(id); set((s) => ({ sitemapsByProject: { ...s.sitemapsByProject, [id]: data } })); return {}; }),
    readSitemaps: async (id, sitemap) => {
      if (get().sitemapBusy[id]) return { ok: true };
      set((s) => ({ sitemapBusy: { ...s.sitemapBusy, [id]: true } }));
      try { return await attempt(async () => { await serverApi.seoReadSitemaps(id, sitemap); await get().loadSitemaps(id); return {}; }); } finally { set((s) => ({ sitemapBusy: { ...s.sitemapBusy, [id]: false } })); }
    },
    loadSitemapUrls: (id, params) => attempt(async () => { const data = await serverApi.seoSitemapUrls(id, params); set((s) => ({ urlsByProject: { ...s.urlsByProject, [id]: { total: data.total, rows: data.rows } } })); return {}; }),
    inspectUrls: (id, urls) => attempt(async () => { await serverApi.seoInspect(id, urls); await get().loadSitemaps(id); return {}; }),
    checkBing: (id, urls, listParams) => attempt(async () => { await serverApi.seoBingCheck(id, urls); await get().loadSitemapUrls(id, listParams); return {}; }),
    loadKeyFile: (id, force) => attempt(async () => { const data = await serverApi.seoKeyCheck(id, force); set((s) => ({ keyFileByProject: { ...s.keyFileByProject, [id]: data } })); return {}; }),
    submitIndexNow: (id, body) => attempt(async () => { const outcome = await serverApi.seoIndexNowSubmit(id, body); await get().loadLog(id); return { outcome }; }),
    loadLog: (id) => attempt(async () => { const data = await serverApi.seoIndexNowLog(id); set((s) => ({ logByProject: { ...s.logByProject, [id]: data.entries } })); return {}; }),
    connectionsByProject: {},
    dataByProject: {},
    syncRequesting: {},
    loadConnections: (id) => attempt(async () => { setConnections(id, await serverApi.seoConnections(id)); return {}; }),
    loadData: (id) => attempt(async () => { const data = await serverApi.seoData(id); set((s) => ({ dataByProject: { ...s.dataByProject, [id]: data } })); return {}; }),
    syncNow: async (id) => {
      if (get().syncRequesting[id]) return { ok: true };
      set((s) => ({ syncRequesting: { ...s.syncRequesting, [id]: true } }));
      try {
        return await attempt(async () => { await serverApi.seoSyncNow(id); await Promise.all([get().loadConnections(id), get().loadData(id)]); return {}; });
      } finally {
        set((s) => ({ syncRequesting: { ...s.syncRequesting, [id]: false } }));
      }
    },
    syncOnOpen: (id) => attempt(async () => { await serverApi.seoSyncOnOpen(id); return {}; }),
    startConsent: (id, service) => attempt(() => serverApi.seoStartConsent(id, service)),
    selectProperty: (id, service, property, confirm) => attempt(async () => { setConnections(id, await serverApi.seoSelectProperty(id, service, property, confirm)); return {}; }),
    disconnect: (id, service) => attempt(async () => { setConnections(id, await serverApi.seoDisconnect(id, service)); return {}; }),
    connectAds: (id, developerToken, customerId) => attempt(async () => {
      const result = await serverApi.seoConnectAds(id, developerToken, customerId);
      setConnections(id, result.connections);
      return { volume: result.volume, message: result.message };
    }),
    connectBing: (id, apiKey) => attempt(async () => {
      const result = await serverApi.seoConnectBing(id, apiKey);
      setConnections(id, result.connections);
      return { message: result.message };
    }),
    saveIndexNow: (id, key) => attempt(async () => { setConnections(id, await serverApi.seoSaveIndexNow(id, key)); return {}; }),
    setRetentionMonths: (id, months) => attempt(async () => { const data = await serverApi.seoSetData(id, { retentionMonths: months }); set((s) => ({ dataByProject: { ...s.dataByProject, [id]: data } })); return {}; }),
    setWarningBytes: (id, bytes) => attempt(async () => { const data = await serverApi.seoSetData(id, { warningBytes: bytes }); set((s) => ({ dataByProject: { ...s.dataByProject, [id]: data } })); return {}; }),
    previewDiscard: (id) => attempt(async () => ({ preview: await serverApi.seoDiscardPreview(id) })),
    acknowledgeAndDiscard: (id, acknowledged) => attempt(async () => {
      if (!acknowledged) throw new Error('Read and confirm the notice before discarding');
      await serverApi.seoAcknowledgeDiscard(id);
      await serverApi.seoDiscard(id);
      await get().loadData(id);
      return {};
    }),
  };
});
