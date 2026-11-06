import assert from 'node:assert/strict';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { AgentRun } from '../src/content/statsAgent.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';

let t: ContentApi;
let calls: AgentRun[] = [];
let agentImpl: (run: AgentRun) => Promise<string> = async () => JSON.stringify({ counts: { impressions: 1200, likes: 30 }, capturedAt: null, unused: [] });
let agentChoice: Awaited<ReturnType<import('../src/content/extractions.ts').ExtractionDeps['resolveAgent']>> = { kind: 'claude-cli', bin: 'fake-claude', env: {} };
let timeoutMs = 120000;

before(async () => {
  t = await startContentApi(() => ({
    extraction: { agent: (run) => { calls.push(run); return agentImpl(run); }, resolveAgent: async () => agentChoice, get timeoutMs() { return timeoutMs; } },
  }));
});
after(async () => { await t.stop(); });
beforeEach(() => { calls = []; agentChoice = { kind: 'claude-cli', bin: 'fake-claude', env: {} }; timeoutMs = 120000; agentImpl = async () => JSON.stringify({ counts: { impressions: 1200, likes: 30 }, capturedAt: null, unused: ['Hearts'] }); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const exists = (p: string) => access(p).then(() => true, () => false);
const iso = (offsetMs: number) => new Date(t.clock.now + offsetMs).toISOString();
const HOUR = 3_600_000;

interface Fx { b: string; cid: string; pid: string; base: string; post: (suffix?: string) => string; ctx: any; textAsset: string }
async function fixture(platform = 'linkedin', format = 'text'): Promise<Fx> {
  const b = await t.createStudio('Acme');
  const c = (await t.send('POST', t.c(b, '/concepts'), { title: 'C', posts: [{ platform, format, scheduledAt: '2026-11-03T09:00:00Z' }] })).body;
  const { contentCtx } = await import('../src/content/runtime.ts');
  const ctx = contentCtx((await t.projectsDb.get(b))!);
  const p = c.posts[0];
  return { b, cid: c.id, pid: p.id, base: t.c(b, `/concepts/${c.id}/posts/${p.id}`), post: (s = '') => t.c(b, `/concepts/${c.id}/posts/${p.id}${s}`), ctx, textAsset: p.needs[0].id };
}
async function finalized(platform?: string, format?: string): Promise<Fx> {
  const f = await fixture(platform, format);
  const { setAssetState } = await import('../src/content/concepts.ts');
  for (const a of (await t.api(t.c(f.b, `/concepts/${f.cid}`))).body.posts[0].needs) setAssetState(f.ctx, a.id, 'finalized', a.kind === 'post-text' ? 'Hello world' : null);
  assert.equal((await t.send('POST', f.post('/finalize'))).status, 200);
  return f;
}
async function published(platform?: string, format?: string): Promise<Fx> {
  const f = await finalized(platform, format);
  const res = await t.send('POST', f.post('/publish'), { liveUrl: 'https://example.com/p', publishedAt: iso(-10 * HOUR) });
  assert.equal(res.status, 200, res.text);
  return f;
}
const stat = (counts: object, capturedAt = iso(-HOUR), extra: object = {}) => ({ capturedAt, counts, ...extra });

test('I01/I02/I03/I05 publish a finalized post; defaults; draft and published refused; validation names its field', async () => {
  const draft = await fixture();
  assert.equal((await t.send('POST', draft.post('/publish'), {})).status, 409);
  const f = await finalized();
  for (const [body, field] of [[{ liveUrl: 'ftp://x' }, 'liveUrl'], [{ liveUrl: `https://e.com/${'a'.repeat(2000)}` }, 'liveUrl'], [{ publishedAt: iso(6 * 60_000) }, 'publishedAt'], [{ publishedAt: 'soon' }, 'publishedAt']] as const) {
    const bad = await t.send('POST', f.post('/publish'), body);
    assert.deepEqual([bad.status, bad.body.field], [400, field], JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await t.send('POST', f.post('/publish'), [] as never)).status, 400);
  assert.equal((await t.send('GET', f.base)).status, 404, 'no such GET');
  const res = await t.send('POST', f.post('/publish'), {});
  assert.deepEqual([res.status, res.body.status, res.body.liveUrl, typeof res.body.publishedAt], [200, 'published', null, 'string']);
  assert.equal((await t.send('POST', f.post('/publish'), {})).status, 409, 'already published');
  assert.equal((await t.send('POST', f.post('/finalize'))).status, 409);
  assert.equal((await t.send('POST', f.post('/unfinalize'))).status, 409);
  assert.equal((await t.send('DELETE', f.post())).status, 409, 'a published post cannot be deleted');
});

test('I06/I07/I08/I09 edit details, unpublish keeps stats, delete after unpublish removes stats', async () => {
  const f = await published();
  const edited = await t.send('PATCH', f.post('/publish'), { liveUrl: null, publishedAt: iso(-12 * HOUR) });
  assert.deepEqual([edited.status, edited.body.liveUrl], [200, null]);
  assert.equal((await t.send('PATCH', f.post('/publish'), {})).status, 200, 'empty patch');
  assert.equal((await t.send('PATCH', f.post('/publish'), { liveUrl: 'nope' })).body.field, 'liveUrl');
  assert.equal((await t.send('POST', f.post('/stats'), stat({ views: 5 }, iso(-5 * HOUR)))).status, 201);
  const late = await t.send('PATCH', f.post('/publish'), { publishedAt: iso(-HOUR) });
  assert.deepEqual([late.status, late.body.field], [400, 'publishedAt']);
  const un = await t.send('POST', f.post('/unpublish'));
  assert.deepEqual([un.status, un.body.status, un.body.liveUrl, un.body.publishedAt], [200, 'finalized', null, null]);
  assert.equal((await t.send('POST', f.post('/unpublish'))).status, 409);
  assert.equal((await t.send('PATCH', f.post('/publish'), {})).status, 409);
  assert.equal((await t.api(f.post('/stats'))).body.snapshots.length, 1, 'stats kept');
  const again = await t.send('POST', f.post('/publish'), {});
  assert.equal(again.body.stats.count, 1, 'a republish shows the old stats');
  await t.send('POST', f.post('/unpublish'));
  assert.equal((await t.send('POST', f.post('/unfinalize'))).status, 200);
  assert.equal((await t.send('DELETE', f.post())).status, 204);
  const { postRow } = await import('../src/content/concepts.ts');
  assert.equal(f.ctx.db.prepare('SELECT COUNT(*) AS n FROM post_stats').get().n >= 0, true);
  assert.throws(() => postRow(f.ctx, f.cid, f.pid));
  assert.equal(f.ctx.db.prepare('SELECT COUNT(*) AS n FROM post_stats WHERE postId = ?').get(f.pid).n, 0);
});

test('I04/I35 every new route 404s for unknown ids and 409s on a read-only Building', async () => {
  const f = await published();
  const ghost = '00000000-0000-4000-8000-000000000000';
  const routes: Array<[string, string, unknown?]> = [['POST', '/publish'], ['PATCH', '/publish'], ['POST', '/unpublish'], ['GET', '/stats'], ['POST', '/stats', stat({ views: 1 })], ['PATCH', `/stats/${ghost}`, {}], ['DELETE', `/stats/${ghost}`], ['POST', '/stats/extractions'], ['DELETE', `/stats/extractions/${ghost}`], ['GET', `/stats/${ghost}/sources/${ghost}`], ['GET', '/media'], ['GET', '/media/images.zip'], ['GET', '/media/images/0'], ['GET', '/media/video']];
  for (const [method, suffix, body] of routes) {
    const bad = await t.send(method, t.c(f.b, `/concepts/${f.cid}/posts/${ghost}${suffix}`), body);
    assert.equal(bad.status, 404, `${method} ${suffix} unknown post`);
    const malformed = await t.send(method, t.c(f.b, `/concepts/${f.cid}/posts/nope${suffix}`), body);
    assert.equal(malformed.status, 404, `${method} ${suffix} malformed`);
  }
  for (const s of ['/stats/nope', `/stats/${ghost}`]) assert.equal((await t.send('PATCH', f.post(s), {})).status, 404);
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  assert.equal((await t.send('POST', t.c(seo.body.id, `/concepts/${f.cid}/posts/${f.pid}/publish`), {})).status, 404);

  const made = await t.send('POST', f.post('/stats'), stat({ views: 3 }));
  await t.projectsDb.update(f.b, { readOnlyReason: 'Frozen for the test' });
  {
    for (const [method, suffix, body] of [['POST', '/publish', {}], ['PATCH', '/publish', {}], ['POST', '/unpublish', {}], ['POST', '/stats', stat({ views: 1 })], ['PATCH', `/stats/${made.body.id}`, {}], ['DELETE', `/stats/${made.body.id}`], ['POST', '/stats/extractions'], ['DELETE', `/stats/extractions/${ghost}`]] as Array<[string, string, unknown?]>) {
      assert.equal((await t.send(method, f.post(suffix), body)).status, 409, `${method} ${suffix}`);
    }
    for (const suffix of ['/stats', '/media']) assert.equal((await t.api(f.post(suffix))).status, 200, suffix);
    assert.equal(calls.length, 0, 'the agent is not called on a read-only Building');
  }
});

test('I16/I17/I18/I19/I20/I21 snapshots: create, validate, order, edit, delete; unknown stays null', async () => {
  const draft = await finalized();
  assert.equal((await t.send('POST', draft.post('/stats'), stat({ views: 1 }))).status, 409, 'finalized post');
  const f = await published('instagram', 'reel');
  const bad: Array<[object, string]> = [
    [{ ...stat({ views: 1 }), capturedAt: iso(6 * 60_000) }, 'capturedAt'], [stat({ views: 1 }, iso(-11 * HOUR)), 'capturedAt'], [{ counts: { views: 1 } }, 'capturedAt'],
    [stat({}), 'counts'], [stat({ views: 1.5 }), 'counts.views'], [stat({ views: -1 }), 'counts.views'], [stat({ views: '5' }), 'counts.views'], [stat({ views: 1e12 + 1 }), 'counts.views'],
    [stat({ nope: 1 }), 'counts.nope'], [stat({ views: 1 }, iso(-HOUR), { watchTime: 1.25 }), 'watchTime'], [stat({ views: 1 }, iso(-HOUR), { note: 'x'.repeat(1001) }), 'note'],
  ];
  for (const [body, field] of bad) assert.equal((await t.send('POST', f.post('/stats'), body)).body.field, field, JSON.stringify(body).slice(0, 60));
  assert.equal((await t.api(f.post('/stats'))).body.snapshots.length, 0, 'nothing written');
  const a = await t.send('POST', f.post('/stats'), stat({ views: 100, likes: 0, saves: null }, iso(-3 * HOUR), { watchTime: 4.5, note: ' first ' }));
  assert.equal(a.status, 201);
  assert.deepEqual([a.body.counts.likes, a.body.counts.saves, a.body.watchTime, a.body.note], [0, null, 4.5, 'first']);
  const b = await t.send('POST', f.post('/stats'), stat({ views: 150, likes: 4 }, iso(-HOUR)));
  const c = await t.send('POST', f.post('/stats'), stat({ views: 120 }, iso(-3 * HOUR)));
  const list = (await t.api(f.post('/stats'))).body.snapshots;
  assert.deepEqual(list.map((s: { id: string }) => s.id), [b.body.id, c.body.id, a.body.id], 'newest captured first, ties by entry time');
  const post = (await t.api(t.c(f.b, `/concepts/${f.cid}`))).body.posts[0];
  assert.deepEqual([post.stats.count, post.stats.latest.counts.views, post.stats.delta.views, post.stats.delta.likes, post.stats.delta.saves], [3, 150, 30, null, null]);
  const getBefore = JSON.stringify((await t.api(f.post('/stats'))).body);
  assert.equal(JSON.stringify((await t.api(f.post('/stats'))).body), getBefore, 'GET is a pure read');
  const edit = await t.send('PATCH', f.post(`/stats/${a.body.id}`), { counts: { views: 101, likes: null }, note: 'x', watchTime: null });
  assert.deepEqual([edit.status, edit.body.counts.views, edit.body.counts.likes, edit.body.watchTime], [200, 101, null, null]);
  assert.equal((await t.send('PATCH', f.post(`/stats/${a.body.id}`), { counts: { views: null } })).body.field, 'counts', 'cannot clear the last count');
  assert.equal((await t.send('PATCH', f.post(`/stats/${a.body.id}`), { capturedAt: iso(-20 * HOUR) })).body.field, 'capturedAt');
  const other = await published();
  assert.equal((await t.send('PATCH', other.post(`/stats/${a.body.id}`), {})).status, 404, 'another post\'s snapshot');
  const imagePost = await published('linkedin', 'image');
  assert.equal((await t.send('POST', imagePost.post('/stats'), stat({ views: 1 }, iso(-HOUR), { watchTime: 2 }))).body.field, 'watchTime');
  assert.equal((await t.send('DELETE', f.post(`/stats/${b.body.id}`))).status, 204);
  assert.equal((await t.send('DELETE', f.post(`/stats/${b.body.id}`))).status, 404);
  const after = (await t.api(t.c(f.b, `/concepts/${f.cid}`))).body.posts[0];
  assert.equal(after.stats.latest.id, c.body.id, 'latest recomputed');
});

test('I13/I14/I15 DTOs, calendar placement, and the Most views sort', async () => {
  const f = await published();
  const month = new Date(t.clock.now - 10 * HOUR).toISOString().slice(0, 7);
  const cal = (await t.api(t.c(f.b, `/calendar?month=${month}`))).body.posts;
  assert.equal(cal.length, 1, 'published day, not the scheduled day (November)');
  const sched = (await t.api(t.c(f.b, '/calendar?month=2026-11'))).body.posts;
  assert.equal(sched.length, 0);
  await t.send('POST', f.post('/unpublish'));
  assert.equal((await t.api(t.c(f.b, '/calendar?month=2026-11'))).body.posts.length, 1, 'scheduled day after unpublish');

  const b = await t.createStudio('Rank');
  const mk = async (title: string, views: number | null, field = 'views') => {
    const c = (await t.send('POST', t.c(b, '/concepts'), { title, posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] })).body;
    const post = c.posts[0];
    const { setAssetState } = await import('../src/content/concepts.ts');
    const { contentCtx } = await import('../src/content/runtime.ts');
    setAssetState(contentCtx((await t.projectsDb.get(b))!), post.needs[0].id, 'finalized', 'x');
    await t.send('POST', t.c(b, `/concepts/${c.id}/posts/${post.id}/finalize`));
    if (views !== null) {
      await t.send('POST', t.c(b, `/concepts/${c.id}/posts/${post.id}/publish`), { publishedAt: iso(-10 * HOUR) });
      await t.send('POST', t.c(b, `/concepts/${c.id}/posts/${post.id}/stats`), stat({ [field]: views }));
    }
  };
  await mk('none', null); await mk('low', 5); await mk('high', 500, 'impressions'); await mk('zero', 0);
  const sorted = await t.api(t.c(b, '/concepts?sort=views&limit=3'));
  assert.deepEqual(sorted.body.rows.map((r: { title: string }) => r.title), ['high', 'low', 'zero']);
  assert.deepEqual([sorted.body.total, sorted.body.hasMore], [4, true]);
  assert.deepEqual((await t.api(t.c(b, '/concepts?sort=views&limit=3&offset=3'))).body.rows.map((r: { title: string }) => r.title), ['none']);
  assert.equal((await t.api(t.c(b, '/concepts?sort=oldest'))).body.field, 'sort');
  assert.equal((await t.api(t.c(b, '/concepts?sort=newest'))).status, 200);
});

test('I10/I11 the reopen block: assets a published post uses are blocked until it is unpublished', async () => {
  const { usedByPublishedPost } = await import('../src/content/concepts.ts');
  const f = await published();
  const rows = f.ctx.db.prepare('SELECT * FROM assets WHERE conceptId = ?').all(f.cid) as Array<{ kind: string; postId: string | null }>;
  const byKind = (k: string) => rows.find((r) => r.kind === k)!;
  assert.equal(usedByPublishedPost(f.ctx, byKind('post-text') as never), true);
  assert.equal(usedByPublishedPost(f.ctx, byKind('script') as never), false, 'the script is never used by a post');
  assert.equal(usedByPublishedPost(f.ctx, byKind('video') as never), false, 'no video post');
  await t.send('POST', f.post('/unpublish'));
  assert.equal(usedByPublishedPost(f.ctx, byKind('post-text') as never), false, 'unpublish lifts the block');
  const v = await published('linkedin', 'video');
  const video = (v.ctx.db.prepare('SELECT * FROM assets WHERE conceptId = ? AND kind = ?').get(v.cid, 'video')) as never;
  assert.equal(usedByPublishedPost(v.ctx, video), true, 'a published video post blocks the Concept video');
});

test('I33/I34 media: finalized text, per-image download, zip, video, and missing files', async () => {
  const { setAssetState } = await import('../src/content/concepts.ts');
  const f = await fixture('linkedin', 'carousel');
  const dir = path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'media');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'a.png'), PNG);
  await writeFile(path.join(dir, 'b.png'), Buffer.concat([PNG, Buffer.from('b')]));
  const assets = f.ctx.db.prepare('SELECT * FROM assets WHERE conceptId = ? AND postId = ?').all(f.cid, f.pid) as Array<{ id: string; kind: string }>;
  setAssetState(f.ctx, assets.find((a) => a.kind === 'post-text')!.id, 'finalized', 'Final text');
  setAssetState(f.ctx, assets.find((a) => a.kind === 'image-set')!.id, 'finalized', JSON.stringify(['media/a.png', 'media/gone.png', '../../escape.png', 'media/b.png']));
  const media = (await t.api(f.post('/media'))).body;
  assert.equal(media.text, 'Final text');
  assert.deepEqual(media.images.map((i: { name: string; missing: boolean }) => [i.name, i.missing]), [['a.png', false], ['gone.png', true], ['escape.png', true], ['b.png', false]]);
  assert.equal(media.video, null);
  const one = await t.api(f.post('/media/images/0'));
  assert.deepEqual([one.status, one.headers.get('content-type'), one.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
  assert.match(one.headers.get('content-disposition')!, /^attachment; filename\*=UTF-8''a\.png$/);
  for (const i of ['1', '2', '9', 'x', '-1']) assert.equal((await t.api(f.post(`/media/images/${i}`))).status, 404, i);
  const zip = await fetch(`${t.baseUrl}${f.post('/media/images.zip')}`);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.deepEqual([zip.status, zip.headers.get('content-type')], [200, 'application/zip']);
  assert.ok(bytes.includes(Buffer.from('a.png')) && bytes.includes(Buffer.from('b.png')) && !bytes.includes(Buffer.from('gone.png')));
  assert.equal((await t.api(f.post('/media/video'))).status, 404);
  assert.ok(!t.dataDir || !JSON.stringify(media).includes(t.dataDir), 'no folder paths in the response');
  const v = await finalized('linkedin', 'video');
  const videoAsset = v.ctx.db.prepare("SELECT id FROM assets WHERE conceptId = ? AND kind = 'video'").get(v.cid).id;
  await mkdir(path.join(t.dataDir, 'buildings', v.b, 'concepts', v.cid), { recursive: true });
  await writeFile(path.join(t.dataDir, 'buildings', v.b, 'concepts', v.cid, 'cut.mp4'), 'video');
  setAssetState(v.ctx, videoAsset, 'finalized', 'cut.mp4');
  const video = await t.api(v.post('/media/video'));
  assert.deepEqual([video.status, video.headers.get('content-type'), video.text], [200, 'video/mp4', 'video']);
  assert.deepEqual((await t.api(v.post('/media'))).body.video, { name: 'cut.mp4', missing: false });
  setAssetState(v.ctx, videoAsset, 'finalized', 'cut-gone.mp4');
  assert.equal((await t.api(v.post('/media'))).body.video.missing, true);
  assert.equal((await t.api(v.post('/media/video'))).status, 404);
  assert.equal((await t.api(v.post('/media/images.zip'))).status, 404, 'no image set');
  const none = await t.api(f.post('/media'));
  assert.equal(none.status, 200);
});

