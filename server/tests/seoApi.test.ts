import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { accessRefused, authFailure, createFakeSeo, network, quota, SECRETS } from './helpers/seoFakes.ts';

let tempRoot: string;
let dataDir: string;
let baseUrl: string;
let server: HttpServer;
let fake: ReturnType<typeof createFakeSeo>;
let clock: Date;
let sleeps: number[];
/** Days fetched for a window ending the day before the clock's 2026-03-15: a month back is 28 days, two months 59. */
const DAYS_1M = 28;
const DAYS_2M = 59;
const logs: string[] = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn };

let storage: typeof import('../src/buildings/buildingStorage.ts');
let sync: typeof import('../src/seo/sync.ts');
let deps: typeof import('../src/seo/deps.ts');
let maintenance: typeof import('../src/seo/maintenance.ts');
let inspection: typeof import('../src/seo/inspection.ts');
let tokens: typeof import('../src/seo/tokens.ts');
let secretsMod: typeof import('../src/buildings/secrets.ts');
let retention: typeof import('../src/buildings/retention.ts');
let projectsDb: typeof import('../src/db/collections.ts').projectsDb;
let notificationsDb: typeof import('../src/db/collections.ts').notificationsDb;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'seo-api-'));
  dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  process.env.AGENT_VISUAL_OS_TEST_FAULTS = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  storage = await import('../src/buildings/buildingStorage.ts');
  sync = await import('../src/seo/sync.ts');
  deps = await import('../src/seo/deps.ts');
  maintenance = await import('../src/seo/maintenance.ts');
  inspection = await import('../src/seo/inspection.ts');
  tokens = await import('../src/seo/tokens.ts');
  secretsMod = await import('../src/buildings/secrets.ts');
  retention = await import('../src/buildings/retention.ts');
  ({ projectsDb, notificationsDb } = await import('../src/db/collections.ts'));
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  for (const level of ['log', 'error', 'warn'] as const) console[level] = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(' ')); };
});

