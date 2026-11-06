import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { ContentCtx } from '../src/content/context.ts';
import type { Retros } from '../src/content/retros.ts';
import type { StudioEvent, StudioSessions } from '../src/content/studioSessions.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/**
 * The writing-style retro end to end (content/retros.ts, the routes in api/contentRoutes.ts): the trigger after a
 * finalize, the log, proposals and their accept/discard, auto-apply and read-only. The agent is a fake that can be
 * held at a latch; the terminal host is fake and every file lives in a temp folder.
 */

type AgentInput = { buildingId: string; prompt: string; instructions: string };
let t: ContentApi;
let service: StudioSessions;
let retros: Retros;
let home: string;
let token: string;
let behave: (input: AgentInput) => Promise<string>;
const calls: AgentInput[] = [];
const events: StudioEvent[] = [];
const fakeAgent = { run: (input: AgentInput) => { calls.push(input); return behave(input); } };
let mod: {
  createRetros: typeof import('../src/content/retros.ts').createRetros;
  createRetroAgent: typeof import('../src/content/retroAgent.ts').createRetroAgent;
  contentCtx: typeof import('../src/content/runtime.ts').contentCtx;
  insertDraft: typeof import('../src/content/studioDrafts.ts').insertDraft;
  setAssetState: typeof import('../src/content/concepts.ts').setAssetState;
  readMeta: typeof import('../src/content/db.ts').readMeta;
  versionOf: typeof import('../src/content/files.ts').versionOf;
  rememberSecret: typeof import('../src/redaction.ts').rememberSecret;
};

