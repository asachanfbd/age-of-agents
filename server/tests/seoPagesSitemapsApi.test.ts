import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, beforeEach, test } from 'node:test';
import { createFakeSeo, SECRETS } from './helpers/seoFakes.ts';
import { authFailure, accessRefused, network, quota } from './helpers/seoFakes.ts';

let tempRoot: string;
let dataDir: string;
let baseUrl: string;
let server: HttpServer;
let site: HttpServer;
let origin: string;
let fake: ReturnType<typeof createFakeSeo>;
let clock: Date;
const logs: string[] = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn };
/** What the loopback "site" answers per path; a missing path is a 404. */
let routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void>;
let hits: string[];

let storage: typeof import('../src/buildings/buildingStorage.ts');
let sync: typeof import('../src/seo/sync.ts');
let deps: typeof import('../src/seo/deps.ts');
let inspection: typeof import('../src/seo/inspection.ts');
let projectsDb: typeof import('../src/db/collections.ts').projectsDb;
let maintenance: typeof import('../src/seo/maintenance.ts');
let secretsMod: typeof import('../src/buildings/secrets.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'seo-pages-'));
  dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  storage = await import('../src/buildings/buildingStorage.ts');
  sync = await import('../src/seo/sync.ts');
  deps = await import('../src/seo/deps.ts');
  inspection = await import('../src/seo/inspection.ts');
  maintenance = await import('../src/seo/maintenance.ts');
  secretsMod = await import('../src/buildings/secrets.ts');
  ({ projectsDb } = await import('../src/db/collections.ts'));
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  site = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    hits.push(pathname);
    const handler = routes.get(pathname);
    if (handler) handler(req, res); else { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  for (const level of ['log', 'error', 'warn'] as const) console[level] = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(' ')); };
});

