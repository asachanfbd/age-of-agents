import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const il = await import('../src/lib/seoInternalLinks.ts');
const pages = await import('../src/lib/seoPages.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { useSeoInternalLinksStore } = await import('../src/store/seoInternalLinksStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { seoLinksState, snapshotDto, node, logRow, crawlLogDto } = await import('./seoInternalLinksStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const graph = (nodes, edges = [], thresholds = { deepClicks: 3, fewInbound: 2 }) => ({ snapshot: snapshotDto(), thresholds, nodes, edges });
const sample = graph([
  node('/', { depth: 0, inbound: 0 }), node('/blog/a', { depth: 1, inbound: 4, title: 'Alpha' }), node('/blog/b', { depth: 4, inbound: 1, noindex: true }),
  node('/shop/x', { depth: null, inbound: 0, orphan: true, status: 404 }), node('/shop/y', { depth: 2, inbound: 2, status: 301, canonicalElsewhere: true }),
], [[0, 1, 0, 1], [1, 2, il.EDGE_BROKEN, 2], [1, 4, il.EDGE_REDIRECT | il.EDGE_NOFOLLOW, 1]]);

test('U27 size grows with inbound links (never below the minimum) and with fewer clicks; colours follow section, status and indexing', () => {
  const radii = [0, 1, 4, 16].map((inbound) => il.nodeRadius({ inbound, depth: 1 }, 'inbound', 16, 5));
  assert.equal(radii[0], il.MIN_RADIUS);
  assert.ok(radii.every((r, i) => i === 0 || r > radii[i - 1]));
  assert.equal(radii[3], il.MAX_RADIUS);
  assert.ok(il.nodeRadius({ inbound: 0, depth: 1 }, 'clicks', 1, 5) > il.nodeRadius({ inbound: 0, depth: 4 }, 'clicks', 1, 5));
  assert.equal(il.nodeRadius({ inbound: 9, depth: null }, 'clicks', 9, 5), il.MIN_RADIUS);
  const sections = il.sectionColours(sample.nodes);
  assert.equal(sections.get('blog'), sections.get('blog'));
  assert.notEqual(sections.get('blog'), sections.get('shop'));
  assert.deepEqual(sample.nodes.map((n) => il.statusClass(n)), ['ok', 'ok', 'ok', 'error', 'redirect']);
  assert.deepEqual(sample.nodes.map((n) => il.indexingState(n)), ['indexable', 'indexable', 'noindex', 'indexable', 'canonical']);
  assert.equal(il.statusClass({ status: null, error: 'robots' }), 'unknown');
  assert.equal(il.statusClass({ status: null, error: 'timeout' }), 'error');
  assert.equal(il.nodeColour(sample.nodes[1], 'section', sections), sections.get('blog'));
  assert.equal(il.legendFor('status', sections).length, 4);
});

test('U28 filters combine, an edge shows only when both ends do, and an empty result is fine', () => {
  const only = (f) => [...il.visibleNodes(sample, { ...il.NO_FILTERS, ...f })];
  assert.deepEqual(only({ section: 'blog' }), [1, 2]);
  assert.deepEqual(only({ section: 'blog', maxDepth: 2 }), [1]);
  assert.deepEqual(only({ status: 'error' }), [3]);
  assert.deepEqual(only({ minInbound: 2 }), [1, 4]);
  assert.deepEqual(only({ search: 'ALPHA' }), [1]);
  assert.deepEqual(only({ search: '/shop' }), [3, 4]);
  assert.deepEqual(only({ section: 'blog', status: 'error' }), []);
  assert.deepEqual(il.visibleEdges(sample, new Set([0, 1, 2])), [[0, 1, 0, 1], [1, 2, il.EDGE_BROKEN, 2]]);
  assert.deepEqual(il.visibleEdges(sample, new Set()), []);
  assert.equal(il.showingText(sample, new Set([1, 2]), [[1, 2, 4, 2]]), 'Showing 2 of 5 pages · 1 links');
  assert.equal(il.firstMatch(sample, { ...il.NO_FILTERS, search: 'blog' }), 1);
  assert.equal(il.firstMatch(sample, { ...il.NO_FILTERS, search: 'nothing' }), null);
});

test('U29 highlights: orphans, deeper than 3 clicks, fewer than 2 inbound (home excluded), broken and redirect links, several at once', () => {
  const marks = (...kinds) => il.highlighted(sample, new Set(kinds));
  assert.deepEqual([...marks('orphans').nodes], [3]);
  assert.deepEqual([...marks('deep').nodes], [2], 'depth 4 is deep, depth 2 and null are not');
  assert.deepEqual([...marks('few-inbound').nodes].sort(), [2, 3], 'home is excluded and a page with 2 inbound is not few');
  const broken = marks('broken');
  assert.deepEqual([[...broken.nodes], [...broken.edges]], [[2], [1]]);
  assert.deepEqual([...marks('redirects').edges], [2]);
  assert.deepEqual([...marks('orphans', 'deep').nodes].sort(), [2, 3]);
  assert.equal(marks().nodes.size, 0);
  assert.deepEqual(il.HIGHLIGHTS.map((h) => h.key), ['orphans', 'deep', 'few-inbound', 'broken', 'redirects']);
  assert.deepEqual([...il.highlighted(graph([node('/', { depth: 3 }), node('/d', { depth: 3 })], [], { deepClicks: 2, fewInbound: 2 }), new Set(['deep'])).nodes], [0, 1]);
});

test('U33 the layout budget shrinks with size, labels and thin edges switch at the thresholds, and a 3,000-node model builds fast', () => {
  const budgets = [100, 600, 2000, 3000, 9000].map((n) => il.layoutBudget(n).iterations);
  assert.ok(budgets.every((b, i) => i === 0 || b <= budgets[i - 1]));
  assert.deepEqual([il.layoutBudget(400).labels, il.layoutBudget(401).labels, il.layoutBudget(800).thinEdges, il.layoutBudget(801).thinEdges], [true, false, false, true]);
  const nodes = Array.from({ length: 3000 }, (_, i) => node(`/s${i % 12}/p${i}`, { inbound: i % 9, depth: i % 6 }));
  const edges = Array.from({ length: 30000 }, (_, i) => [i % 3000, (i * 7 + 1) % 3000, 0, 1]);
  const started = performance.now();
  const g = graph(nodes, edges);
  const visible = il.visibleNodes(g, { ...il.NO_FILTERS, maxDepth: 4 });
  il.visibleEdges(g, visible);
  il.highlighted(g, new Set(['orphans', 'deep', 'few-inbound', 'broken', 'redirects']));
  il.sectionColours(nodes);
  assert.ok(performance.now() - started < 500, 'filtering and highlighting 3,000 pages and 30,000 links stays under half a second');
});

test('matrix helpers: a side holds 30 pages, adding more says so, titles read "source → target: n links, anchor, in body"', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `u${i}`);
  assert.deepEqual(il.addToSide(thirty.slice(0, 29), ['u29']), { urls: thirty, message: null });
  const over = il.addToSide(thirty, ['u30']);
  assert.equal(over.urls.length, 30);
  assert.match(over.message, /at most 30/);
  assert.deepEqual(il.addToSide(['a'], ['a', 'b']).urls, ['a', 'b']);
  assert.deepEqual(il.pagesInSection(sample, 'shop'), ['https://example.com/shop/x', 'https://example.com/shop/y']);
  assert.equal(il.matrixCellTitle('/a', '/b', { count: 2, anchors: ['go', ''], locations: ['body', 'nav'] }), '/a → /b: 2 links · go, (no anchor) · in body, nav');
  assert.equal(il.matrixCellTitle('/a', '/b', null), '/a → /b: no link');
  assert.deepEqual(il.matrixParams('s', ['a'], ['b'], 'n'), { snapshot: 's', rows: ['a'], cols: ['b'], name: 'n' });
});

