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
const { thumbnailState, thumbnailVariants, thumbnailReopenBlock } = await import('../src/lib/contentThumbnail.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { addThumbnailRender } = await import('./contentStudioStub.mjs');

/** The Thumbnail tab's store actions against the daemon stand-in (TI01…TI24 in the Test Case Planning list). */

const B = 'b1';
let stub;
let fx;
beforeEach(async () => {
  stub = installServerStub();
  useContentStore.setState({ listByProject: {}, calendarByProject: {}, conceptsById: {}, missingByPost: {}, studioByAsset: {}, studioBlocked: {}, uploadsByConcept: {} });
  const c = await contentApi.createConcept(B, { title: 'Launch', brief: '', posts: [{ platform: 'linkedin', format: 'video', scheduledAt: '2026-11-03T09:00:00Z' }, { platform: 'linkedin', format: 'text', scheduledAt: '2026-11-04T09:00:00Z' }] });
  fx = { cid: c.id, aid: c.assets.find((a) => a.kind === 'thumbnail').id, video: c.posts[0].id, text: c.posts[1].id };
  await useContentStore.getState().loadConcept(B, c.id);
});
const store = () => useContentStore.getState();
const view = () => store().studioByAsset[fx.aid];
const asset = () => store().conceptsById[fx.cid].assets.find((a) => a.id === fx.aid);
const posts = (suffix) => stub.content.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
const fresh = async () => store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: await contentApi.studio(B, fx.cid, fx.aid) });

test('TI01 opening the tab starts round 1 and the view carries the thumbnail part', async () => {
  assert.equal((await store().openStudio(B, fx.cid, fx.aid)).ok, true);
  assert.equal(view().session.tab, 'thumbnail');
  assert.deepEqual(view().thumbnail.defaultSize, { width: 1280, height: 720 });
  assert.equal(thumbnailState(view()), 'empty');
  assert.equal(posts(`${fx.aid}/session`).length, 1);
});

test('TI02 a session that is already running is not started again', async () => {
  await contentApi.startStudio(B, fx.cid, fx.aid);
  await store().openStudio(B, fx.cid, fx.aid);
  assert.equal(posts(`${fx.aid}/session`).length, 1);
});

test('TI03 a blocked start keeps its reason and sends no second start; Start retries', async () => {
  stub.content.studio.agent = false;
  await store().openStudio(B, fx.cid, fx.aid);
  assert.match(store().studioBlocked[fx.aid], /default coding agent/);
  assert.equal(posts(`${fx.aid}/session`).length, 1);
  stub.content.studio.agent = true;
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'session/start')).ok, true);
  assert.equal(store().studioBlocked[fx.aid] ?? null, null);
  assert.ok(view().session);
});

test('TI04 Remotion setup running and failed come through the part', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  stub.content.studio.panes.get(fx.aid).setup = { status: 'failed', error: 'npm exited with code 1', percent: null };
  await fresh();
  assert.equal(view().thumbnail.setup.error, 'npm exited with code 1');
});

test('TI05 studioAsset events update the rounds; an older rev is dropped', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 3 });
  await fresh();
  assert.equal(thumbnailVariants(view()).length, 3);
  const current = view();
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...current, rev: current.rev - 5, thumbnail: { ...current.thumbnail, rounds: [] } } });
  assert.equal(thumbnailVariants(view()).length, 3);
});

test('TI06 finalize sends the chosen file and the view becomes finalized with the final', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 3 });
  const result = await store().studioAction(B, fx.cid, fx.aid, 'finalize', { file: 'thumb-02.png' });
  assert.equal(result.ok, true);
  assert.deepEqual(posts('/finalize').at(-1).body, { file: 'thumb-02.png' });
  assert.equal(thumbnailState(view()), 'finalized');
  assert.equal(view().thumbnail.final.name, 'thumb-02.png');
  assert.equal(asset().state, 'finalized', 'the Concept follows');
});

test('TI07 finalize while a render runs is refused; the asset stays drafting', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 3, done: 1, status: 'running' });
  const r = await store().studioAction(B, fx.cid, fx.aid, 'finalize', { file: 'thumb-01.png' });
  assert.deepEqual([r.ok, r.status], [false, 409]);
  assert.match(r.error, /once the render finishes/);
  assert.notEqual(view().asset.state, 'finalized');
});

test('TI08 finalize refuses a file the last render does not have', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 3 });
  for (const file of ['thumb-00.png', 'thumb-06.png', '../thumb-01.png', 'THUMB-01.PNG', 'thumb-1.png', '', 7, undefined]) {
    const r = await store().studioAction(B, fx.cid, fx.aid, 'finalize', { file });
    assert.deepEqual([r.ok, r.status], [false, 400], String(file));
  }
  assert.notEqual(view().asset.state, 'finalized');
});

