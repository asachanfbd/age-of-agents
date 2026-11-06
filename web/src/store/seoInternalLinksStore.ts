import { create } from 'zustand';
import { ApiError, serverApi } from '../lib/serverApi';
import { logParams } from '../lib/seoInternalLinks';
import type { CompareDto, CrawlLogDto, CrawlLogPageDto, CrawlSettingsDto, LogFilter, GraphDto, MatrixDto, OverviewDto, PageLinksDto } from '../lib/seoInternalLinks';
import { failure } from './seoStore';
import type { SeoResult } from './seoStore';

/**
 * What the Internal links tab shows for each SEO Building: the crawl overview (snapshots, latest run, rules), the graph of the
 * chosen snapshot, and the page, matrix and comparison views. Only the newest request of each kind may change what is shown.
 * A start that meets a running crawl (409) is not an error: the tab simply follows that run.
 */
export interface SeoInternalLinksState {
  overviewByProject: Record<string, OverviewDto>;
  snapshotByProject: Record<string, string | null>;
  graphByProject: Record<string, GraphDto | null>;
  pageByProject: Record<string, PageLinksDto | null>;
  matrixByProject: Record<string, MatrixDto | null>;
  compareByProject: Record<string, CompareDto | null>;
  crawlLogByProject: Record<string, CrawlLogDto | null>;
  crawlLogPageByProject: Record<string, CrawlLogPageDto | null>;
  loadOverview: (id: string) => Promise<SeoResult>;
  /** Refreshes only the run, and reloads the overview and graph when it has just finished. */
  pollRun: (id: string) => Promise<SeoResult>;
  selectSnapshot: (id: string, snapshot: string) => Promise<SeoResult>;
  startCrawl: (id: string, resume: boolean) => Promise<SeoResult>;
  stopCrawl: (id: string) => Promise<SeoResult>;
  saveSettings: (id: string, patch: Partial<CrawlSettingsDto>) => Promise<SeoResult>;
  loadPage: (id: string, url: string | null) => Promise<SeoResult>;
  loadMatrix: (id: string, rows: string[], cols: string[]) => Promise<SeoResult>;
  exportMatrix: (id: string, rows: string[], cols: string[], name: string) => Promise<SeoResult<{ csv: string; filename: string }>>;
  loadCompare: (id: string, from: string, to: string) => Promise<SeoResult>;
  loadCrawlLog: (id: string, filter: LogFilter, search: string) => Promise<SeoResult>;
  loadCrawlLogPage: (id: string, url: string | null) => Promise<SeoResult>;
  exportCrawlLog: (id: string, filter: LogFilter, search: string) => Promise<SeoResult<{ csv: string; filename: string }>>;
}