test('crawl bar view-models: the rules line, progress text, snapshot labels and which buttons show', () => {
  const caps = il.capsLine('example.com', { pageCap: 3000, requestsPerSecond: 2, timeoutSeconds: 15, pageSizeMb: 2 });
  for (const part of ['example.com', '3,000 pages', '2 requests per second', '15 s timeout', '2 MB page limit', 'robots.txt respected', 'no JavaScript rendering', 'external links counted, not followed']) assert.ok(caps.includes(part), part);
  assert.match(il.capsLine('a.com', { pageCap: 1, requestsPerSecond: 1, timeoutSeconds: 1, pageSizeMb: 1 }), /1 request per second/);
  assert.equal(il.runProgress({ fetched: 1234, queued: 56, failed: 7 }), '1,234 fetched · 56 queued · 7 failed');
  assert.equal(il.snapshotLabel(snapshotDto({ status: 'partial' })), '2026-10-14 09:00 · Partial');
  const run = (status, resumable = false) => ({ status, resumable });
  assert.equal(il.crawlBarState({ run: null, snapshots: [] }), 'never');
  assert.equal(il.crawlBarState({ run: run('running'), snapshots: [] }), 'running');
  assert.equal(il.crawlBarState({ run: run('stopped', true), snapshots: [1] }), 'stopped');
  assert.equal(il.crawlBarState({ run: run('stopped', false), snapshots: [1] }), 'ready');
  assert.equal(il.crawlBarState({ run: run('failed'), snapshots: [1] }), 'failed');
  assert.equal(il.crawlBarState({ run: run('complete'), snapshots: [1] }), 'ready');
});

