import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { WebSocket } from 'ws';
import type { StudioSpawnRequest } from '../src/content/remotionStudio.ts';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';
import { fakeVideo, gate, waitFor } from './helpers/videoFakes.ts';

/**
 * The Remotion tab's Studio routes end to end through the real daemon (`api/remotionStudioRoutes.ts`): the process spawner,
 * port finder, timers, npm install and the agent terminal are fakes; every file lives in a temp folder. Case ids follow the Test
 * Case Planning list (RS-I01…).
 */

let t: ContentApi;
let service: StudioSessions;
let video: ReturnType<typeof fakeVideo>;
let token: string;
let home: string;
let studio: typeof import('../src/content/remotionStudio.ts');
let videoDeps: typeof import('../src/content/videoDeps.ts');

interface FakeChild { request: StudioSpawnRequest; kills: number }
let children: FakeChild[];
let timers: Set<{ ms: number; fn: () => void }>;
let nextPort: number;

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'studio-home-'));
  t = await startContentApi(async () => {
    const mod = await import('../src/content/studioSessions.ts');
    studio = await import('../src/content/remotionStudio.ts');
    videoDeps = await import('../src/content/videoDeps.ts');
    token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
    const terminal = fakeTerminalHost();
    service = mod.createStudioSessions({ host: { ...terminal.host, sessionExists: () => true }, defaultAgentId: async () => 'test-claude-cli', home });
    return { studioSessions: service };
  });
});
after(async () => { studio.resetStudio(); videoDeps.resetVideo(); await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => {
  children = [];
  timers = new Set();
  nextPort = 3047;
  video = fakeVideo();
  videoDeps.configureVideo({ installer: video.installer, renderer: video.renderer, prober: video.prober, submitDelayMs: 0 });
  studio.configureStudio({
    spawner: { spawn(request) { const child = { request, kills: 0 }; children.push(child); return { kill: () => { child.kills++; } }; } },
    findPort: async () => nextPort++,
    setTimer: (fn, ms) => { const timer = { ms, fn }; timers.add(timer); return () => { timers.delete(timer); }; },
  });
});
afterEach(async () => { for (const c of children) c.request.onExit(0); });

// ---- helpers -----------------------------------------------------------------------------------

const REEL = { platform: 'instagram', format: 'reel', scheduledAt: '2026-11-03T09:00:00Z' };
const s = (b: string, suffix = '') => t.c(b, `/remotion/studio${suffix}`);
const ready = (child: FakeChild) => child.request.onOutput(`Server ready - Local: http://localhost:${child.request.port}\n`, 'stdout');
/** Fires the pending timers of this length (the idle timer is 10 minutes, the start timeout 2). */
const fire = (ms: number) => { for (const timer of [...timers].filter((x) => x.ms === ms)) { timers.delete(timer); timer.fn(); } };

interface Fx { b: string; cid: string; scriptAid: string; videoAid: string; c: (suffix: string) => string }
async function concept(b?: string): Promise<Fx> {
  const building = b ?? await t.createStudio('Acme');
  const c = await t.send('POST', t.c(building, '/concepts'), { title: 'Launch', brief: 'Why', posts: [REEL] });
  assert.equal(c.status, 201, c.text);
  return {
    b: building, cid: c.body.id,
    scriptAid: c.body.assets.find((a: any) => a.kind === 'script').id, videoAid: c.body.assets.find((a: any) => a.kind === 'video').id,
    c: (suffix: string) => t.c(building, `/concepts/${c.body.id}${suffix}`),
  };
}
/** Finalizing the script starts the video session, which scaffolds the Remotion project and this Concept's composition. */
async function withVideo(b?: string): Promise<Fx> {
  const f = await concept(b);
  const session = await t.send('POST', f.c(`/assets/${f.scriptAid}/session`));
  assert.equal(session.status, 201, session.text);
  await t.api(`/api/studio-session/draft?taskId=${session.body.session.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: 'Hook. Body.' }) });
  assert.equal((await t.send('POST', f.c(`/assets/${f.scriptAid}/finalize`))).status, 200);
  await waitFor(async () => (await t.api(f.c(`/assets/${f.videoAid}/session`))).body.session?.state === 'running', 'video session');
  return f;
}
async function running(b: string): Promise<FakeChild> {
  assert.equal((await t.send('POST', s(b, '/start'))).status, 200);
  const child = await waitFor(() => children.find((c) => c.request.dir.includes(b)), 'spawn');
  ready(child);
  return child;
}
const view = async (b: string) => (await t.api(s(b))).body;

// ---- the routes ------------------------------------------------------------------------------------

test('RS-I01 GET at first is stopped with nothing set', async () => {
  const b = await t.createStudio();
  assert.deepEqual(await view(b), { state: 'stopped', url: null, error: null, log: [], waitingForSetup: false });
});

test('RS-I02/RS-I03 start answers starting, the ready line makes it running; a second start reuses it', async () => {
  const f = await withVideo();
  const first = await t.send('POST', s(f.b, '/start'));
  assert.deepEqual([first.status, first.body.state], [200, 'starting']);
  const child = await waitFor(() => children[0], 'spawn');
  ready(child);
  assert.deepEqual([(await view(f.b)).state, (await view(f.b)).url], ['running', 'http://127.0.0.1:3047']);
  const again = await t.send('POST', s(f.b, '/start'));
  assert.deepEqual([again.status, again.body.state, children.length], [200, 'running', 1]);
  await t.send('POST', s(f.b, '/stop'));
});

test('RS-I04 start before any video session is 409 and spawns nothing', async () => {
  const f = await concept();
  const res = await t.send('POST', s(f.b, '/start'));
  assert.deepEqual([res.status, res.body.error], [409, 'Start the video in the Video tab first']);
  assert.equal(children.length, 0);
});

test('RS-I05 read-only: start needing the install is 409 with nothing installed; installed starts; GET, stop and heartbeat work', async () => {
  const f = await withVideo();
  const marker = path.join(t.dataDir, 'buildings', f.b, 'remotion', '.agent-visual-os-installed');
  await rm(marker);
  await t.projectsDb.update(f.b, { readOnlyReason: 'Migration failed for the test' });
  const installs = video.state.installs;
  const refused = await t.send('POST', s(f.b, '/start'));
  assert.deepEqual([refused.status, refused.body.error], [409, "Studio can't start: this Building is read-only and the Remotion project still needs its packages installed."]);
  assert.equal(video.state.installs, installs);
  assert.equal(children.length, 0);
  await writeFile(marker, '4.0.529\n');
  assert.equal((await t.send('POST', s(f.b, '/start'))).status, 200);
  assert.equal((await t.api(s(f.b))).status, 200);
  assert.equal((await t.send('POST', s(f.b, '/heartbeat'))).status, 200);
  assert.deepEqual([(await t.send('POST', s(f.b, '/stop'))).status, (await view(f.b)).state], [200, 'stopped']);
  await t.projectsDb.update(f.b, { readOnlyReason: undefined });
});

test('RS-I06 stop while running is stopped; again while stopped is a 200 no-op', async () => {
  const f = await withVideo();
  const child = await running(f.b);
  const res = await t.send('POST', s(f.b, '/stop'));
  assert.deepEqual([res.status, res.body.state, child.kills], [200, 'stopped', 1]);
  const again = await t.send('POST', s(f.b, '/stop'));
  assert.deepEqual([again.status, again.body.state, child.kills], [200, 'stopped', 1]);
});

test('RS-I07 heartbeat answers the view and never starts a stopped Studio', async () => {
  const f = await withVideo();
  const res = await t.send('POST', s(f.b, '/heartbeat'));
  assert.deepEqual([res.status, res.body.state], [200, 'stopped']);
  assert.equal(children.length, 0);
});

test('RS-I08 GET is a pure read: it starts nothing and does not reset the idle timer', async () => {
  const f = await withVideo();
  assert.equal((await view(f.b)).state, 'stopped');
  assert.equal(children.length, 0);
  await running(f.b);
  const idle = [...timers].filter((x) => x.ms === 600_000);
  await view(f.b);
  assert.deepEqual([...timers].filter((x) => x.ms === 600_000), idle, 'the same idle timer, not a new one');
  await t.send('POST', s(f.b, '/stop'));
});

test('RS-I09 every route is 404 for an unknown id, a malformed id and a Building of another type', async () => {
  const seo = (await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' })).body.id;
  for (const id of ['00000000-0000-4000-8000-000000000000', 'not-an-id', seo]) {
    assert.equal((await t.api(s(id))).status, 404, id);
    for (const verb of ['start', 'stop', 'heartbeat']) assert.equal((await t.send('POST', s(id, `/${verb}`))).status, 404, `${id} ${verb}`);
  }
});

test('RS-I10 other spellings are 404: a deeper path and GET on an action', async () => {
  const f = await withVideo();
  assert.equal((await t.send('POST', s(f.b, '/start/extra'))).status, 404);
  assert.equal((await t.api(s(f.b, '/start'))).status, 404);
  assert.equal((await t.send('POST', s(f.b, '/restart'))).status, 404);
  assert.equal(children.length, 0);
});

test('RS-I11 the POST body is ignored: no port or host comes from it, and a non-JSON body changes nothing', async () => {
  const f = await withVideo();
  assert.equal((await t.send('POST', s(f.b, '/start'), { port: 1, host: '0.0.0.0' })).status, 200);
  const child = await waitFor(() => children[0], 'spawn');
  assert.equal(child.request.port, 3047);
  ready(child);
  assert.equal((await view(f.b)).url, 'http://127.0.0.1:3047');
  const text = await t.api(s(f.b, '/heartbeat'), { method: 'POST', body: 'not json', headers: { 'content-type': 'text/plain' } });
  assert.equal(text.status, 200);
  await t.send('POST', s(f.b, '/stop'));
});

test('RS-I12/RS-I13 /ws carries remotionStudio and remotion-studio job events; the running list has the job while it lives', async () => {
  const f = await withVideo();
  const ws = new WebSocket(`${t.baseUrl.replace('http', 'ws')}/ws`);
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => ws.once('open', resolve));
  await t.send('POST', s(f.b, '/start'));
  const listed = async () => (await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.kind === 'remotion-studio' && j.buildingId === f.b);
  assert.equal((await listed()).length, 1);
  ready(await waitFor(() => children[0], 'spawn'));
  await t.send('POST', s(f.b, '/stop'));
  const mine = (type: string) => messages.filter((m) => m.type === type && (m.buildingId ?? m.job?.buildingId) === f.b);
  await waitFor(() => mine('remotionStudio').length >= 3, 'studio events');
  assert.deepEqual(mine('remotionStudio').map((m) => m.studio.state), ['starting', 'running', 'stopped']);
  const jobs = await waitFor(() => (mine('contentJob').length >= 3 ? mine('contentJob') : null), 'job events');
  assert.deepEqual(jobs.map((m) => [m.job.kind, m.job.status, m.job.phase]), [['remotion-studio', 'running', 'starting'], ['remotion-studio', 'running', 'running'], ['remotion-studio', 'stopped', 'running']]);
  assert.deepEqual(await listed(), []);
  ws.close();
});

test('RS-I13 a failed Studio leaves the running list', async () => {
  const f = await withVideo();
  await t.send('POST', s(f.b, '/start'));
  const child = await waitFor(() => children[0], 'spawn');
  child.request.onExit(1);
  assert.equal((await view(f.b)).state, 'failed');
  assert.equal((await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.kind === 'remotion-studio' && j.buildingId === f.b).length, 0);
});

test('RS-I14 deleting the Building kills Studio, ends its job, and its routes then 404', async () => {
  const f = await withVideo();
  const child = await running(f.b);
  assert.equal((await t.send('DELETE', `/api/projects/${f.b}`)).status, 204);
  assert.equal(child.kills, 1);
  assert.equal((await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.buildingId === f.b).length, 0);
  assert.equal((await t.api(s(f.b))).status, 404);
});

test('RS-I15 deleting a Concept leaves the shared Studio running', async () => {
  const f = await withVideo();
  const child = await running(f.b);
  assert.equal((await t.send('DELETE', f.c(''))).status, 204);
  assert.deepEqual([(await view(f.b)).state, child.kills], ['running', 0]);
  await t.send('POST', s(f.b, '/stop'));
});

test('RS-I16 the Concept carries its composition id once the video session scaffolds it', async () => {
  const f = await concept();
  assert.equal((await t.api(f.c(''))).body.compositionId, null);
  const g = await withVideo(f.b);
  assert.match((await t.api(g.c(''))).body.compositionId, /^concept-[0-9a-f]{8}$/);
  const list = (await t.api(t.c(f.b, '/concepts'))).body.rows;
  assert.equal(list.find((r: any) => r.id === f.cid).compositionId, null);
  assert.equal(list.find((r: any) => r.id === g.cid).compositionId, (await t.api(g.c(''))).body.compositionId);
});

test('RS-I17 start during the install that a video session began waits for it, then runs', async () => {
  video.state.installGate = gate();
  const f = await concept();
  const session = await t.send('POST', f.c(`/assets/${f.scriptAid}/session`));
  await t.api(`/api/studio-session/draft?taskId=${session.body.session.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: 'Hook.' }) });
  await t.send('POST', f.c(`/assets/${f.scriptAid}/finalize`));
  await waitFor(async () => (await t.api(f.c(`/assets/${f.videoAid}/session`))).body.video?.setup.status === 'running', 'the install');
  // The install scaffolds the project first; Studio needs its entry file.
  await waitFor(() => existsSync(path.join(t.dataDir, 'buildings', f.b, 'remotion', 'src', 'index.ts')), 'the scaffold');
  const res = await t.send('POST', s(f.b, '/start'));
  assert.deepEqual([res.status, res.body.state, res.body.waitingForSetup], [200, 'starting', true], res.text);
  assert.equal(children.length, 0);
  video.state.installGate.open();
  const child = await waitFor(() => children[0], 'spawn after the install');
  ready(child);
  assert.deepEqual([(await view(f.b)).state, (await view(f.b)).waitingForSetup], ['running', false]);
  await t.send('POST', s(f.b, '/stop'));
});

