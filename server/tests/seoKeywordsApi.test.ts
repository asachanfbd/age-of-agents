import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { accessRefused, authFailure, createFakeAgent, createFakeSeo, quota, SECRETS } from './helpers/seoFakes.ts';

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let fake: ReturnType<typeof createFakeSeo>;
let agent: ReturnType<typeof createFakeAgent>;
let clock: Date;
const logs: string[] = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn };
/** The five-day cannibalisation numbers below assume a loopback origin; pages are reported as https on that host. */
let origin: string;
let site: string;

let storage: typeof import('../src/buildings/buildingStorage.ts');
let sync: typeof import('../src/seo/sync.ts');
let deps: typeof import('../src/seo/deps.ts');
let runs: typeof import('../src/seo/keywordRuns.ts');
let keywords: typeof import('../src/seo/keywords.ts');
let projectsDb: typeof import('../src/db/collections.ts').projectsDb;
let secretsMod: typeof import('../src/buildings/secrets.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'seo-keywords-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  storage = await import('../src/buildings/buildingStorage.ts');
  sync = await import('../src/seo/sync.ts');
  deps = await import('../src/seo/deps.ts');
  runs = await import('../src/seo/keywordRuns.ts');
  keywords = await import('../src/seo/keywords.ts');
  secretsMod = await import('../src/buildings/secrets.ts');
  ({ projectsDb } = await import('../src/db/collections.ts'));
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  origin = 'http://example.test';
  site = 'https://example.test';
  for (const level of ['log', 'error', 'warn'] as const) console[level] = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(' ')); };
});

