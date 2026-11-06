import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';

let t: ContentApi;
before(async () => { t = await startContentApi(); });
after(async () => { await t.stop(); });

const exists = (p: string) => access(p).then(() => true, () => false);
const post = (platform: string, format: string, scheduledAt = '2026-11-03T09:00:00Z') => ({ platform, format, scheduledAt });

test('SI01/SI04 a Content Studio Building is created with its folder, knowledge files and zone; the Type is listed', async () => {
  const types = await t.api('/api/building-types');
  const type = types.body.find((x: { id: string }) => x.id === 'content-studio');
  assert.deepEqual([type.name, type.devOnly, type.repository, type.version, type.category], ['Content Studio', false, false, 1, 'Marketing']);
  const id = await t.createStudio('Acme', 'Asia/Kolkata');
  const dir = path.join(t.dataDir, 'buildings', id);
  for (const f of ['content.sqlite', 'knowledge/README.md', 'knowledge/writing-style.md', 'knowledge/about.md', 'knowledge/dos-donts.md']) assert.ok(await exists(path.join(dir, f)), f);
  assert.equal((await t.api(t.c(id, '/settings'))).body.timezone, 'Asia/Kolkata');
  assert.match((await t.api(t.c(id, '/writing-style'))).body.content, /## General[\s\S]*## Video script/);
});

test('SI02/SI03 create validates name and timezone; an omitted timezone is UTC', async () => {
  for (const name of ['', '   ', 'x'.repeat(81), 5]) {
    const res = await t.send('POST', '/api/projects', { typeId: 'content-studio', name });
    assert.deepEqual([res.status, res.body.field], [400, 'name'], String(name));
  }
  const bad = await t.send('POST', '/api/projects', { typeId: 'content-studio', name: 'A', timezone: 'Mars/Phobos' });
  assert.deepEqual([bad.status, bad.body.field], [400, 'timezone']);
  const id = (await t.send('POST', '/api/projects', { typeId: 'content-studio', name: 'No zone' })).body.id;
  assert.equal((await t.api(t.c(id, '/settings'))).body.timezone, 'UTC');
});

test('SI05 every route group is 404 on an unknown Building and on a Building of another Type', async () => {
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  const routes = ['/concepts', '/calendar?month=2026-10', '/settings', '/knowledge/sections', '/knowledge/files', '/knowledge/colours', '/writing-style', '/writing-style/history'];
  for (const target of ['no-such-building', seo.body.id]) for (const suffix of routes) {
    const res = await t.api(t.c(target, suffix));
    assert.equal(res.status, 404, `${suffix} on ${target}`);
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal((await t.send('POST', t.c(seo.body.id, '/concepts'), { title: 'x' })).status, 404);
});

test('SI06/SI07/SI08 a Concept is created with its folder and empty script and video; bad input and a bad first post write nothing', async () => {
  const id = await t.createStudio();
  const res = await t.send('POST', t.c(id, '/concepts'), { title: '  Launch  ', brief: 'Why' });
  assert.equal(res.status, 201);
  assert.deepEqual([res.body.title, res.body.archived, res.body.posts.length], ['Launch', false, 0]);
  assert.deepEqual(res.body.assets.map((a: { kind: string; state: string }) => [a.kind, a.state]), [['script', 'empty'], ['video', 'empty']]);
  assert.ok(await exists(path.join(t.dataDir, 'buildings', id, 'concepts', res.body.id)));
  for (const body of [{}, { title: 'x'.repeat(201) }, { title: 'ok', brief: 'b'.repeat(5001) }, { title: 4 }, { title: 'ok', posts: 'no' }]) assert.equal((await t.send('POST', t.c(id, '/concepts'), body)).status, 400, JSON.stringify(body).slice(0, 40));
  const atomic = await t.send('POST', t.c(id, '/concepts'), { title: 'Atomic', posts: [post('x', 'text'), post('blog', 'video')] });
  assert.deepEqual([atomic.status, atomic.body.field], [400, 'format']);
  assert.equal((await t.api(t.c(id, '/concepts'))).body.total, 1);
  assert.equal((await readdir(path.join(t.dataDir, 'buildings', id, 'concepts'))).length, 1);
});

test('SI09/SI10/SI11/SI12 the list is newest first, pages and clamps, and filters combine', async () => {
  const id = await t.createStudio();
  for (const [title, posts] of [['Alpha 100%', [post('linkedin', 'text')]], ['Beta', [post('instagram', 'reel')]], ['Gamma', []]] as const) {
    await t.send('POST', t.c(id, '/concepts'), { title, brief: title === 'Beta' ? 'about under_score' : '', posts });
  }
  const list = (q = '') => t.api(t.c(id, `/concepts${q}`));
  assert.deepEqual((await list()).body.rows.map((r: { title: string }) => r.title), ['Gamma', 'Beta', 'Alpha 100%']);
  const page = (await list('?limit=1&offset=1')).body;
  assert.deepEqual([page.rows[0].title, page.total, page.hasMore], ['Beta', 3, true]);
  assert.equal((await list('?limit=500')).body.limit, 200);
  for (const bad of ['0', '-1', '1.5', 'abc']) assert.equal((await list(`?limit=${bad}`)).status, 400, bad);
  assert.deepEqual((await list('?platform=instagram')).body.rows.map((r: { title: string }) => r.title), ['Beta']);
  assert.equal((await list('?status=draft')).body.total, 2);
  assert.equal((await list('?status=published')).body.total, 0);
  assert.equal((await list('?status=weird')).status, 400);
  assert.equal((await list('?platform=weird')).status, 400);
  assert.deepEqual((await list('?q=100%25')).body.rows.map((r: { title: string }) => r.title), ['Alpha 100%']);
  assert.equal((await list('?q=%25')).body.total, 1, '% is literal');
  assert.equal((await list('?q=UNDER_SCORE')).body.total, 1, 'case-insensitive over the brief');
  assert.equal((await list('?q=a_b')).body.total, 0, '_ is literal');
  assert.equal((await list('?platform=linkedin&status=draft&q=alpha')).body.total, 1);
});

test('SI13/SI14/SI15/SI16 read, patch (archive hides it) and delete a Concept', async () => {
  const id = await t.createStudio();
  const a = (await t.send('POST', t.c(id, '/concepts'), { title: 'A' })).body, b = (await t.send('POST', t.c(id, '/concepts'), { title: 'B' })).body;
  assert.equal((await t.api(t.c(id, `/concepts/${a.id}`))).body.title, 'A');
  assert.equal((await t.api(t.c(id, '/concepts/not-an-id'))).status, 404);
  assert.equal((await t.api(t.c(id, '/concepts/00000000-0000-4000-8000-000000000000'))).status, 404);
  const patched = (await t.send('PATCH', t.c(id, `/concepts/${a.id}`), { title: 'A2', brief: 'new', archived: true })).body;
  assert.deepEqual([patched.title, patched.brief, patched.archived, patched.updatedAt > a.updatedAt], ['A2', 'new', true, true]);
  const same = (await t.send('PATCH', t.c(id, `/concepts/${a.id}`), {})).body;
  assert.equal(same.updatedAt, patched.updatedAt);
  assert.deepEqual((await t.api(t.c(id, '/concepts'))).body.rows.map((r: { id: string }) => r.id), [b.id]);
  assert.deepEqual((await t.api(t.c(id, '/concepts?archived=true'))).body.rows.map((r: { id: string }) => r.id), [a.id]);
  assert.equal((await t.api(t.c(id, '/concepts?archived=maybe'))).status, 400);
  for (const body of [{ title: '' }, { brief: 'x'.repeat(5001) }, { archived: 'yes' }]) assert.equal((await t.send('PATCH', t.c(id, `/concepts/${a.id}`), body)).status, 400);
  assert.equal((await t.send('DELETE', t.c(id, `/concepts/${a.id}`))).status, 204);
  assert.equal(await exists(path.join(t.dataDir, 'buildings', id, 'concepts', a.id)), false);
  assert.ok(await exists(path.join(t.dataDir, 'buildings', id, 'concepts', b.id)), 'a sibling is untouched');
  assert.equal((await t.send('DELETE', t.c(id, `/concepts/${a.id}`))).status, 404);
});

test('SI17/SI18/SI19/SI20/SI21 posts: asset records by format, several of one platform, date-only patch, delete', async () => {
  const id = await t.createStudio();
  const concept = (await t.send('POST', t.c(id, '/concepts'), { title: 'C' })).body;
  const add = (body: unknown) => t.send('POST', t.c(id, `/concepts/${concept.id}/posts`), body);
  const kinds = async (platform: string, format: string) => (await add(post(platform, format))).body.needs.map((a: { kind: string; state: string }) => `${a.kind}:${a.state}`);
  assert.deepEqual(await kinds('blog', 'article'), ['article:empty']);
  assert.deepEqual(await kinds('linkedin', 'text'), ['post-text:empty']);
  assert.deepEqual(await kinds('x', 'image'), ['post-text:empty', 'image-set:empty']);
  assert.deepEqual(await kinds('instagram', 'reel'), ['post-text:empty', 'video:empty', 'thumbnail:empty']);
  const two = await add(post('x', 'text'));
  assert.equal(two.status, 201);
  assert.equal(two.body.status, 'draft');
  assert.equal((await t.api(t.c(id, `/concepts/${concept.id}`))).body.posts.filter((p: { platform: string }) => p.platform === 'x').length, 2);
  for (const [body, field] of [[post('nope', 'text'), 'platform'], [post('x', 'carousel'), 'format'], [post('x', 'text', '2026-11-03'), 'scheduledAt'], [{ platform: 'x', format: 'text' }, 'scheduledAt']] as const) {
    const res = await add(body);
    assert.deepEqual([res.status, res.body.field], [400, field]);
  }
  assert.equal((await t.send('POST', t.c(id, '/concepts/00000000-0000-4000-8000-000000000000/posts'), post('x', 'text'))).status, 404);
  const p = `/concepts/${concept.id}/posts/${two.body.id}`;
  assert.equal((await t.send('PATCH', t.c(id, p), { scheduledAt: '2026-12-01T10:00:00+01:00' })).body.scheduledAt, '2026-12-01T09:00:00.000Z');
  assert.equal((await t.send('PATCH', t.c(id, p), { scheduledAt: 'tomorrow' })).status, 400);
  assert.equal((await t.send('PATCH', t.c(id, p), { platform: 'blog' })).status, 400);
  assert.equal((await t.send('PATCH', t.c(id, `/concepts/${concept.id}/posts/00000000-0000-4000-8000-000000000000`), {})).status, 404);
  assert.equal((await t.send('DELETE', t.c(id, p))).status, 204);
  assert.equal((await t.send('DELETE', t.c(id, p))).status, 404);
});

test('SI22/SI23/SI24/SI25/SI26 finalize needs every asset finalized; unfinalize; an asset redrafted demotes the post', async () => {
  const id = await t.createStudio();
  const concept = (await t.send('POST', t.c(id, '/concepts'), { title: 'C', posts: [post('instagram', 'reel'), post('linkedin', 'text')] })).body;
  const [reel, text] = [concept.posts.find((p: { format: string }) => p.format === 'reel'), concept.posts.find((p: { format: string }) => p.format === 'text')];
  const path = (p: { id: string }, verb: string) => t.c(id, `/concepts/${concept.id}/posts/${p.id}/${verb}`);
  const refused = await t.send('POST', path(reel, 'finalize'));
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.details.missing, ['post-text', 'video', 'thumbnail']);
  assert.equal((await t.send('POST', path(text, 'unfinalize'))).status, 409, 'a draft cannot go back to draft');

  const { contentCtx, } = await import('../src/content/runtime.ts');
  const { setAssetState } = await import('../src/content/concepts.ts');
  const ctx = contentCtx((await t.projectsDb.get(id))!);
  const textAsset = text.needs[0].id;
  setAssetState(ctx, textAsset, 'finalized', 'Hello');
  const done = await t.send('POST', path(text, 'finalize'));
  assert.deepEqual([done.status, done.body.status], [200, 'finalized']);
  assert.equal((await t.send('POST', path(text, 'finalize'))).status, 409, 'already finalized');
  assert.equal((await t.send('POST', path(text, 'unfinalize'))).body.status, 'draft');
  await t.send('POST', path(text, 'finalize'));
  setAssetState(ctx, textAsset, 'drafting');
  const after = (await t.api(t.c(id, `/concepts/${concept.id}`))).body.posts.find((p: { id: string }) => p.id === text.id);
  assert.equal(after.status, 'draft');
  assert.match(after.note, /redrafted/);
  assert.equal(after.needs[0].round, 1);
  assert.throws(() => setAssetState(ctx, textAsset, 'weird' as never), /state must be/);
  assert.throws(() => setAssetState(ctx, '00000000-0000-4000-8000-000000000000', 'empty'), /does not exist/);
  // A published post cannot be finalized, unfinalized or deleted.
  ctx.db.prepare("UPDATE posts SET status = 'published' WHERE id = ?").run(text.id);
  assert.equal((await t.send('POST', path(text, 'finalize'))).status, 409);
  assert.equal((await t.send('POST', path(text, 'unfinalize'))).status, 409);
  assert.equal((await t.send('DELETE', t.c(id, `/concepts/${concept.id}/posts/${text.id}`))).status, 409);
  setAssetState(ctx, textAsset, 'finalized');
  const list = (await t.api(t.c(id, '/concepts'))).body.rows[0];
  assert.deepEqual(list.progress, { finalized: 1, needed: 4 });
});

test('SI27/SI28/SI29 the calendar groups by Building-zone month', async () => {
  const id = await t.createStudio('Cal', 'Pacific/Auckland');
  await t.send('POST', t.c(id, '/concepts'), { title: 'Edge', posts: [post('x', 'text', '2026-10-31T10:59:00Z'), post('x', 'text', '2026-10-31T11:00:00Z'), post('blog', 'article', '2026-09-30T11:30:00Z')] });
  const month = async (m: string) => (await t.api(t.c(id, `/calendar?month=${m}`))).body;
  const oct = await month('2026-10');
  assert.equal(oct.timezone, 'Pacific/Auckland');
  assert.deepEqual(oct.posts.map((p: { scheduledAt: string }) => p.scheduledAt), ['2026-09-30T11:30:00.000Z', '2026-10-31T10:59:00.000Z'], 'Auckland is UTC+13 in late October');
  assert.equal(oct.posts[0].conceptTitle, 'Edge');
  assert.deepEqual((await month('2026-11')).posts.map((p: { scheduledAt: string }) => p.scheduledAt), ['2026-10-31T11:00:00.000Z']);
  assert.deepEqual((await month('2027-02')).posts, []);
  for (const bad of ['', '?month=2026-13', '?month=2026-1', '?month=2026-10-01', '?month=2026-10&month=2026-11', '?month=2026-10&x=1']) {
    const res = await t.api(t.c(id, `/calendar${bad === '' ? '' : bad}`));
    assert.equal(res.status, 400, bad);
  }
});

test('SI30 GET routes are pure reads', async () => {
  const id = await t.createStudio();
  const c = (await t.send('POST', t.c(id, '/concepts'), { title: 'P', posts: [post('x', 'text')] })).body;
  const dir = path.join(t.dataDir, 'buildings', id, 'knowledge');
  const before = await Promise.all((await readdir(dir)).map(async (f) => (await import('node:fs/promises')).stat(path.join(dir, f)).then((s) => [f, s.mtimeMs])));
  for (const suffix of ['/concepts', `/concepts/${c.id}`, '/calendar?month=2026-11', '/settings', '/knowledge/sections', '/knowledge/sections/about', '/knowledge/files', '/knowledge/colours', '/writing-style', '/writing-style/history']) assert.equal((await t.api(t.c(id, suffix))).status, 200, suffix);
  const after = await Promise.all((await readdir(dir)).map(async (f) => (await import('node:fs/promises')).stat(path.join(dir, f)).then((s) => [f, s.mtimeMs])));
  assert.deepEqual(after, before);
  assert.equal((await t.api(t.c(id, `/concepts/${c.id}`))).body.updatedAt, c.updatedAt);
});

test('SI44 a read-only Building answers 409 on every write route and 200 on every read route', async () => {
  const id = await t.createStudio('Frozen');
  const c = (await t.send('POST', t.c(id, '/concepts'), { title: 'Keep', posts: [post('x', 'text')] })).body;
  await t.projectsDb.update(id, { readOnlyReason: 'Migration failed for the test' });
  const p = `/concepts/${c.id}/posts/${c.posts[0].id}`;
  const writes: Array<[string, string, unknown?]> = [
    ['POST', '/concepts', { title: 'n' }], ['PATCH', `/concepts/${c.id}`, { title: 'x' }], ['DELETE', `/concepts/${c.id}`], ['POST', `/concepts/${c.id}/posts`, post('x', 'text')],
    ['PATCH', p, { scheduledAt: '2026-12-01T10:00:00Z' }], ['DELETE', p], ['POST', `${p}/finalize`], ['POST', `${p}/unfinalize`], ['PATCH', '/settings', { name: 'n' }],
    ['PUT', '/knowledge/sections/about', { content: 'x', version: 'v' }], ['POST', '/knowledge/sections', { name: 'More' }], ['DELETE', '/knowledge/sections/about'],
    ['PUT', '/knowledge/colours', { colours: [] }], ['POST', '/knowledge/files?name=a.txt'], ['DELETE', '/knowledge/files/a.txt'], ['PUT', '/writing-style', { content: 'x', version: 'v' }],
  ];
  for (const [method, suffix, body] of writes) {
    const res = await t.send(method, t.c(id, suffix), body ?? {});
    assert.equal(res.status, 409, `${method} ${suffix}: ${res.text}`);
    assert.equal(res.body.error, 'Migration failed for the test');
  }
  for (const suffix of ['/concepts', `/concepts/${c.id}`, '/calendar?month=2026-11', '/settings', '/knowledge/sections', '/knowledge/files', '/knowledge/colours', '/writing-style', '/writing-style/history']) assert.equal((await t.api(t.c(id, suffix))).status, 200, suffix);
  assert.equal((await t.api(t.c(id, '/concepts'))).body.total, 1);
});

test('SI45 deleting a Building removes its folder and leaves another Building alone', async () => {
  const [a, b] = [await t.createStudio('A'), await t.createStudio('B')];
  await t.send('POST', t.c(a, '/concepts'), { title: 'Gone' });
  assert.equal((await t.send('DELETE', `/api/projects/${a}`)).status, 204);
  assert.equal(await exists(path.join(t.dataDir, 'buildings', a)), false);
  assert.ok(await exists(path.join(t.dataDir, 'buildings', b, 'content.sqlite')));
  assert.equal((await t.api(t.c(a, '/concepts'))).status, 404);
});

test('SI47 writes to one Building run one at a time', async () => {
  const id = await t.createStudio();
  const { contentCtx } = await import('../src/content/runtime.ts');
  const ctx = contentCtx((await t.projectsDb.get(id))!);
  const order: string[] = [];
  let release!: () => void;
  const first = ctx.exclusive(async () => { order.push('first-start'); await new Promise<void>((r) => { release = r; }); order.push('first-end'); });
  const second = ctx.exclusive(async () => { order.push('second'); });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('SI49 a malformed or non-object body is 400', async () => {
  const id = await t.createStudio();
  assert.equal((await t.api(t.c(id, '/concepts'), { method: 'POST', body: '{nope' })).status, 400);
  for (const body of ['[1]', '"text"', '5']) assert.equal((await t.api(t.c(id, '/concepts'), { method: 'POST', body })).status, 400, body);
});

test('SI50 settings: the name and zone change; only Settings shows the folder path', async () => {
  const id = await t.createStudio('Old');
  const concept = (await t.send('POST', t.c(id, '/concepts'), { title: 'T', posts: [post('x', 'text')] })).body;
  const dir = path.join(t.dataDir, 'buildings', id);
  const settings = (await t.api(t.c(id, '/settings'))).body;
  assert.equal(settings.folder, dir);
  const res = await t.send('PATCH', t.c(id, '/settings'), { name: ' New ', timezone: 'America/New_York' });
  assert.deepEqual([res.body.name, res.body.timezone], ['New', 'America/New_York']);
  assert.equal((await t.api(`/api/projects/${id}`)).body.name, 'New');
  assert.equal((await t.send('PATCH', t.c(id, '/settings'), { name: '' })).body.field, 'name');
  assert.equal((await t.send('PATCH', t.c(id, '/settings'), { timezone: 'nope' })).body.field, 'timezone');
  for (const suffix of ['/concepts', `/concepts/${concept.id}`, '/calendar?month=2026-11', '/knowledge/sections', '/writing-style']) {
    assert.ok(!(await t.api(t.c(id, suffix))).text.includes(dir), `${suffix} does not leak the data path`);
  }
});