test('RS-I18 nothing about Studio is stored: the data folder holds no Studio state and the daemon starts none at boot', async () => {
  const f = await withVideo();
  await running(f.b);
  const files = await readdir(t.dataDir, { recursive: true });
  assert.ok(!files.some((name) => /studio-?process|remotion-studio/i.test(String(name))), 'no Studio state on disk');
  const index = await readFile(path.join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.deepEqual(index.match(/remotionStudios\.\w+/g), ['remotionStudios.killAll']);
  await t.send('POST', s(f.b, '/stop'));
});

test('RS-I19 the idle stop through the routes: start, heartbeat, then the idle timer fires', async () => {
  const f = await withVideo();
  await running(f.b);
  assert.equal((await t.send('POST', s(f.b, '/heartbeat'))).status, 200);
  assert.equal([...timers].filter((x) => x.ms === 600_000).length, 1, 'the heartbeat replaced the idle timer');
  fire(600_000);
  assert.equal((await view(f.b)).state, 'stopped');
  assert.equal((await t.api('/api/content/jobs/running')).body.jobs.filter((j: any) => j.kind === 'remotion-studio' && j.buildingId === f.b).length, 0);
});

test('RS-I20 wiring: the exit handler kills every Studio; deleting a Building stops Studio before its database closes', async () => {
  const index = await readFile(path.join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(index, /process\.on\('exit', \(\) => \{[^}]*remotionStudios\.killAll\(\);/);
  const type = await readFile(path.join(import.meta.dirname, '..', 'src', 'buildings', 'types', 'contentStudio.ts'), 'utf8');
  assert.ok(type.indexOf('remotionStudios.forget(buildingId)') > 0 && type.indexOf('remotionStudios.forget(buildingId)') < type.indexOf('forgetContent(buildingId)'));
  const ws = await readFile(path.join(import.meta.dirname, '..', 'src', 'api', 'ws.ts'), 'utf8');
  assert.match(ws, /remotionStudios\.onEvent\(broadcast\)/);
});