after(async () => {
  Object.assign(console, realConsole);
  deps.resetSeo();
  await storage.closeAllStores();
  site.closeAllConnections();
  await new Promise((resolve) => site.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  fake = createFakeSeo();
  clock = new Date('2026-03-15T12:00:00Z');
  routes = new Map();
  hits = [];
  fake.state.gscProperties = [{ id: `${origin}/`, label: `${origin}/` }];
  deps.configureSeo({ firstRun: false, services: fake.services, now: () => clock, sleep: async () => {}, dayPauseMs: 0, inspectPauseMs: 0, limits: deps.defaultLimits() });
  fake.state.gscRows = () => [
    { page: `${origin}/page-0`, query: 'alpha', clicks: 2, impressions: 20, ctr: 0.1, position: 4 },
    { page: `${origin}/page-0/`, query: 'gamma', clicks: 1, impressions: 5, ctr: 0.2, position: 2 },
    { page: `${origin}/page-1`, query: 'beta', clicks: 0, impressions: 10, ctr: 0, position: 8 },
  ];
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body, text };
}
const send = (method: string, pathname: string, payload?: unknown) => api(pathname, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
const seo = (id: string, suffix: string) => `/api/projects/${id}/seo${suffix}`;

async function createSeo(siteUrl = origin) {
  const res = await send('POST', '/api/projects', { typeId: 'seo', siteUrl });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}

async function connect(id: string, service: 'gsc' | 'ga4', property: string) {
  await send('PUT', '/api/settings/google-oauth-client', { clientId: SECRETS.clientId, clientSecret: SECRETS.clientSecret });
  const started = await send('POST', seo(id, `/connections/${service}/connect`));
  const state = new URL(started.body.authUrl).searchParams.get('state')!;
  assert.equal((await api(`/api/seo/oauth/callback?code=abc&state=${state}`)).status, 200);
  assert.equal((await send('PUT', seo(id, `/connections/${service}/property`), { property })).status, 200);
}
const connectGsc = (id: string) => connect(id, 'gsc', `${origin}/`);

async function runSync(id: string) {
  assert.equal((await send('POST', seo(id, '/sync'))).status, 202);
  await sync.waitForSync(id);
  assert.equal(sync.latestSync(id)!.status, 'done');
}

/** A Building with GSC (and optionally GA4) connected and `months` of history synced. */
async function seeded(options: { months?: number; ga4?: boolean } = {}) {
  const b = await createSeo();
  await connectGsc(b.id);
  if (options.ga4) await connect(b.id, 'ga4', '123456');
  await send('PATCH', seo(b.id, '/data'), { retentionMonths: options.months ?? 1 });
  await runSync(b.id);
  return b;
}

const xml = (urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const serve = (pathname: string, body: string | Buffer, headers: Record<string, string> = { 'content-type': 'application/xml' }) => {
  routes.set(pathname, (_req, res) => { for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(body); });
};
const gscSitemap = (pathname: string, extra: Partial<import('../src/seo/services.ts').GscSitemap> = {}) => ({
  path: `${origin}${pathname}`, lastSubmitted: '2026-03-01T00:00:00Z', lastDownloaded: '2026-03-10T00:00:00Z', isPending: false, isIndex: false, type: 'sitemap', warnings: 0, errors: 0, submitted: 10, indexed: null, ...extra,
});
async function readSitemaps(id: string) {
  const res = await send('POST', seo(id, '/sitemaps/read'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (await api(seo(id, '/sitemaps'))).body;
}
const urlsOf = async (id: string, query = '') => (await api(seo(id, `/sitemaps/urls?limit=200${query}`))).body;
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(check(), 'condition was not met'); };

/* ----- Pages ----- */

test('I1 the default range compares 28 days with the 28 before, equal to hand-computed numbers', async () => {
  fake.state.gscRows = (day) => [{ page: `${origin}/a`, query: 'q', clicks: day < '2026-02-15' ? 1 : 2, impressions: 10, ctr: 0.1, position: day < '2026-02-15' ? 8 : 4 }];
  const b = await seeded({ months: 3, ga4: true });
  const res = await api(seo(b.id, '/pages'));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.range, { from: '2026-02-15', to: '2026-03-14' });
  assert.deepEqual(res.body.previousRange, { from: '2026-01-18', to: '2026-02-14' });
  const row = res.body.rows.find((r: any) => r.url === `https://${origin.replace('http://', '')}/a`);
  assert.deepEqual([row.current.clicks, row.current.impressions, row.current.ctr, row.current.position], [56, 280, 0.2, 4]);
  assert.deepEqual([row.previous.clicks, row.previous.impressions, row.previous.position], [28, 280, 8]);
  assert.deepEqual(row.delta.clicks, { abs: 28, pct: 1, isNew: false });
  assert.deepEqual(row.delta.position, { abs: -4, pct: -0.5, isNew: false });
  assert.equal(row.current.sessions, 0, 'GA4 was fetched for the window, so a page with no row there really had zero sessions');
});

test('I2 connection matrix: neither, GSC only, GA4 only', async () => {
  const none = await createSeo();
  serve('/sitemap.xml', xml([`${origin}/only-in-sitemap`]));
  await readSitemaps(none.id);
  const empty = (await api(seo(none.id, '/pages'))).body;
  assert.deepEqual([empty.gsc.connected, empty.ga4.connected, empty.rows.length], [false, false, 1]);
  assert.equal(empty.rows[0].current.clicks, null);
  assert.equal(empty.rows[0].sources.sitemaps, 1);
  const gscOnly = await seeded();
  const g = (await api(seo(gscOnly.id, '/pages'))).body;
  assert.deepEqual([g.gsc.connected, g.ga4.connected], [true, false]);
  assert.equal(g.rows[0].current.sessions, null);
  const ga4Only = await createSeo();
  await connect(ga4Only.id, 'ga4', '123456');
  await send('PATCH', seo(ga4Only.id, '/data'), { retentionMonths: 1 });
  await runSync(ga4Only.id);
  const a = (await api(seo(ga4Only.id, '/pages'))).body;
  assert.deepEqual([a.gsc.connected, a.ga4.connected], [false, true]);
  assert.ok(a.rows.every((r: any) => r.current.clicks === null && r.current.sessions !== null));
});

test('I3 gap days give a partial flag and a window with no fetched days gives no data, never zero', async () => {
  const b = await seeded({ months: 1 });
  const partial = (await api(seo(b.id, '/pages?from=2026-02-01&to=2026-03-14&compare=none'))).body;
  assert.equal(partial.gsc.coverage.current.state, 'partial');
  const before = (await api(seo(b.id, '/pages?from=2025-06-01&to=2025-06-28&compare=none'))).body;
  assert.equal(before.gsc.coverage.current.state, 'none');
  assert.ok(before.rows.every((r: any) => r.current.clicks === null && r.current.impressions === null));
});

test('I4 one page seen as an https GSC URL, a trailing-slash variant, a tracked sitemap URL and a GA4 path is one row with summed metrics', async () => {
  const b = await seeded({ ga4: true });
  serve('/sitemap.xml', xml([`${origin}/page-0/?utm_source=x`]));
  await readSitemaps(b.id);
  const rows = (await api(seo(b.id, '/pages?limit=500'))).body.rows.filter((r: any) => r.path === '/page-0');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].current.clicks, 3 * 28);
  assert.deepEqual([rows[0].sources.gsc, rows[0].sources.ga4, rows[0].sources.sitemaps], [true, true, 1]);
  assert.equal(rows[0].current.sessions, 5 * 28);
});

test('I5 parameters are validated with a 400 naming the limit', async () => {
  const b = await seeded();
  const bad = ['from=2026-03-01', 'from=2026-03-10&to=2026-03-01', 'from=2024-01-01&to=2026-03-10', 'sort=nope', 'filter=nope', 'dir=sideways', 'compare=yes', 'limit=0', 'limit=-1', 'limit=501', 'limit=abc', `offset=${2 ** 53}`, 'offset=-1', `search=${'x'.repeat(501)}`, `prefix=${'x'.repeat(501)}`, 'from=2026-03-01&to=2026-03-30'];
  for (const q of bad) {
    const res = await api(seo(b.id, `/pages?${q}`));
    assert.equal(res.status, 400, q);
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal((await api(seo(b.id, '/pages?limit=500&offset=0'))).status, 200);
});

test('I6 sort, search, prefix, filter and paging are stable', async () => {
  const b = await seeded();
  const all = (await api(seo(b.id, '/pages?sort=clicks&dir=desc&limit=500'))).body.rows.map((r: any) => r.path);
  const paged: string[] = [];
  for (let offset = 0; offset < all.length; offset += 1) paged.push(...(await api(seo(b.id, `/pages?sort=clicks&dir=desc&limit=1&offset=${offset}`))).body.rows.map((r: any) => r.path));
  assert.deepEqual(paged, all);
  assert.deepEqual((await api(seo(b.id, '/pages?search=PAGE-1'))).body.rows.map((r: any) => r.path), ['/page-1']);
  assert.deepEqual((await api(seo(b.id, '/pages?prefix=page-0'))).body.rows.map((r: any) => r.path), ['/page-0']);
  assert.equal((await api(seo(b.id, '/pages?prefix=.*'))).body.total, 0, 'regular expression characters are literal');
  assert.deepEqual((await api(seo(b.id, '/pages?filter=no-clicks'))).body.rows.map((r: any) => r.path), ['/page-1']);
  assert.equal((await api(seo(b.id, '/pages?filter=no-impressions'))).body.total, 0);
  const asc = (await api(seo(b.id, '/pages?sort=position&dir=asc'))).body.rows.map((r: any) => r.path);
  assert.equal(asc[0], '/page-0');
});

test('I7 the drill-down returns the trend, the queries behind the page, sitemap membership and indexing state', async () => {
  const b = await seeded({ months: 3 });
  serve('/sitemap.xml', xml([`${origin}/page-0`]));
  await readSitemaps(b.id);
  const res = await api(seo(b.id, `/pages/detail?url=${encodeURIComponent(`${origin}/page-0`)}`));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.queries.rows.map((q: any) => [q.query, q.clicks, q.impressions]), [['alpha', 56, 560], ['gamma', 28, 140]]);
  assert.equal(res.body.queries.showingFirst, null);
  assert.equal(res.body.trend.length, 56);
  assert.equal(res.body.trend.filter((p: any) => p.period === 'current').length, 28);
  assert.deepEqual(res.body.crawl, { available: false, title: null, description: null });
  assert.equal(res.body.sitemaps.length, 1);
  assert.equal(res.body.indexing.state, 'never');
  assert.equal(res.body.current.clicks, 84);
});

test('I8 drill-down URL forms: percent-encoded, unicode and an unknown page', async () => {
  fake.state.gscRows = () => [{ page: `${origin}/café`, query: 'q', clicks: 1, impressions: 2, ctr: 0.5, position: 1 }];
  const b = await seeded();
  for (const url of [`${origin}/caf%C3%A9`, `${origin}/café`, `${origin}/café/`]) assert.equal((await api(seo(b.id, `/pages/detail?url=${encodeURIComponent(url)}`))).status, 200, url);
  assert.equal((await api(seo(b.id, `/pages/detail?url=${encodeURIComponent(`${origin}/nowhere`)}`))).status, 404);
  assert.equal((await api(seo(b.id, '/pages/detail?url=notaurl'))).status, 400);
  assert.equal((await api(seo(b.id, `/pages/detail?url=${encodeURIComponent(`${origin}/${'a'.repeat(2100)}`)}`))).status, 400);
});

test('I9 a page with more than 100 queries shows the first 100 and says so; odd query text is kept', async () => {
  fake.state.gscRows = () => [
    ...Array.from({ length: 150 }, (_, i) => ({ page: `${origin}/many`, query: `query ${String(i).padStart(3, '0')}`, clicks: 150 - i, impressions: 1000, ctr: 0.1, position: 3 })),
    { page: `${origin}/many`, query: '🚀 "quotes" & <tags>', clicks: 1000, impressions: 5, ctr: 0.1, position: 1 },
    { page: `${origin}/many`, query: 'x'.repeat(2000), clicks: 0, impressions: 1, ctr: 0, position: 1 },
  ];
  const b = await seeded();
  const res = (await api(seo(b.id, `/pages/detail?url=${encodeURIComponent(`${origin}/many`)}`))).body;
  assert.equal(res.queries.rows.length, 100);
  assert.deepEqual([res.queries.total, res.queries.showingFirst], [152, 100]);
  assert.equal(res.queries.rows[0].query, '🚀 "quotes" & <tags>');
});

test('I10 a site with 120,000+ pages still answers within a lenient bound', async () => {
  const b = await seeded();
  const project = (await projectsDb.get(b.id))!;
  const store = await storage.getStore(project);
  const rows: Array<Array<string | number>> = [];
  for (let i = 0; i < 125_000; i++) rows.push([`${origin}/`, '2026-03-14', '2026-W11', '2026-03', `${origin}/bulk/${i}`, 'q', 1, 2, 3]);
  for (let i = 0; i < rows.length; i += 25_000) await store.insert('gsc_rows', rows.slice(i, i + 25_000));
  const started = Date.now();
  const res = await api(seo(b.id, '/pages?limit=50&sort=impressions'));
  assert.equal(res.status, 200);
  assert.ok(res.body.total >= 125_000);
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
});

test('I11 unknown and non-SEO Buildings answer 404, and a Building with no data has an empty list', async () => {
  assert.equal((await api(seo('no-such-building', '/pages'))).status, 404);
  assert.equal((await api(seo('no-such-building', '/sitemaps'))).status, 404);
  const notes = await send('POST', '/api/projects', { name: 'Plain notes', typeId: 'notes' });
  assert.equal((await api(seo(notes.body.id, '/pages'))).status, 404);
  const empty = await createSeo();
  const res = (await api(seo(empty.id, '/pages'))).body;
  assert.deepEqual([res.total, res.rows], [0, []]);
});

test('I12 moving the injected clock moves the default range', async () => {
  const b = await seeded();
  const first = (await api(seo(b.id, '/pages'))).body.range;
  clock = new Date('2026-03-20T12:00:00Z');
  await runSync(b.id);
  const second = (await api(seo(b.id, '/pages'))).body.range;
  assert.equal(first.to, '2026-03-14');
  assert.equal(second.to, '2026-03-19');
});

test('I13 after old data is discarded, pages in that period show no data', async () => {
  const b = await seeded({ months: 3 });
  await send('PATCH', seo(b.id, '/data'), { retentionMonths: 1 });
  await send('POST', seo(b.id, '/data/discard/acknowledge'));
  const started = await send('POST', seo(b.id, '/data/discard'));
  for (let i = 0; i < 400; i++) { if ((await api(`/api/projects/${b.id}/storage/jobs/${started.body.id}`)).body.status !== 'running') break; await new Promise((r) => setTimeout(r, 25)); }
  const res = (await api(seo(b.id, '/pages?from=2026-01-18&to=2026-02-14&compare=none'))).body;
  assert.equal(res.gsc.coverage.current.state, 'none');
  assert.ok(res.rows.every((r: any) => r.current.clicks === null));
});

/* ----- Sitemap discovery and reading ----- */

test('I14 discovery merges Search Console, robots.txt and the default address, each tagged with its source', async () => {
  const b = await seeded();
  fake.state.gscSitemaps = [gscSitemap('/from-gsc.xml'), gscSitemap('/both.xml')];
  serve('/robots.txt', `User-agent: *\nSitemap: ${origin}/both.xml\nSitemap: ${origin}/from-robots.xml\nSitemap: /relative.xml\n`);
  for (const p of ['/from-gsc.xml', '/both.xml', '/from-robots.xml', '/sitemap.xml']) serve(p, xml([`${origin}/x${p}`]));
  const view = await readSitemaps(b.id);
  const sources = Object.fromEntries(view.sitemaps.map((s: any) => [new URL(s.url).pathname, s.sources]));
  assert.deepEqual(sources, { '/both.xml': ['gsc', 'robots'], '/from-gsc.xml': ['gsc'], '/from-robots.xml': ['robots'], '/sitemap.xml': ['default'] });
});

test('I15 an index lists its children and one failing child does not fail the parent', async () => {
  const b = await seeded();
  serve('/sitemap.xml', `<sitemapindex><sitemap><loc>${origin}/c1.xml</loc></sitemap><sitemap><loc>${origin}/c2.xml</loc></sitemap></sitemapindex>`);
  serve('/c1.xml', xml([`${origin}/a`, `${origin}/b`]));
  const view = await readSitemaps(b.id);
  const by = Object.fromEntries(view.sitemaps.map((s: any) => [new URL(s.url).pathname, s]));
  assert.equal(by['/sitemap.xml'].status, 'ok');
  assert.deepEqual(by['/sitemap.xml'].children.map((c: string) => new URL(c).pathname), ['/c1.xml', '/c2.xml']);
  assert.equal(by['/c1.xml'].urlCount, 2);
  assert.equal(by['/c2.xml'].status, 'fetch-failed');
  assert.match(by['/c2.xml'].error, /HTTP 404/);
  assert.equal(by['/c1.xml'].parent, by['/sitemap.xml'].url);
});

test('I16 fetch failures: 404, 500, timeout, a redirect to another host and an HTML page are listed with their reason', async () => {
  const b = await seeded();
  deps.configureSeo({ limits: { ...deps.defaultLimits(), fetchTimeoutMs: 300 } });
  fake.state.gscSitemaps = ['/s404.xml', '/s500.xml', '/slow.xml', '/redirect.xml', '/html.xml'].map((p) => gscSitemap(p));
  routes.set('/s500.xml', (_req, res) => { res.statusCode = 500; res.end('boom'); });
  routes.set('/slow.xml', () => { /* never answers */ });
  routes.set('/redirect.xml', (_req, res) => { res.statusCode = 302; res.setHeader('location', 'http://example.org/sitemap.xml'); res.end(); });
  serve('/html.xml', '<html><body>Welcome</body></html>', { 'content-type': 'text/html' });
  const view = await readSitemaps(b.id);
  const by = Object.fromEntries(view.sitemaps.map((s: any) => [new URL(s.url).pathname, s]));
  assert.match(by['/s404.xml'].error, /HTTP 404/);
  assert.match(by['/s500.xml'].error, /HTTP 500/);
  assert.match(by['/slow.xml'].error, /did not answer in time/);
  assert.match(by['/redirect.xml'].error, /redirected somewhere that is not allowed/);
  assert.equal(by['/html.xml'].status, 'not-a-sitemap');
  site.closeAllConnections();
});

test('I17 limits hold against the real source: an endless body, an oversize content-length and a gzip bomb', async () => {
  const b = await seeded();
  deps.configureSeo({ limits: { ...deps.defaultLimits(), sitemapBytes: 100_000, fetchTimeoutMs: 3000 } });
  fake.state.gscSitemaps = ['/endless.xml', '/big.xml', '/bomb.xml.gz'].map((p) => gscSitemap(p));
  routes.set('/endless.xml', (_req, res) => {
    res.write('<urlset>');
    const timer = setInterval(() => { if (!res.write('x'.repeat(50_000))) clearInterval(timer); }, 1);
    res.on('close', () => clearInterval(timer));
  });
  routes.set('/big.xml', (_req, res) => { res.setHeader('content-length', '99999999'); res.write('<urlset>'); res.on('error', () => undefined); setTimeout(() => res.destroy(), 500); });
  serve('/bomb.xml.gz', gzipSync(Buffer.alloc(5_000_000)), { 'content-type': 'application/gzip' });
  const view = await readSitemaps(b.id);
  const by = Object.fromEntries(view.sitemaps.map((s: any) => [new URL(s.url).pathname, s]));
  assert.match(by['/endless.xml'].error, /larger than the allowed size/);
  assert.match(by['/big.xml'].error, /larger than the allowed size/);
  assert.match(by['/bomb.xml.gz'].error, /not valid gzip data or expands beyond the allowed size/);
  site.closeAllConnections();
});

test('I18 a sitemap with 50,001 URLs shows the first 50,000 and a notice', async () => {
  const b = await seeded();
  serve('/sitemap.xml', xml(Array.from({ length: 50_001 }, (_, i) => `${origin}/p/${i}`)));
  const view = await readSitemaps(b.id);
  const s = view.sitemaps[0];
  assert.deepEqual([s.urlCount, s.showingFirst], [50_000, 50_000]);
  assert.ok(s.warnings.some((w: string) => /only the first 50,000/.test(w)));
  assert.equal((await urlsOf(b.id)).total, 50_000);
});

test('I19 gzip arrives both as a .gz file and as Content-Encoding', async () => {
  const b = await seeded();
  fake.state.gscSitemaps = [gscSitemap('/a.xml.gz'), gscSitemap('/b.xml')];
  serve('/a.xml.gz', gzipSync(Buffer.from(xml([`${origin}/one`]))), { 'content-type': 'application/gzip' });
  serve('/b.xml', gzipSync(Buffer.from(xml([`${origin}/two`, `${origin}/three`]))), { 'content-type': 'application/xml', 'content-encoding': 'gzip' });
  const view = await readSitemaps(b.id);
  const counts = Object.fromEntries(view.sitemaps.map((s: any) => [new URL(s.url).pathname, s.urlCount]));
  assert.deepEqual(counts, { '/a.xml.gz': 1, '/b.xml': 2 });
});

test('I20 other-host, invalid and duplicate entries are warnings and are not counted', async () => {
  const b = await seeded();
  serve('/sitemap.xml', xml([`${origin}/ok`, `${origin}/ok/`, `${origin}/ok?utm_source=a`, 'https://elsewhere.example/page', '/relative', '', `${origin}/${'a'.repeat(2100)}`, 'ftp://x/y']));
  const s = (await readSitemaps(b.id)).sitemaps[0];
  assert.equal(s.urlCount, 1);
  assert.equal(s.otherHostCount, 1);
  assert.ok(s.warningCount >= 4);
  assert.ok(s.warnings.some((w: string) => /on another host/.test(w)));
});

test('I21 Search Console fields are shown, a missing indexed count is null, and without GSC fetched sitemaps are still listed', async () => {
  const b = await seeded();
  fake.state.gscSitemaps = [gscSitemap('/sitemap.xml', { warnings: 2, errors: 1, submitted: 40, indexed: null })];
  serve('/sitemap.xml', xml([`${origin}/a`]));
  const view = await readSitemaps(b.id);
  assert.deepEqual([view.gsc.state, view.sitemaps[0].gsc.warnings, view.sitemaps[0].gsc.errors, view.sitemaps[0].gsc.submitted, view.sitemaps[0].gsc.indexed], ['connected', 2, 1, 40, null]);
  assert.equal(view.sitemaps[0].gsc.lastSubmitted, '2026-03-01T00:00:00Z');
  const bare = await createSeo();
  const listed = await readSitemaps(bare.id);
  assert.equal(listed.gsc.state, 'not-connected');
  assert.equal(listed.sitemaps[0].gsc, null);
  assert.equal(listed.sitemaps[0].urlCount, 1);
  fake.fail('listSitemaps', network());
  const failed = await readSitemaps(b.id);
  assert.equal(failed.gsc.state, 'error');
  assert.equal(failed.sitemaps.length, 1, 'sitemaps known from Search Console are kept when it cannot be reached');
});

test('I22 two concurrent re-reads of one sitemap share one fetch', async () => {
  const b = await seeded();
  serve('/sitemap.xml', xml([`${origin}/a`]));
  await readSitemaps(b.id);
  const url = `${origin}/sitemap.xml`;
  hits.length = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  routes.set('/sitemap.xml', (_req, res) => { void gate.then(() => res.end(xml([`${origin}/a`, `${origin}/b`]))); });
  const first = send('POST', seo(b.id, '/sitemaps/reread'), { sitemap: url });
  await waitFor(() => hits.length === 1);
  const second = send('POST', seo(b.id, '/sitemaps/reread'), { sitemap: url });
  await new Promise((r) => setTimeout(r, 50));
  release();
  const [a, c] = await Promise.all([first, second]);
  assert.deepEqual([a.status, c.status], [200, 200]);
  assert.equal(hits.filter((h) => h === '/sitemap.xml').length, 1);
  assert.deepEqual(a.body, c.body);
});

test('I23 a conflicting action on a busy sitemap is 409', async () => {
  const b = await seeded();
  await send('PUT', seo(b.id, '/connections/indexnow'), { key: SECRETS.indexNow });
  serve('/sitemap.xml', xml([`${origin}/a`]));
  await readSitemaps(b.id);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fake.state.indexNowGate = () => gate;
  const submitting = send('POST', seo(b.id, '/indexnow/submit'), { mode: 'sitemap', sitemap: `${origin}/sitemap.xml` });
  await waitFor(() => true);
  await new Promise((r) => setTimeout(r, 100));
  const conflict = await send('POST', seo(b.id, '/sitemaps/reread'), { sitemap: `${origin}/sitemap.xml` });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /already busy/);
  assert.equal((await send('POST', seo(b.id, '/sitemaps/read'))).status, 409);
  release();
  assert.equal((await submitting).status, 200);
});

