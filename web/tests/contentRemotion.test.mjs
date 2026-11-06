import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const r = await import('../src/lib/contentRemotion.ts');
const rules = await import('../src/lib/contentRules.ts');
const workspace = await import('../src/lib/contentWorkspace.ts');
const { buildRunningGroups, runningStopLabel } = await import('../src/lib/runningCommands.ts');
const { useContentStore } = await import('../src/store/contentStore.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CONTENT_ROUTES } = await import('./contentStudioStub.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const docs = () => readFileSync(new URL('../../docs/content-studio-building.md', import.meta.url), 'utf8');

/** The Remotion tab's pure rules (web/src/lib/contentRemotion.ts), the footer row and the store through the daemon stand-in. Ids follow the Test Case Planning list (RW-U01…, RW-S01…). */

const studio = (over = {}) => ({ state: 'stopped', url: null, error: null, log: [], waitingForSetup: false, ...over });
const REEL = [{ platform: 'instagram', format: 'reel' }];

// ---- the tab rule ---------------------------------------------------------------------------------

test('RW-U01 the Remotion tab needs a video post first, then the composition; the script state does not matter', () => {
  const remotion = (posts, context) => rules.conceptTabStates(posts, context).find((t) => t.key === 'remotion');
  for (const scriptFinalized of [false, true]) {
    assert.equal(remotion([], { scriptFinalized, compositionReady: true }).reason, 'Add a video or reel post to use this tab');
    assert.equal(remotion([], { scriptFinalized, compositionReady: false }).reason, 'Add a video or reel post to use this tab');
    assert.deepEqual([remotion(REEL, { scriptFinalized, compositionReady: false }).enabled, remotion(REEL, { scriptFinalized, compositionReady: false }).reason], [false, 'Start the video in the Video tab first']);
    assert.deepEqual([remotion(REEL, { scriptFinalized, compositionReady: true }).enabled, remotion(REEL, { scriptFinalized, compositionReady: true }).reason], [true, null]);
  }
});

test('RW-U02 withComingSoon is gone; Images keeps its post rule and no tab says Coming soon', () => {
  assert.equal(workspace.withComingSoon, undefined);
  assert.equal(workspace.COMING_SOON_TABS, undefined);
  const tabs = rules.conceptTabStates([{ platform: 'linkedin', format: 'image' }], { scriptFinalized: true, compositionReady: true });
  assert.equal(tabs.find((t) => t.key === 'images').enabled, true);
  assert.equal(rules.conceptTabStates([], {}).find((t) => t.key === 'images').reason, 'Add an image or carousel post to use this tab');
  assert.ok(rules.conceptTabStates([]).every((t) => t.reason !== 'Coming soon'));
});

// ---- the pane state --------------------------------------------------------------------------------

test('RW-U03 the pane state for every view, with its precedence', () => {
  const pane = (view, o = {}) => r.studioPaneState(view, { readOnly: false, needsInstall: false, ...o });
  assert.equal(pane(null), 'loading');
  assert.equal(pane(studio({ state: 'starting', waitingForSetup: true })), 'waiting');
  assert.equal(pane(studio({ state: 'starting' })), 'starting');
  assert.equal(pane(studio({ state: 'running', url: 'http://127.0.0.1:3047' })), 'running');
  assert.equal(pane(studio({ state: 'failed', error: 'x' })), 'failed');
  assert.equal(pane(studio()), 'stopped');
  assert.equal(pane(studio({ state: 'running' }), { embeddable: false }), 'fallback');
  assert.equal(pane(studio(), { readOnly: true, needsInstall: true }), 'ro-refused');
  assert.equal(pane(studio({ state: 'failed' }), { readOnly: true, needsInstall: true }), 'ro-refused');
  assert.equal(pane(studio({ state: 'running' }), { readOnly: true }), 'ro-running');
  assert.equal(pane(studio({ state: 'running' }), { readOnly: true, needsInstall: true }), 'ro-running', 'a running Studio is shown even when the install is gone');
  assert.equal(pane(studio({ state: 'starting', waitingForSetup: true }), { needsInstall: true }), 'waiting', 'starting with an install running is waiting');
  assert.equal(pane(studio({ state: 'running' }), { readOnly: true, embeddable: false }), 'fallback', 'not embeddable beats read-only');
  assert.equal(pane(studio(), { readOnly: true }), 'stopped');
});

test('RW-U04 the composition url: base plus the id, a trailing slash, no base, reserved characters', () => {
  assert.equal(r.compositionUrl('http://127.0.0.1:3047', 'concept-3f9a1c2e'), 'http://127.0.0.1:3047/concept-3f9a1c2e');
  assert.equal(r.compositionUrl('http://127.0.0.1:3047/', 'concept-3f9a1c2e'), 'http://127.0.0.1:3047/concept-3f9a1c2e');
  assert.equal(r.compositionUrl(null, 'concept-3f9a1c2e'), null);
  assert.equal(r.compositionUrl('http://127.0.0.1:3047', null), null);
  assert.equal(r.compositionUrl('http://127.0.0.1:3047', 'a b/?#'), 'http://127.0.0.1:3047/a%20b%2F%3F%23');
});

test('RW-U05 the embed decision: the flag picks the iframe or the fallback, and the doc records the finding', () => {
  assert.equal(r.studioPaneState(studio({ state: 'running' }), { readOnly: false, needsInstall: false, embeddable: true }), 'running');
  assert.equal(r.studioPaneState(studio({ state: 'running' }), { readOnly: false, needsInstall: false, embeddable: false }), 'fallback');
  assert.equal(r.STUDIO_EMBEDDABLE, true);
  assert.match(docs(), /X-Frame-Options/);
  assert.match(docs(), /STUDIO_EMBEDDABLE/);
});

test('RW-U06 the narrow hint shows below 640 px only', () => {
  assert.deepEqual([639, 640, 0, 10_000].map(r.isNarrow), [true, false, true, false]);
});

test('RW-U07 the chip text of each state; a malformed url says Running', () => {
  const chip = (view, o) => r.studioChip(view, r.studioPaneState(view, { readOnly: false, needsInstall: false, ...o }));
  assert.equal(chip(studio({ state: 'starting', waitingForSetup: true })), 'Waiting for setup');
  assert.equal(chip(studio({ state: 'starting' })), 'Starting');
  assert.equal(chip(studio({ state: 'running', url: 'http://127.0.0.1:3047' })), 'Running · 127.0.0.1:3047');
  assert.equal(chip(studio({ state: 'running', url: 'not a url' })), 'Running');
  assert.equal(chip(studio({ state: 'failed', error: 'x' })), 'Failed');
  assert.equal(chip(studio({ log: ['Server ready'] })), 'Stopped');
  assert.equal(chip(studio()), 'Not started');
  assert.equal(chip(null), 'Not started');
  assert.equal(chip(studio(), { readOnly: true, needsInstall: true }), 'Not started');
});

test('RW-U08 header controls: Stop only while starting or running; the new-tab link needs a url', () => {
  const stops = ['loading', 'waiting', 'starting', 'running', 'failed', 'stopped', 'fallback', 'ro-refused', 'ro-running'].filter((p) => r.studioHeaderControls(p, null).showStop);
  assert.deepEqual(stops, ['starting', 'running', 'fallback', 'ro-running']);
  assert.deepEqual(r.studioHeaderControls('running', 'http://127.0.0.1:3047/c'), { showStop: true, openEnabled: true, openTitle: undefined });
  assert.deepEqual(r.studioHeaderControls('starting', null), { showStop: true, openEnabled: false, openTitle: 'Available while Studio is running' });
});

// ---- the heartbeat ----------------------------------------------------------------------------------

function fakeEnv(hidden = false) {
  const env = { sent: 0, isHidden: hidden, intervals: new Map(), listeners: new Set(), next: 1 };
  return Object.assign(env, {
    send: () => { env.sent++; },
    setInterval: (fn, ms) => { const id = env.next++; env.intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { env.intervals.delete(id); },
    hidden: () => env.isHidden,
    onVisibility: (fn) => { env.listeners.add(fn); return () => env.listeners.delete(fn); },
    tick: () => { for (const { fn } of env.intervals.values()) fn(); },
    show: (on) => { env.isHidden = !on; for (const fn of env.listeners) fn(); },
  });
}

test('RW-U09 heartbeats: at once while visible, then every HEARTBEAT_MS, none while hidden, at once on becoming visible, none after close', () => {
  assert.ok(r.HEARTBEAT_MS < 600_000);
  const env = fakeEnv();
  const stop = r.startHeartbeat(env);
  assert.equal(env.sent, 1);
  assert.deepEqual([...env.intervals.values()].map((i) => i.ms), [r.HEARTBEAT_MS]);
  env.tick();
  assert.equal(env.sent, 2);
  env.show(false);
  env.tick();
  assert.equal(env.sent, 2);
  env.show(true);
  assert.equal(env.sent, 3);
  stop();
  env.tick(); env.show(true);
  assert.deepEqual([env.sent, env.intervals.size, env.listeners.size], [3, 0, 0]);
  const hiddenEnv = fakeEnv(true);
  r.startHeartbeat(hiddenEnv)();
  assert.equal(hiddenEnv.sent, 0);
});

test('RW-U10 switching Concepts keeps one heartbeat interval: the effect follows the Building, not the Concept', () => {
  const hook = src('ui/content/useRemotionStudio.ts');
  assert.match(hook, /startHeartbeat\(\{[\s\S]*?\}\);\n  \}, \[enabled, projectId, store\]\);/);
  const env = fakeEnv();
  const stops = [r.startHeartbeat(env)];
  stops.shift()();
  stops.push(r.startHeartbeat(env));
  assert.equal(env.intervals.size, 1);
  stops[0]();
});