after(async () => {
  Object.assign(console, realConsole);
  // Background inspection passes started by the maintenance loop must end before the stores close and the data is deleted.
  for (const project of await projectsDb.all()) await inspection.stopInspection(project.id);
  await storage.closeAllStores();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  fake = createFakeSeo();
  clock = new Date('2026-03-15T12:00:00Z');
  sleeps = [];
  deps.configureSeo({ firstRun: false, services: fake.services, now: () => clock, sleep: async (ms) => { sleeps.push(ms); }, dayPauseMs: 0 });
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

/** Every error answer is `{ error }` and nothing else leaks the stored values. */
function assertErrorShape(res: { status: number; body: any }, status: number) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(typeof res.body.error, 'string');
}

async function createSeo(siteUrl = 'https://example.com', extra: Record<string, unknown> = {}) {
  const res = await send('POST', '/api/projects', { typeId: 'seo', siteUrl, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; name: string; typeId: string; ownerId: string; tenantId: string };
}

async function saveClient(id: string) {
  const res = await send('PUT', '/api/settings/google-oauth-client', { clientId: SECRETS.clientId, clientSecret: SECRETS.clientSecret });
  assert.equal(res.status, 200);
}

async function consent(id: string, service: 'gsc' | 'ga4' | 'ads', callbackQuery: (state: string) => string = (state) => `code=abc&state=${state}`) {
  const started = await send('POST', seo(id, `/connections/${service}/connect`));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const state = new URL(started.body.authUrl).searchParams.get('state')!;
  return { started, state, callback: await api(`/api/seo/oauth/callback?${callbackQuery(state)}`) };
}

async function connect(id: string, service: 'gsc' | 'ga4', property: string) {
  await saveClient(id);
  const { callback } = await consent(id, service);
  assert.equal(callback.status, 200, callback.text);
  const picked = await send('PUT', seo(id, `/connections/${service}/property`), { property });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
}
const connectGsc = (id: string) => connect(id, 'gsc', 'https://example.com/');

async function runSync(id: string) {
  const started = await send('POST', seo(id, '/sync'));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await sync.waitForSync(id);
  return sync.latestSync(id)!;
}

const setMonths = (id: string, retentionMonths: number) => send('PATCH', seo(id, '/data'), { retentionMonths });

async function allRows(id: string, table: string, filter = '') {
  const rows: Array<Record<string, any>> = [];
  let cursor = '';
  do {
    const res = await api(`/api/projects/${id}/data/${table}?limit=200&sort=day${cursor ? `&cursor=${cursor}` : ''}${filter}`);
    rows.push(...res.body.rows);
    cursor = res.body.nextCursor ?? '';
  } while (cursor);
  return rows;
}

async function rollup(id: string, name: string, by: string) {
  const res = await api(`/api/projects/${id}/rollups/${name}?groupBy=property,${by}&limit=200&orderBy=${by}&dir=asc`);
  return res.body.rows as Array<Record<string, any>>;
}

/** The roll-up must equal what a full rebuild from the raw rows gives, for months and weeks. */
async function assertRollupsMatchRows(id: string) {
  const rows = await allRows(id, 'gsc_rows');
  for (const [name, key] of [['gsc_monthly', 'month'], ['gsc_weekly', 'week']] as const) {
    const rebuilt = new Map<string, { clicks: number; impressions: number; positionImpressions: number; rows: number }>();
    for (const r of rows) {
      const k = `${r.property}|${r[key]}`;
      const t = rebuilt.get(k) ?? { clicks: 0, impressions: 0, positionImpressions: 0, rows: 0 };
      t.clicks += r.clicks; t.impressions += r.impressions; t.positionImpressions += r.positionImpressions; t.rows += 1;
      rebuilt.set(k, t);
    }
    const stored = await rollup(id, name, key);
    assert.equal(stored.length, rebuilt.size, `${name} group count`);
    for (const s of stored) {
      const t = rebuilt.get(`${s.property}|${s[key]}`)!;
      assert.ok(t, `${name} has a group the rows do not`);
      assert.equal(s.clicks, t.clicks); assert.equal(s.impressions, t.impressions); assert.equal(s.rows, t.rows);
      assert.ok(Math.abs(s.positionImpressions - t.positionImpressions) < 1e-6);
    }
  }
}

const jobDone = async (id: string, jobId: string) => {
  for (let i = 0; i < 400; i++) {
    const job = (await api(`/api/projects/${id}/storage/jobs/${jobId}`)).body;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
};

const counts = async (id: string) => {
  const store = await storage.getStore((await projectsDb.get(id))!);
  return { gsc: (await store.count('gsc_rows')).count, ga4: (await store.count('ga4_rows')).count, ledger: (await store.count('fetch_ledger')).count };
};

/* ----- Create ----- */

test('I1 creating an SEO Building from a site URL returns 201 with the normalised URL, and the popup data lists connections', async () => {
  const b = await createSeo('HTTPS://Example.COM:443/');
  assert.equal(b.typeId, 'seo');
  assert.equal(b.name, 'example.com');
  const view = (await api(seo(b.id, '/connections'))).body;
  assert.equal(view.siteUrl, 'https://example.com');
  assert.deepEqual(view.connections.map((c: any) => [c.service, c.state]), [['gsc', 'not-connected'], ['ga4', 'not-connected'], ['ads', 'not-connected'], ['bing', 'not-connected'], ['indexnow', 'not-connected']]);
  const types = (await api('/api/building-types')).body;
  const seoType = types.find((t: any) => t.id === 'seo');
  assert.equal(seoType.devOnly, false);
  assert.equal(seoType.hasStorage, true);
});

test('I2 an invalid site URL returns 400 with { error } and creates nothing', async () => {
  const before = (await api('/api/projects')).body.length;
  for (const siteUrl of ['ftp://example.com', '', 'nonsense', 'https://u:p@example.com', undefined]) {
    const res = await send('POST', '/api/projects', { typeId: 'seo', siteUrl });
    assertErrorShape(res, 400);
    assert.equal(res.body.field, 'siteUrl');
  }
  assert.equal((await api('/api/projects')).body.length, before);
});

test('I3 owner and tenant fields follow the foundation', async () => {
  const b = await createSeo();
  assert.ok(b.ownerId && b.tenantId);
});

test('I4 non-SEO Buildings are unchanged: Notes creates and lists, and has no SEO routes', async () => {
  const notes = await send('POST', '/api/projects', { name: 'Plain notes', typeId: 'notes' });
  assert.equal(notes.status, 201);
  assertErrorShape(await api(seo(notes.body.id, '/connections')), 404);
  assert.ok((await api('/api/projects')).body.some((p: any) => p.id === notes.body.id));
});

test('I5 every SEO route answers 404 for an unknown Building', async () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/connections'], ['POST', '/connections/gsc/connect'], ['GET', '/connections/gsc/properties'],
    ['PUT', '/connections/gsc/property', {}], ['PUT', '/connections/ads', {}], ['PUT', '/connections/bing', {}], ['PUT', '/connections/indexnow', {}],
    ['DELETE', '/connections/gsc'], ['POST', '/sync'], ['POST', '/sync/on-open'], ['GET', '/sync'], ['GET', '/data'], ['PATCH', '/data', {}],
    ['GET', '/data/discard/preview'], ['POST', '/data/discard/acknowledge'], ['POST', '/data/discard'], ['GET', '/series?dataset=gsc&from=2026-01-01&to=2026-01-02'],
  ];
  for (const [method, suffix, body] of routes) assertErrorShape(await send(method, seo('no-such-building', suffix), body), 404);
});

/* ----- Connections ----- */

test('I6 the Google client id and secret are accepted once and never come back, in responses or logs', async () => {
  const b = await createSeo();
  logs.length = 0;
  const saved = await send('PUT', '/api/settings/google-oauth-client', { clientId: SECRETS.clientId, clientSecret: SECRETS.clientSecret });
  assert.equal(saved.status, 200);
  const view = await api(seo(b.id, '/connections'));
  assert.equal(view.body.googleClientSaved, true);
  for (const text of [JSON.stringify(saved.body), view.text, logs.join('\n')]) for (const value of [SECRETS.clientId, SECRETS.clientSecret]) assert.ok(!text.includes(value));
  assertErrorShape(await send('PUT', '/api/settings/google-oauth-client', { clientId: 'x' }), 400);
});

test('I7 consent start returns an auth URL with a state and the right scopes for each service, never the client secret', async () => {
  const b = await createSeo();
  assert.equal((await send('DELETE', '/api/settings/google-oauth-client')).status, 204);
  assertErrorShape(await send('POST', seo(b.id, '/connections/gsc/connect')), 400);
  await saveClient(b.id);
  for (const [service, scope] of [['gsc', 'webmasters.readonly'], ['ga4', 'analytics.readonly'], ['ads', 'adwords']] as const) {
    const res = await send('POST', seo(b.id, `/connections/${service}/connect`));
    const url = new URL(res.body.authUrl);
    assert.ok(url.searchParams.get('scope')!.includes(scope));
    assert.ok(url.searchParams.get('state'));
    assert.equal(url.searchParams.get('redirect_uri'), `${baseUrl}/api/seo/oauth/callback`);
    assert.ok(!res.text.includes(SECRETS.clientSecret));
  }
  assertErrorShape(await send('POST', seo(b.id, '/connections/bing/connect')), 400);
});

test('I8 the callback stores tokens through the secrets store and no token reaches a response or a log', async () => {
  const b = await createSeo();
  logs.length = 0;
  await saveClient(b.id);
  const { callback } = await consent(b.id, 'gsc');
  assert.equal(callback.status, 200);
  const secrets = new secretsMod.SecretsStore(b.id);
  const access = await secrets.get(tokens.secretKeys.access('gsc'));
  assert.ok(access?.startsWith(SECRETS.access));
  assert.equal(await secrets.get(tokens.secretKeys.refresh('gsc')), SECRETS.refresh);
  const view = await api(seo(b.id, '/connections'));
  assert.equal(view.body.connections[0].state, 'connected');
  assert.equal(view.body.connections[0].account, 'me@example.com');
  for (const text of [callback.text, view.text, logs.join('\n')]) for (const value of [access!, SECRETS.refresh, SECRETS.clientSecret]) assert.ok(!text.includes(value));
});

test('I9 a bad, expired or replayed state returns 400', async () => {
  const b = await createSeo();
  await saveClient(b.id);
  assertErrorShape(await api('/api/seo/oauth/callback?code=abc&state=nope'), 400);
  assertErrorShape(await api('/api/seo/oauth/callback?code=abc'), 400);
  const { state } = await consent(b.id, 'gsc');
  assertErrorShape(await api(`/api/seo/oauth/callback?code=abc&state=${state}`), 400); // replay
  const started = await send('POST', seo(b.id, '/connections/ga4/connect'));
  const expired = new URL(started.body.authUrl).searchParams.get('state')!;
  clock = new Date(clock.getTime() + 11 * 60_000);
  assertErrorShape(await api(`/api/seo/oauth/callback?code=abc&state=${expired}`), 400);
});

test('I10 when the person denies consent the connection stays not connected with a reason', async () => {
  const b = await createSeo();
  await saveClient(b.id);
  const { callback } = await consent(b.id, 'gsc', (state) => `error=access_denied&state=${state}`);
  assert.equal(callback.status, 400);
  const gsc = (await api(seo(b.id, '/connections'))).body.connections[0];
  assert.equal(gsc.state, 'needs-attention');
  assert.match(gsc.reason, /cancelled/);
  assert.equal(fake.state.exchangeCalls, 0);
});

test('I11 and I12 properties come from the service; a listed one is accepted and an unlisted one is refused', async () => {
  const b = await createSeo();
  await saveClient(b.id);
  await consent(b.id, 'gsc');
  const list = await api(seo(b.id, '/connections/gsc/properties'));
  assert.deepEqual(list.body.properties.map((p: any) => p.id), ['https://example.com/', 'sc-domain:example.com']);
  assertErrorShape(await send('PUT', seo(b.id, '/connections/gsc/property'), { property: 'https://other.example/' }), 400);
  const ok = await send('PUT', seo(b.id, '/connections/gsc/property'), { property: 'sc-domain:example.com' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.connections[0].property, 'sc-domain:example.com');
});

test('I13 a refused property list is an error and leaves the state unchanged', async () => {
  const b = await createSeo();
  await saveClient(b.id);
  await consent(b.id, 'gsc');
  fake.fail('gscList', accessRefused());
  assertErrorShape(await api(seo(b.id, '/connections/gsc/properties')), 502);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'connected');
  assertErrorShape(await api(seo(b.id, '/connections/ga4/properties')), 409);
});

test('I14 disconnect stops syncing, keeps the data, removes the tokens, and a second disconnect is harmless', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  await runSync(b.id);
  const before = await counts(b.id);
  assert.ok(before.gsc > 0);
  const res = await send('DELETE', seo(b.id, '/connections/gsc'));
  assert.equal(res.status, 200);
  assert.equal(res.body.connections[0].state, 'not-connected');
  const secrets = new secretsMod.SecretsStore(b.id);
  assert.equal(await secrets.get(tokens.secretKeys.refresh('gsc')), undefined);
  assert.equal((await send('DELETE', seo(b.id, '/connections/gsc'))).status, 200);
  assertErrorShape(await send('POST', seo(b.id, '/sync')), 409);
  assert.deepEqual(await counts(b.id), before);
  assertErrorShape(await send('DELETE', seo(b.id, '/connections/nope')), 400);
});

