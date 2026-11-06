import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';
import { fakeVideo, gate, pngSize, waitFor } from './helpers/videoFakes.ts';

/**
 * The Thumbnail tab end to end through the real daemon routes (`api/thumbnailRoutes.ts`, `content/thumbnailStudio.ts`): the asset's
 * life with its video posts, thumbnail sessions in the shared Remotion project, `render_thumbnails` with the fake still renderer, the
 * shared render queue, Finalize with the owner's pick, Reopen, new rounds, deletion and the file and publish routes. The terminal host,
 * npm install and renderers are fakes; every file lives in a temp folder.
 */

let t: ContentApi;
let terminal: ReturnType<typeof fakeTerminalHost>;
let service: StudioSessions;
let video: ReturnType<typeof fakeVideo>;
let token: string;
let home: string;
let defaultAgent: string | null = 'test-claude-cli';
let videoDeps: typeof import('../src/content/videoDeps.ts');
let contentCtx: typeof import('../src/content/runtime.ts').contentCtx;
const events: any[] = [];
const jobEvents: any[] = [];

const LIMITS = { stillTimeoutMs: 10_000, callTimeoutMs: 20_000 };

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'thumbs-home-'));
  t = await startContentApi(async () => {
    const mod = await import('../src/content/studioSessions.ts');
    videoDeps = await import('../src/content/videoDeps.ts');
    contentCtx = (await import('../src/content/runtime.ts')).contentCtx;
    const jobs = await import('../src/content/jobs.ts');
    jobs.contentJobs.on((e) => jobEvents.push(e));
    token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
    terminal = fakeTerminalHost();
    service = mod.createStudioSessions({ host: { ...terminal.host, sessionExists: () => true }, defaultAgentId: async () => defaultAgent, home });
    service.onEvent((e) => events.push(e));
    return { studioSessions: service };
  });
});
after(async () => { await service.settled(); videoDeps.resetVideo(); await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => {
  defaultAgent = 'test-claude-cli';
  video = fakeVideo();
  videoDeps.configureVideo({ installer: video.installer, renderer: video.renderer, stillRenderer: video.stillRenderer, prober: video.prober, imageLimits: { ...LIMITS }, submitDelayMs: 0 });
});

// ---- helpers -----------------------------------------------------------------------------------

const AT = '2026-11-03T09:00:00Z';
const LI_VIDEO = { platform: 'linkedin', format: 'video', scheduledAt: AT };
const IG_REEL = { platform: 'instagram', format: 'reel', scheduledAt: AT };
const LI_TEXT = { platform: 'linkedin', format: 'text', scheduledAt: AT };
const IG_IMAGE = { platform: 'instagram', format: 'image', scheduledAt: AT };

interface Fx { b: string; cid: string; aid: string; c: (s: string) => string; body: any }

async function concept(b?: string, posts: unknown[] = [LI_VIDEO], title = 'Launch'): Promise<Fx> {
  const building = b ?? await t.createStudio('Acme');
  const c = await t.send('POST', t.c(building, '/concepts'), { title, brief: 'Why', posts });
  assert.equal(c.status, 201, c.text);
  return { b: building, cid: c.body.id, aid: c.body.assets.find((a: any) => a.kind === 'thumbnail')?.id, body: c.body, c: (s: string) => t.c(building, `/concepts/${c.body.id}${s}`) };
}

const tool = (method: string, route: string, sessionId: string | undefined, body?: unknown, auth = token) => t.api(`/api/studio-session${route}${sessionId ? `?taskId=${sessionId}` : ''}`, {
  method, headers: auth ? { authorization: `Bearer ${auth}` } : {}, body: body === undefined ? undefined : JSON.stringify(body),
});
const view = async (f: Fx) => (await t.api(f.c(`/assets/${f.aid}/session`))).body;
const remotion = (f: Fx) => path.join(t.dataDir, 'buildings', f.b, 'remotion');
const codeDir = (f: Fx) => path.join(remotion(f), 'src', 'concepts', f.cid, 'thumbnail');
const roundDir = (f: Fx, round: number) => path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'thumbnail', `round-${round}`);
const registry = (f: Fx) => path.join(remotion(f), 'src', 'concepts', 'registry.ts');
const thumbsBase = (f: Fx) => t.c(f.b, `/assets/${f.aid}/thumbnail`);
const currentRound = (v: any) => v.thumbnail.rounds.find((r: any) => r.round === v.asset.round);
const ctxOf = async (f: Fx) => contentCtx((await t.projectsDb.get(f.b))!);

/** A Concept whose thumbnail has a running session in round 1, after the fake Remotion setup. */
async function withSession(b?: string, posts: unknown[] = [LI_VIDEO], title?: string): Promise<Fx & { sid: string }> {
  const f = await concept(b, posts, title);
  const res = await t.send('POST', f.c(`/assets/${f.aid}/session`));
  assert.equal(res.status, 201, res.text);
  const v = await waitFor(async () => { const x = await view(f); return x.session?.state === 'running' && x.asset.state === 'drafting' ? x : null; }, 'thumbnail session');
  return { ...f, sid: v.session.id };
}

/** Writes thumbnail still files and returns their composition ids, in name order. */
async function stills(f: Fx, names: string[]): Promise<string[]> {
  await mkdir(codeDir(f), { recursive: true });
  for (const name of names) await writeFile(path.join(codeDir(f), `${name}.tsx`), `export const still = { component: () => null }; // ${name}\n`);
  const prefix = `thumb-${f.cid.replace(/-/g, '').slice(0, 8)}`;
  return names.map((n) => `${prefix}-${n}`);
}

const render = (sid: string, body: unknown) => tool('POST', '/thumbnails', sid, body);
const finalize = (f: Fx, body?: unknown) => t.send('POST', f.c(`/assets/${f.aid}/finalize`), body);

// ---- the asset ------------------------------------------------------------------------------------

