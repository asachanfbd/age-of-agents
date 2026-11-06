import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { Insights } from '../src/content/insights.ts';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/**
 * Targets, post results, the Insights document and the get_performance tool end to end. The insights agent and the debounce
 * timer are fakes; the terminal host is fake and every file lives in a temp folder.
 */

type AgentInput = { buildingId: string; dataFile: string; instructions: string; signal: AbortSignal };
let t: ContentApi;
let insights: Insights;
let sessions: StudioSessions;
let terminal: ReturnType<typeof fakeTerminalHost>;
let home: string;
let token: string;
let behave: (input: AgentInput) => Promise<string>;
let calls: Array<AgentInput & { data: any }> = [];
let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
let mod: { contentCtx: typeof import('../src/content/runtime.ts').contentCtx; setAssetState: typeof import('../src/content/concepts.ts').setAssetState };

const ok = (markdown = '## Summary\n\nLinkedIn hooks work (3 posts, e.g. "Launch").') => JSON.stringify({ markdown });
const fakeAgent = {
  async run(input: AgentInput) {
    calls.push({ ...input, data: JSON.parse(await readFile(input.dataFile, 'utf8')) });
    return behave(input);
  },
};

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'insights-home-'));
  t = await startContentApi(async () => {
    const [ins, ses, runtime, concepts, hooks] = await Promise.all([
      import('../src/content/insights.ts'), import('../src/content/studioSessions.ts'), import('../src/content/runtime.ts'), import('../src/content/concepts.ts'), import('../src/terminal/projectCliHooks.ts'),
    ]);
    mod = { contentCtx: runtime.contentCtx, setAssetState: concepts.setAssetState };
    token = hooks.CLI_HOOK_TOKEN;
    insights = ins.createInsights({
      agent: fakeAgent, timeoutMs: 80,
      schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    });
    terminal = fakeTerminalHost();
    const { createRetros } = await import('../src/content/retros.ts');
    sessions = ses.createStudioSessions({ host: terminal.host, defaultAgentId: async () => 'test-claude-cli', home, retros: createRetros({ agent: { run: async () => '{"summary":"x","changes":[]}' }, home }) });
    return { insights, studioSessions: sessions };
  });
});
after(async () => { await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => { behave = async () => ok(); calls = []; timers = []; });

const HOUR = 3_600_000, DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(t.clock.now + offsetMs).toISOString();
const ctxOf = async (b: string) => mod.contentCtx((await t.projectsDb.get(b))!);
const settle = async () => { for (let i = 0; i < 40 && insights.view(await ctxOf(lastB)).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10)); await new Promise((r) => setTimeout(r, 10)); };
let lastB = '';

interface Fx { b: string; cid: string; pid: string; post: (s?: string) => string }
/** A Concept with one published post, published `ageDays` ago. */
async function published(b: string, opts: { platform?: string; format?: string; title?: string; ageDays?: number; counts?: object | null; text?: string; publishedAt?: string } = {}): Promise<Fx> {
  const { platform = 'linkedin', format = 'text', title = 'Launch', ageDays = 10, counts = { impressions: 2000, likes: 100, comments: 10 }, text = 'Hello world' } = opts;
  const c = (await t.send('POST', t.c(b, '/concepts'), { title, brief: 'Why now', posts: [{ platform, format, scheduledAt: '2026-11-03T09:00:00Z' }] })).body;
  const ctx = await ctxOf(b);
  for (const a of c.posts[0].needs) mod.setAssetState(ctx, a.id, 'finalized', a.kind === 'post-text' || a.kind === 'article' ? text : null);
  const post = (s = '') => t.c(b, `/concepts/${c.id}/posts/${c.posts[0].id}${s}`);
  assert.equal((await t.send('POST', post('/finalize'))).status, 200);
  assert.equal((await t.send('POST', post('/publish'), { publishedAt: opts.publishedAt ?? iso(-ageDays * DAY) })).status, 200);
  if (counts) assert.equal((await t.send('POST', post('/stats'), { capturedAt: iso(-HOUR), counts })).status, 201);
  return { b, cid: c.id, pid: c.posts[0].id, post };
}
async function studio(): Promise<string> { lastB = await t.createStudio('Acme', 'Asia/Kolkata'); return lastB; }
const targetsOf = (b: string) => t.api(t.c(b, '/targets'));
const insightsOf = async (b: string) => (await t.api(t.c(b, '/insights'))).body;