export const useSeoInternalLinksStore = create<SeoInternalLinksState>((set, get) => {
  const attempt = async <T extends object>(work: () => Promise<T>): Promise<SeoResult<T>> => {
    try { return { ok: true, ...(await work()) }; } catch (error) { return failure(error); }
  };
  const counters = new Map<string, number>();
  const newest = (kind: string, id: string) => { const key = `${kind}/${id}`; const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); return () => counters.get(key) === n; };
  const put = <K extends keyof SeoInternalLinksState>(field: K, id: string, value: unknown) =>
    set((s) => ({ [field]: { ...(s[field] as Record<string, unknown>), [id]: value } }) as Partial<SeoInternalLinksState>);

  const showSnapshot = async (id: string, snapshot: string | null) => {
    put('snapshotByProject', id, snapshot);
    put('pageByProject', id, null);
    put('matrixByProject', id, null);
    put('crawlLogByProject', id, null);
    put('crawlLogPageByProject', id, null);
    if (!snapshot) { put('graphByProject', id, null); return; }
    const isNewest = newest('graph', id);
    const graph = await serverApi.seoGraph(id, snapshot);
    if (isNewest()) put('graphByProject', id, graph);
  };

  return {
    overviewByProject: {}, snapshotByProject: {}, graphByProject: {}, pageByProject: {}, matrixByProject: {}, compareByProject: {}, crawlLogByProject: {}, crawlLogPageByProject: {},
    loadOverview: (id) => attempt(async () => {
      const overview = await serverApi.seoInternalLinks(id);
      put('overviewByProject', id, overview);
      const current = get().snapshotByProject[id];
      const keep = current && overview.snapshots.some((s) => s.id === current) ? current : overview.snapshots[0]?.id ?? null;
      if (keep !== current || !get().graphByProject[id]) await showSnapshot(id, keep);
      return {};
    }),
    pollRun: (id) => attempt(async () => {
      const before = get().overviewByProject[id]?.run?.status;
      const run = await serverApi.seoCrawlRun(id);
      const overview = get().overviewByProject[id];
      if (overview) put('overviewByProject', id, { ...overview, run });
      if (before === 'running' && run && run.status !== 'running') {
        const fresh = await serverApi.seoInternalLinks(id);
        put('overviewByProject', id, fresh);
        await showSnapshot(id, fresh.snapshots[0]?.id ?? null);
      }
      return {};
    }),
    selectSnapshot: (id, snapshot) => attempt(async () => { await showSnapshot(id, snapshot); return {}; }),
    startCrawl: (id, resume) => attempt(async () => {
      try {
        const run = await serverApi.seoStartCrawl(id, resume);
        const overview = get().overviewByProject[id];
        if (overview) put('overviewByProject', id, { ...overview, run });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || error.details.code !== 'crawl-running') throw error;
        await get().pollRun(id);
        await get().loadOverview(id);
      }
      return {};
    }),
    stopCrawl: (id) => attempt(async () => {
      const run = await serverApi.seoStopCrawl(id);
      const fresh = await serverApi.seoInternalLinks(id);
      put('overviewByProject', id, { ...fresh, run: run ?? fresh.run });
      await showSnapshot(id, fresh.snapshots[0]?.id ?? null);
      return {};
    }),
    saveSettings: (id, patch) => attempt(async () => {
      const settings = await serverApi.seoCrawlSettings(id, patch);
      const overview = get().overviewByProject[id];
      if (overview) put('overviewByProject', id, { ...overview, settings });
      return {};
    }),
    loadPage: (id, url) => {
      const isNewest = newest('page', id);
      const snapshot = get().snapshotByProject[id];
      if (!url || !snapshot) { put('pageByProject', id, null); return Promise.resolve({ ok: true }); }
      return attempt(async () => { const page = await serverApi.seoGraphPage(id, snapshot, url); if (isNewest()) put('pageByProject', id, page); return {}; });
    },
    loadMatrix: (id, rows, cols) => {
      const isNewest = newest('matrix', id);
      const snapshot = get().snapshotByProject[id];
      if (!snapshot) return Promise.resolve({ ok: true });
      return attempt(async () => { const matrix = await serverApi.seoMatrix(id, { snapshot, rows, cols }); if (isNewest()) put('matrixByProject', id, matrix); return {}; });
    },
    exportMatrix: (id, rows, cols, name) => attempt(() => serverApi.seoMatrixExport(id, { snapshot: get().snapshotByProject[id], rows, cols, name })),
    loadCompare: (id, from, to) => {
      const isNewest = newest('compare', id);
      return attempt(async () => { const diff = await serverApi.seoCompare(id, from, to); if (isNewest()) put('compareByProject', id, diff); return {}; });
    },
    loadCrawlLog: (id, filter, search) => {
      const isNewest = newest('crawl-log', id);
      const snapshot = get().snapshotByProject[id];
      if (!snapshot) return Promise.resolve({ ok: true });
      return attempt(async () => {
        const log = await serverApi.seoCrawlLog(id, logParams(snapshot, filter, search));
        if (isNewest() && get().snapshotByProject[id] === snapshot) put('crawlLogByProject', id, log);
        return {};
      });
    },
    loadCrawlLogPage: (id, url) => {
      const isNewest = newest('crawl-log-page', id);
      const snapshot = get().snapshotByProject[id];
      if (!url || !snapshot) { put('crawlLogPageByProject', id, null); return Promise.resolve({ ok: true }); }
      return attempt(async () => {
        const page = await serverApi.seoCrawlLogPage(id, snapshot, url);
        if (isNewest() && get().snapshotByProject[id] === snapshot) put('crawlLogPageByProject', id, page);
        return {};
      });
    },
    exportCrawlLog: (id, filter, search) => attempt(() => serverApi.seoCrawlLogExport(id, logParams(get().snapshotByProject[id] ?? '', filter, search))),
  };
});