test('TI01/TI02 a Concept with a video post gets one thumbnail asset, in the post\'s needs; text and image posts get none', async () => {
  const f = await concept(undefined, [LI_VIDEO, LI_TEXT]);
  const thumbs = f.body.assets.filter((a: any) => a.kind === 'thumbnail');
  assert.equal(thumbs.length, 1);
  assert.deepEqual([thumbs[0].postId, thumbs[0].state], [null, 'empty']);
  const videoPost = f.body.posts.find((p: any) => p.format === 'video');
  assert.deepEqual(videoPost.needs.map((a: any) => a.kind), ['post-text', 'video', 'thumbnail']);
  assert.equal(videoPost.needs[2].id, f.aid);
  const plain = await concept(f.b, [LI_TEXT, IG_IMAGE]);
  assert.equal(plain.aid, undefined);
  assert.deepEqual(plain.body.assets.map((a: any) => a.kind), ['script', 'video']);
});

test('TI03/TI04/TI45 adding video posts reuses the one thumbnail; deleting the last keeps it, unneeded; deleting one of two leaves it', async () => {
  const f = await concept(undefined, [LI_TEXT]);
  const reel = await t.send('POST', f.c('/posts'), IG_REEL);
  const aid = reel.body.needs.find((a: any) => a.kind === 'thumbnail').id;
  const second = await t.send('POST', f.c('/posts'), LI_VIDEO);
  assert.equal(second.body.needs.find((a: any) => a.kind === 'thumbnail').id, aid);
  const all = (await t.api(f.c(''))).body;
  assert.equal(all.assets.filter((a: any) => a.kind === 'thumbnail').length, 1);

  const g = { ...f, aid };
  const s = await t.send('POST', f.c(`/assets/${aid}/session`));
  assert.equal(s.status, 201, s.text);
  const sid = (await waitFor(async () => (await view(g)).session, 'session')).id;
  await render(sid, { compositionIds: await stills(g, ['a']) });
  assert.equal((await t.send('DELETE', f.c(`/posts/${reel.body.id}`))).status, 204);
  assert.deepEqual(await readdir(codeDir(g)), ['a.tsx'], 'TI45: the code stays');
  assert.deepEqual(await readdir(roundDir(g, 1)), ['thumb-01.png'], 'TI45: the PNGs stay');
  assert.equal((await view(g)).session.state, 'running', 'TI45: the session runs on');
  assert.equal((await t.send('DELETE', f.c(`/posts/${second.body.id}`))).status, 204);
  const left = (await t.api(f.c(''))).body;
  assert.deepEqual(left.assets.filter((a: any) => a.kind === 'thumbnail').map((a: any) => a.id), [aid]);
  assert.ok(left.posts.every((p: any) => !p.needs.some((a: any) => a.kind === 'thumbnail')));
  const again = await t.send('POST', f.c('/posts'), LI_VIDEO);
  assert.equal(again.body.needs.find((a: any) => a.kind === 'thumbnail').id, aid);
});

test('TI07/TI08/TI09 Finalize post names the thumbnail; progress counts it; a redrafted thumbnail demotes video posts only', async () => {
  const f = await concept(undefined, [LI_VIDEO, LI_TEXT]);
  const ctx = await ctxOf(f);
  const { setAssetState } = await import('../src/content/concepts.ts');
  const [vp, tp] = [f.body.posts.find((p: any) => p.format === 'video'), f.body.posts.find((p: any) => p.format === 'text')];
  const fin = (p: any) => t.send('POST', f.c(`/posts/${p.id}/finalize`));
  setAssetState(ctx, vp.needs[0].id, 'finalized', 'Text');
  assert.deepEqual((await fin(vp)).body.details.missing, ['video', 'thumbnail']);
  setAssetState(ctx, vp.needs[1].id, 'finalized', 'render');
  assert.deepEqual((await fin(vp)).body.details.missing, ['thumbnail']);
  setAssetState(ctx, f.aid, 'finalized', '["thumbnail/round-1/thumb-01.png"]');
  setAssetState(ctx, tp.needs[0].id, 'finalized', 'Text');
  assert.equal((await fin(vp)).status, 200);
  assert.equal((await fin(tp)).status, 200);
  assert.deepEqual((await t.api(f.c(''))).body.progress, { finalized: 4, needed: 4 });
  ctx.db.prepare("UPDATE posts SET status = 'published' WHERE id = ?").run(tp.id);
  setAssetState(ctx, f.aid, 'drafting');
  const after = (await t.api(f.c(''))).body;
  const v = after.posts.find((p: any) => p.id === vp.id);
  assert.deepEqual([v.status, v.note], ['draft', 'Back to draft: the thumbnail for this LinkedIn post is being redrafted']);
  assert.equal(after.posts.find((p: any) => p.id === tp.id).status, 'published');
  assert.deepEqual(after.progress, { finalized: 3, needed: 4 });
});

// ---- sessions --------------------------------------------------------------------------------------

test('TI11/TI12 the session runs in remotion/ after the setup with the thumbnail tools; the view carries the thumbnail part only', async () => {
  const f = await concept();
  const res = await t.send('POST', f.c(`/assets/${f.aid}/session`));
  assert.equal(res.status, 201, res.text);
  const v = await waitFor(async () => { const x = await view(f); return x.session && x.asset.state === 'drafting' ? x : null; }, 'session');
  assert.equal(v.session.tab, 'thumbnail');
  const start = terminal.starts.find((s) => s.taskId === v.session.id)!;
  assert.equal(start.cwd, remotion(f));
  assert.match(start.prompt!, /2 to 4 thumbnail variants/);
  assert.deepEqual(start.mcpServers!.map((s) => s.tools), [['get_concept', 'get_performance', 'get_reference_content', 'save_draft', 'list_media', 'render_thumbnails']]);
  assert.ok(existsSync(codeDir(f)), 'the thumbnail folder is scaffolded');
  assert.equal(video.state.installs, 1);
  assert.equal(v.thumbnail.setup.status, 'ready');
  assert.deepEqual(v.thumbnail.defaultSize, { width: 1280, height: 720 });
  assert.deepEqual([v.thumbnail.stills, v.thumbnail.rounds, v.thumbnail.final, v.thumbnail.blockedReason], [[], [], null, null]);
  assert.equal(v.thumbnail.finalizeBlocked, 'Finalize needs a rendered thumbnail. Ask the agent to render one.');
  assert.equal(v.images, undefined);
  assert.equal(v.video, undefined);
  const imageAid = (await concept(f.b, [IG_IMAGE])).body.posts[0].needs.find((a: any) => a.kind === 'image-set').id;
  const imageView = (await t.api(t.c(f.b, `/concepts/${(await t.api(t.c(f.b, '/concepts'))).body.rows[0].id}/assets/${imageAid}/session`))).body;
  assert.equal(imageView.thumbnail, undefined);
});