test('I01-I05 targets: empty by default, saved per platform, validated with the field named, unknown platform 400, read-only 409', async () => {
  const b = await studio();
  const first = await targetsOf(b);
  assert.equal(first.body.evaluationDays, 7);
  assert.deepEqual(Object.keys(first.body.targets), ['linkedin', 'instagram', 'x', 'facebook', 'blog']);
  assert.ok(Object.values(first.body.targets.linkedin).every((v) => v === null));
  const put = await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 1000, engagementRate: 2.5 });
  assert.deepEqual([put.status, put.body.targets.views, put.body.targets.engagementRate], [200, 1000, 2.5]);
  assert.equal((await targetsOf(b)).body.targets.linkedin.views, 1000);
  assert.equal((await targetsOf(b)).body.targets.x.views, null, 'other platforms are untouched');
  const bad = await t.send('PUT', t.c(b, '/targets/linkedin'), { likes: 5, comments: -1 });
  assert.deepEqual([bad.status, bad.body.field], [400, 'comments']);
  assert.equal((await targetsOf(b)).body.targets.linkedin.likes, null, 'a refused body stores nothing');
  assert.equal((await t.send('PUT', t.c(b, '/targets/tiktok'), { likes: 1 })).status, 400);
  assert.equal((await t.send('PUT', t.c(b, '/targets/LinkedIn'), { likes: 1 })).status, 400);
  assert.equal((await t.send('PUT', '/api/projects/nope/content/targets/x', {})).status, 404);
  assert.equal((await t.send('PUT', t.c(b, '/targets/x'), [] as never)).status, 400);
  await t.projectsDb.update(b, { readOnlyReason: 'Frozen for the test' });
  assert.equal((await t.send('PUT', t.c(b, '/targets/linkedin'), { likes: 1 })).status, 409);
  assert.equal((await targetsOf(b)).status, 200);
  assert.equal((await t.send('POST', t.c(b, '/insights/refresh'))).status, 409);
  await t.projectsDb.update(b, { readOnlyReason: undefined });
});

test('I07/I08/I09 target history: newest first, who and old/new, no entry for a no-op, 50 kept', async () => {
  const b = await studio();
  await t.send('PUT', t.c(b, '/targets/x'), { likes: 5 });
  await t.send('PUT', t.c(b, '/targets/x'), { likes: 5 });
  await t.send('PUT', t.c(b, '/targets/x'), {});
  await t.send('PUT', t.c(b, '/targets/x'), { likes: 8, saves: 1 });
  const entries = (await t.api(t.c(b, '/targets/history'))).body.entries;
  assert.equal(entries.length, 2);
  assert.deepEqual([entries[0].who, entries[0].platform, entries[0].before.likes, entries[0].after.likes, entries[0].after.saves], ['person', 'x', 5, 8, 1]);
  for (let n = 0; n < 55; n++) await t.send('PUT', t.c(b, '/targets/blog'), { views: n + 1 });
  const capped = (await t.api(t.c(b, '/targets/history'))).body.entries;
  assert.equal(capped.length, 50);
  assert.equal(capped[0].after.views, 55);
});

test('I06/I10/I11/I12/I13 results are computed: a target edit and the window change a past post, unpublished posts have none', async () => {
  const b = await studio();
  const f = await published(b, { ageDays: 10 });
  const result = async () => (await t.api(t.c(b, `/concepts/${f.cid}`))).body.posts[0].result;
  assert.equal((await result()).overall, 'no-target');
  await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 2000, likes: 500 });
  const partly = await result();
  assert.deepEqual([partly.overall, partly.fields.map((x: any) => x.state), partly.engagementRate], ['partly', ['hit', 'missed'], 5.5]);
  await t.send('PUT', t.c(b, '/targets/linkedin'), { likes: null });
  assert.equal((await result()).overall, 'on-target', 'results follow the new targets');
  assert.equal((await t.send('PATCH', t.c(b, '/settings'), { evaluationDays: 30 })).body.evaluationDays, 30);
  const early = await result();
  assert.deepEqual([early.overall, early.progress.of], ['too-early', 30]);
  for (const bad of [0, 91, 7.5, '7', null, -1]) assert.deepEqual([(await t.send('PATCH', t.c(b, '/settings'), { evaluationDays: bad })).status], [400], String(bad));
  assert.equal((await t.api(t.c(b, '/settings'))).body.evaluationDays, 30);
  assert.equal((await t.send('PATCH', t.c(b, '/settings'), { evaluationDays: 1 })).body.evaluationDays, 1);
  assert.equal((await result()).overall, 'on-target');
  const draft = (await t.send('POST', t.c(b, '/concepts'), { title: 'Draft', posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] })).body;
  assert.equal(draft.posts[0].result, null);
  assert.equal((await t.send('PATCH', t.c(b, '/settings'), { evaluationDays: 7 })).status, 200);
});

