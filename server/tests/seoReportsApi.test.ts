import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fakeClock } from './helpers/schedulerFakes.ts';
import { createFakeAgent, createFakeSeo, SECRETS } from './helpers/seoFakes.ts';
import type { AgentRuns, Handoff, LinkLookup } from '../src/seo/taskPorts.ts';

/*
 * The Reports tab over HTTP, with fixed Search Console data and the clock at Thursday 15 October 2026. Search Console
 * returns the same rows every day of a period: 12 clicks for page-a and 1 for page-b over the last 28 days
 * (2026-09-17 to 2026-10-14), against 10 and 5 over the 28 days before.
 */
const SITE = 'https://example.test';
let tempRoot: string;
let dataDir: string;
let baseUrl: string;
let server: HttpServer;
let clock: Date;
let fake: ReturnType<typeof createFakeSeo>;
let ai: ReturnType<typeof createFakeAgent>;
const realConsole = { log: console.log, error: console.error, warn: console.warn };
const sched = fakeClock('2026-10-15T12:00:00Z');

let storage: typeof import('../src/buildings/buildingStorage.ts');
let deps: typeof import('../src/seo/deps.ts');
let ports: typeof import('../src/seo/taskPorts.ts');
let collections: typeof import('../src/db/collections.ts');
let sync: typeof import('../src/seo/sync.ts');
let crawlStore: typeof import('../src/seo/crawl/store.ts');
let reportsMod: typeof import('../src/seo/reports.ts');
let scheduler: import('../src/scheduler/scheduler.ts').Scheduler;
let schedulerMod: typeof import('../src/scheduler/scheduler.ts');

const runs: AgentRuns = {
  start: async () => ({ runId: 'run-1', planItemId: 'item-1' }), state: async () => null, outputs: async () => [], approve: async () => undefined, stop: async () => undefined,
};
const handoff: Handoff = {
  lookup: async () => ({ state: 'not-linked' }) as LinkLookup, startPlanning: async () => ({ state: 'done', sessionId: 's' }), callResult: async () => ({ state: 'waiting', sessionId: null, note: null }), sessionStatus: async () => 'running',
};

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'seo-reports-'));
  dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  storage = await import('../src/buildings/buildingStorage.ts');
  deps = await import('../src/seo/deps.ts');
  ports = await import('../src/seo/taskPorts.ts');
  collections = await import('../src/db/collections.ts');
  sync = await import('../src/seo/sync.ts');
  crawlStore = await import('../src/seo/crawl/store.ts');
  reportsMod = await import('../src/seo/reports.ts');
  schedulerMod = await import('../src/scheduler/scheduler.ts');
  const { createManagerRunStarter } = await import('../src/scheduler/runStarter.ts');
  const { createActionRunner } = await import('../src/seo/scheduledActions.ts');
  const idle = () => () => undefined;
  const starter = createManagerRunStarter(
    { executePlanItem: async () => { throw new Error('unused'); }, hasFreeSlot: async () => true, onWorkerEvent: idle } as never,
    { callFromJob: async () => { throw new Error('unused'); }, callState: async () => null, onCallChanged: idle } as never,
    createActionRunner(),
  );
  scheduler = schedulerMod.createScheduler({ starter, now: sched.now, setTimer: sched.setTimer, hostTimezone: 'UTC' });
  await scheduler.start();
  server = createDaemonServer({ scheduler });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const level of ['log', 'error', 'warn'] as const) console[level] = () => {};
});