async function extract(f: Fx, parts: Array<[string, string | Buffer]>) {
  const form = new FormData();
  for (const [k, v] of parts) { if (typeof v === 'string') form.append(k, v); else form.append(k, new Blob([new Uint8Array(v)], { type: 'image/png' }), 'shot.png'); }
  const res = await fetch(`${t.baseUrl}${f.post('/stats/extractions')}`, { method: 'POST', body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
const extractionFolders = async (f: Fx) => (await exists(path.join(t.dataDir, 'buildings', f.b, 'extractions'))) ? readdir(path.join(t.dataDir, 'buildings', f.b, 'extractions')) : [];

test('I23/I25 extraction: pre-fills, saves nothing, and the agent gets only the text and the image files', async () => {
  const f = await published('linkedin', 'text');
  const res = await extract(f, [['text', 'Reactions 30\nImpressions 1.2K'], ['images', PNG]]);
  assert.deepEqual([res.status, res.body.ok, res.body.counts, res.body.capturedAt, res.body.unused], [200, true, { impressions: 1200, likes: 30 }, null, ['Hearts']]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.prompt, /Impressions 1\.2K/);
  assert.equal(calls[0]!.images.length, 1);
  assert.equal(calls[0]!.kind, 'claude-cli');
  assert.ok(calls[0]!.cwd.includes(path.join('extractions', res.body.extractionId)) && !calls[0]!.prompt.includes(t.dataDir));
  assert.equal((await t.api(f.post('/stats'))).body.snapshots.length, 0, 'nothing saved');
  assert.equal(JSON.stringify(res.body).includes(t.dataDir), false);
});

test('I24 every agent failure answers ok:false with a reason, leaves no files and calls the agent once', async () => {
  const f = await published();
  const cases: Array<[string, (r: AgentRun) => Promise<string>, RegExp]> = [
    ['fenced', async () => '```json\n{"counts":{},"capturedAt":null,"unused":[]}\n```', /plain JSON/],
    ['extra keys', async () => JSON.stringify({ counts: { impressions: 1 }, capturedAt: null, unused: [], x: 1 }), /exactly/],
    ['unknown field', async () => JSON.stringify({ counts: { nope: 1 }, capturedAt: null, unused: [] }), /nope/],
    ['string number', async () => JSON.stringify({ counts: { impressions: '1.2K' }, capturedAt: null, unused: [] }), /whole number/],
    ['exit', async () => { throw new Error('the agent exited with code 1'); }, /code 1/],
    ['not installed', async () => { throw new Error('the agent is not installed'); }, /not installed/],
  ];
  for (const [name, impl, reason] of cases) {
    calls = []; agentImpl = impl;
    const res = await extract(f, [['text', 'x']]);
    assert.deepEqual([res.status, res.body.ok], [200, false], name);
    assert.match(res.body.reason, reason, name);
    assert.equal(calls.length, 1, `${name}: no retry`);
  }
  assert.deepEqual(await extractionFolders(f), []);
  timeoutMs = 20; agentImpl = () => new Promise(() => undefined);
  const slow = await extract(f, [['text', 'x']]);
  assert.match(slow.body.reason, /longer than/);
  assert.equal(calls[calls.length - 1]!.signal.aborted, true);
  agentChoice = 'No default coding agent is set';
  assert.match((await extract(f, [['text', 'x']])).body.reason, /No default coding agent/);
  assert.deepEqual(await extractionFolders(f), []);
});

test('I26/I27 input limits are 400 with a field, a body past the window is 413, and a wrong status is 409 without calling the agent', async () => {
  const f = await published();
  assert.equal((await extract(f, [])).body.field, 'text');
  assert.equal((await extract(f, Array.from({ length: 11 }, () => ['images', PNG] as [string, Buffer]))).body.field, 'images');
  assert.equal((await extract(f, [['images', Buffer.from('<svg/>')]])).body.field, 'images');
  assert.equal((await extract(f, [['text', 'x'.repeat(20001)]])).body.field, 'text');
  assert.equal((await t.send('POST', f.post('/stats/extractions'), { text: 'json is not multipart' })).status, 400);
  const huge = await fetch(`${t.baseUrl}${f.post('/stats/extractions')}`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: Buffer.alloc(102 * 1048576 + 1) });
  assert.equal(huge.status, 413);
  assert.equal(calls.length, 0);
  const fin = await finalized();
  assert.equal((await extract(fin, [['text', 'x']])).status, 409);
  assert.equal(calls.length, 0);
});

test('I28/I29/I30/I31 sources are kept on save, served safely, removed with the snapshot, and bad extraction ids are refused', async () => {
  const f = await published();
  const res = await extract(f, [['text', 'Impressions 5'], ['images', PNG]]);
  const id = res.body.extractionId;
  const ghost = '00000000-0000-4000-8000-000000000000';
  for (const [bad, status] of [[ghost, 404], ['nope', 400], [5, 400]] as Array<[unknown, number]>) assert.equal((await t.send('POST', f.post('/stats'), { ...stat({ views: 1 }), extractionId: bad })).status, status, String(bad));
  const other = await published();
  assert.equal((await t.send('POST', other.post('/stats'), { ...stat({ views: 1 }), extractionId: id })).status, 404, 'another post\'s extraction');
  assert.equal((await t.send('POST', f.post('/stats'), { ...stat({}), extractionId: id })).status, 400, 'invalid save keeps the extraction');
  assert.equal((await extractionFolders(f)).length, 1);
  const saved = await t.send('POST', f.post('/stats'), { ...stat({ views: 5 }), extractionId: id });
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.sources.map((s: { kind: string; name: string }) => [s.kind, s.name]), [['text', 'pasted-text.txt'], ['image', 'screenshot-1.png']]);
  assert.deepEqual(await extractionFolders(f), []);
  assert.equal((await t.send('POST', f.post('/stats'), { ...stat({ views: 5 }), extractionId: id })).status, 404, 'used once');
  assert.equal((await t.send('DELETE', f.post(`/stats/extractions/${id}`))).status, 404, 'a used extraction is gone');
  const [text, image] = saved.body.sources;
  const img = await t.api(f.post(`/stats/${saved.body.id}/sources/${image.id}`));
  assert.deepEqual([img.status, img.headers.get('content-type'), img.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
  assert.equal((await t.api(f.post(`/stats/${saved.body.id}/sources/${text.id}`))).text, 'Impressions 5');
  assert.equal((await t.api(f.post(`/stats/${saved.body.id}/sources/${ghost}`))).status, 404);
  assert.equal(JSON.stringify(saved.body).includes(t.dataDir), false);
  const folder = path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'posts', f.pid, 'stats', saved.body.id);
  assert.equal((await readdir(folder)).length, 2);
  await t.send('POST', f.post('/unpublish'));
  assert.equal((await readdir(folder)).length, 2, 'unpublish keeps sources');
  await t.send('POST', f.post('/publish'), {});
  assert.equal((await t.send('DELETE', f.post(`/stats/${saved.body.id}`))).status, 204);
  assert.equal(await exists(folder), false, 'delete removes sources');
  const second = await extract(f, [['text', 'Impressions 5']]);
  assert.equal((await t.send('DELETE', f.post(`/stats/extractions/${second.body.extractionId}`))).status, 204);
  assert.deepEqual(await extractionFolders(f), []);
  assert.equal((await t.send('DELETE', other.post(`/stats/extractions/${second.body.extractionId}`))).status, 404);
});

test('I32 unused extractions are swept after 24 hours and kept before', async () => {
  const f = await published();
  const a = await extract(f, [['text', 'one']]);
  assert.equal((await extractionFolders(f)).length, 1);
  t.clock.now += 24 * HOUR - 60_000;
  await extract(f, [['text', 'two']]);
  assert.equal((await extractionFolders(f)).length, 2, 'under 24 hours, kept');
  t.clock.now += 2 * 60_000;
  await extract(f, [['text', 'three']]);
  const left: string[] = await extractionFolders(f);
  assert.equal(left.length, 2);
  assert.ok(!left.includes(a.body.extractionId), 'the old one is swept');
});

test('I39/I38 a post unpublished while the agent runs discards the result and leaves no files', async () => {
  const f = await published();
  let release!: () => void;
  agentImpl = () => new Promise((resolve) => { release = () => resolve('{"counts":{"likes":1},"capturedAt":null,"unused":[]}'); });
  const pending = extract(f, [['text', 'x']]);
  while (!calls.length) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await t.send('POST', f.post('/unpublish'))).status, 200);
  release();
  assert.equal((await pending).status, 409);
  assert.deepEqual(await extractionFolders(f), []);
  const g = await published();
  assert.equal((await Promise.all([t.send('POST', g.post('/unpublish')), t.send('POST', g.post('/unpublish'))])).filter((r) => r.status === 200).length, 1, 'one unpublish wins');
});

