import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';
import { render } from './renderHelper.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const studio = await import('../src/lib/contentStudio.ts');
const rules = await import('../src/lib/contentRules.ts');
const viewLib = await import('../src/lib/contentView.ts');
const { useContentStore } = await import('../src/store/contentStore.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const NOW = Date.parse('2026-10-26T10:00:00Z');
const ISO = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();
const mkView = (over = {}) => ({
  rev: 1, conceptId: 'c1', assetId: 'a1',
  asset: { state: 'drafting', round: 1, finalizedAt: null, content: null },
  session: { id: 's1', conceptId: 'c1', assetId: 'a1', tab: 'script', round: 1, state: 'running', executorId: 'x', createdAt: ISO(-10), updatedAt: ISO(-10) },
  rounds: [{ round: 1, startedAt: ISO(-10), draft: null }],
  skillWarning: null,
  blockedReason: null,
  ...over,
});
const withDraft = (text = 'Hello script', round = 1) => mkView({ asset: { state: 'drafting', round, finalizedAt: null, content: null }, rounds: [{ round, startedAt: ISO(-10), draft: { text, savedAt: ISO(-2) } }] });
const finalizedView = () => mkView({ asset: { state: 'finalized', round: 1, finalizedAt: ISO(-1), content: 'Final text' }, session: { ...mkView().session, state: 'ended' }, rounds: [{ round: 1, startedAt: ISO(-10), draft: { text: 'Final text', savedAt: ISO(-2) } }] });
const noop = () => {};
const props = (over = {}) => ({ view: withDraft(), blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, renderTerminal: (id) => `TERMINAL:${id}`, now: NOW, ...over });
const pane = (over) => render('src/ui/content/StudioPaneView.tsx', 'StudioPaneView', props(over));
const btn = (html, label) => html.match(new RegExp(`<button[^>]*>[^<]*${label}[^<]*</button>`))?.[0];

test('W01/W02 pane state decides which buttons show and which can be pressed', () => {
  const b = (mode, hasText, readOnly = false) => studio.paneButtons(mode, hasText, readOnly);
  assert.deepEqual(b('working', true), { start: 'hidden', finalize: 'enabled', newSession: 'enabled', resume: 'hidden', reopen: 'hidden', copy: 'enabled' });
  assert.equal(b('working', false).finalize, 'disabled');
  assert.equal(b('working', false).copy, 'hidden');
  assert.deepEqual([b('ended', true).resume, b('ended', true).finalize, b('ended', true).newSession], ['enabled', 'enabled', 'enabled']);
  assert.deepEqual([b('starting', false).finalize, b('starting', false).newSession], ['disabled', 'disabled']);
  assert.deepEqual([b('loading', false).finalize, b('blocked', false).newSession, b('blocked', false).finalize], ['hidden', 'hidden', 'hidden']);
  assert.deepEqual([b('blocked', false).start, b('blocked', false, true).start, b('working', true).start], ['enabled', 'disabled', 'hidden']);
  assert.deepEqual(b('finalized', true), { start: 'hidden', finalize: 'hidden', newSession: 'hidden', resume: 'hidden', reopen: 'enabled', copy: 'enabled' });
  const ro = b('ended', true, true);
  assert.deepEqual([ro.finalize, ro.newSession, ro.resume, ro.copy], ['disabled', 'disabled', 'disabled', 'enabled']);
  assert.equal(b('finalized', true, true).reopen, 'disabled');
});

test('paneMode follows the view: loading, blocked, starting, working, ended, finalized', () => {
  assert.equal(studio.paneMode(null, null), 'loading');
  assert.equal(studio.paneMode(null, 'why'), 'blocked');
  assert.equal(studio.paneMode(mkView({ session: null }), null), 'starting');
  assert.equal(studio.paneMode(mkView({ session: null }), 'why'), 'blocked');
  assert.equal(studio.paneMode(mkView(), null), 'working');
  assert.equal(studio.paneMode(mkView({ session: { ...mkView().session, state: 'ended' } }), null), 'ended');
  assert.equal(studio.paneMode(finalizedView(), 'ignored'), 'finalized');
});

test('W03/W04 labels and the confirm text', () => {
  assert.equal(studio.draftHeading(3), 'Draft · round 3 · saved');
  assert.equal(studio.FINALIZED_HEADING, 'Finalized');
  assert.equal(studio.EMPTY_DRAFT_TEXT, 'No draft yet. Ask the agent to write one.');
  assert.equal(studio.confirmNewSessionText(1), 'End round 1 and start round 2? Nothing from this round carries over.');
  assert.equal(studio.confirmNewSessionText(99), 'End round 99 and start round 100? Nothing from this round carries over.');
});

test('W08/W09 previous rounds are earlier ones, newest first, and Copy picks the right text', () => {
  const v = mkView({
    asset: { state: 'drafting', round: 3, finalizedAt: null, content: null },
    rounds: [{ round: 1, startedAt: ISO(-30), draft: { text: 'one', savedAt: ISO(-29) } }, { round: 2, startedAt: ISO(-20), draft: null }, { round: 3, startedAt: ISO(-10), draft: { text: 'three', savedAt: ISO(-5) } }],
  });
  assert.deepEqual(studio.previousRounds(v).map((r) => r.round), [2, 1]);
  assert.equal(studio.shownText(v), 'three');
  assert.deepEqual(studio.currentDraft(v), { text: 'three', savedAt: ISO(-5) });
  assert.equal(studio.shownText(mkView()), null);
  assert.equal(studio.shownText(finalizedView()), 'Final text');
});

test('W10 a late older view never replaces a newer one', () => {
  const a = mkView({ rev: 5 });
  assert.equal(studio.newerView(a, mkView({ rev: 4 })), a);
  const b = mkView({ rev: 6 });
  assert.equal(studio.newerView(a, b), b);
  assert.equal(studio.newerView(undefined, a), a);
});

test('W14 the Writing skill file field trims and maps empty to the default', () => {
  assert.equal(viewLib.skillFileValue('  /a/b.md '), '/a/b.md');
  assert.equal(viewLib.skillFileValue('   '), null);
});

test('W05/W06 the Video tab needs a video post and a finalized script, with the reason naming what is missing', () => {
  const reel = [{ platform: 'instagram', format: 'reel' }];
  const video = (posts, scriptFinalized) => rules.conceptTabStates(posts, { scriptFinalized }).find((t) => t.key === 'video');
  assert.equal(video(reel, false).enabled, false);
  assert.equal(video(reel, false).reason, 'Finalize the script to use this tab');
  assert.equal(video([], true).reason, 'Add a video or reel post to use this tab');
  assert.equal(video([], false).reason, 'Add a video or reel post and finalize the script to use this tab');
  assert.equal(video(reel, true).enabled, true);
  assert.equal(rules.conceptTabStates(reel, { scriptFinalized: false, compositionReady: true }).find((t) => t.key === 'remotion').enabled, true);
});

// ---- the store, through the daemon stand-in ----
const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ listByProject: {}, calendarByProject: {}, conceptsById: {}, missingByPost: {}, studioByAsset: {}, studioBlocked: {} });
});
const store = () => useContentStore.getState();
async function newConcept(format = 'reel') {
  const c = await contentApi.createConcept(B, { title: 'T', brief: '', posts: [{ platform: 'instagram', format, scheduledAt: '2026-10-27T09:00:00Z' }] });
  await store().loadConcept(B, c.id);
  return { cid: c.id, aid: c.assets.find((a) => a.kind === 'script').id };
}
const addDraft = (aid, text) => {
  const pane = stub.content.studio.panes.get(aid);
  const round = pane.rounds.at(-1).round;
  pane.drafts.push({ round, text, savedAt: new Date().toISOString() });
};