/* ----- URL inspection ----- */

async function withSitemap(count = 3) {
  const b = await seeded();
  serve('/sitemap.xml', xml(Array.from({ length: count }, (_, i) => `${origin}/u${i}`)));
  await readSitemaps(b.id);
  return b;
}
const quotaOf = async (id: string) => (await api(seo(id, '/sitemaps'))).body.quota;
const inspect = (id: string, urls: string[]) => send('POST', seo(id, '/sitemaps/urls/inspect'), { urls });

test('I24 on-demand inspection stores the status and time, and counts against the quota', async () => {
  const b = await withSitemap();
  fake.state.inspections.set(`${origin}/u1`, { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' });
  // Manual inspections run in parallel, so hold /u0 until /u1 is recorded: Google may answer them in either order.
  fake.state.inspectGate = async (url) => {
    while (url.endsWith('/u0') && !fake.state.inspectCalls.includes(`${origin}/u1`)) await new Promise((r) => setImmediate(r));
  };
  const res = await inspect(b.id, [`${origin}/u0`, `${origin}/u1`]);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.results.map((r: any) => [r.status, r.state]), [['inspected', 'indexed'], ['inspected', 'not-indexed']]);
  assert.equal(res.body.results[1].reason, 'Crawled - currently not indexed');
  assert.equal(res.body.quota.used, 2);
  const listed = await urlsOf(b.id);
  assert.equal(listed.rows.find((r: any) => r.url.endsWith('/u0')).indexing.inspectedAt, clock.toISOString());
  assert.deepEqual([...fake.state.inspectCalls].sort(), [`${origin}/u0`, `${origin}/u1`], 'a URL-prefix property is inspected in its own protocol');
});

test('I25 manual requests beyond the quota inspect what fits, the rest wait, and the count never passes 2,000, even in parallel', async () => {
  const b = await withSitemap(10);
  const project = (await projectsDb.get(b.id))!;
  await inspection.claimInspections(project, 1995, 'manual');
  const urls = Array.from({ length: 10 }, (_, i) => `${origin}/u${i}`);
  const [one, two] = await Promise.all([inspect(b.id, urls.slice(0, 5)), inspect(b.id, urls.slice(5))]);
  const statuses = [...one.body.results, ...two.body.results].map((r: any) => r.status);
  assert.equal(statuses.filter((s) => s === 'inspected').length, 5);
  assert.equal(statuses.filter((s) => s === 'waiting').length, 5);
  assert.equal((await quotaOf(b.id)).used, 2000);
  assert.equal(fake.state.inspectCalls.length, 5);
  const waiting = (await urlsOf(b.id, '&filter=waiting')).rows;
  assert.equal(waiting.length, 5);
  assert.ok(waiting.every((r: any) => r.indexing.waitingForQuota));
});

test('I26 the background pass takes new and changed URLs first, stops at 1,800 and leaves room for a manual request', async () => {
  const b = await withSitemap(3);
  const project = (await projectsDb.get(b.id))!;
  await inspect(b.id, [`${origin}/u2`]);
  await inspection.claimInspections(project, 1798, 'manual');
  fake.state.inspectCalls.length = 0;
  const result = await inspection.runInspectionPass(project);
  assert.equal(result.stoppedBecause, 'quota');
  assert.equal(result.inspected, 1);
  assert.deepEqual(fake.state.inspectCalls, [`${origin}/u0`], 'a never-inspected URL goes first, the fresh one is skipped, and the pass stops at 1,800');
  const manual = await inspect(b.id, [`${origin}/u2`]);
  assert.equal(manual.body.results[0].status, 'inspected');
});

test('I27 with the quota exhausted URLs wait, Google is not called, and they resume after Pacific midnight', async () => {
  const b = await withSitemap(2);
  const project = (await projectsDb.get(b.id))!;
  await inspection.claimInspections(project, 2000, 'manual');
  const res = await inspect(b.id, [`${origin}/u0`]);
  assert.equal(res.body.results[0].status, 'waiting');
  assert.equal(fake.state.inspectCalls.length, 0);
  assert.equal(res.body.quota.exhausted, true);
  assert.equal(res.body.quota.resetsAt, '2026-03-16T07:00:00.000Z');
  clock = new Date('2026-03-16T07:00:00Z');
  const pass = await inspection.runInspectionPass(project);
  assert.equal(pass.inspected, 2);
  assert.equal(fake.state.inspectCalls[0], `${origin}/u0`, 'the waiting request goes first');
  assert.equal((await quotaOf(b.id)).used, 2);
});

test('I28 a Google quota error mid-pass marks the day exhausted and makes no more calls', async () => {
  const b = await withSitemap(4);
  const project = (await projectsDb.get(b.id))!;
  fake.fail('inspectUrl', quota());
  const pass = await inspection.runInspectionPass(project);
  assert.equal(pass.stoppedBecause, 'quota');
  assert.equal((await quotaOf(b.id)).exhausted, true);
  const callsBefore = fake.state.inspectCalls.length;
  assert.equal((await inspect(b.id, [`${origin}/u0`])).body.results[0].status, 'waiting');
  assert.equal(fake.state.inspectCalls.length, callsBefore);
});

test('I29 inspection errors: sign-in, a refused URL, a network failure, and no connection', async () => {
  const b = await withSitemap(3);
  fake.fail('inspectUrl', accessRefused());
  const refused = await inspect(b.id, [`${origin}/u0`]);
  assert.equal(refused.body.results[0].status, 'error');
  fake.fail('inspectUrl', network());
  assert.equal((await inspect(b.id, [`${origin}/u1`])).body.results[0].status, 'error');
  fake.fail('inspectUrl', authFailure());
  const auth = await inspect(b.id, [`${origin}/u2`]);
  assert.equal(auth.status, 409);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'needs-attention');
  const bare = await createSeo();
  const none = await inspect(bare.id, [`${origin}/u0`]);
  assert.equal(none.status, 409);
  assert.match(none.body.error, /Connect Search Console/);
});

