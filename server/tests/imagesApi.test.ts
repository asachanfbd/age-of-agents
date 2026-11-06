import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import yauzl from 'yauzl';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';
import { fakeVideo, gate, pngSize, waitFor } from './helpers/videoFakes.ts';

/**
 * The Images tab end to end through the real daemon routes (`api/imageRoutes.ts`, `content/imageStudio.ts`): image sessions in the
 * shared Remotion project, `render_images` with the fake still renderer, round folders, the shared render queue and its jobs,
 * Finalize's count rule, Reopen, new rounds and the file routes. The terminal host, npm install and renderers are fakes; every file
 * lives in a temp folder.
 */

let t: ContentApi;
let terminal: ReturnType<typeof fakeTerminalHost>;
let service: StudioSessions;
let video: ReturnType<typeof fakeVideo>;
let token: string;
let home: string;
let defaultAgent: string | null = 'test-claude-cli';
let videoDeps: typeof import('../src/content/videoDeps.ts');
const events: any[] = [];
const jobEvents: any[] = [];

const IMAGE_LIMITS = { stillTimeoutMs: 10_000, callTimeoutMs: 20_000 };
const SKILL_TEXT = '# Human content writing\n\nAvoid AI patterns.';

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'images-home-'));
  t = await startContentApi(async () => {
    const mod = await import('../src/content/studioSessions.ts');
    videoDeps = await import('../src/content/videoDeps.ts');
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
  videoDeps.configureVideo({ installer: video.installer, renderer: video.renderer, stillRenderer: video.stillRenderer, prober: video.prober, imageLimits: { ...IMAGE_LIMITS }, submitDelayMs: 0 });
});

// ---- helpers -----------------------------------------------------------------------------------

const AT = '2026-11-03T09:00:00Z';
const IG_CAROUSEL = { platform: 'instagram', format: 'carousel', scheduledAt: AT };

interface Fx { b: string; cid: string; pid: string; aid: string; c: (s: string) => string; title: string; body: any }

async function concept(b?: string, post: Record<string, string> = IG_CAROUSEL, title = 'Launch', extra: unknown[] = []): Promise<Fx> {
  const building = b ?? await t.createStudio('Acme');
  const c = await t.send('POST', t.c(building, '/concepts'), { title, brief: 'Why', posts: [post, ...extra] });
  assert.equal(c.status, 201, c.text);
  const first = c.body.posts[0];
  return {
    b: building, cid: c.body.id, pid: first.id, aid: first.needs.find((a: any) => a.kind === 'image-set').id, title, body: c.body,
    c: (s: string) => t.c(building, `/concepts/${c.body.id}${s}`),
  };
}

const tool = (method: string, route: string, sessionId: string | undefined, body?: unknown, auth = token) => t.api(`/api/studio-session${route}${sessionId ? `?taskId=${sessionId}` : ''}`, {
  method, headers: auth ? { authorization: `Bearer ${auth}` } : {}, body: body === undefined ? undefined : JSON.stringify(body),
});
const view = async (f: Fx) => (await t.api(f.c(`/assets/${f.aid}/session`))).body;
const remotion = (f: Fx) => path.join(t.dataDir, 'buildings', f.b, 'remotion');
const stillsDir = (f: Fx) => path.join(remotion(f), 'src', 'concepts', f.cid, 'images', f.pid);
const roundDir = (f: Fx, round: number) => path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'posts', f.pid, 'images', `round-${round}`);

/** A Concept whose image-set has a running session in round 1, after the fake Remotion setup. */
async function withSession(b?: string, post: Record<string, string> = IG_CAROUSEL, title?: string): Promise<Fx & { sid: string }> {
  const f = await concept(b, post, title);
  const res = await t.send('POST', f.c(`/assets/${f.aid}/session`));
  assert.equal(res.status, 201, res.text);
  const v = await waitFor(async () => { const x = await view(f); return x.session?.state === 'running' && x.asset.state === 'drafting' ? x : null; }, 'image session');
  return { ...f, sid: v.session.id };
}

/** Writes still files for the post and returns their composition ids, in name order. */
async function stills(f: Fx, names: string[]): Promise<string[]> {
  await mkdir(stillsDir(f), { recursive: true });
  for (const name of names) await writeFile(path.join(stillsDir(f), `${name}.tsx`), `export const still = { component: () => null }; // ${name}\n`);
  const prefix = `still-${f.pid.replace(/-/g, '').slice(0, 8)}`;
  return names.map((n) => `${prefix}-${n}`);
}
const slideNames = (n: number) => Array.from({ length: n }, (_, i) => `slide-${String(i + 1).padStart(2, '0')}`);

const renderImages = (sid: string, body: unknown) => tool('POST', '/images', sid, body);
const finalize = (f: Fx) => t.send('POST', f.c(`/assets/${f.aid}/finalize`));
const imagesBase = (f: Fx) => t.c(f.b, `/assets/${f.aid}/images`);
const currentRound = (v: any) => v.images.rounds.find((r: any) => r.round === v.asset.round);