test('I15 changing property needs confirmation; once confirmed the old data is kept and marked as the previous property', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  await runSync(b.id);
  const rowsBefore = (await counts(b.id)).gsc;
  const refused = await send('PUT', seo(b.id, '/connections/gsc/property'), { property: 'sc-domain:example.com' });
  assertErrorShape(refused, 409);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].property, 'https://example.com/');
  const ok = await send('PUT', seo(b.id, '/connections/gsc/property'), { property: 'sc-domain:example.com', confirm: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.previousProperties.map((p: any) => [p.service, p.property]), [['gsc', 'https://example.com/']]);
  assert.equal((await counts(b.id)).gsc, rowsBefore);
  await runSync(b.id);
  const properties = new Set((await allRows(b.id, 'gsc_rows')).map((r) => r.property));
  assert.deepEqual([...properties].sort(), ['https://example.com/', 'sc-domain:example.com']);
  const series = (await api(seo(b.id, '/series?dataset=gsc&from=2026-03-10&to=2026-03-14'))).body;
  assert.equal(series.property, 'sc-domain:example.com');
});

/* ----- Sync ----- */

test('I16 backfill stores 12 months of GSC days, progress rises, and the connection ends connected with a last sync', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  const progress: number[] = [];
  fake.state.gate = async () => { progress.push(sync.runningSync(b.id)?.done ?? -1); };
  const job = await runSync(b.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.kind, 'backfill');
  assert.equal(job.done, job.total);
  assert.equal(job.total, 365);
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]!) && progress.at(-1)! > 300);
  assert.equal(fake.state.queryDays[0], '2025-03-15');
  assert.equal(fake.state.queryDays.at(-1), '2026-03-14');
  const c = (await api(seo(b.id, '/connections'))).body.connections[0];
  assert.equal(c.state, 'connected');
  assert.equal(c.lastSyncAt, clock.toISOString());
  assert.equal((await counts(b.id)).gsc, 365 * 3);
});

test('I17 a backfill resumes after a restart with no duplicate rows and no refetched committed days', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 2);
  let seen = 0;
  fake.state.gate = async () => { if (++seen === 11) void sync.stopSync(b.id); };
  const first = await runSync(b.id).catch(() => sync.latestSync(b.id)!);
  assert.equal(first.status, 'cancelled');
  const committed = (await counts(b.id)).ledger;
  assert.ok(committed >= 5 && committed < DAYS_2M, `committed ${committed}`);
  await storage.closeAllStores(); // the daemon restarts: the in-memory job is gone, the database is not
  fake.state.gate = undefined;
  fake.state.queryDays.length = 0;
  const second = await runSync(b.id);
  assert.equal(second.status, 'done', second.error);
  assert.equal(fake.state.queryDays.length, DAYS_2M - committed);
  assert.equal(new Set(fake.state.queryDays).size, fake.state.queryDays.length);
  const counted = await counts(b.id);
  assert.equal(counted.ledger, DAYS_2M);
  assert.equal(counted.gsc, DAYS_2M * 3);
  await assertRollupsMatchRows(b.id);
});

test('I18 a quota error backs off with growing waits, then the backfill continues and the wait honours Retry-After', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  fake.fail('queryDay', quota(), 2);
  fake.fail('queryDay', quota(45_000), 1);
  const job = await runSync(b.id);
  assert.equal(job.status, 'done');
  assert.deepEqual(sleeps, [1000, 2000, 45_000]);
  assert.equal((await counts(b.id)).ledger, DAYS_1M);
});

