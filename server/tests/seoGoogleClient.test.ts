import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import type { ProjectRecord } from '../src/domain/types.ts';
import { authFailure, createFakeSeo, SECRETS } from './helpers/seoFakes.ts';

/** Settings > Google (SEO): the one app-wide Google OAuth client, its API, its use by every SEO Building, and the move off per-Building clients. */

let tempRoot: string;
let dataDir: string;
let baseUrl: string;
let server: HttpServer;
let fake: ReturnType<typeof createFakeSeo>;
let clock: Date;
const logs: string[] = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn };

let deps: typeof import('../src/seo/deps.ts');
let tokens: typeof import('../src/seo/tokens.ts');
let sync: typeof import('../src/seo/sync.ts');
let secretsMod: typeof import('../src/buildings/secrets.ts');
let client: typeof import('../src/seo/googleClient.ts');
let storage: typeof import('../src/buildings/buildingStorage.ts');
let projectsDb: typeof import('../src/db/collections.ts').projectsDb;

const ROUTE = '/api/settings/google-oauth-client';
const OTHER = { clientId: 'other-client-ID-2.apps.example', clientSecret: 'OTHER-CLIENT-SECRET-2' };

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'seo-google-client-'));
  dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  deps = await import('../src/seo/deps.ts');
  tokens = await import('../src/seo/tokens.ts');
  sync = await import('../src/seo/sync.ts');
  secretsMod = await import('../src/buildings/secrets.ts');
  client = await import('../src/seo/googleClient.ts');
  storage = await import('../src/buildings/buildingStorage.ts');
  ({ projectsDb } = await import('../src/db/collections.ts'));
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  for (const level of ['log', 'error', 'warn'] as const) console[level] = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(' ')); };
});

after(async () => {
  Object.assign(console, realConsole);
  await storage.closeAllStores();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(async () => {
  fake = createFakeSeo();
  clock = new Date('2026-03-15T12:00:00Z');
  deps.configureSeo({ firstRun: false, services: fake.services, now: () => clock, sleep: async () => {}, dayPauseMs: 0 });
  await client.clearGoogleClient();
  logs.length = 0;
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
const savePair = (pair: { clientId: string; clientSecret: string } = SECRETS) => send('PUT', ROUTE, { clientId: pair.clientId, clientSecret: pair.clientSecret });
const appFile = () => path.join(dataDir, 'secrets.json');
const appFileText = () => readFile(appFile(), 'utf8').catch(() => undefined);

async function createSeo(siteUrl = 'https://example.com') {
  const res = await send('POST', '/api/projects', { typeId: 'seo', siteUrl });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}

async function connectGsc(id: string) {
  const started = await send('POST', seo(id, '/connections/gsc/connect'));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const state = new URL(started.body.authUrl).searchParams.get('state')!;
  const callback = await api(`/api/seo/oauth/callback?code=abc&state=${state}`);
  assert.equal(callback.status, 200, callback.text);
  const picked = await send('PUT', seo(id, '/connections/gsc/property'), { property: 'https://example.com/' });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
}

/** Every value a test might have saved, in the forms a leak could take. */
const leakForms = (...values: string[]) => values.flatMap((v) => [v, encodeURIComponent(v)]);
const assertNoLeak = (texts: string[], values: string[]) => {
  for (const text of texts) for (const value of leakForms(...values)) assert.ok(!text.includes(value), `leaked ${value}`);
};

/* ----- Global store ----- */

test('U1 U2 U3 the app-wide store lives at <data>/secrets.json with owner-only permissions and round-trips', async () => {
  assert.equal(secretsMod.appSecretsFile(), path.join(dataDir, 'secrets.json'));
  const store = secretsMod.appSecrets();
  await store.set('u3.key', 'u3-value-long');
  assert.equal(await store.get('u3.key'), 'u3-value-long');
  assert.equal(((await stat(appFile())).mode & 0o777).toString(8), '600');
  await store.delete('u3.key');
  assert.equal(await store.get('u3.key'), undefined);
  await store.delete('u3.key');
  assert.ok(!(await appFileText())!.includes('buildings'));
});

test('U4 a saved value is registered for log redaction', async () => {
  await client.saveGoogleClient('u4-client-id-value', 'u4-client-secret-value');
  assert.equal(secretsMod.redactSecrets('id u4-client-id-value / u4-client-secret-value'), 'id [secret] / [secret]');
});

test('U5 after a restart, loadKnownSecrets reads the app-wide file so its values are redacted from the first line', async () => {
  await writeFile(appFile(), JSON.stringify({ 'google.clientId': 'u5-written-before-start' }), { mode: 0o600 });
  assert.equal(secretsMod.redactSecrets('u5-written-before-start'), 'u5-written-before-start');
  await secretsMod.loadKnownSecrets();
  assert.equal(secretsMod.redactSecrets('u5-written-before-start'), '[secret]');
});

test('U6 the app-wide secrets file is git-ignored', () => {
  const repoRoot = path.join(import.meta.dirname, '..', '..');
  execFileSync('git', ['check-ignore', '-q', 'server/data/secrets.json'], { cwd: repoRoot });
});

test('U7 U12 a save trims both values and a second save replaces both', async () => {
  await client.saveGoogleClient('  id-one  ', '\tsecret-one\n');
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'id-one', clientSecret: 'secret-one' });
  await client.saveGoogleClient('id-two', 'secret-two');
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'id-two', clientSecret: 'secret-two' });
});

