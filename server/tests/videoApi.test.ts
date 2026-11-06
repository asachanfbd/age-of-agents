import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';
import { fakeVideo, gate, waitFor } from './helpers/videoFakes.ts';

/**
 * The Video tab end to end through the real daemon routes (`api/videoRoutes.ts`, `content/videoStudio.ts`): uploads, the checklist
 * and Confirm, renders, rounds, finalize and reopen. The terminal host, npm install, renderer and ffprobe are fakes; every file
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
let jobs: typeof import('../src/content/jobs.ts');
const events: any[] = [];

const LIMITS = { mediaMaxBytes: 1_000, mediaFilesMax: 6, renderTimeoutMs: 10_000 };

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'video-home-'));
  t = await startContentApi(async () => {
    const mod = await import('../src/content/studioSessions.ts');
    videoDeps = await import('../src/content/videoDeps.ts');
    jobs = await import('../src/content/jobs.ts');
    token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
    terminal = fakeTerminalHost();
    service = mod.createStudioSessions({ host: { ...terminal.host, sessionExists: () => true }, defaultAgentId: async () => defaultAgent, home });
    // Only view updates; a finalized script also reports its writing-style retro.
    service.onEvent((e) => { if (e.type === 'studioAsset') events.push(e); });
    return { studioSessions: service };
  });
});
after(async () => { await service.settled(); videoDeps.resetVideo(); await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => {
  defaultAgent = 'test-claude-cli';
  video = fakeVideo();
  videoDeps.configureVideo({ installer: video.installer, renderer: video.renderer, prober: video.prober, limits: { ...LIMITS }, submitDelayMs: 0 });
});

// ---- helpers -----------------------------------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MP4 = Buffer.from([0, 0, 0, 0x20, ...Buffer.from('ftypisom'), 1, 2, 3]);
const MP3 = Buffer.from('ID3\x04\x00 audio', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const REEL = { platform: 'instagram', format: 'reel', scheduledAt: '2026-11-03T09:00:00Z' };

interface Fx { b: string; cid: string; scriptAid: string; videoAid: string; c: (s: string) => string; title: string }

async function concept(b?: string, posts: unknown[] = [REEL], title = 'Launch'): Promise<Fx> {
  const building = b ?? await t.createStudio('Acme');
  const c = await t.send('POST', t.c(building, '/concepts'), { title, brief: 'Why', posts });
  assert.equal(c.status, 201);
  return {
    b: building, cid: c.body.id, title,
    scriptAid: c.body.assets.find((a: any) => a.kind === 'script').id, videoAid: c.body.assets.find((a: any) => a.kind === 'video').id,
    c: (s: string) => t.c(building, `/concepts/${c.body.id}${s}`),
  };
}

const tool = (method: string, route: string, sessionId: string | undefined, body?: unknown, auth = token) => t.api(`/api/studio-session${route}${sessionId ? `?taskId=${sessionId}` : ''}`, {
  method, headers: auth ? { authorization: `Bearer ${auth}` } : {}, body: body === undefined ? undefined : JSON.stringify(body),
});
const videoView = async (f: Fx) => (await t.api(f.c(`/assets/${f.videoAid}/session`))).body;

/** Finalizes the script through its own pane, which starts the video session (after the fake install). */
async function finalizeScript(f: Fx): Promise<void> {
  const s = await t.send('POST', f.c(`/assets/${f.scriptAid}/session`));
  assert.equal(s.status, 201, s.text);
  await tool('POST', '/draft', s.body.session.id, { text: 'Hook. Body. Call to action.' });
  const fin = await t.send('POST', f.c(`/assets/${f.scriptAid}/finalize`));
  assert.equal(fin.status, 200, fin.text);
  await service.settled();
}

/** A Concept with a running video session in round 1, once the thumbnail session the script also started is running too. */
async function withSession(b?: string, title?: string): Promise<Fx & { sid: string }> {
  const f = await concept(b, [REEL], title);
  await finalizeScript(f);
  const view = await waitFor(async () => { const v = await videoView(f); return v.session?.state === 'running' ? v : null; }, 'video session');
  const thumbnail = (await t.api(f.c(''))).body.assets.find((a: any) => a.kind === 'thumbnail').id;
  await waitFor(async () => (await t.api(f.c(`/assets/${thumbnail}/session`))).body.session?.state === 'running', 'thumbnail session');
  return { ...f, sid: view.session.id };
}

function upload(f: Fx, name: string | null, bytes: Buffer, headers: Record<string, string> = {}) {
  const q = name === null ? '' : `?name=${encodeURIComponent(name)}`;
  return t.api(f.c(`/media${q}`), { method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream', ...headers } });
}

/** A raw upload where the test controls the stream: chunked, or cut off half way. */
function rawUpload(f: Fx, name: string, chunks: Buffer[], options: { abort?: boolean } = {}): Promise<{ status: number; body: any }> {
  const url = new URL(`${t.baseUrl}${f.c(`/media?name=${encodeURIComponent(name)}`)}`);
  return new Promise((resolve) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', () => resolve({ status: 0, body: undefined }));
    for (const chunk of chunks) req.write(chunk);
    if (options.abort) setTimeout(() => { req.destroy(); resolve({ status: 0, body: undefined }); }, 50);
    else req.end();
  });
}

/** Sends only the request head with this Content-Length, as a client that declares a size it never sends; resolves with the status. */
function declaredOnly(f: Fx, name: string, length: string): Promise<number> {
  const url = new URL(t.baseUrl);
  return new Promise((resolve) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(`POST ${f.c(`/media?name=${encodeURIComponent(name)}`)} HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\n\r\n`);
    });
    let text = '';
    socket.on('data', (d) => { text += d; const m = text.match(/^HTTP\/1\.1 (\d+)/); if (m) { socket.destroy(); resolve(Number(m[1])); } });
    socket.on('error', () => resolve(0));
  });
}

const mediaDir = (f: Fx) => path.join(t.dataDir, 'buildings', f.b, 'remotion', 'public', 'concepts', f.cid, 'media');
const uploadsLeft = async (f: Fx) => (await readdir(path.join(t.dataDir, 'buildings', f.b, 'remotion', '.uploads')).catch(() => [])).length;

async function setChecklist(sid: string, items = [{ id: 'clip', label: 'Intro clip', detail: 'Vertical' }, { id: 'logo', label: 'Logo' }]) {
  return tool('POST', '/checklist', sid, { items });
}
async function tickAll(f: Fx) {
  const list = (await t.api(f.c('/video/checklist'))).body;
  for (const item of list.items) assert.equal((await t.send('PATCH', f.c(`/video/checklist/${item.id}`), { ticked: true })).status, 200);
}
async function confirmed(f: Fx & { sid: string }) {
  await setChecklist(f.sid);
  await tickAll(f);
  const res = await t.send('POST', f.c('/video/confirm'));
  assert.equal(res.status, 200, res.text);
}
/** Finalize queues the video's one render and answers at once; `settled` waits until the render has ended and the asset has followed. */
const finalizeVideo = (f: Fx) => t.send('POST', f.c(`/assets/${f.videoAid}/finalize`));
const settled = () => service.video.settled();
const finalizeAndSettle = async (f: Fx) => { const res = await finalizeVideo(f); assert.equal(res.status, 200, res.text); await settled(); return res; };
const running = (f: Fx) => waitFor(async () => (await renders(f)).find((r: any) => r.status === 'running'), 'running');
const renders = async (f: Fx) => (await t.api(f.c('/video/renders'))).body.renders;

// ---- sessions --------------------------------------------------------------------------------------