after(async () => {
  Object.assign(console, realConsole);
  deps.resetSeo();
  await storage.closeAllStores();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Per day: "Alpha" (page /a) and "alpha" (page /b) are one keyword with 3 clicks and 30 impressions; "Beta" has 10
 * impressions on /a; "gamma" has 4 clicks (2 before 15 Feb) on 8 impressions on /a.
 */
const dayRows = (day: string) => [
  { page: `${origin}/a`, query: 'Alpha', clicks: 2, impressions: 20, ctr: 0.1, position: 4 },
  { page: `${origin}/b`, query: 'alpha', clicks: 1, impressions: 10, ctr: 0.1, position: 6 },
  { page: `${origin}/a`, query: 'Beta', clicks: 0, impressions: 10, ctr: 0, position: 8 },
  { page: `${origin}/a`, query: 'gamma', clicks: day < '2026-02-15' ? 2 : 4, impressions: 8, ctr: 0.5, position: 2 },
];

beforeEach(() => {
  fake = createFakeSeo();
  agent = createFakeAgent();
  clock = new Date('2026-03-15T12:00:00Z');
  fake.state.gscProperties = [{ id: `${origin}/`, label: `${origin}/` }];
  fake.state.gscRows = dayRows;
  deps.configureSeo({ firstRun: false, services: fake.services, agent: agent.agent, now: () => clock, sleep: async () => {}, dayPauseMs: 0, inspectPauseMs: 0, limits: deps.defaultLimits() });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body, text, headers: res.headers };
}
const send = (method: string, pathname: string, payload?: unknown) => api(pathname, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
const seo = (id: string, suffix: string) => `/api/projects/${id}/seo${suffix}`;
const kw = (id: string, suffix = '') => seo(id, `/keywords${suffix}`);

async function createSeo(siteUrl = origin) {
  const res = await send('POST', '/api/projects', { typeId: 'seo', siteUrl });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}

async function signIn(id: string, service: 'gsc' | 'ga4' | 'ads') {
  await send('PUT', '/api/settings/google-oauth-client', { clientId: SECRETS.clientId, clientSecret: SECRETS.clientSecret });
  const started = await send('POST', seo(id, `/connections/${service}/connect`));
  const state = new URL(started.body.authUrl).searchParams.get('state')!;
  assert.equal((await api(`/api/seo/oauth/callback?code=abc&state=${state}`)).status, 200);
}

async function connectGsc(id: string) {
  await signIn(id, 'gsc');
  assert.equal((await send('PUT', seo(id, '/connections/gsc/property'), { property: `${origin}/` })).status, 200);
}

async function connectAds(id: string, market = true) {
  await signIn(id, 'ads');
  const res = await send('PUT', seo(id, '/connections/ads'), { developerToken: SECRETS.ads, customerId: '123-456-7890' });
  assert.equal(res.status, 200, res.text);
  if (market) assert.equal((await send('PUT', kw(id, '/market'), { languageId: '1000', locationId: '2840' })).status, 200);
}

/** A Building with Search Console connected and three months of the fake data synced. */
async function seeded() {
  const b = await createSeo();
  await connectGsc(b.id);
  await send('PATCH', seo(b.id, '/data'), { retentionMonths: 3 });
  assert.equal((await send('POST', seo(b.id, '/sync'))).status, 202);
  await sync.waitForSync(b.id);
  assert.equal(sync.latestSync(b.id)!.status, 'done');
  return b;
}

const clustersOf = async (id: string, query = '') => (await api(kw(id, `/clusters?${query}`))).body;
const keywordsOf = async (id: string, query = '') => (await api(kw(id, `?${query}`))).body;
const rowsByName = (body: any) => new Map<string, any>(body.rows.map((r: any) => [r.name, r]));
const keyOf = (rows: any[], key: string) => rows.find((r) => r.key === key);

async function clusterRun(id: string) {
  const started = await send('POST', kw(id, '/cluster-run'));
  assert.equal(started.status, 202, started.text);
  await runs.settleRun(id, 'cluster');
  return (await api(kw(id, '/cluster-run'))).body;
}
async function researchRun(id: string, competitors?: string[]) {
  const started = await send('POST', kw(id, '/research-run'), { competitors });
  assert.equal(started.status, 202, started.text);
  await runs.settleRun(id, 'research');
  return (await api(kw(id, '/research-run'))).body;
}
async function create(id: string, name: string) {
  const res = await send('POST', kw(id, '/clusters'), { name });
  assert.equal(res.status, 201, res.text);
  return res.body.id as string;
}
const idOfGate = () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  return { held, release };
};
const waitFor = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 300 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(await check(), 'condition was not met'); };

/* ----- Universe, sources and the list ----- */

test('I1 Search Console queries become keywords with source gsc; case variants are one keyword with summed numbers', async () => {
  const b = await seeded();
  const res = await keywordsOf(b.id);
  assert.deepEqual(res.rows.map((r: any) => r.key).sort(), ['alpha', 'beta', 'gamma']);
  const alpha = keyOf(res.rows, 'alpha');
  assert.deepEqual(alpha.sources, ['gsc']);
  assert.equal(alpha.keyword, 'Alpha');
  assert.deepEqual([alpha.current.clicks, alpha.current.impressions, alpha.current.ctr], [84, 840, 0.1]);
  assert.ok(Math.abs(alpha.current.position - 140 / 30) < 1e-9);
  assert.equal(alpha.pages, 2);
  assert.equal(alpha.status, 'tracking');
  assert.equal(alpha.clusterId, null);
});

test('I2/I3/I4 manual and imported keywords record their source; the same keyword in other case, spacing and accents is one keyword with every source', async () => {
  const b = await seeded();
  const added = await send('POST', kw(b.id), { keywords: ['  Red   SHOES ', 'ALPHA', 'café', '', 'x'.repeat(501), 'cafe'] });
  assert.equal(added.status, 200, added.text);
  assert.deepEqual([added.body.added, added.body.existing, added.body.duplicates, added.body.rejected.length], [2, 1, 1, 2]);
  const imported = await send('POST', kw(b.id, '/import'), { csv: 'keyword,status\nRED shoes,Target\nBeta,ignored\nnew one,\n' });
  assert.equal(imported.status, 200, imported.text);
  assert.deepEqual([imported.body.added, imported.body.existing], [1, 2]);
  const res = await keywordsOf(b.id, 'limit=100');
  const bySource = (key: string) => keyOf(res.rows, key).sources.slice().sort();
  assert.deepEqual(bySource('red shoes'), ['import', 'manual']);
  assert.deepEqual(bySource('alpha'), ['gsc', 'manual']);
  assert.deepEqual(bySource('beta'), ['gsc', 'import']);
  assert.deepEqual(bySource('cafe'), ['manual']);
  assert.deepEqual(bySource('new one'), ['import']);
  assert.equal(keyOf(res.rows, 'red shoes').status, 'target');
  assert.equal(keyOf(res.rows, 'beta').status, 'ignored');
  assert.equal(keyOf(res.rows, 'cafe').current.clicks, 0, 'a keyword with no Search Console rows in a covered range has zero clicks');
  assert.equal(keyOf(res.rows, 'cafe').current.ctr, null);
  assert.equal(keyOf(res.rows, 'cafe').current.position, null);
});

test('I5/I6 the collapsed row for Unclustered equals the totals recomputed from the raw rows', async () => {
  const b = await seeded();
  const store = await storage.getStore((await projectsDb.get(b.id))!);
  const raw = await store.groupSums({ source: 'gsc_rows', groupBy: [], measures: ['clicks', 'impressions', 'positionImpressions'], range: { col: 'day', from: '2026-02-15', to: '2026-03-14' } });
  const res = await clustersOf(b.id);
  const un = rowsByName(res).get('Unclustered');
  assert.equal(un.id, null);
  assert.equal(un.keywords, 3);
  assert.equal(un.current.clicks, Number(raw.rows[0]!.clicks));
  assert.equal(un.current.impressions, Number(raw.rows[0]!.impressions));
  assert.ok(Math.abs(un.current.ctr - Number(raw.rows[0]!.clicks) / Number(raw.rows[0]!.impressions)) < 1e-12);
  assert.ok(Math.abs(un.current.position - Number(raw.rows[0]!.positionImpressions) / Number(raw.rows[0]!.impressions)) < 1e-9);
  assert.deepEqual([res.totals.keywords, res.totals.clusters, res.totals.unclustered], [3, 0, 3]);
  assert.deepEqual([res.range, res.previousRange], [{ from: '2026-02-15', to: '2026-03-14' }, { from: '2026-01-18', to: '2026-02-14' }]);
});

test('I7 a cluster row combines its keywords exactly: CTR recomputed, position weighted, change, best, pages, volume', async () => {
  const b = await seeded();
  const greek = await create(b.id, 'Greek');
  assert.equal((await send('POST', kw(b.id, '/move'), { keys: ['Alpha', 'beta', 'gamma'], clusterId: greek })).status, 200);
  const row = rowsByName(await clustersOf(b.id)).get('Greek');
  assert.deepEqual([row.keywords, row.current.clicks, row.current.impressions], [3, 84 + 0 + 112, 840 + 280 + 224]);
  assert.equal(row.current.ctr, 196 / 1344);
  assert.ok(Math.abs(row.current.position - (140 * 28 + 8 * 280 + 2 * 224) / 1344) < 1e-9);
  assert.deepEqual([row.previous.clicks, row.previous.impressions], [84 + 56, 1344]);
  assert.deepEqual(row.change, { abs: 56, pct: 0.4, isNew: false });
  assert.equal(row.best.key, 'gamma');
  assert.equal(row.pages, 2, 'pages /a and /b, counted once');
  assert.equal(row.volume, null);
  assert.equal(row.pinned, true);
  const expanded = await keywordsOf(b.id, `cluster=${greek}&sort=keyword&dir=asc`);
  assert.deepEqual(expanded.rows.map((r: any) => [r.key, r.current.clicks, r.pinned, r.clusterName]), [['alpha', 84, true, 'Greek'], ['beta', 0, true, 'Greek'], ['gamma', 112, true, 'Greek']]);
  assert.equal(keyOf(expanded.rows, 'gamma').change.pct, 1);
});

test('I8/I9 a range with no fetched days gives null metrics, a partly covered one is flagged, and compare=none gives no change', async () => {
  const b = await seeded();
  const none = await clustersOf(b.id, 'from=2025-06-01&to=2025-06-28&compare=none');
  assert.equal(none.gsc.coverage.current.state, 'none');
  assert.ok(none.rows.every((r: any) => r.current === null && r.change === null && r.best === null));
  assert.equal(none.rows[0].keywords, 3, 'keywords are still listed');
  const partial = await clustersOf(b.id, 'from=2025-12-01&to=2026-03-14&compare=none');
  assert.equal(partial.gsc.coverage.current.state, 'partial');
  const noCompare = await clustersOf(b.id, 'compare=none');
  assert.equal(noCompare.previousRange, null);
  assert.ok(noCompare.rows.every((r: any) => r.change === null && r.previous === null));
});

test('I10 a keyword missing from Search Console data in the range stays listed with its cluster', async () => {
  const b = await seeded();
  fake.state.gscRows = (day) => dayRows(day).filter((r) => r.query !== 'gamma');
  clock = new Date('2026-04-20T12:00:00Z');
  const c = await create(b.id, 'Keep');
  await send('POST', kw(b.id, '/move'), { keys: ['gamma'], clusterId: c });
  const res = await keywordsOf(b.id, 'from=2026-04-01&to=2026-04-10&compare=none');
  const gamma = keyOf(res.rows, 'gamma');
  assert.equal(gamma.clusterName, 'Keep');
  assert.equal(gamma.current, null, 'April was never fetched, so there is no data rather than zero');
});

test('I11 a later sync adds new queries without touching pins or assignments', async () => {
  const b = await seeded();
  const c = await create(b.id, 'Mine');
  await send('POST', kw(b.id, '/move'), { keys: ['alpha'], clusterId: c });
  fake.state.gscRows = (day) => [...dayRows(day), { page: `${origin}/z`, query: 'Fresh Query', clicks: 1, impressions: 3, ctr: 0.3, position: 5 }];
  clock = new Date('2026-03-18T12:00:00Z');
  await send('POST', seo(b.id, '/sync'));
  await sync.waitForSync(b.id);
  const res = await keywordsOf(b.id, 'limit=100');
  assert.ok(keyOf(res.rows, 'fresh query'));
  const alpha = keyOf(res.rows, 'alpha');
  assert.deepEqual([alpha.clusterName, alpha.pinned], ['Mine', true]);
});

test('I12 two Buildings never see each other\'s keywords or clusters', async () => {
  const one = await seeded();
  const two = await createSeo();
  await send('POST', kw(one.id), { keywords: ['only here'] });
  await create(one.id, 'Private');
  assert.equal((await keywordsOf(two.id)).total, 0);
  assert.equal((await clustersOf(two.id)).total, 0);
});

test('I13 server pagination keeps a stable total and a stable order under ties', async () => {
  const b = await createSeo();
  await send('POST', kw(b.id, '/import'), { csv: `keyword\n${Array.from({ length: 120 }, (_, i) => `kw ${String(i).padStart(3, '0')}`).join('\n')}\n` });
  const pages = await Promise.all([0, 50, 100].map((offset) => keywordsOf(b.id, `limit=50&offset=${offset}&sort=clicks`)));
  assert.deepEqual(pages.map((p) => [p.total, p.rows.length]), [[120, 50], [120, 50], [120, 20]]);
  const all = pages.flatMap((p) => p.rows.map((r: any) => r.key));
  assert.equal(new Set(all).size, 120);
  assert.deepEqual(all, [...all].sort(), 'ties on null clicks fall back to the keyword');
});

test('I14 30,000 keywords list, search and cluster within a time bound', async () => {
  const b = await createSeo();
  const csv = `keyword\n${Array.from({ length: 30_000 }, (_, i) => `bulk keyword ${i}`).join('\n')}\n`;
  const imported = await send('POST', kw(b.id, '/import'), { csv });
  assert.equal(imported.body.added, 30_000);
  const started = Date.now();
  const first = await keywordsOf(b.id, 'limit=500&search=keyword 29999');
  const clusters = await clustersOf(b.id, 'limit=5');
  assert.equal(first.rows[0].key, 'bulk keyword 29999');
  assert.equal(clusters.rows[0].keywords, 30_000);
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
});

test('I15/I16 search matches cluster names and keywords; filters and sort work and null volumes sort last', async () => {
  const b = await seeded();
  const c = await create(b.id, 'Greek letters');
  await send('POST', kw(b.id, '/move'), { keys: ['alpha'], clusterId: c });
  await send('PATCH', kw(b.id, '/item'), { key: 'beta', status: 'ignored' });
  assert.deepEqual((await clustersOf(b.id, 'search=greek')).rows.map((r: any) => r.name), ['Greek letters']);
  assert.deepEqual((await clustersOf(b.id, 'search=gamma')).rows.map((r: any) => r.name), ['Unclustered']);
  assert.deepEqual((await clustersOf(b.id, 'filter=pinned')).rows.map((r: any) => r.name), ['Greek letters']);
  assert.deepEqual((await clustersOf(b.id, 'filter=cannibalised')).rows.map((r: any) => r.name), ['Greek letters']);
  assert.deepEqual((await clustersOf(b.id, 'filter=unclustered')).rows.map((r: any) => r.name), ['Unclustered']);
  const filtered = async (f: string) => (await keywordsOf(b.id, `filter=${f}&sort=keyword&dir=asc`)).rows.map((r: any) => r.key);
  assert.deepEqual(await filtered('ignored'), ['beta']);
  assert.deepEqual(await filtered('tracking'), ['alpha', 'gamma']);
  assert.deepEqual(await filtered('pinned'), ['alpha']);
  assert.deepEqual(await filtered('cannibalised'), ['alpha']);
  assert.deepEqual(await filtered('no-cluster'), ['beta', 'gamma']);
  assert.deepEqual(await filtered('target'), []);
  assert.deepEqual((await keywordsOf(b.id, 'sort=volume&dir=desc')).rows.length, 3);
});

/* ----- Drill-down ----- */

test('I17/I18/I21 the drill-down lists pages with their metrics, a trend with gap days, and flags cannibalisation with the rule', async () => {
  const b = await seeded();
  const res = await api(kw(b.id, '/detail?key=ALPHA'));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.pageList.map((p: any) => [p.url, p.clicks, p.impressions]), [[`${site}/a`, 56, 560], [`${site}/b`, 28, 280]]);
  assert.equal(res.body.pageList[0].ctr, 0.1);
  assert.equal(res.body.cannibalisation.flagged, true);
  assert.match(res.body.cannibalisation.rule, /at least 5 impressions/);
  assert.deepEqual(res.body.cannibalisation.competingPages.sort(), [`${site}/a`, `${site}/b`]);
  const trend = res.body.trend;
  assert.equal(trend.length, 56);
  assert.equal(trend.find((p: any) => p.day === '2026-03-14').clicks, 3);
  const beta = (await api(kw(b.id, '/detail?key=beta'))).body;
  assert.equal(beta.cannibalisation.flagged, false);
  const gap = (await api(kw(b.id, '/detail?key=beta&from=2025-08-01&to=2025-08-10&compare=none'))).body;
  assert.ok(gap.trend.some((p: any) => p.clicks === null), 'days that were never fetched are null, not zero');
  assert.equal(gap.current, null);
});