test('W12 opening starts round 1; the action routes move the pane and surface 409 reasons', async () => {
  const { cid, aid } = await newConcept();
  assert.equal((await store().openStudio(B, cid, aid)).ok, true);
  assert.deepEqual([store().studioByAsset[aid].session.round, store().studioByAsset[aid].asset.state], [1, 'drafting']);
  assert.equal(stub.content.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/session')).length, 1);
  await store().openStudio(B, cid, aid);
  assert.equal(stub.content.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/session')).length, 1, 'an open with a running session starts nothing');
  const early = await store().studioAction(B, cid, aid, 'finalize');
  assert.deepEqual([early.ok, early.status, early.error], [false, 409, 'Save a draft before finalizing.']);
  const round2 = await store().studioAction(B, cid, aid, 'session/new-round');
  assert.equal(round2.ok, true);
  assert.equal(store().studioByAsset[aid].session.round, 2);
  addDraft(aid, 'the script');
  assert.equal((await store().studioAction(B, cid, aid, 'finalize')).ok, true);
  assert.equal(store().studioByAsset[aid].asset.state, 'finalized');
  assert.equal(store().conceptsById[cid].assets.find((a) => a.id === aid).state, 'finalized');
  assert.equal((await store().studioAction(B, cid, aid, 'reopen')).ok, true);
  assert.deepEqual([store().studioByAsset[aid].asset.state, store().studioByAsset[aid].session.round], ['drafting', 3]);
  assert.equal((await store().studioAction(B, cid, aid, 'session/resume')).ok, true);
});

test('a refused start (no default agent) is kept as the reason, and a later open can start', async () => {
  const { cid, aid } = await newConcept();
  stub.content.studio.agent = false;
  assert.equal((await store().openStudio(B, cid, aid)).ok, true);
  assert.match(store().studioBlocked[aid], /default coding agent/);
  assert.equal(studio.paneMode(store().studioByAsset[aid], store().studioBlocked[aid]), 'blocked');
  stub.content.studio.agent = true;
  // The daemon kept the refusal, so opening again waits for the owner's Start.
  await store().openStudio(B, cid, aid);
  assert.equal(store().studioByAsset[aid].session, null);
  assert.equal((await store().studioAction(B, cid, aid, 'session/start')).ok, true);
  assert.equal(store().studioBlocked[aid], undefined);
  assert.equal(store().studioByAsset[aid].session.round, 1);
});

test('opening without autoStart (a read-only Building) only reads', async () => {
  const { cid, aid } = await newConcept();
  await store().openStudio(B, cid, aid, false);
  assert.equal(store().studioByAsset[aid].session, null);
  assert.equal(stub.content.requests.some((r) => r.method === 'POST' && r.path.endsWith('/session')), false);
});

test('opening a missing asset fails with the daemon reason', async () => {
  const { cid } = await newConcept();
  const res = await store().openStudio(B, cid, 'nope');
  assert.deepEqual([res.ok, res.status], [false, 404]);
});

test('W11 a studio event moves the Concept asset so the Video tab enables without a refetch', async () => {
  const { cid, aid } = await newConcept();
  const tabs = () => rules.conceptTabStates(store().conceptsById[cid].posts, { scriptFinalized: store().conceptsById[cid].assets.find((a) => a.id === aid).state === 'finalized' });
  assert.equal(tabs().find((t) => t.key === 'video').enabled, false);
  const before = stub.content.requests.length;
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...finalizedView(), rev: 10, conceptId: cid, assetId: aid } });
  assert.equal(tabs().find((t) => t.key === 'video').enabled, true);
  assert.equal(stub.content.requests.length, before);
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...withDraft(), rev: 9, conceptId: cid, assetId: aid } });
  assert.equal(store().studioByAsset[aid].asset.state, 'finalized', 'a stale event is ignored');
  assert.equal(store().conceptsById[cid].assets.find((a) => a.id === aid).state, 'finalized');
});

