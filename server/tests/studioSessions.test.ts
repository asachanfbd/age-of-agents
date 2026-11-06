import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { WebSocket } from 'ws';
import type { StudioSessions } from '../src/content/studioSessions.ts';
import type { TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/**
 * Content Studio writing sessions (content/studioSessions.ts): rounds, finalize/reopen, the session's own tools,
 * the skill file and restart behaviour. The terminal host is fake and every file lives in a temp folder.
 */

let t: ContentApi;
let terminal: ReturnType<typeof fakeTerminalHost>;
let service: StudioSessions;
let home: string;
let token: string;
let defaultAgent: string | null = 'test-claude-cli';
let lostConversation = false;
let studioDb: typeof import('../src/db/collections.ts').studioSessionsDb;
const events: any[] = [];

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'studio-home-'));
  t = await startContentApi(async () => {
    const mod = await import('../src/content/studioSessions.ts');
    studioDb = (await import('../src/db/collections.ts')).studioSessionsDb;
    token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
    terminal = fakeTerminalHost();
    const { createRetros } = await import('../src/content/retros.ts');
    service = mod.createStudioSessions({
      // Every finalize starts a retro; this one never reaches a real agent.
      retros: createRetros({ agent: { run: async () => '{"summary":"Nothing","changes":[]}' }, home }),
      host: { ...terminal.host, sessionExists: () => !lostConversation },
      defaultAgentId: async () => defaultAgent,
      home,
    });
    service.onEvent((e) => events.push(e));
    return { studioSessions: service };
  });
});
after(async () => { await service.settled(); await t.stop(); await rm(home, { recursive: true, force: true }); });
beforeEach(() => { defaultAgent = 'test-claude-cli'; lostConversation = false; });

