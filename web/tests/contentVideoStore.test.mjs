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
const { videoPaneState } = await import('../src/lib/contentVideo.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { addRender, videoPane } = await import('./contentStudioStub.mjs');

/** The Video tab's store actions against the daemon stand-in (S01…S12 in the Test Case Planning list). */

const B = 'b1';
let stub;
let fx;
beforeEach(async () => {
  stub = installServerStub();
  useContentStore.setState({ listByProject: {}, calendarByProject: {}, conceptsById: {}, missingByPost: {}, studioByAsset: {}, studioBlocked: {}, uploadsByConcept: {} });
  const c = await contentApi.createConcept(B, { title: 'Launch', brief: '', posts: [{ platform: 'instagram', format: 'reel', scheduledAt: '2026-11-03T09:00:00Z' }] });
  fx = { cid: c.id, aid: c.assets.find((a) => a.kind === 'video').id };
});
const store = () => useContentStore.getState();
const view = () => store().studioByAsset[fx.aid];
const blob = (name, size = 10) => Object.assign(new Blob([new Uint8Array(size)]), { name });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const withChecklist = (items) => { videoPane(stub.content, fx.aid).checklist = { items, confirmedAt: null }; };
const started = async () => { assert.equal((await store().startVideo(B, fx.cid, fx.aid)).ok, true); };

test('S01 opening the tab reads the view with media and checklist, and starts nothing', async () => {
  assert.equal((await store().openStudio(B, fx.cid, fx.aid, false)).ok, true);
  assert.equal(view().session, null);
  assert.deepEqual(view().video.media, []);
  assert.deepEqual(view().video.checklist.items, []);
  assert.equal(stub.content.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/session')).length, 0);
});

test('S02/S03 uploads send raw bytes with the name, progress reaches the end, the list updates; a refused file shows on its row', async () => {
  await started();
  store().uploadMedia(B, fx.cid, fx.aid, [blob('clip.mp4', 64), blob('notes.pdf')]);
  assert.equal(store().uploadsByConcept[fx.cid].find((r) => r.name === 'notes.pdf').status, 'error');
  await settle();
  const sent = stub.content.requests.find((r) => r.method === 'POST' && r.path.endsWith('/media'));
  assert.equal(sent.query, 'name=clip.mp4');
  assert.ok(sent.body instanceof Blob, 'the body is the file itself, not JSON');
  assert.deepEqual(view().video.media.map((m) => m.name), ['clip.mp4']);
  assert.deepEqual(store().uploadsByConcept[fx.cid].map((r) => r.name), ['notes.pdf']);
  stub.content.answers[`POST concepts/${fx.cid}/media`] = () => ({ status: 400, body: { error: 'Unsupported file type' } });
  store().uploadMedia(B, fx.cid, fx.aid, [blob('fake.png')]);
  await settle();
  assert.equal(store().uploadsByConcept[fx.cid][0].error, 'Unsupported file type');
  store().cancelUpload(fx.cid, store().uploadsByConcept[fx.cid][0].key);
  assert.equal(store().uploadsByConcept[fx.cid].length, 1);
});

test('S04/S05 rename, a 409 comes back as the error; delete removes the item', async () => {
  await started();
  store().uploadMedia(B, fx.cid, fx.aid, [blob('a.png'), blob('b.png')]);
  await settle();
  const [b, a] = view().video.media;
  assert.equal((await store().renameMedia(B, fx.cid, fx.aid, a.id, 'logo.png')).ok, true);
  assert.ok(view().video.media.some((m) => m.name === 'logo.png'));
  const taken = await store().renameMedia(B, fx.cid, fx.aid, b.id, 'LOGO.png');
  assert.deepEqual([taken.ok, taken.status], [false, 409]);
  assert.equal((await store().deleteMedia(B, fx.cid, fx.aid, b.id)).ok, true);
  assert.deepEqual(view().video.media.map((m) => m.name), ['logo.png']);
});

test('S06/S07 tick, untick and link; confirm moves the pane to the live preview; a refused confirm shows its message', async () => {
  await started();
  store().uploadMedia(B, fx.cid, fx.aid, [blob('a.png')]);
  await settle();
  withChecklist([{ id: 'logo', label: 'Logo', detail: null, ticked: false, mediaIds: [] }, { id: 'vo', label: 'Voice-over', detail: null, ticked: false, mediaIds: [] }]);
  const refused = await store().confirmAssets(B, fx.cid, fx.aid);
  assert.deepEqual([refused.ok, refused.status], [false, 409]);
  await store().patchChecklistItem(B, fx.cid, fx.aid, 'logo', { ticked: true, mediaIds: [view().video.media[0].id] });
  await store().patchChecklistItem(B, fx.cid, fx.aid, 'vo', { ticked: true });
  await store().patchChecklistItem(B, fx.cid, fx.aid, 'vo', { ticked: false });
  assert.equal(videoPaneState(view()), 'checklist');
  await store().patchChecklistItem(B, fx.cid, fx.aid, 'vo', { ticked: true });
  assert.equal(videoPaneState(view()), 'ready');
  assert.equal((await store().confirmAssets(B, fx.cid, fx.aid)).ok, true);
  assert.equal(videoPaneState(view()), 'preview');
  assert.equal(view().video.checklist.items[0].mediaIds.length, 1);
});

test('S08 renders list and Stop', async () => {
  await started();
  withChecklist([]);
  const running = addRender(stub.content, B, fx.cid, fx.aid, { status: 'running', fileUrl: null, percent: 10 });
  assert.deepEqual((await contentApi.renders(B, fx.cid)).renders.map((r) => r.status), ['running']);
  assert.equal((await store().stopRender(B, fx.cid, fx.aid, running.id)).ok, true);
  assert.equal(view().video.renders[0].status, 'stopped');
  assert.equal((await store().stopRender(B, fx.cid, fx.aid, running.id)).status, 409);
});

test('S09 discard gives a new round with an empty checklist and the media kept', async () => {
  await started();
  store().uploadMedia(B, fx.cid, fx.aid, [blob('a.png')]);
  await settle();
  withChecklist([{ id: 'a', label: 'A', detail: null, ticked: true, mediaIds: [] }]);
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'session/new-round')).ok, true);
  assert.equal(view().asset.round, 2);
  assert.deepEqual(view().video.checklist.items, []);
  assert.equal(view().video.media.length, 1);
});