test('I19/I20 a target page can be set and cleared, and must be on the site', async () => {
  const b = await seeded();
  const set = await send('PATCH', kw(b.id, '/item'), { key: 'alpha', targetPage: `${origin}/a/?utm_source=x` });
  assert.equal(set.status, 200, set.text);
  const detail = (await api(kw(b.id, '/detail?key=alpha'))).body;
  assert.equal(detail.targetPage, `${site}/a`);
  assert.deepEqual(detail.pageList.map((p: any) => [p.url, p.isTarget]), [[`${site}/a`, true], [`${site}/b`, false]]);
  assert.equal((await send('PATCH', kw(b.id, '/item'), { key: 'alpha', targetPage: 'https://elsewhere.example/x' })).status, 400);
  assert.equal((await send('PATCH', kw(b.id, '/item'), { key: 'alpha', targetPage: 'not a url' })).status, 400);
  assert.equal((await send('PATCH', kw(b.id, '/item'), { key: 'alpha', targetPage: null })).status, 200);
  assert.equal((await api(kw(b.id, '/detail?key=alpha'))).body.targetPage, null);
});

test('I22 status changes work and an invalid status, unknown keyword or empty change is refused', async () => {
  const b = await seeded();
  assert.equal((await send('PATCH', kw(b.id, '/item'), { key: 'gamma', status: 'target' })).status, 200);
  assert.equal(keyOf((await keywordsOf(b.id)).rows, 'gamma').status, 'target');
  assert.equal((await send('PATCH', kw(b.id, '/item'), { key: 'gamma', status: 'weird' })).status, 400);
  assert.equal((await send('PATCH', kw(b.id, '/item'), { key: 'nothing like it', status: 'target' })).status, 404);
  assert.equal((await send('PATCH', kw(b.id, '/item'), { key: 'gamma' })).status, 400);
  assert.equal((await api(kw(b.id, '/detail?key=unknown'))).status, 404);
  assert.equal((await api(kw(b.id, '/detail'))).status, 400);
});

/* ----- Clustering run ----- */

const greekOutput = { clusters: [{ name: 'Greek', keywords: ['Alpha', 'beta'] }, { name: 'Other', keywords: ['gamma'] }] };