const SKILL = 'SKILL-TEXT-é😀 write like a human';
async function writeSkill(text = SKILL): Promise<string> {
  const file = path.join(home, '.claude', 'skills', 'human-content-writing-skill', 'SKILL.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

interface Fixture { b: string; cid: string; aid: string; base: string; videoAid: string }
async function fixture(posts: unknown[] = [{ platform: 'instagram', format: 'reel', scheduledAt: '2026-11-03T09:00:00Z' }]): Promise<Fixture> {
  const b = await t.createStudio('Acme');
  const c = await t.send('POST', t.c(b, '/concepts'), { title: 'Launch "week"', brief: '**Big** news', posts });
  const aid = c.body.assets.find((a: any) => a.kind === 'script').id;
  const videoAid = c.body.assets.find((a: any) => a.kind === 'video').id;
  return { b, cid: c.body.id, aid, videoAid, base: t.c(b, `/concepts/${c.body.id}/assets/${aid}`) };
}
const startsFor = (id: string): TerminalSessionStart[] => terminal.starts.filter((s) => s.taskId === id);
const lastStart = (): TerminalSessionStart => terminal.starts[terminal.starts.length - 1]!;
const tool = (method: string, route: string, sessionId: string | undefined, body?: unknown, auth = token) => t.api(`/api/studio-session${route}${sessionId ? `?taskId=${sessionId}` : ''}`, {
  method, headers: auth ? { authorization: `Bearer ${auth}` } : {}, body: body === undefined ? undefined : JSON.stringify(body),
});
const saveDraft = (sessionId: string, text: unknown) => tool('POST', '/draft', sessionId, { text });

test('I01/I02/I11 first open starts round 1 with the default agent in the Concept folder, auto permissions, no hooks, and the asset becomes drafting', async () => {
  const f = await fixture();
  const res = await t.send('POST', `${f.base}/session`);
  assert.equal(res.status, 201);
  const start = lastStart();
  assert.equal(start.kind, 'claude-cli');
  assert.equal(start.autonomy, 'auto');
  assert.equal(start.reportHooks, false);
  assert.equal(start.cwd, path.join(t.dataDir, 'buildings', f.b, 'concepts', f.cid));
  assert.equal(start.resume, false);
  assert.match(start.prompt, /first draft of the script/);
  assert.deepEqual(start.mcpServers!.map((s) => [s.name, s.tools]), [['agent_visual_os_studio', ['save_draft', 'get_concept', 'get_performance', 'get_reference_content']]]);
  assert.equal(res.body.session.round, 1);
  assert.equal(res.body.session.state, 'running');
  assert.equal(res.body.asset.state, 'drafting');
  assert.equal((await t.api(t.c(f.b, `/concepts/${f.cid}`))).body.assets.find((a: any) => a.id === f.aid).state, 'drafting');
  assert.equal((await t.api('/api/tasks')).text.includes(res.body.session.id), false);
});

test('I03/I04 no default agent, or one that is not a CLI agent, is 409 with a reason and starts nothing', async () => {
  const f = await fixture();
  const before = terminal.starts.length;
  defaultAgent = null;
  const none = await t.send('POST', `${f.base}/session`);
  assert.equal(none.status, 409);
  assert.match(none.body.error, /default coding agent/);
  defaultAgent = 'test-unsupported';
  const bad = await t.send('POST', `${f.base}/session`);
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /cannot run an interactive terminal/);
  defaultAgent = 'missing-agent';
  assert.equal((await t.send('POST', `${f.base}/session`)).status, 409);
  assert.equal(terminal.starts.length, before);
  assert.equal((await t.api(`${f.base}/session`)).body.session, null);
});

test('I05/I42 a second start is 409, and two simultaneous starts give one 201 and one 409', async () => {
  const f = await fixture();
  const [x, y] = await Promise.all([t.send('POST', `${f.base}/session`), t.send('POST', `${f.base}/session`)]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  assert.match((await t.send('POST', `${f.base}/session`)).body.error, /already running/);
});

test('I06/I23/I39 a finalized asset cannot start, start a new round or resume', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  await saveDraft(id, 'final');
  assert.equal((await t.send('POST', `${f.base}/finalize`)).status, 200);
  for (const suffix of ['/session', '/session/new-round', '/session/resume']) assert.equal((await t.send('POST', `${f.base}${suffix}`)).status, 409, suffix);
});

test('I07/I09 unknown or malformed ids are 404, and a Building of another type is 404', async () => {
  const f = await fixture();
  const uuid = '11111111-1111-4111-8111-111111111111';
  assert.equal((await t.send('POST', t.c(f.b, `/concepts/${uuid}/assets/${uuid}/session`))).status, 404);
  assert.equal((await t.send('POST', t.c(f.b, `/concepts/${f.cid}/assets/${uuid}/session`))).status, 404);
  assert.equal((await t.api(t.c(f.b, `/concepts/${f.cid}/assets/..%2Fx/session`))).status, 404);
  assert.equal((await t.api(t.c(f.b, `/concepts/not-a-uuid/assets/${f.aid}/drafts`))).status, 404);
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  assert.equal((await t.api(`/api/projects/${seo.body.id}/content/concepts/${f.cid}/assets/${f.aid}/session`)).status, 404);
});

test('I08 a read-only Building answers 409 on every POST and 200 on reads, and starts nothing', async () => {
  const f = await fixture();
  await t.projectsDb.update(f.b, { readOnlyReason: 'Migration failed for the test' });
  const before = terminal.starts.length;
  for (const suffix of ['/session', '/session/new-round', '/session/resume', '/finalize', '/reopen']) assert.equal((await t.send('POST', `${f.base}${suffix}`)).status, 409, suffix);
  assert.equal(terminal.starts.length, before);
  assert.equal((await t.api(`${f.base}/session`)).status, 200);
  assert.equal((await t.api(`${f.base}/drafts`)).status, 200);
});

test('I10/I12/I25 the session view shows rounds, each save_draft keeps history and the newest wins', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  assert.equal((await saveDraft(id, '  first  ')).status, 200);
  const second = await saveDraft(id, 'second');
  assert.equal(second.body.round, 1);
  const view = (await t.api(`${f.base}/session`)).body;
  assert.equal(view.rounds[0].draft.text, 'second');
  const drafts = (await t.api(`${f.base}/drafts`)).body;
  assert.deepEqual(drafts.rounds.map((r: any) => [r.round, r.drafts.map((d: any) => d.text)]), [[1, ['first', 'second']]]);
});