test('I14/I15 the list filters by overall result and summarises every platform over all matches', async () => {
  const b = await studio();
  await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 1000 });
  const hit = await published(b, { title: 'Hit', counts: { impressions: 5000 } });
  await published(b, { title: 'Miss', counts: { impressions: 10 } });
  await published(b, { title: 'Fresh', ageDays: 1, counts: { impressions: 10 } });
  await published(b, { title: 'Instagram', platform: 'instagram', format: 'image', counts: { views: 10 } });
  const list = (q: string) => t.api(t.c(b, `/concepts?${q}`));
  const titles = async (q: string) => (await list(q)).body.rows.map((r: any) => r.title).sort();
  assert.deepEqual(await titles('result=on-target'), ['Hit']);
  assert.deepEqual(await titles('result=below-target'), ['Miss']);
  assert.deepEqual(await titles('result=too-early'), ['Fresh']);
  assert.deepEqual(await titles('result=no-target'), ['Instagram']);
  assert.deepEqual(await titles('result=partly'), []);
  assert.deepEqual(await titles('result=on-target&platform=linkedin&status=published&sort=views'), ['Hit']);
  assert.deepEqual([(await list('result=good')).status, (await list('result=good')).body.field], [400, 'result']);
  const paged = (await list('limit=1&result=below-target')).body;
  assert.deepEqual(paged.summary.find((s: any) => s.platform === 'linkedin'), { platform: 'linkedin', judged: 2, onTarget: 1, tooEarly: 1, noTarget: 0 });
  assert.equal(paged.rows.length, 1);
  assert.equal(hit.b, b);
});

test('I16/I17/I18 a stats burst gives one debounced run, a target change refreshes at once, and refresh is 409 while running', async () => {
  const b = await studio();
  const f = await published(b);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 10 * 60_000);
  const stat = (await t.api(f.post('/stats'))).body.snapshots[0];
  await t.send('PATCH', f.post(`/stats/${stat.id}`), { counts: { likes: 101 } });
  await t.send('POST', f.post('/stats'), { capturedAt: iso(-HOUR / 2), counts: { likes: 102 } });
  assert.equal(timers.filter((x) => !x.cancelled).length, 1, 'only the last event keeps its timer');
  assert.equal((await insightsOf(b)).nextRefreshAt !== null, true);
  assert.equal(calls.length, 0);
  timers.find((x) => !x.cancelled)!.fn();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal((await insightsOf(b)).state, 'ready');
  await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 100 });
  await settle();
  assert.equal(calls.length, 2, 'a target change refreshes at once');
  let release: (() => void) | undefined;
  behave = () => new Promise<string>((resolve) => { release = () => resolve(ok('## Summary\n\nSecond')); });
  assert.equal((await t.send('POST', t.c(b, '/insights/refresh'))).status, 202);
  while (!release) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await insightsOf(b)).state, 'running');
  assert.equal((await t.send('POST', t.c(b, '/insights/refresh'))).status, 409);
  await t.send('POST', f.post('/stats'), { capturedAt: iso(-HOUR / 4), counts: { likes: 103 } });
  behave = async () => ok('## Summary\n\nThird');
  release!();
  await settle();
  await settle();
  assert.equal(calls.length, 4, 'a stats change during a run gives exactly one follow-up');
  assert.match((await insightsOf(b)).markdown, /Third/);
  await t.send('DELETE', f.post(`/stats/${stat.id}`));
  assert.ok(timers.some((x) => !x.cancelled), 'a delete also arms the timer');
});

test('I19/I20 nothing refreshes on a read-only Building and there is nothing to learn without stats', async () => {
  const b = await studio();
  const none = await t.send('POST', t.c(b, '/insights/refresh'));
  assert.equal(none.status, 409);
  assert.match(none.body.error, /nothing to learn/);
  assert.equal((await insightsOf(b)).state, 'never-run');
  await published(b);
  await t.projectsDb.update(b, { readOnlyReason: 'Frozen for the test' });
  timers[0]!.fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0, 'a due timer does nothing');
  assert.equal((await t.api(t.c(b, '/insights'))).status, 200, 'readable while read-only');
  await t.projectsDb.update(b, { readOnlyReason: undefined });
});