function zipEntries(bytes: Buffer): Promise<{ name: string; method: number; data: Buffer }[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      const out: { name: string; method: number; data: Buffer }[] = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) { reject(e); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => { out.push({ name: entry.fileName, method: entry.compressionMethod, data: Buffer.concat(chunks) }); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
}

// ---- sessions --------------------------------------------------------------------------------------

test('I01/U19 POST session on an image set is 201: round 1 starts in remotion/ after the tracked setup, with the images tools', async () => {
  const f = await concept();
  assert.equal((await t.api(f.c(`/assets/${f.aid}/session`))).status, 200);
  const res = await t.send('POST', f.c(`/assets/${f.aid}/session`));
  assert.equal(res.status, 201, res.text);
  // The session record lands a moment before the asset moves to drafting.
  const v = await waitFor(async () => { const x = await view(f); return x.session && x.asset.state === 'drafting' ? x : null; }, 'session');
  assert.equal(v.session.tab, 'images');
  assert.equal(v.asset.state, 'drafting');
  assert.equal(v.images.setup.status, 'ready');
  assert.deepEqual(v.images.defaultSize, { width: 1080, height: 1350 });
  assert.deepEqual(v.images.range, { min: 2, max: 20 });
  assert.equal(v.images.finalizeBlocked, 'Finalize needs a rendered set: 2 to 20 images for an Instagram carousel.');
  const start = terminal.starts.find((s) => s.taskId === v.session.id)!;
  assert.equal(start.cwd, remotion(f));
  assert.deepEqual(start.mcpServers!.map((s) => s.tools), [['get_concept', 'get_performance', 'get_reference_content', 'save_draft', 'list_media', 'render_images']]);
  assert.ok(existsSync(stillsDir(f)), 'the still folder is scaffolded');
  assert.equal(video.state.installs, 1);
});

test('I30/U17/U18 instructions: post, size, count rule, text (finalized, else draft, else none), script, brand, media, skill', async () => {
  const skill = path.join(home, '.claude', 'skills', 'human-content-writing-skill', 'SKILL.md');
  await rm(skill, { force: true });
  const b = await t.createStudio('Brand');
  await t.send('PUT', t.c(b, '/knowledge/colours'), { colours: [{ name: 'Ink', hex: '#112233' }] });
  await t.api(t.c(b, '/knowledge/files?name=logo.svg'), { method: 'POST', body: '<svg xmlns="http://www.w3.org/2000/svg"/>', headers: { 'content-type': 'application/octet-stream' } });
  const none = await withSession(b, { platform: 'x', format: 'image', scheduledAt: AT });
  const p0 = terminal.starts.find((s) => s.taskId === none.sid)!.systemPrompt!;
  for (const part of ['Platform: X (Twitter)', 'Format: image', '1 to 4 images', '1600x900', 'No post text yet.', 'No finalized script yet.', 'Ink: #112233', '- logo.svg', 'src/brand/', 'list_media', 'Make no network requests', `src/concepts/${none.cid}/images/${none.pid}/`, 'Render only with `render_images`', path.join(t.dataDir, 'buildings', b, 'knowledge')]) {
    assert.ok(p0.includes(part), part);
  }
  assert.doesNotMatch(p0, /## Writing skill/);
  assert.equal((await view(none)).skillWarning, `Writing skill not found at ${skill}`);

  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, SKILL_TEXT);
  const f = await concept(b, { platform: 'linkedin', format: 'image', scheduledAt: AT });
  const textAid = f.body.posts[0].needs.find((a: any) => a.kind === 'post-text').id;
  const textSid = (await t.send('POST', f.c(`/assets/${textAid}/session`))).body.session.id;
  await tool('POST', '/draft', textSid, { text: 'Draft one' });
  await tool('POST', '/draft', textSid, { text: 'Draft two' });
  const s1 = await t.send('POST', f.c(`/assets/${f.aid}/session`));
  const draftPrompt = terminal.starts.find((s) => s.taskId === s1.body.session.id)!.systemPrompt!;
  assert.match(draftPrompt, /latest draft of the text[\s\S]*Draft two/);
  assert.ok(draftPrompt.includes(SKILL_TEXT), 'the skill text is included');
  assert.equal(s1.body.skillWarning, null);
  assert.match(draftPrompt, /exactly 1 image/);

  await t.send('POST', f.c(`/assets/${textAid}/finalize`));
  const scriptAid = f.body.assets.find((a: any) => a.kind === 'script').id;
  const ss = (await t.send('POST', f.c(`/assets/${scriptAid}/session`))).body.session.id;
  await tool('POST', '/draft', ss, { text: 'Spoken script' });
  await t.send('POST', f.c(`/assets/${scriptAid}/finalize`));
  await tool('POST', '/images', s1.body.session.id, { compositionIds: await stills(f, ['one']) });
  await finalize(f);
  const re = await t.send('POST', f.c(`/assets/${f.aid}/reopen`));
  const finalPrompt = terminal.starts.find((s) => s.taskId === re.body.session.id)!.systemPrompt!;
  assert.match(finalPrompt, /finalized text of this post[\s\S]*Draft two/);
  assert.ok(finalPrompt.includes(path.join('concepts', f.cid, 'script', 'script.md')));
  assert.match(finalPrompt, /reopened these images/);
  assert.equal(terminal.starts.find((s) => s.taskId === re.body.session.id)!.prompt, '');
  await rm(skill, { force: true });
});

// ---- render_images ---------------------------------------------------------------------------------

test('I03/I10/I17 happy path: PNGs in order at the size, the answer and the view list them, events per image', async () => {
  const f = await withSession();
  const ids = await stills(f, ['slide-01', 'slide-02', 'slide-03']);
  const before = events.length;
  const jobsBefore = jobEvents.length;
  const res = await renderImages(f.sid, { compositionIds: [ids[2], ids[0], ids[1]], width: 1000, height: 1200 });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.images.map((i: any) => [i.index, i.compositionId, i.width, i.height]), [[1, ids[2], 1000, 1200], [2, ids[0], 1000, 1200], [3, ids[1], 1000, 1200]]);
  assert.deepEqual(video.state.stills.map((s) => s.compositionId), [ids[2], ids[0], ids[1]]);
  assert.equal(video.state.stills[0]!.dir, remotion(f));
  assert.deepEqual(await readdir(roundDir(f, 1)), ['image-01.png', 'image-02.png', 'image-03.png']);
  assert.deepEqual(pngSize(await readFile(path.join(roundDir(f, 1), 'image-02.png'))), { width: 1000, height: 1200 });
  const v = await view(f);
  const round = currentRound(v);
  assert.equal(round.call.status, 'done');
  assert.deepEqual(round.images.map((i: any) => [i.index, i.name, i.compositionId, i.width, i.height]), [[1, 'image-01.png', ids[2], 1000, 1200], [2, 'image-02.png', ids[0], 1000, 1200], [3, 'image-03.png', ids[1], 1000, 1200]]);
  assert.ok(round.images[0].size > 20);
  assert.equal(round.images[0].url, `${imagesBase(f)}/rounds/1/image-01.png`);
  assert.equal(v.images.finalizeBlocked, null);
  const mine = events.slice(before).filter((e) => e.view.assetId === f.aid);
  const counts = mine.map((e) => currentRound(e.view)?.call?.done ?? 0);
  assert.ok([1, 2, 3].every((n) => counts.includes(n)), `a view per image: ${counts}`);
  const revs = mine.map((e) => e.view.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  const jobs = jobEvents.slice(jobsBefore).filter((e) => e.job.kind === 'images');
  assert.deepEqual(jobs.map((e) => [e.job.status, e.job.done]), [['running', 0], ['running', 1], ['running', 2], ['running', 3], ['complete', 3]]);
  assert.deepEqual([jobs[0].job.buildingId, jobs[0].job.conceptId, jobs[0].job.assetId, jobs[0].job.total], [f.b, f.cid, f.aid, 3]);
});

test('I04 an omitted size gives the post default, each side on its own; 320x4000 reaches the renderer unchanged', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  await renderImages(f.sid, { compositionIds: ids });
  assert.deepEqual([video.state.stills[0]!.width, video.state.stills[0]!.height], [1080, 1350]);
  await renderImages(f.sid, { compositionIds: ids, width: 320, height: 4000 });
  assert.deepEqual([video.state.stills[2]!.width, video.state.stills[2]!.height], [320, 4000]);
  await renderImages(f.sid, { compositionIds: ids, width: 900 });
  assert.deepEqual([video.state.stills[4]!.width, video.state.stills[4]!.height], [900, 1350]);
  const x = await withSession(f.b, { platform: 'x', format: 'image', scheduledAt: AT });
  await renderImages(x.sid, { compositionIds: await stills(x, ['wide']) });
  assert.deepEqual([video.state.stills[6]!.width, video.state.stills[6]!.height], [1600, 900]);
});