test('I13/I14/I15/I16/I17 the tool routes: 401 bad token, 400 no id, 404 unknown, 409 ended or finalized, 400 bad text', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  assert.equal((await tool('POST', '/draft', id, { text: 'x' }, 'wrong')).status, 401);
  assert.equal((await tool('POST', '/draft', id, { text: 'x' }, '')).status, 401);
  assert.equal((await tool('POST', '/draft', undefined, { text: 'x' })).status, 400);
  assert.equal((await saveDraft('00000000-0000-4000-8000-000000000000', 'x')).status, 404);
  assert.equal((await tool('GET', '/concept', '00000000-0000-4000-8000-000000000000')).status, 404);
  for (const bad of ['', '   ', ' \n', undefined, null, 5, ['a'], 'x'.repeat(50_001)]) assert.equal((await saveDraft(id, bad)).status, 400, String(bad).slice(0, 10));
  assert.equal((await t.api(`/api/studio-session/draft?taskId=${id}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '[1]' })).status, 400);
  await saveDraft(id, 'ok');
  await t.send('POST', `${f.base}/finalize`);
  assert.equal((await saveDraft(id, 'late')).status, 409);
  assert.equal((await tool('GET', '/concept', id)).status, 409);
  const f2 = await fixture();
  const id2 = (await t.send('POST', `${f2.base}/session`)).body.session.id;
  terminal.live.delete(id2);
  assert.equal((await saveDraft(id2, 'x')).status, 409);
});

test('U01-U06 save_draft counts code points after trim and stores the trimmed text', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  assert.equal((await saveDraft(id, 'a'.repeat(50_000))).status, 200);
  assert.equal((await saveDraft(id, 'a'.repeat(50_001))).status, 400);
  assert.equal((await saveDraft(id, '😀'.repeat(50_000))).status, 200);
  assert.equal((await saveDraft(id, '😀'.repeat(50_001))).status, 400);
  assert.equal((await saveDraft(id, `${' '.repeat(10)}${'b'.repeat(50_000)}${' '.repeat(10)}`)).status, 200);
  const drafts = (await t.api(`${f.base}/drafts`)).body.rounds[0].drafts;
  assert.equal(drafts[2].text, 'b'.repeat(50_000));
  assert.equal([...drafts[1].text].length, 50_000);
});

test('I18/I19 get_concept returns the Concept, posts and asset states, and a session cannot reach another Concept', async () => {
  const f = await fixture();
  const other = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  const concept = (await tool('GET', '/concept', id)).body;
  assert.equal(concept.id, f.cid);
  assert.equal(concept.posts[0].format, 'reel');
  assert.equal(concept.assets.find((a: any) => a.kind === 'script').state, 'drafting');
  await saveDraft(id, 'mine');
  assert.deepEqual((await t.api(`${other.base}/drafts`)).body.rounds, []);
});

test('I21/I22 a new round ends the session, starts round 2 with nothing from round 1, and keeps earlier drafts', async () => {
  const f = await fixture();
  const first = (await t.send('POST', `${f.base}/session`)).body.session.id;
  await saveDraft(first, 'round one draft');
  const res = await t.send('POST', `${f.base}/session/new-round`);
  assert.equal(res.status, 200);
  assert.equal(res.body.session.round, 2);
  assert.notEqual(res.body.session.id, first);
  assert.ok(terminal.stops.includes(first));
  assert.equal(startsFor(res.body.session.id)[0]!.systemPrompt.includes('round one draft'), false);
  assert.match(startsFor(res.body.session.id)[0]!.prompt, /first draft of the script/);
  assert.equal(res.body.rounds.find((r: any) => r.round === 2).draft, null);
  assert.equal(res.body.rounds.find((r: any) => r.round === 1).draft.text, 'round one draft');
  assert.equal(res.body.asset.round, 2);
  terminal.live.delete(res.body.session.id);
  const again = await t.send('POST', `${f.base}/session/new-round`);
  assert.equal(again.body.session.round, 3);
});

test('I24 a new round without a default agent is 409 and leaves round N untouched', async () => {
  const f = await fixture();
  const first = (await t.send('POST', `${f.base}/session`)).body.session.id;
  defaultAgent = null;
  assert.equal((await t.send('POST', `${f.base}/session/new-round`)).status, 409);
  const view = (await t.api(`${f.base}/session`)).body;
  assert.deepEqual([view.session.id, view.session.round, view.session.state], [first, 1, 'running']);
  assert.equal(terminal.stops.includes(first), false);
});

test('new round before the first session is 409', async () => {
  const f = await fixture();
  assert.equal((await t.send('POST', `${f.base}/session/new-round`)).status, 409);
});

test('I26-I29 finalize needs a draft, finalizes with the newest draft, ends the session, and works once', async () => {
  const f = await fixture();
  assert.equal((await t.send('POST', `${f.base}/finalize`)).status, 409);
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  assert.equal((await t.send('POST', `${f.base}/finalize`)).status, 409);
  await saveDraft(id, 'one');
  await saveDraft(id, 'two');
  events.length = 0;
  const res = await t.send('POST', `${f.base}/finalize`);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.asset.state, res.body.asset.content, res.body.session.state], ['finalized', 'two', 'ended']);
  assert.ok(res.body.asset.finalizedAt);
  assert.ok(terminal.stops.includes(id));
  assert.ok(events.some((e) => e.view.asset.state === 'finalized'));
  assert.equal((await t.send('POST', `${f.base}/finalize`)).status, 409);
  // Finalize with an already ended session and a draft.
  const g = await fixture();
  const gid = (await t.send('POST', `${g.base}/session`)).body.session.id;
  await saveDraft(gid, 'kept');
  terminal.live.delete(gid);
  assert.equal((await t.send('POST', `${g.base}/finalize`)).status, 200);
});

// The ordering guarantee is the Building's write queue (`ctx.exclusive`): draft saves, finalize and starts run one at a time,
// so firing the calls together can only produce one of the two legal outcomes asserted below.
test('I30 save_draft against finalize: the finalized text is the draft that was current, a later save is 409', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  await saveDraft(id, 'base');
  const [fin, save] = await Promise.all([t.send('POST', `${f.base}/finalize`), saveDraft(id, 'racing')]);
  assert.equal(fin.status, 200);
  const view = (await t.api(`${f.base}/session`)).body;
  const drafts = (await t.api(`${f.base}/drafts`)).body.rounds[0].drafts.map((d: any) => d.text);
  assert.equal(view.asset.content, save.status === 200 ? 'racing' : 'base');
  if (save.status !== 200) { assert.equal(save.status, 409); assert.deepEqual(drafts, ['base']); }
});

test('I31-I34 reopen needs a finalized asset, starts round N+1 seeded with the text, and demotes finalized posts that need it', async () => {
  const f = await fixture();
  assert.equal((await t.send('POST', `${f.base}/reopen`)).status, 409);
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  await saveDraft(id, 'the script');
  await t.send('POST', `${f.base}/finalize`);
  const res = await t.send('POST', `${f.base}/reopen`);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.asset.state, res.body.session.round, res.body.session.state], ['drafting', 2, 'running']);
  assert.equal(res.body.asset.content, null);
  assert.match(startsFor(res.body.session.id)[0]!.systemPrompt, /start from it:\n\nthe script/);
  assert.equal(startsFor(res.body.session.id)[0]!.prompt, '');
  assert.equal(res.body.rounds.find((r: any) => r.round === 2).draft, null);
});

test('I33/I34 reopening a script moves back only finalized posts that need it', async () => {
  const f = await fixture([
    { platform: 'linkedin', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' },
  ]);
  // The script is never needed by a post, so a finalized post stays finalized when the script is reopened.
  const post = (await t.api(t.c(f.b, `/concepts/${f.cid}`))).body.posts[0];
  const text = post.needs[0];
  const { setAssetState } = await import('../src/content/concepts.ts');
  const { contentCtx } = await import('../src/content/runtime.ts');
  const ctx = contentCtx((await t.projectsDb.get(f.b))!);
  setAssetState(ctx, text.id, 'finalized', 'post text');
  assert.equal((await t.send('POST', t.c(f.b, `/concepts/${f.cid}/posts/${post.id}/finalize`))).status, 200);
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  await saveDraft(id, 's');
  await t.send('POST', `${f.base}/finalize`);
  await t.send('POST', `${f.base}/reopen`);
  assert.equal((await t.api(t.c(f.b, `/concepts/${f.cid}`))).body.posts[0].status, 'finalized');
});

test('I35-I39 resume: a live session starts nothing, an ended one relaunches the same conversation, a lost one restarts with the last draft', async () => {
  const f = await fixture();
  assert.equal((await t.send('POST', `${f.base}/session/resume`)).status, 404);
  const started = (await t.send('POST', `${f.base}/session`)).body.session;
  const count = terminal.starts.length;
  assert.equal((await t.send('POST', `${f.base}/session/resume`)).status, 200);
  assert.equal(terminal.starts.length, count);
  await saveDraft(started.id, 'last words');
  terminal.live.delete(started.id);
  const res = await t.send('POST', `${f.base}/session/resume`);
  assert.equal(res.body.session.state, 'running');
  const relaunch = lastStart();
  assert.deepEqual([relaunch.resume, relaunch.sessionId], [true, startsFor(started.id)[0]!.sessionId]);
  assert.equal(relaunch.systemPrompt.includes('last words'), false);
  assert.equal(relaunch.prompt, '');
  terminal.live.delete(started.id);
  lostConversation = true;
  await t.send('POST', `${f.base}/session/resume`);
  const fresh = lastStart();
  assert.equal(fresh.resume, false);
  assert.notEqual(fresh.sessionId, relaunch.sessionId);
  assert.match(fresh.systemPrompt, /latest saved draft was:\n\nlast words/);
  assert.equal(fresh.prompt, '');
  // No draft: fresh start without context.
  const g = await fixture();
  const gid = (await t.send('POST', `${g.base}/session`)).body.session.id;
  terminal.live.delete(gid);
  await t.send('POST', `${g.base}/session/resume`);
  assert.equal(lastStart().systemPrompt.includes('latest saved draft'), false);
  assert.match(lastStart().prompt, /first draft of the script/);
});

test('a start on a round whose session ended says to resume or start anew', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  terminal.live.delete(id);
  const res = await t.send('POST', `${f.base}/session`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Resume/);
});

test('I40/I41 an exit marks the session ended with an event, and a restart marks running ones ended', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  events.length = 0;
  startsFor(id)[0]!.onExit(0, undefined, 'agent-id');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await studioDb.get(id))!.state, 'ended');
  assert.equal((await studioDb.get(id))!.agentSessionId, 'agent-id');
  assert.ok(events.some((e) => e.view.session?.state === 'ended'));
  const g = await fixture();
  const gid = (await t.send('POST', `${g.base}/session`)).body.session.id;
  terminal.live.delete(gid);
  await service.markInterruptedEnded();
  assert.equal((await studioDb.get(gid))!.state, 'ended');
  const view = (await t.api(`${g.base}/session`)).body;
  assert.deepEqual([view.session.state, view.asset.state], ['ended', 'drafting']);
});

test('onSessionId stores the discovered conversation id without an event', async () => {
  defaultAgent = 'test-codex-cli';
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  assert.equal(startsFor(id)[0]!.kind, 'codex-cli');
  assert.equal(startsFor(id)[0]!.sessionId, null);
  events.length = 0;
  startsFor(id)[0]!.onSessionId!('codex-conv');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await studioDb.get(id))!.agentSessionId, 'codex-conv');
  assert.equal(events.length, 0);
});

test('I43/I44 deleting a Concept or the Building ends its sessions and removes their records', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  assert.equal((await t.send('DELETE', t.c(f.b, `/concepts/${f.cid}`))).status, 204);
  assert.equal(await studioDb.get(id), undefined);
  assert.ok(terminal.stops.includes(id));
  const g = await fixture();
  const gid = (await t.send('POST', `${g.base}/session`)).body.session.id;
  assert.equal((await t.send('DELETE', `/api/projects/${g.b}`)).status, 204);
  assert.equal(await studioDb.get(gid), undefined);
});

test('I45/I46 the instructions carry the skill text and paths for both CLIs, and a missing skill warns without blocking', async () => {
  const f = await fixture();
  const file = path.join(home, '.claude', 'skills', 'human-content-writing-skill', 'SKILL.md');
  const missing = (await t.send('POST', `${f.base}/session`)).body;
  assert.equal(missing.skillWarning, `Writing skill not found at ${file}`);
  assert.equal(missing.session.state, 'running');
  assert.equal(startsFor(missing.session.id)[0]!.systemPrompt.includes('Writing skill'), false);

  await writeSkill();
  const prompts: string[] = [];
  for (const agent of ['test-claude-cli', 'test-codex-cli']) {
    defaultAgent = agent;
    const g = await fixture();
    const res = (await t.send('POST', `${g.base}/session`)).body;
    assert.equal(res.skillWarning, null);
    prompts.push(startsFor(res.session.id)[0]!.systemPrompt);
    const p = prompts.at(-1)!;
    assert.ok(p.includes(SKILL));
    assert.ok(p.includes(path.join(t.dataDir, 'buildings', g.b, 'knowledge')));
    assert.ok(p.includes('writing-style.md'));
    assert.ok(p.includes('"Video script"'));
    assert.ok(p.includes('Launch "week"') && p.includes('**Big** news'));
    assert.ok(p.includes('Instagram, reel, scheduled 2026-11-03T09:00:00.000Z'));
    assert.ok(p.includes('save_draft'));
    assert.match(p, /length, the hook or the call to action/);
  }
  assert.equal(prompts[0]!.replace(/knowledge/g, '').length > 0, true);
  // A Building override wins over the default; a directory counts as missing.
  const dir = path.join(home, 'a-folder');
  await mkdir(dir, { recursive: true });
  const custom = path.join(home, 'custom.md');
  await writeFile(custom, 'CUSTOM-SKILL');
  const h = await fixture();
  assert.equal((await t.send('PATCH', t.c(h.b, '/settings'), { writingSkillFile: custom })).status, 200);
  const res = (await t.send('POST', `${h.base}/session`)).body;
  assert.match(startsFor(res.session.id)[0]!.systemPrompt, /CUSTOM-SKILL/);
  assert.equal(startsFor(res.session.id)[0]!.systemPrompt.includes(SKILL), false);
});

test('I46 the writingSkillFile setting validates, persists, trims and clears', async () => {
  const b = await t.createStudio('Settings');
  const url = t.c(b, '/settings');
  const file = path.join(home, 'skill-setting.md');
  await writeFile(file, 'x');
  const initial = (await t.api(url)).body;
  assert.equal(initial.writingSkillFile, null);
  assert.ok(initial.defaultWritingSkillFile.endsWith(path.join('human-content-writing-skill', 'SKILL.md')));
  const folder = path.join(home, 'a-folder');
  await mkdir(folder, { recursive: true });
  for (const bad of ['relative/x.md', '~/x.md', path.join(home, 'nope.md'), folder, `${file}\0`, 5, `/${'a'.repeat(4096)}`]) {
    const res = await t.send('PATCH', url, { writingSkillFile: bad });
    assert.deepEqual([res.status, res.body.field], [400, 'writingSkillFile'], String(bad).slice(0, 30));
  }
  assert.equal((await t.api(url)).body.writingSkillFile, null);
  const ok = await t.send('PATCH', url, { writingSkillFile: `  ${file}  ` });
  assert.equal(ok.body.writingSkillFile, file);
  assert.equal((await t.api(url)).body.writingSkillFile, file);
  assert.equal((await t.send('PATCH', url, { writingSkillFile: '' })).body.writingSkillFile, null);
  await t.send('PATCH', url, { writingSkillFile: file });
  assert.equal((await t.send('PATCH', url, { writingSkillFile: null })).body.writingSkillFile, null);
  assert.equal((await t.send('PATCH', url, { name: 'Renamed' })).body.writingSkillFile, null);
});

test('U21/I47 the DTO and every event carry only the allowed keys and no secret value', async () => {
  const f = await fixture();
  events.length = 0;
  const res = await t.send('POST', `${f.base}/session`);
  const record = (await studioDb.get(res.body.session.id))!;
  const keys = ['assetId', 'conceptId', 'createdAt', 'executorId', 'id', 'round', 'state', 'tab', 'updatedAt'];
  assert.deepEqual(Object.keys(res.body.session).sort(), keys);
  await saveDraft(record.id, 'hello');
  await t.send('POST', `${f.base}/finalize`);
  await t.send('POST', `${f.base}/reopen`);
  const wire = JSON.stringify([res.body, events, (await t.api(`${f.base}/session`)).body, (await t.api(`${f.base}/drafts`)).body]);
  for (const secret of [record.agentSessionId!, token, path.join(t.dataDir, 'buildings'), record.setup.systemPrompt.slice(0, 40)]) assert.equal(wire.includes(secret), false, secret.slice(0, 20));
  assert.ok(events.length >= 4);
  assert.ok(events.every((e) => (e.type === 'studioAsset' || e.type === 'contentRetro') && e.buildingId === f.b));
});

test('I50 the Concept shows the script state that feeds the Video tab rule', async () => {
  const f = await fixture();
  const state = async () => (await t.api(t.c(f.b, `/concepts/${f.cid}`))).body.assets.find((a: any) => a.kind === 'script').state;
  assert.equal(await state(), 'empty');
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  assert.equal(await state(), 'drafting');
  await saveDraft(id, 'x');
  await t.send('POST', `${f.base}/finalize`);
  assert.equal(await state(), 'finalized');
});

/** The first frame the `/terminal` socket sends for a session id, then its close. */
const terminalReply = (id: string): Promise<{ type: string; message?: string }> => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${t.baseUrl.replace('http', 'ws')}/terminal?taskId=${id}`);
  socket.on('message', (raw) => { resolve(JSON.parse(raw.toString())); socket.close(); });
  socket.on('error', reject);
});

test('I48 the /terminal socket accepts a studio session id as a session, and refuses an unknown id as a Task', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  // The real terminal host has no process for the fake one, so a known studio session reaches the attach step.
  assert.match((await terminalReply(id)).message!, /no longer available/);
  assert.doesNotMatch((await terminalReply('00000000-0000-4000-8000-000000000000')).message!, /no longer available/);
});

