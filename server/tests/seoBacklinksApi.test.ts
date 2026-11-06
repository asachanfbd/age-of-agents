import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let clock: Date;
let storage: typeof import('../src/buildings/buildingStorage.ts');
let deps: typeof import('../src/seo/deps.ts');
let projectsDb: typeof import('../src/db/collections.ts').projectsDb;
const realConsole = { log: console.log, error: console.error, warn: console.warn };
const SITE = 'https://example.test';

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'seo-backlinks-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  process.env.AGENT_VISUAL_OS_TEST_FAULTS = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  storage = await import('../src/buildings/buildingStorage.ts');
  deps = await import('../src/seo/deps.ts');
  ({ projectsDb } = await import('../src/db/collections.ts'));
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const level of ['log', 'error', 'warn'] as const) console[level] = () => {};
});

after(async () => {
  Object.assign(console, realConsole);
  deps.resetSeo();
  await storage.closeAllStores();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  clock = new Date('2026-10-14T12:00:00Z');
  deps.configureSeo({ firstRun: false, now: () => clock, limits: deps.defaultLimits() });
});

async function send(method: string, pathname: string, payload?: unknown) {
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers: { 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body, text, headers: res.headers };
}
const bl = (id: string, suffix = '') => `/api/projects/${id}/seo/backlinks${suffix}`;
async function createSeo() {
  const res = await send('POST', '/api/projects', { typeId: 'seo', siteUrl: SITE });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}
const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');
const ahrefs = (rows: string[][]) => ['Referring page URL,Target URL,Anchor,Domain rating,UR,Domain traffic,First seen,Last seen,Type,Title', ...rows.map((r) => r.join(','))].join('\n');
const row = (n: string, extra: Partial<Record<'dr' | 'ur' | 'anchor' | 'target' | 'traffic', string>> = {}) =>
  [`https://${n}.com/post`, extra.target ?? `${SITE}/pricing`, extra.anchor ?? `link ${n}`, extra.dr ?? '', extra.ur ?? '', extra.traffic ?? '', '2026-10-01', '2026-10-10', 'follow', `Title ${n}`];
const upload = (rows: string[][], over: Record<string, unknown> = {}) => ({ fileName: 'links.csv', content: b64(ahrefs(rows)), mode: 'full', ...over });
const preview = (id: string, body: unknown) => send('POST', bl(id, '/import/preview'), body);
const commit = (id: string, body: unknown) => send('POST', bl(id, '/import'), body);
const list = async (id: string, q = '') => (await send('GET', bl(id, `?${q}`))).body;
const overview = async (id: string, q = '') => (await send('GET', bl(id, `/overview?${q}`))).body;