test('TI10/TI11 reopen puts the asset back to drafting; a published post refuses it', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 2 });
  await store().studioAction(B, fx.cid, fx.aid, 'finalize', { file: 'thumb-01.png' });
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'reopen')).ok, true);
  assert.equal(view().asset.state, 'drafting');
  assert.equal(view().thumbnail.final, null);
  const c = store().conceptsById[fx.cid];
  assert.equal(thumbnailReopenBlock(c, fx.aid), null);
  const published = { ...c, posts: c.posts.map((p) => (p.id === fx.video ? { ...p, status: 'published' } : p)) };
  assert.equal(thumbnailReopenBlock(published, fx.aid), 'Used by a published post');
});

test('TI12 a new session starts the next round and keeps the old thumbnails under it', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 2 });
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'session/new-round')).ok, true);
  assert.equal(view().asset.round, 2);
  assert.equal(view().thumbnail.rounds.length, 1);
  assert.equal(view().thumbnail.rounds[0].round, 1);
});

test('TI13/TI14 Stop stops a running render; an unknown render is refused in words', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  const call = addThumbnailRender(stub.content, B, fx.aid, { total: 3, done: 1, status: 'running' });
  assert.equal((await store().stopThumbnailRender(B, fx.cid, fx.aid, call.id)).ok, true);
  assert.equal(posts(`/thumbnail/renders/${call.id}/stop`).length, 1);
  assert.equal(thumbnailState(view()), 'stopped');
  const again = await store().stopThumbnailRender(B, fx.cid, fx.aid, call.id);
  assert.deepEqual([again.ok, again.status], [false, 409]);
  const unknown = await store().stopThumbnailRender(B, fx.cid, fx.aid, 'nope');
  assert.deepEqual([unknown.ok, unknown.status, unknown.error], [false, 404, 'That render does not exist']);
});

test('TI15 thumbnail files: the PNG answers, a bad name or round is 404', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 2 });
  const get = (path) => fetch(`http://localhost:4500/api/projects/${B}/content/assets/${fx.aid}/thumbnail/${path}`);
  assert.equal((await get('rounds/1/thumb-01.png')).status, 200);
  for (const path of ['rounds/1/thumb-09.png', 'rounds/1/evil.png', 'rounds/0/thumb-01.png', 'rounds/999/thumb-01.png']) assert.equal((await get(path)).status, 404, path);
});

test('TI16 publish media carries the thumbnail for the video post, none for text', async () => {
  const c = store().conceptsById[fx.cid];
  const video = c.posts.find((p) => p.id === fx.video);
  assert.ok(video.needs.some((a) => a.kind === 'thumbnail'));
  assert.equal(c.posts.find((p) => p.id === fx.text).needs.some((a) => a.kind === 'thumbnail'), false);
  assert.equal((await contentApi.postMedia(B, fx.cid, fx.text)).thumbnail, null);
});

test('TI17 finalizing updates the Concept asset list', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 1 });
  await store().studioAction(B, fx.cid, fx.aid, 'finalize', { file: 'thumb-01.png' });
  assert.equal(asset().state, 'finalized');
  await store().studioAction(B, fx.cid, fx.aid, 'reopen');
  assert.equal(asset().state, 'drafting');
});

test('TI18 a read-only open does not start a session', async () => {
  await store().openStudio(B, fx.cid, fx.aid, false);
  assert.equal(posts(`${fx.aid}/session`).length, 0);
  assert.equal(view().session, null);
});

test('TI19 a daemon failure on finalize is returned, not thrown', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  stub.content.answers[`POST concepts/${fx.cid}/assets/${fx.aid}/finalize`] = () => ({ status: 500, body: { error: 'Something broke' } });
  const r = await store().studioAction(B, fx.cid, fx.aid, 'finalize', { file: 'thumb-01.png' });
  assert.deepEqual([r.ok, r.status, r.error], [false, 500, 'Something broke']);
});

test('TI21 a studioAsset event arriving while finalize is in flight does not undo the finalized view', async () => {
  await store().openStudio(B, fx.cid, fx.aid);
  addThumbnailRender(stub.content, B, fx.aid, { total: 2 });
  let release;
  stub.content.delays[`POST concepts/${fx.cid}/assets/${fx.aid}/finalize`] = () => new Promise((resolve) => { release = resolve; });
  const pending = store().studioAction(B, fx.cid, fx.aid, 'finalize', { file: 'thumb-01.png' });
  await new Promise((r) => setTimeout(r, 0));
  const before = view();
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...before, rev: before.rev + 1 } });
  release();
  await pending;
  assert.equal(view().asset.state, 'finalized');
  assert.equal(view().thumbnail.final.name, 'thumb-01.png');
});

test('TI24 the stub answers every thumbnail route the server mounts', async () => {
  const { CONTENT_ROUTES } = await import('./contentStudioStub.mjs');
  const routes = CONTENT_ROUTES.map(([m, p]) => `${m} ${p}`);
  for (const route of ['GET assets/:aid/thumbnail/rounds/:round/:file', 'POST assets/:aid/thumbnail/renders/:rid/stop']) assert.ok(routes.includes(route), route);
});