test('I23/I24 a run goes queued, running, succeeded and its fake output is applied', async () => {
  const b = await seeded();
  const gate = idOfGate();
  agent.state.gate = () => gate.held;
  agent.state.clusterOutputs = [greekOutput];
  const started = await send('POST', kw(b.id, '/cluster-run'));
  assert.equal(started.status, 202);
  assert.ok(['queued', 'running'].includes(started.body.status));
  await waitFor(async () => (await api(kw(b.id, '/cluster-run'))).body.status === 'running');
  gate.release();
  await runs.settleRun(b.id, 'cluster');
  const done = (await api(kw(b.id, '/cluster-run'))).body;
  assert.equal(done.status, 'succeeded');
  assert.deepEqual([done.result.placed, done.result.clustersCreated, done.progress], [3, 2, { done: 3, total: 3 }]);
  const rows = rowsByName(await clustersOf(b.id));
  assert.deepEqual([rows.get('Greek').keywords, rows.get('Other').keywords, rows.has('Unclustered')], [2, 1, false]);
  assert.equal(rows.get('Greek').pinned, false, 'a cluster the agent made is not a manual edit');
  assert.ok((await keywordsOf(b.id)).rows.every((r: any) => r.pinned === false));
  assert.equal(agent.state.clusterCalls[0]!.keywords.length, 3);
});

test('I25/I37/I38 pinned keywords stay put, the agent\'s idea becomes a suggestion that moves the keyword and keeps its pin when applied', async () => {
  const b = await seeded();
  const mine = await create(b.id, 'Mine');
  await send('POST', kw(b.id, '/move'), { keys: ['alpha'], clusterId: mine });
  agent.state.clusterOutputs = [greekOutput];
  const done = await clusterRun(b.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.suggestions, 1);
  const alpha = keyOf((await keywordsOf(b.id)).rows, 'alpha');
  assert.deepEqual([alpha.clusterName, alpha.pinned], ['Mine', true]);
  const { suggestions } = (await api(kw(b.id, '/suggestions'))).body;
  assert.deepEqual(suggestions.map((s: any) => [s.key, s.fromCluster, s.toName]), [['alpha', 'Mine', 'Greek']]);
  assert.equal((await clustersOf(b.id)).totals.pendingSuggestions, 1);
  assert.equal((await send('POST', kw(b.id, `/suggestions/${suggestions[0].id}/apply`))).status, 200);
  const after = keyOf((await keywordsOf(b.id)).rows, 'alpha');
  assert.deepEqual([after.clusterName, after.pinned], ['Greek', true]);
  assert.equal((await send('POST', kw(b.id, `/suggestions/${suggestions[0].id}/apply`))).status, 404, 'already handled');
  const again = await clusterRun(b.id);
  assert.equal(again.result.suggestions, 0, 'alpha is now where the agent wants it');
});

test('I38b dismissing a suggestion works and a stale one (keyword moved since) is dropped with a conflict', async () => {
  const b = await seeded();
  const mine = await create(b.id, 'Mine');
  const other = await create(b.id, 'Elsewhere');
  await send('POST', kw(b.id, '/move'), { keys: ['alpha', 'gamma'], clusterId: mine });
  agent.state.clusterOutputs = [{ clusters: [{ name: 'Greek', keywords: ['alpha', 'gamma'] }] }];
  await clusterRun(b.id);
  const { suggestions } = (await api(kw(b.id, '/suggestions'))).body;
  assert.equal(suggestions.length, 2);
  const [first, second] = suggestions;
  assert.equal((await send('POST', kw(b.id, `/suggestions/${first.id}/dismiss`))).status, 200);
  await send('POST', kw(b.id, '/move'), { keys: [second.key], clusterId: other });
  assert.equal((await send('POST', kw(b.id, `/suggestions/${second.id}/apply`))).status, 409);
  assert.equal((await api(kw(b.id, '/suggestions'))).body.suggestions.length, 0);
  assert.equal((await send('POST', kw(b.id, '/suggestions/nope/dismiss'))).status, 404);
});

test('I26 600 candidates: 500 are processed in order of impressions and the cap message names the numbers', async () => {
  const b = await createSeo();
  await send('POST', kw(b.id, '/import'), { csv: `keyword\n${Array.from({ length: 600 }, (_, i) => `kw ${String(i).padStart(3, '0')}`).join('\n')}\n` });
  agent.state.clusterFn = (input) => ({ clusters: [{ name: 'All', keywords: input.keywords.map((k) => k.keyword) }] });
  const done = await clusterRun(b.id);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.notices, ['Processed 500 of 600 keywords this run (keywords without a cluster first, then highest impressions). Run again to place the rest.']);
  assert.equal(done.progress.total, 500);
  assert.equal((await clustersOf(b.id)).rows.find((r: any) => r.name === 'All').keywords, 500);
  const second = await clusterRun(b.id);
  assert.equal(second.progress.total, 500, 'the 100 unplaced keywords come first, then placed ones fill the cap');
  assert.equal((await clustersOf(b.id)).rows.find((r: any) => r.name === 'All').keywords, 600);
});

test('I27 several batches run in order with progress counters', async () => {
  const b = await createSeo();
  deps.configureSeo({ limits: { ...deps.defaultLimits(), clusterBatch: 2 } });
  await send('POST', kw(b.id, '/import'), { csv: 'keyword\nk1\nk2\nk3\nk4\nk5\n' });
  const seen: number[] = [];
  agent.state.gate = async (batch) => { seen.push(batch); };
  agent.state.clusterFn = (input) => ({ clusters: [{ name: `Batch of ${input.keywords.length}`, keywords: input.keywords.map((k) => k.keyword) }] });
  const done = await clusterRun(b.id);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.deepEqual(agent.state.clusterCalls.map((c) => c.keywords.length), [2, 2, 1]);
  assert.deepEqual(done.progress, { done: 5, total: 5 });
  assert.deepEqual(agent.state.clusterCalls[2]!.clusters.sort(), ['Batch of 2', 'Batch of 2'].slice(0, 1), 'later batches see the names earlier ones chose');
});

test('I28 a failure in batch 2 applies nothing from batch 1 and leaves the clusters unchanged', async () => {
  const b = await createSeo();
  deps.configureSeo({ limits: { ...deps.defaultLimits(), clusterBatch: 2 } });
  await send('POST', kw(b.id, '/import'), { csv: 'keyword\nk1\nk2\nk3\n' });
  await create(b.id, 'Existing');
  agent.state.clusterOutputs = [{ clusters: [{ name: 'New', keywords: ['k1', 'k2'] }] }];
  agent.fail('cluster', new Error('unused'));
  agent.state.failures.get('cluster')!.length = 0;
  agent.state.gate = async (batch) => { if (batch === 1) agent.fail('cluster', new Error('The model is overloaded')); };
  const done = await clusterRun(b.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /overloaded/);
  const rows = (await clustersOf(b.id)).rows;
  assert.deepEqual(rows.map((r: any) => r.name).sort(), ['Existing', 'Unclustered']);
  assert.equal(rows.find((r: any) => r.name === 'Unclustered').keywords, 3);
});