test('RW-U11 the log tail keeps the newest 200 lines', () => {
  const lines = Array.from({ length: 250 }, (_, i) => `l${i}`);
  assert.deepEqual([r.studioLogTail(lines).length, r.studioLogTail(lines)[0]], [200, 'l50']);
  const few = ['a'];
  assert.equal(r.studioLogTail(few), few);
});

// ---- the footer -----------------------------------------------------------------------------------

const projects = [{ id: 'b1', name: 'Bakery' }];
const job = (over) => ({ id: 'j1', buildingId: 'b1', status: 'running', startedAt: '2026-10-26T10:00:00Z', ...over });

test('RW-U12 the footer row: Remotion Studio in Content Studio, starting… while starting, stoppable; renders and setup unchanged', () => {
  const rows = (jobs) => buildRunningGroups({ projects, commandRunsById: {}, testRunsById: {}, contentJobsById: Object.fromEntries(jobs.map((j) => [j.id, j])) })[0].rows;
  const [starting] = rows([job({ kind: 'remotion-studio', percent: null, phase: 'starting' })]);
  assert.deepEqual([starting.name, starting.where, starting.progress, starting.stoppable, starting.contentKind, starting.startedByAgent], ['Remotion Studio', 'Content Studio', 'starting…', true, 'remotion-studio', false]);
  assert.equal(rows([job({ kind: 'remotion-studio', percent: null, phase: 'running' })])[0].progress, undefined);
  const [render] = rows([job({ id: 'r1', kind: 'render', percent: 46, renderId: 'r1', conceptId: 'c1' })]);
  assert.deepEqual([render.name, render.progress, render.stoppable, render.runId, render.conceptId], ['Video render', '46%', true, 'r1', 'c1']);
  const [setup] = rows([job({ id: 's1', kind: 'remotion-setup', percent: 10 })]);
  assert.deepEqual([setup.name, setup.progress, setup.stoppable], ['Remotion setup', '10%', false]);
});