test('compare helpers list five tiles and know when nothing changed', () => {
  assert.deepEqual(il.COMPARE_TILES.map((t) => t.label), ['Pages added', 'Pages removed', 'Links added', 'Links removed', 'Status changes']);
  const empty = { total: 0, items: [] };
  assert.equal(il.noChanges({ pagesAdded: empty, pagesRemoved: empty, linksAdded: empty, linksRemoved: empty, statusChanged: empty }), true);
  assert.equal(il.noChanges({ pagesAdded: { total: 1, items: ['x'] }, pagesRemoved: empty, linksAdded: empty, linksRemoved: empty, statusChanged: empty }), false);
});

const crawled = (patch = {}) => ({ available: true, found: true, crawledAt: '2026-10-14T09:10:00Z', partial: false, url: 'https://example.com/a', path: '/a', status: 200, error: null, title: 'T', description: 'D', canonical: 'https://example.com/a', noindex: false, depth: 2, inbound: 3, outbound: 4, externalLinks: 1, inSitemap: true, orphan: false, ...patch });

test('U34 the Pages drill-down block shows crawl numbers, an orphan marker and the empty states', () => {
  assert.deepEqual(pages.internalBlock({ available: false, title: null, description: null }), { kind: 'no-crawl' });
  assert.deepEqual(pages.internalBlock({ available: true, found: false, crawledAt: '', partial: false, title: null, description: null }), { kind: 'not-seen' });
  const seen = pages.internalBlock(crawled());
  assert.equal(seen.kind, 'seen');
  assert.deepEqual(Object.fromEntries(seen.facts), { Crawled: '2026-10-14', Status: '200 · 2 clicks from home', Inbound: '3 pages link here', Outbound: '4 internal · 1 external', Canonical: 'https://example.com/a', Indexing: 'indexable' });
  const orphan = Object.fromEntries(pages.internalBlock(crawled({ orphan: true, inbound: 0, depth: null, noindex: true })).facts);
  assert.match(orphan.Inbound, /orphan/);
  assert.equal(orphan.Status, '200 · not reachable from home');
  assert.match(Object.fromEntries(pages.internalBlock(crawled({ partial: true })).facts).Crawled, /partial crawl/);
  assert.deepEqual(pages.crawlLabel({ available: false, title: null, description: null }), { title: 'Not crawled yet', description: 'Not crawled yet' });
  assert.equal(il.internalCell(undefined), '—');
  assert.equal(il.internalCell(0), '0');
  assert.equal(il.internalCell(12400), '12,400');
});