test('I21/I28/I29/I39 success writes insights.md with the notes on top; the data file carries posts, targets, previous text and notes; it is removed after', async () => {
  const b = await studio();
  await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 1000 });
  await settle().catch(() => undefined);
  const f = await published(b, { text: 'x'.repeat(1200) });
  const script = (await t.api(t.c(b, `/concepts/${f.cid}`))).body.assets.find((a: any) => a.kind === 'script');
  mod.setAssetState(await ctxOf(b), script.id, 'finalized', 'Line 1\nLine 2\nLine 3\nLine 4');
  const notes = await t.send('PUT', t.c(b, '/insights/notes'), { content: 'Never mention prices.', version: (await insightsOf(b)).notesVersion });
  assert.equal(notes.status, 200);
  calls = [];
  assert.equal((await t.send('POST', t.c(b, '/insights/refresh'))).status, 202);
  await settle();
  const call = calls[0]!;
  const post = call.data.posts[0];
  assert.deepEqual([call.data.posts.length, post.conceptTitle, post.conceptBrief, post.platform, post.format], [1, 'Launch', 'Why now', 'linkedin', 'text']);
  assert.deepEqual([post.text.length, post.textLength, post.hook, post.results.overall, post.stats.counts.impressions], [1000, 1200, 'Line 1\nLine 2\nLine 3', 'on-target', 2000]);
  assert.ok(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].includes(post.publishedWeekday));
  assert.equal(call.data.targets.linkedin.views, 1000);
  assert.deepEqual([call.data.previousInsights, call.data.ownerNotes, call.data.timeZone], [null, 'Never mention prices.', 'Asia/Kolkata']);
  assert.equal(JSON.stringify(call.data).includes(t.dataDir), false, 'no absolute path');
  assert.match(call.instructions, /Not enough data yet/);
  await access(call.dataFile).then(() => assert.fail('the data file should be gone'), () => undefined);
  const file = await readFile(path.join(t.dataDir, 'buildings', b, 'knowledge', 'insights.md'), 'utf8');
  assert.ok(file.indexOf('Never mention prices.') < file.indexOf('LinkedIn hooks work'));
  const view = await insightsOf(b);
  assert.deepEqual([view.state, view.postCount, view.markdown.startsWith('## Summary'), view.lastError], ['ready', 1, true, null]);
  await t.send('POST', t.c(b, '/insights/refresh')).then(() => settle());
  assert.equal(calls[1]!.data.previousInsights, view.markdown, 'the previous document goes into the next run');
});

test('I22/I23/I24/I25/I38 a bad, late or thrown answer keeps the previous document, shows the reason, adds no history and raises no job failure; a success clears it', async () => {
  const b = await studio();
  await published(b);
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  const before = await insightsOf(b);
  for (const [name, run, reason] of [
    ['invalid', async () => 'not json', /not the expected JSON/],
    ['late', () => new Promise<string>(() => undefined), /did not answer within/],
    ['thrown', async () => { throw new Error('No agent is available: none is set up'); }, /No agent is available/],
  ] as const) {
    behave = run;
    await t.send('POST', t.c(b, '/insights/refresh'));
    await settle();
    const view = await insightsOf(b);
    assert.deepEqual([view.state, view.markdown, view.updatedAt], ['failed', before.markdown, before.updatedAt], name);
    assert.match(view.lastError.reason, reason, name);
    assert.ok(view.lastError.at, name);
  }
  assert.equal((await t.api(t.c(b, '/insights/history'))).body.entries.length, 1, 'failures add no version');
  behave = async () => ok('## Summary\n\nFresh');
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  const healed = await insightsOf(b);
  assert.deepEqual([healed.state, healed.lastError], ['ready', null]);
});

test('I26/I27 a run is a footer job of kind insights and Stop ends it without an error', async () => {
  const b = await studio();
  await published(b);
  const { contentJobs } = await import('../src/content/jobs.ts');
  behave = ({ signal }) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('killed'))));
  assert.equal((await t.send('POST', t.c(b, '/insights/stop'))).status, 409, 'nothing to stop');
  await t.send('POST', t.c(b, '/insights/refresh'));
  const job = contentJobs.list().find((j) => j.buildingId === b)!;
  assert.deepEqual([job.kind, job.status], ['insights', 'running']);
  assert.equal((await t.send('POST', t.c(b, '/insights/stop'))).status, 200);
  await settle();
  assert.equal(contentJobs.list().some((j) => j.buildingId === b), false);
  const view = await insightsOf(b);
  assert.deepEqual([view.state, view.lastError], ['never-run', null]);
});