after(async () => {
  Object.assign(console, realConsole);
  scheduler.stop();
  await scheduler.idle();
  deps.resetSeo();
  ports.resetTaskPorts();
  await storage.closeAllStores();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(async () => {
  fake = createFakeSeo();
  ai = createFakeAgent();
  clock = new Date('2026-10-15T12:00:00Z');
  fake.state.gscProperties = [{ id: `${SITE}/`, label: `${SITE}/` }];
  fake.state.gscRows = (day) => (day >= '2026-09-17'
    ? [{ page: `${SITE}/page-a`, query: 'alpha', clicks: 12, impressions: 100, ctr: 0.12, position: 4 }, { page: `${SITE}/page-b`, query: 'beta', clicks: 1, impressions: 100, ctr: 0.01, position: 9 }]
    : [{ page: `${SITE}/page-a`, query: 'alpha', clicks: 10, impressions: 100, ctr: 0.1, position: 5 }, { page: `${SITE}/page-b`, query: 'beta', clicks: 5, impressions: 100, ctr: 0.05, position: 7 }]);
  deps.configureSeo({ services: fake.services, now: () => clock, sleep: async () => {}, dayPauseMs: 0, inspectPauseMs: 0, limits: deps.defaultLimits(), agent: ai.agent });
  ports.configureTaskPorts({ runs, handoff, hostTimezone: () => 'UTC' });
  if (!scheduler.isRunning()) await scheduler.start();
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
const rep = (id: string, suffix = '') => seo(id, `/reports${suffix}`);

async function createSeo() {
  const res = await send('POST', '/api/projects', { typeId: 'seo', siteUrl: SITE });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; name: string };
}
async function connect(id: string, service: 'gsc' | 'ga4', property: string) {
  await send('PUT', '/api/settings/google-oauth-client', { clientId: SECRETS.clientId, clientSecret: SECRETS.clientSecret });
  const started = await send('POST', seo(id, `/connections/${service}/connect`));
  const state = new URL(started.body.authUrl).searchParams.get('state')!;
  assert.equal((await api(`/api/seo/oauth/callback?code=abc&state=${state}`)).status, 200);
  assert.equal((await send('PUT', seo(id, `/connections/${service}/property`), { property })).status, 200);
}
async function runSync(id: string) {
  assert.equal((await send('POST', seo(id, '/sync'))).status, 202);
  await sync.waitForSync(id);
  assert.equal(sync.latestSync(id)!.status, 'done');
}
/** A Building with Search Console (and Analytics when asked) synced over a 2-month window. */
async function seeded(options: { ga4?: boolean } = {}) {
  const b = await createSeo();
  await connect(b.id, 'gsc', `${SITE}/`);
  if (options.ga4) await connect(b.id, 'ga4', '123456');
  await send('PATCH', seo(b.id, '/data'), { retentionMonths: 2 });
  await runSync(b.id);
  return b;
}
const live = async (id: string, q = 'preset=last-28') => (await send('GET', rep(id, `/live?${q}`))).body;
const tileOf = (report: any, key: string) => report.tiles.find((t: any) => t.key === key);
const b64 = (text: string) => Buffer.from(text).toString('base64');
const ahrefs = (rows: string[][]) => ['Referring page URL,Target URL,Anchor,Domain rating,UR,Domain traffic,First seen,Last seen,Type,Title', ...rows.map((r) => r.join(','))].join('\n');
const linkRow = (n: string, dr = '', ur = '', firstSeen = '2026-10-01') => [`https://${n}.com/post`, `${SITE}/page-a`, `link ${n}`, dr, ur, '', firstSeen, '2026-10-10', 'follow', `Title ${n}`];
const importLinks = (id: string, rows: string[][], mode = 'full') => send('POST', seo(id, '/backlinks/import'), { fileName: 'links.csv', content: b64(ahrefs(rows)), mode, confirm: true });
const storeOf = async (id: string) => storage.getStore((await collections.projectsDb.get(id))!);

// ---- the live report ---------------------------------------------------------------------------------------------------------------------

test('I01 the last-28 preset gives the exact scorecard for the fixed data, with direction cues', async () => {
  const b = await seeded({ ga4: true });
  const r = await live(b.id);
  assert.deepEqual([r.state, r.period.current, r.period.previous], ['ok', { from: '2026-09-17', to: '2026-10-14' }, { from: '2026-08-20', to: '2026-09-16' }]);
  const clicks = tileOf(r, 'clicks');
  assert.deepEqual([clicks.current, clicks.previous, clicks.change, clicks.changePct, clicks.glyph, clicks.verdict], [364, 420, -56, -13.3, '▼', 'worse']);
  assert.deepEqual([tileOf(r, 'impressions').current, tileOf(r, 'ctr').current, tileOf(r, 'ctr').previous], [5600, 6.5, 7.5]);
  const position = tileOf(r, 'position');
  assert.deepEqual([position.current, position.previous, position.glyph, position.verdict], [6.5, 6, '▲', 'worse']);
  assert.deepEqual([tileOf(r, 'sessions').current, tileOf(r, 'keyEvents').current, r.coverage.ga4.current], [216, 27, 27]);
  assert.deepEqual([tileOf(r, 'top3').current, tileOf(r, 'top10').current, tileOf(r, 'top20').current], [0, 2, 2]);
  assert.match(tileOf(r, 'top10').note, /not rank tracking/);
  const week = await live(b.id, 'preset=week');
  assert.deepEqual([week.period.current, week.period.previous, week.period.perDay], [{ from: '2026-10-12', to: '2026-10-14' }, { from: '2026-10-05', to: '2026-10-11' }, true]);
  assert.equal(tileOf(week, 'clicks').perDay, true);
  const month = await live(b.id, 'preset=month');
  assert.deepEqual([month.period.current, month.period.previous], [{ from: '2026-10-01', to: '2026-10-14' }, { from: '2026-09-01', to: '2026-09-30' }]);
  assert.equal((await live(b.id, '')).period.preset, 'last-28');
});

test('I02 a custom range with and without a comparison; bad input is a 400 with the message', async () => {
  const b = await seeded();
  const auto = await live(b.id, 'preset=custom&from=2026-09-20&to=2026-09-29');
  assert.deepEqual(auto.period.previous, { from: '2026-09-10', to: '2026-09-19' });
  assert.equal(tileOf(auto, 'clicks').current, 130);
  const override = await live(b.id, 'preset=custom&from=2026-09-20&to=2026-09-29&compareFrom=2026-08-20&compareTo=2026-09-19');
  assert.deepEqual([override.period.perDay, override.period.lengths], [true, { current: 10, previous: 31 }]);
  const cases: Array<[string, RegExp]> = [
    ['preset=custom&from=2026-09-29&to=2026-09-20', /from must not be after to/], ['preset=custom&from=2026-9-1&to=2026-09-20', /YYYY-MM-DD/], ['preset=custom&from=2026-02-30&to=2026-09-20', /YYYY-MM-DD/],
    ['preset=custom&from=2026-10-01&to=2026-10-16', /future/], ['preset=custom&from=2025-01-01&to=2026-10-14', /at most 400 days/], ['preset=year', /preset must be one of/],
    ['preset=custom&from=2026-09-01', /YYYY-MM-DD/], ['includePartial=maybe', /true or false/],
  ];
  for (const [query, message] of cases) {
    const res = await send('GET', rep(b.id, `/live?${query}`));
    assert.equal(res.status, 400, query);
    assert.match(res.body.error, message, query);
  }
});

test('I03 chart series align by day number, both periods have the same length and gaps are null', async () => {
  const b = await seeded();
  const store = await storeOf(b.id);
  await store.replaceRows([{ table: 'fetch_ledger', where: { dataset: 'gsc', day: '2026-10-01' }, rows: [] }]);
  const r = await live(b.id);
  const clicks = r.charts.find((c: any) => c.key === 'clicks');
  assert.equal(clicks.points.length, 28);
  assert.deepEqual([clicks.points[0].currentDay, clicks.points[0].previousDay, clicks.points[0].current, clicks.points[0].previous], ['2026-09-17', '2026-08-20', 13, 15]);
  const gap = clicks.points.find((p: any) => p.currentDay === '2026-10-01');
  assert.deepEqual([gap.current, gap.previous === null], [null, false]);
  assert.equal(r.charts.find((c: any) => c.key === 'position').points[0].current, 6.5);
});

test('I04 data past the retention window is clipped with a note naming the oldest day', async () => {
  const b = await seeded();
  const r = await live(b.id, 'preset=custom&from=2026-07-01&to=2026-08-31');
  assert.deepEqual([r.period.current, r.period.clipped.current], [{ from: '2026-08-15', to: '2026-08-31' }, 'partly']);
  assert.ok(r.notes.some((n: string) => n.includes('2026-08-15')));
  assert.equal(r.period.previous, null);
  await send('PATCH', seo(b.id, '/data'), { retentionMonths: 1 });
  await send('POST', seo(b.id, '/data/discard/acknowledge'));
  assert.equal((await send('POST', seo(b.id, '/data/discard'))).status, 202);
  await sync.waitForSync(b.id).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await live(b.id);
  assert.equal(after.period.oldestRetained, '2026-09-15');
  assert.ok(after.notes.some((n: string) => n.includes('2026-09-15')));
  assert.equal(after.period.clipped.previous, 'partly');
});

test('I05 a source that is not connected says so and never shows 0', async () => {
  const b = await seeded();
  const r = await live(b.id);
  assert.deepEqual([tileOf(r, 'sessions').state, tileOf(r, 'sessions').current, tileOf(r, 'keyEvents').state], ['not-connected', null, 'not-connected']);
  assert.equal(r.charts.find((c: any) => c.key === 'sessions').state, 'not-connected');
  assert.equal(tileOf(r, 'newBacklinks').state, 'not-available');
  assert.equal(tileOf(r, 'indexed').state, 'not-available');
  assert.equal(r.tiles.some((t: any) => t.key === 'avgDr'), false);
});

test('I06 a Building with nothing set up gets setup guidance, and saving it is refused', async () => {
  const b = await createSeo();
  const r = await live(b.id);
  assert.equal(r.state, 'setup');
  assert.ok(r.setup.length >= 3);
  assert.deepEqual(r.tiles, []);
  const refused = await send('POST', rep(b.id), { preset: 'last-28' });
  assert.equal(refused.status, 409);
  assert.equal((await send('POST', rep(b.id, '/summary'), {})).status, 409);
  assert.equal(ai.state.reportCalls.length, 0);
});

test('I07 partial days are left out by default and included on request', async () => {
  const b = await seeded();
  const base = await live(b.id, 'preset=custom&from=2026-10-10&to=2026-10-15');
  assert.deepEqual([base.period.current.to, base.period.trimmedDays], ['2026-10-14', 1]);
  assert.ok(base.notes.some((n: string) => /left out/.test(n)));
  const full = await live(b.id, 'preset=custom&from=2026-10-10&to=2026-10-15&includePartial=true');
  assert.equal(full.period.current.to, '2026-10-15');
  assert.ok(full.notes.some((n: string) => /Partial days are included/.test(n)));
  const store = await storeOf(b.id);
  await store.replaceRows([{ table: 'fetch_ledger', where: { dataset: 'gsc', day: '2026-10-14' }, rows: [['gsc', `${SITE}/`, '2026-10-14', 0, clock.toISOString(), 3]] }]);
  const late = await live(b.id, 'preset=custom&from=2026-10-10&to=2026-10-14');
  assert.equal(late.coverage.gsc.current, 4, 'a day Google still calls incomplete is not counted by default');
  assert.equal((await live(b.id, 'preset=custom&from=2026-10-10&to=2026-10-14&includePartial=true')).coverage.gsc.current, 5);
});

test('I08 DR and UR tiles appear only after an import that has them, with coverage counts', async () => {
  const b = await seeded();
  assert.equal((await live(b.id)).tiles.some((t: any) => t.key === 'avgDr'), false);
  await importLinks(b.id, [linkRow('a'), linkRow('b')]);
  const without = await live(b.id);
  assert.equal(without.tiles.some((t: any) => t.key === 'avgDr'), false);
  assert.equal(tileOf(without, 'newBacklinks').current, 2);
  await importLinks(b.id, [linkRow('a', '60', '30'), linkRow('b', '40', ''), linkRow('c')]);
  const r = await live(b.id);
  assert.deepEqual([tileOf(r, 'avgDr').current, tileOf(r, 'avgDr').detail, tileOf(r, 'avgUr').current, tileOf(r, 'avgUr').detail], [50, '2 of 3 links have DR', 30, '1 of 3 links have UR']);
  assert.deepEqual([r.backlinks.coverage.dr, r.backlinks.coverage.ur], ['2 of 3 links have DR', '1 of 3 links have UR']);
});

test('I09 winners and losers honour the impressions threshold; a bad threshold is a 400', async () => {
  const b = await seeded();
  const r = await live(b.id);
  assert.deepEqual(r.movers.pages.gains.map((m: any) => [m.name, m.change]), [[`${SITE}/page-a`, 56]]);
  assert.deepEqual(r.movers.pages.losses.map((m: any) => [m.name, m.change]), [[`${SITE}/page-b`, -112]]);
  assert.deepEqual(r.movers.keywords.gains.map((m: any) => m.name), ['alpha']);
  assert.deepEqual(r.movers.keywords.positionGains.map((m: any) => m.name), ['alpha']);
  assert.deepEqual(r.movers.keywords.positionLosses.map((m: any) => m.name), ['beta']);
  const strict = await live(b.id, 'preset=last-28&minImpressions=3000');
  assert.deepEqual([strict.movers.pages.gains, strict.movers.pages.losses, strict.movers.pages.belowThreshold], [[], [], 2]);
  assert.equal(strict.minImpressions, 3000);
  const zero = await live(b.id, 'preset=last-28&minImpressions=0');
  assert.equal(zero.minImpressions, 0);
  for (const bad of ['-1', '1.5', 'x']) assert.equal((await send('GET', rep(b.id, `/live?minImpressions=${bad}`))).status, 400, bad);
  const clusters = await send('POST', seo(b.id, '/keywords/clusters'), { name: 'Greek' });
  assert.equal(clusters.status, 201, clusters.text);
  await send('POST', seo(b.id, '/keywords/move'), { keys: ['alpha', 'beta'], clusterId: clusters.body.id });
  const grouped = await live(b.id);
  assert.deepEqual(grouped.movers.clusters.losses.map((m: any) => [m.name, m.change]), [['Greek', -56]]);
});

test('I10 the new and lost backlink lists follow a re-import that drops links, with DR and UR', async () => {
  const b = await seeded();
  await importLinks(b.id, [linkRow('a', '60', '30', '2026-08-01'), linkRow('b', '40', '20', '2026-08-01')]);
  clock = new Date('2026-10-12T12:00:00Z');
  await importLinks(b.id, [linkRow('a', '60', '30', '2026-08-01'), linkRow('c', '80', '55', '2026-10-03')]);
  clock = new Date('2026-10-15T12:00:00Z');
  process.stderr.write(JSON.stringify((await send('GET', seo(b.id, '/backlinks?limit=50'))).body.links.map((l: any) => [l.sourceHost, l.firstSeen, l.lostAt, l.status])));
  const r = await live(b.id);
  assert.deepEqual(r.backlinks.added.map((l: any) => [l.sourceHost, l.dr, l.ur]), [['c.com', 80, 55]]);
  assert.deepEqual(r.backlinks.lost.map((l: any) => [l.sourceHost, l.dr, l.ur, l.on]), [['b.com', 40, 20, '2026-10-12']]);
  assert.deepEqual([tileOf(r, 'newBacklinks').current, tileOf(r, 'lostBacklinks').current, tileOf(r, 'lostBacklinks').verdict], [1, 1, 'worse']);
  assert.equal(tileOf(r, 'referringDomains').current, 2);
});

test('I11 indexing changes come from the state-change log written when URLs are inspected', async () => {
  const b = await seeded();
  const store = await storeOf(b.id);
  const urls = [`${SITE}/page-a`, `${SITE}/page-b`];
  await store.insert('seo_sitemap_urls', urls.map((u) => ['https://example.test/sitemap.xml', u, '', '2026-08-01']));
  clock = new Date('2026-09-01T12:00:00Z');
  fake.state.defaultInspection = { verdict: 'FAIL', coverageState: 'Crawled - currently not indexed' };
  assert.equal((await send('POST', seo(b.id, '/sitemaps/urls/inspect'), { urls })).status, 200);
  clock = new Date('2026-10-05T12:00:00Z');
  fake.state.inspections.set(urls[0]!, { verdict: 'PASS', coverageState: 'Submitted and indexed' });
  assert.equal((await send('POST', seo(b.id, '/sitemaps/urls/inspect'), { urls })).status, 200);
  clock = new Date('2026-10-15T12:00:00Z');
  const r = await live(b.id);
  assert.deepEqual([r.indexing.available, r.indexing.newlyIndexed, r.indexing.newlyExcluded], [true, [urls[0]], []]);
  assert.deepEqual([tileOf(r, 'indexed').current, tileOf(r, 'indexed').previous, tileOf(r, 'indexed').detail], [1, 0, 'of 2 submitted']);
});

test('I11b a Building with inspections but an empty log uses them as the baseline: no data before them, no false "newly indexed"', async () => {
  const b = await seeded();
  const store = await storeOf(b.id);
  const urls = [`${SITE}/page-a`, `${SITE}/page-b`];
  await store.insert('seo_sitemap_urls', urls.map((u) => ['https://example.test/sitemap.xml', u, '', '2026-08-01']));
  await store.insert('seo_inspections', urls.map((u) => [u, 'indexed', '', '', '2026-10-05T10:00:00.000Z', 0, '']));
  assert.equal((await store.count('seo_index_changes')).count, 0);
  const r = await live(b.id);
  const t = tileOf(r, 'indexed');
  assert.deepEqual([t.current, t.previous, t.detail, t.missing, t.change], [2, null, 'of 2 submitted', 'previous', null]);
  assert.deepEqual([r.indexing.newlyIndexed, r.indexing.newlyExcluded], [[], []]);
  assert.ok(r.notes.some((n: string) => /Indexing is known from 2026-10-05/.test(n)));
  // A re-inspection that changes nothing logs nothing; a change is logged once even when the same pass runs twice.
  clock = new Date('2026-10-12T12:00:00Z');
  fake.state.inspections.set(urls[0]!, { verdict: 'FAIL', coverageState: 'Crawled - currently not indexed' });
  await Promise.all([send('POST', seo(b.id, '/sitemaps/urls/inspect'), { urls: [urls[0]] }), send('POST', seo(b.id, '/sitemaps/urls/inspect'), { urls: [urls[0]] })]);
  const log = await store.groupSums({ source: 'seo_index_changes', groupBy: ['url', 'fromState', 'toState', 'at'] });
  assert.equal(log.rows.length, 1);
  clock = new Date('2026-10-15T12:00:00Z');
  assert.deepEqual((await live(b.id)).indexing.newlyExcluded, [], 'the state before the 17 Sep window start is unknown');
  assert.deepEqual((await live(b.id, 'preset=custom&from=2026-10-12&to=2026-10-12')).indexing.newlyExcluded, [urls[0]], 'the state the log started from counts as the state just before it');
});

const snapshot = (id: string, finishedAt: string, edges: Array<[string, string]>) => ({
  id, startedAt: finishedAt, finishedAt, status: 'complete' as const, stopReason: null, capped: false, incomplete: false, host: 'example.test', seededFrom: 'home' as const,
  settings: {} as never, stats: { pages: 2, fetched: 2, failed: 0, blockedByRobots: 0, skippedUrlSpace: 0, links: edges.length, externalLinks: 0, uncrawledLinks: 0 },
  pages: [{ url: `${SITE}/`, outbound: edges.length, orphan: false }, { url: `${SITE}/x`, outbound: 0, orphan: edges.length === 1 }] as never,
  links: edges.map(([from, to]) => ({ from, to, anchor: '', nofollow: false, location: 'body', via: null, broken: false })) as never,
});

test('I12 internal-link changes need two crawls; with two they show added and removed links', async () => {
  const b = await seeded();
  await crawlStore.writeSnapshot(b.id, snapshot('s-aaa1', '2026-09-10T00:00:00.000Z', [[`${SITE}/`, `${SITE}/x`]]));
  const one = await live(b.id);
  assert.equal(one.internalLinks.available, false);
  assert.match(one.internalLinks.reason, /two crawls/);
  await crawlStore.writeSnapshot(b.id, snapshot('s-aaa2', '2026-10-10T00:00:00.000Z', [[`${SITE}/`, `${SITE}/y`], [`${SITE}/`, `${SITE}/z`]]));
  const two = await live(b.id);
  assert.deepEqual([two.internalLinks.available, two.internalLinks.added, two.internalLinks.removed, two.internalLinks.orphansBefore, two.internalLinks.orphansAfter], [true, 2, 1, 1, 0]);
});

test('I13 work done lists completed manual tasks and agent runs in the period', async () => {
  const b = await seeded();
  clock = new Date('2026-10-10T12:00:00Z');
  const done = await send('POST', seo(b.id, '/tasks'), { title: 'Fix titles', status: 'done' });
  assert.equal(done.status, 201, done.text);
  await send('POST', seo(b.id, '/tasks'), { title: 'Still open' });
  const started = await send('POST', seo(b.id, '/agent-tasks'), { slot: 'research' });
  assert.ok([201, 202].includes(started.status), started.text);
  clock = new Date('2026-10-15T12:00:00Z');
  const r = await live(b.id);
  assert.deepEqual(r.work.tasks.map((t: any) => t.title), ['Fix titles']);
  assert.equal(tileOf(r, 'tasksCompleted').current, 1);
  assert.equal(r.work.agentRuns.length, 1);
});

// ---- the AI summary --------------------------------------------------------------------------------------------------------------------------

test('I14/I16 the summary is written only on request, is labelled, tied to the period, and a change of period makes it stale', async () => {
  const b = await seeded();
  const first = await live(b.id);
  assert.equal(ai.state.reportCalls.length, 0, 'viewing a report never calls the agent');
  assert.equal(first.summary, null);
  const made = await send('POST', rep(b.id, '/summary'), { preset: 'last-28' });
  assert.equal(made.status, 200, made.text);
  assert.deepEqual([made.body.label, made.body.paragraph, made.body.actions, made.body.periodKey, made.body.digest], ['AI-generated', 'Clicks grew.', ['Refresh the top page.'], first.period.key, first.digest]);
  assert.match(JSON.stringify(ai.state.reportCalls[0]), /2026-09-17 to 2026-10-14/);
  ai.state.reportOutput = { paragraph: 'Second take.', actions: [] };
  assert.equal((await send('POST', rep(b.id, '/summary'), { preset: 'last-28' })).body.paragraph, 'Second take.');
  const other = await live(b.id, 'preset=month');
  assert.notEqual(other.digest, made.body.digest);
  assert.equal(await collections.activityLogDb.find((e) => e.name === 'report-published').then((r) => r.length), 0, 'no event is sent by a summary');
});

test('I15 a failed or slow agent leaves the report usable, and a second request while one runs is 409', async () => {
  const b = await seeded();
  ai.fail('summarise', new Error('model unavailable'));
  const failed = await send('POST', rep(b.id, '/summary'), {});
  assert.ok(failed.status >= 400, failed.text);
  assert.equal((await live(b.id)).state, 'ok');
  ai.state.reportOutput = { paragraph: '', actions: [] };
  assert.ok((await send('POST', rep(b.id, '/summary'), {})).status >= 400, 'an empty answer is an error');
  ai.state.reportOutput = { paragraph: 'ok', actions: [] };
  deps.configureSeo({ limits: { ...deps.defaultLimits(), agentTimeoutMs: 20 } });
  ai.state.gate = () => new Promise(() => undefined);
  const slow = await send('POST', rep(b.id, '/summary'), {});
  assert.ok(slow.status >= 400);
  assert.match(slow.body.error, /did not answer/);
  deps.configureSeo({ limits: deps.defaultLimits() });
  let release!: () => void;
  ai.state.gate = () => new Promise<void>((resolve) => { release = resolve; });
  const first = send('POST', rep(b.id, '/summary'), {});
  while (ai.state.reportCalls.length < 4) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await send('POST', rep(b.id, '/summary'), {})).status, 409);
  release();
  assert.equal((await first).status, 200);
  ai.state.gate = undefined;
});

// ---- saved reports ---------------------------------------------------------------------------------------------------------------------------

test('I17 a report is saved, listed newest first with a small summary, and reopened', async () => {
  const b = await seeded();
  const one = await send('POST', rep(b.id), { preset: 'last-28', name: '  First  ' });
  assert.equal(one.status, 201, one.text);
  clock = new Date('2026-10-15T13:00:00Z');
  const two = await send('POST', rep(b.id), { preset: 'week' });
  assert.equal(two.body.name, '2026-10-12 to 2026-10-14');
  const list = (await send('GET', rep(b.id))).body.reports;
  assert.deepEqual(list.map((r: any) => r.name), ['2026-10-12 to 2026-10-14', 'First']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['from', 'hasSummary', 'id', 'name', 'periodKey', 'savedAt', 'source', 'to']);
  const opened = await send('GET', rep(b.id, `/${one.body.id}`));
  assert.deepEqual([opened.body.name, opened.body.source, opened.body.report.state, tileOf(opened.body.report, 'clicks').current], ['First', 'manual', 'ok', 364]);
  assert.equal((await send('POST', rep(b.id), { name: 'x'.repeat(81) })).status, 400);
  assert.equal((await send('POST', rep(b.id), { name: 'a'.repeat(80) })).status, 201);
});

test('I18/I19 a saved report is identical after new syncs, imports and discards, and survives the retention discard', async () => {
  const b = await seeded();
  const made = (await send('POST', rep(b.id), { preset: 'last-28', summary: (await send('POST', rep(b.id, '/summary'), {})).body })).body;
  const before = (await send('GET', rep(b.id, `/${made.id}`))).text;
  assert.equal(JSON.parse(before).hasSummary, true);
  fake.state.gscRows = () => [{ page: `${SITE}/page-a`, query: 'alpha', clicks: 999, impressions: 999, ctr: 1, position: 1 }];
  clock = new Date('2026-12-20T12:00:00Z');
  await importLinks(b.id, [linkRow('zzz', '10', '10')]);
  await runSync(b.id);
  await send('POST', seo(b.id, '/data/discard/acknowledge'));
  await send('POST', seo(b.id, '/data/discard'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const gone = await live(b.id, 'preset=custom&from=2026-09-17&to=2026-10-14');
  assert.equal(gone.period.current, null);
  assert.equal((await send('GET', rep(b.id, `/${made.id}`))).text, before);
  await (await import('../src/seo/maintenance.ts')).syncBuildingIfStale(b.id, 0).catch(() => undefined);
  assert.equal((await send('GET', rep(b.id, `/${made.id}`))).text, before);
});

test('I20 exports of a live and a saved report: type, file name and content', async () => {
  const b = await seeded();
  await importLinks(b.id, [linkRow('=evil', '60', '30')]);
  const saved = (await send('POST', rep(b.id), { preset: 'last-28', name: 'Week 41 2026' })).body;
  const csv = await api(rep(b.id, `/${saved.id}/export?format=csv&table=scorecard`));
  assert.match(csv.headers.get('content-type')!, /text\/csv/);
  assert.match(csv.headers.get('content-disposition')!, /week-41-2026-scorecard\.csv/);
  assert.match(csv.text, /^Metric,Current,Comparison,Change,Note\n/);
  assert.match(csv.text, /Sessions,Not connected,Not connected/);
  const md = await api(rep(b.id, `/${saved.id}/export?format=md`));
  assert.match(md.headers.get('content-type')!, /text\/markdown/);
  assert.match(md.text, /^# Week 41 2026/);
  const html = await api(rep(b.id, `/${saved.id}/export?format=html`));
  assert.match(html.headers.get('content-type')!, /text\/html/);
  assert.match(html.text, /<h1>Week 41 2026<\/h1>/);
  assert.match((await api(rep(b.id, '/live/export?format=csv&table=pages&preset=last-28'))).text, /gain,.*page-a/);
  assert.match((await api(rep(b.id, '/live/export?format=csv&table=backlinks'))).text, /new,/);
  assert.equal((await api(rep(b.id, `/${saved.id}/export?format=pdf`))).status, 400);
  assert.equal((await api(rep(b.id, `/${saved.id}/export?format=csv&table=nope`))).status, 400);
  assert.equal((await api(rep(b.id, '/nope/export'))).status, 404);
});

test('I21 a report is deleted; unknown ids and ids from another Building are 404', async () => {
  const a = await seeded();
  const other = await seeded();
  const made = (await send('POST', rep(a.id), {})).body;
  assert.equal((await send('GET', rep(other.id, `/${made.id}`))).status, 404);
  assert.equal((await send('DELETE', rep(other.id, `/${made.id}`))).status, 404);
  assert.equal((await send('GET', rep(a.id, '/nope'))).status, 404);
  assert.equal((await send('DELETE', rep(a.id, `/${made.id}`))).status, 204);
  assert.equal((await send('GET', rep(a.id, `/${made.id}`))).status, 404);
  assert.equal((await send('DELETE', rep(a.id, `/${made.id}`))).status, 404);
  const notes = await send('POST', '/api/projects', { name: 'n', typeId: 'notes' });
  assert.equal((await send('GET', rep(notes.body.id))).status, 404);
});

test('I22 two saves at the same time both persist', async () => {
  const b = await seeded();
  const results = await Promise.all([send('POST', rep(b.id), { name: 'one' }), send('POST', rep(b.id), { name: 'two' }), send('POST', rep(b.id), { name: 'three' })]);
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
  assert.deepEqual((await send('GET', rep(b.id))).body.reports.map((r: any) => r.name).sort(), ['one', 'three', 'two']);
});

// ---- the capability, the event and the schedule ----------------------------------------------------------------------------------------

async function linked(seoId: string, capabilities = ['get-latest-report']) {
  const caller = (await send('POST', '/api/projects', { name: `caller-${Math.random().toString(36).slice(2, 8)}`, typeId: 'notes' })).body;
  const made = await send('POST', '/api/links', { fromBuildingId: caller.id, toBuildingId: seoId, capabilities });
  assert.equal(made.status, 201, made.text);
  return caller as { id: string };
}
const callCap = (caller: { id: string }, target: string, capabilityId = 'get-latest-report') => send('POST', `/api/projects/${caller.id}/capability-calls`, { targetBuildingId: target, capabilityId, inputs: {} });

test('I23 the Building type declares get-latest-report (read, no approval) and report-published', async () => {
  const { seoType } = await import('../src/buildings/types/seo.ts');
  const capability = seoType.capabilities.find((c) => c.id === 'get-latest-report')!;
  assert.deepEqual([capability.mode, capability.requiresApproval ?? false, capability.inputs], ['read', false, []]);
  assert.deepEqual(capability.outputs.map((o) => o.name), ['found', 'markdown', 'period', 'savedAt', 'keyNumbers']);
  assert.deepEqual(seoType.events.map((e) => e.id), ['report-published']);
  assert.deepEqual(seoType.events[0]!.payload!.map((p) => p.name), ['reportId', 'period', 'source']);
  assert.equal(seoType.version, 5);
});

test('I24 a linked Building reads the newest saved report as Markdown plus key numbers; with none it gets the empty result', async () => {
  const b = await seeded();
  const caller = await linked(b.id);
  const empty = await callCap(caller, b.id);
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body.outputs, { found: false, markdown: '', period: '', savedAt: '', keyNumbers: {} });
  await send('POST', rep(b.id), { name: 'Old' });
  clock = new Date('2026-10-15T13:00:00Z');
  await send('POST', rep(b.id), { name: 'Newest', preset: 'last-28' });
  const res = await callCap(caller, b.id);
  assert.equal(res.status, 200, res.text);
  const out = res.body.outputs;
  assert.deepEqual([out.found, out.period, out.savedAt], [true, '2026-09-17 to 2026-10-14 vs 2026-08-20 to 2026-09-16', '2026-10-15T13:00:00.000Z']);
  assert.match(out.markdown, /^# Newest/);
  assert.deepEqual([out.keyNumbers.clicks, out.keyNumbers.ctr, out.keyNumbers.position, 'sessions' in out.keyNumbers], [364, 6.5, 6.5, false]);
});

test('I25 an unlinked caller is refused and no export or capability output holds a secret, a property id or the data path', async () => {
  const b = await seeded({ ga4: true });
  const stranger = (await send('POST', '/api/projects', { name: 'stranger', typeId: 'notes' })).body;
  assert.ok((await callCap(stranger, b.id)).status >= 400);
  const made = (await send('POST', rep(b.id), { name: 'Private' })).body;
  const caller = await linked(b.id);
  const texts = [
    (await callCap(caller, b.id)).text, (await send('GET', rep(b.id, `/${made.id}`))).text, (await send('GET', rep(b.id, '/live'))).text,
    ...(await Promise.all(['csv', 'md', 'html'].map(async (f) => (await api(rep(b.id, `/${made.id}/export?format=${f}`))).text))), JSON.stringify(ai.state.reportCalls),
  ];
  await send('POST', rep(b.id, '/summary'), {});
  texts.push(JSON.stringify(ai.state.reportCalls));
  for (const secret of [SECRETS.access, SECRETS.refresh, SECRETS.clientId, SECRETS.clientSecret, '123456', dataDir, tempRoot]) for (const text of texts) assert.equal(text.includes(secret), false, secret);
});

const reportJob = async (id: string, actionId: string, cron: string) => {
  const res = await send('POST', seo(id, '/schedules'), { name: actionId, actionId, cron });
  assert.equal(res.status, 201, res.text);
  return res.body as { id: string };
};
/** Runs a schedule now and waits for the action behind it, which settles after the scheduler has answered. */
const runJob = async (id: string, jobId: string) => {
  const res = await send('POST', seo(id, `/schedules/${jobId}/run`));
  await scheduler.idle();
  for (let i = 0; i < 100; i++) {
    const history = (await send('GET', seo(id, `/schedules/${jobId}/history`))).body;
    if (history.entries?.[0] && history.entries[0].outcome !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return res;
};

test('I26 with the scheduler running, a weekly schedule saves the last full week, raises a notification and publishes the event', async () => {
  const b = await seeded();
  await send('PATCH', seo(b.id, '/data'), { retentionMonths: 2 });
  const state = (await send('GET', rep(b.id, '/schedule'))).body;
  assert.deepEqual([state.available, state.schedules], [true, []]);
  const job = await reportJob(b.id, 'report-weekly', '0 8 * * 1');
  const ran = await runJob(b.id, job.id);
  assert.ok([200, 201, 202].includes(ran.status), ran.text);
  const list = (await send('GET', rep(b.id))).body.reports;
  assert.deepEqual(list.map((r: any) => [r.name, r.source, r.from, r.to]), [['Week 41 2026', 'scheduled', '2026-10-05', '2026-10-11']]);
  const notes = await collections.notificationsDb.find((n) => n.kind === 'seo.report_published' && n.projectId === b.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.title, /Week 41 2026/);
  const events = await collections.activityLogDb.find((e) => e.name === 'report-published' && e.callerBuildingId === b.id);
  assert.equal(events.length, 1);
  assert.match(events[0]!.inputsSummary, /scheduled/);
  const shown = (await send('GET', rep(b.id, '/schedule'))).body.schedules;
  assert.deepEqual(shown.map((s: any) => [s.cadence, s.enabled]), [['weekly', true]]);
  assert.equal((await send('PATCH', seo(b.id, `/schedules/${job.id}`), { enabled: false })).body.enabled, false);
  const monthly = await reportJob(b.id, 'report-monthly', '0 8 1 * *');
  await runJob(b.id, monthly.id);
  assert.deepEqual((await send('GET', rep(b.id))).body.reports.map((r: any) => r.name).sort(), ['September 2026', 'Week 41 2026']);
});

test('I27 without the scheduler reports are manual: the schedule state says so and manual saves work', async () => {
  const b = await seeded();
  scheduler.stop();
  assert.equal((await send('GET', rep(b.id, '/schedule'))).body.available, false);
  assert.equal((await send('POST', rep(b.id), { name: 'Manual' })).status, 201);
  await scheduler.start();
});

test('I28/I29 a scheduled run on an empty Building saves nothing, and a repeat for the same period saves once', async () => {
  const empty = await createSeo();
  const emptyJob = await reportJob(empty.id, 'report-weekly', '0 8 * * 1');
  await runJob(empty.id, emptyJob.id);
  assert.deepEqual((await send('GET', rep(empty.id))).body.reports, []);
  assert.equal((await collections.notificationsDb.find((n) => n.kind === 'seo.report_published' && n.projectId === empty.id)).length, 0);
  const b = await seeded();
  const job = await reportJob(b.id, 'report-weekly', '0 8 * * 1');
  await runJob(b.id, job.id);
  await runJob(b.id, job.id);
  assert.equal((await send('GET', rep(b.id))).body.reports.length, 1);
  clock = new Date('2026-10-22T12:00:00Z');
  await runJob(b.id, job.id);
  assert.equal((await send('GET', rep(b.id))).body.reports.length, 2, 'the next week is a new period');
});

test('I30 a version 4 Building opens at version 5 with the reports tables and keeps its data', async () => {
  const { BulkStore } = await import('../src/buildings/bulkClient.ts');
  const { SEO_STORAGE } = await import('../src/buildings/types/seo.ts');
  const file = path.join(tempRoot, 'migrate', 'seo.sqlite');
  const dropped = ['seo_reports', 'seo_index_changes'];
  const v4 = { ...SEO_STORAGE, tables: SEO_STORAGE.tables.filter((t) => !dropped.includes(t.name)), migrations: SEO_STORAGE.migrations.filter((m) => m.toVersion <= 4) };
  const open = (spec: typeof SEO_STORAGE, version: number) => new BulkStore({ file, spec, version, backupDir: path.join(tempRoot, 'migrate', 'backups') } as any);
  const old = open(v4, 4);
  await old.open();
  await old.insert('fetch_ledger', [['gsc', 'p', '2026-01-01', 1, 'now', 3]]);
  await old.close();
  const migrated = open(SEO_STORAGE, 5);
  assert.equal((await migrated.open()).status, 'migrated');
  assert.equal((await migrated.count('fetch_ledger')).count, 1);
  assert.deepEqual([(await migrated.count('seo_reports')).count, (await migrated.count('seo_index_changes')).count], [0, 0]);
  await migrated.close();
});

test('I31 deleting the Building removes its saved reports', async () => {
  const b = await seeded();
  await send('POST', rep(b.id), { name: 'Gone' });
  assert.equal((await send('DELETE', `/api/projects/${b.id}`)).status, 204);
  assert.equal((await send('GET', rep(b.id))).status, 404);
  const left = await readdir(path.join(dataDir)).catch(() => [] as string[]);
  assert.equal(left.includes(b.id), false);
});

test('I32 a report over a large data set finishes and stays small', async () => {
  const b = await createSeo();
  await connect(b.id, 'gsc', `${SITE}/`);
  await send('PATCH', seo(b.id, '/data'), { retentionMonths: 2 });
  fake.state.gscRows = (day) => Array.from({ length: 2000 }, (_, i) => ({ page: `${SITE}/p-${i % 400}`, query: `kw ${i}`, clicks: day >= '2026-09-17' ? 2 : 1, impressions: 60, ctr: 0.02, position: 3 + (i % 10) }));
  const started = Date.now();
  await runSync(b.id);
  const r = await live(b.id);
  assert.equal(tileOf(r, 'clicks').current, 2 * 2000 * 28);
  assert.ok(r.movers.pages.gains.length <= 10 && r.movers.keywords.gains.length <= 10);
  assert.ok(JSON.stringify(r).length < 200_000, 'the report holds capped lists, not every row');
  assert.ok(Date.now() - started < 120_000);
});

test('I33 the list returns a small summary per report, and a report with many entries saves and reopens', async () => {
  const b = await seeded();
  const links = Array.from({ length: 300 }, (_, i) => linkRow(`site${i}`, String(i % 100), String(i % 90)));
  await importLinks(b.id, links);
  const made = (await send('POST', rep(b.id), { name: 'Big' })).body;
  const listText = (await send('GET', rep(b.id))).text;
  assert.ok(listText.length < 1000, listText);
  const opened = (await send('GET', rep(b.id, `/${made.id}`))).body.report;
  assert.equal(opened.backlinks.addedTotal, 300);
  assert.equal(opened.backlinks.added.length, 25);
  const direct = await reportsMod.getReport((await collections.projectsDb.get(b.id))!, made.id);
  assert.equal(direct.report.backlinks.added.length, 25);
});