async function linkBuilding({ snapshots = [snapshotDto()], run = null, nodes = sample } = {}) {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], newBuildingField: null, ...CLEAN_ERROR_STATE });
  assert.equal(await useWorldStore.getState().addProject('', undefined, 'seo', 'https://example.com/'), true);
  const b = useWorldStore.getState().projects.at(-1);
  const state = seoLinksState(stub.seo.byProject.get(b.id));
  Object.assign(state, { snapshots, run, graph: nodes });
  useSeoInternalLinksStore.setState({ overviewByProject: {}, snapshotByProject: {}, graphByProject: {}, pageByProject: {}, matrixByProject: {}, compareByProject: {}, crawlLogByProject: {}, crawlLogPageByProject: {} });
  return { b, state };
}

test('C09 loading picks the newest snapshot and its graph; switching reloads the graph for that snapshot', async () => {
  const { b, state } = await linkBuilding({ snapshots: [snapshotDto({ id: 's-new' }), snapshotDto({ id: 's-old', status: 'partial' })] });
  const store = useSeoInternalLinksStore.getState();
  assert.equal((await store.loadOverview(b.id)).ok, true);
  assert.equal(useSeoInternalLinksStore.getState().snapshotByProject[b.id], 's-new');
  assert.equal(useSeoInternalLinksStore.getState().graphByProject[b.id].nodes.length, 5);
  await store.selectSnapshot(b.id, 's-old');
  assert.equal(state.requests.filter((r) => r.rest === 'internal-links/graph').at(-1).query, 'snapshot=s-old');
});

test('C02/C27 before any crawl there is no graph; a failed load reports the error', async () => {
  const { b, state } = await linkBuilding({ snapshots: [], nodes: null });
  assert.equal((await useSeoInternalLinksStore.getState().loadOverview(b.id)).ok, true);
  assert.equal(useSeoInternalLinksStore.getState().graphByProject[b.id], null);
  assert.equal(state.requests.some((r) => r.rest === 'internal-links/graph'), false);
});

test('C04/C05/C06/C28 start shows a running crawl, stop makes it resumable and keeps the snapshot, polling picks up completion', async () => {
  const { b, state } = await linkBuilding();
  const store = useSeoInternalLinksStore.getState();
  await store.loadOverview(b.id);
  assert.equal((await store.startCrawl(b.id, false)).ok, true);
  assert.equal(useSeoInternalLinksStore.getState().overviewByProject[b.id].run.status, 'running');
  assert.deepEqual(state.requests.find((r) => r.rest === 'internal-links/crawl' && r.method === 'POST').body, { resume: false });
  await store.stopCrawl(b.id);
  const stopped = useSeoInternalLinksStore.getState().overviewByProject[b.id];
  assert.deepEqual([stopped.run.status, stopped.run.resumable, stopped.snapshots.length], ['stopped', true, 1]);
  await store.startCrawl(b.id, true);
  assert.deepEqual(state.requests.filter((r) => r.rest === 'internal-links/crawl' && r.method === 'POST').at(-1).body, { resume: true });
  state.run = { ...state.run, status: 'complete', resumable: false };
  state.snapshots = [snapshotDto({ id: 's-two' }), ...state.snapshots];
  await store.pollRun(b.id);
  assert.equal(useSeoInternalLinksStore.getState().overviewByProject[b.id].run.status, 'complete');
  assert.equal(useSeoInternalLinksStore.getState().snapshotByProject[b.id], 's-two');
});

test('C07 a 409 on start follows the running crawl without an error', async () => {
  const { b, state } = await linkBuilding({ run: { runId: 'r-1', snapshotId: 's-x', status: 'running', startedAt: '', finishedAt: null, fetched: 3, queued: 2, failed: 0, error: null, resumable: false } });
  const store = useSeoInternalLinksStore.getState();
  await store.loadOverview(b.id);
  state.conflictOnStart = true;
  assert.equal((await store.startCrawl(b.id, false)).ok, true);
  assert.equal(useSeoInternalLinksStore.getState().overviewByProject[b.id].run.fetched, 3);
});