test('U8 U9 U10 anything but two non-empty strings is refused and keeps the saved pair', async () => {
  await client.saveGoogleClient('kept-id', 'kept-secret');
  const bad: Array<[unknown, unknown]> = [
    [undefined, 's'], ['i', undefined], ['', 's'], ['i', ''], ['   ', 's'], ['i', '   '], ['\t\n', 's'], ['i', '\n\t'],
    [123, 's'], ['i', null], [true, 's'], [['x'], 's'], ['i', {}],
  ];
  for (const [id, secret] of bad) await assert.rejects(client.saveGoogleClient(id, secret), /clientId and clientSecret are required/, JSON.stringify([id, secret]));
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'kept-id', clientSecret: 'kept-secret' });
});

test('U11 there is no length limit, and Unicode is kept', async () => {
  const long = 'x'.repeat(10_000);
  await client.saveGoogleClient(long, 'sécret-ünïcode-✓');
  assert.deepEqual(await client.readGoogleClient(), { clientId: long, clientSecret: 'sécret-ünïcode-✓' });
});

test('U13 clear removes both values and is a no-op when nothing is saved', async () => {
  await client.saveGoogleClient('clear-id', 'clear-secret');
  await client.clearGoogleClient();
  assert.equal(await client.readGoogleClient(), undefined);
  assert.equal(await client.googleClientSaved(), false);
  await client.clearGoogleClient();
});

/* ----- Token refresh ----- */