const CHANGE = { section: 'Video script', action: 'add', text: 'Open with the result.', reason: 'The owner moved the result to the first line' };
const answerOf = (changes: unknown[] = [CHANGE], summary = 'Shorter hooks') => JSON.stringify({ summary, changes });
const STYLE = '# Writing style\n\n## General\n\nBe plain.\nNo jargon.\n\n## LinkedIn\n\n## Instagram\n\n## X\n\n## Facebook\n\n## Blog\n\nLong form.\n\n## Video script\n\nHook first.\n';
const REPLACE = { section: 'General', action: 'replace', find: 'Be plain.', text: 'Be clear.', reason: 'The owner rewrote the opening' };

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'retro-home-'));
  t = await startContentApi(async () => {
    const [sessions, r, agent, runtime, drafts, concepts, db, files, redaction] = await Promise.all([
      import('../src/content/studioSessions.ts'), import('../src/content/retros.ts'), import('../src/content/retroAgent.ts'), import('../src/content/runtime.ts'),
      import('../src/content/studioDrafts.ts'), import('../src/content/concepts.ts'), import('../src/content/db.ts'), import('../src/content/files.ts'), import('../src/redaction.ts'),
    ]);
    mod = {
      createRetros: r.createRetros, createRetroAgent: agent.createRetroAgent, contentCtx: runtime.contentCtx, insertDraft: drafts.insertDraft,
      setAssetState: concepts.setAssetState, readMeta: db.readMeta, versionOf: files.versionOf, rememberSecret: redaction.rememberSecret,
    };
    token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
    retros = r.createRetros({ agent: fakeAgent, home });
    service = sessions.createStudioSessions({ host: fakeTerminalHost().host, defaultAgentId: async () => 'test-claude-cli', home, retros });
    service.onEvent((e) => events.push(e));
    return { studioSessions: service };
  });
});
after(async () => { await service.settled(); await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => { behave = async () => answerOf(); });

function hold() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}
/** Waits for every running retro to be recorded and for the views it publishes. */
async function settle(r: Retros = retros): Promise<void> {
  await r.settled();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

interface Fixture { b: string; cid: string; script: string; postText: string; article: string; imageSet: string; video: string; base: string }
async function fixture(): Promise<Fixture> {
  const b = await t.createStudio('Acme');
  const posts = [
    { platform: 'linkedin', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' },
    { platform: 'blog', format: 'article', scheduledAt: '2026-11-04T09:00:00Z' },
    { platform: 'instagram', format: 'image', scheduledAt: '2026-11-05T09:00:00Z' },
  ];
  const c = (await t.send('POST', t.c(b, '/concepts'), { title: 'Launch week', brief: 'Why now', posts })).body;
  const needs = c.posts.flatMap((p: any) => p.needs);
  const id = (kind: string) => (c.assets.find((a: any) => a.kind === kind) ?? needs.find((a: any) => a.kind === kind)).id;
  const script = id('script');
  return { b, cid: c.id, script, postText: id('post-text'), article: id('article'), imageSet: id('image-set'), video: id('video'), base: t.c(b, `/concepts/${c.id}/assets/${script}`) };
}
const ctxOf = async (b: string): Promise<ContentCtx> => mod.contentCtx((await t.projectsDb.get(b))!);
const saveDraft = (sessionId: string, text: string) => t.api(`/api/studio-session/draft?taskId=${sessionId}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });

/** Drafts the script through its session (one round) and finalizes it. */
async function finalizeScript(f: Fixture, drafts: string[]) {
  const session = (await t.send('POST', `${f.base}/session`)).body.session.id;
  for (const d of drafts) assert.equal((await saveDraft(session, d)).status, 200);
  return t.send('POST', `${f.base}/finalize`);
}
/** A text tab without a pane yet: drafts and finalize written directly, then the shared finalized hook (D1). */
async function finalizeDirect(f: Fixture, assetId: string, drafts: Array<[number, string]>, finalized: string): Promise<void> {
  const ctx = await ctxOf(f.b);
  for (const [round, text] of drafts) mod.insertDraft(ctx, assetId, round, text);
  mod.setAssetState(ctx, assetId, 'finalized', finalized);
  retros.assetFinalized(ctx, assetId);
}
async function setStyle(b: string, content: string): Promise<void> {
  const { version } = (await t.api(t.c(b, '/writing-style'))).body;
  assert.equal((await t.send('PUT', t.c(b, '/writing-style'), { content, version })).status, 200);
}
const styleFile = (b: string) => path.join(t.dataDir, 'buildings', b, 'knowledge', 'writing-style.md');
const proposals = async (b: string) => (await t.api(t.c(b, '/style-proposals'))).body.proposals as any[];
const log = async (b: string) => (await t.api(t.c(b, '/retros'))).body.entries as any[];
const history = async (b: string) => (await t.api(t.c(b, '/writing-style/history'))).body.entries as any[];
const studioRetro = async (f: Fixture) => (await t.api(`${f.base}/session`)).body.retro;
const accept = (b: string, id: string, body?: unknown) => t.send('POST', t.c(b, `/style-proposals/${id}/accept`), body);
const runRetro = (b: string, aid: string) => t.send('POST', t.c(b, `/assets/${aid}/retro`), {});

/** A Building whose writing style has text to replace, with one pending proposal replacing "Be plain." and adding to Video script. */
async function withProposal(changes: unknown[] = [REPLACE, CHANGE]) {
  const f = await fixture();
  await setStyle(f.b, STYLE);
  behave = async () => answerOf(changes);
  await finalizeScript(f, ['draft one', 'draft two']);
  await settle();
  const [proposal] = await proposals(f.b);
  assert.ok(proposal);
  return { f, proposal };
}

test('I01 finalizing a script answers while the agent is still held, then a proposal appears with reasons', async () => {
  const f = await fixture();
  const h = hold();
  behave = async () => { await h.gate; return answerOf(); };
  const res = await finalizeScript(f, ['draft one', 'draft two']);
  assert.equal(res.status, 200);
  assert.equal(res.body.asset.state, 'finalized');
  assert.equal(res.body.retro.status, 'running');
  assert.equal((await studioRetro(f)).status, 'running');
  assert.deepEqual(await proposals(f.b), []);
  h.release();
  await settle();
  const [p] = await proposals(f.b);
  assert.equal(p.summary, 'Shorter hooks');
  assert.deepEqual(p.changes, [{ id: 0, ...CHANGE }]);
  const retro = await studioRetro(f);
  assert.deepEqual([retro.status, retro.proposalId, retro.changeCount], ['proposal', p.id, 1]);
});

test('I02/I03 a finalized post text and a finalized article run a retro through the shared hook', async () => {
  const f = await fixture();
  await finalizeDirect(f, f.postText, [[1, 'post v1'], [1, 'post v2']], 'post final');
  await finalizeDirect(f, f.article, [[1, 'article v1']], 'article final');
  await settle();
  const sources = (await proposals(f.b)).map((p) => [p.source.assetKind, p.source.platform, p.source.format]);
  assert.deepEqual(sources.sort(), [['article', 'blog', 'article'], ['post-text', 'linkedin', 'text']]);
  assert.ok(calls.some((c) => c.prompt.startsWith('What was written: LinkedIn · text') && c.prompt.includes('post v2')));
});

test('I04 a finalized image set or video runs no retro and writes no log row', async () => {
  const f = await fixture();
  const before = calls.length;
  await finalizeDirect(f, f.imageSet, [[1, 'x']], 'y');
  await finalizeDirect(f, f.video, [[1, 'x']], 'y');
  await settle();
  assert.equal(calls.length, before);
  assert.deepEqual(await log(f.b), []);
  assert.deepEqual(await proposals(f.b), []);
});

test('I05 one draft equal to the finalized text is logged as skipped without an agent call', async () => {
  const f = await fixture();
  const before = calls.length;
  await finalizeScript(f, ['Same text']);
  await settle();
  assert.equal(calls.length, before);
  const [entry] = await log(f.b);
  assert.deepEqual([entry.status, entry.reason, entry.draftCount, entry.roundCount], ['skipped', null, 1, 1]);
  assert.equal((await studioRetro(f)).status, 'skipped');
});

test('I06 an empty change list is logged as nothing to learn, never as a proposal', async () => {
  const f = await fixture();
  behave = async () => answerOf([]);
  await finalizeScript(f, ['a', 'b']);
  await settle();
  assert.deepEqual((await log(f.b)).map((e) => e.status), ['nothing']);
  assert.deepEqual(await proposals(f.b), []);
});

test('I07 a fenced answer is logged as failed and is not retried by itself', async () => {
  const f = await fixture();
  behave = async () => `\`\`\`json\n${answerOf()}\n\`\`\``;
  const before = calls.length;
  await finalizeScript(f, ['a', 'b']);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, before + 1);
  const [entry] = await log(f.b);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.reason, 'The answer was not the expected JSON (it is wrapped in a code fence).');
  assert.deepEqual(await proposals(f.b), []);
  const retro = await studioRetro(f);
  assert.deepEqual([retro.status, retro.reason], ['failed', entry.reason]);
});