test('I44/I47/I52 finalizing the script starts video round 1 in the Remotion project after a tracked install; no remotion/ at Building creation', async () => {
  const b = await t.createStudio('Fresh');
  assert.equal(existsSync(path.join(t.dataDir, 'buildings', b, 'remotion')), false);
  const f = await withSession(b);
  assert.equal(video.state.installs, 1);
  const view = await videoView(f);
  assert.equal(view.asset.state, 'drafting');
  assert.equal(view.session.tab, 'video');
  assert.equal(view.video.setup.status, 'ready');
  const start = terminal.starts.find((s) => s.taskId === f.sid)!;
  assert.equal(start.cwd, path.join(t.dataDir, 'buildings', b, 'remotion'));
  assert.deepEqual(start.mcpServers!.map((s) => s.tools), [['get_concept', 'get_performance', 'get_reference_content', 'set_checklist', 'report_speaking_rate', 'list_media']]);
  assert.match(start.systemPrompt!, /set_checklist/);
  assert.match(start.systemPrompt!, new RegExp(`concepts/${f.cid}/script/script.md`));
  assert.doesNotMatch(start.systemPrompt!, /Writing skill/);
  assert.equal(await readFile(path.join(t.dataDir, 'buildings', b, 'concepts', f.cid, 'script', 'script.md'), 'utf8'), 'Hook. Body. Call to action.');
  assert.ok(existsSync(path.join(t.dataDir, 'buildings', b, 'remotion', 'src', 'concepts', f.cid, 'index.tsx')));
});

test('I45 a Concept with no video or reel post starts no video session', async () => {
  const f = await concept(undefined, [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }]);
  await finalizeScript(f);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await videoView(f)).session, null);
});

test('I46 with no default agent the script still finalizes, the video view shows the reason, and POST session starts it later', async () => {
  const f = await concept();
  const s = await t.send('POST', f.c(`/assets/${f.scriptAid}/session`));
  await tool('POST', '/draft', s.body.session.id, { text: 'Script' });
  defaultAgent = null;
  assert.equal((await t.send('POST', f.c(`/assets/${f.scriptAid}/finalize`))).status, 200);
  const view = await videoView(f);
  assert.equal(view.session, null);
  assert.match(view.video.blockedReason, /default coding agent/);
  defaultAgent = 'test-claude-cli';
  assert.equal((await t.send('POST', f.c(`/assets/${f.videoAid}/session`))).status, 201);
  await waitFor(async () => (await videoView(f)).session, 'session');
  assert.equal((await videoView(f)).video.blockedReason, null);
});

test('I48 an install failure is reported, starts nothing, and POST session retries it (Retry setup)', async () => {
  video.state.installError = 'npm exited with code 1';
  const f = await concept();
  await finalizeScript(f);
  const failed = await waitFor(async () => { const v = await videoView(f); return v.video.setup.status === 'failed' ? v : null; }, 'failed setup');
  assert.equal(failed.video.setup.error, 'Remotion setup failed: npm exited with code 1');
  assert.equal(failed.session, null);
  video.state.installError = null;
  assert.equal((await t.send('POST', f.c(`/assets/${f.videoAid}/session`))).status, 201);
  await waitFor(async () => (await videoView(f)).session, 'session after retry');
  assert.equal(video.state.installs, 2);
});

test('I49/I50/I42 two Concepts during one install share it; the setup job is listed while running; no reinstall afterwards', async () => {
  video.state.installGate = gate();
  const b = await t.createStudio('Pair');
  const one = await concept(b);
  const two = await concept(b);
  await finalizeScript(one);
  await finalizeScript(two);
  const running = (await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.buildingId === b);
  assert.deepEqual(running.map((j: any) => j.kind), ['remotion-setup']);
  assert.equal((await videoView(one)).video.setup.status, 'running');
  video.state.installGate.open();
  await waitFor(async () => (await videoView(one)).session && (await videoView(two)).session, 'both sessions');
  assert.equal(video.state.installs, 1);
  assert.deepEqual((await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.buildingId === b), []);
  await withSession(b);
  assert.equal(video.state.installs, 1);
});

test('I51 re-finalizing the script while a video session exists starts nothing and flags scriptChanged', async () => {
  const f = await withSession();
  assert.equal((await videoView(f)).video.scriptChanged, false);
  const starts = terminal.starts.length;
  assert.equal((await t.send('POST', f.c(`/assets/${f.scriptAid}/reopen`))).status, 200);
  const s = (await t.api(f.c(`/assets/${f.scriptAid}/session`))).body.session.id;
  await tool('POST', '/draft', s, { text: 'New script' });
  assert.equal((await t.send('POST', f.c(`/assets/${f.scriptAid}/finalize`))).status, 200);
  assert.equal(terminal.starts.length, starts + 1, 'only the script round started');
  assert.equal((await videoView(f)).video.scriptChanged, true);
});

// ---- upload -------------------------------------------------------------------------------------

test('I01/I03/I12 raw upload is 201 with the bytes on disk, five in parallel, in every asset state', async () => {
  const f = await concept();
  const res = await upload(f, 'shot.png', PNG);
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.kind, 'image');
  assert.deepEqual(await readFile(path.join(mediaDir(f), 'shot.png')), PNG);
  const many = await Promise.all([1, 2, 3, 4, 5].map((i) => upload(f, `p${i}.png`, PNG)));
  assert.deepEqual(many.map((r) => r.status), [201, 201, 201, 201, 201]);
});

test('I02 the stream reaches disk before the request ends, and the route uses no body parser', async () => {
  const f = await concept();
  const url = new URL(`${t.baseUrl}${f.c('/media?name=slow.mp4')}`);
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
  const done = new Promise<number>((resolve) => req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }));
  req.write(MP4);
  const dir = path.join(t.dataDir, 'buildings', f.b, 'remotion', '.uploads');
  await waitFor(async () => { const files = await readdir(dir).catch(() => []); return files.length && (await readFile(path.join(dir, files[0]!))).length >= MP4.length; }, 'first chunk on disk');
  req.end(Buffer.from('more'));
  assert.equal(await done, 201);
  const source = await readFile(new URL('../src/api/videoRoutes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /express\.raw|express\.json|base64/);
});

test('I04/I05/I06 declared over the limit is 400 before writing; streamed over is 413 and leaves nothing; exactly at the limit is 201', async () => {
  const f = await concept();
  assert.equal(await declaredOnly(f, 'big.png', '1001'), 400);
  assert.equal(await declaredOnly(f, 'huge.png', '99999999999999999999'), 400);
  assert.equal(await uploadsLeft(f), 0);
  const over = await rawUpload(f, 'over.png', [PNG, Buffer.alloc(1_000)]);
  assert.equal(over.status, 413);
  assert.equal(await uploadsLeft(f), 0);
  const exact = await upload(f, 'exact.png', Buffer.concat([PNG, Buffer.alloc(1_000 - PNG.length)]));
  assert.equal(exact.status, 201);
  assert.equal((await upload(f, 'declared.png', Buffer.concat([PNG, Buffer.alloc(1_001 - PNG.length)]))).status, 400, 'fetch declares the size');
  assert.equal((await rawUpload(f, 'onemore.png', [PNG, Buffer.alloc(1_001 - PNG.length)])).status, 413);
  assert.deepEqual((await t.api(f.c('/media'))).body.media.map((m: any) => m.name), ['exact.png']);
});

test('I07/I08 unsupported or mismatched types are 400 and leave nothing; names are cleaned and suffixed', async () => {
  const f = await concept();
  for (const [name, bytes] of [['notes.pdf', PNG], ['logo.jpg', PNG], ['a.svg', Buffer.from('<html></html>')]] as const) {
    const res = await upload(f, name, bytes);
    assert.equal(res.status, 400, name);
    assert.equal(res.body.error, 'Unsupported file type');
  }
  assert.equal(await uploadsLeft(f), 0);
  assert.equal((await upload(f, null, PNG)).status, 400);
  assert.equal((await upload(f, '  ', PNG)).status, 400);
  assert.equal((await upload(f, 'IMG (1).JPG', Buffer.from([0xff, 0xd8, 0xff, 0]))).body.name, 'IMG -1-.JPG');
  assert.equal((await upload(f, 'IMG (1).JPG', Buffer.from([0xff, 0xd8, 0xff, 0]))).body.name, 'IMG -1--2.JPG');
  assert.equal((await upload(f, 'empty.png', Buffer.alloc(0))).status, 400);
});