test('RW-U13 the Stop label names the Building for Studio; a render keeps its own', () => {
  assert.equal(runningStopLabel({ name: 'Remotion Studio', contentKind: 'remotion-studio' }, 'Bakery'), 'Stop Remotion Studio for Bakery');
  assert.equal(runningStopLabel({ name: 'Video render', contentKind: 'render' }, 'Bakery'), 'Stop Video render');
  assert.equal(runningStopLabel({ name: 'Internal links crawl' }, 'Site'), 'Stop Internal links crawl');
});

test('RW-U14 becoming visible after an idle stop sends only a heartbeat, never a start', () => {
  const env = fakeEnv();
  const calls = [];
  r.startHeartbeat({ ...env, send: () => calls.push('heartbeat') });
  env.show(false); env.show(true);
  assert.deepEqual(calls, ['heartbeat', 'heartbeat']);
  assert.match(src('ui/content/useRemotionStudio.ts'), /send: \(\) => store\(\)\.heartbeatRemotion\(projectId\)/);
});

// ---- the store, through the daemon stand-in -----------------------------------------------------

const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ conceptsById: {}, studioByAsset: {}, studioBlocked: {}, remotionByBuilding: {} });
});
const store = () => useContentStore.getState();
const studioRequests = () => stub.content.requests.filter((q) => q.path.startsWith('remotion/studio')).map((q) => `${q.method} ${q.path}`);
async function composedConcept() {
  const c = await contentApi.createConcept(B, { title: 'T', brief: '', posts: [{ platform: 'instagram', format: 'reel', scheduledAt: '2026-10-27T09:00:00Z' }] });
  const video = c.assets.find((a) => a.kind === 'video').id;
  await contentApi.startStudio(B, c.id, video);
  await store().loadConcept(B, c.id);
  return { cid: c.id, video, compositionId: store().conceptsById[c.id].compositionId };
}

