import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import type { TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/**
 * The Post content, Captions and Blog tabs on the daemon: their sessions on a post's text or article, the platform
 * limits on `save_draft`, the finalized script file, and deleting a post. Fake terminal host, temp folders, no real CLI.
 */

let t: ContentApi;
let terminal: ReturnType<typeof fakeTerminalHost>;
let service: StudioSessions;
let home: string;
let token: string;
let studioDb: typeof import('../src/db/collections.ts').studioSessionsDb;
let contentCtx: typeof import('../src/content/runtime.ts').contentCtx;
const events: any[] = [];

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'studio-post-home-'));
  t = await startContentApi(async () => {
    const mod = await import('../src/content/studioSessions.ts');
    studioDb = (await import('../src/db/collections.ts')).studioSessionsDb;
    contentCtx = (await import('../src/content/runtime.ts')).contentCtx;
    token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
    terminal = fakeTerminalHost();
    service = mod.createStudioSessions({ host: terminal.host, defaultAgentId: async () => 'test-claude-cli', home });
    service.onEvent((e) => events.push(e));
    return { studioSessions: service };
  });
});
after(async () => { await service.settled(); await t.stop(); await rm(home, { recursive: true, force: true }); });

const AT = '2026-11-03T09:00:00Z';
const ALL_POSTS = [
  { platform: 'linkedin', format: 'text', scheduledAt: AT },
  { platform: 'x', format: 'text', scheduledAt: '2026-11-04T09:00:00Z' },
  { platform: 'facebook', format: 'text', scheduledAt: '2026-11-05T09:00:00Z' },
  { platform: 'instagram', format: 'reel', scheduledAt: '2026-11-06T09:00:00Z' },
  { platform: 'blog', format: 'article', scheduledAt: '2026-11-07T09:00:00Z' },
  { platform: 'linkedin', format: 'image', scheduledAt: '2026-11-08T09:00:00Z' },
];