test('I30/I31/I33/I34/I35 notes: saved with the current version, stale version 409, size limit, kept across refreshes', async () => {
  const b = await studio();
  const first = await insightsOf(b);
  assert.deepEqual([first.state, first.markdown, first.notes], ['never-run', '', '']);
  const saved = await t.send('PUT', t.c(b, '/insights/notes'), { content: 'Mine', version: first.notesVersion });
  assert.equal(saved.status, 200);
  const stale = await t.send('PUT', t.c(b, '/insights/notes'), { content: 'Other', version: first.notesVersion });
  assert.deepEqual([stale.status, stale.body.details.current], [409, saved.body.version]);
  assert.equal((await insightsOf(b)).notes, 'Mine');
  assert.equal((await t.send('PUT', t.c(b, '/insights/notes'), { content: 'a'.repeat(50_001), version: saved.body.version })).status, 400);
  assert.equal((await t.send('PUT', t.c(b, '/insights/notes'), { content: 4, version: saved.body.version })).status, 400);
  assert.equal((await t.send('PUT', t.c(b, '/insights/notes'), { content: 'x' })).status, 400);
  await published(b);
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  assert.equal((await insightsOf(b)).notes, 'Mine');
  await t.projectsDb.update(b, { readOnlyReason: 'Frozen for the test' });
  assert.equal((await t.send('PUT', t.c(b, '/insights/notes'), { content: 'y', version: saved.body.version })).status, 409);
  await t.projectsDb.update(b, { readOnlyReason: undefined });
});

test('I36/I37 an agent edit of insights.md is replaced at the next refresh; 20 versions are kept, newest first', async () => {
  const b = await studio();
  await published(b);
  const file = path.join(t.dataDir, 'buildings', b, 'knowledge', 'insights.md');
  for (let n = 1; n <= 22; n++) {
    behave = async () => ok(`## Summary\n\nVersion ${n}`);
    await t.send('POST', t.c(b, '/insights/refresh'));
    await settle();
  }
  const entries = (await t.api(t.c(b, '/insights/history'))).body.entries;
  assert.equal(entries.length, 20);
  assert.deepEqual([entries[0].markdown.endsWith('Version 22'), entries[19].markdown.endsWith('Version 3'), entries[0].trigger], [true, true, 'manual']);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, 'edited by an agent');
  behave = async () => ok('## Summary\n\nAfter edit');
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  assert.match(await readFile(file, 'utf8'), /After edit/);
  assert.doesNotMatch(await readFile(file, 'utf8'), /edited by an agent/);
});

test('I40/I41 the knowledge README describes insights.md', async () => {
  const b = await studio();
  const readme = await readFile(path.join(t.dataDir, 'buildings', b, 'knowledge', 'README.md'), 'utf8');
  assert.match(readme, /`insights\.md`/);
});

test('I53 a new service over the same Building keeps the history, notes and last error and carries no timer', async () => {
  const b = await studio();
  await published(b);
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  behave = async () => 'broken';
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  const { createInsights } = await import('../src/content/insights.ts');
  const again = createInsights({ agent: fakeAgent });
  const view = again.view(await ctxOf(b));
  assert.deepEqual([view.state, view.nextRefreshAt, view.markdown !== '', view.lastError !== null], ['failed', null, true, true]);
});

test('I51 a Building forgotten during a run stops it and writes nothing', async () => {
  const b = await studio();
  await published(b);
  behave = ({ signal }) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('killed'))));
  await t.send('POST', t.c(b, '/insights/refresh'));
  insights.forget(b);
  await settle();
  assert.deepEqual([(await insightsOf(b)).state, (await insightsOf(b)).lastError], ['never-run', null]);
});

// ---- sessions: instructions and the get_performance tool ----------------------------------------------------------------

const lastStart = () => terminal.starts[terminal.starts.length - 1]!;
const tool = (route: string, sessionId: string | undefined, auth: string | undefined = token) => t.api(`/api/studio-session${route}${sessionId ? `?taskId=${sessionId}` : ''}`.replace('?taskId=', route.includes('?') ? '&taskId=' : '?taskId='), { headers: auth ? { authorization: `Bearer ${auth}` } : {} });