test('I30 inspection input is validated', async () => {
  const b = await withSitemap(1);
  for (const urls of [[], 'x', [42], ['notaurl'], ['https://elsewhere.example/a'], Array.from({ length: 201 }, (_, i) => `${origin}/p${i}`)]) assert.equal((await inspect(b.id, urls as string[])).status, 400, JSON.stringify(urls).slice(0, 40));
  const dup = await inspect(b.id, [`${origin}/u0`, `${origin}/u0/`, `${origin}/u0?utm_source=x`]);
  assert.equal(dup.body.results.length, 1);
  assert.equal(fake.state.inspectCalls.length, 1);
});

test('I46 a crash between the Google call and recording it still counts the call', async () => {
  const b = await withSitemap(1);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fake.state.inspectGate = async () => { await gate; throw new Error('process died'); };
  const pending = inspect(b.id, [`${origin}/u0`]);
  await waitFor(() => true);
  await new Promise((r) => setTimeout(r, 100));
  await inspection.stopInspection(b.id);
  assert.equal((await quotaOf(b.id)).used, 1, 'the count was written to disk before the call');
  release();
  await pending;
});

/* ----- IndexNow and Bing ----- */

const withKey = async (id: string) => { assert.equal((await send('PUT', seo(id, '/connections/indexnow'), { key: SECRETS.indexNow })).status, 200); serve(`/${SECRETS.indexNow}.txt`, SECRETS.indexNow, { 'content-type': 'text/plain' }); };
const submit = (id: string, body: unknown) => send('POST', seo(id, '/indexnow/submit'), body);
const log = async (id: string, query = '') => (await api(seo(id, `/indexnow/log?limit=200${query}`))).body;