test('I09 the file count limit holds, also for two uploads racing at the last slot', async () => {
  const f = await concept();
  for (let i = 0; i < 5; i++) assert.equal((await upload(f, `f${i}.png`, PNG)).status, 201);
  const raced = await Promise.all([upload(f, 'x.png', PNG), upload(f, 'y.png', PNG)]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [201, 400]);
  assert.equal((await upload(f, 'z.png', PNG)).status, 400);
  assert.equal((await readdir(mediaDir(f))).length, 6);
  assert.equal(await uploadsLeft(f), 0);
});

test('I10 a client abort mid-upload removes the partial file and writes no row', async () => {
  const f = await concept();
  await rawUpload(f, 'cut.mp4', [MP4], { abort: true });
  await waitFor(async () => (await uploadsLeft(f)) === 0, 'partial removed');
  assert.deepEqual((await t.api(f.c('/media'))).body.media, []);
});

test('I11/I67 unknown Building, Concept, non-UUID ids and another type are 404', async () => {
  const f = await concept();
  const uuid = '11111111-1111-4111-8111-111111111111';
  assert.equal((await t.api(t.c(f.b, `/concepts/${uuid}/media`))).status, 404);
  assert.equal((await t.api(t.c(f.b, '/concepts/not-a-uuid/media'))).status, 404);
  assert.equal((await upload({ ...f, c: (s) => t.c(f.b, `/concepts/${uuid}${s}`) }, 'a.png', PNG)).status, 404);
  assert.equal((await t.api(`/api/projects/${uuid}/content/concepts/${f.cid}/media`)).status, 404);
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  assert.equal((await t.api(`/api/projects/${seo.body.id}/content/concepts/${f.cid}/media`)).status, 404);
  for (const route of [`/media/${uuid}/file`, `/media/${uuid}/thumbnail`, '/media/..%2Fx/file', `/video/renders/${uuid}/file`, `/video/checklist/nope`]) {
    assert.equal((await t.api(f.c(route), route.includes('checklist') ? { method: 'PATCH', body: '{}' } : undefined)).status, 404, route);
  }
  assert.equal((await t.send('POST', f.c(`/video/renders/${uuid}/stop`))).status, 404);
});

test('I13 probing lists duration and size and makes a video thumbnail; a probe failure only hides it; audio has none', async () => {
  const f = await concept();
  const clip = (await upload(f, 'clip.mp4', MP4)).body;
  assert.equal(clip.durationMs, 48_000);
  assert.equal(clip.width, 1080);
  assert.equal(clip.hasThumbnail, true);
  assert.equal((await t.api(clip.thumbnailUrl)).status, 200);
  const song = (await upload(f, 'song.mp3', MP3)).body;
  assert.equal(song.thumbnailUrl, null);
  assert.equal((await t.api(f.c(`/media/${song.id}/thumbnail`))).status, 404);
  video.state.proberFails = true;
  const unprobed = (await upload(f, 'raw.mp4', MP4)).body;
  assert.equal(unprobed.hasThumbnail, false);
  assert.equal(unprobed.durationMs, null);
  assert.equal((await t.api(f.c(`/media/${unprobed.id}/thumbnail`))).status, 404);
  const image = (await upload(f, 'pic.png', PNG)).body;
  assert.equal((await t.api(image.thumbnailUrl)).headers.get('content-type'), 'image/png');
});

test('I14/I68 the media list is newest first with links and relative paths; no absolute data path, token or conversation id anywhere', async () => {
  const f = await withSession();
  const a = (await upload(f, 'a.png', PNG)).body;
  const b2 = (await upload(f, 'b.png', PNG)).body;
  const list = (await t.api(f.c('/media'))).body.media;
  assert.deepEqual(list.map((m: any) => m.id), [b2.id, a.id]);
  assert.equal(list[0].path, `concepts/${f.cid}/media/b.png`);
  const record = (await import('../src/db/collections.ts')).studioSessionsDb;
  const stored = (await record.get(f.sid))!;
  const view = await videoView(f);
  for (const text of [JSON.stringify(list), JSON.stringify(view)]) {
    for (const secret of [t.dataDir, path.join(t.dataDir, 'buildings', f.b), token, stored.agentSessionId!, JSON.stringify(stored.setup.env).slice(1, -1) || 'never-empty']) {
      assert.equal(text.includes(secret), false, `leaked ${secret.slice(0, 20)}`);
    }
  }
});

test('I15 media files: content type, nosniff, sandboxed SVG, Range 206 and 416, another Concept is 404', async () => {
  const f = await concept(undefined, [REEL]);
  const other = await concept(f.b);
  const clip = (await upload(f, 'clip.mp4', MP4)).body;
  const full = await t.api(clip.fileUrl);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  const part = await t.api(clip.fileUrl, { headers: { range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${MP4.length}`);
  assert.equal((await t.api(clip.fileUrl, { headers: { range: 'bytes=999-1000' } })).status, 416);
  const svg = (await upload(f, 'logo.svg', SVG)).body;
  assert.match((await t.api(svg.fileUrl)).headers.get('content-security-policy')!, /sandbox/);
  assert.equal((await t.api(other.c(`/media/${clip.id}/file`))).status, 404);
});

// ---- rename and delete ---------------------------------------------------------------------------

test('I16/I17/I18 rename moves the file, keeps links; 409 for a taken name; case-only and same-name are 200; bad input is 400', async () => {
  const f = await withSession();
  const a = (await upload(f, 'a.png', PNG)).body;
  await upload(f, 'b.png', PNG);
  await setChecklist(f.sid);
  await t.send('PATCH', f.c('/video/checklist/logo'), { mediaIds: [a.id] });
  const renamed = await t.send('PATCH', f.c(`/media/${a.id}`), { name: 'brand logo.png' });
  assert.equal(renamed.status, 200);
  assert.ok(existsSync(path.join(mediaDir(f), 'brand logo.png')));
  assert.equal(existsSync(path.join(mediaDir(f), 'a.png')), false);
  assert.deepEqual((await t.api(f.c('/video/checklist'))).body.items.find((i: any) => i.id === 'logo').mediaIds, [a.id]);
  assert.equal((await t.send('PATCH', f.c(`/media/${a.id}`), { name: 'B.png' })).status, 409);
  assert.equal((await t.send('PATCH', f.c(`/media/${a.id}`), { name: 'Brand Logo.PNG' })).status, 200);
  assert.equal((await t.send('PATCH', f.c(`/media/${a.id}`), { name: 'Brand Logo.PNG' })).status, 200);
  for (const name of [`${'x'.repeat(117)}.png`, 'a/b.png', 'a.jpg', '', 5]) assert.equal((await t.send('PATCH', f.c(`/media/${a.id}`), { name })).status, 400, String(name));
  assert.equal((await t.send('PATCH', f.c('/media/11111111-1111-4111-8111-111111111111'), { name: 'x.png' })).status, 404);
});

test('I19 two renames to the same name, queued in order: the second is 409', async () => {
  const f = await concept();
  const a = (await upload(f, 'a.png', PNG)).body;
  const b2 = (await upload(f, 'b.png', PNG)).body;
  const [x, y] = await Promise.all([t.send('PATCH', f.c(`/media/${a.id}`), { name: 'same.png' }), t.send('PATCH', f.c(`/media/${b2.id}`), { name: 'same.png' })]);
  assert.deepEqual([x.status, y.status], [200, 409]);
});

test('I20/I21 delete removes file, thumbnail and row, unlinks it everywhere; unknown is 404', async () => {
  const f = await withSession();
  const clip = (await upload(f, 'clip.mp4', MP4)).body;
  await setChecklist(f.sid);
  await t.send('PATCH', f.c('/video/checklist/clip'), { mediaIds: [clip.id] });
  assert.equal((await t.send('DELETE', f.c(`/media/${clip.id}`))).status, 204);
  assert.equal(existsSync(path.join(mediaDir(f), 'clip.mp4')), false);
  assert.equal(existsSync(path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'media-thumbs', `${clip.id}.jpg`)), false);
  assert.deepEqual((await t.api(f.c('/video/checklist'))).body.items.find((i: any) => i.id === 'clip').mediaIds, []);
  assert.deepEqual((await tool('GET', '/media', f.sid)).body.media, []);
  assert.equal((await t.send('DELETE', f.c(`/media/${clip.id}`))).status, 404);
});

// ---- checklist and confirm -----------------------------------------------------------------------------

test('I22/I24/I28 set_checklist shows unticked; a repeat keeps ticks of ids that stay; empty before any', async () => {
  const f = await withSession();
  assert.deepEqual((await t.api(f.c('/video/checklist'))).body, { round: 1, items: [], confirmedAt: null });
  assert.equal((await setChecklist(f.sid)).status, 200);
  const list = (await t.api(f.c('/video/checklist'))).body;
  assert.deepEqual(list.items.map((i: any) => [i.id, i.ticked, i.detail]), [['clip', false, 'Vertical'], ['logo', false, null]]);
  await t.send('PATCH', f.c('/video/checklist/clip'), { ticked: true });
  await setChecklist(f.sid, [{ id: 'clip', label: 'Clip' }, { id: 'music', label: 'Music' }]);
  assert.deepEqual((await t.api(f.c('/video/checklist'))).body.items.map((i: any) => [i.id, i.ticked]), [['clip', true], ['music', false]]);
});

test('I23 each refused checklist shape is 400 through the tool route', async () => {
  const f = await withSession();
  for (const items of [[], 'x', [{ id: 'A', label: 'x' }], [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }], [{ id: 'a', label: 'two\nlines' }], [{ id: 'a', label: 'x', detail: 'd'.repeat(1001) }]]) {
    assert.equal((await tool('POST', '/checklist', f.sid, { items })).status, 400, JSON.stringify(items));
  }
  assert.equal((await t.api(`/api/studio-session/checklist?taskId=${f.sid}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '[1]' })).status, 400);
});