test('TI25/TU26 instructions: the Concept, video posts, script, video, brand, skill; a reopened round continues from the code', async () => {
  const skill = path.join(home, '.claude', 'skills', 'human-content-writing-skill', 'SKILL.md');
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, 'SKILL TEXT');
  const f = await withSession(undefined, [LI_VIDEO, IG_REEL, LI_TEXT]);
  const prompt = terminal.starts.find((s) => s.taskId === f.sid)!.systemPrompt!;
  for (const part of ['LinkedIn, video', 'Instagram, reel', 'No finalized script yet.', 'No finalized video yet.', 'SKILL TEXT', '## Targets and Insights', 'Offer 2 to 4 variants', `src/concepts/${f.cid}/thumbnail/`, path.join(t.dataDir, 'buildings', f.b, 'knowledge')]) {
    assert.ok(prompt.includes(part), part);
  }
  assert.equal((await view(f)).skillWarning, null);
  await render(f.sid, { compositionIds: await stills(f, ['a']) });
  assert.equal((await finalize(f)).status, 200);
  const re = await t.send('POST', f.c(`/assets/${f.aid}/reopen`));
  assert.equal(re.status, 200, re.text);
  const reopened = terminal.starts.find((s) => s.taskId === re.body.session.id)!;
  assert.match(reopened.systemPrompt!, /reopened this thumbnail/);
  assert.equal(reopened.prompt, '');
  await rm(skill, { force: true });
});

// ---- render_thumbnails -----------------------------------------------------------------------------

test('TI13/TI14/TI25/TI27 happy path: PNGs at 1280x720, the answer, the view and its URLs; jobs and events per thumbnail; nothing private', async () => {
  const f = await withSession();
  const ids = await stills(f, ['bold', 'calm', 'dark']);
  const before = events.length;
  const jobsBefore = jobEvents.length;
  const res = await render(f.sid, { compositionIds: ids });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { round: 1, thumbnails: ids.map((id, i) => ({ index: i + 1, compositionId: id, width: 1280, height: 720 })), queued: false });
  assert.deepEqual(video.state.stills.map((s) => [s.compositionId, s.width, s.height, s.dir]), ids.map((id) => [id, 1280, 720, remotion(f)]));
  assert.deepEqual(await readdir(roundDir(f, 1)), ['thumb-01.png', 'thumb-02.png', 'thumb-03.png']);
  assert.deepEqual(pngSize(await readFile(path.join(roundDir(f, 1), 'thumb-02.png'))), { width: 1280, height: 720 });
  const v = await view(f);
  assert.deepEqual(v.thumbnail.stills, ids);
  const round = currentRound(v);
  assert.deepEqual([round.call.status, round.call.done, round.call.total], ['done', 3, 3]);
  assert.equal(round.thumbnails[1].url, `/api/projects/${f.b}/content/assets/${f.aid}/thumbnail/rounds/1/thumb-02.png`);
  assert.equal(round.thumbnails[1].downloadUrl, `${round.thumbnails[1].url}?download=1`);
  assert.equal(round.thumbnails[1].compositionId, ids[1]);
  assert.equal(v.thumbnail.finalizeBlocked, null);
  const jobs = jobEvents.slice(jobsBefore).filter((e) => e.job.id === round.call.id);
  assert.deepEqual(jobs.map((e) => [e.job.kind, e.job.status, e.job.done, e.job.total]), [['thumbnail', 'running', 0, 3], ['thumbnail', 'running', 1, 3], ['thumbnail', 'running', 2, 3], ['thumbnail', 'running', 3, 3], ['thumbnail', 'complete', 3, 3]]);
  assert.deepEqual([jobs[0].job.conceptId, jobs[0].job.assetId, jobs[0].job.renderId], [f.cid, f.aid, round.call.id]);
  const mine = events.slice(before).filter((e) => e.type === 'studioAsset' && e.view.assetId === f.aid);
  assert.ok(mine.length >= 5, 'a view at the start, after each thumbnail and at the end');
  assert.ok(mine.some((e) => currentRound(e.view)?.call.done === 2));
  assert.equal(mine.at(-1).view.thumbnail.rounds[0].call.status, 'done');
  // TI13: no folder of this machine in the answer, the view or the events, even inside a URL.
  const record = (await (await import('../src/db/collections.ts')).studioSessionsDb.get(f.sid))!;
  for (const text of [res.text, JSON.stringify(v), JSON.stringify(mine), JSON.stringify(jobs)]) {
    for (const secret of [t.dataDir, remotion(f), path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid), token, record.agentSessionId!]) assert.equal(text.includes(secret), false, `leaked ${secret.slice(0, 24)}`);
  }
});

test('TI14/TI15 a still written after the start is rendered (the registry is refreshed first); a custom size is used and stored; one side falls back', async () => {
  const f = await withSession();
  const ids = await stills(f, ['late']);
  assert.doesNotMatch(await readFile(registry(f), 'utf8'), /late/);
  let seen = '';
  const still = video.stillRenderer.still.bind(video.stillRenderer);
  videoDeps.configureVideo({ stillRenderer: { still: async (r) => { seen = await readFile(registry(f), 'utf8'); return still(r); } } });
  assert.equal((await render(f.sid, { compositionIds: ids, width: 1920, height: 1080 })).status, 200);
  assert.match(seen, new RegExp(`still\\('${ids[0]}', t0\\)`));
  assert.match(seen, new RegExp(`from './${f.cid}/thumbnail/late'`));
  assert.deepEqual([video.state.stills.at(-1)!.width, video.state.stills.at(-1)!.height], [1920, 1080]);
  assert.deepEqual([currentRound(await view(f)).call.width, currentRound(await view(f)).call.height], [1920, 1080]);
  assert.equal((await render(f.sid, { compositionIds: ids, height: 1080 })).body.thumbnails[0].width, 1280);
});