test('I08 with no agent available the retro fails and the finalize still succeeds', async () => {
  const f = await fixture();
  const noAgent = mod.createRetroAgent({ selectExecutor: async () => null, runTurn: async () => { throw new Error('never'); } });
  behave = (input) => noAgent.run(input);
  assert.equal((await finalizeScript(f, ['a', 'b'])).status, 200);
  await settle();
  assert.match((await log(f.b))[0].reason, /^No agent is available/);
});

test('I09 an agent that never answers fails after the timeout', async () => {
  const f = await fixture();
  const quick = mod.createRetros({ agent: { run: () => new Promise<string>(() => undefined) }, timeoutMs: 10, home });
  await finalizeDirect(f, f.postText, [[1, 'a'], [1, 'b']], 'c');
  await settle();
  quick.run(await ctxOf(f.b), f.postText);
  await settle(quick);
  assert.equal((await log(f.b))[0].reason, 'The agent did not answer within 60 seconds.');
});

test('I10 an agent that throws at once leaves the finalize unaffected', async () => {
  const f = await fixture();
  behave = () => { throw new Error('boom'); };
  assert.equal((await finalizeScript(f, ['a', 'b'])).status, 200);
  await settle();
  assert.equal((await log(f.b))[0].reason, 'boom');
});

test('I11 Run retro answers 202 at once and retries after a failed retro', async () => {
  const f = await fixture();
  behave = async () => 'not json';
  await finalizeScript(f, ['a', 'b']);
  await settle();
  assert.equal((await log(f.b))[0].status, 'failed');
  behave = async () => answerOf();
  const res = await runRetro(f.b, f.script);
  assert.deepEqual([res.status, res.body], [202, { status: 'running' }]);
  await settle();
  assert.equal((await proposals(f.b)).length, 1);
});

test('I12 Run retro while one is running is 409', async () => {
  const f = await fixture();
  const h = hold();
  behave = async () => { await h.gate; return answerOf(); };
  await finalizeScript(f, ['a', 'b']);
  const res = await runRetro(f.b, f.script);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already running/);
  h.release();
  await settle();
});