test('I05/I06 size and id refusals are 400 with their field; nothing renders, no job, the old images stay', async () => {
  const f = await withSession();
  const ids = await stills(f, slideNames(21));
  await renderImages(f.sid, { compositionIds: ids.slice(0, 2) });
  const renders = video.state.stills.length;
  const jobsBefore = jobEvents.length;
  for (const size of [{ width: 319 }, { width: 4001 }, { height: 0 }, { height: -1080 }, { width: 1080.5 }, { width: '1080' }, { width: true }, { width: null }, { height: 2 ** 53 }]) {
    const res = await renderImages(f.sid, { compositionIds: ids.slice(0, 2), ...size });
    assert.equal(res.status, 400, JSON.stringify(size));
    assert.equal(res.body.field, Object.keys(size)[0]);
    assert.match(res.body.error, /320 to 4,000/);
  }
  const other = await withSession(f.b);
  const otherIds = await stills(other, ['mine']);
  for (const compositionIds of [undefined, 'x', [], ids, [5], [''], [ids[0], ids[0]], [otherIds[0]], [`concept-${f.cid.slice(0, 8)}`], ['nope'], [ids[0]!.replace('slide', 'Slide')]]) {
    const res = await renderImages(f.sid, { compositionIds });
    assert.equal(res.status, 400, JSON.stringify(compositionIds)?.slice(0, 60));
    assert.equal(res.body.field, 'compositionIds');
  }
  assert.match((await renderImages(f.sid, { compositionIds: ['nope'] })).body.error, /"nope" is not one of this post's still compositions/);
  assert.equal(video.state.stills.length, renders);
  assert.equal(jobEvents.slice(jobsBefore).length, 0);
  assert.deepEqual(await readdir(roundDir(f, 1)), ['image-01.png', 'image-02.png']);
  assert.equal((await renderImages(f.sid, { compositionIds: ids.slice(0, 20) })).status, 200);
  assert.equal((await renderImages(f.sid, { compositionIds: ids.slice(0, 1) })).status, 200);
});

test('I07 tool refusals: 401, 400, 404, ended, finalized and old round 409; other tabs and other tools 409', async () => {
  const f = await withSession(undefined, { platform: 'instagram', format: 'image', scheduledAt: AT });
  const ids = await stills(f, ['one']);
  const unknown = '00000000-0000-4000-8000-000000000000';
  assert.equal((await tool('POST', '/images', f.sid, { compositionIds: ids }, 'wrong')).status, 401);
  assert.equal((await tool('POST', '/images', undefined, { compositionIds: ids })).status, 400);
  assert.equal((await tool('POST', '/images', unknown, { compositionIds: ids })).status, 404);
  assert.equal((await tool('POST', '/images', f.sid, [ids])).status, 400, 'a body that is not an object');
  assert.equal((await tool('POST', '/images', f.sid, null)).status, 400);
  assert.equal((await t.api(`/api/studio-session/images?taskId=${f.sid}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 400, 'no body: no ids');
  assert.equal((await tool('POST', '/render', f.sid, {})).status, 404, 'render_video is gone');
  assert.equal((await tool('POST', '/checklist', f.sid, { items: [{ id: 'a', label: 'A' }] })).status, 409);
  const media = await tool('GET', '/media', f.sid);
  assert.equal(media.status, 200);
  assert.equal(media.body.folder, `public/concepts/${f.cid}/media`);
  const textAid = f.body.posts[0].needs.find((a: any) => a.kind === 'post-text').id;
  const textSid = (await t.send('POST', f.c(`/assets/${textAid}/session`))).body.session.id;
  assert.equal((await renderImages(textSid, { compositionIds: ids })).status, 409);
  const scriptAid = f.body.assets.find((a: any) => a.kind === 'script').id;
  const scriptSid = (await t.send('POST', f.c(`/assets/${scriptAid}/session`))).body.session.id;
  assert.equal((await renderImages(scriptSid, { compositionIds: ids })).status, 409);

  const round1 = f.sid;
  await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`));
  assert.equal((await renderImages(round1, { compositionIds: ids })).status, 409, 'old round');
  const round2 = (await view(f)).session.id;
  await renderImages(round2, { compositionIds: await stills(f, ['one']) });
  assert.equal((await finalize(f)).status, 200);
  assert.equal((await renderImages(round2, { compositionIds: ids })).status, 409, 'finalized');
  const g = await withSession(f.b);
  terminal.live.delete(g.sid);
  assert.equal((await renderImages(g.sid, { compositionIds: await stills(g, ['a']) })).status, 409, 'ended');
});

test('I08/I09 a second call for the same asset while one runs is 409; a new call removes the old images at once', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b', 'c']);
  assert.equal((await renderImages(f.sid, { compositionIds: ids })).status, 200);
  video.state.stillGate = gate();
  video.state.stillGateAt = 4;
  const pending = renderImages(f.sid, { compositionIds: ids.slice(0, 2) });
  await waitFor(() => video.state.stills.length === 4, 'B held at its first image');
  assert.deepEqual(await readdir(roundDir(f, 1)).catch(() => []), [], "A's files are gone");
  assert.equal(currentRound(await view(f)).images.length, 0);
  const second = await renderImages(f.sid, { compositionIds: ids });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already running or waiting/);
  video.state.stillGate.open();
  assert.equal((await pending).status, 200);
  assert.equal(video.state.stills.length, 5, 'the refused call rendered nothing');
  assert.deepEqual(await readdir(roundDir(f, 1)), ['image-01.png', 'image-02.png']);
});