test('U14 a refresh refused as unauthorized_client, invalid_grant or invalid_client is an auth failure', async () => {
  const { googleServices } = await import('../src/seo/googleServices.ts');
  const realFetch = globalThis.fetch;
  try {
    for (const error of ['unauthorized_client', 'invalid_grant', 'invalid_client']) {
      globalThis.fetch = (async () => new Response(JSON.stringify({ error }), { status: 400 })) as typeof fetch;
      await assert.rejects(googleServices.oauth.refresh({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' }), (e: any) => e.kind === 'auth', error);
    }
  } finally { globalThis.fetch = realFetch; }
});

test('U15 U18 a refresh uses the app-wide pair, and a fresh access token needs no refresh', async () => {
  await savePair();
  const b = await createSeo();
  await connectGsc(b.id);
  const d = { services: fake.services, now: () => clock };
  fake.state.refreshArgs.length = 0;
  await tokens.accessTokenFor(b.id, 'gsc', d);
  assert.equal(fake.state.refreshArgs.length, 0, 'a fresh token is used as is');
  await client.clearGoogleClient();
  assert.ok(await tokens.accessTokenFor(b.id, 'gsc', d), 'a fresh token does not need the client');
  await savePair(OTHER);
  clock = new Date(clock.getTime() + 2 * 3600_000);
  await tokens.accessTokenFor(b.id, 'gsc', d);
  assert.deepEqual(fake.state.refreshArgs, [OTHER]);
});

test('U16 U17 without an app-wide pair a refresh is an auth failure, even with leftover Building keys', async () => {
  await savePair();
  const b = await createSeo();
  await connectGsc(b.id);
  await client.clearGoogleClient();
  const store = new secretsMod.SecretsStore(b.id);
  await store.setMany({ 'google.clientId': SECRETS.clientId, 'google.clientSecret': SECRETS.clientSecret });
  clock = new Date(clock.getTime() + 2 * 3600_000);
  fake.state.refreshCalls = 0;
  await assert.rejects(tokens.accessTokenFor(b.id, 'gsc', { services: fake.services, now: () => clock }), (e: any) => e.kind === 'auth' && /connect the service again/.test(e.message));
  assert.equal(fake.state.refreshCalls, 0);
});

/* ----- API ----- */

test('I1 I2 I5 GET, PUT and DELETE answer only whether a client is saved', async () => {
  assert.deepEqual((await api(ROUTE)).body, { saved: false });
  const put = await savePair();
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { saved: true });
  assert.deepEqual((await api(ROUTE)).body, { saved: true });
  const del = await send('DELETE', ROUTE);
  assert.equal(del.status, 204);
  assert.equal(del.text, '');
  assert.deepEqual((await api(ROUTE)).body, { saved: false });
  assert.equal((await send('DELETE', ROUTE)).status, 204);
});

test('I3 a bad PUT is a 400 with the exact error, and only camelCase keys count', async () => {
  const bodies: Array<RequestInit['body']> = [
    '{}', undefined, 'not json', JSON.stringify({ clientId: 'i' }), JSON.stringify({ clientSecret: 's' }),
    JSON.stringify({ clientId: '  ', clientSecret: '\t' }), JSON.stringify({ clientId: 1, clientSecret: 2 }),
    JSON.stringify({ clientId: null, clientSecret: null }), JSON.stringify({ client_id: 'i', client_secret: 's' }),
  ];
  for (const body of bodies) {
    const res = await api(ROUTE, { method: 'PUT', body });
    assert.equal(res.status, 400, String(body));
    if (body !== 'not json') assert.deepEqual(res.body, { error: 'clientId and clientSecret are required' }, String(body));
  }
  assert.deepEqual((await api(ROUTE)).body, { saved: false });
});

test('I4 extra fields in the PUT body are ignored', async () => {
  const res = await send('PUT', ROUTE, { clientId: 'i4-id', clientSecret: 'i4-secret', extra: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'i4-id', clientSecret: 'i4-secret' });
});

test('I6 no answer and no log line ever carries the id or the secret', async () => {
  const b = await createSeo();
  const texts = [
    (await savePair()).text, (await api(ROUTE)).text, (await api(seo(b.id, '/connections'))).text,
    (await send('PUT', ROUTE, { clientId: SECRETS.clientId })).text, (await send('DELETE', ROUTE)).text,
  ];
  assertNoLeak([...texts, logs.join('\n')], [SECRETS.clientId, SECRETS.clientSecret]);
});

test('I7 I8 one saved client counts for every SEO Building; leftover Building keys do not', async () => {
  const [one, two] = [await createSeo(), await createSeo('https://two.example')];
  await new secretsMod.SecretsStore(one.id).setMany({ 'google.clientId': 'left-id', 'google.clientSecret': 'left-secret' });
  for (const b of [one, two]) assert.equal((await api(seo(b.id, '/connections'))).body.googleClientSaved, false);
  await savePair();
  for (const b of [one, two]) assert.equal((await api(seo(b.id, '/connections'))).body.googleClientSaved, true);
  await send('DELETE', ROUTE);
  for (const b of [one, two]) assert.equal((await api(seo(b.id, '/connections'))).body.googleClientSaved, false);
});

test('I9 I10 consent starts with the app-wide client id for each Google service, and is refused without one', async () => {
  const b = await createSeo();
  const refused = await send('POST', seo(b.id, '/connections/gsc/connect'));
  assert.equal(refused.status, 400);
  assert.equal(refused.body.authUrl, undefined);
  assert.match(refused.body.error, /Settings > Google \(SEO\)/);
  await savePair({ clientId: 'id with spaces&más', clientSecret: 's' });
  for (const service of ['gsc', 'ga4', 'ads']) {
    const res = await send('POST', seo(b.id, `/connections/${service}/connect`));
    assert.ok(res.body.authUrl.includes(`client_id=${encodeURIComponent('id with spaces&más')}`), service);
    assert.equal(new URL(res.body.authUrl).searchParams.get('client_id'), 'id with spaces&más');
  }
});

test('I11 I13 the callback exchanges the code with the client saved at that moment and stores the tokens on the Building', async () => {
  const b = await createSeo();
  await savePair();
  const started = await send('POST', seo(b.id, '/connections/gsc/connect'));
  const state = new URL(started.body.authUrl).searchParams.get('state')!;
  const redirectUri = new URL(started.body.authUrl).searchParams.get('redirect_uri')!;
  await savePair(OTHER);
  assert.equal((await api(`/api/seo/oauth/callback?code=abc&state=${state}`)).status, 200);
  assert.deepEqual(fake.state.exchangeArgs, [{ ...OTHER, redirectUri }]);
  assert.ok(await new secretsMod.SecretsStore(b.id).get('google.gsc.refreshToken'));
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'connected');
});

test('I12 a client removed between start and callback is refused and nothing is connected', async () => {
  const b = await createSeo();
  await savePair();
  const started = await send('POST', seo(b.id, '/connections/gsc/connect'));
  const state = new URL(started.body.authUrl).searchParams.get('state')!;
  await send('DELETE', ROUTE);
  const callback = await api(`/api/seo/oauth/callback?code=abc&state=${state}`);
  assert.equal(callback.status, 400);
  assert.match(callback.text, /The saved Google client is missing/);
  assert.equal(fake.state.exchangeCalls, 0);
  assert.equal((await api(seo(b.id, '/connections'))).body.connections[0].state, 'not-connected');
});

test('I14 a Building signed in with another client is asked to connect again, and reconnecting fixes it', async () => {
  await savePair();
  const b = await createSeo();
  await connectGsc(b.id);
  await savePair(OTHER);
  clock = new Date(clock.getTime() + 2 * 3600_000);
  fake.fail('refresh', authFailure());
  assert.equal((await send('POST', seo(b.id, '/sync'))).status, 202);
  await sync.waitForSync(b.id);
  const gsc = (await api(seo(b.id, '/connections'))).body.connections[0];
  assert.equal(gsc.reason, 'Search Console no longer accepts the saved sign-in. Connect it again.');
  await connectGsc(b.id);
  const reconnected = (await api(seo(b.id, '/connections'))).body.connections[0];
  assert.equal(reconnected.state, 'connected');
  assert.equal(reconnected.reason, undefined);
});

test('I15 the per-Building client route is gone', async () => {
  const b = await createSeo();
  assert.equal((await send('PUT', seo(b.id, '/google-client'), { clientId: 'a', clientSecret: 'b' })).status, 404);
});

test('I16 the generic Building secrets list never shows the Google client', async () => {
  const b = await createSeo();
  await new secretsMod.SecretsStore(b.id).setMany({ 'google.clientId': 'i16-id-value', 'google.clientSecret': 'i16-secret-value' });
  await savePair();
  await client.migrateGoogleClients();
  const keys = (await api(`/api/projects/${b.id}/secrets`)).body.map((s: { key: string }) => s.key);
  assert.ok(!keys.includes('google.clientId') && !keys.includes('google.clientSecret'), JSON.stringify(keys));
});

test('I17 two saves at once leave one whole pair, never a mix', async () => {
  const A = { clientId: 'race-id-A', clientSecret: 'race-secret-A' };
  const B = { clientId: 'race-id-B', clientSecret: 'race-secret-B' };
  await Promise.all([savePair(A), savePair(B)]);
  const saved = await client.readGoogleClient();
  assert.ok([JSON.stringify(A), JSON.stringify(B)].includes(JSON.stringify(saved)), JSON.stringify(saved));
});

test('I18 deleting an SEO Building keeps the app-wide client', async () => {
  const b = await createSeo();
  await savePair();
  assert.ok([200, 204].includes((await send('DELETE', `/api/projects/${b.id}`)).status));
  assert.deepEqual((await api(ROUTE)).body, { saved: true });
});

/* ----- Migration ----- */

let template: ProjectRecord;
/** Leaves only the given SEO Buildings (written straight to the store) with their own secrets. */
async function seedBuildings(specs: Array<{ id: string; createdAt: string; typeId?: string; secrets?: Record<string, string> }>) {
  if (!template) template = (await projectsDb.get((await createSeo()).id))!;
  for (const p of await projectsDb.all()) await projectsDb.delete(p.id);
  for (const spec of specs) {
    await projectsDb.insert({ ...template, id: spec.id, createdAt: spec.createdAt, typeId: spec.typeId ?? 'seo' });
    await rm(path.join(dataDir, 'buildings', spec.id), { recursive: true, force: true });
    if (spec.secrets) await new secretsMod.SecretsStore(spec.id).setMany(spec.secrets);
  }
}
const pair = (clientId: string, clientSecret: string) => ({ 'google.clientId': clientId, 'google.clientSecret': clientSecret });
const buildingKeys = async (id: string) => (await new secretsMod.SecretsStore(id).list()).map((s) => s.key);

test('M1 with no SEO Building and no client, nothing is created', async () => {
  await seedBuildings([]);
  await rm(appFile(), { force: true });
  await client.migrateGoogleClients();
  assert.equal(await appFileText(), undefined);
});

test('M2 one Building: its pair becomes the app-wide one and only its client keys are deleted', async () => {
  await seedBuildings([{ id: 'm2-one', createdAt: '2026-01-01T00:00:00Z', secrets: {
    ...pair('m2-id-value', 'm2-secret-value'), 'google.gsc.refreshToken': 'r1', 'google.gsc.accessToken': 'a1',
    'ads.developerToken': 'dt', 'bing.apiKey': 'bk', 'indexnow.key': 'ik',
  } }]);
  await client.migrateGoogleClients();
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'm2-id-value', clientSecret: 'm2-secret-value' });
  assert.deepEqual(await buildingKeys('m2-one'), ['ads.developerToken', 'bing.apiKey', 'google.gsc.accessToken', 'google.gsc.refreshToken', 'indexnow.key']);
});