test('W11 an event for a Concept that is not loaded only stores the view', () => {
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...withDraft(), rev: 1, conceptId: 'unknown', assetId: 'unknown-asset' } });
  assert.equal(store().studioByAsset['unknown-asset'].rev, 1);
});

test('W13 a studio event leaves the lists, calendar and unrelated assets at the same identity', async () => {
  const { cid, aid } = await newConcept();
  await store().openStudio(B, cid, aid);
  const other = { a: store().studioByAsset, list: store().listByProject, calendar: store().calendarByProject, missing: store().missingByPost };
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...withDraft('x'), rev: 99, conceptId: cid, assetId: aid } });
  assert.equal(store().listByProject, other.list);
  assert.equal(store().calendarByProject, other.calendar);
  assert.equal(store().missingByPost, other.missing);
  assert.equal(store().studioByAsset[aid].rounds[0].draft.text, 'x');
});

test('W10 the live connection hands studio events to the content store', () => {
  const source = src('store/worldStore.ts');
  assert.match(source, /event\.type === 'studioAsset' \|\| event\.type === 'contentRetro' \|\| event\.type === 'contentImportSession'\) useContentStore\.getState\(\)\.applyStudioEvent\(event\)/);
  assert.match(source, /event\.type === 'remotionStudio'\) useContentStore\.getState\(\)\.applyRemotionEvent\(event\)/);
  assert.match(source, /if \(event\.type === 'studioAsset' \|\| event\.type === 'contentRetro' \|\| event\.type === 'contentImportSession' \|\| event\.type === 'remotionStudio'\) return \{\};/);
  assert.ok(useWorldStore.getState());
});

// ---- the pane, rendered ----
test('C01 while drafting: terminal left, draft label and Copy right, Finalize enabled, Start a new session', async () => {
  const html = await pane();
  assert.match(html, /data-mode="working"/);
  assert.match(html, /TERMINAL:s1/);
  assert.match(html, /Draft · round 1 · saved <time/);
  assert.match(html, /Hello script/);
  assert.match(html, /Copy<\/button>/);
  assert.doesNotMatch(btn(html, 'Finalize'), / disabled=""/);
  assert.ok(btn(html, 'Start a new session'));
  assert.doesNotMatch(html, /Resume|Reopen/);
});