test('a resumed fresh restart keeps the round context in the stored setup, so a second resume still has it', async () => {
  const f = await fixture();
  const id = (await t.send('POST', `${f.base}/session`)).body.session.id;
  await saveDraft(id, 'context draft');
  lostConversation = true;
  terminal.live.delete(id);
  await t.send('POST', `${f.base}/session/resume`);
  terminal.live.delete(id);
  await t.send('POST', `${f.base}/session/resume`);
  assert.match(lastStart().systemPrompt, /context draft/);
  assert.equal((await studioDb.get(id))!.setup.systemPrompt.includes('context draft'), true);
});

test('a view built after a daemon restart outranks every earlier view (rev starts from the clock)', async () => {
  const f = await fixture();
  const view = (await t.send('POST', `${f.base}/session`)).body;
  assert.ok(view.rev > Date.now() * 1000 - 3_600_000_000);
  assert.ok((await t.api(`${f.base}/session`)).body.rev > view.rev);
});

test('a save from a session of an older round is 409 saying the round ended', async () => {
  const f = await fixture();
  const first = (await t.send('POST', `${f.base}/session`)).body.session.id;
  await t.send('POST', `${f.base}/session/new-round`);
  terminal.live.add(first);
  await studioDb.update(first, { state: 'running' });
  const res = await saveDraft(first, 'late');
  assert.deepEqual([res.status, res.body.error], [409, 'This round has ended']);
});