test('I25/I29 confirm pastes exactly the asset message, then Enter, into the session, then set_checklist is 409', async () => {
  const f = await withSession();
  const clip = (await upload(f, 'clip.mp4', MP4)).body;
  await upload(f, 'logo.png', PNG);
  await setChecklist(f.sid);
  await t.send('PATCH', f.c('/video/checklist/clip'), { ticked: true, mediaIds: [clip.id, clip.id] });
  await t.send('PATCH', f.c('/video/checklist/logo'), { ticked: true });
  const before = terminal.writes.length;
  const res = await t.send('POST', f.c('/video/confirm'));
  assert.equal(res.status, 200);
  assert.ok(res.body.confirmedAt);
  const written = terminal.writes.slice(before);
  assert.ok(written.every((w) => w.taskId === f.sid));
  const text = written.map((w) => w.data).join('');
  assert.equal(written.length, 2, 'one bracketed paste, then Enter on its own');
  assert.equal(text, `\x1b[200~All assets are provided. Media folder: public/concepts/${f.cid}/media. Files: logo.png (image, 1 KB); clip.mp4 (video, 0:48). Checklist: Intro clip → clip.mp4; Logo → (no file linked). Start building the video.\x1b[201~\r`);
  assert.equal(text.match(/\r/g)!.length, 1);
  const again = await setChecklist(f.sid);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'Checklist is confirmed');
  const invalidAfter = await tool('POST', '/checklist', f.sid, { items: [] });
  assert.deepEqual([invalidAfter.status, invalidAfter.body.error], [409, 'Checklist is confirmed'], 'locked wins over bad input');
});

test('I27 item PATCH: ticks, de-duplicated links, 400 for unknown or bad values, 404 unknown item, 409 after confirm', async () => {
  const f = await withSession();
  const a = (await upload(f, 'a.png', PNG)).body;
  await setChecklist(f.sid);
  assert.equal((await t.send('PATCH', f.c('/video/checklist/clip'), { ticked: true })).body.items[0].ticked, true);
  assert.equal((await t.send('PATCH', f.c('/video/checklist/clip'), { ticked: false })).body.items[0].ticked, false);
  assert.deepEqual((await t.send('PATCH', f.c('/video/checklist/clip'), { mediaIds: [a.id, a.id] })).body.items[0].mediaIds, [a.id]);
  for (const body of [{ mediaIds: ['11111111-1111-4111-8111-111111111111'] }, { mediaIds: ['x'] }, { mediaIds: 'x' }, { ticked: 'yes' }]) assert.equal((await t.send('PATCH', f.c('/video/checklist/clip'), body)).status, 400, JSON.stringify(body));
  assert.equal((await t.send('PATCH', f.c('/video/checklist/none'), { ticked: true })).status, 404);
  await tickAll(f);
  await t.send('POST', f.c('/video/confirm'));
  assert.equal((await t.send('PATCH', f.c('/video/checklist/clip'), { ticked: false })).status, 409);
});

test('I30/I31 confirm is 409 with an unticked item, an empty list, a second time, or an ended session (nothing written)', async () => {
  const f = await withSession();
  assert.equal((await t.send('POST', f.c('/video/confirm'))).status, 409);
  await setChecklist(f.sid);
  await t.send('PATCH', f.c('/video/checklist/clip'), { ticked: true });
  assert.equal((await t.send('POST', f.c('/video/confirm'))).status, 409);
  await t.send('PATCH', f.c('/video/checklist/logo'), { ticked: true });
  terminal.live.delete(f.sid);
  const writes = terminal.writes.length;
  assert.equal((await t.send('POST', f.c('/video/confirm'))).status, 409);
  assert.equal(terminal.writes.length, writes);
  assert.equal((await t.api(f.c('/video/checklist'))).body.confirmedAt, null);
  terminal.live.add(f.sid);
  assert.equal((await t.send('POST', f.c('/video/confirm'))).status, 200);
  assert.equal((await t.send('POST', f.c('/video/confirm'))).status, 409);
  assert.equal(terminal.writes.length, writes + 2);
});

test('I32 set_checklist queued behind confirm in the write queue loses with 409', async () => {
  const f = await withSession();
  await setChecklist(f.sid);
  await tickAll(f);
  const [c, s] = await Promise.all([t.send('POST', f.c('/video/confirm')), setChecklist(f.sid)]);
  assert.equal(c.status, 200);
  assert.equal(s.status, 409);
});

test('I26/I41 tool refusals: 401, 400, 404, ended 409, finalized 409, a script session 409', async () => {
  const f = await withSession();
  const unknown = '00000000-0000-4000-8000-000000000000';
  for (const [method, route, body] of [['POST', '/checklist', { items: [{ id: 'a', label: 'A' }] }], ['GET', '/media', undefined]] as const) {
    assert.equal((await tool(method, route, f.sid, body, 'wrong')).status, 401, route);
    assert.equal((await tool(method, route, undefined, body)).status, 400, route);
    assert.equal((await tool(method, route, unknown, body)).status, 404, route);
  }
  const scriptSession = (await t.api(f.c(`/assets/${f.scriptAid}/session`))).body.session.id;
  await t.send('POST', f.c(`/assets/${f.scriptAid}/reopen`));
  const liveScript = (await t.api(f.c(`/assets/${f.scriptAid}/session`))).body.session.id;
  assert.notEqual(liveScript, scriptSession);
  assert.equal((await setChecklist(liveScript)).status, 409);
  assert.equal((await tool('GET', '/media', liveScript)).status, 409);
  assert.equal((await tool('POST', '/draft', f.sid, { text: 'x' })).status, 409, 'a video session saves no drafts');
  terminal.live.delete(f.sid);
  assert.equal((await setChecklist(f.sid)).status, 409);
  assert.equal((await tool('POST', '/render', f.sid, {})).status, 404, 'render_video is gone');
});

// ---- renders ------------------------------------------------------------------------------------------

