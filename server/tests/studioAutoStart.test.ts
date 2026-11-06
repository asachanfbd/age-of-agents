import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';
import { fakeVideo, gate, waitFor } from './helpers/videoFakes.ts';

/**
 * Finalizing the script starts the sessions of the assets that depend on it (content/studioDependencies.ts). Fake terminal
 * host, installer and renderer; no real agent.
 */

let t: ContentApi;
let terminal: ReturnType<typeof fakeTerminalHost>;
let service: StudioSessions;
let home: string;
let token: string;
let defaultAgent: string | null = 'test-claude-cli';
let agentError: string | null = null;
let video: ReturnType<typeof fakeVideo>;
let videoDeps: typeof import('../src/content/videoDeps.ts');
let studioDb: typeof import('../src/db/collections.ts').studioSessionsDb;
let contentCtx: typeof import('../src/content/runtime.ts').contentCtx;
const events: any[] = [];

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'studio-auto-home-'));
  t = await startContentApi(async () => {
    const mod = await import('../src/content/studioSessions.ts');
    videoDeps = await import('../src/content/videoDeps.ts');
    studioDb = (await import('../src/db/collections.ts')).studioSessionsDb;
    contentCtx = (await import('../src/content/runtime.ts')).contentCtx;
    token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
    terminal = fakeTerminalHost();
    service = mod.createStudioSessions({ host: { ...terminal.host, sessionExists: () => true }, defaultAgentId: async () => { if (agentError) throw new Error(agentError); return defaultAgent; }, home });
    service.onEvent((e) => { if (e.type === 'studioAsset') events.push(e); });
    return { studioSessions: service };
  });
});
after(async () => { await service.settled(); videoDeps.resetVideo(); await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => {
  defaultAgent = 'test-claude-cli';
  agentError = null;
  video = fakeVideo();
  videoDeps.configureVideo({ installer: video.installer, renderer: video.renderer, prober: video.prober, limits: { mediaMaxBytes: 1_000, mediaFilesMax: 6, renderTimeoutMs: 10_000 }, submitDelayMs: 0 });
  events.length = 0;
});

const POSTS = [
  { platform: 'linkedin', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' },
  { platform: 'instagram', format: 'reel', scheduledAt: '2026-11-04T09:00:00Z' },
  { platform: 'blog', format: 'article', scheduledAt: '2026-11-05T09:00:00Z' },
  { platform: 'linkedin', format: 'carousel', scheduledAt: '2026-11-06T09:00:00Z' },
];

interface Fx { b: string; cid: string; concept: any; script: string }
async function fixture(posts: unknown[] = POSTS): Promise<Fx> {
  const b = await t.createStudio('Acme');
  const c = await t.send('POST', t.c(b, '/concepts'), { title: 'Launch', brief: 'Big news', posts });
  return { b, cid: c.body.id, concept: c.body, script: c.body.assets.find((a: any) => a.kind === 'script').id };
}
const base = (f: Fx, aid: string) => t.c(f.b, `/concepts/${f.cid}/assets/${aid}`);
const saveDraft = (sid: string, text: string) => t.api(`/api/studio-session/draft?taskId=${sid}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
/** Starts the script's own session by hand, saves a draft and finalizes it, then waits for the dependent starts. */
async function finalizeScript(f: Fx, beforeFinalize: () => void = () => undefined): Promise<void> {
  const s = await t.send('POST', `${base(f, f.script)}/session`);
  assert.equal(s.status, 201);
  await saveDraft(s.body.session.id, 'Hook. Body. Call.');
  beforeFinalize();
  const res = await t.send('POST', `${base(f, f.script)}/finalize`);
  assert.equal(res.status, 200, res.text);
  await service.settled();
}
/** Waits for the sessions that had to wait for the Remotion install. */
const sessionCount = (f: Fx, n: number) => waitFor(async () => {
  const ctx = contentCtx((await t.projectsDb.get(f.b))!);
  const drafting = (ctx.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE conceptId = ? AND state = 'drafting' AND kind != 'script'").get(f.cid) as { n: number }).n;
  return (await sessionsOf(f)).length === n && drafting === n;
}, `${n} sessions`);
const sessionsOf = (f: Fx) => studioDb.find((s) => s.conceptId === f.cid && s.assetId !== f.script);
const tabs = async (f: Fx) => (await sessionsOf(f)).map((s) => s.tab).sort();
const assetOf = (f: Fx, kind: string, platform?: string, format?: string) =>
  f.concept.posts.filter((p: any) => (!platform || p.platform === platform) && (!format || p.format === format)).flatMap((p: any) => p.needs).find((a: any) => a.kind === kind).id as string;
const viewOf = async (f: Fx, aid: string) => (await t.api(`${base(f, aid)}/session`)).body;

test('I1/I2/I18 finalizing the script starts exactly the dependent sessions once, as drafting, with a view event each', async () => {
  const f = await fixture();
  await finalizeScript(f);
  await sessionCount(f, 7);
  assert.deepEqual(await tabs(f), ['blog', 'captions', 'images', 'post-content', 'post-content', 'thumbnail', 'video']);
  for (const s of await sessionsOf(f)) {
    assert.equal(s.round, 1);
    const view = await viewOf(f, s.assetId);
    assert.equal(view.asset.state, 'drafting');
    assert.equal(view.session.id, s.id);
    assert.equal(view.blockedReason, null);
    assert.ok(events.some((e) => e.view.assetId === s.assetId && e.view.asset.state === 'drafting' && e.view.session?.id === s.id), s.tab);
  }
  assert.equal(video.state.installs, 1, 'the Remotion install is shared by the video, the images and the thumbnail');
});

test('I3 the starts wait in the write queue and then all run', async () => {
  const f = await fixture();
  const ctx = contentCtx((await t.projectsDb.get(f.b))!);
  const s = await t.send('POST', `${base(f, f.script)}/session`);
  await saveDraft(s.body.session.id, 'Script.');
  const hold = gate();
  const blocker = ctx.exclusive(() => hold.promise);
  await service.finalize(ctx, f.cid, f.script);
  assert.equal((await sessionsOf(f)).length, 0, 'nothing starts while the queue is held');
  hold.open();
  await blocker;
  await service.settled();
  await sessionCount(f, 7);
});

test('I4/I5/I6/I7 re-finalizing after a reopen leaves running, drafting, finalized and ended sessions alone', async () => {
  const f = await fixture();
  await finalizeScript(f);
  await sessionCount(f, 7);
  const before = (await sessionsOf(f)).map((s) => s.id).sort();
  const startsBefore = terminal.starts.length;
  const blog = assetOf(f, 'article');
  const li = assetOf(f, 'post-text', 'linkedin', 'text');
  const liSession = (await viewOf(f, li)).session.id;
  await saveDraft(liSession, 'Post text.');
  assert.equal((await t.send('POST', `${base(f, li)}/finalize`)).status, 200);
  await studioDb.update((await viewOf(f, blog)).session.id, { state: 'ended' });
  assert.equal((await t.send('POST', `${base(f, f.script)}/reopen`)).status, 200);
  const s2 = (await viewOf(f, f.script)).session.id;
  await saveDraft(s2, 'Second script.');
  assert.equal((await t.send('POST', `${base(f, f.script)}/finalize`)).status, 200);
  await service.settled();
  assert.deepEqual((await sessionsOf(f)).map((s) => s.id).sort(), before);
  assert.equal(terminal.starts.length - startsBefore, 1, 'only the script reopen started a terminal');
  assert.equal((await viewOf(f, blog)).session.state, 'ended');
});

test('I9 a Concept without a video post does not start the video or a thumbnail', async () => {
  const f = await fixture([POSTS[0]]);
  await finalizeScript(f);
  assert.deepEqual(await tabs(f), ['post-content']);
});

test('I10/I11/I12 with no default agent the finalize succeeds, each asset keeps its reason, and opening later starts it', async () => {
  const f = await fixture();
  await finalizeScript(f, () => { defaultAgent = null; });
  assert.equal((await sessionsOf(f)).length, 0);
  const blog = assetOf(f, 'article');
  const refused = await viewOf(f, blog);
  assert.match(refused.blockedReason, /No default coding agent/);
  assert.equal(refused.asset.state, 'empty');
  assert.ok(events.some((e) => e.view.assetId === blog && /No default coding agent/.test(e.view.blockedReason)), 'the refusal is published');
  for (const kind of ['video', 'image-set', 'thumbnail']) assert.match((await viewOf(f, assetOf(f, kind))).blockedReason, /No default coding agent/, kind);
  defaultAgent = 'test-claude-cli';
  const res = await t.send('POST', `${base(f, blog)}/session`);
  assert.equal(res.status, 201);
  assert.equal(res.body.blockedReason, null);
});

test('I13/I14 a failed Remotion install leaves the video, images and thumbnail waiting, the text sessions still start, and the install ran once', async () => {
  const f = await fixture();
  video.state.installError = 'offline';
  await finalizeScript(f);
  await waitFor(async () => (await viewOf(f, assetOf(f, 'video'))).video.setup.status === 'failed', 'install failed');
  assert.deepEqual(await tabs(f), ['blog', 'captions', 'post-content', 'post-content']);
  assert.equal(video.state.installs, 1);
  assert.equal((await viewOf(f, assetOf(f, 'video'))).video.setup.status, 'failed');
});

test('I16 an archived Concept starts nothing', async () => {
  const f = await fixture();
  const s = await t.send('POST', `${base(f, f.script)}/session`);
  await saveDraft(s.body.session.id, 'Script.');
  assert.equal((await t.send('PATCH', t.c(f.b, `/concepts/${f.cid}`), { archived: true })).status, 200);
  assert.equal((await t.send('POST', `${base(f, f.script)}/finalize`)).status, 200);
  await service.settled();
  assert.equal((await sessionsOf(f)).length, 0);
});

test('I17 an asset removed between the finalize and its queued start is skipped without error', async () => {
  const f = await fixture();
  const ctx = contentCtx((await t.projectsDb.get(f.b))!);
  const s = await t.send('POST', `${base(f, f.script)}/session`);
  await saveDraft(s.body.session.id, 'Script.');
  const hold = gate();
  const blocker = ctx.exclusive(() => hold.promise);
  await service.finalize(ctx, f.cid, f.script);
  const blog = f.concept.posts.find((p: any) => p.platform === 'blog');
  ctx.db.prepare('DELETE FROM assets WHERE postId = ?').run(blog.id);
  ctx.db.prepare('DELETE FROM posts WHERE id = ?').run(blog.id);
  hold.open();
  await blocker;
  await service.settled();
  await sessionCount(f, 6);
  assert.deepEqual(await tabs(f), ['captions', 'images', 'post-content', 'post-content', 'thumbnail', 'video']);
});

test('I21 finalizing a text asset starts no session', async () => {
  const f = await fixture([POSTS[0]]);
  await finalizeScript(f);
  const li = assetOf(f, 'post-text');
  await saveDraft((await viewOf(f, li)).session.id, 'Post text.');
  const before = terminal.starts.length;
  assert.equal((await t.send('POST', `${base(f, li)}/finalize`)).status, 200);
  await service.settled();
  assert.equal(terminal.starts.length, before);
});

test('I20 a long refusal reason is kept and shown unchanged', async () => {
  const f = await fixture([POSTS[0]]);
  const long = 'x'.repeat(5000);
  await finalizeScript(f, () => { agentError = long; });
  assert.equal((await viewOf(f, assetOf(f, 'post-text'))).blockedReason, long);
});

test('TI37 finalizing the video starts an empty thumbnail that has no session (a drafting or started one: TU20)', async () => {
  const f = await fixture([POSTS[1]]);
  await finalizeScript(f);
  await sessionCount(f, 3);
  const thumb = assetOf(f, 'thumbnail');
  const videoAid = assetOf(f, 'video');
  assert.equal((await viewOf(f, thumb)).session.tab, 'thumbnail', 'the script started the thumbnail in parallel with the video');
  // Put the thumbnail back to empty with no session, as if it had never started.
  await service.removeForAssets([thumb]);
  const ctx = contentCtx((await t.projectsDb.get(f.b))!);
  ctx.db.prepare("UPDATE assets SET state = 'empty', round = 0 WHERE id = ?").run(thumb);
  const videoSid = (await viewOf(f, videoAid)).session.id;
  const tool = (route: string, body: unknown) => t.api(`/api/studio-session${route}?taskId=${videoSid}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await tool('/checklist', { items: [{ id: 'clip', label: 'Clip' }] })).status, 200);
  assert.equal((await t.send('PATCH', t.c(f.b, `/concepts/${f.cid}/video/checklist/clip`), { ticked: true })).status, 200);
  assert.equal((await t.send('POST', t.c(f.b, `/concepts/${f.cid}/video/confirm`))).status, 200);
  const startsBefore = terminal.starts.length;
  assert.equal((await t.send('POST', `${base(f, videoAid)}/finalize`)).status, 200);
  await service.video.settled();
  await service.settled();
  const view = await waitFor(async () => { const v = await viewOf(f, thumb); return v.session ? v : null; }, 'thumbnail session');
  assert.equal(view.asset.state, 'drafting');
  assert.equal(view.session.tab, 'thumbnail');
  assert.equal(terminal.starts.length - startsBefore, 1, 'only the thumbnail started');
});