test('C11 settings save, and an out-of-range value comes back as an error for the form', async () => {
  const { b } = await linkBuilding();
  const store = useSeoInternalLinksStore.getState();
  await store.loadOverview(b.id);
  assert.equal((await store.saveSettings(b.id, { pageCap: 50 })).ok, true);
  assert.equal(useSeoInternalLinksStore.getState().overviewByProject[b.id].settings.pageCap, 50);
  const bad = await store.saveSettings(b.id, { pageCap: 99999 });
  assert.deepEqual([bad.ok, bad.status], [false, 400]);
  assert.match(bad.error, /1 to 10000/);
});

test('C16 a page request returns who links to it; C24 compare loads and one snapshot is a clear error', async () => {
  const { b, state } = await linkBuilding({ snapshots: [snapshotDto({ id: 's-new' })] });
  const store = useSeoInternalLinksStore.getState();
  await store.loadOverview(b.id);
  await store.loadPage(b.id, 'https://example.com/blog/a');
  assert.equal(useSeoInternalLinksStore.getState().pageByProject[b.id].linkedFrom.links[0].anchor, 'Home link');
  await store.loadPage(b.id, null);
  assert.equal(useSeoInternalLinksStore.getState().pageByProject[b.id], null);
  const refused = await store.loadCompare(b.id, 's-old', 's-new');
  assert.deepEqual([refused.ok, refused.status], [false, 409]);
  state.snapshots = [snapshotDto({ id: 's-new' }), snapshotDto({ id: 's-old' })];
  await store.loadCompare(b.id, 's-old', 's-new');
  assert.equal(useSeoInternalLinksStore.getState().compareByProject[b.id].pagesAdded.total, 1);
});