test('I13 Run retro: 409 on a drafting, empty or media asset; 404 for unknown ids or another Building type', async () => {
  const f = await fixture();
  await t.send('POST', `${f.base}/session`);
  assert.equal((await runRetro(f.b, f.script)).status, 409, 'drafting');
  assert.equal((await runRetro(f.b, f.postText)).status, 409, 'empty');
  const ctx = await ctxOf(f.b);
  mod.setAssetState(ctx, f.imageSet, 'finalized', 'x');
  assert.match((await runRetro(f.b, f.imageSet)).body.error, /only on a script, a post text or an article/);
  assert.equal((await runRetro(f.b, '11111111-1111-4111-8111-111111111111')).status, 404);
  assert.equal((await runRetro(f.b, 'not-a-uuid')).status, 404);
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  assert.equal((await t.send('POST', `/api/projects/${seo.body.id}/content/assets/${f.script}/retro`, {})).status, 404);
  assert.equal((await t.api(`/api/projects/${seo.body.id}/content/style-proposals`)).status, 404);
});

test('I14/I15 pending proposals newest first with every field, no folder path or session id; the writing style carries them', async () => {
  const f = await fixture();
  await finalizeScript(f, ['a', 'b']);
  await settle();
  await finalizeDirect(f, f.postText, [[1, 'p1'], [2, 'p2']], 'p3');
  await settle();
  const res = await t.api(t.c(f.b, '/style-proposals'));
  const [newest, older] = res.body.proposals;
  assert.equal(newest.source.assetKind, 'post-text');
  assert.equal(older.source.assetKind, 'script');
  assert.deepEqual(Object.keys(newest).sort(), ['at', 'autoApplyError', 'changes', 'draftCount', 'id', 'roundCount', 'source', 'summary']);
  assert.deepEqual(newest.source, { kind: 'asset', conceptId: f.cid, conceptTitle: 'Launch week', assetId: f.postText, assetKind: 'post-text', platform: 'linkedin', format: 'text' });
  assert.deepEqual([newest.draftCount, newest.roundCount, older.source.platform, older.source.format], [2, 2, null, null]);
  const sessions = (await t.api(`${f.base}/session`)).body;
  for (const secret of [t.dataDir, sessions.session.id]) assert.equal(res.text.includes(secret), false, secret);
  const style = (await t.api(t.c(f.b, '/writing-style'))).body;
  assert.deepEqual(style.proposals, res.body.proposals);
});

test('I16 Accept applies every change, logs a Retro history entry and records the new version', async () => {
  const { f, proposal } = await withProposal();
  const res = await accept(f.b, proposal.id);
  assert.equal(res.status, 200);
  const content = await readFile(styleFile(f.b), 'utf8');
  assert.equal(res.body.content, content);
  assert.ok(content.includes('\nBe clear.\nNo jargon.\n'));
  assert.ok(content.endsWith('Hook first.\nOpen with the result.\n'));
  assert.deepEqual(res.body.proposals, []);
  assert.deepEqual(await proposals(f.b), []);
  const [entry] = await history(f.b);
  assert.deepEqual([entry.who, entry.autoApplied, entry.summary], ['retro', false, 'Shorter hooks (+2 lines, -1 line)']);
  assert.equal(mod.readMeta((await ctxOf(f.b)).db, 'style_version'), mod.versionOf(content));
  assert.equal((await studioRetro(f)).status, 'applied');
  assert.deepEqual(await log(f.b), []);
});

test('I17/I18 Accept with exclusions applies only the rest; edited changes apply what the owner wrote', async () => {
  const one = await withProposal();
  assert.equal((await accept(one.f.b, one.proposal.id, { exclude: [0] })).status, 200);
  const kept = await readFile(styleFile(one.f.b), 'utf8');
  assert.ok(kept.includes('Be plain.') && kept.includes('Open with the result.'));
  const two = await withProposal();
  assert.equal((await accept(two.f.b, two.proposal.id, { changes: [{ id: 0, text: 'Be very clear.' }] })).status, 200);
  assert.ok((await readFile(styleFile(two.f.b), 'utf8')).includes('\nBe very clear.\n'));
});