test('I18b quota that never clears gives up for now, shows the reason and leaves the connection alone until the cool-down passes', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  fake.fail('queryDay', quota(), 40);
  await runSync(b.id);
  const gsc = (await api(seo(b.id, '/connections'))).body.connections[0];
  assert.equal(gsc.state, 'needs-attention');
  assert.match(gsc.reason, /quota/i);
  const calls = fake.state.queryDays.length;
  await runSync(b.id); // still cooling down: nothing is fetched
  assert.equal(fake.state.queryDays.length, calls);
  clock = new Date(clock.getTime() + 16 * 60_000);
  fake.state.failures.clear();
  assert.equal((await runSync(b.id)).status, 'done');
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'connected');
});

test('I19 a large backfill keeps the daemon responsive', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 2);
  fake.state.rowsPerDay = 5000;
  let last = Date.now();
  let maxGap = 0;
  const timer = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 20);
  const job = await runSync(b.id);
  clearInterval(timer);
  assert.equal(job.status, 'done', job.error);
  assert.equal((await counts(b.id)).gsc, DAYS_2M * 5000);
  assert.ok(maxGap < 1500, `the event loop stalled for ${maxGap} ms`);
  assert.equal((await api(`/api/building-types`)).status, 200);
});

test('I20 days Google marks incomplete are refetched until final, and the roll-ups follow the corrected numbers', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  fake.state.firstIncomplete = '2026-03-13';
  await runSync(b.id);
  const ledger = await allRows(b.id, 'fetch_ledger');
  assert.deepEqual(ledger.filter((r) => r.final === 0).map((r) => r.day), ['2026-03-13', '2026-03-14']);
  const before = (await rollup(b.id, 'gsc_monthly', 'month')).find((r) => r.month === '2026-03')!;
  fake.state.firstIncomplete = null;
  fake.state.queryDays.length = 0;
  fake.state.gscRows = (day) => fake.defaultGscDay(day).map((r) => (day >= '2026-03-13' ? { ...r, clicks: r.clicks + 100 } : r));
  await runSync(b.id);
  assert.deepEqual(fake.state.queryDays, ['2026-03-13', '2026-03-14']);
  assert.equal((await allRows(b.id, 'fetch_ledger')).filter((r) => r.final === 0).length, 0);
  const after = (await rollup(b.id, 'gsc_monthly', 'month')).find((r) => r.month === '2026-03')!;
  assert.equal(after.clicks, before.clicks + 100 * 3 * 2);
  assert.equal(after.rows, before.rows);
  await assertRollupsMatchRows(b.id);
});

test('I21 an atomic day: a disk-full error in the middle of a day leaves no part of that day and the earlier days intact', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  let seen = 0;
  fake.state.gate = async () => {
    if (++seen === 4) await (await storage.getStore((await projectsDb.get(b.id))!)).setFault({ code: 'SQLITE_FULL', atRow: 2 });
  };
  const job = await runSync(b.id);
  assert.equal(job.status, 'failed');
  const counted = await counts(b.id);
  assert.equal(counted.ledger, 3);
  assert.equal(counted.gsc, 9);
  await assertRollupsMatchRows(b.id);
  const days = new Set((await allRows(b.id, 'gsc_rows')).map((r) => r.day));
  assert.equal(days.size, 3);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'needs-attention');
  await storage.resumeIngestion(b.id);
  fake.state.gate = undefined;
  assert.equal((await runSync(b.id)).status, 'done');
  assert.equal((await counts(b.id)).gsc, DAYS_1M * 3);
});

test('I22 and I63 a never-fetched day is a gap (null), a fetched day with no rows is a real zero', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  fake.state.gscRows = (day) => (day === '2026-03-10' ? [] : fake.defaultGscDay(day));
  await runSync(b.id);
  const res = await api(seo(b.id, '/series?dataset=gsc&from=2026-02-10&to=2026-03-15'));
  const byDay = new Map<string, any>(res.body.points.map((p: any) => [p.key, p]));
  const gap = byDay.get('2026-02-10');
  assert.deepEqual([gap.state, gap.clicks, gap.impressions, gap.ctr, gap.position], ['missing', null, null, null, null]);
  assert.deepEqual([byDay.get('2026-03-15').state, byDay.get('2026-03-15').clicks], ['missing', null]);
  const empty = byDay.get('2026-03-10');
  assert.deepEqual([empty.state, empty.clicks, empty.impressions, empty.ctr, empty.position], ['final', 0, 0, null, null]);
  const normal = byDay.get('2026-03-11');
  assert.equal(normal.state, 'final');
  assert.ok(normal.clicks > 0 && normal.ctr! > 0 && normal.position! > 0);
  assertErrorShape(await api(seo(b.id, '/series?dataset=gsc&from=2026-03-10&to=2026-03-01')), 400);
  assertErrorShape(await api(seo(b.id, '/series?dataset=nope&from=2026-03-01&to=2026-03-10')), 400);
});

test('I23 GA4 sessions and key events are stored; without GA4 the GA4 series reads Not connected, never zero', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  const none = await api(seo(b.id, '/series?dataset=ga4&from=2026-03-01&to=2026-03-10'));
  assert.deepEqual([none.body.connected, none.body.points], [false, []]);
  await connect(b.id, 'ga4', '123456');
  await runSync(b.id);
  const res = (await api(seo(b.id, '/series?dataset=ga4&from=2026-03-01&to=2026-03-10'))).body;
  assert.equal(res.connected, true);
  assert.deepEqual([res.points[0].sessions, res.points[0].keyEvents], [8, 1]);
  assert.equal((await counts(b.id)).ga4, DAYS_1M * 2);
  const weekly = (await api(seo(b.id, '/series?dataset=ga4&from=2026-03-01&to=2026-03-14&grain=week'))).body;
  assert.ok(weekly.points.length >= 2);
});

test('I24, U6 and U7 an access token that expires mid-sync is refreshed once; a fresh one is not refreshed', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  let seen = 0;
  fake.state.gate = async () => { if (++seen === 10) clock = new Date(clock.getTime() + 2 * 3600_000); };
  const job = await runSync(b.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(fake.state.refreshCalls, 1);
  const fresh = await createSeo();
  await connectGsc(fresh.id);
  await setMonths(fresh.id, 1);
  fake.state.refreshCalls = 0;
  await runSync(fresh.id);
  assert.equal(fake.state.refreshCalls, 0);
});