test('I29 stop leaves clusters unchanged and reports stopped; stopping with no run is a conflict', async () => {
  const b = await seeded();
  assert.equal((await send('POST', kw(b.id, '/cluster-run/stop'))).status, 409);
  const gate = idOfGate();
  agent.state.gate = () => gate.held;
  agent.state.clusterOutputs = [greekOutput];
  await send('POST', kw(b.id, '/cluster-run'));
  await waitFor(async () => agent.state.clusterCalls.length === 1);
  const stopped = await send('POST', kw(b.id, '/cluster-run/stop'));
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'stopped');
  gate.release();
  assert.deepEqual((await clustersOf(b.id)).rows.map((r: any) => r.name), ['Unclustered']);
});

test('I30 a second start while one is running is a conflict, forced at the agent gate', async () => {
  const b = await seeded();
  const gate = idOfGate();
  agent.state.gate = () => gate.held;
  agent.state.clusterOutputs = [greekOutput];
  assert.equal((await send('POST', kw(b.id, '/cluster-run'))).status, 202);
  assert.equal((await send('POST', kw(b.id, '/cluster-run'))).status, 409);
  gate.release();
  await runs.settleRun(b.id, 'cluster');
  assert.equal((await send('POST', kw(b.id, '/cluster-run'))).status, 202, 'a finished run frees the slot');
  await runs.settleRun(b.id, 'cluster');
});

test('I31/I32/I36 malformed output, a timeout and an unavailable agent each fail the run and leave clusters unchanged', async () => {
  const b = await seeded();
  agent.state.clusterOutputs = [{ clusters: [{ name: '', keywords: ['alpha'] }] }];
  const malformed = await clusterRun(b.id);
  assert.equal(malformed.status, 'failed');
  assert.match(malformed.error, /not usable/);
  deps.configureSeo({ limits: { ...deps.defaultLimits(), agentTimeoutMs: 30 } });
  agent.state.gate = () => new Promise(() => {});
  const timedOut = await clusterRun(b.id);
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.error, /did not answer within/);
  agent.state.gate = undefined;
  agent.state.failures.clear();
  agent.fail('cluster', new Error('No agent is available'));
  deps.configureSeo({ limits: deps.defaultLimits() });
  const unavailable = await clusterRun(b.id);
  assert.match(unavailable.error, /No agent is available/);
  assert.deepEqual((await clustersOf(b.id)).rows.map((r: any) => r.name), ['Unclustered']);
});

test('I33 a keyword pinned while the run works is not overwritten when it finishes', async () => {
  const b = await seeded();
  const gate = idOfGate();
  agent.state.gate = () => gate.held;
  agent.state.clusterOutputs = [greekOutput];
  await send('POST', kw(b.id, '/cluster-run'));
  await waitFor(async () => agent.state.clusterCalls.length === 1);
  const mine = await create(b.id, 'Mine');
  await send('POST', kw(b.id, '/move'), { keys: ['alpha'], clusterId: mine });
  gate.release();
  await runs.settleRun(b.id, 'cluster');
  const alpha = keyOf((await keywordsOf(b.id)).rows, 'alpha');
  assert.deepEqual([alpha.clusterName, alpha.pinned], ['Mine', true]);
  assert.equal(keyOf((await keywordsOf(b.id)).rows, 'beta').clusterName, 'Greek');
  assert.equal((await api(kw(b.id, '/suggestions'))).body.suggestions.length, 1);
});

test('I34 a run left working when the daemon restarted is closed as failed', async () => {
  const b = await seeded();
  const project = (await projectsDb.get(b.id))!;
  const store = await storage.getStore(project);
  await store.replaceRows([{ table: 'seo_keyword_runs', where: { uid: 'old' }, rows: [['old', 'cluster', 'running', JSON.stringify({ progress: { done: 1, total: 5 }, notices: [], error: null, adsError: null, result: {} }), '2026-03-14T00:00:00Z', '']] }]);
  const res = (await api(kw(b.id, '/cluster-run'))).body;
  assert.equal(res.status, 'failed');
  assert.match(res.error, /restarted/);
  assert.equal((await send('POST', kw(b.id, '/cluster-run'))).status, 202);
  await runs.settleRun(b.id, 'cluster');
});

test('I35 an empty keyword set is refused with no agent call', async () => {
  const b = await createSeo();
  const res = await send('POST', kw(b.id, '/cluster-run'));
  assert.equal(res.status, 400);
  assert.equal(agent.state.clusterCalls.length, 0);
});

test('I23b the run view is null before any run', async () => {
  const b = await seeded();
  assert.equal((await api(kw(b.id, '/cluster-run'))).body, null);
});

/* ----- Cluster operations ----- */

test('I39-I45 rename, merge, split, create, delete and bulk move, with 404 for unknown ids and 409 for duplicate names', async () => {
  const b = await seeded();
  const one = await create(b.id, 'One');
  const two = await create(b.id, 'Two');
  assert.equal((await send('POST', kw(b.id, '/clusters'), { name: 'one' })).status, 409);
  assert.equal((await send('POST', kw(b.id, '/clusters'), { name: ' ' })).status, 400);
  assert.equal((await send('PATCH', kw(b.id, `/clusters/${one}`), { name: 'Uno' })).status, 200);
  assert.equal((await send('PATCH', kw(b.id, `/clusters/${one}`), { name: 'Two' })).status, 409);
  assert.equal((await send('PATCH', kw(b.id, '/clusters/nope'), { name: 'x' })).status, 404);
  assert.equal((await send('POST', kw(b.id, '/move'), { keys: ['alpha', 'beta', 'gamma'], clusterId: one })).status, 200);
  assert.equal((await send('POST', kw(b.id, '/move'), { keys: ['alpha'], clusterId: 'nope' })).status, 404);
  assert.equal((await send('POST', kw(b.id, '/move'), { keys: [], clusterId: one })).status, 400);
  assert.equal((await send('POST', kw(b.id, '/move'), { keys: ['alpha'] })).status, 400, 'a missing clusterId is not a move to Unclustered');
  assert.equal((await send('POST', kw(b.id, '/move'), { keys: Array.from({ length: 501 }, (_, i) => `k${i}`), clusterId: one })).status, 400);
  const split = await send('POST', kw(b.id, `/clusters/${one}/split`), { keys: ['gamma'], name: 'Gamma only' });
  assert.equal(split.status, 201, split.text);
  assert.equal((await send('POST', kw(b.id, `/clusters/${one}/split`), { keys: ['alpha', 'beta'], name: 'All' })).status, 400);
  assert.equal((await send('POST', kw(b.id, '/clusters/merge'), { sourceIds: [one], targetId: one })).status, 400);
  assert.equal((await send('POST', kw(b.id, '/clusters/merge'), { sourceIds: [one], targetId: two })).status, 200);
  let rows = rowsByName(await clustersOf(b.id));
  assert.deepEqual([rows.get('Two').keywords, rows.get('Gamma only').keywords, rows.has('Uno')], [2, 1, false]);
  assert.equal((await send('DELETE', kw(b.id, `/clusters/${two}`))).status, 200);
  assert.equal((await send('DELETE', kw(b.id, `/clusters/${two}`))).status, 404);
  rows = rowsByName(await clustersOf(b.id));
  assert.deepEqual([rows.get('Unclustered').keywords, rows.get('Gamma only').keywords], [2, 1]);
  const freed = keyOf((await keywordsOf(b.id)).rows, 'alpha');
  assert.deepEqual([freed.clusterId, freed.pinned], [null, false], 'deleting a cluster unpins its keywords');
});