test('I1/I2 preview saves nothing and reports counts, a sample, row-numbered problems and links that would be lost', async () => {
  const b = await createSeo();
  assert.equal((await commit(b.id, upload([row('a'), row('b')]))).status, 201);
  const res = await preview(b.id, upload([row('a'), row('c', { dr: 'oops' }), row('a')], { mode: 'full' }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.valid, 1);
  assert.equal(res.body.invalid, 1);
  assert.equal(res.body.duplicates, 1);
  assert.deepEqual(res.body.problems.map((p: any) => p.row), [3, 4]);
  assert.equal(res.body.problems[1].message, 'Duplicate of row 2');
  assert.equal(res.body.willBeLost, 1);
  assert.equal(res.body.sample.length, 1);
  assert.equal(res.body.suggested, 'ahrefs');
  assert.equal((await list(b.id)).total, 2);
  assert.equal((await send('GET', bl(b.id, '/batches'))).body.batches.length, 1);
});

test('I3/I4 commit saves links and a batch; the mode is required', async () => {
  const b = await createSeo();
  const done = await commit(b.id, upload([row('a', { dr: '62', traffic: '"1,200"' }), row('b')]));
  assert.equal(done.status, 201, done.text);
  assert.deepEqual(done.body.counts, { added: 2, updated: 0, unchanged: 0, lost: 0, returned: 0 });
  assert.equal(done.body.batch.fileName, 'links.csv');
  assert.equal(done.body.batch.importedAt, '2026-10-14T12:00:00.000Z');
  assert.equal((await commit(b.id, upload([row('c')], { mode: undefined }))).status, 400);
  assert.equal((await commit(b.id, upload([row('c')], { mode: 'sometimes' }))).status, 400);
  const first = (await list(b.id, 'sort=source&dir=asc')).links[0];
  assert.equal(first.sourceDr, 62);
  assert.equal(first.sourceTraffic, 1200);
});

test('I5 problem rows need confirmation; with it only the valid rows are saved', async () => {
  const b = await createSeo();
  const body = upload([row('a'), row('b', { dr: '500' })]);
  const refused = await commit(b.id, body);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Confirm/);
  assert.equal((await list(b.id)).total, 0);
  const ok = await commit(b.id, { ...body, confirm: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.skipped, 1);
  assert.equal((await list(b.id)).total, 1);
});

test('I6 each preset imports its export', async () => {
  const files: Array<[string, string]> = [
    ['ahrefs', ahrefs([row('a', { dr: '40', ur: '33' })])],
    ['semrush', 'Page ascore,Source url,Target url,Anchor,First seen,Last seen\n55,https://a.com/p,https://example.test/x,hello,2026-10-01,2026-10-02'],
    ['moz', 'Source URL,Target URL,Anchor Text,Source Domain Authority,Source Page Authority,Link Type,Date First Seen\nhttps://a.com/p,https://example.test/x,hi,61,33,nofollow,2026-10-01'],
    ['gsc', 'Linking page,Target page,Last crawled\nhttps://a.com/p,https://example.test/x,2026-10-02'],
  ];
  for (const [id, csv] of files) {
    const b = await createSeo();
    const res = await commit(b.id, { fileName: `${id}.csv`, content: b64(csv), format: id, mode: 'full' });
    assert.equal(res.status, 201, `${id}: ${res.text}`);
    assert.equal((await list(b.id)).total, 1);
    if (id === 'ahrefs') assert.deepEqual([(await list(b.id)).links[0].sourceDr, (await list(b.id)).links[0].sourceUr], [40, 33]);
  }
  const b = await createSeo();
  assert.equal((await preview(b.id, { ...upload([row('a')]), format: 'nope' })).status, 400);
});

test('I7 manual mapping needs mapping, can be remembered, and is isolated per Building', async () => {
  const a = await createSeo();
  const other = await createSeo();
  const csv = b64('from,to,words\nhttps://x.com/p,/pricing,go');
  const needs = await preview(a.id, { fileName: 'x.csv', content: csv, format: 'manual' });
  assert.equal(needs.body.needsMapping, true);
  assert.deepEqual(needs.body.headers, ['from', 'to', 'words']);
  assert.equal((await commit(a.id, { fileName: 'x.csv', content: csv, mode: 'partial' })).status, 400);
  const mapping = { sourceUrl: 'from', targetUrl: 'to', anchor: 'words' };
  assert.equal((await commit(a.id, { fileName: 'x.csv', content: csv, mapping, mode: 'partial', rememberAs: 'My tool' })).status, 201);
  assert.deepEqual((await send('GET', bl(a.id, '/mappings'))).body.mappings, [{ name: 'My tool', mapping }]);
  assert.deepEqual((await send('GET', bl(other.id, '/mappings'))).body.mappings, []);
  assert.equal((await commit(a.id, { fileName: 'x.csv', content: csv, mapping: { sourceUrl: 'nope', targetUrl: 'to' }, mode: 'partial' })).status, 400);
  assert.equal((await commit(a.id, { fileName: 'x.csv', content: csv, mapping, mode: 'partial', rememberAs: ' ' })).status, 400);
});

test('I8/I9 a wrong file type or an oversize file is refused and saves nothing', async () => {
  const b = await createSeo();
  const wrong = await commit(b.id, { fileName: 'links.xlsx', content: b64('x'), mode: 'full' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /not a CSV or TSV/);
  deps.configureSeo({ limits: { ...deps.defaultLimits(), backlinkFileBytes: 100 } });
  const big = await commit(b.id, upload([row('a'), row('b'), row('c')]));
  assert.equal(big.status, 413);
  assert.match(big.body.error, /limit/);
  assert.equal((await list(b.id)).total, 0);
});

test('I10 UTF-16 and Latin-1 uploads decode correctly', async () => {
  const b = await createSeo();
  const header = 'Referring page URL;Target URL;Anchor\n';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${header}https://a.com/p;${SITE}/x;café`, 'utf16le')]);
  assert.equal((await commit(b.id, { fileName: 'a.csv', content: b64(utf16), mode: 'partial' })).status, 201);
  const latin = Buffer.concat([Buffer.from(`${header}https://b.com/p;${SITE}/x;`), Buffer.from([0x63, 0x61, 0x66, 0xe9])]);
  assert.equal((await commit(b.id, { fileName: 'b.csv', content: b64(latin), mode: 'partial' })).status, 201);
  const anchors = (await list(b.id)).links.map((l: any) => l.anchor);
  assert.deepEqual(anchors, ['café', 'café']);
});

test('I12/I13 re-importing updates rather than duplicates; a changed metric updates, first seen is kept, an empty value does not wipe', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a', { dr: '40', traffic: '10' })]));
  const again = await commit(b.id, upload([row('a', { dr: '', traffic: '99' })]));
  assert.deepEqual(again.body.counts, { added: 0, updated: 1, unchanged: 0, lost: 0, returned: 0 });
  const links = (await list(b.id)).links;
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].sourceDr, links[0].sourceTraffic, links[0].firstSeen], [40, 99, '2026-10-01']);
  const same = await commit(b.id, upload([row('a', { dr: '', traffic: '99' })]));
  assert.equal(same.body.counts.unchanged, 1);
  assert.equal((await send('GET', bl(b.id, '/batches'))).body.batches.map((x: any) => x.seq).join(), '3,2,1');
});