test('I11 a per-image timeout fails the call naming image 2; image 1 stays, image 3 is never asked for, no notification', async () => {
  const notifications = (await import('../src/db/collections.ts')).notificationsDb;
  const before = (await notifications.find(() => true)).length;
  videoDeps.configureVideo({ imageLimits: { stillTimeoutMs: 40, callTimeoutMs: 20_000 } });
  const f = await withSession();
  const ids = await stills(f, ['a', 'b', 'c']);
  video.state.stillGate = gate();
  video.state.stillGateAt = 2;
  const res = await renderImages(f.sid, { compositionIds: ids });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, `Render failed: image 2 (${ids[1]}) timed out after 40 ms`);
  assert.equal(video.state.stills.length, 2);
  assert.deepEqual(await readdir(roundDir(f, 1)), ['image-01.png']);
  const round = currentRound(await view(f));
  assert.deepEqual([round.call.status, round.call.done, round.images.length], ['failed', 1, 1]);
  assert.match(round.call.error, /image 2/);
  assert.equal(jobEvents.filter((e) => e.job.id === round.call.id).at(-1).job.status, 'failed');
  assert.equal((await notifications.find(() => true)).length, before);
});

test('I12 a per-call timeout fails naming the image in progress; earlier images stay', async () => {
  videoDeps.configureVideo({ imageLimits: { stillTimeoutMs: 10_000, callTimeoutMs: 60 } });
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  video.state.stillGate = gate();
  video.state.stillGateAt = 2;
  const res = await renderImages(f.sid, { compositionIds: ids });
  assert.equal(res.status, 409);
  assert.match(res.body.error, new RegExp(`while rendering image 2 \\(${ids[1]}\\)`));
  assert.deepEqual(await readdir(roundDir(f, 1)), ['image-01.png']);
  video.state.stillGate = null;
  videoDeps.configureVideo({ imageLimits: { stillTimeoutMs: 10_000, callTimeoutMs: 0 } });
  assert.match((await renderImages(f.sid, { compositionIds: ids })).body.error, new RegExp(`ran over 0 ms while rendering image 1 \\(${ids[0]}\\)`), 'no time left before the first image');
  // A renderer that ignores the abort and finishes late still fails the call by its limit.
  videoDeps.configureVideo({ imageLimits: { stillTimeoutMs: 5, callTimeoutMs: 10_000 }, stillRenderer: { still: async (r) => { await new Promise((x) => setTimeout(x, 30)); await writeFile(r.output, 'late'); } } });
  assert.match((await renderImages(f.sid, { compositionIds: ids })).body.error, /image 1 \(.*\) timed out after 5 ms/);
});

test('I13 a renderer failure is in the answer and the view; partial images stay; no notification', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b', 'c']);
  video.state.stillErrorFor = ids[2]!;
  const res = await renderImages(f.sid, { compositionIds: ids });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, `Render failed: image 3 (${ids[2]}): Cannot find module './${ids[2]}'`);
  const v = await view(f);
  assert.equal(currentRound(v).call.status, 'failed');
  assert.equal(currentRound(v).images.length, 2);
  assert.equal(v.images.finalizeBlocked, 'The last render did not finish, so there is no complete set. Render again to finalize.');
});

test('I14/I15 Stop while running and while queued; a finished render is 409, an unknown one 404', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  video.state.stillGate = gate();
  video.state.stillGateAt = 2;
  const pending = renderImages(f.sid, { compositionIds: ids });
  const running = await waitFor(async () => { const r = currentRound(await view(f)); return r?.call?.status === 'running' && r.call.done === 1 ? r : null; }, 'running');
  assert.equal((await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.id === running.call.id).length, 1);
  assert.equal((await t.send('POST', `${imagesBase(f)}/renders/${running.call.id}/stop`)).status, 200);
  const stopped = await pending;
  assert.equal(stopped.status, 409);
  assert.equal(stopped.body.error, 'The render was stopped');
  assert.equal((await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.id === running.call.id).length, 0);
  const after = currentRound(await view(f));
  assert.deepEqual([after.call.status, after.images.length], ['stopped', 1]);
  assert.equal((await t.send('POST', `${imagesBase(f)}/renders/${running.call.id}/stop`)).status, 409);
  assert.equal((await t.send('POST', `${imagesBase(f)}/renders/11111111-1111-4111-8111-111111111111/stop`)).status, 404);

  // Queued behind another post's render in the same Building: dropped, never rendered.
  const other = await withSession(f.b);
  const otherIds = await stills(other, ['x']);
  video.state.stillGate = gate();
  video.state.stillGateAt = video.state.stills.length + 1;
  const blocking = renderImages(other.sid, { compositionIds: otherIds });
  await waitFor(async () => currentRound(await view(other))?.call?.status === 'running', 'other running');
  const waiting = renderImages(f.sid, { compositionIds: ids });
  const queued = await waitFor(async () => { const r = currentRound(await view(f)); return r?.call?.status === 'queued' ? r : null; }, 'queued');
  const asked = video.state.stills.length;
  assert.equal((await t.send('POST', `${imagesBase(f)}/renders/${queued.call.id}/stop`)).status, 200);
  assert.equal((await waiting).body.error, 'The render was stopped');
  video.state.stillGate.open();
  await blocking;
  assert.equal(video.state.stills.length, asked, 'the dropped call never rendered');
});