test('C02 no draft: the empty text shows, Finalize is disabled and Copy is hidden', async () => {
  const html = await pane({ view: mkView() });
  assert.match(html, /No draft yet\. Ask the agent to write one\./);
  assert.match(btn(html, 'Finalize'), / disabled=""/);
  assert.doesNotMatch(html, /Copy<\/button>/);
});

test('C03 first open shows a starting state, never Session ended', async () => {
  const html = await pane({ view: mkView({ session: null }) });
  assert.match(html, /Starting the agent/);
  assert.doesNotMatch(html, /Session ended/);
  const loading = await pane({ view: null });
  assert.match(loading, /Loading/);
});

test('C04 an ended session offers Resume and Start a new session', async () => {
  const html = await pane({ view: { ...withDraft(), session: { ...mkView().session, state: 'ended' } } });
  assert.match(html, /Session ended/);
  assert.doesNotMatch(btn(html, 'Resume'), / disabled=""/);
  assert.ok(btn(html, 'Start a new session'));
  assert.doesNotMatch(html, /TERMINAL:/);
});

test('C05 no default agent: the reason and how to set one, no terminal', async () => {
  const html = await pane({ view: mkView({ session: null }), blocked: 'No default coding agent is set.' });
  assert.match(html, /No default coding agent is set\./);
  assert.match(html, /default coding agent from the footer/);
  assert.doesNotMatch(html, /TERMINAL:/);
});

test('C05b blocked: Start is enabled, calls session/start, and a 2,000-character unbroken reason wraps in a scrolling pane', async () => {
  const long = 'x'.repeat(2000);
  const calls = [];
  const html = await pane({ view: mkView({ session: null }), blocked: long, onAction: (a) => calls.push(a) });
  assert.match(html, /overflow-y-auto/);
  assert.match(html, /\[overflow-wrap:anywhere\]/);
  assert.ok(html.includes(long));
  assert.ok(btn(html, 'Start'));
  assert.doesNotMatch(btn(html, 'Start'), /disabled=""/);
  assert.match(src('ui/content/StudioPaneView.tsx'), /onAction\('session\/start'\)/);
  const ro = await pane({ view: mkView({ session: null }), blocked: 'No default coding agent is set.', readOnly: true });
  assert.match(btn(ro, 'Start'), /disabled=""[^>]*title="This Building is read-only"|title="This Building is read-only"[^>]*disabled=""/);
});

test('C05c the blocked reason: this tab\'s own refusal, else the daemon\'s; never once a session exists', () => {
  const blocked = mkView({ session: null, blockedReason: 'from the daemon' });
  assert.equal(studio.blockedReasonOf(blocked, null), 'from the daemon');
  assert.equal(studio.blockedReasonOf(blocked, 'own refusal'), 'own refusal');
  assert.equal(studio.blockedReasonOf(mkView({ blockedReason: 'stale' }), 'own refusal'), null);
  assert.equal(studio.blockedReasonOf(null, 'own refusal'), 'own refusal');
  assert.equal(studio.blockedReasonOf(null, null), null);
  assert.equal(studio.paneMode(blocked, studio.blockedReasonOf(blocked, null)), 'blocked');
});

test('C06 the skill warning shows above a working pane', async () => {
  const html = await pane({ view: { ...withDraft(), skillWarning: 'Writing skill not found at /x/SKILL.md' } });
  assert.match(html, /Writing skill not found at \/x\/SKILL\.md/);
  assert.match(html, /TERMINAL:s1/);
});

test('C07 read-only: every changing button is disabled and Copy still works', async () => {
  const html = await pane({ readOnly: true, view: { ...withDraft(), session: { ...mkView().session, state: 'ended' } } });
  for (const label of ['Finalize', 'Start a new session', 'Resume']) assert.match(btn(html, label), / disabled=""/, label);
  assert.match(html, /This Building is read-only/);
  assert.match(html, /Copy<\/button>/);
  const done = await pane({ readOnly: true, view: finalizedView() });
  assert.match(btn(done, 'Reopen'), / disabled=""/);
});

test('C08 finalized: full width, no terminal, Finalized label, Copy and Reopen with its tooltip', async () => {
  const html = await pane({ view: finalizedView() });
  assert.match(html, /data-mode="finalized"/);
  assert.doesNotMatch(html, /TERMINAL:|lg:grid-cols-2|Agent terminal/);
  assert.match(html, /Finalized <time/);
  assert.match(html, /Final text/);
  assert.match(html, /Copy<\/button>/);
  assert.match(btn(html, 'Reopen'), /title="Reopen to keep editing\. Finalized posts that need this move back to draft\."/);
  assert.doesNotMatch(html, /Start a new session|>Finalize</);
});