test('I47/I48/U84-U86 every session kind carries the platform targets, the insights path and the exact sentence, and offers get_performance', async () => {
  const b = await studio();
  await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 1500, engagementRate: 3 });
  const posts = [
    { platform: 'linkedin', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' },
    { platform: 'instagram', format: 'reel', scheduledAt: '2026-11-04T09:00:00Z' },
    { platform: 'blog', format: 'article', scheduledAt: '2026-11-05T09:00:00Z' },
    { platform: 'facebook', format: 'image', scheduledAt: '2026-11-06T09:00:00Z' },
  ];
  const c = (await t.send('POST', t.c(b, '/concepts'), { title: 'Multi', posts })).body;
  const asset = (kind: string, platform?: string) => (platform ? c.posts.find((p: any) => p.platform === platform).needs : c.assets).find((a: any) => a.kind === kind).id;
  const insightsFile = path.join(t.dataDir, 'buildings', b, 'knowledge', 'insights.md');
  const start = async (aid: string) => {
    assert.equal((await t.send('POST', t.c(b, `/concepts/${c.id}/assets/${aid}/session`))).status, 201);
    return lastStart();
  };
  const sentence = 'Read the Insights before proposing anything. Prefer what works, avoid what does not, and say which insight a choice follows.';
  const kinds: Array<[string, string, RegExp]> = [
    ['script', asset('script'), /LinkedIn: views \(impressions on this platform\) at least 1500, engagement rate \(%\) at least 3[\s\S]*Instagram: no targets set/],
    ['post text', asset('post-text', 'linkedin'), /LinkedIn: views/],
    ['caption', asset('post-text', 'instagram'), /Instagram: no targets set/],
    ['blog', asset('article', 'blog'), /Blog: no targets set/],
  ];
  for (const [name, aid, targets] of kinds) {
    const started = await start(aid);
    const prompt = started.systemPrompt!;
    assert.match(prompt, targets, name);
    assert.ok(prompt.includes(insightsFile), name);
    assert.ok(prompt.includes(sentence), name);
    assert.ok(started.mcpServers![0]!.tools.includes('get_performance'), name);
  }
  assert.doesNotMatch(lastStart().systemPrompt!, /Instagram: no targets set[\s\S]*Instagram: no targets set/);
});

test('U84/U85 the video and images prompts carry the same Targets and Insights section; the retro gets targets and the insights text without a folder path', async () => {
  const b = await studio();
  await t.send('PUT', t.c(b, '/targets/facebook'), { likes: 40 });
  const ctx = await ctxOf(b);
  const { performanceSection } = await import('../src/content/insightsInstructions.ts');
  const { videoSystemPrompt } = await import('../src/content/videoInstructions.ts');
  const { imagesSystemPrompt } = await import('../src/content/imageInstructions.ts');
  const { retroInstructions } = await import('../src/content/retroRules.ts');
  const section = performanceSection(ctx, ['facebook', 'facebook']);
  assert.match(section, /Facebook: likes at least 40/);
  assert.equal(section.match(/Facebook:/g)!.length, 1);
  assert.match(performanceSection(ctx, []), /no posts yet/);
  const video = videoSystemPrompt({ concept: { id: 'c', title: 'T', brief: '', posts: [] }, buildingDir: ctx.dir, scriptFile: '/s.md', compositionId: 'comp', performance: section });
  assert.ok(video.includes('## Targets and Insights'));
  const images = imagesSystemPrompt({
    concept: { id: 'c', title: 'T', brief: '' }, post: { id: 'p', platform: 'facebook', format: 'image', scheduledAt: '2026-11-03T09:00:00Z' }, buildingDir: ctx.dir,
    size: { width: 1080, height: 1080 }, stillPrefix: 'still-a', postText: null, scriptFile: null, brandFiles: [], colours: [], skillText: null, performance: section,
  });
  assert.ok(images.includes('Facebook: likes at least 40'));
  assert.equal(videoSystemPrompt({ concept: { id: 'c', title: 'T', brief: '', posts: [] }, buildingDir: ctx.dir, scriptFile: '/s.md', compositionId: 'comp' }).includes('Targets and Insights'), false);
  assert.ok(retroInstructions(null, 'RETRO-PERF').endsWith('RETRO-PERF'));
});

test('I43-I46 get_performance: refusals, newest first with the item shape, filters, limit', async () => {
  const b = await studio();
  await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 1000 });
  await published(b, { title: 'Old', ageDays: 20, counts: { impressions: 5000 } });
  await published(b, { title: 'New', ageDays: 10, counts: { impressions: 10 } });
  await published(b, { title: 'Insta', platform: 'instagram', format: 'image', ageDays: 15, counts: { views: 10 } });
  const f = (await t.send('POST', t.c(b, '/concepts'), { title: 'Session', posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] })).body;
  const aid = f.posts[0].needs[0].id;
  const session = (await t.send('POST', t.c(b, `/concepts/${f.id}/assets/${aid}/session`))).body.session.id;
  assert.equal((await tool('/performance', session, 'wrong')).status, 401);
  assert.equal((await tool('/performance', session, '')).status, 401);
  assert.equal((await tool('/performance', 'no-such-session')).status, 404);
  const all = (await tool('/performance', session)).body.posts;
  assert.deepEqual(all.map((p: any) => p.conceptTitle), ['New', 'Insta', 'Old']);
  assert.deepEqual([all[0].platform, all[0].stats.counts.impressions, all[0].results.overall, all[0].text, all[2].results.overall], ['linkedin', 10, 'below-target', 'Hello world', 'on-target']);
  const only = async (q: string) => (await tool(`/performance?${q}`, session)).body.posts.map((p: any) => p.conceptTitle);
  assert.deepEqual(await only('platform=linkedin&result=on-target'), ['Old']);
  assert.deepEqual(await only('platform=instagram'), ['Insta']);
  assert.deepEqual(await only('format=image'), ['Insta']);
  assert.deepEqual(await only('result=partly'), []);
  assert.deepEqual(await only('limit=1'), ['New']);
  for (const q of ['limit=0', 'limit=101', 'limit=20.5', 'limit=x', 'platform=tiktok', 'result=good', 'format=gif']) assert.equal((await tool(`/performance?${q}`, session)).status, 400, q);
  assert.equal((await tool('/performance?limit=100', session)).status, 200);
  terminal.live.delete(session);
  assert.equal((await tool('/performance', session)).status, 409);
});