test('I16/I17 the Building has one queue for video and images: an image call waits for a video render, naming its Concept', async () => {
  const f = await withSession(undefined, IG_CAROUSEL, 'Image concept');
  const ids = await stills(f, ['a', 'b']);
  // A video render of another Concept in the same Building holds the queue.
  const reel = await t.send('POST', t.c(f.b, '/concepts'), { title: 'Video concept', brief: '', posts: [{ platform: 'instagram', format: 'reel', scheduledAt: AT }] });
  const rc = (s: string) => t.c(f.b, `/concepts/${reel.body.id}${s}`);
  const scriptAid = reel.body.assets.find((a: any) => a.kind === 'script').id;
  const videoAid = reel.body.assets.find((a: any) => a.kind === 'video').id;
  const ss = (await t.send('POST', rc(`/assets/${scriptAid}/session`))).body.session.id;
  await tool('POST', '/draft', ss, { text: 'Script' });
  await t.send('POST', rc(`/assets/${scriptAid}/finalize`));
  const vsid = (await waitFor(async () => (await t.api(rc(`/assets/${videoAid}/session`))).body.session, 'video session')).id;
  await tool('POST', '/checklist', vsid, { items: [{ id: 'a', label: 'A' }] });
  await t.send('PATCH', rc('/video/checklist/a'), { ticked: true });
  await t.send('POST', rc('/video/confirm'));
  video.state.renderGate = gate();
  const videoRender = t.send('POST', rc(`/assets/${videoAid}/finalize`));
  await waitFor(() => video.state.renders.length === 1, 'video running');
  const imageCall = renderImages(f.sid, { compositionIds: ids });
  const queued = await waitFor(async () => { const r = currentRound(await view(f)); return r?.call?.status === 'queued' ? r : null; }, 'image queued');
  assert.deepEqual(queued.call.waitingFor, { conceptTitle: 'Video concept', kind: 'video' });
  assert.equal(queued.call.queuePosition, 1);
  assert.equal(video.state.stills.length, 0);
  const running = (await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.buildingId === f.b);
  assert.deepEqual(running.map((j: any) => j.kind), ['render'], 'a queued image job is not running');
  // The first video render fails, so its asset stays drafting and can render again below.
  video.state.renderError = 'first render fails';
  video.state.renderGate.open();
  assert.equal((await videoRender).status, 200);
  assert.equal((await imageCall).status, 200);
  await service.video.settled();
  video.state.renderError = null;

  // The reverse: a video render waits for an image call.
  video.state.stillGate = gate();
  video.state.stillGateAt = video.state.stills.length + 1;
  const imageFirst = renderImages(f.sid, { compositionIds: ids });
  await waitFor(async () => currentRound(await view(f))?.call?.status === 'running', 'images running');
  const listed = (await t.api('/api/content/jobs/running')).body.jobs.find((j: any) => j.kind === 'images' && j.buildingId === f.b);
  assert.deepEqual([listed.conceptId, listed.assetId, listed.done, listed.total], [f.cid, f.aid, 0, 2]);
  video.state.renderGate = null;
  const videoAfter = t.send('POST', rc(`/assets/${videoAid}/finalize`));
  const waitingVideo = await waitFor(async () => (await t.api(rc('/video/renders'))).body.renders.find((r: any) => r.status === 'queued'), 'video queued');
  assert.equal(waitingVideo.waitingFor, 'Image concept');
  // Another Building renders in parallel.
  const elsewhere = await withSession();
  assert.equal((await renderImages(elsewhere.sid, { compositionIds: await stills(elsewhere, ['p', 'q']) })).status, 200);
  video.state.stillGate.open();
  assert.equal((await imageFirst).status, 200);
  assert.equal((await videoAfter).status, 200);
  await service.video.settled();
});

// ---- finalize, reopen, new rounds ---------------------------------------------------------------

test('I18 finalize: content is the round paths, the session ends, and the publish routes serve the files', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  await renderImages(f.sid, { compositionIds: ids });
  const fin = await finalize(f);
  assert.equal(fin.status, 200, fin.text);
  assert.deepEqual(JSON.parse(fin.body.asset.content), [`posts/${f.pid}/images/round-1/image-01.png`, `posts/${f.pid}/images/round-1/image-02.png`]);
  assert.ok(terminal.stops.includes(f.sid));
  const post = f.c(`/posts/${f.pid}/media`);
  assert.deepEqual((await t.api(post)).body.images.map((i: any) => [i.name, i.missing]), [['image-01.png', false], ['image-02.png', false]]);
  assert.equal((await t.api(`${post}/images/1`)).status, 200);
  assert.equal((await t.api(`${post}/images.zip`)).status, 200);
});

test('I19/I20/U08/U09 finalize is 409 with its reason until the newest call finished with a count that fits', async () => {
  const cases: [Record<string, string>, number, number | null][] = [
    [{ platform: 'x', format: 'image', scheduledAt: AT }, 5, 409], [{ platform: 'x', format: 'image', scheduledAt: AT }, 4, 200],
    [{ platform: 'instagram', format: 'image', scheduledAt: AT }, 2, 409], [{ platform: 'facebook', format: 'carousel', scheduledAt: AT }, 11, 409],
    [{ platform: 'facebook', format: 'carousel', scheduledAt: AT }, 10, 200], [IG_CAROUSEL, 1, 409], [IG_CAROUSEL, 20, 200],
  ];
  const b = await t.createStudio('Counts');
  for (const [post, count, status] of cases) {
    const f = await withSession(b, post);
    await renderImages(f.sid, { compositionIds: await stills(f, slideNames(count)) });
    const res = await finalize(f);
    assert.equal(res.status, status, `${post.platform} ${post.format} ${count}`);
    if (status === 409) assert.match(res.body.error, new RegExp(`this round has ${count}\\.`));
  }
  const x = await withSession(b, { platform: 'x', format: 'image', scheduledAt: AT });
  assert.equal((await finalize(x)).body.error, 'Finalize needs a rendered set: 1 to 4 images for an X image.');
  const ids = await stills(x, ['a']);
  await renderImages(x.sid, { compositionIds: ids });
  video.state.stillErrorFor = ids[0]!;
  await renderImages(x.sid, { compositionIds: ids });
  assert.match((await finalize(x)).body.error, /no complete set/, 'a success followed by a failure');
  video.state.stillErrorFor = null;
  video.state.stillGate = gate();
  video.state.stillGateAt = video.state.stills.length + 1;
  const pending = renderImages(x.sid, { compositionIds: ids });
  await waitFor(async () => currentRound(await view(x))?.call?.status === 'running', 'running');
  assert.equal((await finalize(x)).body.error, 'Finalize is available once the render finishes.');
  await t.send('POST', `${imagesBase(x)}/renders/${currentRound(await view(x)).call.id}/stop`);
  await pending;
  assert.match((await finalize(x)).body.error, /no complete set/, 'stopped');
  await renderImages(x.sid, { compositionIds: ids });
  await rm(path.join(roundDir(x, 1), 'image-01.png'));
  assert.match((await finalize(x)).body.error, /no complete set/, 'a finished call whose file went missing');
});