test('M3 two Buildings with the same pair: it becomes the app-wide one and both are cleared', async () => {
  await seedBuildings([
    { id: 'm3-a', createdAt: '2026-01-01T00:00:00Z', secrets: pair('m3-id', 'm3-secret') },
    { id: 'm3-b', createdAt: '2026-01-02T00:00:00Z', secrets: pair('m3-id', 'm3-secret') },
  ]);
  await client.migrateGoogleClients();
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'm3-id', clientSecret: 'm3-secret' });
  for (const id of ['m3-a', 'm3-b']) assert.deepEqual(await buildingKeys(id), []);
});

test('M4 two Buildings with different pairs: the older one by createdAt wins, whatever the file or id order', async () => {
  await seedBuildings([
    { id: 'm4-aaa-newer', createdAt: '2026-02-01T00:00:00Z', secrets: pair('newer-id', 'newer-secret') },
    { id: 'm4-zzz-older', createdAt: '2026-01-01T00:00:00Z', secrets: pair('older-id', 'older-secret') },
  ]);
  await client.migrateGoogleClients();
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'older-id', clientSecret: 'older-secret' });
  for (const id of ['m4-aaa-newer', 'm4-zzz-older']) assert.deepEqual(await buildingKeys(id), []);
});

test('M5 an existing app-wide client stays, and every Building is cleared whether it matched or not', async () => {
  await seedBuildings([
    { id: 'm5-same', createdAt: '2026-01-01T00:00:00Z', secrets: pair('global-id', 'global-secret') },
    { id: 'm5-diff', createdAt: '2026-01-02T00:00:00Z', secrets: pair('diff-id', 'diff-secret') },
  ]);
  await client.saveGoogleClient('global-id', 'global-secret');
  await client.migrateGoogleClients();
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'global-id', clientSecret: 'global-secret' });
  for (const id of ['m5-same', 'm5-diff']) assert.deepEqual(await buildingKeys(id), []);
});

