import assert from 'node:assert/strict';
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

const { useContentStore } = await import('../src/store/contentStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { imagesState, shownRound } = await import('../src/lib/contentImages.ts');
const { buildRunningGroups } = await import('../src/lib/runningCommands.ts');
const { mergeContentJobEvent } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { addImageRender } = await import('./contentStudioStub.mjs');

/** The Images tab's store actions against the daemon stand-in (S01…S08 in the Test Case Planning list). */

const B = 'b1';
let stub;
let fx;
beforeEach(async () => {
  stub = installServerStub();
  useContentStore.setState({ listByProject: {}, calendarByProject: {}, conceptsById: {}, missingByPost: {}, studioByAsset: {}, studioBlocked: {}, uploadsByConcept: {} });
  const c = await contentApi.createConcept(B, { title: 'Launch', brief: '', posts: [{ platform: 'instagram', format: 'carousel', scheduledAt: '2026-11-03T09:00:00Z' }, { platform: 'x', format: 'image', scheduledAt: '2026-11-04T09:00:00Z' }] });
  const setOf = (i) => c.posts[i].needs.find((a) => a.kind === 'image-set').id;
  fx = { cid: c.id, aid: setOf(0), other: setOf(1) };
  await useContentStore.getState().loadConcept(B, c.id);
});
const store = () => useContentStore.getState();
const view = (aid = fx.aid) => store().studioByAsset[aid];
const url = (path) => `http://localhost:4500/api/projects/${B}/content/${path}`;

test('S01 opening the tab reads the image view and starts round 1', async () => {
  assert.equal((await store().openStudio(B, fx.cid, fx.aid)).ok, true);
  assert.equal(view().session.tab, 'images');
  assert.equal(view().images.platform, 'instagram');
  assert.deepEqual(view().images.defaultSize, { width: 1080, height: 1350 });
  assert.equal(imagesState(view()), 'empty');
  assert.equal(stub.content.requests.filter((r) => r.method === 'POST' && r.path.endsWith(`${fx.aid}/session`)).length, 1);
});

test('S02 studioAsset events update the gallery; an older rev is dropped', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addImageRender(stub.content, B, fx.aid, { total: 3 });
  const fresh = await contentApi.studio(B, fx.cid, fx.aid);
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: fresh });
  assert.equal(shownRound(view()).images.length, 3);
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...fresh, rev: fresh.rev - 5, images: { ...fresh.images, rounds: [] } } });
  assert.equal(shownRound(view()).images.length, 3, 'the late, older view is dropped');
});

test('S03 a refused finalize keeps its reason; a fitting set finalizes', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addImageRender(stub.content, B, fx.aid, { total: 1 });
  const refused = await store().studioAction(B, fx.cid, fx.aid, 'finalize');
  assert.deepEqual([refused.ok, refused.status], [false, 409]);
  assert.match(refused.error, /this round has 1/);
  addImageRender(stub.content, B, fx.aid, { total: 4 });
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'finalize')).ok, true);
  assert.equal(imagesState(view()), 'finalized');
  assert.equal(store().conceptsById[fx.cid].posts[0].needs.find((a) => a.kind === 'image-set').state, 'finalized');
});

test('S04 reopen and a new session through the stand-in', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'session/new-round')).ok, true);
  assert.equal(view().asset.round, 2);
  addImageRender(stub.content, B, fx.aid, { total: 2 });
  await store().studioAction(B, fx.cid, fx.aid, 'finalize');
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'reopen')).ok, true);
  assert.deepEqual([view().asset.state, view().asset.round, view().session.round], ['drafting', 3, 3]);
});

test('S05 Stop calls the images stop route and the view follows', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  const call = addImageRender(stub.content, B, fx.aid, { total: 5, done: 2, status: 'running' });
  assert.equal((await store().stopImageRender(B, fx.cid, fx.aid, call.id)).ok, true);
  assert.ok(stub.content.requests.some((r) => r.method === 'POST' && r.path === `assets/${fx.aid}/images/renders/${call.id}/stop`));
  assert.equal(imagesState(view()), 'stopped');
  const again = await store().stopImageRender(B, fx.cid, fx.aid, call.id);
  assert.deepEqual([again.ok, again.status], [false, 409]);
});

test('S06 the stand-in image and zip routes: 200, unknown file 404, traversal 404', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addImageRender(stub.content, B, fx.aid, { total: 2 });
  assert.equal((await fetch(url(`assets/${fx.aid}/images/rounds/1/image-01.png`))).status, 200);
  assert.equal((await fetch(url(`assets/${fx.aid}/images/rounds/1/images.zip`))).status, 200);
  for (const bad of ['rounds/1/image-03.png', 'rounds/2/images.zip', 'rounds/1/..%2Fx', 'rounds/x/image-01.png', 'renders/nope/stop']) {
    assert.equal((await fetch(url(`assets/${fx.aid}/images/${bad}`), { method: bad.startsWith('renders') ? 'POST' : 'GET' })).status, 404, bad);
  }
  assert.equal((await fetch(url('assets/unknown/images/rounds/1/image-01.png'))).status, 404);
});

test('S07 a contentJob images event adds a footer row and its end removes it', () => {
  const job = { id: 'j1', buildingId: B, kind: 'images', status: 'running', startedAt: '2026-10-26T10:00:00Z', conceptId: fx.cid, assetId: fx.aid, renderId: 'ir1', done: 1, total: 4 };
  const started = mergeContentJobEvent({}, {}, job);
  const rows = (jobs) => buildRunningGroups({ projects: [{ id: B, name: 'Acme' }], commandRunsById: {}, testRunsById: {}, contentJobsById: jobs }).flatMap((g) => g.rows);
  assert.deepEqual(rows(started.contentJobsById).map((r) => [r.name, r.progress, r.assetId]), [['Image render', '1 of 4 images', fx.aid]]);
  const ended = mergeContentJobEvent(started.contentJobsById, started.settledContentJobIds, { ...job, status: 'complete' });
  assert.deepEqual(rows(ended.contentJobsById), []);
});

test('S08 an images event or a terminal chunk leaves other assets alone; an unchanged images part keeps its object', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  await store().openStudio(B, fx.cid, fx.other);
  const other = view(fx.other);
  const before = view();
  addImageRender(stub.content, B, fx.aid, { total: 3, done: 1, status: 'running' });
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: await contentApi.studio(B, fx.cid, fx.aid) });
  assert.equal(view(fx.other), other, 'another asset keeps its view object');
  assert.notEqual(view(), before);
  const progressed = view();
  // The same images again (a terminal chunk or a session-only change rebuilds the view): the gallery's object stays.
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: await contentApi.studio(B, fx.cid, fx.aid) });
  assert.equal(view().images, progressed.images);
  assert.equal(view(fx.other), other);
});