test('I33/I34/I35/I43 list_media; Finalize waits for Confirm; the final render goes to round-1/render-1.mp4, finalizes the asset and plays with Range', async () => {
  const f = await withSession();
  const clip = (await upload(f, 'clip.mp4', MP4)).body;
  const early = await finalizeVideo(f);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'Waiting for the owner to confirm assets');
  assert.equal(video.state.renders.length, 0);
  await setChecklist(f.sid);
  await t.send('PATCH', f.c('/video/checklist/clip'), { ticked: true, mediaIds: [clip.id] });
  await t.send('PATCH', f.c('/video/checklist/logo'), { ticked: true });
  await t.send('POST', f.c('/video/confirm'));
  const late = (await upload(f, 'late.png', PNG)).body;
  const media = (await tool('GET', '/media', f.sid)).body;
  assert.equal(media.folder, `public/concepts/${f.cid}/media`);
  assert.deepEqual(media.media.map((m: any) => [m.name, m.checklistItems]), [[late.name, []], ['clip.mp4', ['clip']]]);
  assert.deepEqual(Object.keys(media.media[1]).sort(), ['checklistItems', 'durationMs', 'height', 'id', 'kind', 'name', 'path', 'size', 'width']);
  const res = await finalizeVideo(f);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.asset.state, 'drafting', 'the answer comes before the render ends');
  await settled();
  const request = video.state.renders[0]!;
  assert.equal(request.dir, path.join(t.dataDir, 'buildings', f.b, 'remotion'));
  assert.equal(request.compositionId, `concept-${f.cid.slice(0, 8)}`);
  assert.equal(request.output, path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'video', 'round-1', 'render-1.mp4'));
  const [done] = await renders(f);
  assert.equal([done.status, done.durationMs].join(), 'done,48000');
  const view = await videoView(f);
  assert.equal(view.asset.state, 'finalized');
  assert.equal(view.asset.content, done.id);
  assert.ok(terminal.stops.includes(f.sid), 'the session ends');
  const file = await t.api(done.fileUrl);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'video/mp4');
  assert.equal(file.headers.get('accept-ranges'), 'bytes');
  const ranged = await t.api(done.fileUrl, { headers: { range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers.get('content-range')!, /^bytes 0-99\//);
  assert.equal((await t.api(done.fileUrl, { headers: { range: 'bytes=-10' } })).status, 206);
  assert.equal((await t.api(done.fileUrl, { headers: { range: 'bytes=5000-6000' } })).status, 416);
  assert.match((await t.api(`${done.fileUrl}?download=1`)).headers.get('content-disposition')!, /attachment/);
  assert.equal((await finalizeVideo(f)).status, 409, 'already finalized');
});

test('I36 the render tool route is gone: POST /studio-session/render is 404 for a live video session', async () => {
  const f = await withSession();
  await confirmed(f);
  assert.equal((await tool('POST', '/render', f.sid, {})).status, 404);
  assert.equal(video.state.renders.length, 0);
});

test('I37/I38/I42 a second Concept waits in the queue naming the first; Stop works on running and queued final renders and leaves the asset drafting; finished is 409', async () => {
  video.state.renderGate = gate();
  const one = await withSession(undefined, 'First concept');
  const two = await withSession(one.b, 'Second');
  await confirmed(one);
  await confirmed(two);
  assert.equal((await finalizeVideo(one)).status, 200);
  await running(one);
  const jobs = (await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.buildingId === one.b && j.kind === 'render');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].conceptId, one.cid);
  assert.equal((await finalizeVideo(two)).status, 200);
  const queued = await waitFor(async () => (await renders(two))[0], 'queued');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.queuePosition, 1);
  assert.equal(queued.waitingFor, 'First concept');
  assert.equal((await t.send('POST', two.c(`/video/renders/${queued.id}/stop`))).status, 200);
  const runningRender = (await renders(one))[0];
  assert.equal((await t.send('POST', one.c(`/video/renders/${runningRender.id}/stop`))).status, 200);
  await settled();
  assert.deepEqual([(await renders(one))[0].status, (await renders(two))[0].status], ['stopped', 'stopped']);
  assert.equal((await renders(one))[0].error, 'The render was stopped');
  assert.equal(existsSync(video.state.renders[0]!.output), false);
  assert.equal((await videoView(one)).asset.state, 'drafting');
  video.state.renderGate = null;
  await finalizeAndSettle(one);
  const [done] = await renders(one);
  assert.equal(done.k, 2, 'stopped renders still count');
  assert.equal((await videoView(one)).asset.content, done.id);
  assert.equal((await t.send('POST', one.c(`/video/renders/${done.id}/stop`))).status, 409);
  assert.ok(events.some((e) => e.view.conceptId === one.cid && e.view.video?.renders.some((r: any) => r.status === 'running')));
});

test('I39/I40 a failed or timed-out final render leaves the asset drafting with the error; a retry finalizes with its own render', async () => {
  const f = await withSession();
  await confirmed(f);
  video.state.renderError = 'Cannot find file "media/logo-light.png"';
  await finalizeAndSettle(f);
  let view = await videoView(f);
  assert.equal(view.asset.state, 'drafting');
  assert.equal(view.session.state, 'running');
  assert.match(view.video.renders[0].error, /Cannot find file/);
  video.state.renderError = null;
  video.state.renderGate = gate();
  videoDeps.configureVideo({ limits: { ...LIMITS, renderTimeoutMs: 50 } });
  await finalizeAndSettle(f);
  assert.match((await renders(f))[0].error, /timed out after 50 ms/);
  assert.equal((await videoView(f)).asset.state, 'drafting');
  video.state.renderGate = null;
  videoDeps.configureVideo({ limits: { ...LIMITS } });
  await finalizeAndSettle(f);
  const list = await renders(f);
  assert.deepEqual(list.map((r: any) => [r.k, r.status]), [[3, 'done'], [2, 'failed'], [1, 'failed']]);
  view = await videoView(f);
  assert.equal(view.asset.content, list[0].id);
  assert.equal((await t.api(f.c(`/video/renders/${list[1].id}/file`))).status, 404);
  assert.equal(existsSync(video.state.renders[0]!.output), false, 'a failed render keeps no partial file');
});

test('I39b an ended session may still finalize; a project that is not ready may not', async () => {
  const f = await withSession();
  await confirmed(f);
  terminal.live.delete(f.sid);
  assert.equal((await videoView(f)).session.state, 'ended');
  const marker = path.join(t.dataDir, 'buildings', f.b, 'remotion', '.agent-visual-os-installed');
  const kept = await readFile(marker);
  await rm(marker);
  const refused = await finalizeVideo(f);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /still being set up/);
  assert.equal(video.state.renders.length, 0);
  await writeFile(marker, kept);
  await finalizeAndSettle(f);
  assert.equal((await videoView(f)).asset.state, 'finalized');
});

// ---- discard, finalize, reopen ---------------------------------------------------------------------------