test('I31 submitting selected URLs logs one row per URL and sends the key and key location to IndexNow', async () => {
  const b = await withSitemap(3);
  await withKey(b.id);
  const res = await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`, `${origin}/u1`] });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.total, res.body.batches, res.body.accepted, res.body.keyFile, res.body.keyFileWarning], [2, 1, 2, 'reachable', false]);
  const call = fake.state.indexNowCalls[0]!;
  assert.deepEqual([call.key, call.keyLocation, call.urls, call.host], [SECRETS.indexNow, `${origin}/${SECRETS.indexNow}.txt`, [`${origin}/u0`, `${origin}/u1`], origin.replace('http://', '')]);
  const entries = (await log(b.id)).entries;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e: any) => [e.result, e.httpStatus, e.endpoint]), [['accepted', 200, 'api.indexnow.org'], ['accepted', 200, 'api.indexnow.org']]);
  assert.match(entries[0].message, /not a confirmation/);
  assert.equal((await urlsOf(b.id)).rows.find((r: any) => r.url.endsWith('/u0')).indexNow.result, 'accepted');
});

test('I32 a whole sitemap is split into batches of 10,000 and a failed batch is logged per URL while others succeed', async () => {
  const b = await seeded();
  await withKey(b.id);
  serve('/sitemap.xml', xml(Array.from({ length: 10_001 }, (_, i) => `${origin}/p/${i}`)));
  await readSitemaps(b.id);
  let n = 0;
  fake.state.indexNowAnswer = () => ({ status: ++n === 1 ? 200 : 503, retryAfter: null });
  const res = await submit(b.id, { mode: 'sitemap', sitemap: `${origin}/sitemap.xml` });
  assert.deepEqual([res.body.batches, res.body.accepted, res.body.errors], [2, 10_000, 1]);
  assert.deepEqual(fake.state.indexNowCalls.map((c) => c.urls.length), [10_000, 1]);
  const store = await storage.getStore((await projectsDb.get(b.id))!);
  const { rows } = await store.groupSums({ source: 'seo_indexnow_log', groupBy: ['result', 'httpStatus'] });
  assert.deepEqual(rows.map((r) => [r.result, r.httpStatus, r.rows]).sort(), [['accepted', 200, 10_000], ['error', 503, 1]]);
});

test('I33 new or changed submits only addresses added since the last read or changed after their last submission', async () => {
  const b = await seeded();
  await withKey(b.id);
  serve('/sitemap.xml', xml([`${origin}/a`, `${origin}/b`]));
  await readSitemaps(b.id);
  assert.equal((await submit(b.id, { mode: 'new-or-changed' })).body.total, 2, 'on the first read everything is new');
  clock = new Date('2026-03-15T12:05:00Z');
  serve('/sitemap.xml', `<urlset><url><loc>${origin}/a</loc></url><url><loc>${origin}/b</loc><lastmod>2026-03-15T12:03:00Z</lastmod></url><url><loc>${origin}/c</loc></url></urlset>`);
  await send('POST', seo(b.id, '/sitemaps/read'));
  clock = new Date('2026-03-15T12:10:00Z');
  const res = await submit(b.id, { mode: 'new-or-changed' });
  assert.equal(res.body.total, 2);
  assert.deepEqual(fake.state.indexNowCalls.at(-1)!.urls.sort(), [`${origin}/b`, `${origin}/c`]);
  clock = new Date('2026-03-15T12:20:00Z');
  assert.equal((await submit(b.id, { mode: 'new-or-changed' })).status, 400, 'nothing left to submit');
});

test('I34 rejections show their reason and are not retried', async () => {
  const b = await withSitemap(1);
  await withKey(b.id);
  for (const [status, text] of [[400, /malformed/], [403, /key is not valid/], [422, /do not belong/]] as const) {
    clock = new Date(clock.getTime() + 120_000);
    fake.state.indexNowAnswer = () => ({ status, retryAfter: null });
    const calls = fake.state.indexNowCalls.length;
    const res = await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] });
    assert.equal(res.body.rejected, 1);
    assert.equal(fake.state.indexNowCalls.length, calls + 1);
    assert.match((await log(b.id)).entries[0].message, text);
  }
  clock = new Date(clock.getTime() + 120_000);
  fake.state.indexNowAnswer = () => ({ status: 429, retryAfter: '90' });
  const limited = await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] });
  assert.equal(limited.body.retryAt, new Date(clock.getTime() + 90_000).toISOString());
});

test('I35 a second submission inside the rate limit is refused with a retry time and IndexNow is not called', async () => {
  const b = await withSitemap(1);
  await withKey(b.id);
  await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] });
  const calls = fake.state.indexNowCalls.length;
  const again = await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] });
  assert.equal(again.status, 429);
  assert.equal(again.body.details.retryAt, '2026-03-15T12:01:00.000Z');
  assert.equal(fake.state.indexNowCalls.length, calls);
  clock = new Date('2026-03-15T12:01:00Z');
  assert.equal((await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] })).status, 200);
});

test('I36 no key is 409; an unreachable key file still submits with a warning; other hosts and bad input are 400', async () => {
  const b = await withSitemap(1);
  assert.equal((await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] })).status, 409);
  assert.equal((await send('PUT', seo(b.id, '/connections/indexnow'), { key: SECRETS.indexNow })).status, 200);
  const res = await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.keyFile, res.body.keyFileWarning], ['not-found', true]);
  clock = new Date('2026-03-15T12:05:00Z');
  assert.equal((await submit(b.id, { mode: 'selected', urls: ['https://elsewhere.example/a'] })).status, 400);
  for (const body of [{ mode: 'nope' }, { mode: 'selected', urls: [] }, { mode: 'selected', urls: [1] }, { mode: 'selected', urls: Array.from({ length: 10_001 }, (_, i) => `${origin}/p${i}`) }, { mode: 'sitemap', sitemap: 'x' }, { mode: 'sitemap', sitemap: `${origin}/unknown.xml` }]) {
    assert.equal((await submit(b.id, body)).status, 400, JSON.stringify(body).slice(0, 50));
  }
});

test('I37 nothing is ever submitted automatically', async () => {
  const b = await withSitemap(2);
  await withKey(b.id);
  await send('POST', seo(b.id, '/sync'));
  await sync.waitForSync(b.id);
  await send('POST', seo(b.id, '/sync/on-open'));
  await send('POST', seo(b.id, '/sitemaps/read'));
  await inspection.runInspectionPass((await projectsDb.get(b.id))!);
  await maintenance.runSeoMaintenance();
  await storage.closeAllStores();
  assert.equal(fake.state.indexNowCalls.length, 0);
});

test('I38 IndexNow has no indexed status; Bing information appears only when Bing is connected and a failure affects one URL only', async () => {
  const b = await withSitemap(2);
  const before = (await urlsOf(b.id)).rows;
  assert.ok(before.every((r: any) => r.bing.state === 'not-connected'));
  assert.equal((await send('POST', seo(b.id, '/sitemaps/bing-check'), { urls: [`${origin}/u0`] })).status, 409);
  await send('PUT', seo(b.id, '/connections/bing'), { apiKey: SECRETS.bing });
  assert.ok((await urlsOf(b.id)).rows.every((r: any) => r.bing.state === 'unchecked'));
  const n0 = `${origin.replace('http:', 'https:')}/u0`;
  const n1 = `${origin.replace('http:', 'https:')}/u1`;
  fake.state.bingInfo.set(n0, { discoveredAt: '2026-01-01T00:00:00Z', lastCrawledAt: '2026-03-01T00:00:00Z', httpCode: 200 });
  const res = await send('POST', seo(b.id, '/sitemaps/bing-check'), { urls: [`${origin}/u0`, `${origin}/u1`] });
  assert.deepEqual([res.body.results[n0].state, res.body.results[n1].state], ['known', 'not-found']);
  fake.fail('bingInfo', network());
  const partial = await send('POST', seo(b.id, '/sitemaps/bing-check'), { urls: [`${origin}/u0`, `${origin}/u1`] });
  assert.deepEqual([partial.body.results[n0].state, partial.body.results[n1].state], ['unavailable', 'not-found']);
  assert.equal((await send('POST', seo(b.id, '/sitemaps/bing-check'), { urls: [] })).status, 400);
});

test('I39 the key file check reports reachable, mismatch, missing and redirected, and is cached for a cooldown', async () => {
  const b = await withSitemap(1);
  assert.equal((await api(seo(b.id, '/indexnow/key-check'))).body.status, 'no-key');
  await send('PUT', seo(b.id, '/connections/indexnow'), { key: SECRETS.indexNow });
  assert.equal((await api(seo(b.id, '/indexnow/key-check'))).body.status, 'not-found');
  serve(`/${SECRETS.indexNow}.txt`, SECRETS.indexNow, { 'content-type': 'text/plain' });
  hits.length = 0;
  assert.equal((await api(seo(b.id, '/indexnow/key-check'))).body.status, 'not-found', 'cached inside the cooldown');
  assert.equal(hits.length, 0);
  assert.equal((await send('POST', seo(b.id, '/indexnow/key-check'))).body.status, 'reachable');
  serve(`/${SECRETS.indexNow}.txt`, 'something else', { 'content-type': 'text/plain' });
  assert.equal((await send('POST', seo(b.id, '/indexnow/key-check'))).body.status, 'mismatch');
  routes.set(`/${SECRETS.indexNow}.txt`, (_req, res) => { res.statusCode = 301; res.setHeader('location', 'http://example.org/k.txt'); res.end(); });
  assert.equal((await send('POST', seo(b.id, '/indexnow/key-check'))).body.status, 'redirected');
});

test('I40 the IndexNow key, Bing key and tokens appear in no response, log row, error or stored database file', async () => {
  const b = await withSitemap(2);
  logs.length = 0;
  await withKey(b.id);
  await send('PUT', seo(b.id, '/connections/bing'), { apiKey: SECRETS.bing });
  const texts: string[] = [];
  const keep = async (p: Promise<{ text: string }>) => { texts.push((await p).text); };
  await keep(Promise.resolve(await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] })));
  fake.state.indexNowAnswer = () => ({ status: 403, retryAfter: null });
  clock = new Date('2026-03-15T12:05:00Z');
  await keep(Promise.resolve(await submit(b.id, { mode: 'selected', urls: [`${origin}/u1`] })));
  for (const p of ['/sitemaps', '/sitemaps/urls', '/indexnow/key-check', '/indexnow/log', '/pages', '/connections']) await keep(api(seo(b.id, p)));
  await keep(send('POST', seo(b.id, '/sitemaps/bing-check'), { urls: [`${origin}/u0`] }));
  const secrets = [SECRETS.indexNow, SECRETS.bing, SECRETS.refresh, SECRETS.clientSecret];
  const dir = path.join(dataDir, 'buildings', b.id);
  for (const file of (await readdir(dir)).filter((f) => f !== 'secrets.json')) texts.push((await readFile(path.join(dir, file)).catch(() => Buffer.alloc(0))).toString('latin1'));
  texts.push(logs.join('\n'));
  for (const text of texts) for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.ok(texts.some((t) => t.includes('secr') === false || true));
});

test('I41 the log is newest first, pages, filters by URL, and old submissions are pruned beyond the cap', async () => {
  const b = await withSitemap(3);
  await withKey(b.id);
  deps.configureSeo({ limits: { ...deps.defaultLimits(), indexNowLogRows: 4 } });
  for (let i = 0; i < 3; i++) {
    clock = new Date(clock.getTime() + 120_000);
    await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`, `${origin}/u1`] });
  }
  const all = (await log(b.id)).entries;
  assert.equal(all.length, 4, 'the oldest whole submission was pruned');
  assert.ok(all.every((e: any, i: number) => i === 0 || all[i - 1].at >= e.at));
  const page = (await api(seo(b.id, '/indexnow/log?limit=1&offset=1'))).body;
  assert.deepEqual([page.entries.length, page.hasMore], [1, true]);
  assert.ok((await log(b.id, `&url=${encodeURIComponent(`${origin}/u0`)}`)).entries.every((e: any) => e.url === `${origin}/u0`));
  assert.equal((await api(seo(b.id, '/indexnow/log?limit=0'))).status, 400);
});