test('TI16 input refusals are 400 with their field; nothing is recorded and the old PNGs stay', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  assert.equal((await render(f.sid, { compositionIds: ids })).status, 200);
  const calls = (await view(f)).thumbnail.rounds.length;
  const asked = video.state.stills.length;
  const other = await concept(f.b);
  const otherIds = await stills(other, ['x']);
  const cases: [unknown, string][] = [
    [{ compositionIds: ids, width: 319 }, 'width'], [{ compositionIds: ids, height: 4001 }, 'height'], [{ compositionIds: ids, width: 1280.5 }, 'width'], [{ compositionIds: ids, width: '1280' }, 'width'],
    [{ compositionIds: [] }, 'compositionIds'], [{ compositionIds: [...ids, 'c', 'd', 'e', 'f'] }, 'compositionIds'], [{ compositionIds: [ids[0], ids[0]] }, 'compositionIds'],
    [{ compositionIds: ids[0] }, 'compositionIds'], [{ compositionIds: [ids[0]!.toUpperCase()] }, 'compositionIds'], [{ compositionIds: otherIds }, 'compositionIds'],
    [{ compositionIds: [`still-${f.cid.slice(0, 8)}-a`] }, 'compositionIds'], [{ compositionIds: [`concept-${f.cid.slice(0, 8)}`] }, 'compositionIds'], [{}, 'compositionIds'],
  ];
  for (const [body, field] of cases) {
    const res = await render(f.sid, body);
    assert.deepEqual([res.status, res.body.field], [400, field], JSON.stringify(body));
  }
  assert.match((await render(f.sid, { compositionIds: otherIds })).body.error, new RegExp(`"${otherIds[0]}" is not one of this Concept's thumbnail stills`));
  assert.equal((await view(f)).thumbnail.rounds.length, calls);
  assert.equal(currentRound(await view(f)).call.status, 'done');
  assert.equal(video.state.stills.length, asked);
  assert.deepEqual(await readdir(roundDir(f, 1)), ['thumb-01.png', 'thumb-02.png']);
  const empty = await withSession(f.b);
  assert.match((await render(empty.sid, { compositionIds: ['thumb-x-a'] })).body.error, /none exist yet/);
});