test('I14-I16 full imports mark absent links lost; a partial update does not; a returning link is live again', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a'), row('b')]));
  const full = await commit(b.id, upload([row('a')]));
  assert.equal(full.body.counts.lost, 1);
  assert.equal((await list(b.id, 'status=lost')).links[0].sourceUrl, 'https://b.com/post');
  await commit(b.id, upload([row('c')], { mode: 'partial' }));
  assert.equal((await list(b.id, 'status=lost')).total, 1);
  const back = await commit(b.id, upload([row('a'), row('b'), row('c')]));
  assert.equal(back.body.counts.returned, 1);
  assert.equal((await list(b.id, 'status=lost')).total, 0);
});

test('I17 a file with no valid rows is refused and changes nothing', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a')]));
  const res = await commit(b.id, { ...upload([row('a', { dr: 'zzz' })]), confirm: true });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no valid rows/);
  assert.equal((await list(b.id, 'status=lost')).total, 0);
});

test('I18 an import in one Building never touches another', async () => {
  const a = await createSeo();
  const c = await createSeo();
  await commit(a.id, upload([row('a')]));
  await commit(c.id, upload([row('z')]));
  await commit(c.id, upload([row('y')]));
  assert.equal((await list(a.id)).total, 1);
  assert.equal((await list(a.id, 'status=lost')).total, 0);
});

test('I19 a failure part-way through leaves links, lost marks and batches unchanged, and a retry works', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a'), row('b')]));
  const store = await storage.getStore((await projectsDb.get(b.id))!);
  await store.setFault({ code: 'SQLITE_FULL', atRow: 0 });
  const failed = await commit(b.id, upload([row('a', { dr: '70' }), row('c')]));
  assert.ok(failed.status >= 400, failed.text);
  assert.ok(!failed.text.includes(tempRoot) && !/SQLITE/.test(failed.text));
  const links = (await list(b.id)).links;
  assert.deepEqual(links.map((l: any) => l.status).sort(), ['new', 'new']);
  assert.equal(links.some((l: any) => l.sourceDr === 70), false);
  assert.equal((await send('GET', bl(b.id, '/batches'))).body.batches.length, 1);
  // A disk-full stops ingestion for the Building until the person resumes it; after that the same import goes through.
  assert.equal((await commit(b.id, upload([row('a', { dr: '70' }), row('c')]))).status >= 400, true);
  await storage.resumeIngestion(b.id);
  assert.equal((await commit(b.id, upload([row('a', { dr: '70' }), row('c')]))).status, 201);
  assert.equal((await list(b.id)).links.some((l: any) => l.sourceDr === 70), true);
});