test('I19 bad accept bodies are 400 with the field, and nothing is applied', async () => {
  const { f, proposal } = await withProposal();
  const cases: Array<[unknown, string]> = [
    [{ exclude: 'all' }, 'exclude'], [{ exclude: [-1] }, 'exclude'], [{ exclude: [1.5] }, 'exclude'], [{ exclude: ['1'] }, 'exclude'], [{ exclude: [2 ** 53] }, 'exclude'],
    [{ exclude: [7] }, 'exclude'], [{ exclude: [0, 1] }, 'exclude'], [{ changes: [{ id: 1, text: 'a'.repeat(2001) }] }, 'changes'],
    [{ changes: [{ id: 0, find: '' }] }, 'changes'], [{ changes: [{ id: 1, find: 'Hook first.' }] }, 'changes'], [{ changes: [{ id: 4, text: 'x' }] }, 'changes'],
  ];
  const before = await readFile(styleFile(f.b), 'utf8');
  for (const [body, field] of cases) {
    const res = await accept(f.b, proposal.id, body);
    assert.deepEqual([res.status, res.body.field], [400, field], JSON.stringify(body));
  }
  assert.equal((await t.api(t.c(f.b, `/style-proposals/${proposal.id}/accept`), { method: 'POST', body: '[1]' })).status, 400);
  assert.equal(await readFile(styleFile(f.b), 'utf8'), before);
  assert.equal((await proposals(f.b)).length, 1);
});

test('I20 a find made stale on disk is 409 with the failing changes, writes nothing, and the rest can still be accepted', async () => {
  const { f, proposal } = await withProposal();
  const stale = STYLE.replace('No jargon.', 'Be plain.');
  await writeFile(styleFile(f.b), stale);
  const res = await accept(f.b, proposal.id);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'content-conflict');
  assert.deepEqual(res.body.details.failed, [{ id: 0, section: 'General', action: 'replace', reason: '"Be plain." must occur exactly once in General but occurs 2 times' }]);
  assert.equal(await readFile(styleFile(f.b), 'utf8'), stale);
  assert.equal((await proposals(f.b)).length, 1);
  assert.equal((await accept(f.b, proposal.id, { exclude: [0] })).status, 200);
});

test('I21 a stale change fixed by an edited find applies', async () => {
  const { f, proposal } = await withProposal();
  await writeFile(styleFile(f.b), STYLE.replace('Be plain.', 'Be simple.'));
  assert.equal((await accept(f.b, proposal.id)).status, 409);
  assert.equal((await accept(f.b, proposal.id, { changes: [{ id: 0, find: 'Be simple.' }] })).status, 200);
  assert.ok((await readFile(styleFile(f.b), 'utf8')).includes('\nBe clear.\n'));
});

test('I22 an agent edit on disk before an accept is logged before the Retro entry', async () => {
  const { f, proposal } = await withProposal();
  await writeFile(styleFile(f.b), STYLE.replace('Long form.', 'Long form, with headings.'));
  assert.equal((await accept(f.b, proposal.id)).status, 200);
  const [retro, agent] = await history(f.b);
  assert.deepEqual([retro.who, agent.who, agent.summary], ['retro', 'agent', 'Edited on disk']);
  assert.ok((await readFile(styleFile(f.b), 'utf8')).includes('Long form, with headings.'));
});

test('I23 an apply that would pass 50,000 characters is 409 with every change listed', async () => {
  const f = await fixture();
  await setStyle(f.b, STYLE.replace('Long form.', 'x'.repeat(49_000)));
  behave = async () => answerOf([{ ...CHANGE, text: 'y'.repeat(2000) }, { ...CHANGE, section: 'Blog', text: 'z' }]);
  await finalizeScript(f, ['a', 'b']);
  await settle();
  const [p] = await proposals(f.b);
  const res = await accept(f.b, p.id);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.details.failed.map((x: any) => x.id), [0, 1]);
  assert.match(res.body.details.failed[0].reason, /over 50,000 characters/);
});