test('I46 every keyword is in exactly one cluster after a mix of operations', async () => {
  const b = await seeded();
  const a = await create(b.id, 'A');
  const c = await create(b.id, 'C');
  await send('POST', kw(b.id, '/move'), { keys: ['alpha', 'beta'], clusterId: a });
  await send('POST', kw(b.id, '/move'), { keys: ['beta'], clusterId: c });
  await send('POST', kw(b.id, '/clusters/merge'), { sourceIds: [a], targetId: c });
  const rows = (await clustersOf(b.id)).rows;
  assert.equal(rows.reduce((n: number, r: any) => n + r.keywords, 0), 3);
  const all = (await keywordsOf(b.id)).rows;
  assert.ok(all.every((r: any) => r.clusterId === null || rows.some((c2: any) => c2.id === r.clusterId)));
});

test('U36-U42 through the API: unknown cluster filters are 404, bad or out-of-range parameters are 400 and the limits themselves are accepted', async () => {
  const b = await seeded();
  assert.equal((await api(kw(b.id, '?cluster=nope'))).status, 404);
  for (const q of ['sort=bad', 'dir=sideways', 'filter=odd', 'limit=0', 'limit=501', 'limit=abc', 'limit=%2B50', 'offset=-1', 'offset=10000001', `search=${'a'.repeat(501)}`, 'from=2026-03-01', 'from=2026-03-10&to=2026-03-01', 'from=2026-1-5&to=2026-03-01', 'from=2026-03-01&to=2099-01-01', 'from=0001-01-01&to=2026-03-01']) {
    assert.equal((await api(kw(b.id, `?${q}`))).status, 400, q);
    assert.equal((await api(kw(b.id, `/clusters?${q}`))).status, 400, q);
  }
  for (const q of ['limit=50', 'limit=500', 'offset=10000000', 'from=2025-02-08&to=2026-03-14']) assert.equal((await api(kw(b.id, `?${q}`))).status, 200, q);
  assert.equal((await api(kw(b.id, '?from=2025-02-07&to=2026-03-14'))).status, 400, '401 days');
});

/* ----- Research ----- */

const idea = (keyword: string, reason = 'because') => ({ keyword, reason });

test('I48/I49 a research run fills the review list from agent and Ads ideas and tracks nothing', async () => {
  const b = await seeded();
  await connectAds(b.id);
  agent.state.researchOutput = { keywords: [idea('delta force'), idea('Alpha')] };
  fake.state.adsIdeas = [{ keyword: 'epsilon wave', volume: 1000 }, { keyword: 'zeta', volume: 320 }];
  fake.state.adsVolumes.set('delta force', 50);
  const before = (await keywordsOf(b.id)).total;
  const done = await researchRun(b.id, ['https://Rival.com/path']);
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  assert.equal(done.result.proposed, 3, 'alpha is already tracked');
  assert.deepEqual(agent.state.researchCalls[0]!.competitors, ['rival.com']);
  assert.ok(agent.state.researchCalls[0]!.topQueries.some((q) => q.keyword === 'Alpha' || q.keyword === 'gamma'));
  assert.equal((await keywordsOf(b.id)).total, before, 'nothing is tracked before acceptance');
  const list = (await api(kw(b.id, '/proposals'))).body;
  assert.equal(list.volumeAvailable, true);
  const byKey = new Map<string, any>(list.proposals.map((p: any) => [p.key, p]));
  assert.deepEqual([byKey.get('delta force').origin, byKey.get('epsilon wave').origin], ['agent', 'ads']);
  assert.deepEqual(byKey.get('delta force').volume, { kind: 'exact', low: 50, high: 50, fetchedAt: clock.toISOString() });
  assert.deepEqual([byKey.get('epsilon wave').volume.kind, byKey.get('epsilon wave').volume.low, byKey.get('epsilon wave').volume.high], ['range', 1000, 10000], 'a bucketed volume is stored as a range');
  assert.equal(byKey.get('zeta').volume.kind, 'exact');
});

test('I50/I51/I52/I53 accept, accept into cluster (pinned), reject, and accepting twice is harmless', async () => {
  const b = await seeded();
  await connectAds(b.id);
  agent.state.researchOutput = { keywords: [idea('one'), idea('two'), idea('three')] };
  fake.state.adsVolumes.set('one', 1000);
  fake.state.adsVolumes.set('two', 120);
  await researchRun(b.id);
  const ids = Object.fromEntries((await api(kw(b.id, '/proposals'))).body.proposals.map((p: any) => [p.key, p.id]));
  const target = await create(b.id, 'Research');
  assert.equal((await send('POST', kw(b.id, '/proposals/accept'), { ids: [ids.one] })).body.accepted, 1);
  assert.equal((await send('POST', kw(b.id, '/proposals/accept'), { ids: [ids.one] })).body.alreadyAccepted, 1);
  assert.equal((await send('POST', kw(b.id, '/proposals/accept'), { ids: [ids.two], clusterId: target })).body.accepted, 1);
  assert.equal((await send('POST', kw(b.id, '/proposals/reject'), { ids: [ids.three] })).body.rejected, 1);
  assert.equal((await send('POST', kw(b.id, '/proposals/reject'), { ids: [ids.one] })).status, 409);
  assert.equal((await send('POST', kw(b.id, '/proposals/accept'), { ids: ['nope'] })).status, 404);
  assert.equal((await send('POST', kw(b.id, '/proposals/accept'), { ids: [ids.three], clusterId: 'nope' })).status, 404);
  const rows = (await keywordsOf(b.id, 'limit=100')).rows;
  const one = keyOf(rows, 'one');
  const two = keyOf(rows, 'two');
  assert.deepEqual([one.sources, one.clusterId, one.pinned], [['research'], null, false]);
  assert.deepEqual([two.clusterName, two.pinned], ['Research', true]);
  assert.deepEqual([one.volume.kind, one.volume.low, one.volume.high], ['range', 1000, 10000]);
  assert.deepEqual([two.volume.kind, two.volume.low], ['exact', 120]);
  assert.equal(keyOf(rows, 'three'), undefined);
  const research = rowsByName(await clustersOf(b.id)).get('Research');
  assert.deepEqual(research.volume, { low: 120, high: 120, exact: true, missing: 0 });
  const unclustered = rowsByName(await clustersOf(b.id)).get('Unclustered');
  assert.deepEqual(unclustered.volume, { low: 1000, high: 10000, exact: false, missing: 3 }, 'a sum with a range is a range, and keywords without volume are counted');
  await researchRun(b.id);
  agent.state.researchOutput = { keywords: [idea('three'), idea('four')] };
  await researchRun(b.id);
  const pending = (await api(kw(b.id, '/proposals'))).body.proposals.map((p: any) => p.key);
  assert.deepEqual(pending, ['four'], 'a rejected keyword is not proposed again');
  assert.deepEqual((await api(kw(b.id, '/proposals?status=rejected'))).body.proposals.map((p: any) => p.key), ['three']);
  assert.equal((await api(kw(b.id, '/proposals?status=weird'))).status, 400);
});