test('S10 finalize with a render, then reopen', async () => {
  await started();
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'finalize')).ok, false, 'no render yet');
  const done = addRender(stub.content, B, fx.cid, fx.aid);
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'finalize')).ok, true);
  assert.equal(videoPaneState(view()), 'finalized');
  assert.equal(view().asset.content, done.id);
  assert.equal((await store().studioAction(B, fx.cid, fx.aid, 'reopen')).ok, true);
  assert.equal(view().asset.state, 'drafting');
});

test('S11 an older view arriving late is dropped', async () => {
  await started();
  const current = view();
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...current, rev: current.rev - 1, video: { ...current.video, media: [] } } });
  assert.equal(view(), current);
});

test('S12 writes on a read-only stand-in get 409', async () => {
  await started();
  stub.content.readOnly = true;
  for (const result of [
    await store().confirmAssets(B, fx.cid, fx.aid), await store().patchChecklistItem(B, fx.cid, fx.aid, 'x', { ticked: true }),
    await store().renameMedia(B, fx.cid, fx.aid, 'm1', 'x.png'), await store().deleteMedia(B, fx.cid, fx.aid, 'm1'), await store().startVideo(B, fx.cid, fx.aid),
  ]) assert.deepEqual([result.ok, result.status], [false, 409]);
  stub.content.readOnly = false;
});

test('a refused start keeps the view, whose reason the tab shows', async () => {
  stub.content.studio.agent = false;
  const result = await store().startVideo(B, fx.cid, fx.aid);
  assert.equal(result.ok, false);
  assert.match(view().video.blockedReason, /No default coding agent/);
  assert.equal(videoPaneState(view()), 'blocked');
  stub.content.studio.agent = true;
});

test('in a browser the upload goes through XMLHttpRequest: raw body, progress, errors and Cancel', async () => {
  const sent = [];
  class FakeXhr {
    constructor() { this.upload = {}; this.headers = {}; sent.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) { this.body = body; }
    abort() { this.onabort(); }
  }
  globalThis.XMLHttpRequest = FakeXhr;
  try {
    const progress = [];
    const file = blob('clip one.mp4', 100);
    const ok = contentApi.uploadMedia(B, fx.cid, file, (n) => progress.push(n), new AbortController().signal);
    const x = sent[0];
    assert.equal(x.method, 'POST');
    assert.match(x.url, /\/media\?name=clip\+one\.mp4$/);
    assert.equal(x.headers['content-type'], 'application/octet-stream');
    assert.equal(x.body, file);
    x.upload.onprogress({ loaded: 40 });
    Object.assign(x, { status: 201, responseText: JSON.stringify({ id: 'm1', name: 'clip one.mp4' }) });
    x.onload();
    assert.equal((await ok).id, 'm1');
    assert.deepEqual(progress, [40]);
    const refused = contentApi.uploadMedia(B, fx.cid, file, () => {}, new AbortController().signal);
    Object.assign(sent[1], { status: 413, responseText: '{"error":"A file can be at most 2 GB"}' });
    sent[1].onload();
    await assert.rejects(refused, (e) => e.status === 413 && e.message === 'A file can be at most 2 GB');
    const garbled = contentApi.uploadMedia(B, fx.cid, file, () => {}, new AbortController().signal);
    Object.assign(sent[2], { status: 502, statusText: 'Bad Gateway', responseText: '<html>' });
    sent[2].onload();
    await assert.rejects(garbled, (e) => e.status === 502 && e.message === 'Bad Gateway');
    const offline = contentApi.uploadMedia(B, fx.cid, file, () => {}, new AbortController().signal);
    sent[3].onerror();
    await assert.rejects(offline, /The upload failed/);
    const abort = new AbortController();
    const cancelled = contentApi.uploadMedia(B, fx.cid, file, () => {}, abort.signal);
    abort.abort();
    await assert.rejects(cancelled, (e) => e.name === 'AbortError');
  } finally { delete globalThis.XMLHttpRequest; }
});

test('cancelling an upload in flight aborts it and removes its row', async () => {
  await started();
  let release;
  stub.content.delays[`POST concepts/${fx.cid}/media`] = () => new Promise((r) => { release = r; });
  store().uploadMedia(B, fx.cid, fx.aid, [blob('slow.mp4')]);
  await settle();
  const [row] = store().uploadsByConcept[fx.cid];
  assert.equal(row.status, 'uploading');
  store().cancelUpload(fx.cid, row.key);
  release();
  await settle();
  assert.deepEqual(store().uploadsByConcept[fx.cid], []);
});