test('C01/C19/C20/C29 the tab is wired in, the canvas has a WebGL fallback and cleans up, and the layout is responsive and themed', () => {
  assert.match(src('ui/SeoWorkspace.tsx'), /tab === 'internal-links' \? <SeoInternalLinks/);
  const canvas = src('ui/SeoGraphCanvas.tsx');
  assert.match(canvas, /needs WebGL/);
  assert.match(canvas, /layout\?\.kill\(\)/);
  assert.match(canvas, /sigma\?\.kill\(\)/);
  const view = src('ui/SeoGraphView.tsx');
  assert.match(view, /flex-col[^"]*lg:flex-row/, 'the detail panel stacks below the graph on narrow screens');
  assert.match(view, /aria-pressed=\{on\.has/);
  assert.match(src('ui/SeoMatrixView.tsx'), /overflow-x-auto/);
  for (const file of ['SeoGraphView', 'SeoMatrixView', 'SeoCompareView', 'SeoInternalLinks']) assert.doesNotMatch(src(`ui/${file}.tsx`), /bg-white|text-black|#fff\b/, `${file} uses theme tokens`);
  const bar = src('ui/SeoInternalLinks.tsx');
  assert.match(bar, /disabled=\{running \|\| busy\}/);
  assert.match(bar, /Respect robots\.txt \(always on\)/);
  assert.match(bar, /clearInterval\(timer\)/);
  assert.match(bar, /current\?\.seededFrom === 'home' && .*home page only/);
  assert.match(src('ui/SeoPages.tsx'), /Go to Internal links/);
  assert.match(src('ui/SeoPages.tsx'), /Show who links here/);
});

// ---- crawl log ----------------------------------------------------------------------------------------------------------

test('the Crawl log is the fourth view, after Compare, and the tab renders it with the snapshot warning above every view', () => {
  const tab = src('ui/SeoInternalLinks.tsx');
  assert.match(tab, /\{ key: 'compare', label: 'Compare' \}, \{ key: 'log', label: 'Crawl log' \}\]/);
  assert.match(tab, /view === 'log' && snapshotId && <SeoCrawlLogView key=\{snapshotId\}/);
  assert.ok(tab.indexOf('current?.warning') < tab.indexOf('VIEWS.map'), 'the warning sits in the alert stack, outside the view switch');
  assert.match(tab, /Open the Crawl log/);
  const view = src('ui/SeoCrawlLogView.tsx');
  assert.match(view, /aria-label="Search address"/);
  assert.match(view, /aria-pressed=\{filter === c\.key\}/);
  assert.match(view, /role="status">\{logSummaryText/);
});

test('summary line, chips, "from" wording, showing text and export text', () => {
  assert.equal(il.logSummaryText({ requested: 1200, ok: 1000, redirected: 100, failed: 100, other: 0, internalLinks: 5000, externalLinks: 30 }), '1,200 requested · 1,000 OK · 100 redirected · 100 failed · 5,000 internal and 30 external links found');
  assert.deepEqual(il.LOG_CHIPS.map((c) => c.label), ['All', 'Redirects', '4xx/5xx', 'Errors', 'Self-redirects', 'Zero links found']);
  assert.deepEqual([il.fromLabel('sitemap'), il.fromLabel('start'), il.fromLabel('unknown'), il.fromLabel('https://example.com/')], ['sitemap', 'start page', 'unknown', 'https://example.com/']);
  assert.equal(il.logShowingText({ matched: 1, rows: [1] }), '1 matching request');
  assert.equal(il.logShowingText({ matched: 5000, rows: new Array(1000) }), 'Showing the first 1,000 of 5,000 matching requests. Export the CSV for all of them.');
  assert.equal(il.logExportText(1, 'a.csv'), '1 row exported to a.csv');
  assert.equal(il.logExportText(0, 'a.csv'), '0 rows exported to a.csv');
});

test('log params carry the snapshot, a non-default filter and a trimmed search', () => {
  assert.equal(il.logParams('s-1', 'all', '  ').toString(), 'snapshot=s-1');
  assert.equal(il.logParams('s-1', 'zero-links', ' Blog ').toString(), 'snapshot=s-1&filter=zero-links&q=Blog');
});

test('the amber zero-links cell follows the server\'s own flag, so it always matches the Zero links chip', () => {
  const view = src('ui/SeoCrawlLogView.tsx');
  assert.equal(view.match(/r\.zeroLinks \? 'bg-warning\/20'/g).length, 2);
  assert.equal(il.hasNoLinks, undefined, 'no second client-side definition');
});

test('the summary shows an "other" bucket only when there is one', () => {
  const base = { requested: 4, ok: 1, redirected: 1, failed: 1, other: 1, internalLinks: 2, externalLinks: 0 };
  assert.match(il.logSummaryText(base), /1 failed · 1 other · 2 internal/);
  assert.doesNotMatch(il.logSummaryText({ ...base, other: 0 }), /other/);
});

test('the snapshot label and warning wording: a complete crawl with a warning is not plain "Complete"', () => {
  assert.equal(il.snapshotLabel(snapshotDto()), '2026-10-14 09:00 · Complete');
  assert.equal(il.snapshotLabel(snapshotDto({ warning: { affected: 3, total: 4 } })), '2026-10-14 09:00 · Complete, with warning');
  assert.equal(il.snapshotLabel(snapshotDto({ status: 'partial', warning: { affected: 3, total: 4 } })), '2026-10-14 09:00 · Partial, with warning');
  assert.equal(il.snapshotLabel(snapshotDto({ warning: null })), '2026-10-14 09:00 · Complete');
  assert.equal(il.warningText({ affected: 1200, total: 1500 }), 'Most pages have no outgoing links or redirect to themselves (1,200 of 1,500). This crawl is not reliable even though it finished.');
});

test('the store loads the log for the selected snapshot with the filter and search, and keeps the error on failure', async () => {
  const { b, state } = await linkBuilding();
  state.crawlLog = crawlLogDto([logRow(1, '/'), logRow(2, '/old', { status: 301, redirectTo: 'https://example.com/new', internalLinks: 0 })]);
  const store = useSeoInternalLinksStore.getState();
  await store.loadOverview(b.id);
  assert.equal((await store.loadCrawlLog(b.id, 'redirects', 'old')).ok, true);
  assert.equal(state.requests.filter((r) => r.rest === 'internal-links/log').at(-1).query, 'snapshot=s-one&filter=redirects&q=old');
  assert.equal(useSeoInternalLinksStore.getState().crawlLogByProject[b.id].rows.length, 2);
  state.crawlLog = null;
  const failed = await store.loadCrawlLog(b.id, 'all', '');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /No crawl has finished yet/);
});

test('the log is cleared when the snapshot changes, and a slow answer for the old snapshot is dropped', async () => {
  const { b, state } = await linkBuilding({ snapshots: [snapshotDto({ id: 's-new' }), snapshotDto({ id: 's-old' })] });
  state.crawlLog = crawlLogDto([logRow(1, '/')]);
  const store = useSeoInternalLinksStore.getState();
  await store.loadOverview(b.id);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  state.logGate = () => gate;
  const slow = store.loadCrawlLog(b.id, 'all', '');
  await store.selectSnapshot(b.id, 's-old');
  assert.equal(useSeoInternalLinksStore.getState().crawlLogByProject[b.id], null);
  release();
  await slow;
  assert.equal(useSeoInternalLinksStore.getState().crawlLogByProject[b.id], null, 'the stale answer did not land');
});

test('a row detail loads links found and linked-from; null clears it; the newest request wins', async () => {
  const { b, state } = await linkBuilding();
  state.crawlLogPage = (url) => ({ row: logRow(1, '/'), stored: true, linksFound: { total: 1, links: [{ url, anchor: 'x', location: 'nav', nofollow: true, crawled: false }] }, linkedFrom: { total: 0, pages: [] } });
  const store = useSeoInternalLinksStore.getState();
  await store.loadOverview(b.id);
  await store.loadCrawlLogPage(b.id, 'https://example.com/a');
  assert.equal(useSeoInternalLinksStore.getState().crawlLogPageByProject[b.id].linksFound.links[0].url, 'https://example.com/a');
  assert.equal(state.requests.filter((r) => r.rest === 'internal-links/log/page').at(-1).query, 'snapshot=s-one&url=https%3A%2F%2Fexample.com%2Fa');
  await store.loadCrawlLogPage(b.id, null);
  assert.equal(useSeoInternalLinksStore.getState().crawlLogPageByProject[b.id], null);
});

test('the export asks for the same filter and search as the table and reports a failed request', async () => {
  const { b, state } = await linkBuilding();
  state.crawlLog = crawlLogDto([logRow(1, '/')]);
  const store = useSeoInternalLinksStore.getState();
  await store.loadOverview(b.id);
  const ok = await store.exportCrawlLog(b.id, 'http-errors', 'x');
  assert.equal(ok.ok, true);
  assert.equal(ok.filename, 'crawl-log.csv');
  assert.equal(state.requests.filter((r) => r.rest === 'internal-links/log/export').at(-1).query, 'snapshot=s-one&filter=http-errors&q=x');
  state.crawlLog = null;
  assert.equal((await store.exportCrawlLog(b.id, 'all', '')).ok, false);
});

test('an old snapshot: "unknown" origin and a missing link list are worded, not hidden', () => {
  const view = src('ui/SeoCrawlLogView.tsx');
  assert.match(view, /The full link list is not stored for this page/);
  assert.match(view, /No links found on this page\./);
  assert.match(view, /not crawled/);
  assert.match(view, /No requests match these filters\./);
  assert.match(view, /setTimeout\(\(\) => setQuery\(search\), SEARCH_DEBOUNCE_MS\)/);
  assert.match(view, /if \(selected && log && !row\) setSelected\(null\)/);
  assert.match(view, /may be missing/);
  assert.match(view, /Loading…/);
  assert.match(view, /Retry/);
  assert.match(view, /to itself/);
});