test('TI17/TI18 tool refusals: 401, 400, 404, ended, finalized, old round, busy; other tabs and tools 409', async () => {
  const f = await withSession(undefined, [LI_VIDEO, IG_IMAGE]);
  const ids = await stills(f, ['one', 'two']);
  const unknown = '00000000-0000-4000-8000-000000000000';
  assert.equal((await tool('POST', '/thumbnails', f.sid, { compositionIds: ids }, 'wrong')).status, 401);
  assert.equal((await tool('POST', '/thumbnails', undefined, { compositionIds: ids })).status, 400);
  assert.equal((await tool('POST', '/thumbnails', unknown, { compositionIds: ids })).status, 404);
  assert.equal((await tool('POST', '/thumbnails', f.sid, [ids])).status, 400, 'a body that is not an object');
  // A call already running for this asset.
  video.state.stillGate = gate();
  video.state.stillGateAt = 1;
  const pending = render(f.sid, { compositionIds: ids });
  await waitFor(() => video.state.stills.length === 1, 'held');
  const busy = await render(f.sid, { compositionIds: ids });
  assert.deepEqual([busy.status, busy.body.error], [409, 'A render is already running or waiting for these thumbnails']);
  video.state.stillGate.open();
  assert.equal((await pending).status, 200);
  // Wrong tabs and tools.
  assert.equal((await tool('POST', '/images', f.sid, { compositionIds: ids })).status, 409, 'render_images from a thumbnail session');
  assert.equal((await tool('POST', '/checklist', f.sid, { items: [{ id: 'a', label: 'A' }] })).status, 409, 'set_checklist from a thumbnail session');
  assert.equal((await tool('GET', '/media', f.sid)).status, 200, 'list_media is a thumbnail tool');
  const imageAid = f.body.posts.find((p: any) => p.format === 'image').needs.find((a: any) => a.kind === 'image-set').id;
  await t.send('POST', f.c(`/assets/${imageAid}/session`));
  const imageSid = (await waitFor(async () => (await t.api(f.c(`/assets/${imageAid}/session`))).body.session, 'image session')).id;
  assert.equal((await render(imageSid, { compositionIds: ids })).status, 409, 'an images session');
  const scriptAid = f.body.assets.find((a: any) => a.kind === 'script').id;
  const scriptSid = (await t.send('POST', f.c(`/assets/${scriptAid}/session`))).body.session.id;
  assert.equal((await render(scriptSid, { compositionIds: ids })).status, 409, 'a script session');
  // Old round, finalized, ended.
  assert.equal((await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`))).status, 200);
  assert.equal((await render(f.sid, { compositionIds: ids })).status, 409, 'old round');
  const round2 = (await view(f)).session.id;
  await render(round2, { compositionIds: await stills(f, ['one']) });
  assert.equal((await finalize(f)).status, 200);
  assert.equal((await render(round2, { compositionIds: ids })).status, 409, 'finalized');
  const g = await withSession(f.b);
  terminal.live.delete(g.sid);
  assert.equal((await render(g.sid, { compositionIds: await stills(g, ['a']) })).status, 409, 'ended');
});

test('TI19/TI23 a new call clears the round at once; a renderer error fails the call, keeps what it made and blocks Finalize', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b', 'c']);
  assert.equal((await render(f.sid, { compositionIds: ids })).status, 200);
  video.state.stillGate = gate();
  video.state.stillGateAt = video.state.stills.length + 1;
  const pending = render(f.sid, { compositionIds: ids.slice(0, 1) });
  await waitFor(() => video.state.stillGate !== null && video.state.stills.length === 4, 'held');
  assert.deepEqual(await readdir(roundDir(f, 1)).catch(() => []), [], 'the old PNGs are gone');
  video.state.stillGate.open();
  await pending;
  video.state.stillGate = null;
  video.state.stillErrorFor = ids[1]!;
  const res = await render(f.sid, { compositionIds: ids });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, `Render failed: thumbnail 2 (${ids[1]}): Cannot find module './${ids[1]}'`);
  const v = await view(f);
  assert.deepEqual([currentRound(v).call.status, currentRound(v).thumbnails.map((x: any) => x.name)], ['failed', ['thumb-01.png']]);
  assert.equal(v.thumbnail.finalizeBlocked, 'The last render did not finish, so there is no complete set. Render again to finalize.');
});

test('TI22 time limits: a slow thumbnail and a slow call fail naming the thumbnail', async () => {
  videoDeps.configureVideo({ imageLimits: { stillTimeoutMs: 40, callTimeoutMs: 20_000 } });
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  video.state.stillGate = gate();
  video.state.stillGateAt = 2;
  const res = await render(f.sid, { compositionIds: ids });
  assert.equal(res.body.error, `Render failed: thumbnail 2 (${ids[1]}) timed out after 40 ms`);
  assert.deepEqual(await readdir(roundDir(f, 1)), ['thumb-01.png']);
  video.state.stillGate = null;
  videoDeps.configureVideo({ imageLimits: { stillTimeoutMs: 10_000, callTimeoutMs: 0 } });
  assert.equal((await render(f.sid, { compositionIds: ids })).body.error, `Render failed: the render_thumbnails call ran over 0 ms while rendering thumbnail 1 (${ids[0]})`);
});

test('TI24 Stop: a running call is stopped; a finished one is 409; an unknown or another asset\'s render 404; a read-only Building 409', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  video.state.stillGate = gate();
  video.state.stillGateAt = 2;
  const pending = render(f.sid, { compositionIds: ids });
  const running = await waitFor(async () => { const r = currentRound(await view(f)); return r?.call?.status === 'running' && r.call.done === 1 ? r : null; }, 'running');
  assert.equal((await t.send('POST', `${thumbsBase(f)}/renders/${running.call.id}/stop`)).status, 200);
  assert.deepEqual([(await pending).status, (await pending).body.error], [409, 'The render was stopped']);
  assert.equal(currentRound(await view(f)).call.status, 'stopped');
  assert.equal(jobEvents.filter((e) => e.job.id === running.call.id).at(-1).job.status, 'stopped');
  assert.equal((await t.send('POST', `${thumbsBase(f)}/renders/${running.call.id}/stop`)).status, 409);
  assert.equal((await t.send('POST', `${thumbsBase(f)}/renders/11111111-1111-4111-8111-111111111111/stop`)).status, 404);
  const other = await withSession(f.b);
  assert.equal((await t.send('POST', `${thumbsBase(other)}/renders/${running.call.id}/stop`)).status, 404, "another asset's render");
  await t.projectsDb.update(f.b, { readOnlyReason: 'Read-only for the test' });
  assert.equal((await t.send('POST', `${thumbsBase(f)}/renders/${running.call.id}/stop`)).status, 409);
  await t.projectsDb.update(f.b, { readOnlyReason: undefined });
});

test('TI20/TI21/TI25 one queue per Building: a thumbnail waits for a video render; an image call waits for a thumbnail; another Building runs in parallel', async () => {
  const f = await withSession(undefined, [LI_VIDEO], 'Thumb concept');
  const ids = await stills(f, ['a', 'b']);
  // A video render of another Concept in the same Building holds the queue.
  const reel = await concept(f.b, [IG_REEL], 'Video concept');
  const scriptAid = reel.body.assets.find((a: any) => a.kind === 'script').id;
  const videoAid = reel.body.assets.find((a: any) => a.kind === 'video').id;
  const ss = (await t.send('POST', reel.c(`/assets/${scriptAid}/session`))).body.session.id;
  await tool('POST', '/draft', ss, { text: 'Script' });
  await t.send('POST', reel.c(`/assets/${scriptAid}/finalize`));
  const vsid = (await waitFor(async () => (await t.api(reel.c(`/assets/${videoAid}/session`))).body.session, 'video session')).id;
  await tool('POST', '/checklist', vsid, { items: [{ id: 'a', label: 'A' }] });
  await t.send('PATCH', reel.c('/video/checklist/a'), { ticked: true });
  await t.send('POST', reel.c('/video/confirm'));
  video.state.renderGate = gate();
  const videoRender = t.send('POST', reel.c(`/assets/${videoAid}/finalize`));
  await waitFor(() => video.state.renders.length === 1, 'video running');
  const call = render(f.sid, { compositionIds: ids });
  const queued = await waitFor(async () => { const r = currentRound(await view(f)); return r?.call?.status === 'queued' ? r : null; }, 'thumbnail queued');
  assert.deepEqual([queued.call.waitingFor, queued.call.queuePosition], [{ conceptTitle: 'Video concept', kind: 'video' }, 1]);
  assert.equal(video.state.stills.length, 0);
  assert.deepEqual((await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.buildingId === f.b).map((j: any) => j.kind), ['render'], 'a queued thumbnail job is not listed');
  video.state.renderError = 'first render fails';
  video.state.renderGate.open();
  await videoRender;
  const done = await call;
  assert.deepEqual([done.status, done.body.queued], [200, true]);
  await service.video.settled();
  video.state.renderError = null;

  // An image call waits behind a thumbnail render.
  const img = await concept(f.b, [IG_IMAGE], 'Image concept');
  const imageAid = img.body.posts[0].needs.find((a: any) => a.kind === 'image-set').id;
  await t.send('POST', img.c(`/assets/${imageAid}/session`));
  const isid = (await waitFor(async () => (await t.api(img.c(`/assets/${imageAid}/session`))).body.session, 'image session')).id;
  const stillDir = path.join(remotion(f), 'src', 'concepts', img.cid, 'images', img.body.posts[0].id);
  await mkdir(stillDir, { recursive: true });
  await writeFile(path.join(stillDir, 'x.tsx'), 'export const still = { component: () => null };\n');
  video.state.stillGate = gate();
  video.state.stillGateAt = video.state.stills.length + 1;
  const thumbFirst = render(f.sid, { compositionIds: ids });
  await waitFor(async () => currentRound(await view(f))?.call?.status === 'running', 'thumbnail running');
  const listed = (await t.api('/api/content/jobs/running')).body.jobs.find((j: any) => j.kind === 'thumbnail' && j.buildingId === f.b);
  assert.deepEqual([listed.conceptId, listed.assetId, listed.done, listed.total], [f.cid, f.aid, 0, 2]);
  const imageCall = tool('POST', '/images', isid, { compositionIds: [`still-${img.body.posts[0].id.replace(/-/g, '').slice(0, 8)}-x`] });
  const waiting = await waitFor(async () => {
    const r = (await t.api(img.c(`/assets/${imageAid}/session`))).body.images.rounds[0];
    return r?.call?.status === 'queued' ? r : null;
  }, 'image queued');
  assert.deepEqual(waiting.call.waitingFor, { conceptTitle: 'Thumb concept', kind: 'thumbnail' });
  // Another Building renders in parallel.
  const elsewhere = await withSession();
  assert.equal((await render(elsewhere.sid, { compositionIds: await stills(elsewhere, ['p']) })).status, 200);
  video.state.stillGate.open();
  assert.equal((await thumbFirst).status, 200);
  assert.equal((await imageCall).status, 200);
});

test('TI26 after a restart a running thumbnail render reads failed and a waiting one stopped', async () => {
  const f = await withSession();
  const db = (await ctxOf(f)).db;
  db.prepare("INSERT INTO image_renders (id, assetId, round, status, compositionIds, width, height, createdAt) VALUES ('11111111-1111-4111-8111-111111111111', ?, 1, 'running', '[\"a\"]', 1280, 720, 1)").run(f.aid);
  assert.deepEqual([currentRound(await view(f)).call.status, currentRound(await view(f)).call.error], ['failed', 'Interrupted by a daemon restart']);
  db.prepare("INSERT INTO image_renders (id, assetId, round, status, compositionIds, width, height, createdAt) VALUES ('22222222-2222-4222-8222-222222222222', ?, 1, 'queued', '[\"a\"]', 1280, 720, 2)").run(f.aid);
  assert.deepEqual([currentRound(await view(f)).call.status, currentRound(await view(f)).call.error], ['stopped', 'Interrupted by a daemon restart']);
});

test('TI28 alt text through save_draft: trimmed lines; 21 lines or empty is 400', async () => {
  const f = await withSession();
  assert.equal((await tool('POST', '/draft', f.sid, { text: '  Bold title on navy  \r\nCalm photo ' })).status, 200);
  assert.equal((await view(f)).rounds.at(-1).draft.text, 'Bold title on navy\nCalm photo');
  assert.equal((await tool('POST', '/draft', f.sid, { text: Array(21).fill('x').join('\n') })).status, 400);
  assert.equal((await tool('POST', '/draft', f.sid, { text: '  ' })).status, 400);
});

// ---- finalize, reopen, new rounds ---------------------------------------------------------------

test('TI29/TI30/TI33 finalize keeps the pick (or the only one), ends the session and starts no retro', async () => {
  const f = await withSession();
  await render(f.sid, { compositionIds: await stills(f, ['a', 'b', 'c']) });
  const fin = await finalize(f, { file: 'thumb-02.png' });
  assert.equal(fin.status, 200, fin.text);
  assert.equal(fin.body.asset.state, 'finalized');
  assert.equal(fin.body.asset.content, '["thumbnail/round-1/thumb-02.png"]');
  assert.deepEqual(fin.body.thumbnail.final, { round: 1, name: 'thumb-02.png', url: `/api/projects/${f.b}/content/assets/${f.aid}/thumbnail/rounds/1/thumb-02.png`, downloadUrl: `/api/projects/${f.b}/content/assets/${f.aid}/thumbnail/rounds/1/thumb-02.png?download=1` });
  assert.ok(terminal.stops.includes(f.sid));
  assert.equal(fin.body.retro, null, 'no writing-style retro');

  const one = await withSession(f.b);
  await render(one.sid, { compositionIds: await stills(one, ['only']) });
  const single = await finalize(one);
  assert.equal(single.status, 200, single.text);
  assert.equal(single.body.asset.content, '["thumbnail/round-1/thumb-01.png"]');
});

test('TI31/TI32 finalize: 400 for a missing or wrong pick; 409 with no call, a running call, a failed one or a missing file', async () => {
  const f = await withSession();
  assert.deepEqual([(await finalize(f, { file: 'thumb-01.png' })).status, (await finalize(f)).body.error], [409, 'Finalize needs a rendered thumbnail. Ask the agent to render one.']);
  const ids = await stills(f, ['a', 'b', 'c']);
  video.state.stillGate = gate();
  video.state.stillGateAt = 1;
  const pending = render(f.sid, { compositionIds: ids });
  await waitFor(() => video.state.stills.length === 1, 'running');
  assert.deepEqual([(await finalize(f, { file: 'thumb-01.png' })).status, (await finalize(f, { file: 'thumb-01.png' })).body.error], [409, 'Finalize is available once the render finishes.']);
  video.state.stillGate.open();
  await pending;
  video.state.stillGate = null;
  for (const body of [undefined, { file: 'thumb-04.png' }, { file: 'thumb-2.png' }, { file: '../x' }, { file: 2 }, { file: ' thumb-02.png' }]) {
    const res = await finalize(f, body);
    assert.deepEqual([res.status, res.body.field], [400, 'file'], JSON.stringify(body));
  }
  assert.equal((await view(f)).asset.state, 'drafting');
  await rm(path.join(roundDir(f, 1), 'thumb-02.png'));
  assert.equal((await finalize(f, { file: 'thumb-01.png' })).status, 409, 'a file gone on disk means no complete set');
  video.state.stillErrorFor = ids[2]!;
  await render(f.sid, { compositionIds: ids });
  assert.equal((await finalize(f, { file: 'thumb-01.png' })).status, 409, 'the newest call failed');
  assert.equal((await view(f)).asset.state, 'drafting');
});

test('TI34 reopen: round 2 keeps the still code and round-1 PNGs; 409 when not finalized or used by a published post', async () => {
  const f = await withSession(undefined, [LI_VIDEO]);
  assert.equal((await t.send('POST', f.c(`/assets/${f.aid}/reopen`))).status, 409, 'not finalized');
  await render(f.sid, { compositionIds: await stills(f, ['a', 'b']) });
  await finalize(f, { file: 'thumb-01.png' });
  const ctx = await ctxOf(f);
  const postId = f.body.posts[0].id;
  ctx.db.prepare("UPDATE posts SET status = 'published' WHERE id = ?").run(postId);
  const blocked = await t.send('POST', f.c(`/assets/${f.aid}/reopen`));
  assert.deepEqual([blocked.status, blocked.body.error], [409, 'Used by a published post']);
  ctx.db.prepare("UPDATE posts SET status = 'draft' WHERE id = ?").run(postId);
  const re = await t.send('POST', f.c(`/assets/${f.aid}/reopen`));
  assert.equal(re.status, 200, re.text);
  assert.deepEqual([re.body.asset.state, re.body.session.round, re.body.thumbnail.final], ['drafting', 2, null]);
  assert.deepEqual((await readdir(codeDir(f))).sort(), ['a.tsx', 'b.tsx']);
  assert.equal((await t.api(`${thumbsBase(f)}/rounds/1/thumb-01.png`)).status, 200);
});

test('TI35 Start a new session stops the call, archives the code and starts round N+1 fresh; a failed launch restores; no agent is 409', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  await render(f.sid, { compositionIds: ids });
  video.state.stillGate = gate();
  video.state.stillGateAt = video.state.stills.length + 1;
  const pending = render(f.sid, { compositionIds: ids });
  await waitFor(async () => currentRound(await view(f))?.call?.status === 'running', 'running');
  let filesAtLaunch: string[] | null = null;
  const push = terminal.starts.push.bind(terminal.starts);
  terminal.starts.push = (...items) => { filesAtLaunch = readdirSync(codeDir(f)); return push(...items); };
  const res = await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`));
  terminal.starts.push = push;
  assert.equal(res.status, 200, res.text);
  assert.equal((await pending).body.error, 'The render was stopped');
  video.state.stillGate.open();
  assert.deepEqual(filesAtLaunch, []);
  assert.deepEqual(await readdir(codeDir(f)), []);
  const archive = path.join(remotion(f), 'archive', f.cid, 'thumbnail', 'round-1');
  assert.deepEqual((await readdir(archive)).sort(), ['a.tsx', 'b.tsx']);
  assert.doesNotMatch(await readFile(registry(f), 'utf8'), new RegExp(ids[0]!));
  assert.equal(res.body.session.round, 2);
  assert.equal(terminal.starts.at(-1)!.resume, false);

  await stills(f, ['c']);
  terminal.starts.push = () => { throw new Error('spawn failed'); };
  const failed = await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`));
  terminal.starts.push = push;
  assert.equal(failed.status, 500);
  assert.deepEqual(await readdir(codeDir(f)), ['c.tsx']);
  assert.equal(existsSync(path.join(remotion(f), 'archive', f.cid, 'thumbnail', 'round-2')), false);
  defaultAgent = null;
  assert.equal((await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`))).status, 409);
  assert.deepEqual(await readdir(codeDir(f)), ['c.tsx']);
});