test('U8 and U9 two concurrent refreshes share one call, and an invalid_grant refresh is an auth failure', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  clock = new Date(clock.getTime() + 2 * 3600_000);
  const d = { services: fake.services, now: () => clock };
  const [one, two] = await Promise.all([tokens.accessTokenFor(b.id, 'gsc', d), tokens.accessTokenFor(b.id, 'gsc', d)]);
  assert.equal(one, two);
  assert.equal(fake.state.refreshCalls, 1);
  clock = new Date(clock.getTime() + 2 * 3600_000);
  fake.fail('refresh', authFailure());
  await assert.rejects(tokens.accessTokenFor(b.id, 'gsc', d), (e: any) => e.kind === 'auth');
});

test('I25 a refresh that fails marks needs attention, raises a notification, keeps the data and is retried at the next sync', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  await runSync(b.id);
  const rows = (await counts(b.id)).gsc;
  clock = new Date(clock.getTime() + 25 * 3600_000);
  fake.fail('refresh', authFailure());
  const job = await runSync(b.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error!, /sign-in/);
  const gsc = (await api(seo(b.id, '/connections'))).body.connections[0];
  assert.equal(gsc.state, 'needs-attention');
  assert.match(gsc.reason, /sign-in/);
  assert.ok((await notificationsDb.find((n) => n.projectId === b.id && n.resolvedAt === null)).some((n) => /SEO sync/.test(n.title)));
  assert.equal((await counts(b.id)).gsc, rows);
  await runSync(b.id);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'connected');
  assert.ok(!(await notificationsDb.find((n) => n.projectId === b.id && n.resolvedAt === null)).some((n) => /SEO sync/.test(n.title)));
});

test('I26 property access removed (403) needs attention with a reason', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  fake.fail('queryDay', accessRefused());
  const job = await runSync(b.id);
  assert.deepEqual([job.status, /refused access/.test(job.error ?? '')], ['failed', true]);
  assert.equal((await api(seo(b.id, '/data'))).body.sync.status, 'failed');
  const gsc = (await api(seo(b.id, '/connections'))).body.connections[0];
  assert.equal(gsc.state, 'needs-attention');
  assert.match(gsc.reason, /refused access/);
});

test('I27 a network error keeps the previous data and is retried at the next sync', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  await runSync(b.id);
  const rows = (await counts(b.id)).gsc;
  clock = new Date(clock.getTime() + 24 * 3600_000);
  fake.fail('queryDay', network());
  await runSync(b.id);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'needs-attention');
  assert.equal((await counts(b.id)).gsc, rows);
  await runSync(b.id);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'connected');
  assert.equal((await counts(b.id)).gsc, rows + 3);
});

test('I28, I55 and I56 Sync now answers 202; a second while running is 409; discard and property change wait for it', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => { reached = resolve; });
  fake.state.gate = async (day) => { if (day === '2026-02-20') { reached(); await held; } };
  assert.equal((await send('POST', seo(b.id, '/sync'))).status, 202);
  await atGate;
  assertErrorShape(await send('POST', seo(b.id, '/sync')), 409);
  assertErrorShape(await send('PUT', seo(b.id, '/connections/gsc/property'), { property: 'sc-domain:example.com', confirm: true }), 409);
  await send('POST', seo(b.id, '/data/discard/acknowledge'));
  assertErrorShape(await send('POST', seo(b.id, '/data/discard')), 409);
  const view = (await api(seo(b.id, '/connections'))).body.connections[0];
  assert.equal(view.state, 'syncing');
  assert.ok(view.progress.done > 0);
  release();
  await sync.waitForSync(b.id);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].property, 'https://example.com/');
});

test('I29 without the platform scheduler the daily refresh is the SEO timer, plus Sync now and the on-open sync', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  assert.equal((await api('/api/building-types')).body.find((t: any) => t.id === 'seo').scheduledJobs.length, 0);
  assert.equal((await send('POST', seo(b.id, '/sync/on-open'))).body.started, true);
  await sync.waitForSync(b.id);
  assert.equal((await send('POST', seo(b.id, '/sync/on-open'))).body.started, false); // fresh
  clock = new Date(clock.getTime() + 21 * 3600_000);
  await maintenance.runSeoMaintenance();
  await sync.waitForSync(b.id);
  assert.equal(sync.latestSync(b.id)!.startedAt, clock.toISOString());
  const none = await createSeo();
  assert.equal((await send('POST', seo(none.id, '/sync/on-open'))).body.started, false);
});

test('I30 the last successful sync is reported per connection', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  const before = (await api(seo(b.id, '/connections'))).body.connections;
  assert.equal(before[0].lastSyncAt, undefined);
  await runSync(b.id);
  await connect(b.id, 'ga4', '123456');
  const view = (await api(seo(b.id, '/connections'))).body.connections;
  assert.equal(view[0].lastSyncAt, clock.toISOString());
  assert.equal(view[1].lastSyncAt, undefined);
});

/* ----- Ads, Bing, IndexNow ----- */

test('I31 and I32 Ads: a missing developer token is 400, access is checked and labelled exact or range, and an Ads failure does not touch GSC', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  assertErrorShape(await send('PUT', seo(b.id, '/connections/ads'), { customerId: '123-456-7890' }), 400);
  assertErrorShape(await send('PUT', seo(b.id, '/connections/ads'), { developerToken: SECRETS.ads, customerId: '123-456-7890' }), 409);
  await consent(b.id, 'ads');
  assertErrorShape(await send('PUT', seo(b.id, '/connections/ads'), { developerToken: SECRETS.ads, customerId: 'abc' }), 400);
  logs.length = 0;
  const range = await send('PUT', seo(b.id, '/connections/ads'), { developerToken: SECRETS.ads, customerId: '123-456-7890' });
  assert.deepEqual([range.body.ok, range.body.volume], [true, 'range']);
  assert.equal(range.body.connections.connections[2].volume, 'range');
  assert.ok(![range.text, logs.join('\n')].some((t) => t.includes(SECRETS.ads)));
  fake.state.adsVolume = 'exact';
  assert.equal((await send('PUT', seo(b.id, '/connections/ads'), { developerToken: SECRETS.ads, customerId: '123-456-7890' })).body.volume, 'exact');
  fake.state.adsOk = false;
  const bad = await send('PUT', seo(b.id, '/connections/ads'), { developerToken: SECRETS.ads, customerId: '123-456-7890' });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.connections.connections[2].state, 'needs-attention');
  assert.equal((await runSync(b.id)).status, 'done');
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'connected');
});