test('RW-S01 opening the tab reads Studio, then starts it; the state is kept per Building', async () => {
  await composedConcept();
  assert.equal((await store().openRemotion(B)).ok, true);
  assert.deepEqual(studioRequests(), ['GET remotion/studio', 'POST remotion/studio/start']);
  assert.deepEqual([store().remotionByBuilding[B].state, store().remotionByBuilding[B].url], ['running', 'http://127.0.0.1:3047']);
  assert.equal(store().remotionByBuilding.other, undefined);
});

test('RW-S02 a live event updates its own Building only; a log-only one leaves the Concepts untouched', async () => {
  const { cid } = await composedConcept();
  await store().openRemotion(B);
  const concepts = store().conceptsById;
  const studioByAsset = store().studioByAsset;
  const before = store().remotionByBuilding[B];
  store().applyRemotionEvent({ type: 'remotionStudio', buildingId: 'b2', studio: studio({ state: 'starting' }) });
  assert.equal(store().remotionByBuilding[B], before);
  store().applyRemotionEvent({ type: 'remotionStudio', buildingId: B, studio: { ...before, log: [...before.log, 'Building... 12%'] } });
  assert.equal(store().conceptsById, concepts);
  assert.equal(store().conceptsById[cid], concepts[cid]);
  assert.equal(store().studioByAsset, studioByAsset);
  assert.equal(store().remotionByBuilding.b2.state, 'starting');
  assert.equal(store().remotionByBuilding[B].log.at(-1), 'Building... 12%');
  assert.match(src('store/worldStore.ts'), /if \(event\.type === 'remotionStudio'\) useContentStore\.getState\(\)\.applyRemotionEvent\(event\);/);
});

test('RW-S03 switching Concepts reuses the one Studio and moves the iframe to the other composition', async () => {
  const a = await composedConcept();
  const b = await composedConcept();
  await store().openRemotion(B);
  await store().openRemotion(B);
  assert.equal(stub.content.remotion.spawns, 1);
  const base = store().remotionByBuilding[B].url;
  assert.notEqual(r.compositionUrl(base, a.compositionId), r.compositionUrl(base, b.compositionId));
  assert.equal(r.compositionUrl(base, b.compositionId), `http://127.0.0.1:3047/${b.compositionId}`);
});

test('RW-S04 Stop in the tab posts stop; the footer Stop of a Studio row uses the Studio route, not a render stop', async () => {
  await composedConcept();
  await store().openRemotion(B);
  assert.equal((await store().stopRemotion(B)).ok, true);
  assert.equal(store().remotionByBuilding[B].state, 'stopped');
  await store().startRemotion(B);
  await useWorldStore.getState().stopStudioFromFooter(B);
  assert.deepEqual(studioRequests().slice(-3), ['POST remotion/studio/stop', 'POST remotion/studio/start', 'POST remotion/studio/stop']);
  assert.ok(!stub.content.requests.some((q) => q.path.includes('/renders/')));
  const lists = src('ui/FooterListPopovers.tsx');
  assert.match(lists, /if \(row\.contentKind === 'remotion-studio'\) return stopStudio\(row\.projectId\);/);
});

test('RW-S05 Retry and Start Studio post start', async () => {
  await composedConcept();
  await store().startRemotion(B);
  assert.deepEqual(studioRequests(), ['POST remotion/studio/start']);
  assert.equal(stub.content.remotion.spawns, 1);
});