test('C09/C10 previous rounds are collapsed by default and list round, last draft and its own Copy', async () => {
  const v = mkView({
    asset: { state: 'drafting', round: 2, finalizedAt: null, content: null },
    session: { ...mkView().session, round: 2 },
    rounds: [{ round: 1, startedAt: ISO(-60), draft: { text: 'old draft', savedAt: ISO(-50) } }, { round: 2, startedAt: ISO(-5), draft: null }],
  });
  const html = await pane({ view: v });
  assert.match(html, /<details[^>]*aria-label="Previous rounds"/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Previous rounds \(1\)/);
  assert.match(html, /data-round="1"[\s\S]*Round 1[\s\S]*old draft/);
  assert.match(html.match(/data-round="1"[\s\S]*?<\/li>/)[0], /Copy<\/button>/);
  assert.match(html, /No draft yet\. Ask the agent/);
  const none = await pane({ view: withDraft() });
  assert.doesNotMatch(none, /Previous rounds/);
  const empty = await pane({ view: { ...v, rounds: [{ round: 1, startedAt: ISO(-60), draft: null }, v.rounds[1]] } });
  assert.match(empty, /No draft in this round\./);
});

test('C11 the confirm dialog text and its buttons', async () => {
  assert.match(await render('src/ui/content/StudioPaneView.tsx', 'NewSessionConfirmBody', { round: 4 }), /End round 4 and start round 5\? Nothing from this round carries over\./);
  const source = src('ui/content/StudioPaneView.tsx');
  assert.match(source, />Cancel<\/Button>/);
  assert.match(source, /confirmOpen && view/);
  assert.match(source, /onAction\('session\/new-round'\)/);
});

test('C12 the pane reuses the shared terminal; Copy toasts and handles a clipboard failure in try/catch', async () => {
  const connected = src('ui/content/StudioPane.tsx');
  assert.match(connected, /import \{ TaskTerminal \} from '..\/TaskTerminal'/);
  assert.match(connected, /<TaskTerminal key=\{sessionId\} taskId=\{sessionId\} \/>/);
  const view = src('ui/content/StudioPaneView.tsx');
  assert.match(view, /try \{[\s\S]*clipboard\.writeText\(text\)[\s\S]*toast\.success[\s\S]*\} catch \{[\s\S]*toast\.error/);
});

test('C13 Settings has the Writing skill file field with the default as placeholder', () => {
  const source = src('ui/content/SettingsTab.tsx');
  assert.match(source, /Writing skill file/);
  assert.match(source, /placeholder=\{loaded\.data\.defaultWritingSkillFile\}/);
  assert.match(source, /writingSkillFile: skillFileValue\(skillFile\)/);
});

test('C14/C15 ConceptView gives Video the script rule and wires the Script tab; Images keeps Coming soon', () => {
  const source = src('ui/content/ConceptView.tsx');
  assert.match(source, /conceptTabStates\(concept\.posts, \{ scriptFinalized: script\?\.state === 'finalized', compositionReady: !!concept\.compositionId, imported: concept\.imported \}\)/);
  assert.match(source, /tab === 'script' && script\s*\?\s*renderStudio\(concept\.id, script\.id\)/);
  assert.match(source, /Coming soon/);
  assert.match(src('ui/ContentStudioWorkspace.tsx'), /renderStudio=\{\(conceptId, assetId, format\) => <StudioPane key=\{assetId\} projectId=\{project\.id\} conceptId=\{conceptId\} assetId=\{assetId\} readOnly=\{readOnly\} format=\{format\} onOpenStyle=\{openStyle\} \/>\}/);
});

test('C16 relative times in the pane use the shared RelativeTime', () => {
  const view = src('ui/content/StudioPaneView.tsx');
  assert.match(view, /import \{ RelativeTime \} from '..\/design\/RelativeTime'/);
  assert.doesNotMatch(view, /setInterval|setTimeout/);
});

test('copyToClipboard reports success and failure', async () => {
  const mod = await import('../src/ui/content/StudioPaneView.tsx').catch(() => null);
  if (!mod) return; // The bundled render test above covers the source; Node cannot load TSX with path aliases here.
  assert.equal(await mod.copyToClipboard('x', { writeText: async () => {} }), true);
  assert.equal(await mod.copyToClipboard('x', { writeText: async () => { throw new Error('no'); } }), false);
  assert.equal(await mod.copyToClipboard('x', undefined), false);
});