test('I42 sitemaps, inspections, the log and the quota count survive a restart', async () => {
  const b = await withSitemap(2);
  await withKey(b.id);
  await inspect(b.id, [`${origin}/u0`]);
  await submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] });
  await storage.closeAllStores();
  await inspection.stopInspection(b.id);
  assert.equal((await api(seo(b.id, '/sitemaps'))).body.sitemaps.length, 1);
  assert.equal((await api(seo(b.id, '/sitemaps'))).body.quota.used, 1);
  assert.equal((await urlsOf(b.id)).rows[0].indexing.state, 'indexed');
  assert.equal((await log(b.id)).entries.length, 1);
});

test('I43 deleting the Building removes its stored data', async () => {
  const b = await withSitemap(1);
  const dir = path.join(dataDir, 'buildings', b.id);
  assert.ok((await readdir(dir)).includes('bulk.sqlite'));
  assert.equal((await send('DELETE', `/api/projects/${b.id}`)).status, 204);
  await assert.rejects(readdir(dir));
});

test('I45 the drill-down shows sitemap membership and the indexing state, unknown until inspected', async () => {
  const b = await withSitemap(1);
  const detail = async () => (await api(seo(b.id, `/pages/detail?url=${encodeURIComponent(`${origin}/u0`)}`))).body;
  assert.deepEqual([(await detail()).sitemaps.length, (await detail()).indexing.state], [1, 'never']);
  await inspect(b.id, [`${origin}/u0`]);
  assert.equal((await detail()).indexing.state, 'indexed');
});

