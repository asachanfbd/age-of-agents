/**
 * The SEO Internal links routes of the daemon stand-in (server/src/api/seoRoutes.ts, server/src/seo/crawl/), kept apart from
 * serverStub.mjs. It keeps one in-memory crawl state per Building: snapshots, a run, a graph and the requests received.
 * `il.conflictOnStart` makes a start answer 409 with the running crawl's id, as the daemon does.
 */
export function seoLinksState(st) {
  st.il ??= { snapshots: [], run: null, graph: null, requests: [], conflictOnStart: false, settings: { pageCap: 3000, requestsPerSecond: 2, timeoutSeconds: 15, pageSizeMb: 2 }, matrix: null };
  return st.il;
}

export const snapshotDto = (patch = {}) => ({
  id: 's-one', startedAt: '2026-10-14T09:00:00.000Z', finishedAt: '2026-10-14T09:10:00.000Z', status: 'complete', stopReason: null, capped: false, incomplete: false, host: 'example.com', seededFrom: 'sitemaps',
  settings: { pageCap: 3000, requestsPerSecond: 2, timeoutSeconds: 15, pageSizeMb: 2 }, stats: { pages: 3, fetched: 3, failed: 0, blockedByRobots: 0, skippedUrlSpace: 0, links: 2, externalLinks: 0, uncrawledLinks: 0 }, ...patch,
});

export const node = (path, patch = {}) => ({ url: `https://example.com${path}`, path, section: path.split('/')[1] || 'home', status: 200, error: null, depth: 1, inbound: 1, outbound: 1, noindex: false, canonicalElsewhere: false, inSitemap: true, orphan: false, title: null, ...patch });

export async function seoLinksRoute(st, method, rest, body, params) {
  if (!rest.startsWith('internal-links')) return null;
  const il = seoLinksState(st);
  il.requests.push({ method, rest, body, query: params.toString() });
  const ok = (value, status = 200) => ({ status, body: value });
  const sub = rest.slice('internal-links'.length);

  if (method === 'GET' && sub === '') {
    return ok({ host: 'example.com', snapshots: il.snapshots, run: il.run, settings: il.settings, defaults: il.settings, ranges: {
      pageCap: { min: 1, max: 10000, label: 'Page cap', whole: true }, requestsPerSecond: { min: 0.1, max: 10, label: 'Requests per second', whole: false },
      timeoutSeconds: { min: 1, max: 60, label: 'Timeout (seconds)', whole: true }, pageSizeMb: { min: 0.1, max: 10, label: 'Page size limit (MB)', whole: false },
    } });
  }
  if (method === 'PUT' && sub === '/settings') {
    if (body.pageCap !== undefined && (body.pageCap < 1 || body.pageCap > 10000)) return ok({ error: 'Page cap must be a whole number from 1 to 10000' }, 400);
    il.settings = { ...il.settings, ...body };
    return ok(il.settings);
  }
  if (method === 'POST' && sub === '/crawl') {
    if (il.conflictOnStart) return ok({ error: 'A crawl is already running', code: 'crawl-running', details: { runId: 'r-1' } }, 409);
    il.run = { runId: 'r-2', snapshotId: 's-two', status: 'running', startedAt: '2026-10-14T10:00:00.000Z', finishedAt: null, fetched: 0, queued: 1, failed: 0, error: null, resumable: false };
    return ok(il.run, 202);
  }
  if (method === 'GET' && sub === '/crawl') return ok(il.run);
  if (method === 'POST' && sub === '/crawl/stop') {
    if (il.run?.status === 'running') il.run = { ...il.run, status: 'stopped', resumable: true, finishedAt: '2026-10-14T10:05:00.000Z' };
    return ok(il.run);
  }
  if (method === 'GET' && sub === '/graph') return il.graph ? ok(il.graph) : ok({ error: 'No crawl has finished yet' }, 404);
  if (method === 'GET' && sub === '/page') {
    const n = il.graph.nodes.find((x) => x.url === params.get('url'));
    return ok({ snapshot: il.snapshots[0], page: { ...n, description: null, canonical: null, externalLinks: 2, fetchedAt: '' }, linkedFrom: { total: 1, links: [{ url: 'https://example.com/', path: '/', anchor: 'Home link', location: 'nav', nofollow: false, via: null, broken: false }] }, linksTo: { total: 0, links: [] }, redirectsFrom: [] });
  }
  if (method === 'GET' && (sub === '/log' || sub === '/log/export')) {
    await il.logGate?.(params);
    return ok(il.crawlLog ?? { error: 'No crawl has finished yet' }, il.crawlLog ? 200 : 404);
  }
  if (method === 'GET' && sub === '/log/page') return il.crawlLogPage ? ok(il.crawlLogPage(params.get('url'))) : ok({ error: 'That page is not in this crawl' }, 404);
  if (method === 'POST' && sub === '/matrix') return ok(il.matrix ?? { snapshot: il.snapshots[0], rows: [], cols: [], cells: [], rowTotals: [], colTotals: [] });
  if (method === 'GET' && sub === '/compare') {
    if (il.snapshots.length < 2) return ok({ error: 'Comparing needs two crawls; only one exists so far' }, 409);
    return ok({ from: il.snapshots[1], to: il.snapshots[0], pagesAdded: { total: 1, items: ['https://example.com/new'] }, pagesRemoved: { total: 0, items: [] }, statusChanged: { total: 0, items: [] }, linksAdded: { total: 0, items: [] }, linksRemoved: { total: 0, items: [] } });
  }
  return null;
}

export const logRow = (n, path, patch = {}) => ({ n, url: `https://example.com${path}`, from: 'sitemap', status: 200, contentType: 'text/html', redirectTo: null, selfRedirect: false, error: null, internalLinks: 2, externalLinks: 1, ...patch });

export const crawlLogDto = (rows, patch = {}) => ({
  snapshot: snapshotDto(),
  summary: { requested: rows.length, ok: 1, redirected: 1, failed: 1, internalLinks: 4, externalLinks: 2 },
  counts: { all: rows.length, redirects: 1, 'http-errors': 1, errors: 0, 'self-redirects': 0, 'zero-links': 0 },
  matched: rows.length, rows, ...patch,
});