test('I21 a second finalize is 409; reopen starts round N+1 with the code kept and posts back to draft; a published post blocks it', async () => {
  const f = await withSession(undefined, { platform: 'instagram', format: 'image', scheduledAt: AT });
  await renderImages(f.sid, { compositionIds: await stills(f, ['one']) });
  assert.equal((await finalize(f)).status, 200);
  assert.equal((await finalize(f)).status, 409);
  const textAid = f.body.posts[0].needs.find((a: any) => a.kind === 'post-text').id;
  const ts = (await t.send('POST', f.c(`/assets/${textAid}/session`))).body.session.id;
  await tool('POST', '/draft', ts, { text: 'Caption' });
  await t.send('POST', f.c(`/assets/${textAid}/finalize`));
  assert.equal((await t.send('POST', f.c(`/posts/${f.pid}/finalize`))).status, 200);
  await writeFile(path.join(stillsDir(f), 'one.tsx'), '// kept\n');
  const re = await t.send('POST', f.c(`/assets/${f.aid}/reopen`));
  assert.equal(re.status, 200, re.text);
  assert.deepEqual([re.body.asset.state, re.body.session.round], ['drafting', 2]);
  assert.equal(await readFile(path.join(stillsDir(f), 'one.tsx'), 'utf8'), '// kept\n');
  assert.equal((await t.api(f.c(''))).body.posts[0].status, 'draft');
  assert.equal(currentRound(re.body), undefined, 'round 2 has no images yet');
  assert.equal(re.body.images.rounds[0].round, 1);

  await renderImages(re.body.session.id, { compositionIds: await stills(f, ['one']) });
  await finalize(f);
  await t.send('POST', f.c(`/posts/${f.pid}/finalize`));
  assert.equal((await t.send('POST', f.c(`/posts/${f.pid}/publish`), { publishedAt: new Date(t.clock.now).toISOString() })).status, 200);
  const blocked = await t.send('POST', f.c(`/assets/${f.aid}/reopen`));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'Used by a published post');
});

test('I22 new session archives round N still code and empties the folder; round N images stay; a launch failure restores; no agent is 409', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b']);
  await renderImages(f.sid, { compositionIds: ids });
  let filesAtLaunch: string[] | null = null;
  const push = terminal.starts.push.bind(terminal.starts);
  terminal.starts.push = (...items) => { filesAtLaunch = readdirSync(stillsDir(f)); return push(...items); };
  const res = await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`));
  terminal.starts.push = push;
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(filesAtLaunch, []);
  assert.deepEqual(await readdir(stillsDir(f)), []);
  const archive = path.join(remotion(f), 'archive', f.cid, 'images', f.pid, 'round-1');
  assert.deepEqual((await readdir(archive)).sort(), ['a.tsx', 'b.tsx']);
  assert.equal(res.body.session.round, 2);
  assert.equal(terminal.starts.at(-1)!.resume, false, 'a fresh conversation');
  assert.equal((await t.api(`${imagesBase(f)}/rounds/1/image-01.png`)).status, 200, 'round 1 images stay readable');
  assert.equal(res.body.images.rounds.find((r: any) => r.round === 1).images.length, 2);

  await stills(f, ['c']);
  terminal.starts.push = () => { throw new Error('spawn failed'); };
  const failed = await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`));
  terminal.starts.push = push;
  assert.equal(failed.status, 500);
  assert.deepEqual(await readdir(stillsDir(f)), ['c.tsx']);
  assert.equal(existsSync(path.join(remotion(f), 'archive', f.cid, 'images', f.pid, 'round-2')), false);
  defaultAgent = null;
  assert.equal((await t.send('POST', f.c(`/assets/${f.aid}/session/new-round`))).status, 409);
  assert.deepEqual(await readdir(stillsDir(f)), ['c.tsx']);
});

// ---- files ---------------------------------------------------------------------------------------