/* ----- Review round 1 ----- */

test('I47 two different selections are never merged: identical ones share a run, a different one is refused, not answered with the first result', async () => {
  const b = await withSitemap(3);
  await withKey(b.id);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fake.state.indexNowGate = () => gate;
  const first = submit(b.id, { mode: 'selected', urls: [`${origin}/u0`] });
  await new Promise((r) => setTimeout(r, 100));
  const same = submit(b.id, { mode: 'selected', urls: [`${origin}/u0/`] });
  const other = await submit(b.id, { mode: 'selected', urls: [`${origin}/u1`, `${origin}/u2`] });
  assert.equal(other.status, 429, 'the different selection ran on its own and hit the rate limit instead of joining the first run');
  release();
  const [a, c] = await Promise.all([first, same]);
  assert.deepEqual([a.status, c.status, a.body.batchId === c.body.batchId], [200, 200, true]);
  assert.equal(fake.state.indexNowCalls.length, 1);
});

test('I48 submitting a whole sitemap index sends the URLs of all its children', async () => {
  const b = await seeded();
  await withKey(b.id);
  serve('/sitemap.xml', `<sitemapindex><sitemap><loc>${origin}/c1.xml</loc></sitemap><sitemap><loc>${origin}/c2.xml</loc></sitemap></sitemapindex>`);
  serve('/c1.xml', xml([`${origin}/a`, `${origin}/b`]));
  serve('/c2.xml', xml([`${origin}/b`, `${origin}/c`]));
  await readSitemaps(b.id);
  const res = await submit(b.id, { mode: 'sitemap', sitemap: `${origin}/sitemap.xml` });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(fake.state.indexNowCalls[0]!.urls.sort(), [`${origin}/a`, `${origin}/b`, `${origin}/c`]);
});