test('RW-S06 a 409 start keeps its message; a 404 is handled', async () => {
  const refused = await store().startRemotion(B);
  assert.deepEqual([refused.ok, refused.status, refused.error], [false, 409, 'Start the video in the Video tab first']);
  stub.content.remotion.notContent.add('seo1');
  const missing = await store().openRemotion('seo1');
  assert.deepEqual([missing.ok, missing.status], [false, 404]);
});

test('RW-S07 heartbeats are sent; a failed one is silent', async () => {
  store().heartbeatRemotion(B);
  stub.content.remotion.notContent.add('gone');
  store().heartbeatRemotion('gone');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(studioRequests(), ['POST remotion/studio/heartbeat', 'POST remotion/studio/heartbeat']);
  assert.equal(store().remotionByBuilding[B].state, 'stopped');
  assert.equal(store().remotionByBuilding.gone, undefined);
  assert.deepEqual(Object.keys(useWorldStore.getState().errorNotificationsById ?? {}).length, 0);
});

test('RW-S08 a remotion-studio job event is added to the running jobs and removed when it ends', async () => {
  const { mergeContentJobEvent } = await import('../src/store/worldStore.ts');
  const added = mergeContentJobEvent({}, {}, job({ kind: 'remotion-studio', phase: 'starting' }));
  assert.deepEqual(Object.keys(added.contentJobsById), ['j1']);
  const ended = mergeContentJobEvent(added.contentJobsById, added.settledContentJobIds ?? {}, job({ kind: 'remotion-studio', status: 'stopped' }));
  assert.deepEqual(ended.contentJobsById, {});
});

test('RW-S09 the stand-in lists and answers the four Studio routes; 404 for another type; 409 with no project', async () => {
  const routes = CONTENT_ROUTES.map(([m, p]) => `${m} ${p}`);
  for (const route of ['GET remotion/studio', 'POST remotion/studio/start', 'POST remotion/studio/stop', 'POST remotion/studio/heartbeat']) assert.ok(routes.includes(route), route);
  assert.equal((await contentApi.remotionStudio(B)).state, 'stopped');
  await assert.rejects(contentApi.remotionStudioAction(B, 'start'), { status: 409 });
  assert.equal((await contentApi.remotionStudioAction(B, 'stop')).state, 'stopped');
  assert.equal((await contentApi.remotionStudioAction(B, 'heartbeat')).state, 'stopped');
  stub.content.remotion.notContent.add('crm1');
  await assert.rejects(contentApi.remotionStudio('crm1'), { status: 404 });
});

test('WU22/WU24 the Remotion tab and the Video tab share one Studio hook; the effects follow the Building and the enabled flag, never render progress', () => {
  const hook = src('ui/content/useRemotionStudio.ts');
  assert.match(hook, /if \(enabled\) void store\(\)\.openRemotion\(projectId\)[\s\S]*?\}, \[enabled, projectId, store\]\);/);
  assert.match(src('ui/content/RemotionTab.tsx'), /useRemotionStudio\(\{ projectId, videoAssetId, readOnly \}\)/);
  const video = src('ui/content/VideoTab.tsx');
  assert.match(video, /useRemotionStudio\(\{ projectId, videoAssetId: assetId, readOnly: ro, enabled: videoPaneState\(view\) === 'preview' \}\)/);
  for (const file of ['ui/content/VideoTab.tsx', 'ui/content/VideoTabView.tsx']) assert.doesNotMatch(src(file), /startHeartbeat|heartbeatRemotion|openRemotion/, `${file} copies none of the hook`);
});

test('WU17/WU18 the Video preview url and pane: encoded composition ids, a project that needs install maps to waiting', () => {
  assert.equal(r.compositionUrl('http://127.0.0.1:3047/', 'a b/c#d'), 'http://127.0.0.1:3047/a%20b%2Fc%23d');
  assert.equal(r.compositionUrl(null, 'x'), null);
  assert.equal(r.compositionUrl('http://127.0.0.1:3047', ''), null);
  const waiting = { state: 'starting', url: null, error: null, log: [], waitingForSetup: true };
  assert.equal(r.studioPaneState(waiting, { readOnly: false, needsInstall: true }), 'waiting');
  assert.equal(r.studioPaneState({ ...waiting, state: 'stopped' }, { readOnly: true, needsInstall: true }), 'ro-refused');
  assert.equal(r.studioPaneState({ ...waiting, state: 'running', url: 'http://127.0.0.1:1' }, { readOnly: false, needsInstall: false, embeddable: false }), 'fallback');
});