test('I53/I54/I55 discard: stops the render, archives the code, starts round 2 with an empty checklist and the same media', async () => {
  const f = await withSession();
  await upload(f, 'keep.png', PNG);
  await confirmed(f);
  const remotion = path.join(t.dataDir, 'buildings', f.b, 'remotion');
  const index = path.join(remotion, 'src', 'concepts', f.cid, 'index.tsx');
  await writeFile(index, (await readFile(index, 'utf8')).replace('#000000', '#ff0000'));
  video.state.renderGate = gate();
  assert.equal((await finalizeVideo(f)).status, 200);
  await running(f);
  // What the code folder held at the moment round 2's agent launched.
  let codeAtLaunch: string | null = null;
  const push = terminal.starts.push.bind(terminal.starts);
  terminal.starts.push = (...items) => { codeAtLaunch = readFileSync(index, 'utf8'); return push(...items); };
  const res = await t.send('POST', f.c(`/assets/${f.videoAid}/session/new-round`));
  terminal.starts.push = push;
  assert.equal(res.status, 200, res.text);
  assert.match(codeAtLaunch!, /#000000/, 'round 2 launched on the fresh scaffold, never on round 1 code');
  await settled();
  assert.equal(res.body.session.round, 2);
  assert.deepEqual(res.body.video.checklist, { round: 2, items: [], confirmedAt: null });
  assert.match(await readFile(path.join(remotion, 'archive', f.cid, 'round-1', 'index.tsx'), 'utf8'), /#ff0000/);
  assert.match(await readFile(index, 'utf8'), /#000000/);
  assert.match(await readFile(path.join(remotion, 'src', 'concepts', 'registry.ts'), 'utf8'), new RegExp(f.cid));
  assert.deepEqual((await t.api(f.c('/media'))).body.media.map((m: any) => m.name), ['keep.png']);
  assert.deepEqual((await renders(f)).map((r: any) => [r.round, r.status]), [[1, 'stopped']]);
  assert.equal(res.body.asset.state, 'drafting', 'the stopped final render finalized nothing');
});

test('I53b a discard whose launch fails puts round N code back and leaves the round as it was', async () => {
  const f = await withSession();
  const index = path.join(t.dataDir, 'buildings', f.b, 'remotion', 'src', 'concepts', f.cid, 'index.tsx');
  await writeFile(index, `${await readFile(index, 'utf8')}// round 1 work\n`);
  const push = terminal.starts.push.bind(terminal.starts);
  terminal.starts.push = () => { throw new Error('spawn failed'); };
  const res = await t.send('POST', f.c(`/assets/${f.videoAid}/session/new-round`));
  terminal.starts.push = push;
  assert.equal(res.status, 500);
  assert.match(await readFile(index, 'utf8'), /\/\/ round 1 work/);
  assert.equal(existsSync(path.join(t.dataDir, 'buildings', f.b, 'remotion', 'archive', f.cid, 'round-1')), false);
  const view = await videoView(f);
  assert.deepEqual([view.asset.round, view.session.id], [1, f.sid]);
  defaultAgent = null;
  assert.equal((await t.send('POST', f.c(`/assets/${f.videoAid}/session/new-round`))).status, 409);
  assert.match(await readFile(index, 'utf8'), /\/\/ round 1 work/, 'no agent: nothing archived');
});

test('I56/I57/I58/I59/I61 finalize needs confirmed assets, refuses while a render runs or waits, then renders and finalizes, ends the session; media stays open', async () => {
  const f = await withSession();
  assert.equal((await finalizeVideo(f)).status, 409);
  await confirmed(f);
  video.state.renderError = 'boom';
  await finalizeAndSettle(f);
  assert.equal((await videoView(f)).asset.state, 'drafting', 'a failed render finalizes nothing');
  video.state.renderError = null;
  video.state.renderGate = gate();
  assert.equal((await finalizeVideo(f)).status, 200);
  await running(f);
  const blocked = await finalizeVideo(f);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /waits until the render finishes/);
  assert.equal((await renders(f)).length, 2, 'no second row');
  video.state.renderGate.open();
  await settled();
  video.state.renderGate = null;
  const view = await videoView(f);
  const list = await renders(f);
  assert.equal(view.asset.content, list.find((r: any) => r.k === 2).id);
  assert.equal(view.asset.state, 'finalized');
  assert.ok(view.asset.finalizedAt);
  assert.ok(terminal.stops.includes(f.sid));
  assert.equal((await finalizeVideo(f)).status, 409);
  const after = (await upload(f, 'after.png', PNG)).body;
  assert.equal((await t.send('PATCH', f.c(`/media/${after.id}`), { name: 'after2.png' })).status, 200);
  assert.equal((await t.send('PATCH', f.c('/video/checklist/clip'), { ticked: false })).status, 409);
  assert.equal((await t.send('POST', f.c('/video/confirm'))).status, 409);
});

test('I60 reopen starts round N+1 with the code kept and the checklist copied, ticked but not confirmed; posts go back to draft', async () => {
  const f = await withSession();
  await confirmed(f);
  await finalizeAndSettle(f);
  const postId = (await t.api(f.c(''))).body.posts[0].id;
  await t.send('POST', f.c(`/posts/${postId}/finalize`)).catch(() => undefined);
  const index = path.join(t.dataDir, 'buildings', f.b, 'remotion', 'src', 'concepts', f.cid, 'index.tsx');
  await writeFile(index, `${await readFile(index, 'utf8')}// kept\n`);
  const res = await t.send('POST', f.c(`/assets/${f.videoAid}/reopen`));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.session.round, 2);
  assert.deepEqual(res.body.video.checklist.items.map((i: any) => [i.id, i.ticked]), [['clip', true], ['logo', true]]);
  assert.equal(res.body.video.checklist.confirmedAt, null);
  assert.match(await readFile(index, 'utf8'), /\/\/ kept/);
  assert.match(terminal.starts.at(-1)!.systemPrompt!, /reopened this video/);
  assert.equal(terminal.starts.at(-1)!.prompt, '');
  assert.equal(res.body.asset.state, 'drafting');
});

test('I62 a read-only Building refuses every write with 409, serves reads, and installs or renders nothing', async () => {
  const f = await withSession();
  const a = (await upload(f, 'a.png', PNG)).body;
  await t.projectsDb.update(f.b, { readOnlyReason: 'Migration failed for the test' });
  const installs = video.state.installs;
  const uuid = '11111111-1111-4111-8111-111111111111';
  const writes: [string, string, unknown?][] = [
    ['PATCH', `/media/${a.id}`, { name: 'b.png' }], ['DELETE', `/media/${a.id}`], ['PATCH', '/video/checklist/clip', { ticked: true }], ['POST', '/video/confirm'],
    ['POST', `/video/renders/${uuid}/stop`], ['POST', `/assets/${f.videoAid}/session`], ['POST', `/assets/${f.videoAid}/session/new-round`],
    ['POST', `/assets/${f.videoAid}/finalize`], ['POST', `/assets/${f.videoAid}/reopen`],
  ];
  for (const [method, route, body] of writes) assert.equal((await t.send(method, f.c(route), body)).status, 409, `${method} ${route}`);
  assert.equal((await upload(f, 'c.png', PNG)).status, 409);
  for (const route of ['/media', `/media/${a.id}/file`, `/media/${a.id}/thumbnail`, '/video/checklist', '/video/renders', `/assets/${f.videoAid}/session`]) assert.equal((await t.api(f.c(route))).status, 200, route);
  assert.equal(video.state.installs, installs);
  assert.equal(video.state.renders.length, 0);
  assert.equal((await readdir(mediaDir(f))).length, 1);
  await t.projectsDb.update(f.b, { readOnlyReason: undefined });
});

test('I63 deleting a Concept stops its render and removes its code, media and folder; the registry follows', async () => {
  const f = await withSession();
  await upload(f, 'a.png', PNG);
  await confirmed(f);
  video.state.renderGate = gate();
  assert.equal((await finalizeVideo(f)).status, 200);
  await running(f);
  assert.equal((await t.send('DELETE', f.c(''))).status, 204);
  await settled();
  const remotion = path.join(t.dataDir, 'buildings', f.b, 'remotion');
  for (const gone of [path.join(remotion, 'src', 'concepts', f.cid), path.join(remotion, 'public', 'concepts', f.cid), path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid)]) assert.equal(existsSync(gone), false, gone);
  assert.doesNotMatch(await readFile(path.join(remotion, 'src', 'concepts', 'registry.ts'), 'utf8'), new RegExp(f.cid));
});

test('I64 deleting the Building stops its install and render jobs', async () => {
  video.state.installGate = gate();
  const f = await concept();
  await finalizeScript(f);
  assert.equal((await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.buildingId === f.b).length, 1);
  assert.equal((await t.send('DELETE', `/api/projects/${f.b}`)).status < 300, true);
  await waitFor(async () => (await t.api('/api/content/jobs/running')).body.jobs.every((j: any) => j.buildingId !== f.b), 'jobs gone');
});