test('I33 and I62 Bing connects with an API key that is never returned; a failing check surfaces an error without breaking sync', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  assertErrorShape(await send('PUT', seo(b.id, '/connections/bing'), { apiKey: 'x' }), 400);
  logs.length = 0;
  const ok = await send('PUT', seo(b.id, '/connections/bing'), { apiKey: SECRETS.bing });
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.connections.connections[3].state, 'connected');
  assert.ok(![ok.text, logs.join('\n'), (await api(seo(b.id, '/connections'))).text].some((t) => t.includes(SECRETS.bing)));
  fake.state.bingOk = false;
  const bad = await send('PUT', seo(b.id, '/connections/bing'), { apiKey: SECRETS.bing });
  assert.equal(bad.body.connections.connections[3].state, 'needs-attention');
  fake.fail('bing', network());
  const down = await send('PUT', seo(b.id, '/connections/bing'), { apiKey: SECRETS.bing });
  assert.equal(down.status, 200);
  assert.match(down.body.message, /could not reach/);
  assert.equal((await runSync(b.id)).status, 'done');
});

test('I34 an IndexNow key is saved and validated; none sent generates one', async () => {
  const b = await createSeo();
  assertErrorShape(await send('PUT', seo(b.id, '/connections/indexnow'), { key: 'short' }), 400);
  logs.length = 0;
  const ok = await send('PUT', seo(b.id, '/connections/indexnow'), { key: SECRETS.indexNow });
  assert.equal(ok.body.indexNowKeySaved, true);
  assert.ok(!ok.text.includes(SECRETS.indexNow) && !logs.join('').includes(SECRETS.indexNow));
  const generated = await send('PUT', seo(b.id, '/connections/indexnow'), {});
  assert.equal(generated.status, 200);
  assert.match((await new secretsMod.SecretsStore(b.id).get(tokens.secretKeys.indexNowKey))!, /^[0-9a-f]{32}$/);
});

/* ----- Data, retention ----- */

test('I35, I36 and I37 data status shows size, rows per dataset, oldest data, the rule and the threshold; settings are validated', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 2);
  await runSync(b.id);
  const data = (await api(seo(b.id, '/data'))).body;
  assert.ok(data.bytes > 0);
  assert.deepEqual(data.datasets.map((d: any) => [d.id, d.rows, d.oldestDay]), [['gsc', DAYS_2M * 3, '2026-01-15'], ['ga4', 0, null]]);
  assert.equal(data.retention.months, 2);
  assert.match(data.retention.description, /more than 2 months ago/);
  assert.match(data.retention.description, /year-over-year/);
  assert.equal(data.sync.status, 'done');
  const threshold = await send('PATCH', seo(b.id, '/data'), { warningBytes: 12345 });
  assert.equal(threshold.body.warningBytes, 12345);
  assert.equal(threshold.body.level, 'warning');
  assertErrorShape(await send('PATCH', seo(b.id, '/data'), { warningBytes: 0 }), 400);
  assertErrorShape(await send('PATCH', seo(b.id, '/data'), {}), 400);
  for (const bad of [0, -1, 1.5, '12', 37, 1e9, null]) assertErrorShape(await send('PATCH', seo(b.id, '/data'), { retentionMonths: bad }), 400);
  assert.equal((await send('PATCH', seo(b.id, '/data'), { retentionMonths: 36 })).body.retention.months, 36);
});

test('I38 the discard preview returns counts and the cutoff without deleting', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await runSync(b.id);
  await setMonths(b.id, 3);
  const before = await counts(b.id);
  const preview = (await api(seo(b.id, '/data/discard/preview'))).body;
  assert.equal(preview.cutoff, retention.retentionCutoff({ months: 3 }, clock));
  const gscTable = preview.tables.find((t: any) => t.table === 'gsc_rows');
  assert.ok(gscTable.count > 0 && gscTable.count < before.gsc);
  assert.equal(preview.acknowledged, false);
  assert.match(preview.note, /year-over-year/);
  assert.deepEqual(await counts(b.id), before);
});

test('I39 and I40 discarding before the notice is acknowledged is 409; after it, old rows go, newer stay, size drops, and the roll-ups match', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await runSync(b.id);
  await setMonths(b.id, 3);
  const sizeBefore = (await api(seo(b.id, '/data'))).body.bytes;
  assertErrorShape(await send('POST', seo(b.id, '/data/discard')), 409);
  assert.equal((await counts(b.id)).gsc, 365 * 3);
  assert.equal((await send('POST', seo(b.id, '/data/discard/acknowledge'))).body.acknowledged, true);
  const started = await send('POST', seo(b.id, '/data/discard'));
  assert.equal(started.status, 202);
  assert.equal((await jobDone(b.id, started.body.id)).status, 'done');
  const cutoff = retention.retentionCutoff({ months: 3 }, clock);
  const rows = await allRows(b.id, 'gsc_rows');
  assert.equal(rows[0]!.day, cutoff); // I42: the day exactly at the cutoff is kept
  assert.ok(rows.every((r) => r.day >= cutoff));
  const gone = (await allRows(b.id, 'fetch_ledger')).filter((r) => r.day < cutoff);
  assert.equal(gone.length, 0);
  assert.ok((await api(seo(b.id, '/data'))).body.bytes < sizeBefore);
  await assertRollupsMatchRows(b.id); // I43
  assert.equal((await api(seo(b.id, '/data'))).body.datasets[0].oldestDay, cutoff);
});

test('I41 automatic retention does not delete before the notice, raises a notification, and deletes after acknowledgement', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await runSync(b.id);
  await setMonths(b.id, 6);
  const total = (await counts(b.id)).gsc;
  await storage.runScheduledMaintenance(clock);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await counts(b.id)).gsc, total);
  const notes = await notificationsDb.find((n) => n.projectId === b.id && n.resolvedAt === null);
  assert.ok(notes.some((n) => /ready to be discarded/.test(n.title)));
  assertErrorShape(await send('POST', `/api/projects/${b.id}/storage/retention`, {}), 409);
  await send('POST', seo(b.id, '/data/discard/acknowledge'));
  await storage.runScheduledMaintenance(clock);
  for (let i = 0; i < 200 && (await counts(b.id)).gsc === total; i++) await new Promise((r) => setTimeout(r, 25));
  const cutoff = retention.retentionCutoff({ months: 6 }, clock);
  assert.ok((await allRows(b.id, 'gsc_rows')).every((r) => r.day >= cutoff));
  assert.ok((await counts(b.id)).gsc < total);
});