interface Fixture { b: string; cid: string; concept: any; dir: string }
async function fixture(posts: unknown[] = ALL_POSTS): Promise<Fixture> {
  const b = await t.createStudio('Acme');
  const c = await t.send('POST', t.c(b, '/concepts'), { title: 'Launch', brief: 'Big news', posts });
  return { b, cid: c.body.id, concept: c.body, dir: path.join(t.dataDir, 'buildings', b, 'concepts', c.body.id) };
}
const postOf = (f: Fixture, platform: string, format?: string) => f.concept.posts.find((p: any) => p.platform === platform && (!format || p.format === format));
const assetOf = (f: Fixture, platform: string, kind = platform === 'blog' ? 'article' : 'post-text', format?: string) => postOf(f, platform, format).needs.find((a: any) => a.kind === kind).id as string;
const base = (f: Fixture, aid: string) => t.c(f.b, `/concepts/${f.cid}/assets/${aid}`);
/** The session the script's finalize already started on this asset. */
const startedSession = async (f: Fixture, aid: string) => (await t.api(`${base(f, aid)}/session`)).body.session.id as string;
const start = async (f: Fixture, aid: string) => (await t.send('POST', `${base(f, aid)}/session`)).body.session.id as string;
const startsFor = (id: string): TerminalSessionStart[] => terminal.starts.filter((s) => s.taskId === id);
const saveDraft = (sessionId: string, text: unknown) => t.api(`/api/studio-session/draft?taskId=${sessionId}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
const drafts = async (f: Fixture, aid: string) => (await t.api(`${base(f, aid)}/drafts`)).body.rounds.flatMap((r: any) => r.drafts);
const ctxOf = async (b: string) => contentCtx((await t.projectsDb.get(b))!);
const blog = (n: number) => `# Title\n${'a'.repeat(n - 8)}`;
const rowCount = (ctx: Awaited<ReturnType<typeof ctxOf>>, table: string, column: string, id: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as { n: number }).n;
const fileExists = (file: string) => access(file).then(() => true, () => false);

test('I01 a session starts on a post text or article with its tab; an image set has the images pane (imagesApi.test.ts)', async () => {
  const f = await fixture();
  const cases: [string, string][] = [[assetOf(f, 'linkedin', 'post-text', 'text'), 'post-content'], [assetOf(f, 'x'), 'post-content'], [assetOf(f, 'facebook'), 'post-content'], [assetOf(f, 'instagram'), 'captions'], [assetOf(f, 'blog'), 'blog']];
  for (const [aid, tab] of cases) {
    const res = await t.send('POST', `${base(f, aid)}/session`);
    assert.equal(res.status, 201, tab);
    assert.equal(res.body.session.tab, tab);
    assert.equal(res.body.asset.state, 'drafting');
  }
  const images = assetOf(f, 'linkedin', 'image-set', 'image');
  assert.equal((await t.api(`${base(f, images)}/session`)).status, 200);
});

test('I02/I03 save_draft per platform: at the limit 200, one over 400 naming the limit, and a refusal stores nothing', async () => {
  const f = await fixture();
  const cases: [string, string, string, string][] = [
    [assetOf(f, 'linkedin', 'post-text', 'text'), 'a'.repeat(3000), 'a'.repeat(3001), '3,000'],
    [assetOf(f, 'x'), 'a'.repeat(280), 'a'.repeat(281), '280'],
    [assetOf(f, 'facebook'), 'a'.repeat(63206), 'a'.repeat(63207), '63,206'],
    [assetOf(f, 'instagram'), 'a'.repeat(2200), 'a'.repeat(2201), '2,200'],
    [assetOf(f, 'blog'), blog(50000), blog(50001), '50,000'],
  ];
  for (const [aid, fits, over, limit] of cases) {
    const id = await start(f, aid);
    assert.equal((await saveDraft(id, fits)).status, 200, limit);
    const view = (await t.api(`${base(f, aid)}/session`)).body;
    events.length = 0;
    const refused = await saveDraft(id, over);
    assert.equal(refused.status, 400, limit);
    assert.equal(refused.body.field, 'text');
    assert.ok(refused.body.error.includes(limit), refused.body.error);
    assert.equal((await drafts(f, aid)).length, 1, 'nothing stored');
    assert.equal(events.length, 0, 'no studioAsset event');
    const again = (await t.api(`${base(f, aid)}/session`)).body;
    assert.deepEqual(again.rounds, view.rounds);
    assert.equal(again.asset.round, view.asset.round);
  }
});

test('I04 X threads: 26 tweets and a long tweet are refused; a 25-tweet thread is stored as raw trimmed text', async () => {
  const f = await fixture();
  const id = await start(f, assetOf(f, 'x'));
  const join = (tweets: string[]) => tweets.join('\n---\n');
  const many = await saveDraft(id, join(Array.from({ length: 26 }, (_, i) => `t${i}`)));
  assert.equal(many.status, 400);
  assert.match(many.body.error, /26 tweets; the limit is 25 tweets/);
  const long = await saveDraft(id, join(['a', 'b'.repeat(281)]));
  assert.equal(long.status, 400);
  assert.match(long.body.error, /Tweet 2 of 2 is 281 characters/);
  const thread = join(Array.from({ length: 25 }, () => 'c'.repeat(280)));
  assert.equal((await saveDraft(id, `\n  ${thread}\n---\n  `)).status, 200);
  assert.equal((await drafts(f, assetOf(f, 'x')))[0].text, `${thread}\n---`);
});

test('I05/I06 Instagram hashtags and the blog title and minimum are refused', async () => {
  const f = await fixture();
  const ig = await start(f, assetOf(f, 'instagram'));
  const tags = await saveDraft(ig, Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '));
  assert.equal(tags.status, 400);
  assert.match(tags.body.error, /31 hashtags; the limit is 30 hashtags/);
  const article = await start(f, assetOf(f, 'blog'));
  assert.match((await saveDraft(article, 'a'.repeat(400))).body.error, /"# " followed by the title/);
  const short = await saveDraft(article, blog(299));
  assert.equal(short.status, 400);
  assert.match(short.body.error, /at least 300/);
});

test('I07 a Facebook draft of 63,206 four-byte characters (~253 KB) is accepted, not 413', async () => {
  const f = await fixture();
  const id = await start(f, assetOf(f, 'facebook'));
  const text = '😀'.repeat(63206);
  assert.ok(Buffer.byteLength(JSON.stringify({ text })) > 250_000);
  assert.equal((await saveDraft(id, text)).status, 200);
  assert.equal((await saveDraft(id, `${text}😀`)).status, 400);
});

test('I08 the stdio tool returns the refusal message to the agent as a tool error', async () => {
  const f = await fixture();
  const id = await start(f, assetOf(f, 'x'));
  const child = spawn(process.execPath, [path.resolve('bin/studio-session-mcp.mjs')], {
    env: { ...process.env, AGENT_VISUAL_OS_TASK_ID: id, AGENT_VISUAL_OS_HOOK_TOKEN: token, AGENT_VISUAL_OS_STUDIO_URL: `${t.baseUrl}/api/studio-session`, AGENT_VISUAL_OS_STUDIO_TOOLS: 'save_draft' },
  });
  const reply = await new Promise<any>((resolve) => {
    createInterface({ input: child.stdout }).once('line', (line) => resolve(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_draft', arguments: { text: 'a'.repeat(281) } } })}\n`);
  });
  child.kill();
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /^Failed: The tweet is 281 characters; the limit is 280 characters/);
});

test('I09/I11/I12 the post prompt carries the rules, the finalized script path and the other posts; the script file follows finalize and reopen', async () => {
  const f = await fixture();
  const scriptAid = f.concept.assets.find((a: any) => a.kind === 'script').id;
  const file = path.join(f.dir, 'script', 'script.md');
  const scriptSession = await start(f, scriptAid);
  await saveDraft(scriptSession, 'Hook. Body. Call to action.');
  assert.equal((await t.send('POST', `${base(f, scriptAid)}/finalize`)).status, 200);
  assert.equal(await readFile(file, 'utf8'), 'Hook. Body. Call to action.');

  await service.settled();
  const xAid = assetOf(f, 'x');
  const xPrompt = startsFor(await startedSession(f, xAid))[0]!.systemPrompt;
  assert.match(xPrompt, /Platform: X \(Twitter\)\nFormat: text/);
  assert.match(xPrompt, /One tweet up to 280 characters/);
  assert.ok(xPrompt.includes(`finalized script is in ${file}`));
  assert.match(xPrompt, /- LinkedIn, text, scheduled 2026-11-03T09:00:00\.000Z, text: Drafting/);
  assert.match(xPrompt, /- Blog, article, scheduled 2026-11-07T09:00:00\.000Z, text: Not started/);
  assert.equal(/- X \(Twitter\), text, scheduled/.test(xPrompt), false, 'its own post is not among the others');

  // Reopen removes the file; finalizing again writes the new text.
  assert.equal((await t.send('POST', `${base(f, scriptAid)}/reopen`)).status, 200);
  assert.equal(await fileExists(file), false);
  const fbAid = assetOf(f, 'facebook');
  await studioDb.delete(await startedSession(f, fbAid));
  const fbPrompt = startsFor(await start(f, fbAid))[0]!.systemPrompt;
  assert.match(fbPrompt, /No finalized script yet/);
  assert.match(fbPrompt, /- X \(Twitter\), text, scheduled 2026-11-04T09:00:00\.000Z, text: Drafting/);
  const round2 = (await t.api(`${base(f, scriptAid)}/session`)).body.session.id;
  await saveDraft(round2, 'Second script.');
  await t.send('POST', `${base(f, scriptAid)}/finalize`);
  await service.settled();
  assert.equal(await readFile(file, 'utf8'), 'Second script.');

  // Finalized in the database but the file deleted by hand: no path, and the start still succeeds.
  await rm(file);
  const igAid = assetOf(f, 'instagram');
  await studioDb.delete(await startedSession(f, igAid));
  const res = await t.send('POST', `${base(f, igAid)}/session`);
  assert.equal(res.status, 201);
  const igPrompt = startsFor(res.body.session.id)[0]!.systemPrompt;
  assert.match(igPrompt, /No finalized script yet/);
  assert.equal(igPrompt.includes('script.md'), false);
});

test('I10 the view and events never carry the folder, the script path, the token or the conversation id', async () => {
  const f = await fixture();
  const scriptAid = f.concept.assets.find((a: any) => a.kind === 'script').id;
  await saveDraft(await start(f, scriptAid), 'Script.');
  events.length = 0;
  await t.send('POST', `${base(f, scriptAid)}/finalize`);
  await service.settled();
  const aid = assetOf(f, 'linkedin', 'post-text', 'text');
  const res = await t.api(`${base(f, aid)}/session`);
  const record = (await studioDb.get(res.body.session.id))!;
  await saveDraft(record.id, 'Post.');
  const wire = JSON.stringify([res.body, events, (await t.api(`${base(f, aid)}/session`)).body]);
  for (const secret of [path.join(t.dataDir, 'buildings'), path.join(f.dir, 'script', 'script.md'), encodeURIComponent(f.dir), token, record.agentSessionId!]) assert.equal(wire.includes(secret), false, secret.slice(0, 30));
  assert.deepEqual(Object.keys(res.body.session).sort(), ['assetId', 'conceptId', 'createdAt', 'executorId', 'id', 'round', 'state', 'tab', 'updatedAt']);
  assert.equal(res.body.conceptId, f.cid);
  assert.equal(res.body.assetId, aid);
});

test('I13 deleting a post with a running session stops it and removes its record, rows, drafts and folder', async () => {
  const f = await fixture();
  const post = postOf(f, 'linkedin', 'text');
  const aid = assetOf(f, 'linkedin', 'post-text', 'text');
  const id = await start(f, aid);
  await saveDraft(id, 'draft');
  const folder = path.join(f.dir, 'posts', post.id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'note.txt'), 'x');
  const res = await t.send('DELETE', t.c(f.b, `/concepts/${f.cid}/posts/${post.id}`));
  assert.equal(res.status, 204);
  assert.ok(terminal.stops.includes(id));
  assert.equal(await studioDb.get(id), undefined);
  assert.equal(await fileExists(folder), false);
  const ctx = await ctxOf(f.b);
  assert.equal(rowCount(ctx, 'assets', 'postId', post.id), 0);
  assert.equal(rowCount(ctx, 'studio_drafts', 'assetId', aid), 0);
  assert.equal((await t.api(`${base(f, aid)}/session`)).status, 404);
});

test('I14 deleting a post with no session and no folder is 204', async () => {
  const f = await fixture();
  assert.equal((await t.send('DELETE', t.c(f.b, `/concepts/${f.cid}/posts/${postOf(f, 'facebook').id}`))).status, 204);
});

test('I15 a published post is 409 and its session and files stay', async () => {
  const f = await fixture();
  const post = postOf(f, 'x');
  const id = await start(f, assetOf(f, 'x'));
  const folder = path.join(f.dir, 'posts', post.id);
  await mkdir(folder, { recursive: true });
  (await ctxOf(f.b)).db.prepare("UPDATE posts SET status = 'published' WHERE id = ?").run(post.id);
  assert.equal((await t.send('DELETE', t.c(f.b, `/concepts/${f.cid}/posts/${post.id}`))).status, 409);
  assert.equal(terminal.stops.includes(id), false);
  assert.equal((await studioDb.get(id))?.state, 'running');
  assert.equal(await fileExists(folder), true);
});

test('I16 a save_draft that passed its session check before a delete gets 404 once the delete ran, and writes no row', async () => {
  const f = await fixture();
  const post = postOf(f, 'instagram');
  const aid = assetOf(f, 'instagram');
  const id = await start(f, aid);
  const ctx = await ctxOf(f.b);
  const { deletePost } = await import('../src/content/concepts.ts');
  // Hold the Building's write queue, queue the delete, then the draft: the draft sees a live session but its turn comes after the delete.
  let release!: () => void;
  const gate = ctx.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  const del = ctx.exclusive(() => deletePost(ctx, f.cid, post.id, (ids) => service.removeForAssets(ids)));
  const draft = service.saveDraft(id, 'late').then(() => 200, (e: { status?: number }) => e.status);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await gate;
  await del;
  assert.equal(await draft, 404);
  assert.equal(rowCount(ctx, 'studio_drafts', 'assetId', aid), 0);
});

test('I17/I18 deleting a post leaves a sibling untouched; deleting the Concept still removes every post session', async () => {
  const f = await fixture();
  const li = await start(f, assetOf(f, 'linkedin', 'post-text', 'text'));
  const x = await start(f, assetOf(f, 'x'));
  const sibling = path.join(f.dir, 'posts', postOf(f, 'x').id);
  await mkdir(sibling, { recursive: true });
  await t.send('DELETE', t.c(f.b, `/concepts/${f.cid}/posts/${postOf(f, 'linkedin', 'text').id}`));
  assert.equal(terminal.stops.includes(x), false);
  assert.equal((await studioDb.get(x))?.state, 'running');
  assert.equal(await fileExists(sibling), true);
  assert.equal(await studioDb.get(li), undefined);
  assert.equal((await t.send('DELETE', t.c(f.b, `/concepts/${f.cid}`))).status, 204);
  assert.ok(terminal.stops.includes(x));
  assert.equal(await studioDb.get(x), undefined);
});

test('I19/I20 finalizing a text leaves the post draft; the Overview finalizes it once all its assets are final', async () => {
  const f = await fixture();
  const finalizeText = async (aid: string, text: string) => {
    await saveDraft(await start(f, aid), text);
    const res = await t.send('POST', `${base(f, aid)}/finalize`);
    assert.equal(res.status, 200);
    return res;
  };
  const textPost = postOf(f, 'linkedin', 'text');
  const fin = await finalizeText(assetOf(f, 'linkedin', 'post-text', 'text'), 'Ready.');
  assert.equal(fin.body.session.state, 'ended');
  const concept = (await t.api(t.c(f.b, `/concepts/${f.cid}`))).body;
  assert.equal(concept.posts.find((p: any) => p.id === textPost.id).status, 'draft');
  assert.equal((await t.send('POST', t.c(f.b, `/concepts/${f.cid}/posts/${textPost.id}/finalize`))).status, 200);

  const imagePost = postOf(f, 'linkedin', 'image');
  await finalizeText(assetOf(f, 'linkedin', 'post-text', 'image'), 'With image.');
  const refused = await t.send('POST', t.c(f.b, `/concepts/${f.cid}/posts/${imagePost.id}/finalize`));
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.details.missing, ['image-set']);

  const blogPost = postOf(f, 'blog');
  await finalizeText(assetOf(f, 'blog'), blog(400));
  assert.equal((await t.send('POST', t.c(f.b, `/concepts/${f.cid}/posts/${blogPost.id}/finalize`))).status, 200);
});

test('I21 reopening the text of a finalized post moves the post back to draft with a note', async () => {
  const f = await fixture([{ platform: 'facebook', format: 'text', scheduledAt: AT }]);
  const post = f.concept.posts[0];
  const aid = post.needs[0].id;
  await saveDraft(await start(f, aid), 'Text.');
  await t.send('POST', `${base(f, aid)}/finalize`);
  await t.send('POST', t.c(f.b, `/concepts/${f.cid}/posts/${post.id}/finalize`));
  assert.equal((await t.send('POST', `${base(f, aid)}/reopen`)).status, 200);
  const after = (await t.api(t.c(f.b, `/concepts/${f.cid}`))).body.posts[0];
  assert.equal(after.status, 'draft');
  assert.match(after.note, /Back to draft: the post-text for this Facebook post/);
});

test('I22 two posts run sessions at once; a second start on one is 409', async () => {
  const f = await fixture();
  const a = await start(f, assetOf(f, 'linkedin', 'post-text', 'text'));
  const b = await start(f, assetOf(f, 'facebook'));
  assert.ok(terminal.live.has(a) && terminal.live.has(b));
  const again = await t.send('POST', `${base(f, assetOf(f, 'linkedin', 'post-text', 'text'))}/session`);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already running/);
});

