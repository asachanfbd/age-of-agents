import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import type { Insights } from '../src/content/insights.ts';
import type { Retros } from '../src/content/retros.ts';
import type { StudioEvent, StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/**
 * Importing past Concepts end to end: the migration, saving through the session tool, the import session, the read-only
 * rules, Insights, Reference content and Learn (I01-I72 and the database-backed U35-U38 in the Test Case Planning list). The agents and the
 * terminal host are fakes, and every file lives in a temp folder.
 */

type RetroInput = { buildingId: string; prompt: string; instructions: string };
type InsightsInput = { buildingId: string; dataFile: string; instructions: string; signal: AbortSignal };
let t: ContentApi;
let service: StudioSessions;
let retros: Retros;
let insights: Insights;
let terminal: ReturnType<typeof fakeTerminalHost>;
let home: string;
let token: string;
let defaultAgent: string | null = 'test-claude-cli';
let learnAnswer: (input: RetroInput) => Promise<string>;
let dataSeen: any[] = [];
let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
const retroCalls: RetroInput[] = [];
const events: StudioEvent[] = [];
let mod: {
  contentCtx: typeof import('../src/content/runtime.ts').contentCtx;
  getConcept: typeof import('../src/content/concepts.ts').getConcept;
  conceptDir: typeof import('../src/content/concepts.ts').conceptDir;
  scriptFile: typeof import('../src/content/concepts.ts').scriptFile;
  referenceSection: typeof import('../src/content/referenceContent.ts').referenceSection;
  openContentDb: typeof import('../src/content/db.ts').openContentDb;
  setAssetState: typeof import('../src/content/concepts.ts').setAssetState;
};

const STYLE = '# Writing style\n\n## General\n\nBe plain.\n\n## LinkedIn\n\n## Instagram\n\n## X\n\n## Facebook\n\n## Blog\n\n## Video script\n';
const CHANGE = { section: 'General', action: 'add', text: 'Open with the result.', reason: 'The post opens with it' };
const answer = (changes: unknown[] = [CHANGE]) => JSON.stringify({ summary: 'Sounds like the owner', changes });
const PUBLISHED = '2026-10-01T09:00:00.000Z';
const post = (over: Record<string, unknown> = {}) => ({ platform: 'linkedin', format: 'text', text: 'We stopped standups.', publishedAt: PUBLISHED, ...over });
const body = (over: Record<string, unknown> = {}) => ({ title: 'Past', brief: 'Why', posts: [post()], ...over });
const blogText = `# Pricing\n\n${'x'.repeat(300)}`;

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'import-home-'));
  t = await startContentApi(async () => {
    const [ses, ins, ret, runtime, concepts, reference, db, hooks] = await Promise.all([
      import('../src/content/studioSessions.ts'), import('../src/content/insights.ts'), import('../src/content/retros.ts'), import('../src/content/runtime.ts'), import('../src/content/concepts.ts'),
      import('../src/content/referenceContent.ts'), import('../src/content/db.ts'), import('../src/terminal/projectCliHooks.ts'),
    ]);
    mod = { contentCtx: runtime.contentCtx, getConcept: concepts.getConcept, conceptDir: concepts.conceptDir, scriptFile: concepts.scriptFile, referenceSection: reference.referenceSection, openContentDb: db.openContentDb, setAssetState: concepts.setAssetState };
    token = hooks.CLI_HOOK_TOKEN;
    terminal = fakeTerminalHost();
    retros = ret.createRetros({ agent: { run: (input: RetroInput) => { retroCalls.push(input); return learnAnswer(input); } }, home, timeoutMs: 200 });
    insights = ins.createInsights({
      agent: { run: async (input: InsightsInput) => { dataSeen.push(JSON.parse(await readFile(input.dataFile, 'utf8'))); return JSON.stringify({ markdown: '## Summary\n\nFine.' }); } }, timeoutMs: 200,
      schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    });
    service = ses.createStudioSessions({ host: terminal.host, defaultAgentId: async () => defaultAgent, home, retros, importInsights: insights });
    service.onEvent((e) => events.push(e));
    return { studioSessions: service, insights };
  });
});
after(async () => { await retros.settled(); await service.settled(); await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => { learnAnswer = async () => answer(); retroCalls.length = 0; events.length = 0; timers = []; dataSeen = []; defaultAgent = 'test-claude-cli'; });

const ctxOf = async (b: string) => mod.contentCtx((await t.projectsDb.get(b))!);

const tool = (url: string, sid: string, init: RequestInit = {}, key = token) => t.api(`/api/studio-session/${url}${url.includes('?') ? '&' : '?'}taskId=${sid}`, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } });
const save = (sid: string, payload: unknown, key?: string) => tool('imported-concept', sid, { method: 'POST', body: JSON.stringify(payload) }, key);
const reference = (sid: string, query = '') => tool(`reference-content${query}`, sid);
const route = (b: string, suffix = '') => t.c(b, `/import-session${suffix}`);

async function session(name = 'Acme'): Promise<{ b: string; sid: string }> {
  const b = await t.createStudio(name);
  const started = await t.send('POST', route(b));
  assert.equal(started.status, 201, started.text);
  return { b, sid: started.body.session.id as string };
}
async function saved(payload: unknown = body()): Promise<{ b: string; sid: string; cid: string; c: any }> {
  const s = await session();
  const res = await save(s.sid, payload);
  assert.equal(res.status, 201, res.text);
  return { ...s, cid: res.body.conceptId, c: (await t.api(t.c(s.b, `/concepts/${res.body.conceptId}`))).body };
}
const assetId = (c: any, kind: string) => (c.assets.find((a: any) => a.kind === kind) ?? c.posts.flatMap((p: any) => p.needs).find((a: any) => a.kind === kind)).id as string;
const exists = (file: string) => access(file).then(() => true, () => false);
const rows = async (b: string, table: string) => ((await ctxOf(b)).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const settle = async () => { await retros.settled(); await new Promise((r) => setTimeout(r, 20)); };
const OLD_SCHEMA = `
CREATE TABLE concepts (id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE posts (id TEXT PRIMARY KEY, conceptId TEXT NOT NULL, platform TEXT NOT NULL, format TEXT NOT NULL, scheduledAt INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', note TEXT, createdAt INTEGER NOT NULL, publishedAt INTEGER, liveUrl TEXT);
CREATE TABLE assets (id TEXT PRIMARY KEY, conceptId TEXT NOT NULL, postId TEXT, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'empty', content TEXT, finalizedAt INTEGER, round INTEGER NOT NULL DEFAULT 0);
CREATE TABLE retros (id TEXT PRIMARY KEY, assetId TEXT NOT NULL, conceptId TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, draftCount INTEGER NOT NULL, roundCount INTEGER NOT NULL);
INSERT INTO concepts VALUES ('c1', 'Old', 'b', 0, 1, 1, 1);
INSERT INTO posts (id, conceptId, platform, format, scheduledAt, createdAt) VALUES ('p1', 'c1', 'linkedin', 'text', 1, 1);
INSERT INTO assets (id, conceptId, postId, kind) VALUES ('a1', 'c1', NULL, 'script'), ('a2', 'c1', NULL, 'video'), ('a3', 'c1', 'p1', 'post-text');
INSERT INTO retros VALUES ('r1', 'a1', 'c1', 1, 'nothing', NULL, 1, 1);`;

test('I01/I02 an old database gains the four columns, keeps its data, and opens twice', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-migrate-'));
  const file = path.join(dir, 'content.sqlite');
  const old = new Database(file);
  old.exec(OLD_SCHEMA);
  old.close();
  for (const pass of [1, 2]) {
    const db = mod.openContentDb(file);
    assert.deepEqual(db.prepare('SELECT title, imported, importSessionId FROM concepts').all(), [{ title: 'Old', imported: 0, importSessionId: null }], `pass ${pass}`);
    assert.deepEqual(db.prepare('SELECT platform, externalAssets FROM posts').all(), [{ platform: 'linkedin', externalAssets: null }]);
    assert.deepEqual(db.prepare('SELECT status, sourceKind FROM retros').all(), [{ status: 'nothing', sourceKind: 'asset' }]);
    db.close();
  }
  await rm(dir, { recursive: true, force: true });
});

