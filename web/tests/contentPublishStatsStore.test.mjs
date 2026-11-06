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
const { installServerStub } = await import('./serverStub.mjs');
const { CONTENT_ROUTES } = await import('./contentStudioStub.mjs');

const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ listByProject: {}, calendarByProject: {}, conceptsById: {}, missingByPost: {}, studioByAsset: {}, studioBlocked: {}, statsByPost: {}, mediaByPost: {} });
});
const store = () => useContentStore.getState();
const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

/** A Concept with one finalized text post, ready to publish. */
async function finalizedPost(platform = 'linkedin', format = 'text') {
  const c = await contentApi.createConcept(B, { title: 'T', brief: '', posts: [{ platform, format, scheduledAt: '2026-11-03T09:00:00Z' }] });
  const b = stub.content.byBuilding.get(B);
  const raw = b.concepts.find((x) => x.id === c.id);
  for (const a of [...raw.posts[0].own, ...raw.assets]) Object.assign(a, { state: 'finalized', content: a.kind === 'post-text' ? 'Hello' : 'x' });
  await store().finalizePost(B, c.id, c.posts[0].id);
  return { cid: c.id, pid: c.posts[0].id };
}
const post = (cid, pid) => store().conceptsById[cid].posts.find((p) => p.id === pid);
const past = (min) => new Date(Date.now() - min * 60_000).toISOString();

test('WI09 the stand-in answers every new route with its own answer, not the generic "not found"', async () => {
  const { cid, pid } = await finalizedPost();
  const fresh = CONTENT_ROUTES.filter(([, route]) => /posts\/:pid\/(publish|unpublish|media|stats)/.test(route));
  assert.equal(fresh.length, 15, 'media/thumbnail (37.004) is the 15th');
  for (const [method, route] of fresh) {
    const path = route.replace(':cid', cid).replace(':pid', pid).replace(':statId', 's-none').replace(':sourceId', 'x').replace(':index', '0').replace(':eid', 'e-none');
    const res = await fetch(`http://localhost:4500/api/projects/${B}/content/${path}`, { method, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}) });
    const body = await res.json().catch(() => ({}));
    assert.notEqual(body.error, 'not found', `${method} ${route}`);
    assert.notEqual(res.status, 500, `${method} ${route}`);
  }
});

test('WI01/WI03 publish, edit details, unpublish and the post state follow', async () => {
  const { cid, pid } = await finalizedPost();
  assert.equal((await store().publishPost(B, cid, pid, { liveUrl: 'https://example.com/p', publishedAt: past(60) })).ok, true);
  assert.deepEqual([post(cid, pid).status, post(cid, pid).liveUrl], ['published', 'https://example.com/p']);
  assert.equal((await store().editPublish(B, cid, pid, { liveUrl: null })).ok, true);
  assert.equal(post(cid, pid).liveUrl, null);
  assert.equal((await store().unpublishPost(B, cid, pid)).ok, true);
  assert.deepEqual([post(cid, pid).status, post(cid, pid).publishedAt], ['finalized', null]);
  assert.equal((await store().loadMedia(B, cid, pid)).ok, true);
  assert.equal(store().mediaByPost[pid].text, 'Hello');
});

test('WI02 a refusal surfaces its message and leaves the post as it was', async () => {
  const { cid, pid } = await finalizedPost();
  const bad = await store().publishPost(B, cid, pid, { liveUrl: 'ftp://x' });
  assert.deepEqual([bad.ok, bad.status], [false, 400]);
  assert.equal(post(cid, pid).status, 'finalized');
  await store().publishPost(B, cid, pid, {});
  const again = await store().publishPost(B, cid, pid, {});
  assert.deepEqual([again.ok, again.status], [false, 409]);
});

test('WI04/WI05 stats: create, sorted list with the latest delta, edit and delete', async () => {
  const { cid, pid } = await finalizedPost();
  await store().publishPost(B, cid, pid, { publishedAt: past(600) });
  const mk = (min, counts, extra = {}) => store().createStat(B, cid, pid, { capturedAt: past(min), counts, ...extra });
  const first = await mk(300, { impressions: 100, likes: 5 });
  await mk(60, { impressions: 160 });
  assert.equal(first.ok, true);
  const list = store().statsByPost[pid];
  assert.deepEqual(list.map((s) => s.counts.impressions), [160, 100], 'newest captured first');
  const summary = post(cid, pid).stats;
  assert.deepEqual([summary.count, summary.latest.counts.impressions, summary.delta.impressions, summary.delta.likes], [2, 160, 60, null]);
  assert.equal((await store().patchStat(B, cid, pid, list[0].id, { counts: { impressions: 170 } })).ok, true);
  assert.equal(post(cid, pid).stats.latest.counts.impressions, 170);
  assert.equal((await store().deleteStat(B, cid, pid, list[0].id)).ok, true);
  assert.equal(store().statsByPost[pid].length, 1);
  assert.equal(post(cid, pid).stats.delta, null, 'one snapshot left, no change shown');
  const none = await mk(30, {});
  assert.deepEqual([none.ok, none.status], [false, 400]);
  assert.equal((await store().loadStats(B, cid, pid)).ok, true);
});