test('TI36 the video\'s and the images\' new sessions leave the thumbnail code alone', async () => {
  const f = await withSession(undefined, [IG_REEL, IG_IMAGE]);
  await stills(f, ['keep']);
  const imageAid = f.body.posts.find((p: any) => p.format === 'image').needs.find((a: any) => a.kind === 'image-set').id;
  await t.send('POST', f.c(`/assets/${imageAid}/session`));
  await waitFor(async () => (await t.api(f.c(`/assets/${imageAid}/session`))).body.asset.state === 'drafting', 'image drafting');
  assert.equal((await t.send('POST', f.c(`/assets/${imageAid}/session/new-round`))).status, 200);
  assert.deepEqual(await readdir(codeDir(f)), ['keep.tsx']);
  const scriptAid = f.body.assets.find((a: any) => a.kind === 'script').id;
  const videoAid = f.body.assets.find((a: any) => a.kind === 'video').id;
  const ss = (await t.send('POST', f.c(`/assets/${scriptAid}/session`))).body.session.id;
  await tool('POST', '/draft', ss, { text: 'Script' });
  await t.send('POST', f.c(`/assets/${scriptAid}/finalize`));
  await service.settled();
  await waitFor(async () => (await t.api(f.c(`/assets/${videoAid}/session`))).body.session, 'video session');
  assert.equal((await t.send('POST', f.c(`/assets/${videoAid}/session/new-round`))).status, 200);
  assert.deepEqual(await readdir(codeDir(f)), ['keep.tsx']);
  assert.equal(existsSync(path.join(remotion(f), 'archive', f.cid, 'round-1', 'thumbnail')), false, 'no thumbnail in the video archive');
});