test('I54 another Building keeps its own targets and insights', async () => {
  const a = await studio();
  const other = await t.createStudio('Other');
  await t.send('PUT', t.c(a, '/targets/x'), { likes: 9 });
  assert.equal((await targetsOf(other)).body.targets.x.likes, null);
  assert.equal((await insightsOf(other)).state, 'never-run');
});

// ---- review round 1: data file contents, debounce edges, stop, coverage ---------------------------------------------------

test('U54/U55 the data file holds the newest 200 published posts with stats, newest first, and leaves out the rest', { timeout: 120_000 }, async () => {
  const b = await studio();
  for (let i = 0; i < 205; i++) await published(b, { title: `P${i}`, ageDays: 400 - i });
  await published(b, { title: 'No stats', counts: null });
  await t.send('POST', t.c(b, '/concepts'), { title: 'Draft', posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] });
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  const posts = calls.at(-1)!.data.posts;
  assert.equal(posts.length, 200);
  assert.deepEqual([posts[0].conceptTitle, posts[199].conceptTitle], ['P204', 'P5']);
  assert.equal(posts.some((p: any) => ['No stats', 'Draft'].includes(p.conceptTitle)), false);
});

test('U56/U57/U58/U59 text is cut at 1,000 code points, the hook is the first 3 lines, weekday and hour use the Building zone, video seconds and image count appear', async () => {
  const { performanceItems } = await import('../src/content/performance.ts');
  const b = await studio();
  const items = async () => performanceItems(await ctxOf(b), { limit: 20 });
  const at = (title: string) => items().then((list) => list.find((p) => p.conceptTitle === title)!);
  await published(b, { title: 'Exact', text: '😀'.repeat(1000) });
  await published(b, { title: 'Over', text: '😀'.repeat(1001) });
  assert.deepEqual([[...(await at('Exact')).text!].length, (await at('Exact')).textLength], [1000, 1000]);
  assert.deepEqual([[...(await at('Over')).text!].length, (await at('Over')).textLength], [1000, 1001]);
  const withScript = async (title: string, script: string | null) => {
    const f = await published(b, { title });
    const concept = (await t.api(t.c(b, `/concepts/${f.cid}`))).body;
    if (script !== null) mod.setAssetState(await ctxOf(b), concept.assets.find((a: any) => a.kind === 'script').id, 'finalized', script);
  };
  await withScript('Two', 'one\ntwo');
  await withScript('Blank', 'a\n\nb\nc');
  await withScript('None', null);
  assert.deepEqual([(await at('Two')).hook, (await at('Blank')).hook, (await at('None')).hook, (await at('None')).scriptExcerpt], ['one\ntwo', 'a\n\nb', null, null]);
  await published(b, { title: 'Late', publishedAt: '2026-10-25T20:00:00.000Z' });
  const late = await at('Late');
  assert.deepEqual([late.publishedWeekday, late.publishedHour], ['Monday', 1], 'Sunday 20:00 UTC is Monday 01:30 in Asia/Kolkata');
  const insta = await published(b, { title: 'Reel', platform: 'instagram', format: 'reel' });
  const ctx = await ctxOf(b);
  const video = ((await t.api(t.c(b, `/concepts/${insta.cid}`))).body.assets as any[]).find((a) => a.kind === 'video').id;
  ctx.db.prepare("INSERT INTO video_renders (id, assetId, round, k, status, compositionId, durationMs, createdAt) VALUES ('r1', ?, 1, 1, 'done', 'c', 12340, 1)").run(video);
  assert.equal((await at('Reel')).videoSeconds, 12.3);
  const carousel = await published(b, { title: 'Carousel', platform: 'instagram', format: 'carousel' });
  const set = (await t.api(t.c(b, `/concepts/${carousel.cid}`))).body.posts[0].needs.find((a: any) => a.kind === 'image-set').id;
  mod.setAssetState(ctx, set, 'finalized', JSON.stringify(['a.png', 'b.png']));
  assert.equal((await at('Carousel')).imageCount, 2);
  mod.setAssetState(ctx, set, 'finalized', 'not json');
  assert.equal((await at('Carousel')).imageCount, null);
  mod.setAssetState(ctx, set, 'finalized', '{"a":1}');
  assert.equal((await at('Carousel')).imageCount, null);
});