test('I54/I58 without Ads, or without a language and location, volumes stay empty and the response says why', async () => {
  const b = await seeded();
  agent.state.researchOutput = { keywords: [idea('no volume')] };
  const done = await researchRun(b.id);
  assert.deepEqual(done.notices, ['Connect Google Ads for volume']);
  const list = (await api(kw(b.id, '/proposals'))).body;
  assert.equal(list.volumeAvailable, false);
  assert.equal(list.proposals[0].volume, null);
  await connectAds(b.id, false);
  agent.state.researchOutput = { keywords: [idea('still none')] };
  const noMarket = await researchRun(b.id);
  assert.match(noMarket.notices[0], /language and location/);
  assert.equal(fake.state.adsIdeaCalls.length, 0);
  assert.equal((await send('PUT', kw(b.id, '/market'), { languageId: 'en', locationId: '2840' })).status, 400);
  assert.equal((await api(seo(b.id, '/connections'))).body.keywordMarket, null);
  assert.equal((await send('PUT', kw(b.id, '/market'), { languageId: '1000', locationId: '2840' })).status, 200);
  assert.deepEqual((await api(seo(b.id, '/connections'))).body.keywordMarket, { languageId: '1000', locationId: '2840' }, 'Settings → Connections reads the market back');
});

test('I55/I56 an Ads quota, access or auth error still returns proposals, shows in the run and in Settings, and leaves stored volumes alone', async () => {
  const b = await seeded();
  await connectAds(b.id);
  agent.state.researchOutput = { keywords: [idea('first')] };
  fake.state.adsVolumes.set('first', 120);
  await researchRun(b.id);
  const ids = (await api(kw(b.id, '/proposals'))).body.proposals.map((p: any) => p.id);
  await send('POST', kw(b.id, '/proposals/accept'), { ids });
  for (const [failure, pattern] of [[quota(), /quota exceeded/], [accessRefused(), /access was refused/], [authFailure(), /no longer accepts/]] as const) {
    agent.state.researchOutput = { keywords: [idea(`after ${pattern.source.slice(0, 5)}`)] };
    fake.fail('adsIdeas', failure);
    fake.state.adsIdeas = [{ keyword: 'x', volume: 5 }];
    const done = await researchRun(b.id);
    assert.equal(done.status, 'succeeded');
    assert.match(done.adsError, pattern);
    assert.equal(done.result.proposed, 1);
    const connections = (await api(seo(b.id, '/connections'))).body.connections.find((c: any) => c.service === 'ads');
    assert.match(JSON.stringify(connections), pattern);
  }
  assert.equal(keyOf((await keywordsOf(b.id, 'limit=100')).rows, 'first').volume.low, 120);
  const ok = await researchRun(b.id);
  assert.equal(ok.adsError, null);
  assert.doesNotMatch(JSON.stringify((await api(seo(b.id, '/connections'))).body), /quota exceeded/, 'a good run clears the Settings message');
});

test('I57/I63 volumes are stored with precision and date; a refresh failure keeps the old value', async () => {
  const b = await seeded();
  await connectAds(b.id);
  fake.state.adsVolumes.set('Alpha', 1000);
  const refreshed = await send('POST', kw(b.id, '/volumes/refresh'));
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.equal(refreshed.body.updated, 1);
  const alpha = keyOf((await keywordsOf(b.id)).rows, 'alpha');
  assert.deepEqual(alpha.volume, { kind: 'range', low: 1000, high: 10000, fetchedAt: clock.toISOString() });
  fake.fail('adsVolume', quota());
  fake.state.adsVolumes.set('Alpha', 2000);
  assert.equal((await send('POST', kw(b.id, '/volumes/refresh'))).status, 502);
  assert.equal(keyOf((await keywordsOf(b.id)).rows, 'alpha').volume.low, 1000);
  const plain = await seeded();
  assert.equal((await send('POST', kw(plain.id, '/volumes/refresh'))).status, 409);
});

test('I59 invalid competitor input is refused', async () => {
  const b = await seeded();
  for (const competitors of [['localhost'], ['127.0.0.1'], ['ftp://x.com'], Array.from({ length: 11 }, (_, i) => `s${i}.com`), 'rival.com', [5]]) {
    assert.equal((await send('POST', kw(b.id, '/research-run'), { competitors })).status, 400, JSON.stringify(competitors));
  }
  assert.equal(agent.state.researchCalls.length, 0);
});

test('I60/I61/I62 malformed research output fails with no proposals; re-running does not duplicate pending proposals; stop works', async () => {
  const b = await seeded();
  agent.state.researchOutput = { nope: true };
  const bad = await researchRun(b.id);
  assert.equal(bad.status, 'failed');
  assert.equal((await api(kw(b.id, '/proposals'))).body.proposals.length, 0);
  agent.state.researchOutput = { keywords: [idea('same idea')] };
  await researchRun(b.id);
  await researchRun(b.id);
  assert.equal((await api(kw(b.id, '/proposals'))).body.proposals.length, 1);
  const gate = idOfGate();
  agent.state.gate = () => gate.held;
  await send('POST', kw(b.id, '/research-run'));
  assert.equal((await send('POST', kw(b.id, '/research-run'))).status, 409);
  await waitFor(async () => agent.state.researchCalls.length === 3);
  assert.equal((await send('POST', kw(b.id, '/research-run/stop'))).body.status, 'stopped');
  gate.release();
});

/* ----- Import and export ----- */

test('I64/I65 import reports added, existing, duplicate and rejected rows with reasons; clusters in the file are created and pin their keywords', async () => {
  const b = await seeded();
  const res = await send('POST', kw(b.id, '/import'), { csv: 'keyword,cluster,status,target page\nnew a,Imported,target,https://example.test/a\nnew a,,,\nbad,,maybe,\nbad2,,,https://other.test/x\n,,,\nalpha,Imported,,\n' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.added, res.body.existing, res.body.duplicates], [1, 1, 1]);
  assert.deepEqual(res.body.rejected.map((r: any) => r.line), [4, 5, 6]);
  const imported = rowsByName(await clustersOf(b.id)).get('Imported');
  assert.equal(imported.keywords, 2);
  const row = keyOf((await keywordsOf(b.id)).rows, 'new a');
  assert.deepEqual([row.status, row.pinned, row.targetPage], ['target', true, `${site}/a`]);
  for (const bad of [{ csv: '' }, { csv: 'name\nx\n' }, {}, { csv: 'k'.repeat(5_000_001) }]) assert.equal((await send('POST', kw(b.id, '/import'), bad)).status, 400);
});