test('I24 Discard removes it from pending and the log; a second discard or an accept is 409; unknown ids 404', async () => {
  const { f, proposal } = await withProposal();
  const before = await readFile(styleFile(f.b), 'utf8');
  const res = await t.send('POST', t.c(f.b, `/style-proposals/${proposal.id}/discard`), {});
  assert.deepEqual([res.status, res.body], [200, { proposals: [] }]);
  assert.deepEqual(await proposals(f.b), []);
  assert.deepEqual(await log(f.b), []);
  assert.equal(await readFile(styleFile(f.b), 'utf8'), before);
  assert.equal((await studioRetro(f)).status, 'discarded');
  assert.match((await t.send('POST', t.c(f.b, `/style-proposals/${proposal.id}/discard`), {})).body.error, /already discarded/);
  assert.equal((await accept(f.b, proposal.id)).status, 409);
  assert.equal((await t.send('POST', t.c(f.b, '/style-proposals/11111111-1111-4111-8111-111111111111/discard'), {})).status, 404);
  assert.equal((await accept(f.b, 'nope')).status, 404);
});

test('I25 two accepts at once: one applies, the other is 409, and the document changes once', async () => {
  const { f, proposal } = await withProposal();
  const results = await Promise.all([accept(f.b, proposal.id), accept(f.b, proposal.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await history(f.b)).filter((e) => e.who === 'retro').length, 1);
  assert.equal((await readFile(styleFile(f.b), 'utf8')).split('Open with the result.').length, 2);
});

test('I26/ST01 with auto-apply on, a valid proposal applies at once and is marked auto-applied', async () => {
  const f = await fixture();
  await setStyle(f.b, STYLE);
  assert.equal((await t.api(t.c(f.b, '/settings'))).body.autoApplyRetro, false);
  assert.equal((await t.send('PATCH', t.c(f.b, '/settings'), { autoApplyRetro: true })).body.autoApplyRetro, true);
  behave = async () => answerOf([REPLACE]);
  await finalizeScript(f, ['a', 'b']);
  await settle();
  assert.deepEqual(await proposals(f.b), []);
  const [entry] = await history(f.b);
  assert.deepEqual([entry.who, entry.autoApplied], ['retro', true]);
  assert.ok((await readFile(styleFile(f.b), 'utf8')).includes('Be clear.'));
  assert.equal((await studioRetro(f)).status, 'applied');
});

test('I27 an auto-apply refused by an edit made while the agent ran stays pending with the reason', async () => {
  const f = await fixture();
  await setStyle(f.b, STYLE);
  await t.send('PATCH', t.c(f.b, '/settings'), { autoApplyRetro: true });
  const h = hold();
  behave = async () => { await h.gate; return answerOf([REPLACE]); };
  await finalizeScript(f, ['a', 'b']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(styleFile(f.b), STYLE.replace('Be plain.', 'Be simple.'));
  h.release();
  await settle();
  const [p] = await proposals(f.b);
  assert.match(p.autoApplyError, /occurs 0 times/);
  assert.equal((await studioRetro(f)).status, 'proposal');
});

test('ST02/I28 the setting saves true and false; any other value is 400 and saves nothing', async () => {
  const f = await fixture();
  const url = t.c(f.b, '/settings');
  await t.send('PATCH', url, { autoApplyRetro: true });
  for (const bad of ['true', 1, null]) {
    const res = await t.send('PATCH', url, { autoApplyRetro: bad, name: 'Changed' });
    assert.deepEqual([res.status, res.body.field], [400, 'autoApplyRetro']);
  }
  const now = (await t.api(url)).body;
  assert.deepEqual([now.autoApplyRetro, now.name], [true, 'Acme']);
  assert.equal((await t.send('PATCH', url, { autoApplyRetro: false })).body.autoApplyRetro, false);
});

test('I29 a read-only Building refuses run, accept, discard and the setting, keeps every read, and starts nothing', async () => {
  const { f, proposal } = await withProposal();
  await t.projectsDb.update(f.b, { readOnlyReason: 'Migration failed for the test' });
  const before = calls.length;
  assert.equal((await runRetro(f.b, f.script)).status, 409);
  assert.equal((await accept(f.b, proposal.id)).status, 409);
  assert.equal((await t.send('POST', t.c(f.b, `/style-proposals/${proposal.id}/discard`), {})).status, 409);
  assert.equal((await t.send('PATCH', t.c(f.b, '/settings'), { autoApplyRetro: true })).status, 409);
  for (const route of ['/retros', '/style-proposals', '/writing-style', '/writing-style/history', '/settings']) assert.equal((await t.api(t.c(f.b, route))).status, 200, route);
  await settle();
  assert.equal(calls.length, before);
  await t.projectsDb.update(f.b, { readOnlyReason: undefined });
});

test('I30 the log keeps the newest 50, newest first', async () => {
  const f = await fixture();
  behave = async () => 'nope';
  await finalizeScript(f, ['a', 'b']);
  await settle();
  for (let i = 0; i < 50; i++) { assert.equal((await runRetro(f.b, f.script)).status, 202); await settle(); }
  const entries = await log(f.b);
  assert.equal(entries.length, 50);
  assert.deepEqual(entries.map((e) => e.at), entries.map((e) => e.at).sort().reverse());
});

test('I31 the log lists only failed, nothing and skipped retros', async () => {
  const { f, proposal } = await withProposal();
  await accept(f.b, proposal.id);
  behave = async () => answerOf();
  await runRetro(f.b, f.script);
  await settle();
  behave = async () => answerOf([]);
  await runRetro(f.b, f.script);
  await settle();
  assert.deepEqual((await log(f.b)).map((e) => e.status), ['nothing']);
});

test('I32 a secret never reaches the agent\'s prompt or the logged reason', async () => {
  const secret = 'sk-retro-api-SECRET-777';
  mod.rememberSecret(secret);
  const f = await fixture();
  behave = async () => { throw new Error(`upstream said ${secret}`); };
  await finalizeScript(f, [`uses ${secret}`, 'second']);
  await settle();
  assert.equal(calls.at(-1)!.prompt.includes(secret), false);
  assert.ok(calls.at(-1)!.prompt.includes('[secret]'));
  const text = (await t.api(t.c(f.b, '/retros'))).text;
  assert.equal(text.includes(secret), false);
  assert.ok(text.includes('upstream said [secret]'));
});

test('I33 deleting a Concept removes its proposals and log rows, and a retro running for it records nothing', async () => {
  const { f } = await withProposal();
  assert.equal((await t.send('DELETE', t.c(f.b, `/concepts/${f.cid}`))).status, 204);
  assert.deepEqual(await proposals(f.b), []);
  const g = await fixture();
  const h = hold();
  behave = async () => { await h.gate; return answerOf(); };
  await finalizeScript(g, ['a', 'b']);
  assert.equal((await t.send('DELETE', t.c(g.b, `/concepts/${g.cid}`))).status, 204);
  h.release();
  await settle();
  assert.deepEqual(await proposals(g.b), []);
  assert.deepEqual(await log(g.b), []);
});

test('I34 reopening during a running retro: the retro still completes and is recorded', async () => {
  const f = await fixture();
  const h = hold();
  behave = async () => { await h.gate; return answerOf(); };
  await finalizeScript(f, ['a', 'b']);
  assert.equal((await t.send('POST', `${f.base}/reopen`)).status, 200);
  h.release();
  await settle();
  assert.equal((await proposals(f.b)).length, 1);
});

test('I35 after a restart a retro that was running is not recorded, and Run retro is allowed again', async () => {
  const f = await fixture();
  behave = async () => answerOf([]);
  await finalizeScript(f, ['a', 'b']);
  await settle();
  const h = hold();
  behave = async () => { await h.gate; return answerOf(); };
  await runRetro(f.b, f.script);
  // A new service stands in for the restarted daemon: it never saw the running retro.
  const restarted = mod.createRetros({ agent: { run: async () => answerOf([]) }, home });
  const ctx = await ctxOf(f.b);
  assert.equal(restarted.statusOf(ctx, f.script)!.status, 'nothing');
  assert.deepEqual(restarted.run(ctx, f.script), { status: 'running' });
  await settle(restarted);
  assert.equal(restarted.statusOf(ctx, f.postText), null);
  h.release();
  await settle();
});

test('I36 when a retro ends, a contentRetro event and a studio view with its status are sent', async () => {
  const f = await fixture();
  await finalizeScript(f, ['a', 'b']);
  events.length = 0;
  await settle();
  assert.ok(events.some((e) => e.type === 'contentRetro' && e.buildingId === f.b && e.assetId === f.script && e.conceptId === f.cid));
  const view = events.find((e) => e.type === 'studioAsset' && e.view.assetId === f.script);
  assert.ok(view && view.type === 'studioAsset' && view.view.retro?.status === 'proposal');
  events.length = 0;
  await finalizeDirect(f, f.postText, [[1, 'a'], [1, 'b']], 'c');
  await settle();
  // Other assets may still publish views of their own automatic starts.
  assert.deepEqual(events.filter((e) => (e.assetId ?? e.view?.assetId) === f.postText).map((e) => e.type), ['contentRetro'], 'an asset without a pane gets no studio view');
});

test('I37/SP05 the prompt has every round\'s drafts in order and no folder path or ids; the skill is included when its file exists', async () => {
  const skill = path.join(home, '.claude', 'skills', 'human-content-writing-skill', 'SKILL.md');
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, 'DEFAULT-SKILL-TEXT');
  const f = await fixture();
  const session = (await t.send('POST', `${f.base}/session`)).body.session;
  await saveDraft(session.id, 'round one draft');
  const next = (await t.send('POST', `${f.base}/session/new-round`)).body.session;
  await saveDraft(next.id, 'round two draft');
  await t.send('POST', `${f.base}/finalize`);
  await settle();
  const { prompt, instructions } = calls.at(-1)!;
  assert.ok(prompt.indexOf('### Draft 1 (round 1)\n\nround one draft') < prompt.indexOf('### Draft 2 (round 2)\n\nround two draft'));
  assert.ok(prompt.startsWith('What was written: Video script'));
  assert.ok(instructions.includes('DEFAULT-SKILL-TEXT'));
  for (const hidden of [t.dataDir, session.id, next.id, f.b]) assert.equal(prompt.includes(hidden) || instructions.includes(hidden), false, hidden);
  await rm(skill);
  await runRetro(f.b, f.script);
  await settle();
  assert.equal(calls.at(-1)!.instructions.includes('## Writing skill'), false);
});

test('I38 the skill file named in Settings is the one read', async () => {
  const f = await fixture();
  const custom = path.join(home, 'custom-skill.md');
  await writeFile(custom, 'CUSTOM-SKILL-TEXT');
  assert.equal((await t.send('PATCH', t.c(f.b, '/settings'), { writingSkillFile: custom })).status, 200);
  await finalizeScript(f, ['a', 'b']);
  await settle();
  assert.ok(calls.at(-1)!.instructions.includes('CUSTOM-SKILL-TEXT'));
});

test('I39 while the agent is held, a writing-style save and a draft save go through', async () => {
  const f = await fixture();
  const h = hold();
  behave = async () => { await h.gate; return answerOf(); };
  await finalizeScript(f, ['a', 'b']);
  const { version } = (await t.api(t.c(f.b, '/writing-style'))).body;
  assert.equal((await t.send('PUT', t.c(f.b, '/writing-style'), { content: STYLE, version })).status, 200);
  const g = await fixture();
  const session = (await t.send('POST', `${g.base}/session`)).body.session.id;
  assert.equal((await saveDraft(session, 'while held')).status, 200);
  h.release();
  await settle();
});

test('I40 deleting the Building while its retro runs writes nothing and crashes nothing', async () => {
  const f = await fixture();
  const h = hold();
  behave = async () => { await h.gate; return answerOf(); };
  await finalizeScript(f, ['a', 'b']);
  assert.equal((await t.send('DELETE', `/api/projects/${f.b}`)).status, 204);
  h.release();
  await settle();
  assert.equal((await t.api(t.c(f.b, '/retros'))).status, 404);
});

test('I49 the retro instructions carry the targets of the Concept\'s platforms and the Insights text, named by a relative path', async () => {
  const f = await fixture();
  assert.equal((await t.send('PUT', t.c(f.b, '/targets/linkedin'), { likes: 77 })).status, 200);
  await finalizeScript(f, ['draft one', 'draft two']);
  await settle();
  const { instructions } = calls.at(-1)!;
  assert.match(instructions, /LinkedIn: likes at least 77/);
  assert.match(instructions, /Instagram: no targets set/);
  assert.ok(instructions.includes('knowledge/insights.md is the Insights document'));
  assert.ok(instructions.includes('Read the Insights before proposing anything. Prefer what works, avoid what does not, and say which insight a choice follows.'));
  assert.equal(instructions.includes(t.dataDir), false);
  assert.match(instructions, /The Insights document, as it is now:/);
});