test('U62-U67 debounce edges: an event just before the timer pushes it out, a manual refresh cancels it, a deleted Building clears it, a due timer on a read-only Building does nothing', async () => {
  const b = await studio();
  const f = await published(b);
  const live = () => timers.filter((x) => !x.cancelled);
  assert.equal(live().length, 1);
  const first = live()[0]!;
  await t.send('POST', f.post('/stats'), { capturedAt: iso(-HOUR / 3), counts: { likes: 1 } });
  assert.equal(first.cancelled, true, 'the earlier timer is cancelled');
  assert.deepEqual([live().length, live()[0]!.ms], [1, 10 * 60_000], 'a fresh full wait starts');
  assert.equal(calls.length, 0);
  const pending = live()[0]!;
  await t.send('POST', t.c(b, '/insights/refresh'));
  assert.equal(pending.cancelled, true, 'a manual refresh cancels the pending timer');
  await settle();
  assert.equal(calls.length, 1);
  await t.send('POST', f.post('/stats'), { capturedAt: iso(-HOUR / 4), counts: { likes: 2 } });
  assert.equal(live().length, 1);
  insights.forget(b);
  assert.equal(live().length, 0, 'forgetting the Building clears its timer');
  assert.equal((await insightsOf(b)).nextRefreshAt, null);
});

test('I26 a stopped run keeps the existing document, the history and no error', async () => {
  const b = await studio();
  await published(b);
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  const before = await insightsOf(b);
  behave = ({ signal }) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('killed'))));
  await t.send('POST', t.c(b, '/insights/refresh'));
  await t.send('POST', t.c(b, '/insights/stop'));
  await settle();
  const after = await insightsOf(b);
  assert.deepEqual([after.state, after.markdown, after.updatedAt, after.lastError], ['ready', before.markdown, before.updatedAt, null]);
  assert.equal((await t.api(t.c(b, '/insights/history'))).body.entries.length, 1);
});

test('a thrown non-Error is reported as text; ensureFile recreates a missing insights.md', async () => {
  const b = await studio();
  await published(b);
  behave = async () => { throw 'plain failure'; };
  await t.send('POST', t.c(b, '/insights/refresh'));
  await settle();
  assert.equal((await insightsOf(b)).lastError.reason, 'plain failure');
  const file = path.join(t.dataDir, 'buildings', b, 'knowledge', 'insights.md');
  await rm(file, { force: true });
  await insights.ensureFile(await ctxOf(b));
  assert.match(await readFile(file, 'utf8'), /Owner notes/);
  const before = await readFile(file, 'utf8');
  await insights.ensureFile(await ctxOf(b));
  assert.equal(await readFile(file, 'utf8'), before, 'an existing file is left alone');
});

test('the result filter respects the platform filter', async () => {
  const b = await studio();
  await t.send('PUT', t.c(b, '/targets/linkedin'), { views: 1000 });
  await t.send('PUT', t.c(b, '/targets/x'), { views: 1000 });
  const mixed = (await t.send('POST', t.c(b, '/concepts'), { title: 'Mixed', posts: [{ platform: 'linkedin', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }, { platform: 'x', format: 'text', scheduledAt: '2026-11-03T10:00:00Z' }] })).body;
  const ctx = await ctxOf(b);
  for (const post of mixed.posts) {
    for (const a of post.needs) mod.setAssetState(ctx, a.id, 'finalized', 'Hello');
    const base = t.c(b, `/concepts/${mixed.id}/posts/${post.id}`);
    await t.send('POST', `${base}/finalize`);
    await t.send('POST', `${base}/publish`, { publishedAt: iso(-10 * DAY) });
    await t.send('POST', `${base}/stats`, { capturedAt: iso(-HOUR), counts: { impressions: post.platform === 'linkedin' ? 5000 : 10 } });
  }
  const titles = async (q: string) => (await t.api(t.c(b, `/concepts?${q}`))).body.rows.map((r: any) => r.title);
  assert.deepEqual(await titles('result=below-target'), ['Mixed']);
  assert.deepEqual(await titles('result=below-target&platform=linkedin'), [], 'the only below-target post is on X');
  assert.deepEqual(await titles('result=below-target&platform=x'), ['Mixed']);
});