test('I23 a read-only Building refuses a post-text start and still reads it', async () => {
  const f = await fixture();
  await t.projectsDb.update(f.b, { readOnlyReason: 'Migration failed for the test' });
  const aid = assetOf(f, 'instagram');
  assert.equal((await t.send('POST', `${base(f, aid)}/session`)).status, 409);
  assert.equal((await t.api(`${base(f, aid)}/session`)).status, 200);
});

test('I24 get_concept and the drafts route work for a post session', async () => {
  const f = await fixture();
  const aid = assetOf(f, 'blog');
  const id = await start(f, aid);
  const concept = await t.api(`/api/studio-session/concept?taskId=${id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(concept.status, 200);
  assert.equal(concept.body.id, f.cid);
  await saveDraft(id, blog(300));
  const list = await t.api(`${base(f, aid)}/drafts`);
  assert.equal(list.status, 200);
  assert.equal(list.body.rounds[0].drafts.length, 1);
});

test('I25 a non-UUID asset id on the post routes is 404', async () => {
  const f = await fixture();
  for (const bad of ['..%2F..%2Fx', 'not-a-uuid', '00000000-0000-4000-8000-00000000000Z']) {
    assert.equal((await t.api(t.c(f.b, `/concepts/${f.cid}/assets/${bad}/session`))).status, 404, bad);
    assert.equal((await t.send('POST', t.c(f.b, `/concepts/${f.cid}/assets/${bad}/session`))).status, 404, bad);
  }
});

test('SI11 37.006 a script draft with a heading is 400 naming the line; nothing is stored or published', async () => {
  const f = await fixture();
  const scriptAid = f.concept.assets.find((a: any) => a.kind === 'script').id;
  const id = await start(f, scriptAid);
  assert.equal((await saveDraft(id, 'Spoken first draft.')).status, 200);
  const before = events.length;
  const refused = await saveDraft(id, '# Launch\nSpoken words.');
  assert.deepEqual([refused.status, refused.body.field], [400, 'text']);
  assert.equal(refused.body.error, 'Remove the heading on line 1 and save only the spoken script');
  assert.deepEqual((await drafts(f, scriptAid)).map((d: any) => d.text), ['Spoken first draft.']);
  assert.equal(events.length, before, 'no publish event for a refusal');
});

test('SI12 37.006 a Hindi/Hinglish script with emoji is stored as sent', async () => {
  const f = await fixture();
  const scriptAid = f.concept.assets.find((a: any) => a.kind === 'script').id;
  const id = await start(f, scriptAid);
  const text = 'दोस्तों, aaj hum baat karenge: WhatsApp replies 🔥\n\nअसली समस्या यही है (sach mein), आपका प्रोडक्ट नहीं।';
  assert.equal((await saveDraft(id, text)).status, 200);
  assert.equal((await drafts(f, scriptAid)).at(-1).text, text);
});

test('SI13 37.006 the script guard leaves post texts and articles alone', async () => {
  const f = await fixture();
  assert.equal((await saveDraft(await start(f, assetOf(f, 'blog')), blog(400))).status, 200, 'an article starts with "# "');
  assert.equal((await saveDraft(await start(f, assetOf(f, 'linkedin', 'post-text', 'text')), 'Hook:\n[pause]\nHere is the script:\nBody')).status, 200);
});

test('SI14 37.006 the stdio tool hands a script refusal to the agent as a tool error', async () => {
  const f = await fixture();
  const id = await start(f, f.concept.assets.find((a: any) => a.kind === 'script').id);
  const child = spawn(process.execPath, [path.resolve('bin/studio-session-mcp.mjs')], {
    env: { ...process.env, AGENT_VISUAL_OS_TASK_ID: id, AGENT_VISUAL_OS_HOOK_TOKEN: token, AGENT_VISUAL_OS_STUDIO_URL: `${t.baseUrl}/api/studio-session`, AGENT_VISUAL_OS_STUDIO_TOOLS: 'save_draft' },
  });
  const reply = await new Promise<any>((resolve) => {
    createInterface({ input: child.stdout }).once('line', (line) => resolve(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_draft', arguments: { text: 'Hook:\nSpoken.' } } })}\n`);
  });
  child.kill();
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /^Failed: Remove the label "Hook:" on line 1 and save only the spoken script/);
});