test('I23/U12 image route: png, nosniff, inline or attachment; 404 for unknown files, traversal, other assets and other types', async () => {
  const f = await withSession();
  await renderImages(f.sid, { compositionIds: await stills(f, ['a', 'b']) });
  const ok = await t.api(`${imagesBase(f)}/rounds/1/image-01.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ok.headers.get('content-disposition')!, /^inline/);
  assert.match((await t.api(`${imagesBase(f)}/rounds/1/image-01.png?download=1`)).headers.get('content-disposition')!, /^attachment; filename="round-1-image-01.png"/);
  const other = await withSession(f.b);
  await renderImages(other.sid, { compositionIds: await stills(other, ['z']) });
  const paths = [
    '/rounds/1/image-03.png', '/rounds/2/image-01.png', '/rounds/0/image-01.png', '/rounds/x/image-01.png', '/rounds/1/..', '/rounds/1/..%2F..%2Fcontent.sqlite',
    '/rounds/1/%2e%2e', '/rounds/1/image-01.PNG', '/rounds/1/image-1.png', '/rounds/1/a%5Cb.png', '/rounds/1/%00.png', '/rounds/1/%2Fetc%2Fpasswd', '/rounds/1/image-01.png%00',
  ];
  for (const p of paths) assert.equal((await t.api(`${imagesBase(f)}${p}`)).status, 404, p);
  assert.equal((await t.api(`${imagesBase(other)}/rounds/1/image-02.png`)).status, 404, "another asset's file");
  assert.equal((await t.api(t.c(f.b, '/assets/not-a-uuid/images/rounds/1/image-01.png'))).status, 404);
  const textAid = f.body.posts[0].needs.find((a: any) => a.kind === 'post-text').id;
  assert.equal((await t.api(t.c(f.b, `/assets/${textAid}/images/rounds/1/image-01.png`))).status, 404, 'another asset kind');
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  assert.equal((await t.api(`/api/projects/${seo.body.id}/content/assets/${f.aid}/images/rounds/1/image-01.png`)).status, 404);
});

test('I24 zip: entries in render order, stored, same bytes; a partial round zips what exists; an empty round is 404', async () => {
  const f = await withSession();
  const ids = await stills(f, ['a', 'b', 'c']);
  await renderImages(f.sid, { compositionIds: ids });
  const res = await fetch(`${t.baseUrl}${imagesBase(f)}/rounds/1/images.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const entries = await zipEntries(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(entries.map((e) => [e.name, e.method]), [['image-01.png', 0], ['image-02.png', 0], ['image-03.png', 0]]);
  assert.deepEqual(entries[1]!.data, await readFile(path.join(roundDir(f, 1), 'image-02.png')));
  video.state.stillErrorFor = ids[1]!;
  await renderImages(f.sid, { compositionIds: ids });
  const partial = await zipEntries(Buffer.from(await (await fetch(`${t.baseUrl}${imagesBase(f)}/rounds/1/images.zip`)).arrayBuffer()));
  assert.deepEqual(partial.map((e) => e.name), ['image-01.png']);
  assert.equal((await t.api(`${imagesBase(f)}/rounds/2/images.zip`)).status, 404);
  assert.equal((await t.api(`${imagesBase(f)}/rounds/0/images.zip`)).status, 404);
  assert.equal(currentRound(await view(f)).zipUrl, `${imagesBase(f)}/rounds/1/images.zip`);
});

test('I25/U13 alt text through save_draft: one line per image; over a line limit 400; after finalize 409', async () => {
  const f = await withSession(undefined, { platform: 'instagram', format: 'image', scheduledAt: AT });
  const saved = await tool('POST', '/draft', f.sid, { text: '  A red logo on white  \r\nSecond line ' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await view(f)).rounds.at(-1).draft.text, 'A red logo on white\nSecond line');
  const over = await tool('POST', '/draft', f.sid, { text: `ok\n${'a'.repeat(1001)}` });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /Line 2 of the alt text is 1,001 characters; the limit is 1,000/);
  assert.equal((await tool('POST', '/draft', f.sid, { text: 'a'.repeat(1000) })).status, 200);
  assert.equal((await tool('POST', '/draft', f.sid, { text: '   ' })).status, 400);
  await renderImages(f.sid, { compositionIds: await stills(f, ['one']) });
  await finalize(f);
  assert.equal((await tool('POST', '/draft', f.sid, { text: 'late' })).status, 409);
});

// ---- read-only, privacy, deletion, restart, registry --------------------------------------------

test('I02 a read-only Building refuses every images write with 409 and serves the GETs', async () => {
  const f = await withSession();
  await renderImages(f.sid, { compositionIds: await stills(f, ['a', 'b']) });
  await t.projectsDb.update(f.b, { readOnlyReason: 'Migration failed for the test' });
  const renders = video.state.stills.length;
  for (const [method, route] of [['POST', `/assets/${f.aid}/session`], ['POST', `/assets/${f.aid}/session/new-round`], ['POST', `/assets/${f.aid}/finalize`], ['POST', `/assets/${f.aid}/reopen`]] as const) {
    assert.equal((await t.send(method, f.c(route))).status, 409, route);
  }
  assert.equal((await t.send('POST', `${imagesBase(f)}/renders/11111111-1111-4111-8111-111111111111/stop`)).status, 409);
  for (const route of [f.c(`/assets/${f.aid}/session`), `${imagesBase(f)}/rounds/1/image-01.png`, `${imagesBase(f)}/rounds/1/images.zip`]) assert.equal((await t.api(route)).status, 200, route);
  assert.equal(video.state.stills.length, renders);
  await t.projectsDb.update(f.b, { readOnlyReason: undefined });
});

test('I26 privacy: no response or event carries the data folder, the project path, the token, the conversation id or the env', async () => {
  const f = await withSession();
  const before = events.length;
  const jobsBefore = jobEvents.length;
  const res = await renderImages(f.sid, { compositionIds: await stills(f, ['a']) });
  const record = (await (await import('../src/db/collections.ts')).studioSessionsDb.get(f.sid))!;
  const texts = [res.text, JSON.stringify(await view(f)), JSON.stringify(events.slice(before)), JSON.stringify(jobEvents.slice(jobsBefore)), JSON.stringify((await t.api('/api/content/jobs/running')).body)];
  for (const text of texts) {
    for (const secret of [t.dataDir, remotion(f), token, record.agentSessionId!, JSON.stringify(record.setup.env).slice(1, -1) || 'never-empty']) {
      assert.equal(text.includes(secret), false, `leaked ${secret.slice(0, 24)}`);
    }
  }
});

test('I27 deleting the post during a render stops it and removes the still code, images and registry entries; so does the Concept', async () => {
  const f = await withSession(undefined, IG_CAROUSEL, 'Two posts');
  const extra = await t.send('POST', f.c('/posts'), { platform: 'linkedin', format: 'carousel', scheduledAt: AT });
  const ids = await stills(f, ['a', 'b']);
  video.state.stillGate = gate();
  video.state.stillGateAt = 2;
  const pending = renderImages(f.sid, { compositionIds: ids });
  await waitFor(() => video.state.stills.length === 2, 'running');
  assert.match(await readFile(path.join(remotion(f), 'src', 'concepts', 'registry.ts'), 'utf8'), new RegExp(ids[0]!));
  assert.equal((await t.send('DELETE', f.c(`/posts/${f.pid}`))).status, 204);
  assert.equal((await pending).status, 409);
  assert.equal(existsSync(stillsDir(f)), false);
  assert.equal(existsSync(path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'posts', f.pid)), false);
  assert.doesNotMatch(await readFile(path.join(remotion(f), 'src', 'concepts', 'registry.ts'), 'utf8'), new RegExp(ids[0]!));

  const g = { ...f, pid: extra.body.id, aid: extra.body.needs.find((a: any) => a.kind === 'image-set').id };
  await t.send('POST', f.c(`/assets/${g.aid}/session`));
  const gsid = (await waitFor(async () => (await view(g)).session, 'session')).id;
  video.state.stillGate = gate();
  video.state.stillGateAt = video.state.stills.length + 1;
  const second = renderImages(gsid, { compositionIds: await stills(g, ['x']) });
  await waitFor(async () => currentRound(await view(g))?.call?.status === 'running', 'running');
  assert.equal((await t.send('DELETE', f.c(''))).status, 204);
  assert.equal((await second).status, 409);
  assert.equal(existsSync(path.join(remotion(f), 'src', 'concepts', f.cid)), false);
});