test('M6 a second run changes nothing', async () => {
  await seedBuildings([{ id: 'm6-one', createdAt: '2026-01-01T00:00:00Z', secrets: { ...pair('m6-id', 'm6-secret'), 'bing.apiKey': 'bk' } }]);
  await client.migrateGoogleClients();
  const appBefore = { text: await appFileText(), mtime: (await stat(appFile())).mtimeMs };
  const buildingFile = path.join(dataDir, 'buildings', 'm6-one', 'secrets.json');
  const buildingMtime = (await stat(buildingFile)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await client.migrateGoogleClients();
  assert.equal(await appFileText(), appBefore.text);
  assert.equal((await stat(appFile())).mtimeMs, appBefore.mtime);
  assert.equal((await stat(buildingFile)).mtimeMs, buildingMtime);
});

test('M7 M8 an oldest Building without a full pair is skipped as a source, and its partial key is deleted too', async () => {
  await seedBuildings([
    { id: 'm7-none', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'm8-partial', createdAt: '2026-01-02T00:00:00Z', secrets: { 'google.clientId': 'partial-id' } },
    { id: 'm7-full', createdAt: '2026-01-03T00:00:00Z', secrets: pair('full-id', 'full-secret') },
  ]);
  await client.migrateGoogleClients();
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'full-id', clientSecret: 'full-secret' });
  assert.deepEqual(await buildingKeys('m8-partial'), []);
});