test('I49 an unreachable robots.txt keeps sitemaps found only there, with their first-seen dates; ignored lines are shown as notes', async () => {
  const b = await seeded();
  serve('/robots.txt', `Sitemap: ${origin}/only-robots.xml\nSitemap: /relative.xml\n`);
  serve('/only-robots.xml', xml([`${origin}/r1`]));
  const first = await readSitemaps(b.id);
  assert.ok(first.notes.some((n: string) => /\/relative\.xml/.test(n)));
  const store = await storage.getStore((await projectsDb.get(b.id))!);
  const seen = async () => (await store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['url', 'firstSeen'] })).rows[0]!.firstSeen;
  const before = await seen();
  clock = new Date('2026-03-16T12:00:00Z');
  routes.set('/robots.txt', (_req, res) => { res.statusCode = 503; res.end('down'); });
  const second = await readSitemaps(b.id);
  assert.deepEqual(second.sitemaps.map((s: any) => new URL(s.url).pathname), ['/only-robots.xml']);
  assert.ok(second.notes.some((n: string) => /could not be read/.test(n)));
  assert.equal(await seen(), before);
  routes.set('/robots.txt', (_req, res) => { res.statusCode = 404; res.end('none'); });
  assert.equal((await readSitemaps(b.id)).sitemaps.length, 0, 'a robots.txt that is really gone does remove them');
});

test('I50 the log pages through one large submission without repeats or gaps', async () => {
  const b = await withSitemap(7);
  await withKey(b.id);
  await submit(b.id, { mode: 'selected', urls: Array.from({ length: 7 }, (_, i) => `${origin}/u${i}`) });
  const seen: string[] = [];
  for (let offset = 0; offset < 7; offset += 2) seen.push(...(await api(seo(b.id, `/indexnow/log?limit=2&offset=${offset}`))).body.entries.map((e: any) => e.url));
  assert.equal(new Set(seen).size, 7);
  assert.equal(seen.length, 7);
});

test('I51 a sign-in failure gives back the inspections that were claimed but never sent', async () => {
  const b = await withSitemap(30);
  fake.fail('inspectUrl', authFailure());
  const res = await inspect(b.id, Array.from({ length: 30 }, (_, i) => `${origin}/u${i}`));
  assert.equal(res.status, 409);
  const used = (await quotaOf(b.id)).used;
  assert.ok(used >= 1 && used < 30, `only the URLs that were started are counted, got ${used}`);
});