test('I28 after a restart a running image render reads failed and a waiting one stopped', async () => {
  const f = await withSession();
  const runtime = await import('../src/content/runtime.ts');
  const db = runtime.contentCtx((await t.projectsDb.get(f.b))!).db;
  db.prepare("INSERT INTO image_renders (id, assetId, round, status, compositionIds, width, height, createdAt) VALUES ('11111111-1111-4111-8111-111111111111', ?, 1, 'running', '[\"a\"]', 1080, 1350, 1)").run(f.aid);
  const failed = currentRound(await view(f)).call;
  assert.deepEqual([failed.status, failed.error], ['failed', 'Interrupted by a daemon restart']);
  db.prepare("INSERT INTO image_renders (id, assetId, round, status, compositionIds, width, height, createdAt) VALUES ('22222222-2222-4222-8222-222222222222', ?, 1, 'queued', '[\"a\"]', 1080, 1350, 2)").run(f.aid);
  const stopped = currentRound(await view(f)).call;
  assert.deepEqual([stopped.status, stopped.error], ['stopped', 'Interrupted by a daemon restart']);
});

test('I29 a new still file is in the registry before rendering; an unchanged registry is not rewritten', async () => {
  const f = await withSession();
  const registry = path.join(remotion(f), 'src', 'concepts', 'registry.ts');
  const ids = await stills(f, ['fresh']);
  assert.doesNotMatch(await readFile(registry, 'utf8'), /fresh/);
  let seen = '';
  const still = video.stillRenderer.still.bind(video.stillRenderer);
  videoDeps.configureVideo({ stillRenderer: { still: async (r) => { seen = await readFile(registry, 'utf8'); return still(r); } } });
  await renderImages(f.sid, { compositionIds: ids });
  assert.match(seen, new RegExp(`still\\('${ids[0]}', s0\\)`));
  assert.match(seen, new RegExp(`from './${f.cid}/images/${f.pid}/fresh'`));
  const mtime = statSync(registry).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await renderImages(f.sid, { compositionIds: ids });
  assert.equal(statSync(registry).mtimeMs, mtime);
});

test('a video Start a new session keeps the image posts\' stills in place, on success and on a failed launch', async () => {
  const f = await concept(undefined, IG_CAROUSEL, 'Both', [{ platform: 'instagram', format: 'reel', scheduledAt: AT }]);
  await t.send('POST', f.c(`/assets/${f.aid}/session`));
  const isid = (await waitFor(async () => { const x = await view(f); return x.session?.state === 'running' && x.asset.state === 'drafting' ? x : null; }, 'image session')).session.id;
  const ids = await stills(f, ['a', 'b']);
  const scriptAid = f.body.assets.find((a: any) => a.kind === 'script').id;
  const videoAid = f.body.assets.find((a: any) => a.kind === 'video').id;
  const ss = (await t.send('POST', f.c(`/assets/${scriptAid}/session`))).body.session.id;
  await tool('POST', '/draft', ss, { text: 'Script' });
  await t.send('POST', f.c(`/assets/${scriptAid}/finalize`));
  const vsid = (await waitFor(async () => (await t.api(f.c(`/assets/${videoAid}/session`))).body.session, 'video session')).id;
  // The record is stored before the launch finishes scaffolding, so the terminal start can come a moment after the view shows it.
  const videoStart = await waitFor(async () => terminal.starts.find((s) => s.taskId === vsid), 'video terminal start');
  assert.match(videoStart.systemPrompt!, /except its images\/ and thumbnail\/ folders/);
  const registry = path.join(remotion(f), 'src', 'concepts', 'registry.ts');
  const index = path.join(remotion(f), 'src', 'concepts', f.cid, 'index.tsx');
  await writeFile(index, `${await readFile(index, 'utf8')}// video round 1\n`);

  assert.equal((await t.send('POST', f.c(`/assets/${videoAid}/session/new-round`))).status, 200);
  assert.deepEqual((await readdir(stillsDir(f))).sort(), ['a.tsx', 'b.tsx']);
  assert.equal(existsSync(path.join(remotion(f), 'archive', f.cid, 'round-1', 'images')), false, 'no stills in the video archive');
  assert.match(await readFile(path.join(remotion(f), 'archive', f.cid, 'round-1', 'index.tsx'), 'utf8'), /video round 1/);
  assert.match(await readFile(registry, 'utf8'), new RegExp(ids[0]!));
  assert.equal((await renderImages(isid, { compositionIds: ids })).status, 200, 'the images session still renders');

  // A failed launch puts round 2's video code back and keeps the stills written meanwhile.
  await writeFile(index, `${await readFile(index, 'utf8')}// video round 2\n`);
  const push = terminal.starts.push.bind(terminal.starts);
  terminal.starts.push = () => { const c = readdirSync(stillsDir(f)); if (!c.includes('c.tsx')) throw new Error('stills moved'); throw new Error('spawn failed'); };
  await stills(f, ['c']);
  const failed = await t.send('POST', f.c(`/assets/${videoAid}/session/new-round`));
  terminal.starts.push = push;
  assert.equal(failed.status, 500);
  assert.match(failed.text, /spawn failed/);
  assert.deepEqual((await readdir(stillsDir(f))).sort(), ['a.tsx', 'b.tsx', 'c.tsx']);
  assert.match(await readFile(index, 'utf8'), /video round 2/);
  assert.match(await readFile(registry, 'utf8'), /still-[0-9a-f]+-c'/);
});