test('I65 after a restart a render still marked running reads as failed and a queued one as stopped', async () => {
  const f = await withSession();
  await confirmed(f);
  await finalizeAndSettle(f);
  const runtime = await import('../src/content/runtime.ts');
  const project = (await t.projectsDb.get(f.b))!;
  const db = runtime.contentCtx(project).db;
  db.prepare("INSERT INTO video_renders (id, assetId, round, k, status, compositionId, createdAt) VALUES ('11111111-1111-4111-8111-111111111111', ?, 1, 9, 'running', 'x', 1), ('22222222-2222-4222-8222-222222222222', ?, 1, 10, 'queued', 'x', 1)").run(f.videoAid, f.videoAid);
  const list = await renders(f);
  assert.deepEqual(list.slice(0, 2).map((r: any) => [r.k, r.status, r.error]), [[10, 'stopped', 'Interrupted by a daemon restart'], [9, 'failed', 'Interrupted by a daemon restart']]);
  terminal.live.delete(f.sid);
  assert.equal((await videoView(f)).session.state, 'ended');
});

test('I66 the video view is published with a growing rev on checklist, confirm, media and render changes', async () => {
  const f = await withSession();
  const seen = () => events.filter((e) => e.view.assetId === f.videoAid).map((e) => e.view.rev);
  const start = seen().length;
  await setChecklist(f.sid);
  await upload(f, 'a.png', PNG);
  await tickAll(f);
  await t.send('POST', f.c('/video/confirm'));
  await finalizeAndSettle(f);
  const revs = seen().slice(start);
  assert.ok(revs.length >= 6, `got ${revs.length}`);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  assert.ok(events.some((e) => e.view.assetId === f.videoAid && e.view.video.media.length === 1));
});

// ---- 37.007 speaking rate ------------------------------------------------------------------------

const rate = (f: Fx & { sid: string }, body: unknown, sid = f.sid) => tool('POST', '/speaking-rate', sid, body);
const settingsOf = async (b: string) => (await t.api(t.c(b, '/settings'))).body.speakingSpeed;
const samplesOf = async (b: string) => (await t.api(t.c(b, '/speaking-rate-samples'))).body;
const sqlOf = async (f: Fx) => (await import('../src/content/runtime.ts')).contentCtx((await t.projectsDb.get(f.b))!);
async function media(f: Fx, name: string, bytes: Buffer): Promise<string> {
  const res = await upload(f, name, bytes);
  assert.equal(res.status, 201, res.text);
  return res.body.id;
}

test('SR01/SR02/SR06 a report stores the sample for video and audio, with the Concept and the rate', async () => {
  const f = await withSession();
  const clip = await media(f, 'face.mp4', MP4);
  const voice = await media(f, 'vo.mp3', MP3);
  const a = await rate(f, { mediaId: clip, words: 300, durationSeconds: 120 });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.wordsPerMinute, 150);
  assert.deepEqual(a.body.speakingSpeed, { speakingWpm: 150, source: 'detected', sampleCount: 1 });
  assert.equal((await rate(f, { mediaId: voice, words: 100, durationSeconds: 60 })).status, 200);
  const list = await samplesOf(f.b);
  assert.deepEqual(list.map((x: any) => [x.mediaName, x.mediaId, x.conceptId, x.wordsPerMinute, x.words, x.durationSeconds]), [['face.mp4', clip, f.cid, 150, 300, 120], ['vo.mp3', voice, f.cid, 100, 100, 60]]);
  assert.ok(list.every((x: any) => !('path' in x) && !('file' in x)));
  // (300 + 100) words over 3 minutes is 133, not the mean of 150 and 100.
  assert.deepEqual(await settingsOf(f.b), { speakingWpm: 133, source: 'detected', sampleCount: 2 });
});

test('SR03 a second report for the same media replaces the row and keeps its id', async () => {
  const f = await withSession();
  const clip = await media(f, 'face.mp4', MP4);
  await rate(f, { mediaId: clip, words: 300, durationSeconds: 120 });
  const [first] = await samplesOf(f.b);
  await rate(f, { mediaId: clip, words: 200, durationSeconds: 60 });
  const list = await samplesOf(f.b);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].id, list[0].wordsPerMinute], [first.id, 200]);
});

test('SR04/SR05 each refusal is 400 naming its field and writes nothing', async () => {
  const f = await withSession();
  const clip = await media(f, 'face.mp4', MP4);
  const image = await media(f, 'a.png', PNG);
  const other = await withSession(f.b, 'Other');
  const foreign = await media(other, 'x.mp4', MP4);
  const ok = { mediaId: clip, words: 300, durationSeconds: 120 };
  const cases: [string, unknown][] = [
    ['words', { ...ok, words: 4 }], ['words', { ...ok, words: 300.5 }], ['words', { ...ok, words: '300' }], ['words', { ...ok, words: 2 ** 53 + 1 }], ['words', { ...ok, words: 1e308 }], ['words', { ...ok, words: -5 }],
    ['durationSeconds', { ...ok, durationSeconds: 2.99 }], ['durationSeconds', { ...ok, durationSeconds: 7200.01 }], ['durationSeconds', { ...ok, durationSeconds: '120' }], ['durationSeconds', { ...ok, durationSeconds: 0 }], ['durationSeconds', { ...ok, durationSeconds: null }],
    ['wordsPerMinute', { ...ok, words: 39, durationSeconds: 60 }], ['wordsPerMinute', { ...ok, words: 401, durationSeconds: 60 }],
    ['mediaId', { ...ok, mediaId: undefined }], ['mediaId', { ...ok, mediaId: '' }], ['mediaId', { ...ok, mediaId: 7 }], ['mediaId', { ...ok, mediaId: 'x'.repeat(10_000) }],
    ['mediaId', { ...ok, mediaId: '00000000-0000-4000-8000-000000000000' }], ['mediaId', { ...ok, mediaId: image }], ['mediaId', { ...ok, mediaId: foreign }],
  ];
  for (const [field, body] of cases) {
    const res = await rate(f, body);
    assert.deepEqual([res.status, res.body.field], [400, field], JSON.stringify(body).slice(0, 80));
  }
  for (const body of [[], 'x', null]) assert.equal((await rate(f, body)).status, 400);
  assert.equal((await samplesOf(f.b)).length, 0);
  // The limits themselves are accepted.
  for (const [words, seconds] of [[5, 3], [40, 60], [400, 60], [14_400, 7200]]) assert.equal((await rate(f, { mediaId: clip, words, durationSeconds: seconds })).status, 200, `${words} in ${seconds}s`);
});

test('SR07/SR08 tool refusals: 401, 400, 404, ended 409 and a script session 409', async () => {
  const f = await withSession();
  const clip = await media(f, 'face.mp4', MP4);
  const body = { mediaId: clip, words: 300, durationSeconds: 120 };
  assert.equal((await tool('POST', '/speaking-rate', f.sid, body, 'wrong')).status, 401);
  assert.equal((await tool('POST', '/speaking-rate', undefined, body)).status, 400);
  assert.equal((await tool('POST', '/speaking-rate', '00000000-0000-4000-8000-000000000000', body)).status, 404);
  await t.send('POST', f.c(`/assets/${f.scriptAid}/reopen`));
  const liveScript = (await t.api(f.c(`/assets/${f.scriptAid}/session`))).body.session.id;
  assert.equal((await rate(f, body, liveScript)).status, 409);
  const thumbAid = (await t.api(f.c(''))).body.assets.find((a: any) => a.kind === 'thumbnail').id;
  const thumbSession = (await t.api(f.c(`/assets/${thumbAid}/session`))).body.session.id;
  assert.equal((await rate(f, body, thumbSession)).status, 409, 'a thumbnail session');
  terminal.live.delete(f.sid);
  assert.equal((await rate(f, body)).status, 409);
  assert.equal((await samplesOf(f.b)).length, 0);
});