test('WI06 extraction sends one multipart request with raw image bytes and the text, and returns the pre-fill', async () => {
  const { cid, pid } = await finalizedPost();
  await store().publishPost(B, cid, pid, {});
  stub.content.answers.extraction = { counts: { impressions: 1200 }, capturedAt: '2026-10-25T08:00:00Z', unused: ['Hearts'] };
  const res = await store().extractStats(B, cid, pid, 'Impressions 1.2K', [png(), png()]);
  assert.equal(res.ok, true);
  assert.deepEqual([res.reply.ok, res.reply.counts, res.reply.capturedAt, res.reply.unused], [true, { impressions: 1200 }, '2026-10-25T08:00:00Z', ['Hearts']]);
  assert.deepEqual(stub.content.extractions.at(-1), { text: 'Impressions 1.2K', images: 2 });
  assert.equal(stub.content.requests.at(-1).body instanceof FormData, true, 'multipart, not base64 JSON');
  assert.equal((await store().loadStats(B, cid, pid)).ok, true);
  assert.equal(store().statsByPost[pid].length, 0, 'nothing saved by extracting');
});

test('WI07 a failed or refused extraction is returned as data and leaves the store untouched', async () => {
  const { cid, pid } = await finalizedPost();
  await store().publishPost(B, cid, pid, {});
  stub.content.answers.extraction = { ok: false, reason: 'the agent took longer than 120 seconds' };
  const failed = await store().extractStats(B, cid, pid, 'x', []);
  assert.deepEqual([failed.ok, failed.reply.ok, failed.reply.reason], [true, false, 'the agent took longer than 120 seconds']);
  await store().unpublishPost(B, cid, pid);
  const refused = await store().extractStats(B, cid, pid, 'x', []);
  assert.deepEqual([refused.ok, refused.status], [false, 409]);
});

test('WI08 discarding an unused extraction is one request and an unknown one is a 404', async () => {
  const { cid, pid } = await finalizedPost();
  await store().publishPost(B, cid, pid, { publishedAt: past(600) });
  const res = await store().extractStats(B, cid, pid, 'x', []);
  assert.equal((await store().discardExtraction(B, cid, pid, res.reply.extractionId)).ok, true);
  assert.deepEqual(stub.content.discarded, [res.reply.extractionId]);
  assert.equal((await store().discardExtraction(B, cid, pid, res.reply.extractionId)).status, 404);
  const saved = await store().extractStats(B, cid, pid, 'x', []);
  assert.equal((await store().createStat(B, cid, pid, { capturedAt: past(1), counts: { views: 1 }, extractionId: saved.reply.extractionId })).ok, true);
  assert.equal((await store().discardExtraction(B, cid, pid, saved.reply.extractionId)).status, 404, 'a saved extraction is gone');
});

test('WI10 a read-only Building refuses every new write and still reads', async () => {
  const { cid, pid } = await finalizedPost();
  await store().publishPost(B, cid, pid, { publishedAt: past(600) });
  const made = await store().createStat(B, cid, pid, { capturedAt: past(1), counts: { views: 1 } });
  stub.content.readOnly = true;
  const writes = [store().publishPost(B, cid, pid, {}), store().editPublish(B, cid, pid, {}), store().unpublishPost(B, cid, pid), store().createStat(B, cid, pid, { capturedAt: past(1), counts: { views: 1 } }),
    store().patchStat(B, cid, pid, made.stat.id, {}), store().deleteStat(B, cid, pid, made.stat.id), store().extractStats(B, cid, pid, 'x', []), store().discardExtraction(B, cid, pid, 'e1')];
  for (const r of await Promise.all(writes)) assert.deepEqual([r.ok, r.status], [false, 409]);
  assert.equal((await store().loadStats(B, cid, pid)).ok, true);
  assert.equal((await store().loadMedia(B, cid, pid)).ok, true);
});

test('WI11 "Most views" is requested through the list and ranks by the latest views', async () => {
  const a = await finalizedPost('blog', 'article');
  const b = await finalizedPost('blog', 'article');
  await store().publishPost(B, b.cid, b.pid, { publishedAt: past(600) });
  await store().createStat(B, b.cid, b.pid, { capturedAt: past(5), counts: { views: 9 } });
  await store().loadList(B, { status: '', platform: '', archived: false, search: '', sort: 'views' });
  assert.match(stub.content.requests.at(-1).query, /sort=views/);
  assert.deepEqual(store().listByProject[B].page.rows.map((r) => r.id), [b.cid, a.cid]);
});

test('WI12 a stats update for one post keeps the other posts as the same objects', async () => {
  const c = await contentApi.createConcept(B, { title: 'T', brief: '', posts: [{ platform: 'blog', format: 'article', scheduledAt: '2026-11-03T09:00:00Z' }, { platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] });
  const raw = stub.content.byBuilding.get(B).concepts.find((x) => x.id === c.id);
  for (const p of raw.posts) { for (const a of p.own) Object.assign(a, { state: 'finalized', content: 'x' }); await store().finalizePost(B, c.id, p.id); await store().publishPost(B, c.id, p.id, { publishedAt: past(600) }); }
  await store().loadStats(B, c.id, raw.posts[0].id);
  await store().loadStats(B, c.id, raw.posts[1].id);
  const before = store().statsByPost[raw.posts[1].id];
  await store().createStat(B, c.id, raw.posts[0].id, { capturedAt: past(5), counts: { views: 3 } });
  assert.equal(store().statsByPost[raw.posts[1].id], before, 'the other post list is the same array');
});