test('I40 every new route is in the product doc and in the web stand-in', async () => {
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile(path.join(import.meta.dirname, '..', '..', 'docs', 'content-studio-building.md'), 'utf8');
  const stub = await readFile(path.join(import.meta.dirname, '..', '..', 'web', 'tests', 'contentStudioStub.mjs'), 'utf8');
  for (const route of ['posts/:pid/publish', 'posts/:pid/unpublish', 'posts/:pid/media', 'media/images/:index', 'media/images.zip', 'media/video', 'posts/:pid/stats', 'stats/:statId', 'stats/:statId/sources/:sourceId', 'stats/extractions', 'stats/extractions/:eid']) {
    assert.ok(stub.includes(route), `stub: ${route}`);
  }
  for (const part of ['/publish', '/unpublish', '/media', 'images.zip', '/media/video', '/stats', 'stats/:statId', 'sources/:sourceId', 'stats/extractions', 'extractions/:eid']) assert.ok(doc.includes(part), `doc: ${part}`);
});

test('the real runner collects the output of a headless CLI, reports failures as reasons and stops on abort', async () => {
  const { chmod, mkdtemp, writeFile: write } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { spawnStatsAgent } = await import('../src/content/statsAgent.ts');
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-agent-'));
  const script = async (name: string, body: string) => { const file = path.join(dir, name); await write(file, `#!/bin/sh\n${body}\n`); await chmod(file, 0o755); return file; };
  const run = (bin: string, signal = new AbortController().signal) => spawnStatsAgent({ kind: 'claude-cli', bin, env: { FAKE: 'yes' }, cwd: dir, prompt: 'P', images: [], signal });
  assert.match((await run(await script('ok.sh', 'echo "{\\"ok\\":$#}"; test "$FAKE" = yes'))).trim(), /^\{"ok":\d+\}$/);
  await assert.rejects(run(await script('bad.sh', 'exit 3')), /code 3/);
  await assert.rejects(run(path.join(dir, 'missing')), /not installed/);
  const controller = new AbortController();
  const slow = run(await script('slow.sh', 'sleep 30'), controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(slow, /stopped/);
});

test('the default extraction agent reports when no default coding agent is set', async () => {
  const { defaultExtractionDeps } = await import('../src/content/defaultExtractionDeps.ts');
  assert.match(String(await defaultExtractionDeps.resolveAgent()), /No default coding agent/);
  const { defaultExecutorStore } = await import('../src/executors/defaultExecutorInstance.ts');
  await defaultExecutorStore.set({ executorId: 'test-claude-cli', label: 'Test Claude' });
  const chosen = await defaultExtractionDeps.resolveAgent();
  assert.equal(typeof chosen, 'object');
  assert.equal((chosen as { kind: string }).kind, 'claude-cli');
});

test('the default extraction agent refuses a kind it cannot run and passes a Claude or Codex one through', async () => {
  const { createExtractionDeps } = await import('../src/content/defaultExtractionDeps.ts');
  const deps = (executor: { kind: string; label: string; bin: string; env?: Record<string, string> } | undefined, id: string | null = 'x') => createExtractionDeps({ currentId: async () => id, find: async () => executor });
  assert.match(String(await deps({ kind: 'http-api', label: 'Cloud API', bin: 'b' }).resolveAgent()), /Cloud API cannot read the stats/);
  assert.match(String(await deps(undefined).resolveAgent()), /No default coding agent/);
  assert.match(String(await deps({ kind: 'codex-cli', label: 'C', bin: 'b' }, null).resolveAgent()), /No default coding agent/);
  assert.deepEqual(await deps({ kind: 'codex-cli', label: 'C', bin: 'codex' }).resolveAgent(), { kind: 'codex-cli', bin: 'codex', env: {} });
  assert.deepEqual(await deps({ kind: 'claude-cli', label: 'C', bin: 'claude', env: { A: '1' } }).resolveAgent(), { kind: 'claude-cli', bin: 'claude', env: { A: '1' } });
});

test('editing an old snapshot after a republish keeps its time; a changed time is still checked', async () => {
  const f = await published();
  const made = await t.send('POST', f.post('/stats'), stat({ views: 5 }, iso(-5 * HOUR)));
  await t.send('POST', f.post('/unpublish'));
  await t.send('POST', f.post('/publish'), {});
  const note = await t.send('PATCH', f.post(`/stats/${made.body.id}`), { note: 'still editable' });
  assert.deepEqual([note.status, note.body.note], [200, 'still editable']);
  assert.equal((await t.send('PATCH', f.post(`/stats/${made.body.id}`), { capturedAt: iso(-5 * HOUR) })).body.field, 'capturedAt');
});

test('a failed save leaves no sources behind and keeps nothing half-written', async () => {
  const f = await published();
  const res = await extract(f, [['text', 'Impressions 5']]);
  f.ctx.db.exec('CREATE TRIGGER fail_insert BEFORE INSERT ON post_stats BEGIN SELECT RAISE(ABORT, \'boom\'); END');
  try {
    assert.equal((await t.send('POST', f.post('/stats'), { ...stat({ impressions: 5 }), extractionId: res.body.extractionId })).status, 500);
  } finally { f.ctx.db.exec('DROP TRIGGER fail_insert'); }
  const folder = path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'posts', f.pid, 'stats');
  assert.deepEqual(await readdir(folder).catch(() => []), [], 'no orphaned snapshot folder');
});