/** Holds the Building's write queue while `work` runs and always lets it go, so a failed assertion cannot leave later tests waiting. */
async function holdingQueue(ctx: Awaited<ReturnType<typeof sqlOf>>, work: (release: () => Promise<void>) => Promise<void>): Promise<void> {
  const hold = gate();
  const held = ctx.exclusive(() => hold.promise);
  let released = false;
  const release = async () => { if (!released) { released = true; hold.open(); await held; } };
  try { await work(release); } finally { await release(); }
}
const pause = () => new Promise((r) => setTimeout(r, 50));
const sampleRows = (ctx: Awaited<ReturnType<typeof sqlOf>>) => (ctx.db.prepare('SELECT COUNT(*) AS n FROM speaking_rate_samples').get() as { n: number }).n;

test('SR09 the upsert and the delete wait for the Building write queue', async () => {
  const f = await withSession();
  const clip = await media(f, 'face.mp4', MP4);
  const ctx = await sqlOf(f);
  await holdingQueue(ctx, async (release) => {
    const pendingReport = rate(f, { mediaId: clip, words: 300, durationSeconds: 120 });
    await pause();
    assert.equal(sampleRows(ctx), 0, 'nothing is written while the lock is held');
    await release();
    assert.equal((await pendingReport).status, 200);
  });
  const [sample] = await samplesOf(f.b);
  await holdingQueue(ctx, async (release) => {
    const pendingDelete = t.send('DELETE', t.c(f.b, `/speaking-rate-samples/${sample.id}`));
    await pause();
    assert.equal(sampleRows(ctx), 1);
    await release();
    assert.equal((await pendingDelete).status, 200);
  });
});

test('SR10 a report queued behind a media delete is refused with 400 mediaId and leaves no row', async () => {
  const f = await withSession();
  const clip = await media(f, 'face.mp4', MP4);
  const ctx = await sqlOf(f);
  await holdingQueue(ctx, async (release) => {
    const del = t.send('DELETE', f.c(`/media/${clip}`));
    await pause();
    const report = rate(f, { mediaId: clip, words: 300, durationSeconds: 120 });
    await pause();
    await release();
    const [r, d] = await Promise.all([report, del]);
    assert.equal(d.status, 204);
    assert.deepEqual([r.status, r.body.field], [400, 'mediaId']);
  });
  assert.equal((await samplesOf(f.b)).length, 0);
  assert.equal(sampleRows(ctx), 0);
});

test('SR11 deleting a media file removes only its sample and the average follows', async () => {
  const f = await withSession();
  const a = await media(f, 'a.mp4', MP4);
  const b = await media(f, 'b.mp3', MP3);
  await rate(f, { mediaId: a, words: 300, durationSeconds: 120 });
  await rate(f, { mediaId: b, words: 100, durationSeconds: 60 });
  assert.equal((await t.send('DELETE', f.c(`/media/${a}`))).status, 204);
  assert.deepEqual(await settingsOf(f.b), { speakingWpm: 100, source: 'detected', sampleCount: 1 });
  assert.deepEqual((await samplesOf(f.b)).map((x: any) => x.mediaId), [b]);
});

test('SR12 deleting a Concept removes its samples', async () => {
  const f = await withSession();
  const a = await media(f, 'a.mp4', MP4);
  await rate(f, { mediaId: a, words: 300, durationSeconds: 120 });
  assert.equal((await t.send('DELETE', t.c(f.b, `/concepts/${f.cid}`))).status, 204);
  assert.deepEqual(await samplesOf(f.b), []);
  assert.deepEqual(await settingsOf(f.b), { speakingWpm: 150, source: 'default', sampleCount: 0 });
});

test('SR13/SR14 listing: empty is [], a rename shows in mediaName', async () => {
  const f = await withSession();
  assert.deepEqual(await samplesOf(f.b), []);
  const a = await media(f, 'a.mp4', MP4);
  await rate(f, { mediaId: a, words: 300, durationSeconds: 120 });
  await t.send('PATCH', f.c(`/media/${a}`), { name: 'renamed.mp4' });
  assert.equal((await samplesOf(f.b))[0].mediaName, 'renamed.mp4');
});

test('SR15 deleting a sample recomputes the speed; an unknown id is 404', async () => {
  const f = await withSession();
  const a = await media(f, 'a.mp4', MP4);
  await rate(f, { mediaId: a, words: 300, durationSeconds: 120 });
  const [sample] = await samplesOf(f.b);
  const res = await t.send('DELETE', t.c(f.b, `/speaking-rate-samples/${sample.id}`));
  assert.deepEqual([res.status, res.body], [200, { speakingWpm: 150, source: 'default', sampleCount: 0 }]);
  assert.equal((await t.send('DELETE', t.c(f.b, `/speaking-rate-samples/${sample.id}`))).status, 404);
});

test('SR16/SR17/SR18 a manual value wins over new reports; clearing it returns to detected, or to the default; clearing nothing is a no-op', async () => {
  const f = await withSession();
  const a = await media(f, 'a.mp4', MP4);
  await rate(f, { mediaId: a, words: 300, durationSeconds: 120 });
  await t.send('PATCH', t.c(f.b, '/settings'), { speakingWpm: 200 });
  await rate(f, { mediaId: a, words: 100, durationSeconds: 60 });
  assert.deepEqual(await settingsOf(f.b), { speakingWpm: 200, source: 'manual', sampleCount: 1 });
  const cleared = await t.send('DELETE', t.c(f.b, '/settings/speaking-speed'));
  assert.deepEqual([cleared.status, cleared.body], [200, { speakingWpm: 100, source: 'detected', sampleCount: 1 }]);
  assert.equal((await t.send('DELETE', t.c(f.b, '/settings/speaking-speed'))).status, 200);
  const [sample] = await samplesOf(f.b);
  await t.send('DELETE', t.c(f.b, `/speaking-rate-samples/${sample.id}`));
  await t.send('PATCH', t.c(f.b, '/settings'), { speakingWpm: 180 });
  assert.deepEqual((await t.send('DELETE', t.c(f.b, '/settings/speaking-speed'))).body, { speakingWpm: 150, source: 'default', sampleCount: 0 });
});

test('SR19 a sample survives a new round and reopening the video', async () => {
  const f = await withSession();
  const a = await media(f, 'a.mp4', MP4);
  await rate(f, { mediaId: a, words: 300, durationSeconds: 120 });
  assert.equal((await t.send('POST', f.c(`/assets/${f.videoAid}/session/new-round`))).status, 200);
  assert.equal((await samplesOf(f.b)).length, 1);
  assert.deepEqual(await settingsOf(f.b), { speakingWpm: 150, source: 'detected', sampleCount: 1 });
});

test('SR19b a finalized video refuses a report (409) and keeps the sample after reopening', async () => {
  const f = await withSession();
  const a = await media(f, 'a.mp4', MP4);
  await rate(f, { mediaId: a, words: 300, durationSeconds: 120 });
  await confirmed(f);
  await finalizeAndSettle(f);
  assert.equal((await rate(f, { mediaId: a, words: 200, durationSeconds: 120 })).status, 409);
  await t.send('POST', f.c(`/assets/${f.videoAid}/reopen`));
  assert.equal((await samplesOf(f.b)).length, 1);
});

test('SR20 a report and a media delete both publish the video view so the web refreshes', async () => {
  const f = await withSession();
  const a = await media(f, 'a.mp4', MP4);
  let seen = events.length;
  await rate(f, { mediaId: a, words: 300, durationSeconds: 120 });
  assert.ok(events.slice(seen).some((e) => e.view.assetId === f.videoAid && e.view.video), 'report');
  seen = events.length;
  await t.send('DELETE', f.c(`/media/${a}`));
  assert.ok(events.slice(seen).some((e) => e.view.assetId === f.videoAid && e.view.video), 'media delete');
});

test('SR21 list_media carries each file id for the report', async () => {
  const f = await withSession();
  const a = await media(f, 'a.mp4', MP4);
  const res = await tool('GET', '/media', f.sid);
  assert.equal(res.body.media[0].id, a);
});

test('jobs clock seam resets', () => { jobs.setContentJobsClock(() => new Date()); });