// ---- deletion, read-only, files -----------------------------------------------------------------

test('TI10 deleting the Concept stops a running call and removes the rows, code, archives, PNGs and registry entries', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  await render(f.sid, { compositionIds: ids });
  assert.equal((await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`))).status, 200);
  const round2 = (await view(f)).session.id;
  const ids2 = await stills(f, ['c', 'd']);
  video.state.stillGate = gate();
  video.state.stillGateAt = video.state.stills.length + 1;
  const pending = render(round2, { compositionIds: ids2 });
  await waitFor(async () => currentRound(await view(f))?.call?.status === 'running', 'running');
  assert.match(await readFile(registry(f), 'utf8'), new RegExp(ids2[0]!));
  const db = (await ctxOf(f)).db;
  assert.equal((await t.send('DELETE', f.c(''))).status, 204);
  assert.equal((await pending).status, 409);
  video.state.stillGate.open();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assets WHERE id = ?').get(f.aid) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM image_renders WHERE assetId = ?').get(f.aid) as { n: number }).n, 0);
  assert.equal(existsSync(codeDir(f)), false);
  assert.equal(existsSync(path.join(remotion(f), 'archive', f.cid)), false);
  assert.equal(existsSync(roundDir(f, 1)), false);
  assert.doesNotMatch(await readFile(registry(f), 'utf8'), /thumb-/);
});

test('TI44 a read-only Building refuses the thumbnail session writes and serves the GETs', async () => {
  const f = await withSession();
  await render(f.sid, { compositionIds: await stills(f, ['a']) });
  await t.projectsDb.update(f.b, { readOnlyReason: 'Read-only for the test' });
  for (const route of [`/assets/${f.aid}/session`, `/assets/${f.aid}/session/new-round`, `/assets/${f.aid}/finalize`, `/assets/${f.aid}/reopen`]) assert.equal((await t.send('POST', f.c(route))).status, 409, route);
  for (const route of [f.c(`/assets/${f.aid}/session`), `${thumbsBase(f)}/rounds/1/thumb-01.png`]) assert.equal((await t.api(route)).status, 200, route);
  await t.projectsDb.update(f.b, { readOnlyReason: undefined });
});

test('TI38/TI39 thumbnail route: png, nosniff, inline or attachment; 404 for bad rounds, names, other assets and other types; image routes refuse it', async () => {
  const f = await withSession(undefined, [LI_VIDEO, IG_IMAGE]);
  await render(f.sid, { compositionIds: await stills(f, ['a', 'b']) });
  const ok = await t.api(`${thumbsBase(f)}/rounds/1/thumb-02.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ok.headers.get('content-disposition')!, /^inline/);
  assert.match((await t.api(`${thumbsBase(f)}/rounds/1/thumb-02.png?download=1`)).headers.get('content-disposition')!, /^attachment; filename="round-1-thumb-02.png"/);
  for (const p of ['/rounds/2/thumb-01.png', '/rounds/0/thumb-01.png', '/rounds/-1/thumb-01.png', '/rounds/1.5/thumb-01.png', '/rounds/abc/thumb-01.png', '/rounds/1/thumb-06.png', '/rounds/1/image-01.png', '/rounds/1/..%2Fthumb-01.png', '/rounds/1/thumb-03.png']) {
    assert.equal((await t.api(`${thumbsBase(f)}${p}`)).status, 404, p);
  }
  const imageAid = f.body.posts.find((p: any) => p.format === 'image').needs.find((a: any) => a.kind === 'image-set').id;
  const videoAid = f.body.assets.find((a: any) => a.kind === 'video').id;
  for (const aid of [imageAid, videoAid, 'not-a-uuid']) assert.equal((await t.api(t.c(f.b, `/assets/${aid}/thumbnail/rounds/1/thumb-01.png`))).status, 404, aid);
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  assert.equal((await t.api(`/api/projects/${seo.body.id}/content/assets/${f.aid}/thumbnail/rounds/1/thumb-01.png`)).status, 404);
  assert.equal((await t.api(`/api/projects/00000000-0000-4000-8000-000000000000/content/assets/${f.aid}/thumbnail/rounds/1/thumb-01.png`)).status, 404);
  assert.equal((await t.api(t.c(f.b, `/assets/${f.aid}/images/rounds/1/image-01.png`))).status, 404, 'TI39: the image routes refuse a thumbnail');
});