test('I30/I22 sources go with the post, the Concept and the Building; snapshots survive the runtime closing', async () => {
  const keep = async () => {
    const f = await published();
    const res = await extract(f, [['text', 'Impressions 5']]);
    const saved = await t.send('POST', f.post('/stats'), { ...stat({ impressions: 5 }), extractionId: res.body.extractionId });
    const folder = path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid, 'posts', f.pid);
    assert.equal(await exists(folder), true);
    return { f, folder, saved };
  };
  const a = await keep();
  await t.send('POST', a.f.post('/unpublish'));
  await t.send('POST', a.f.post('/unfinalize'));
  assert.equal((await t.send('DELETE', a.f.post())).status, 204);
  assert.equal(await exists(a.folder), false, 'post delete');
  const b = await keep();
  assert.equal((await t.send('DELETE', t.c(b.f.b, `/concepts/${b.f.cid}`))).status, 204);
  assert.equal(await exists(b.folder), false, 'Concept delete');
  const c = await keep();
  const { forgetContent, contentCtx } = await import('../src/content/runtime.ts');
  forgetContent(c.f.b);
  const reopened = (await t.api(c.f.post('/stats'))).body.snapshots;
  assert.deepEqual([reopened.length, reopened[0].id, reopened[0].sources.length], [1, c.saved.body.id, 1], 'after the runtime was closed and reopened');
  void contentCtx;
  assert.equal((await t.send('DELETE', `/api/projects/${c.f.b}`)).status < 300, true);
  assert.equal(await exists(path.join(t.dataDir, 'buildings', c.f.b)), false, 'Building delete');
});

test('I38 a snapshot save and an unpublish queued together: the first in the queue wins, the other is refused', async () => {
  const f = await published();
  let release!: () => void;
  const held = f.ctx.exclusive(() => new Promise<void>((r) => { release = r; }));
  const unpublish = t.send('POST', f.post('/unpublish'));
  const save = t.send('POST', f.post('/stats'), stat({ views: 1 }));
  await new Promise((r) => setTimeout(r, 50));
  release();
  await held;
  assert.deepEqual([(await unpublish).status, (await save).status], [200, 409]);
  assert.equal((await t.api(f.post('/stats'))).body.snapshots.length, 0);
});