test('I03 the thumbnail migration on an imported video Concept adds an empty row that stays out of needs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-migrate-'));
  const file = path.join(dir, 'content.sqlite');
  const first = mod.openContentDb(file);
  first.exec(`INSERT INTO concepts (id, title, createdAt, updatedAt, seq, imported) VALUES ('11111111-1111-4111-8111-111111111111', 'V', 1, 1, 1, 1);
    INSERT INTO posts (id, conceptId, platform, format, scheduledAt, status, createdAt, publishedAt) VALUES ('p1', '11111111-1111-4111-8111-111111111111', 'linkedin', 'video', 1, 'published', 1, 1);
    INSERT INTO assets (id, conceptId, postId, kind) VALUES ('a1', '11111111-1111-4111-8111-111111111111', NULL, 'script'), ('a2', '11111111-1111-4111-8111-111111111111', NULL, 'video'), ('a3', '11111111-1111-4111-8111-111111111111', 'p1', 'post-text');`);
  first.close();
  const db = mod.openContentDb(file);
  const ctx = { db, buildingId: 'b', dir, now: () => 2, timezone: () => 'UTC', exclusive: <T>(work: () => Promise<T>) => work() };
  const concept = mod.getConcept(ctx, '11111111-1111-4111-8111-111111111111');
  assert.ok(concept.assets.some((a) => a.kind === 'thumbnail' && a.state === 'empty'));
  assert.deepEqual(concept.posts[0]!.needs, []);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test('I04/I05 a save answers 201 and stores finalized assets, script.md and published posts', async () => {
  const s = await session();
  const res = await save(s.sid, {
    title: ' Standups ', brief: 'Why', script: 'Hook\nBeat',
    posts: [
      post({ liveUrl: 'https://example.com/a', note: 'First', externalAssets: 'Clip on Drive', scheduledAt: '2026-09-30T09:00:00Z' }),
      { platform: 'x', format: 'text', text: 'One\n---\nTwo', publishedAt: PUBLISHED },
      { platform: 'blog', format: 'article', text: blogText, publishedAt: PUBLISHED },
    ],
  });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(Object.keys(res.body).sort(), ['conceptId', 'posts', 'title']);
  assert.deepEqual(res.body.posts.map((p: any) => [p.platform, p.format]), [['linkedin', 'text'], ['x', 'text'], ['blog', 'article']]);
  assert.ok(res.body.posts.every((p: any) => typeof p.postId === 'string'));
  const c = (await t.api(t.c(s.b, `/concepts/${res.body.conceptId}`))).body;
  assert.deepEqual([c.imported, c.title, c.brief], [true, 'Standups', 'Why']);
  assert.equal(c.assets.find((a: any) => a.kind === 'script').state, 'finalized');
  assert.equal(c.assets.find((a: any) => a.kind === 'script').content, 'Hook\nBeat');
  assert.equal(await readFile(mod.scriptFile(await ctxOf(s.b), c.id), 'utf8'), 'Hook\nBeat');
  const linkedin = c.posts.find((p: any) => p.platform === 'linkedin');
  assert.deepEqual([linkedin.status, linkedin.publishedAt, linkedin.scheduledAt, linkedin.liveUrl, linkedin.note, linkedin.externalAssets], ['published', PUBLISHED, '2026-09-30T09:00:00.000Z', 'https://example.com/a', 'First', 'Clip on Drive']);
  assert.deepEqual(linkedin.needs.map((a: any) => [a.kind, a.state, a.content]), [['post-text', 'finalized', 'We stopped standups.']]);
  assert.equal(c.posts.find((p: any) => p.platform === 'blog').needs[0].content, blogText);
  assert.deepEqual(c.progress, { finalized: 3, needed: 3 });
});

test('I06 image and video posts need nothing they did not bring; finalized equals needed', async () => {
  const { c, b } = await saved(body({ posts: [{ platform: 'instagram', format: 'image', publishedAt: PUBLISHED }, post({ format: 'video' })] }));
  const [image, video] = [c.posts.find((p: any) => p.format === 'image'), c.posts.find((p: any) => p.format === 'video')];
  assert.deepEqual(image.needs, []);
  assert.deepEqual(video.needs.map((a: any) => a.kind), ['post-text']);
  assert.deepEqual(c.progress, { finalized: 1, needed: 1 });
  const states = (await ctxOf(b)).db.prepare("SELECT kind, state FROM assets WHERE conceptId = ? AND kind IN ('image-set', 'video', 'thumbnail') ORDER BY kind").all(c.id);
  assert.deepEqual(states, [{ kind: 'image-set', state: 'empty' }, { kind: 'thumbnail', state: 'empty' }, { kind: 'video', state: 'empty' }]);
});

test('I07 without a script: no script.md, an empty script asset, and the folder exists', async () => {
  const { c, b } = await saved();
  const ctx = await ctxOf(b);
  assert.equal(c.assets.find((a: any) => a.kind === 'script').state, 'empty');
  assert.equal(await exists(mod.scriptFile(ctx, c.id)), false);
  assert.equal(await exists(mod.conceptDir(ctx, c.id)), true);
});

test('I08/I09 stats are stored in order with watch time, and count in results, the result filter and the summary', async () => {
  const { b, c } = await saved(body({ posts: [post({ format: 'video', stats: [
    { capturedAt: '2026-10-02T09:00:00Z', counts: { impressions: 100, likes: 1 } },
    { capturedAt: '2026-10-20T09:00:00Z', counts: { impressions: 500, likes: 9 }, watchTime: 12.5, note: 'Later' },
  ] })] }));
  const p = c.posts[0];
  assert.equal(p.stats.count, 2);
  assert.deepEqual([p.stats.latest.counts.impressions, p.stats.latest.watchTime, p.stats.latest.note, p.stats.delta.impressions], [500, 12.5, 'Later', 400]);
  const snapshots = (await t.api(t.c(b, `/concepts/${c.id}/posts/${p.id}/stats`))).body.snapshots;
  assert.deepEqual(snapshots.map((s: any) => s.capturedAt), ['2026-10-20T09:00:00.000Z', '2026-10-02T09:00:00.000Z']);
  assert.equal((await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 100 })).status, 200);
  const list = (await t.api(t.c(b, '/concepts?result=on-target'))).body;
  assert.deepEqual(list.rows.map((r: any) => r.id), [c.id]);
  assert.equal(list.rows[0].posts[0].result.overall, 'on-target');
  assert.equal((await t.api(t.c(b, '/concepts'))).body.summary.find((s: any) => s.platform === 'linkedin').onTarget, 1);
});