test('I21 two imports started together are applied one after the other', async () => {
  const b = await createSeo();
  const [one, two] = await Promise.all([commit(b.id, upload([row('a')])), commit(b.id, upload([row('b')]))]);
  assert.deepEqual([one.status, two.status], [201, 201]);
  const seqs = (await send('GET', bl(b.id, '/batches'))).body.batches.map((x: any) => x.seq);
  assert.deepEqual(seqs, [2, 1]);
  assert.equal((await list(b.id, 'status=lost')).total, 1);
});

test('I23 a read-only Building refuses imports, notes and deletes but can still be read', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a')]));
  const [first] = (await list(b.id)).links;
  await projectsDb.update(b.id, { readOnlyReason: 'newer data' });
  assert.equal((await commit(b.id, upload([row('b')]))).status, 409);
  assert.equal((await send('PUT', bl(b.id, `/${first.uid}/note`), { note: 'x' })).status, 409);
  assert.equal((await send('DELETE', bl(b.id, `/${first.uid}`))).status, 409);
  assert.equal((await list(b.id)).total, 1);
});

test('I22 a Building without a site address refuses imports', async () => {
  const b = await createSeo();
  const settings = await import('../src/seo/settings.ts');
  await settings.updateSettings(b.id, (current) => { current.siteUrl = ''; });
  const res = await commit(b.id, upload([row('a')]));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /site address/);
});

test('I26 missing metrics come back as null, never 0, with other-host and extras', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a', { target: 'https://elsewhere.com/x' }), row('b', { dr: '0' })]));
  const links = new Map<string, any>((await list(b.id)).links.map((l: any) => [l.sourceHost, l]));
  const a = links.get('a.com');
  assert.deepEqual([a.sourceDr, a.sourceUr, a.sourceTraffic, a.pageDr, a.pageTraffic], [null, null, null, null, null]);
  assert.equal(a.otherHost, true);
  assert.deepEqual(a.extras, { Title: 'Title a' });
  assert.equal(links.get('b.com').sourceDr, 0);
  assert.ok(a.uid);
});

test('I27/I28 filters, search, sort and pagination work over HTTP', async () => {
  const b = await createSeo();
  const rows = Array.from({ length: 30 }, (_, i) => row(`s${String(i).padStart(2, '0')}`, { dr: String(i * 3), target: i % 2 ? `${SITE}/a` : `${SITE}/b` }));
  await commit(b.id, upload(rows));
  assert.equal((await list(b.id, 'drMin=30&drMax=60')).total, 11);
  assert.equal((await list(b.id, `target=${encodeURIComponent(`${SITE}/a`)}`)).total, 15);
  assert.equal((await list(b.id, 'domain=s05.com')).total, 1);
  assert.equal((await list(b.id, 'search=LINK%20S07')).total, 1);
  assert.equal((await list(b.id, 'type=follow')).total, 30);
  assert.equal((await list(b.id, 'type=nofollow')).total, 0);
  const page = await list(b.id, 'sort=dr&dir=desc&limit=5&offset=5');
  assert.deepEqual(page.links.map((l: any) => l.sourceDr), [72, 69, 66, 63, 60]);
  assert.equal(page.total, 30);
  assert.equal((await list(b.id, 'sort=dr&offset=1000')).links.length, 0);
});

test('I29 new-in-period and lost-in-period views follow the periods', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a'), row('b')]));
  assert.equal((await list(b.id, 'view=new&period=28')).total, 2);
  clock = new Date('2026-12-30T00:00:00Z');
  await commit(b.id, upload([row('a')]));
  assert.equal((await list(b.id, 'view=new&period=28')).total, 0);
  assert.equal((await list(b.id, 'view=new&period=90')).total, 1);
  assert.equal((await list(b.id, 'view=lost&period=7')).total, 1);
  assert.equal((await overview(b.id, 'period=7')).summary.lostInPeriod, 1);
});

test('I30-I32 rollups and the summary, with partial data visible', async () => {
  const b = await createSeo();
  assert.equal((await overview(b.id)).summary.averageDr, null);
  await commit(b.id, upload([row('a', { dr: '50', traffic: '100' }), row('a', { dr: '70', traffic: '5', anchor: 'again' }), row('b'), row('c', { dr: '30' })]));
  const domains = (await send('GET', bl(b.id, '/domains'))).body.domains;
  assert.deepEqual(domains[0], { domain: 'a.com', links: 2, bestDr: 70, totalTraffic: 105 });
  assert.equal(domains.find((d: any) => d.domain === 'b.com').bestDr, null);
  const targets = (await send('GET', bl(b.id, '/targets'))).body.targets;
  assert.deepEqual(targets[0], { target: `${SITE}/pricing`, links: 4, domains: 3, bestDr: 70, otherHost: false });
  const o = await overview(b.id);
  assert.deepEqual(o.summary, { total: 4, referringDomains: 3, newInPeriod: 4, lostInPeriod: 0, averageDr: 50, withDr: 3 });
  assert.equal(o.hasImports, true);
});