test('I44 roll-ups equal a full rebuild after a corrected day replaces rows', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 2);
  fake.state.firstIncomplete = '2026-03-10';
  await runSync(b.id);
  fake.state.firstIncomplete = null;
  fake.state.gscRows = (day) => (day >= '2026-03-10' ? fake.defaultGscDay(day).slice(0, 2).map((r, i) => ({ ...r, clicks: r.clicks + 7, position: 9 + i })) : fake.defaultGscDay(day));
  await runSync(b.id);
  await assertRollupsMatchRows(b.id);
  assert.equal((await allRows(b.id, 'gsc_rows', '&filter=day:eq:2026-03-12')).length, 2);
});

test('I45 shrinking the window needs a new acknowledgement before discarding; growing it does not', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await runSync(b.id);
  await send('POST', seo(b.id, '/data/discard/acknowledge'));
  assert.equal((await api(seo(b.id, '/data'))).body.retention.needsNotice, false);
  await setMonths(b.id, 6);
  assert.equal((await api(seo(b.id, '/data'))).body.retention.needsNotice, true);
  assertErrorShape(await send('POST', seo(b.id, '/data/discard')), 409);
  await setMonths(b.id, 24);
  assert.equal((await api(seo(b.id, '/data'))).body.retention.needsNotice, false);
});

/* ----- Lifecycle, isolation, secrets ----- */

test('I46 deleting the Building deletes its data, settings and secrets; a failed cleanup is logged and does not block', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  await runSync(b.id);
  const dir = path.join(dataDir, 'buildings', b.id);
  assert.ok((await readdir(dir)).includes('bulk.sqlite'));
  assert.equal((await send('DELETE', `/api/projects/${b.id}`)).status, 204);
  await assert.rejects(readdir(dir));
  logs.length = 0;
  const other = await createSeo();
  await storage.deleteBuildingData(other.id, (async () => { throw new Error('disk says no'); }) as never);
  assert.ok(logs.some((l) => l.includes('disk says no')));
});

test('I47 deleting during a running backfill stops the job', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => { reached = resolve; });
  fake.state.gate = async (day) => { if (day === '2025-04-01') { reached(); await held; } };
  await send('POST', seo(b.id, '/sync'));
  await atGate;
  const deleting = send('DELETE', `/api/projects/${b.id}`);
  release();
  assert.equal((await deleting).status, 204);
  assert.equal(sync.runningSync(b.id), undefined);
  assert.equal(sync.latestSync(b.id)!.status, 'cancelled');
});

test('I48 connection states and secrets survive a restart', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  await runSync(b.id);
  await storage.closeAllStores();
  const view = (await api(seo(b.id, '/connections'))).body;
  assert.deepEqual([view.connections[0].state, view.connections[0].property, view.googleClientSaved], ['connected', 'https://example.com/', true]);
  assert.ok(await new secretsMod.SecretsStore(b.id).get(tokens.secretKeys.refresh('gsc')));
});

test('I49 and I50 token and key values appear in no central store file, no settings file and no captured log', async () => {
  const b = await createSeo();
  logs.length = 0;
  await connectGsc(b.id);
  await connect(b.id, 'ga4', '123456');
  await setMonths(b.id, 1);
  await send('PUT', seo(b.id, '/connections/bing'), { apiKey: SECRETS.bing });
  await runSync(b.id);
  await send('DELETE', seo(b.id, '/connections/ga4'));
  const secretValues = [SECRETS.refresh, SECRETS.clientSecret, SECRETS.clientId, SECRETS.bing, SECRETS.access];
  const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])))).flat();
  for (const file of await walk(dataDir)) {
    if (/(secrets\.json|\.sqlite(-wal|-shm)?)$/.test(file)) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const value of secretValues) assert.ok(!text.includes(value), `${path.relative(dataDir, file)} holds a secret`);
  }
  const log = logs.join('\n');
  for (const value of secretValues) assert.ok(!log.includes(value));
});

test('I59 two SEO Buildings with the same dates never see each other\'s data', async () => {
  const a = await createSeo('https://a.example');
  const c = await createSeo('https://c.example');
  for (const b of [a, c]) { await connectGsc(b.id); await setMonths(b.id, 1); }
  fake.state.gscRows = () => [{ page: '/only-a', query: 'a', clicks: 1, impressions: 1, ctr: 1, position: 1 }];
  await runSync(a.id);
  fake.state.gscRows = () => [{ page: '/only-c', query: 'c', clicks: 2, impressions: 2, ctr: 1, position: 1 }];
  await runSync(c.id);
  assert.ok((await allRows(a.id, 'gsc_rows')).every((r) => r.page === '/only-a'));
  assert.ok((await allRows(c.id, 'gsc_rows')).every((r) => r.page === '/only-c'));
});

test('I61 near midnight Pacific time the newest fetched day follows the Pacific calendar', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  clock = new Date('2026-03-15T06:30:00Z'); // 06:30 UTC on the 15th is 23:30 Pacific (UTC-7) on the 14th
  await runSync(b.id);
  assert.equal(fake.state.queryDays.at(-1), '2026-03-13');
});

test('I64 disconnecting in the middle of a backfill keeps the days already committed', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 2);
  let seen = 0;
  fake.state.gate = async () => { if (++seen === 8) void send('DELETE', seo(b.id, '/connections/gsc')); await new Promise((r) => setTimeout(r, 2)); };
  await send('POST', seo(b.id, '/sync'));
  await sync.waitForSync(b.id);
  await new Promise((r) => setTimeout(r, 100));
  const counted = await counts(b.id);
  assert.ok(counted.ledger >= 5 && counted.ledger < DAYS_2M);
  assert.equal(counted.gsc, counted.ledger * 3);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'not-connected');
});

/* ----- Scale ----- */