test('I10 the list shows imported Concepts and filters them, with status, platform and views sort', async () => {
  const { b, c } = await saved();
  const normal = (await t.send('POST', t.c(b, '/concepts'), { title: 'Normal', posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] })).body;
  const ids = async (q: string) => { const page = (await t.api(t.c(b, `/concepts${q}`))).body; return { ids: page.rows.map((r: any) => r.id), total: page.total, hasMore: page.hasMore }; };
  assert.deepEqual((await ids('')).ids, [normal.id, c.id]);
  assert.deepEqual(await ids('?imported=true'), { ids: [c.id], total: 1, hasMore: false });
  assert.deepEqual((await ids('?imported=false')).ids, [normal.id]);
  assert.deepEqual((await ids('?imported=true&status=published&platform=linkedin&sort=views')).ids, [c.id]);
  assert.deepEqual((await ids('?imported=true&platform=x')).ids, []);
  assert.deepEqual(await ids('?imported=true&limit=1&offset=0'), { ids: [c.id], total: 1, hasMore: false });
  for (const bad of ['True', '1', '']) {
    const res = await t.api(t.c(b, `/concepts?imported=${bad}`));
    assert.deepEqual([res.status, res.body.field], [400, 'imported'], bad);
  }
});

test('I11 the calendar shows imported posts on their published day', async () => {
  const { b, c } = await saved();
  const month = (await t.api(t.c(b, '/calendar?month=2026-10'))).body;
  assert.deepEqual(month.posts.map((p: any) => [p.conceptId, p.conceptTitle]), [[c.id, 'Past']]);
});

test('I12 list and detail carry imported and externalAssets, false and null on a normal Concept', async () => {
  const { b, c } = await saved(body({ posts: [post({ externalAssets: 'Drive' })] }));
  const normal = (await t.send('POST', t.c(b, '/concepts'), { title: 'Normal', posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] })).body;
  assert.deepEqual([normal.imported, normal.posts[0].externalAssets], [false, null]);
  const rowsOf = (await t.api(t.c(b, '/concepts'))).body.rows;
  assert.deepEqual(rowsOf.map((r: any) => [r.imported, r.posts[0].externalAssets]), [[false, null], [true, 'Drive']]);
  assert.equal(c.imported, true);
});

test('I13 a fault in the last of 20 posts writes nothing', async () => {
  const s = await session();
  const posts = Array.from({ length: 20 }, (_, i) => (i === 19 ? post({ text: 'x'.repeat(3001) }) : post()));
  const res = await save(s.sid, body({ script: 'Hook', posts }));
  assert.deepEqual([res.status, res.body.field], [400, 'posts[19].text']);
  for (const table of ['concepts', 'posts', 'assets', 'post_stats']) assert.equal(await rows(s.b, table), 0, table);
  assert.equal((await t.api(t.c(s.b, '/concepts'))).body.total, 0);
});

test('I14 a script write failure rolls the rows back', async () => {
  const s = await session();
  const ctx = await ctxOf(s.b);
  await writeFile(path.join(ctx.dir, 'concepts'), 'in the way');
  const res = await save(s.sid, body({ script: 'Hook' }));
  assert.equal(res.status, 500);
  assert.equal(await rows(s.b, 'concepts'), 0);
  await rm(path.join(ctx.dir, 'concepts'));
  assert.equal((await save(s.sid, body({ script: 'Hook' }))).status, 201);
});

test('I15 a stats insert failure leaves nothing behind', async () => {
  const s = await session();
  const ctx = await ctxOf(s.b);
  ctx.db.exec("CREATE TRIGGER no_stats BEFORE INSERT ON post_stats BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
  const res = await save(s.sid, body({ script: 'Hook', posts: [post({ stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 1 } }] })] }));
  assert.equal(res.status, 500);
  ctx.db.exec('DROP TRIGGER no_stats');
  for (const table of ['concepts', 'posts', 'assets']) assert.equal(await rows(s.b, table), 0, table);
  assert.equal(await exists(path.join(ctx.dir, 'concepts')), false);
});