test('I33 export honours filters, leaves nulls empty, escapes formulas and adds extras columns', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a', { dr: '40', anchor: '=SUM(1)' }), row('b')]));
  const res = await send('GET', bl(b.id, '/export?domain=a.com'));
  assert.match(res.headers.get('content-type')!, /text\/csv/);
  assert.match(res.headers.get('content-disposition')!, /backlinks\.csv/);
  const [head, line, rest] = res.text.split('\n');
  assert.ok(head!.startsWith('Source URL,Source domain,Target URL,Anchor') && head!.endsWith(',Title'));
  assert.ok(line!.includes("'=SUM(1)") && line!.includes(',40,,,,,,no,') && line!.endsWith('Title a'));
  assert.equal(rest, '');
});

test('I34 invalid query parameters answer 400', async () => {
  const b = await createSeo();
  for (const q of ['drMin=abc', 'period=30', 'sort=nope', 'limit=0', 'limit=9999', 'drMin=80&drMax=10', 'status=x', 'view=x']) assert.equal((await send('GET', bl(b.id, `?${q}`))).status, 400, q);
});

test('I35/I36/I37 a link can be deleted and re-imported as new; notes save, clear and survive a re-import', async () => {
  const b = await createSeo();
  const other = await createSeo();
  await commit(b.id, upload([row('a'), row('b')]));
  const [first] = (await list(b.id, 'sort=source&dir=asc')).links;
  assert.equal((await send('PUT', bl(b.id, `/${first.uid}/note`), { note: ' call them ' })).body.note, 'call them');
  assert.equal((await send('PUT', bl(b.id, `/${first.uid}/note`), { note: 'x'.repeat(2001) })).status, 400);
  assert.equal((await send('PUT', bl(b.id, '/nope/note'), { note: 'x' })).status, 404);
  await commit(b.id, upload([row('a', { dr: '9' }), row('b')]));
  assert.equal((await list(b.id, 'sort=source&dir=asc')).links[0].note, 'call them');
  await send('PUT', bl(b.id, `/${first.uid}/note`), { note: '' });
  assert.equal((await list(b.id, 'sort=source&dir=asc')).links[0].note, '');
  assert.equal((await send('DELETE', bl(other.id, `/${first.uid}`))).status, 404);
  assert.equal((await send('DELETE', bl(b.id, '/missing'))).status, 404);
  assert.equal((await send('DELETE', bl(b.id, `/${first.uid}`))).status, 204);
  assert.equal((await overview(b.id)).summary.total, 1);
  await commit(b.id, upload([row('a'), row('b')]));
  assert.equal((await list(b.id, 'domain=a.com')).links[0].status, 'new');
});

test('I39/I40 batches are listed newest first with counts and there is no route to delete one', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a')]));
  await commit(b.id, upload([row('a'), row('b')], { fileName: 'second.csv' }));
  const batches = (await send('GET', bl(b.id, '/batches'))).body.batches;
  assert.deepEqual(batches.map((x: any) => [x.seq, x.fileName, x.added, x.fileRows]), [[2, 'second.csv', 1, 2], [1, 'links.csv', 1, 1]]);
  assert.ok([404, 405].includes((await send('DELETE', bl(b.id, `/batches/${batches[0].uid}`))).status));
});

test('I41 responses expose no data-directory path', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a')]));
  for (const suffix of ['', '/overview', '/domains', '/targets', '/batches']) assert.ok(!(await send('GET', bl(b.id, suffix))).text.includes(tempRoot));
});

test('a non-SEO Building answers 404', async () => {
  assert.equal((await send('GET', '/api/projects/nope/seo/backlinks')).status, 404);
});