test('I51, I53 and I54 at reduced scale lists and aggregates stay fast, lists are capped and the heap stays flat', async () => {
  const b = await createSeo();
  const store = await storage.getStore((await projectsDb.get(b.id))!);
  const heapBefore = process.memoryUsage().heapUsed;
  let id = 0;
  for (let batch = 0; batch < 24; batch++) {
    const rows: Array<Array<string | number>> = [];
    for (let i = 0; i < 5000; i++, id++) {
      const day = new Date(Date.UTC(2025, 6, 1) + (id % 240) * 86_400_000).toISOString().slice(0, 10);
      rows.push(['https://example.com/', day, `${day.slice(0, 4)}-W${String(1 + (id % 50)).padStart(2, '0')}`, day.slice(0, 7), `/p${id % 997}`, `q${id}`, id % 9, id % 90, (id % 90) * 3.5]);
    }
    await store.insert('gsc_rows', rows);
  }
  const timed = async <T>(fn: () => Promise<T>) => { const t = performance.now(); const r = await fn(); return [r, performance.now() - t] as const;};
  const [list, listMs] = await timed(() => api(`/api/projects/${b.id}/data/gsc_rows?sort=day&dir=desc&limit=200&filter=property:eq:https://example.com/`));
  assert.ok(listMs < 1000, `list took ${listMs} ms`);
  assert.equal(list.body.rows.length, 200);
  const [agg, aggMs] = await timed(() => api(`/api/projects/${b.id}/rollups/gsc_monthly?groupBy=property,month&limit=200`));
  assert.ok(aggMs < 2000, `aggregate took ${aggMs} ms`);
  assert.ok(agg.body.rows.length > 0);
  const capped = await api(`/api/projects/${b.id}/data/gsc_rows?limit=100000`);
  assert.equal(capped.body.rows.length, 200);
  assert.ok(capped.body.nextCursor);
  const total = (await api(seo(b.id, '/data'))).body.datasets[0].rows;
  assert.equal(total, 120_000);
  assert.ok(process.memoryUsage().heapUsed - heapBefore < 150 * 1024 * 1024, 'the daemon heap grew with the data');
});

/* ----- Errors, docs ----- */

test('I58 every 400, 404 and 409 body is exactly { error } plus documented detail', async () => {
  const b = await createSeo();
  for (const res of [
    await send('PUT', '/api/settings/google-oauth-client', {}),
    await api(seo(b.id, '/connections/gsc/properties')),
    await send('POST', seo(b.id, '/sync')),
    await api(seo('missing', '/data')),
    await send('POST', seo(b.id, '/data/discard')),
  ]) {
    assert.equal(typeof res.body.error, 'string');
    assert.ok(Object.keys(res.body).every((k) => ['error', 'field', 'requiresAcknowledgement', 'requiresConfirmation', 'from', 'to'].includes(k)), JSON.stringify(res.body));
  }
});

test('I60 docs describe the SEO type, the data model, the 12-month retention and each connection quirk', async () => {
  const doc = await readFile(path.join(import.meta.dirname, '..', '..', 'docs', 'seo-building.md'), 'utf8');
  for (const needle of ['12 months', 'gsc_rows', 'ga4_rows', 'fetch_ledger', 'Search Console', 'Analytics', 'Google Ads', 'developer token', 'Bing', 'IndexNow', 'year-over-year', 'Desktop app', 'Pacific']) assert.ok(doc.includes(needle), `docs/seo-building.md does not mention ${needle}`);
});

test('I3b the first fetched day is never before the retention cutoff, even when Pacific is a day behind UTC', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  clock = new Date('2026-03-15T06:30:00Z'); // Pacific date 03-14 minus a month is 02-14; the UTC cutoff is 02-15
  await runSync(b.id);
  assert.equal(fake.state.queryDays[0], '2026-02-15');
  assert.equal(retention.retentionCutoff({ months: 1 }, clock), '2026-02-15');
  await send('POST', seo(b.id, '/data/discard/acknowledge'));
  const started = await send('POST', seo(b.id, '/data/discard'));
  await jobDone(b.id, started.body.id);
  fake.state.queryDays.length = 0;
  await runSync(b.id);
  assert.ok(!fake.state.queryDays.includes('2026-02-14'), 'a discarded day is not fetched again');
  assert.equal((await allRows(b.id, 'fetch_ledger')).filter((r) => r.day < '2026-02-15').length, 0);
});

test('I29b the hourly timer starts a sync for a stale Building and its stop function ends the timer', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  const stop = maintenance.startSeoMaintenance(60 * 60_000);
  await stop(); // waits for the loop's first run to finish
  await sync.waitForSync(b.id);
  await inspection.stopInspection(b.id);
  assert.equal(sync.latestSync(b.id)!.status, 'done');
  assert.equal((await counts(b.id)).ledger, DAYS_1M);
});

test('I29c a background inspection pass for a Building without settings finishes quietly', async () => {
  const b = await createSeo();
  const project = (await projectsDb.get(b.id))!;
  const missing = { ...project, id: 'no-such-building' };
  assert.deepEqual(await inspection.runInspectionPass(missing), { inspected: 0, stoppedBecause: 'finished' });
});

test('I5b disconnecting Bing, Ads or IndexNow leaves a running backfill alone; disconnecting GSC stops it', async () => {
  const b = await createSeo();
  await connectGsc(b.id);
  await setMonths(b.id, 1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => { reached = resolve; });
  fake.state.gate = async (day) => { if (day === '2026-02-25') { reached(); await held; } };
  await send('POST', seo(b.id, '/sync'));
  await atGate;
  for (const service of ['bing', 'ads', 'indexnow']) assert.equal((await send('DELETE', seo(b.id, `/connections/${service}`))).status, 200);
  assert.ok(sync.runningSync(b.id), 'the sync is still running');
  const stopping = send('DELETE', seo(b.id, '/connections/gsc'));
  release();
  await stopping;
  await sync.waitForSync(b.id);
  assert.equal(sync.latestSync(b.id)!.status, 'cancelled');
});

test('I7b the OAuth redirect URI comes from the daemon socket, not a forged Host header', async () => {
  const b = await createSeo();
  await saveClient(b.id);
  const { request } = await import('node:http');
  const url = new URL(`${baseUrl}${seo(b.id, '/connections/gsc/connect')}`);
  const body: string = await new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { host: 'evil.example:9' } }, (res) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve(text)); });
    req.on('error', reject);
    req.end();
  });
  const redirect = new URL(JSON.parse(body).authUrl).searchParams.get('redirect_uri');
  assert.equal(redirect, `${baseUrl}/api/seo/oauth/callback`);
});