test('M9 a non-SEO Building is neither a source nor touched', async () => {
  await seedBuildings([{ id: 'm9-notes', createdAt: '2025-01-01T00:00:00Z', typeId: 'notes', secrets: pair('notes-id', 'notes-secret') }]);
  await client.migrateGoogleClients();
  assert.equal(await client.readGoogleClient(), undefined);
  assert.deepEqual(await buildingKeys('m9-notes'), ['google.clientId', 'google.clientSecret']);
});

test('M10 equal createdAt is broken by id', async () => {
  await seedBuildings([
    { id: 'm10-b', createdAt: '2026-01-01T00:00:00Z', secrets: pair('b-id', 'b-secret') },
    { id: 'm10-a', createdAt: '2026-01-01T00:00:00Z', secrets: pair('a-id', 'a-secret') },
  ]);
  await client.migrateGoogleClients();
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'a-id', clientSecret: 'a-secret' });
});

test('M11 M12 a corrupt Building file is logged without its contents, the others still move, and no value is logged', async () => {
  await seedBuildings([
    { id: 'm11-bad', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'm11-good', createdAt: '2026-01-02T00:00:00Z', secrets: pair('m11-good-id-value', 'm11-good-secret-value') },
  ]);
  await mkdir(path.join(dataDir, 'buildings', 'm11-bad'), { recursive: true });
  await writeFile(path.join(dataDir, 'buildings', 'm11-bad', 'secrets.json'), '{"google.clientId":"m11-bad-id-value" broken');
  await client.migrateGoogleClients();
  assert.deepEqual(await client.readGoogleClient(), { clientId: 'm11-good-id-value', clientSecret: 'm11-good-secret-value' });
  assert.deepEqual(await buildingKeys('m11-good'), []);
  const text = logs.join('\n');
  assert.match(text, /Could not move the Google client of SEO Building m11-bad/);
  assertNoLeak([text], ['m11-bad-id-value', 'm11-good-id-value', 'm11-good-secret-value']);
});

test('M13 the daemon migrates after loading known secrets and before it listens, never failing startup', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
  const load = source.indexOf('await loadKnownSecrets()');
  const migrate = source.indexOf('await migrateGoogleClients().catch(console.error)');
  const listen = source.indexOf('createDaemonServer()');
  assert.ok(load > 0 && migrate > load && listen > migrate, `${load} ${migrate} ${listen}`);
});

/* ----- Source and docs ----- */

test('D1 D2 no per-Building Google client code is left', async () => {
  const grep = (dir: string) => {
    try { return execFileSync('grep', ['-rlE', 'seoSaveGoogleClient|/seo/google-client|google-client`', dir], { encoding: 'utf8' }); } catch { return ''; }
  };
  const root = path.join(import.meta.dirname, '..', '..');
  assert.equal(grep(path.join(root, 'server', 'src')), '');
  assert.equal(grep(path.join(root, 'web', 'src')), '');
  assert.ok(!('clientId' in tokens.secretKeys) && !('clientSecret' in tokens.secretKeys));
});

test('D3 D4 the docs describe the app-wide client, its routes and the migration; no blueprint mentions a per-Building client', async () => {
  const root = path.join(import.meta.dirname, '..', '..');
  const doc = await readFile(path.join(root, 'docs', 'seo-building.md'), 'utf8');
  assert.ok(!doc.includes('google-client`'));
  for (const needle of ['Settings > Google (SEO)', '/api/settings/google-oauth-client', '<data>/secrets.json', 'Connect it again', 'oldest']) assert.ok(doc.includes(needle), `docs/seo-building.md does not mention ${needle}`);
  let hits = '';
  try { hits = execFileSync('grep', ['-rliE', 'google-client|Google OAuth client id', path.join(root, 'catalog'), path.join(root, 'templates')], { encoding: 'utf8' }); } catch { /* no match */ }
  assert.equal(hits, '');
});