test('I66/I67 export returns the whole filtered set with empty for no data, escaped formulas and range volume columns', async () => {
  const b = await seeded();
  await send('POST', kw(b.id), { keywords: ['=cmd|calc', '+plus', 'quote "x", y'] });
  await connectAds(b.id);
  fake.state.adsVolumes.set('Alpha', 1000);
  await send('POST', kw(b.id, '/volumes/refresh'));
  const res = await api(kw(b.id, '/export?sort=keyword&dir=asc&limit=1'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/csv/);
  const lines = res.text.trim().split('\r\n');
  assert.equal(lines.length, 7, 'every keyword, not one page');
  assert.match(lines[0]!, /^Keyword,Cluster,Status/);
  assert.ok(lines.some((l) => l.startsWith("'+plus,")));
  assert.ok(lines.some((l) => l.startsWith("'=cmd|calc,")));
  assert.ok(lines.some((l) => l.startsWith('"quote ""x"", y",')));
  const alpha = lines.find((l) => l.startsWith('Alpha,'))!;
  assert.ok(alpha.includes(',1000,10000,range,'), alpha);
  const manual = lines.find((l) => l.startsWith("'+plus,"))!;
  assert.match(manual, /,tracking,no,manual,0,0,,,,0,no,,,,$/, 'a covered range with no rows is zero clicks and no CTR or position');
  const outside = (await api(kw(b.id, '/export?from=2025-08-01&to=2025-08-10&compare=none'))).text.trim().split('\r\n').find((l) => l.startsWith("'+plus,"))!;
  assert.match(outside, /,tracking,no,manual,,,,,,0,no,,,,$/, 'a range that was never fetched is empty, not 0');
  const filtered = await api(kw(b.id, '/export?filter=cannibalised'));
  assert.equal(filtered.text.trim().split('\r\n').length, 2);
});

/* ----- Safety ----- */

test('I69 no secret value appears in any keyword response or run message', async () => {
  const b = await seeded();
  await connectAds(b.id);
  agent.state.clusterOutputs = [greekOutput];
  agent.state.researchOutput = { keywords: [idea('idea')] };
  fake.fail('adsIdeas', quota());
  const responses = [
    (await clusterRun(b.id)), (await researchRun(b.id)), (await clustersOf(b.id)), (await keywordsOf(b.id)), (await api(kw(b.id, '/detail?key=alpha'))).body,
    (await api(kw(b.id, '/proposals'))).body, (await api(kw(b.id, '/suggestions'))).body, (await api(seo(b.id, '/connections'))).body, (await api(kw(b.id, '/export'))).text,
  ].map((r) => JSON.stringify(r)).join('\n') + logs.join('\n');
  for (const value of Object.values(SECRETS)) assert.ok(!responses.includes(value), `a secret leaked: ${value.slice(0, 8)}`);
  const secrets = new secretsMod.SecretsStore(b.id);
  assert.ok(await secrets.get('ads.developerToken'), 'the token is still saved');
});

test('I70 a read-only Building refuses every mutation and a Building that is not SEO, or unknown, is 404', async () => {
  const b = await seeded();
  await projectsDb.update(b.id, { readOnlyReason: 'newer data' });
  for (const [method, suffix, body] of [
    ['POST', '', { keywords: ['x'] }], ['POST', '/import', { csv: 'keyword\nx\n' }], ['PATCH', '/item', { key: 'alpha', status: 'ignored' }], ['POST', '/clusters', { name: 'x' }],
    ['POST', '/move', { keys: ['alpha'], clusterId: null }], ['POST', '/cluster-run', {}], ['POST', '/research-run', {}], ['POST', '/proposals/accept', { ids: ['x'] }], ['PUT', '/market', { languageId: '1', locationId: '1' }],
  ] as const) {
    assert.equal((await send(method, kw(b.id, suffix), body)).status, 409, `${method} ${suffix}`);
  }
  assert.equal((await keywordsOf(b.id)).total, 3, 'reading still works');
  assert.equal((await api(kw('missing-building'))).status, 404);
  const other = await send('POST', '/api/projects', { name: 'plain' });
  assert.equal((await api(kw(other.body.id))).status, 404);
});

test('I71 an unknown cluster, proposal or suggestion id is 404', async () => {
  const b = await seeded();
  assert.equal((await send('DELETE', kw(b.id, '/clusters/nope'))).status, 404);
  assert.equal((await send('POST', kw(b.id, '/suggestions/nope/apply'))).status, 404);
  assert.equal((await send('POST', kw(b.id, '/proposals/reject'), { ids: ['nope'] })).status, 404);
});

test('I72 a Search Console query over the length limit is skipped and counted, and never fails the sync', async () => {
  fake.state.gscRows = (day) => [...dayRows(day), { page: `${origin}/a`, query: 'q'.repeat(501), clicks: 1, impressions: 2, ctr: 0.5, position: 3 }];
  const b = await seeded();
  assert.equal(sync.latestSync(b.id)!.status, 'done');
  const res = await clustersOf(b.id);
  assert.equal(res.skippedQueries, 1);
  assert.equal(res.totals.keywords, 3);
});

test('I73 discarding old data leaves keyword records and cluster assignments', async () => {
  const b = await seeded();
  const c = await create(b.id, 'Stays');
  await send('POST', kw(b.id, '/move'), { keys: ['alpha'], clusterId: c });
  clock = new Date('2027-06-15T12:00:00Z');
  await send('PATCH', seo(b.id, '/data'), { retentionMonths: 1 });
  const project = (await projectsDb.get(b.id))!;
  const store = await storage.getStore(project);
  await store.replaceRows([{ table: 'gsc_rows', where: { property: `${origin}/` }, rows: [] }, { table: 'fetch_ledger', where: { property: `${origin}/` }, rows: [] }]);
  const row = keyOf((await keywordsOf(b.id)).rows, 'alpha');
  assert.deepEqual([row.clusterName, row.pinned], ['Stays', true], 'history is gone but the keyword and its cluster are kept');
  assert.equal(row.current, null);
});

test('I68 the migration from version 1 (to the current version) keeps existing rows and creates the keyword tables, and opening again changes nothing', async () => {
  const { BulkStore } = await import('../src/buildings/bulkClient.ts');
  const { SEO_STORAGE } = await import('../src/buildings/types/seo.ts');
  const file = path.join(tempRoot, 'migrate', 'seo.sqlite');
  const old = { ...SEO_STORAGE, tables: SEO_STORAGE.tables.filter((t) => !t.name.startsWith('seo_keyword') && t.name !== 'seo_clusters' && t.name !== 'seo_cluster_suggestions'), migrations: [] };
  const open = (spec: typeof SEO_STORAGE, version: number) => new BulkStore({ file, spec, version, backupDir: path.join(tempRoot, 'migrate', 'backups') } as any);
  const v1 = open(old, 1);
  await v1.open();
  await v1.insert('fetch_ledger', [['gsc', 'p', '2026-01-01', 1, 'now', 3]]);
  await v1.close();
  for (let round = 0; round < 2; round++) {
    const v2 = open(SEO_STORAGE, 5);
    const outcome = await v2.open();
    assert.equal(outcome.status, round === 0 ? 'migrated' : 'ok');
    assert.equal((await v2.count('fetch_ledger')).count, 1);
    assert.equal((await v2.count('seo_keywords')).count, 0);
    await v2.replaceRows([{ table: 'seo_clusters', where: { uid: 'c' }, rows: [['c', 'C', 'c', 0, 'now']] }]);
    assert.equal((await v2.count('seo_clusters')).count, 1);
    await v2.close();
  }
});

test('keywords of a stored record survive when Search Console stops reporting them (history kept)', async () => {
  const b = await seeded();
  const c = await create(b.id, 'Kept');
  await send('POST', kw(b.id, '/move'), { keys: ['gamma'], clusterId: c });
  const all = await keywords.keywordsReport((await projectsDb.get(b.id))!, {});
  assert.equal(all.rows.find((r) => r.key === 'gamma')!.clusterName, 'Kept');
});