test('I25 a Building made before the Backlinks tables keeps its data and gains them', async () => {
  const { BulkStore } = await import('../src/buildings/bulkClient.ts');
  const { SEO_STORAGE } = await import('../src/buildings/types/seo.ts');
  const file = path.join(tempRoot, 'migrate', 'seo.sqlite');
  const old = { ...SEO_STORAGE, tables: SEO_STORAGE.tables.filter((t) => !t.name.startsWith('seo_backlink')), migrations: [{ toVersion: 2, sql: [] }] };
  const open = (spec: typeof SEO_STORAGE, version: number) => new BulkStore({ file, spec, version, backupDir: path.join(tempRoot, 'migrate', 'backups') } as any);
  const v2 = open(old, 2);
  await v2.open();
  await v2.insert('fetch_ledger', [['gsc', 'p', '2026-01-01', 1, 'now', 3]]);
  await v2.close();
  const v3 = open(SEO_STORAGE, 5);
  assert.equal((await v3.open()).status, 'migrated');
  assert.equal((await v3.count('fetch_ledger')).count, 1);
  assert.equal((await v3.count('seo_backlinks')).count, 0);
  await v3.close();
});

test('U14 a small chunk size gives the same result as one pass, and U53/U54 three copies keep the first row', async () => {
  const rows = [row('a', { dr: '10' }), row('a', { dr: '90' }), row('b'), row('a', { dr: '20' }), row('c', { dr: 'x' }), row('d')];
  const results: unknown[] = [];
  for (const chunk of [2, 5000]) {
    deps.configureSeo({ limits: { ...deps.defaultLimits(), backlinkChunkRows: chunk } });
    const b = await createSeo();
    const res = await preview(b.id, upload(rows));
    assert.deepEqual([res.body.valid, res.body.invalid, res.body.duplicates], [3, 1, 2]);
    assert.deepEqual(res.body.problems.map((p: any) => p.message), ['Duplicate of row 2', 'Duplicate of row 2', 'DR is not a number: x']);
    await commit(b.id, { ...upload(rows), confirm: true });
    results.push((await list(b.id, 'sort=source&dir=asc')).links.map((l: any) => [l.sourceHost, l.sourceDr]));
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], [['a.com', 10], ['b.com', null], ['d.com', null]]);
});

test('I11 a large file imports in chunks and other requests are answered meanwhile', async () => {
  deps.configureSeo({ limits: { ...deps.defaultLimits(), backlinkChunkRows: 500 } });
  const b = await createSeo();
  const rows = Array.from({ length: 20_000 }, (_, i) => row(`s${i}`));
  const importing = commit(b.id, upload(rows));
  let answered = 0;
  while (answered < 3) { assert.equal((await send('GET', '/api/health')).status < 500, true); answered++; }
  assert.equal((await importing).status, 201);
  assert.equal((await list(b.id)).total, 20_000);
});

test('U56 only the first 200 problems are listed, with the true total', async () => {
  const b = await createSeo();
  const res = await preview(b.id, upload([row('ok'), ...Array.from({ length: 250 }, (_, i) => row(`bad${i}`, { dr: 'zz' }))]));
  assert.equal(res.body.problems.length, 200);
  assert.equal(res.body.problemsTotal, 250);
  assert.equal(res.body.valid, 1);
});

test('U57/U27 a file where every row is invalid has no valid rows, and a saved mapping naming a missing column is refused', async () => {
  const b = await createSeo();
  const res = await preview(b.id, upload([row('a', { dr: 'x' }), row('b', { dr: 'y' })]));
  assert.deepEqual([res.body.valid, res.body.invalid], [0, 2]);
  const stale = await commit(b.id, { fileName: 'x.csv', content: b64('from,to\nhttps://x.com/p,/a'), mapping: { sourceUrl: 'from', targetUrl: 'gone' }, mode: 'partial' });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /"gone" is not in the file/);
});

test('I38 an other-host target is flagged and listed separately in the target rollup', async () => {
  const b = await createSeo();
  await commit(b.id, upload([row('a', { target: 'https://elsewhere.com/x' }), row('b')]));
  const targets = (await send('GET', bl(b.id, '/targets'))).body.targets;
  assert.deepEqual(targets.map((t: any) => [t.target, t.otherHost]).sort(), [['https://elsewhere.com/x', true], [`${SITE}/pricing`, false]]);
});