test('I16/I17 tool auth: a wrong or missing token is refused like get_performance; no taskId 400, unknown session 404', async () => {
  const s = await session();
  const wrong = await save(s.sid, body(), 'nope');
  const performance = await tool('performance', s.sid, {}, 'nope');
  assert.equal(wrong.status, performance.status);
  assert.equal(wrong.status, 401);
  assert.equal((await t.api(`/api/studio-session/imported-concept?taskId=${s.sid}`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await t.api('/api/studio-session/imported-concept', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}` } })).status, 400);
  assert.equal((await save('no-such-session', body())).status, 404);
});

test('I18 an ended session is 409 and writes nothing', async () => {
  const s = await session();
  terminal.live.delete(s.sid);
  assert.equal((await save(s.sid, body())).status, 409);
  assert.equal(await rows(s.b, 'concepts'), 0);
});

test('I19 a writing session cannot save', async () => {
  const { b } = await session();
  const c = (await t.send('POST', t.c(b, '/concepts'), { title: 'N', posts: [] })).body;
  const started = await t.send('POST', t.c(b, `/concepts/${c.id}/assets/${assetId(c, 'script')}/session`));
  assert.equal((await save(started.body.session.id, body())).status, 404);
});

test('I20 a Building that turns read-only mid-session refuses the save', async () => {
  const s = await session();
  await t.projectsDb.update(s.b, { readOnlyReason: 'Frozen for the test' });
  const res = await save(s.sid, body());
  await t.projectsDb.update(s.b, { readOnlyReason: undefined });
  assert.equal(res.status, 409);
  assert.equal(await rows(s.b, 'concepts'), 0);
});

test('I21 a non-object body is 400; a refused field leaves the session usable', async () => {
  const s = await session();
  assert.equal((await save(s.sid, [1])).status, 400);
  assert.deepEqual((await save(s.sid, body({ title: '' }))).body.field, 'title');
  assert.equal((await save(s.sid, body())).status, 201);
});

test('I22 two saves at once both land, in order, through the write queue', async () => {
  const s = await session();
  const [a, b] = await Promise.all([save(s.sid, body({ title: 'A' })), save(s.sid, body({ title: 'B' }))]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  const seqs = (await ctxOf(s.b)).db.prepare('SELECT seq FROM concepts ORDER BY seq').all() as { seq: number }[];
  assert.deepEqual(seqs.map((r) => r.seq), [1, 2]);
});

test('I23 a start answers 201 and launches with the import tools, auto, without report hooks', async () => {
  const before = terminal.starts.length;
  const { b, sid } = await session();
  const start = terminal.starts[before]!;
  assert.equal(start.taskId, sid);
  assert.equal(start.autonomy, 'auto');
  assert.equal(start.reportHooks, false);
  assert.equal(start.resume, false);
  assert.equal(start.cwd, (await ctxOf(b)).dir);
  assert.deepEqual(start.mcpServers!.map((m) => [m.name, m.tools]), [['agent_visual_os_studio', ['save_imported_concept', 'get_reference_content']]]);
  assert.match(start.systemPrompt!, /import agent/);
  assert.match(start.prompt!, /Greet the owner/);
});

test('I24 a start while running is 409; two at once give one 201 and one launch', async () => {
  const s = await session();
  assert.equal((await t.send('POST', route(s.b))).status, 409);
  const b = await t.createStudio('Race');
  const before = terminal.starts.length;
  const answers = await Promise.all([t.send('POST', route(b)), t.send('POST', route(b))]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [201, 409]);
  assert.equal(terminal.starts.length, before + 1);
});

test('I25 with no default agent the start is 409, nothing is stored, and GET shows why', async () => {
  const b = await t.createStudio('NoAgent');
  defaultAgent = null;
  const res = await t.send('POST', route(b));
  assert.equal(res.status, 409);
  const view = (await t.api(route(b))).body;
  assert.equal(view.session, null);
  assert.match(view.blockedReason, /No default coding agent/);
  defaultAgent = 'test-claude-cli';
  assert.equal((await t.send('POST', route(b))).status, 201);
  assert.equal((await t.api(route(b))).body.blockedReason, null);
});

test('I26 a read-only Building refuses every POST and still reads', async () => {
  const s = await session();
  await t.projectsDb.update(s.b, { readOnlyReason: 'Frozen for the test' });
  for (const suffix of ['', '/resume', '/new', '/end']) assert.equal((await t.send('POST', route(s.b, suffix))).status, 409, suffix);
  assert.equal((await t.api(route(s.b))).status, 200);
  await t.projectsDb.update(s.b, { readOnlyReason: undefined });
});

test('I27 resume relaunches the same conversation; running starts nothing; a lost conversation restarts fresh; no session is 404', async () => {
  const b = await t.createStudio('Resume');
  assert.equal((await t.send('POST', route(b, '/resume'))).status, 404);
  const sid = (await t.send('POST', route(b))).body.session.id;
  const count = terminal.starts.length;
  assert.equal((await t.send('POST', route(b, '/resume'))).status, 200);
  assert.equal(terminal.starts.length, count, 'running starts nothing');
  const first = terminal.starts.at(-1)!;
  await first.onExit(0, undefined, first.sessionId ?? undefined);
  await new Promise((r) => setTimeout(r, 10));
  const resumed = await t.send('POST', route(b, '/resume'));
  assert.equal(resumed.body.session.state, 'running');
  const again = terminal.starts.at(-1)!;
  assert.deepEqual([again.taskId, again.resume, again.sessionId, again.prompt], [sid, true, first.sessionId, '']);
  await again.onExit(0, undefined, again.sessionId ?? undefined);
  await new Promise((r) => setTimeout(r, 10));
  terminal.host.sessionExists = () => false;
  await t.send('POST', route(b, '/resume'));
  delete terminal.host.sessionExists;
  const fresh = terminal.starts.at(-1)!;
  assert.equal(fresh.resume, false);
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.match(fresh.prompt!, /Greet the owner/);
});

test('I28 /new after an ended session gives a new record and an empty list; while running it is 409', async () => {
  const s = await session();
  assert.equal((await save(s.sid, body())).status, 201);
  assert.equal((await t.send('POST', route(s.b, '/new'))).status, 409);
  await t.send('POST', route(s.b, '/end'));
  terminal.live.delete(s.sid);
  assert.equal((await t.send('POST', route(s.b))).status, 409, 'an ended session is resumed or replaced, not started');
  const next = await t.send('POST', route(s.b, '/new'));
  assert.equal(next.status, 201);
  assert.notEqual(next.body.session.id, s.sid);
  assert.deepEqual(next.body.saved, []);
  assert.equal((await t.api(t.c(s.b, '/concepts'))).body.total, 1, 'the earlier Concept stays');
});

test('I29 /end stops the terminal and keeps saved Concepts; with nothing running it answers the view unchanged', async () => {
  const s = await session();
  await save(s.sid, body());
  const ended = await t.send('POST', route(s.b, '/end'));
  assert.equal(ended.status, 200);
  assert.ok(terminal.stops.includes(s.sid));
  assert.equal(ended.body.session.state, 'ended');
  assert.equal(ended.body.saved.length, 1);
  const stops = terminal.stops.length;
  assert.equal((await t.send('POST', route(s.b, '/end'))).body.session.state, 'ended');
  assert.equal(terminal.stops.length, stops);
  const none = await t.createStudio('None');
  assert.equal((await t.send('POST', route(none, '/end'))).body.session, null);
});

test('I30 a terminal exit marks the session ended and emits the event', async () => {
  const s = await session();
  const start = terminal.starts.at(-1)!;
  events.length = 0;
  await start.onExit(0, undefined, 'conv-2');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await t.api(route(s.b))).body.session.state, 'ended');
  assert.ok(events.some((e) => e.type === 'contentImportSession' && e.view.session?.state === 'ended'));
});

test('I31 GET lists only this session\'s Concepts with chips and stats; a deleted one disappears', async () => {
  const s = await session();
  const normal = (await t.send('POST', t.c(s.b, '/concepts'), { title: 'Normal', posts: [] })).body;
  const a = (await save(s.sid, body({ title: 'A', posts: [post({ stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 3 } }] })] }))).body;
  await save(s.sid, body({ title: 'B' }));
  const view = (await t.api(route(s.b))).body;
  assert.deepEqual(view.saved.map((c: any) => c.title), ['A', 'B']);
  assert.ok(!view.saved.some((c: any) => c.id === normal.id));
  assert.equal(view.saved[0].posts[0].stats.latest.counts.likes, 3);
  assert.equal((await t.send('DELETE', t.c(s.b, `/concepts/${a.conceptId}`))).status, 204);
  assert.deepEqual((await t.api(route(s.b))).body.saved.map((c: any) => c.title), ['B']);
});

test('I32 after a restart the session reads ended and the saved list stays', async () => {
  const s = await session();
  await save(s.sid, body());
  terminal.live.delete(s.sid);
  await service.markInterruptedEnded();
  const view = (await t.api(route(s.b))).body;
  assert.deepEqual([view.session.state, view.saved.length], ['ended', 1]);
});

test('I33 removing a Building stops its session and record; another Building is untouched', async () => {
  const a = await session('A'), b = await session('B');
  await service.removeForBuilding(a.b);
  assert.ok(terminal.stops.includes(a.sid));
  assert.equal(await service.exists(a.sid), false);
  assert.equal(await service.exists(b.sid), true);
  assert.equal(terminal.live.has(b.sid), true);
  assert.equal((await save(b.sid, body())).status, 201);
});

test('I34 a terminal attach for an import session id is not taken for a Task', async () => {
  const { sid } = await session();
  assert.equal(await service.exists(sid), true);
  assert.equal(await service.exists('not-a-session'), false);
});

test('I35 the event fires on start, save and end with the buildingId', async () => {
  const b = await t.createStudio('Events');
  events.length = 0;
  const { body: view } = await t.send('POST', route(b));
  await save(view.session.id, body());
  await t.send('POST', route(b, '/end'));
  const mine = events.filter((e) => e.type === 'contentImportSession' && e.buildingId === b) as Extract<StudioEvent, { type: 'contentImportSession' }>[];
  assert.ok(mine.length >= 3);
  assert.deepEqual(mine.map((e) => e.view.saved.length), [0, 1, 1]);
  assert.ok(mine[0]!.view.rev < mine[2]!.view.rev);
});

test('I36 no conversation id, hook token, env value or folder path in the view or the event', async () => {
  const s = await saved(body({ script: 'Hook' }));
  const ctx = await ctxOf(s.b);
  const start = terminal.starts.find((x) => x.taskId === s.sid)!;
  const event = events.find((e) => e.type === 'contentImportSession');
  const text = JSON.stringify([(await t.api(route(s.b))).body, event]);
  const secrets = [start.sessionId!, token, ctx.dir, ...Object.values(start.env ?? {}).filter((v) => v.length > 3)];
  for (const value of secrets) assert.ok(!text.includes(value), `leaked ${value}`);
});

test('I37 a non-Content Building is 404', async () => {
  const res = await t.send('POST', '/api/projects', { typeId: 'crm', name: 'People' });
  assert.equal(res.status, 201, res.text);
  assert.equal((await t.api(route(res.body.id))).status, 404);
});

test('I38 an import starts no session and no retro', async () => {
  const before = terminal.starts.length;
  const s = await saved(body({ script: 'Hook', posts: [post({ format: 'video' })] }));
  await settle();
  assert.equal(terminal.starts.length, before + 1, 'only the import session itself');
  assert.equal(retroCalls.length, 0);
  assert.equal(await rows(s.b, 'retros'), 0);
  assert.equal(await rows(s.b, 'studio_drafts'), 0);
});

test('I39/I40 every change to the content is 409 with the exact message and changes nothing', async () => {
  const { b, c } = await saved(body({ script: 'Hook' }));
  const script = assetId(c, 'script'), text = assetId(c, 'post-text'), pid = c.posts[0].id;
  const asset = (id: string, s: string) => t.c(b, `/concepts/${c.id}/assets/${id}/${s}`);
  const calls: Array<[string, unknown?]> = [
    [asset(script, 'session')], [asset(script, 'session/new-round')], [asset(script, 'session/resume')], [asset(script, 'finalize')], [asset(script, 'reopen')], [asset(text, 'reopen')],
    [asset(script, 'session/comment'), { line: 1, lineText: 'Hook', comment: 'x' }], [t.c(b, `/assets/${script}/retro`)],
    [t.c(b, `/concepts/${c.id}/posts`), { platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }],
    [t.c(b, `/concepts/${c.id}/posts/${pid}/finalize`)], [t.c(b, `/concepts/${c.id}/posts/${pid}/unfinalize`)],
  ];
  const refused = 'Imported content is read-only; delete and import again';
  for (const [url, payload] of calls) {
    const res = await t.send('POST', url, payload);
    assert.deepEqual([res.status, res.body.error], [409, refused], url);
  }
  const media = t.c(b, `/concepts/${c.id}/media`), item = `${media}/00000000-0000-4000-8000-000000000000`;
  const upload = await t.api(`${media}?name=a.png`, { method: 'POST', body: 'bytes', headers: { 'content-type': 'application/octet-stream' } });
  assert.deepEqual([upload.status, upload.body.error], [409, refused], 'media upload');
  for (const [method, payload] of [['PATCH', { name: 'b.png' }], ['DELETE', undefined]] as const) {
    const res = await t.send(method, item, payload);
    assert.deepEqual([res.status, res.body.error], [409, refused], `media ${method}`);
  }
  assert.deepEqual((await t.api(t.c(b, `/concepts/${c.id}`))).body.assets, c.assets);
});

test('I41 edit publish details works; a time past a snapshot is still 400', async () => {
  const { b, c } = await saved(body({ posts: [post({ stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 1 } }] })] }));
  const url = t.c(b, `/concepts/${c.id}/posts/${c.posts[0].id}/publish`);
  const edited = await t.send('PATCH', url, { liveUrl: 'https://example.com/x', publishedAt: '2026-10-01T10:00:00Z' });
  assert.deepEqual([edited.status, edited.body.liveUrl], [200, 'https://example.com/x']);
  assert.equal((await t.send('PATCH', url, { publishedAt: '2026-10-03T10:00:00Z' })).status, 400);
});

test('I42 unpublish then publish again keeps the stats and the owner note', async () => {
  const { b, c } = await saved(body({ posts: [post({ note: 'Mine', stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 1 } }] })] }));
  const base = t.c(b, `/concepts/${c.id}/posts/${c.posts[0].id}`);
  assert.equal((await t.send('POST', `${base}/unpublish`)).body.status, 'finalized');
  const again = await t.send('POST', `${base}/publish`, { publishedAt: PUBLISHED });
  assert.deepEqual([again.status, again.body.status, again.body.stats.count, again.body.note], [200, 'published', 1, 'Mine']);
});

test('I43 add, patch and delete stats', async () => {
  const { b, c } = await saved();
  const url = t.c(b, `/concepts/${c.id}/posts/${c.posts[0].id}/stats`);
  const added = await t.send('POST', url, { capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 1 } });
  assert.equal(added.status, 201);
  assert.equal((await t.send('PATCH', `${url}/${added.body.id}`, { counts: { likes: 2 } })).body.counts.likes, 2);
  assert.equal((await t.send('DELETE', `${url}/${added.body.id}`)).status, 204);
});

test('I44 title, brief, archive and the post date stay open', async () => {
  const { b, c } = await saved();
  const url = t.c(b, `/concepts/${c.id}`);
  assert.equal((await t.send('PATCH', url, { title: 'New', brief: 'Newer' })).body.title, 'New');
  assert.equal((await t.send('PATCH', url, { archived: true })).body.archived, true);
  assert.equal((await t.send('PATCH', `${url}/posts/${c.posts[0].id}`, { scheduledAt: '2026-09-01T09:00:00Z' })).body.scheduledAt, '2026-09-01T09:00:00.000Z');
});

test('I45 a post goes after unpublishing; the last post can go', async () => {
  const { b, c } = await saved();
  const base = t.c(b, `/concepts/${c.id}/posts/${c.posts[0].id}`);
  assert.equal((await t.send('DELETE', base)).status, 409);
  await t.send('POST', `${base}/unpublish`);
  assert.equal((await t.send('DELETE', base)).status, 204);
  assert.deepEqual((await t.api(t.c(b, `/concepts/${c.id}`))).body.posts, []);
});

test('I46 deleting a Concept removes the folder, script.md and every row; read-only refuses', async () => {
  learnAnswer = async () => answer();
  const { b, c, cid } = await saved(body({ script: 'Hook' }));
  await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
  await settle();
  const ctx = await ctxOf(b);
  assert.equal(await rows(b, 'style_proposals'), 1);
  await t.projectsDb.update(b, { readOnlyReason: 'Frozen for the test' });
  assert.equal((await t.send('DELETE', t.c(b, `/concepts/${cid}`))).status, 409);
  await t.projectsDb.update(b, { readOnlyReason: undefined });
  assert.equal((await t.send('DELETE', t.c(b, `/concepts/${cid}`))).status, 204);
  assert.equal(await exists(mod.conceptDir(ctx, c.id)), false);
  for (const table of ['concepts', 'posts', 'assets', 'retros', 'style_proposals']) assert.equal(await rows(b, table), 0, table);
});

test('I47 reading a session of an imported asset starts nothing', async () => {
  const { b, c } = await saved(body({ script: 'Hook' }));
  const count = terminal.starts.length;
  const res = await t.api(t.c(b, `/concepts/${c.id}/assets/${assetId(c, 'script')}/session`));
  assert.deepEqual([res.status, res.body.session], [200, null]);
  assert.equal(terminal.starts.length, count);
});

test('I48 post media answers as a post with no media does', async () => {
  const { b, c } = await saved(body({ posts: [{ platform: 'instagram', format: 'reel', publishedAt: PUBLISHED }] }));
  const res = await t.api(t.c(b, `/concepts/${c.id}/posts/${c.posts[0].id}/media`));
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.text, res.body.images, res.body.video, res.body.thumbnail], [null, null, null, null]);
});

/** A normal post published with stats, and with none. */
async function normalPost(b: string, title: string, counts: object | null): Promise<void> {
  const c = (await t.send('POST', t.c(b, '/concepts'), { title, posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-10-05T09:00:00Z' }] })).body;
  const ctx = await ctxOf(b);
  mod.setAssetState(ctx, assetId(c, 'post-text'), 'finalized', 'Normal text');
  const base = t.c(b, `/concepts/${c.id}/posts/${c.posts[0].id}`);
  await t.send('POST', `${base}/finalize`);
  await t.send('POST', `${base}/publish`, { publishedAt: '2026-10-05T09:00:00Z' });
  if (counts) await t.send('POST', `${base}/stats`, { capturedAt: '2026-10-06T09:00:00Z', counts });
}
const refreshData = async (b: string) => {
  const res = await t.send('POST', t.c(b, '/insights/refresh'));
  assert.equal(res.status, 202, res.text);
  for (let i = 0; i < 50 && !dataSeen.length; i++) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 50 && insights.view(await ctxOf(b)).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  return dataSeen.at(-1);
};

test('I49/I50 imported posts reach the Insights data with or without stats; get_performance keeps only those with stats', async () => {
  const s = await session();
  await save(s.sid, body({ title: 'WithStats', posts: [post({ stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 1 } }] })] }));
  await save(s.sid, body({ title: 'NoStats' }));
  await normalPost(s.b, 'NormalStats', { likes: 2 });
  await normalPost(s.b, 'NormalNone', null);
  const data = await refreshData(s.b);
  const posts = Object.fromEntries(data.posts.map((p: any) => [p.conceptTitle, p]));
  assert.deepEqual(Object.keys(posts).sort(), ['NoStats', 'NormalStats', 'WithStats']);
  assert.deepEqual([posts.WithStats.imported, posts.NoStats.imported, posts.NormalStats.imported, posts.NoStats.stats], [true, true, false, null]);
  assert.equal(posts.NoStats.text, 'We stopped standups.');
  const c = (await t.send('POST', t.c(s.b, '/concepts'), { title: 'N', posts: [] })).body;
  const writing = await t.send('POST', t.c(s.b, `/concepts/${c.id}/assets/${assetId(c, 'script')}/session`));
  const performance = (await tool('performance', writing.body.session.id)).body.posts;
  assert.deepEqual(performance.map((p: any) => [p.conceptTitle, p.imported]).sort(), [['NormalStats', false], ['WithStats', true]]);
});

test('I51 a refresh with only imported posts without stats runs', async () => {
  const s = await saved();
  const data = await refreshData(s.b);
  assert.equal(data.posts.length, 1);
});

test('I52 a burst of saves gives one debounced run; none on a read-only Building', async () => {
  const s = await session();
  await save(s.sid, body());
  await save(s.sid, body());
  await save(s.sid, body());
  const live = timers.filter((x) => !x.cancelled);
  assert.equal(timers.length, 3);
  assert.equal(live.length, 1);
  await t.projectsDb.update(s.b, { readOnlyReason: 'Frozen for the test' });
  live[0]!.fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dataSeen.length, 0);
  await t.projectsDb.update(s.b, { readOnlyReason: undefined });
});

test('I53 the 200-post cap keeps the newest across both kinds', async () => {
  const s = await session();
  const posts = (day: number) => Array.from({ length: 20 }, (_, i) => post({ publishedAt: `2026-09-${String(day).padStart(2, '0')}T${String(i).padStart(2, '0')}:00:00Z` }));
  for (let day = 1; day <= 11; day++) assert.equal((await save(s.sid, body({ title: `Day ${day}`, posts: posts(day) }))).status, 201);
  await normalPost(s.b, 'Newest normal', { likes: 1 });
  const data = await refreshData(s.b);
  assert.equal(data.posts.length, 200);
  assert.equal(data.posts[0].conceptTitle, 'Newest normal');
  assert.ok(!data.posts.some((p: any) => p.conceptTitle === 'Day 1'));
  assert.equal(data.posts.at(-1).conceptTitle, 'Day 2');
});

test('U34-U38 the section: at most 10 newest, 200-character excerpts, the script as fallback, matching platforms, and (none yet)', async () => {
  const empty = await session();
  const none = mod.referenceSection(await ctxOf(empty.b), ['linkedin']);
  assert.match(none, /^## Reference content/);
  assert.match(none, /earlier work from outside this system/);
  assert.match(none, /voice, structure, hooks and length before you write, and never copy them/);
  assert.match(none, /`get_reference_content`/);
  assert.match(none, /\(none yet\)/);
  const s = await session();
  for (let i = 1; i <= 11; i++) await save(s.sid, body({ title: `Concept ${i}`, posts: [post({ publishedAt: `2026-09-${String(i).padStart(2, '0')}T09:00:00Z`, text: '😀'.repeat(250) })] }));
  await save(s.sid, body({ title: 'On X', script: 'Script words', posts: [{ platform: 'x', format: 'text', publishedAt: '2026-09-20T09:00:00Z' }] }));
  const ctx = await ctxOf(s.b);
  const linkedin = mod.referenceSection(ctx, ['linkedin']);
  assert.ok(linkedin.includes('Concept 11 (LinkedIn text, published 2026-09-11)'));
  assert.ok(linkedin.includes('Concept 2 '));
  assert.ok(!linkedin.includes('Concept 1 '), 'the 11th is dropped');
  assert.ok(!linkedin.includes('On X'));
  assert.equal((linkedin.split('\n').at(-1)!.match(/😀/g) ?? []).length, 200);
  const x = mod.referenceSection(ctx, ['x']);
  assert.match(x, /On X \(X \(Twitter\) text, published 2026-09-20\): Script words/);
  assert.ok(mod.referenceSection(ctx, []).includes('On X'), 'no platforms matches all');
});

test('I54 a script session lists imported Concepts; a post session lists only its platform', async () => {
  const s = await session();
  await save(s.sid, body({ title: 'On LinkedIn' }));
  await save(s.sid, body({ title: 'On Blog', posts: [{ platform: 'blog', format: 'article', text: blogText, publishedAt: PUBLISHED }] }));
  const c = (await t.send('POST', t.c(s.b, '/concepts'), { title: 'New', posts: [{ platform: 'linkedin', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] })).body;
  await t.send('POST', t.c(s.b, `/concepts/${c.id}/assets/${assetId(c, 'post-text')}/session`));
  const postPrompt = terminal.starts.at(-1)!.systemPrompt!;
  assert.match(postPrompt, /## Reference content/);
  assert.ok(postPrompt.includes('On LinkedIn') && !postPrompt.includes('On Blog'));
  await t.send('POST', t.c(s.b, `/concepts/${c.id}/assets/${assetId(c, 'script')}/session`));
  assert.ok(terminal.starts.at(-1)!.systemPrompt!.includes('On LinkedIn'));
});

test('I55 Concepts with only unpublished posts are left out; archived ones stay', async () => {
  const s = await session();
  const hidden = (await save(s.sid, body({ title: 'Hidden' }))).body;
  const archived = (await save(s.sid, body({ title: 'Archived' }))).body;
  await t.send('POST', t.c(s.b, `/concepts/${hidden.conceptId}/posts/${hidden.posts[0].postId}/unpublish`));
  await t.send('PATCH', t.c(s.b, `/concepts/${archived.conceptId}`), { archived: true });
  assert.deepEqual((await reference(s.sid)).body.concepts.map((c: any) => c.title), ['Archived']);
  assert.ok(!mod.referenceSection(await ctxOf(s.b), []).includes('Hidden'));
});

test('I56/I59 the tool answers everything, newest first; normal Concepts are out; no stats is null', async () => {
  const s = await session();
  const long = 'y'.repeat(1500);
  await save(s.sid, body({ title: 'Older', brief: 'B', script: 'Hook', posts: [post({ text: long, liveUrl: 'https://example.com/o', externalAssets: 'Drive', stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 4 } }] })] }));
  await save(s.sid, body({ title: 'Newer', posts: [post({ publishedAt: '2026-10-10T09:00:00Z' })] }));
  await normalPost(s.b, 'Normal', { likes: 9 });
  const res = await reference(s.sid);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.concepts.map((c: any) => c.title), ['Newer', 'Older']);
  const [newer, older] = res.body.concepts;
  assert.deepEqual([older.brief, older.script, older.posts[0].text, older.posts[0].liveUrl, older.posts[0].publishedAt, older.posts[0].externalAssets, older.posts[0].stats.counts.likes], ['B', 'Hook', long, 'https://example.com/o', PUBLISHED, 'Drive', 4]);
  assert.ok(older.posts[0].results.overall);
  assert.deepEqual([newer.script, newer.posts[0].stats], [null, null]);
});

test('I57 platform, format and both filter; a mismatch is an empty 200; only matching posts are listed', async () => {
  const s = await session();
  await save(s.sid, body({ posts: [post(), { platform: 'x', format: 'text', text: 'Tweet', publishedAt: PUBLISHED }] }));
  const posts = async (q: string) => (await reference(s.sid, q)).body.concepts.flatMap((c: any) => c.posts.map((p: any) => p.platform));
  assert.deepEqual((await posts('')).sort(), ['linkedin', 'x']);
  assert.deepEqual(await posts('?platform=x'), ['x']);
  assert.deepEqual((await posts('?format=text')).sort(), ['linkedin', 'x']);
  assert.deepEqual(await posts('?platform=linkedin&format=text'), ['linkedin']);
  const none = await reference(s.sid, '?platform=x&format=article');
  assert.deepEqual([none.status, none.body.concepts], [200, []]);
});

test('I58 default 10; 50 of 51; 51 and 0 are 400 on limit', async () => {
  const s = await session();
  await Promise.all(Array.from({ length: 51 }, (_, i) => save(s.sid, body({ title: `C${i}` }))));
  assert.equal((await reference(s.sid)).body.concepts.length, 10);
  assert.equal((await reference(s.sid, '?limit=50')).body.concepts.length, 50);
  for (const limit of ['51', '0']) {
    const res = await reference(s.sid, `?limit=${limit}`);
    assert.deepEqual([res.status, res.body.field], [400, 'limit'], limit);
  }
});

test('I60 refused like get_performance: token, taskId, unknown, ended; a finalized asset\'s live session and the import session may read', async () => {
  const s = await session();
  assert.equal((await reference(s.sid)).status, 200);
  assert.equal((await tool('reference-content', s.sid, {}, 'nope')).status, 401);
  assert.equal((await t.api('/api/studio-session/reference-content', { headers: { authorization: `Bearer ${token}` } })).status, 400);
  assert.equal((await reference('no-such-session')).status, 404);
  const c = (await t.send('POST', t.c(s.b, '/concepts'), { title: 'N', posts: [] })).body;
  const script = assetId(c, 'script');
  const writing = (await t.send('POST', t.c(s.b, `/concepts/${c.id}/assets/${script}/session`))).body.session.id;
  mod.setAssetState(await ctxOf(s.b), script, 'finalized', 'Done');
  assert.equal((await reference(writing)).status, 200);
  terminal.live.delete(writing);
  assert.equal((await reference(writing)).status, 409);
  terminal.live.delete(s.sid);
  assert.equal((await reference(s.sid)).status, 409);
});

test('I62 the tool answer holds no folder or script path', async () => {
  const s = await saved(body({ script: 'Hook' }));
  const ctx = await ctxOf(s.b);
  const text = (await reference(s.sid)).text;
  for (const value of [ctx.dir, mod.scriptFile(ctx, s.cid), 'script.md']) assert.ok(!text.includes(value), value);
});

test('I63/I64 Learn answers 202, runs with no drafts, and leaves a pending proposal with source kind imported; the style file stays', async () => {
  const { b, cid } = await saved(body({ script: 'Hook line', posts: [post(), { platform: 'x', format: 'text', text: 'Tweet words', publishedAt: PUBLISHED }] }));
  await t.send('PUT', t.c(b, '/writing-style'), { content: STYLE, version: (await t.api(t.c(b, '/writing-style'))).body.version });
  const res = await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
  assert.deepEqual([res.status, res.body], [202, { status: 'running' }]);
  await settle();
  assert.equal(retroCalls.length, 1);
  for (const text of ['Past', 'Hook line', 'We stopped standups.', 'Tweet words']) assert.ok(retroCalls[0]!.prompt.includes(text), text);
  const proposals = (await t.api(t.c(b, '/style-proposals'))).body.proposals;
  assert.equal(proposals.length, 1);
  assert.deepEqual([proposals[0].source.kind, proposals[0].source.conceptId, proposals[0].draftCount, proposals[0].summary], ['imported', cid, 0, 'Sounds like the owner']);
  assert.equal((await t.api(t.c(b, '/writing-style'))).body.content, STYLE);
});

test('I65 Learn refuses a normal Concept, an unknown one, a bad id and a read-only Building', async () => {
  const { b, cid } = await saved();
  const normal = (await t.send('POST', t.c(b, '/concepts'), { title: 'N', posts: [] })).body;
  assert.equal((await t.send('POST', t.c(b, `/concepts/${normal.id}/learn`))).status, 409);
  assert.equal((await t.send('POST', t.c(b, '/concepts/00000000-0000-4000-8000-000000000000/learn'))).status, 404);
  assert.equal((await t.send('POST', t.c(b, '/concepts/nope/learn'))).status, 404);
  await t.projectsDb.update(b, { readOnlyReason: 'Frozen for the test' });
  assert.equal((await t.send('POST', t.c(b, `/concepts/${cid}/learn`))).status, 409);
  await t.projectsDb.update(b, { readOnlyReason: undefined });
});

test('I66/I71 while one runs a second is 409, another Concept can run, and GET learn follows it', async () => {
  const s = await session();
  const a = (await save(s.sid, body({ title: 'A' }))).body.conceptId, other = (await save(s.sid, body({ title: 'B' }))).body.conceptId;
  assert.equal((await t.api(t.c(s.b, `/concepts/${a}/learn`))).text, 'null');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  learnAnswer = async () => { await gate; return answer(); };
  assert.equal((await t.send('POST', t.c(s.b, `/concepts/${a}/learn`))).status, 202);
  assert.equal((await t.api(t.c(s.b, `/concepts/${a}/learn`))).body.status, 'running');
  assert.equal((await t.send('POST', t.c(s.b, `/concepts/${a}/learn`))).status, 409);
  assert.equal((await t.send('POST', t.c(s.b, `/concepts/${other}/learn`))).status, 202);
  release();
  await settle();
  const last = (await t.api(t.c(s.b, `/concepts/${a}/learn`))).body;
  assert.equal(last.status, 'proposal');
  assert.equal(typeof last.proposalId, 'string');
  assert.equal((await t.api(t.c(s.b, '/concepts/00000000-0000-4000-8000-000000000000/learn'))).status, 404);
});

test('I67 a Concept with no text is 409', async () => {
  const { b, cid } = await saved(body({ posts: [{ platform: 'instagram', format: 'image', publishedAt: PUBLISHED }] }));
  const res = await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no script or post text/);
});

test('I68 an empty answer records nothing and a log entry', async () => {
  learnAnswer = async () => answer([]);
  const { b, cid } = await saved();
  await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
  await settle();
  assert.equal((await t.api(t.c(b, `/concepts/${cid}/learn`))).body.status, 'nothing');
  const log = (await t.api(t.c(b, '/retros'))).body.entries;
  assert.deepEqual(log.map((e: any) => [e.status, e.source.kind]), [['nothing', 'imported']]);
});

test('I69 an agent error, timeout, code fence or a find out of place records failed; a later run is allowed', async () => {
  const cases: Array<[() => Promise<string>, RegExp]> = [
    [async () => { throw new Error('boom sk-secret'); }, /boom/],
    [() => new Promise<string>(() => undefined), /did not answer/],
    [async () => `\`\`\`json\n${answer()}\n\`\`\``, /code fence/],
    [async () => answer([{ section: 'General', action: 'remove', find: 'Not in there', reason: 'x' }]), /must occur exactly once/],
  ];
  for (const [behave, reason] of cases) {
    const { b, cid } = await saved();
    learnAnswer = behave;
    await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
    await settle();
    const last = (await t.api(t.c(b, `/concepts/${cid}/learn`))).body;
    assert.equal(last.status, 'failed');
    assert.match(last.reason, reason);
    learnAnswer = async () => answer();
    assert.equal((await t.send('POST', t.c(b, `/concepts/${cid}/learn`))).status, 202);
    await settle();
  }
});

test('I70 auto-apply on writes the style and history; off leaves it pending; accept and discard work', async () => {
  const { b, cid } = await saved();
  await t.send('PUT', t.c(b, '/writing-style'), { content: STYLE, version: (await t.api(t.c(b, '/writing-style'))).body.version });
  await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
  await settle();
  const first = (await t.api(t.c(b, '/style-proposals'))).body.proposals[0];
  assert.equal((await t.send('POST', t.c(b, `/style-proposals/${first.id}/discard`))).status, 200);
  await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
  await settle();
  const second = (await t.api(t.c(b, '/style-proposals'))).body.proposals[0];
  assert.equal((await t.send('POST', t.c(b, `/style-proposals/${second.id}/accept`), {})).status, 200);
  assert.match((await t.api(t.c(b, '/writing-style'))).body.content, /Open with the result\./);
  await t.send('PUT', t.c(b, '/writing-style'), { content: STYLE, version: (await t.api(t.c(b, '/writing-style'))).body.version });
  await t.send('PATCH', t.c(b, '/settings'), { autoApplyRetro: true });
  await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
  await settle();
  assert.match((await t.api(t.c(b, '/writing-style'))).body.content, /Open with the result\./);
  assert.deepEqual((await t.api(t.c(b, '/style-proposals'))).body.proposals, []);
  assert.equal((await t.api(t.c(b, '/writing-style/history'))).body.entries[0].autoApplied, true);
});

test('I72 contentRetro fires at the end; a Concept deleted at the latch records nothing; normal retros report kind asset', async () => {
  const { b, cid } = await saved();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  learnAnswer = async () => { await gate; return answer(); };
  await t.send('POST', t.c(b, `/concepts/${cid}/learn`));
  events.length = 0;
  assert.equal((await t.send('DELETE', t.c(b, `/concepts/${cid}`))).status, 204);
  release();
  await settle();
  assert.ok(events.some((e) => e.type === 'contentRetro' && e.conceptId === cid));
  assert.equal(await rows(b, 'retros'), 0);
  const c = (await t.send('POST', t.c(b, '/concepts'), { title: 'N', posts: [] })).body;
  const script = assetId(c, 'script');
  await t.send('POST', t.c(b, `/concepts/${c.id}/assets/${script}/session`));
  const ctx = await ctxOf(b);
  ctx.db.prepare('INSERT INTO studio_drafts (assetId, round, text, savedAt) VALUES (?, 1, ?, 1)').run(script, 'Draft one');
  ctx.db.prepare('INSERT INTO studio_drafts (assetId, round, text, savedAt) VALUES (?, 1, ?, 2)').run(script, 'Draft two');
  mod.setAssetState(ctx, script, 'finalized', 'Final');
  learnAnswer = async () => answer([]);
  await t.send('POST', t.c(b, `/assets/${script}/retro`));
  await settle();
  assert.deepEqual((await t.api(t.c(b, '/retros'))).body.entries.map((e: any) => e.source.kind), ['asset']);
});