test('TI40/TI41/TI42 the publish media: video and reel posts get the thumbnail and its download; text and image posts none; publishing is unchanged', async () => {
  const f = await withSession(undefined, [LI_VIDEO, IG_REEL, LI_TEXT, IG_IMAGE]);
  const [vp, reel, text, image] = ['video', 'reel', 'text', 'image'].map((format) => f.body.posts.find((p: any) => p.format === format));
  const media = (p: any) => t.api(f.c(`/posts/${p.id}/media`));
  assert.equal((await media(vp)).body.thumbnail, null, 'not finalized yet');
  assert.equal((await t.api(f.c(`/posts/${vp.id}/media/thumbnail`))).status, 404);
  await render(f.sid, { compositionIds: await stills(f, ['a', 'b']) });
  assert.equal((await finalize(f, { file: 'thumb-02.png' })).status, 200);
  for (const p of [vp, reel]) assert.deepEqual((await media(p)).body.thumbnail, { name: 'thumb-02.png', missing: false }, p.format);
  for (const p of [text, image]) assert.equal((await media(p)).body.thumbnail, null, p.format);
  const file = await t.api(f.c(`/posts/${vp.id}/media/thumbnail`));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.match(file.headers.get('content-disposition')!, /^attachment; filename\*=UTF-8''thumb-02\.png/);
  assert.equal((await t.api(f.c(`/posts/${text.id}/media/thumbnail`))).status, 404);

  // TI42: a video post with every asset finalized publishes and unpublishes as before.
  const ctx = await ctxOf(f);
  const { setAssetState } = await import('../src/content/concepts.ts');
  setAssetState(ctx, vp.needs[0].id, 'finalized', 'Text');
  setAssetState(ctx, vp.needs[1].id, 'finalized', 'render');
  assert.equal((await t.send('POST', f.c(`/posts/${vp.id}/finalize`))).status, 200);
  const published = await t.send('POST', f.c(`/posts/${vp.id}/publish`), { liveUrl: 'https://www.linkedin.com/feed/update/1' });
  assert.equal(published.body.status, 'published', published.text);
  assert.equal((await t.send('POST', f.c(`/posts/${vp.id}/unpublish`))).body.status, 'finalized');

  await rm(path.join(roundDir(f, 1), 'thumb-02.png'));
  assert.deepEqual((await media(vp)).body.thumbnail, { name: 'thumb-02.png', missing: true });
  assert.equal((await t.api(f.c(`/posts/${vp.id}/media/thumbnail`))).status, 404);
  ctx.db.prepare('UPDATE assets SET content = ? WHERE id = ?').run('["../../x.png"]', f.aid);
  assert.equal((await t.api(f.c(`/posts/${vp.id}/media/thumbnail`))).status, 404, 'a path that leaves the Concept folder');
});
