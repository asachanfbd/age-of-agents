import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/**
 * The line comment route (`POST …/assets/:aid/session/comment`): it types the comment into the live session through the
 * terminal host. Fake terminal host, held submit timer, temp folders; no real CLI or database.
 */

let t: ContentApi;
let terminal: ReturnType<typeof fakeTerminalHost>;
let service: StudioSessions;
let home: string;
let token: string;
let studioDb: typeof import('../src/db/collections.ts').studioSessionsDb;
let commentMessage: typeof import('../src/content/studioComments.ts').commentMessage;
const events: any[] = [];
/** Submit timers waiting to fire; with `holdTimers` off they fire at once. */
let held: (() => void)[] = [];
let holdTimers = false;

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'studio-comment-home-'));
  t = await startContentApi(async () => {
    const mod = await import('../src/content/studioSessions.ts');
    studioDb = (await import('../src/db/collections.ts')).studioSessionsDb;
    commentMessage = (await import('../src/content/studioComments.ts')).commentMessage;
    token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
    (await import('../src/content/videoDeps.ts')).configureVideo({
      submitDelayMs: 300,
      setTimer: (fn) => { if (holdTimers) held.push(fn); else fn(); return () => undefined; },
    });
    terminal = fakeTerminalHost();
    service = mod.createStudioSessions({ host: terminal.host, defaultAgentId: async () => 'test-claude-cli', home });
    service.onEvent((e) => events.push(e));
    return { studioSessions: service };
  });
});
after(async () => { await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => { holdTimers = false; held = []; });

const DRAFT = 'Open strong\n\nSecond beat\nThird beat\nFourth beat\nFifth beat\nThe hook line\nEighth\nNinth';
const POSTS = [
  { platform: 'instagram', format: 'reel', scheduledAt: '2026-11-03T09:00:00Z' },
  { platform: 'linkedin', format: 'text', scheduledAt: '2026-11-04T09:00:00Z' },
  { platform: 'linkedin', format: 'image', scheduledAt: '2026-11-05T09:00:00Z' },
];

interface Fixture { b: string; cid: string; aid: string; concept: any; base: string; sessionId: string }
async function fixture(draft: string | null = DRAFT): Promise<Fixture> {
  const b = await t.createStudio('Acme');
  const c = await t.send('POST', t.c(b, '/concepts'), { title: 'Launch', brief: 'Big news', posts: POSTS });
  const aid = c.body.assets.find((a: any) => a.kind === 'script').id;
  const base = t.c(b, `/concepts/${c.body.id}/assets/${aid}`);
  const sessionId = (await t.send('POST', `${base}/session`)).body.session.id;
  if (draft !== null) await saveDraft(sessionId, draft);
  return { b, cid: c.body.id, aid, concept: c.body, base, sessionId };
}
const saveDraft = (sessionId: string, text: string) => t.api(`/api/studio-session/draft?taskId=${sessionId}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
const send = (base: string, payload: unknown) => t.send('POST', `${base}/session/comment`, payload);
const ok = { line: 7, lineText: 'The hook line', comment: 'Make it punchier' };
const pasted = (text: string) => `\x1b[200~${text}\x1b[201~`;
const writesFor = (id: string) => terminal.writes.filter((w) => w.taskId === id).map((w) => w.data);
const endSession = (id: string) => [...terminal.starts].reverse().find((s) => s.taskId === id)!.onExit(0, undefined, undefined);
const postAsset = (f: Fixture, format: string, kind: string) => f.concept.posts.find((p: any) => p.format === format).needs.find((a: any) => a.kind === kind).id as string;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function assertRefused(f: Fixture, payload: unknown, status: number, error: RegExp, field?: string) {
  const before = terminal.writes.length;
  const res = await send(f.base, payload);
  assert.equal(res.status, status, res.text);
  assert.match(res.body.error, error);
  if (field) assert.equal(res.body.field, field);
  assert.equal(terminal.writes.length, before, 'nothing is typed into the terminal');
}

test('SI1 a comment on a live session answers 200 and types the message, then Enter, into that session', async () => {
  const f = await fixture();
  const res = await send(f.base, ok);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body).sort(), ['line', 'sentAt', 'sentChars']);
  assert.equal(res.body.line, 7);
  assert.ok(!Number.isNaN(Date.parse(res.body.sentAt)));
  assert.equal(res.body.sentChars, commentMessage(DRAFT, ok, true).length);
  assert.deepEqual(writesFor(f.sessionId), [pasted(commentMessage(DRAFT, ok, true)), '\r']);
  assert.match(writesFor(f.sessionId)[0]!, /^\x1b\[200~Comment on line 7 of the current draft\. Line: "The hook line"\. Nearby lines: 5: "Fourth beat"; 6: "Fifth beat"; 8: "Eighth"; 9: "Ninth"\. Comment: Make it punchier\. Update the script/);
});

test('SI2 Enter is typed only after the submit timer fires', async () => {
  const f = await fixture();
  holdTimers = true;
  const pending = send(f.base, ok);
  while (!held.length) await flush();
  assert.deepEqual(writesFor(f.sessionId), [pasted(commentMessage(DRAFT, ok, true))]);
  held.shift()!();
  assert.equal((await pending).status, 200);
  assert.deepEqual(writesFor(f.sessionId).at(-1), '\r');
});

test('SI3 an ended session is 409 with the Resume message', async () => {
  const f = await fixture();
  endSession(f.sessionId);
  await flush();
  await assertRefused(f, ok, 409, /^The agent session has ended\. Press Resume, then send the comment again\.$/);
});

test('SI4 a record still marked running that the host lost is the same 409', async () => {
  const f = await fixture();
  terminal.live.delete(f.sessionId);
  assert.equal((await studioDb.get(f.sessionId))!.state, 'running');
  await assertRefused(f, ok, 409, /Press Resume/);
});

test('SI5 a draft only in an earlier round is 409 "no draft yet"', async () => {
  const f = await fixture();
  assert.equal((await t.send('POST', `${f.base}/session/new-round`)).status, 200);
  await assertRefused(f, ok, 409, /^There is no draft to comment on yet\.$/);
});

test('SI6 an empty comment is 400 on the comment field', async () => {
  const f = await fixture();
  await assertRefused(f, { ...ok, comment: '   ' }, 400, /comment/i, 'comment');
});

test('SI7 a 2,001-code-point comment is 400; 2,000 is 200', async () => {
  const f = await fixture();
  await assertRefused(f, { ...ok, comment: '😀'.repeat(2001) }, 400, /2,000/, 'comment');
  assert.equal((await send(f.base, { ...ok, comment: '😀'.repeat(2000) })).status, 200);
});

test('SI8 a line of 0, "7" or 1.5 is 400 on the line field', async () => {
  const f = await fixture();
  for (const line of [0, '7', 1.5]) await assertRefused(f, { ...ok, line }, 400, /line/, 'line');
});

test('SI9 a line past the end, or text that no longer matches, is 409 stale', async () => {
  const f = await fixture();
  await assertRefused(f, { ...ok, line: 99 }, 409, /^The draft changed\. Check the line and send again\.$/);
  await assertRefused(f, { ...ok, lineText: 'An older hook line' }, 409, /The draft changed/);
});

test('SI10 a finalized asset is 409', async () => {
  const f = await fixture();
  assert.equal((await t.send('POST', `${f.base}/finalize`)).status, 200);
  await assertRefused(f, ok, 409, /^This is finalized\. Reopen it to work on it again\.$/);
});

test('SI11 an unknown asset, another Concept\'s asset or a malformed id is 404', async () => {
  const f = await fixture();
  const other = await fixture();
  const uuid = '11111111-1111-4111-8111-111111111111';
  for (const suffix of [`/concepts/${f.cid}/assets/${uuid}`, `/concepts/${f.cid}/assets/${other.aid}`, `/concepts/${f.cid}/assets/not-an-id`]) {
    const res = await t.send('POST', `${t.c(f.b, suffix)}/session/comment`, ok);
    assert.equal(res.status, 404, suffix);
  }
});

test('SI12 a video or image-set asset is 409 "text drafts only"', async () => {
  const f = await fixture();
  const video = f.concept.assets.find((a: any) => a.kind === 'video').id;
  const images = postAsset(f, 'image', 'image-set');
  for (const aid of [video, images]) {
    const before = terminal.writes.length;
    const res = await t.send('POST', t.c(f.b, `/concepts/${f.cid}/assets/${aid}/session/comment`), ok);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'Comments work on text drafts only');
    assert.equal(terminal.writes.length, before);
  }
});

test('SI13 a read-only Building is 409', async () => {
  const f = await fixture();
  await t.projectsDb.update(f.b, { readOnlyReason: 'Migration failed for the test' });
  await assertRefused(f, ok, 409, /Migration failed/);
});

test('SI14 a Building of another type is 404', async () => {
  const f = await fixture();
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  assert.equal((await t.send('POST', `/api/projects/${seo.body.id}/content/concepts/${f.cid}/assets/${f.aid}/session/comment`, ok)).status, 404);
});

test('SI15 a body that is an array or a string is 400', async () => {
  const f = await fixture();
  for (const raw of ['[1]', '"text"']) {
    const res = await t.api(`${f.base}/session/comment`, { method: 'POST', body: raw });
    assert.equal(res.status, 400, raw);
  }
});

test('SI16 a post text with a live session takes comments and says "the text"', async () => {
  const f = await fixture();
  const aid = postAsset(f, 'text', 'post-text');
  const base = t.c(f.b, `/concepts/${f.cid}/assets/${aid}`);
  const sessionId = (await t.send('POST', `${base}/session`)).body.session.id;
  await saveDraft(sessionId, 'First line\nSecond line');
  const res = await send(base, { line: 2, lineText: 'Second line', comment: 'Warmer' });
  assert.equal(res.status, 200, res.text);
  assert.match(writesFor(sessionId)[0]!, /Update the text to address this and save the new draft\.\x1b\[201~$/);
});

test('SI17 no answer leaks the session id, the conversation id or a folder path', async () => {
  const f = await fixture();
  const record = (await studioDb.get(f.sessionId))!;
  const secrets = [f.sessionId, record.agentSessionId!, path.join(t.dataDir, 'buildings', f.b), path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid)];
  const answers = [await send(f.base, ok), await send(f.base, { ...ok, comment: '' }), await send(f.base, { ...ok, line: 99 })];
  endSession(f.sessionId);
  await flush();
  answers.push(await send(f.base, ok));
  for (const res of answers) for (const secret of secrets) assert.ok(!res.text.includes(secret), `${res.status} leaks ${secret}`);
});

test('SI18 two comments at once are typed one after the other', async () => {
  const f = await fixture();
  holdTimers = true;
  const second = { ...ok, line: 1, lineText: 'Open strong', comment: 'Second' };
  const first = send(f.base, ok);
  while (!held.length) await flush();
  const next = send(f.base, second);
  await flush();
  assert.equal(held.length, 1, 'the second comment waits for the first');
  held.shift()!();
  while (!held.length) await flush();
  held.shift()!();
  assert.deepEqual([(await first).status, (await next).status], [200, 200]);
  assert.deepEqual(writesFor(f.sessionId), [pasted(commentMessage(DRAFT, ok, true)), '\r', pasted(commentMessage(DRAFT, second, true)), '\r']);
});

test('SI19 a comment saves no draft, keeps the asset as it was and emits no view', async () => {
  const f = await fixture();
  const before = (await t.api(`${f.base}/session`)).body;
  const drafts = (await t.api(`${f.base}/drafts`)).body;
  const emitted = events.length;
  assert.equal((await send(f.base, ok)).status, 200);
  assert.equal(events.length, emitted);
  const afterView = (await t.api(`${f.base}/session`)).body;
  assert.deepEqual(afterView.asset, before.asset);
  assert.deepEqual(afterView.rounds, before.rounds);
  assert.deepEqual((await t.api(`${f.base}/drafts`)).body, drafts);
});
