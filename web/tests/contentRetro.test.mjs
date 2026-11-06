import assert from 'node:assert/strict';
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

/** The writing-style retro in the web: pure helpers (lib/contentRetro.ts), the store through the stand-in, and static renders. */

const retro = await import('../src/lib/contentRetro.ts');
const view = await import('../src/lib/contentView.ts');
const { useContentStore } = await import('../src/store/contentStore.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { installServerStub } = await import('./serverStub.mjs');

const NOW = Date.parse('2026-10-26T10:00:00Z');
const ISO = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();
const STYLE = '# Writing style\n\n## General\n\nWrite like you talk.\nOpen with a question.\nAvoid jargon.\n\n## LinkedIn\n\n## Blog\n\nOne heading per topic.\n\n## Video script\n\n- Read it aloud.\n';
const replace = { id: 0, section: 'General', action: 'replace', find: 'Open with a question.', text: 'Open with the result.', reason: 'Every opening was rewritten' };
const add = { id: 1, section: 'Video script', action: 'add', text: '- Short lines.\n- One idea each.', reason: 'Long lines were split' };
const remove = { id: 2, section: 'Blog', action: 'remove', find: 'One heading per topic.', reason: 'Headings were cut' };
const source = (over = {}) => ({ conceptId: 'c1', conceptTitle: 'Launch week', assetId: 'a1', assetKind: 'script', platform: null, format: null, ...over });
const proposal = (over = {}) => ({ id: 'p1', at: ISO(-12), summary: 'Lead with the result.', source: source(), draftCount: 4, roundCount: 2, changes: [replace, add, remove], autoApplyError: null, ...over });

test('WU01 sectionBody: a middle section, the last one, an empty one and a missing one', () => {
  assert.equal(retro.sectionBody(STYLE, 'General'), '\nWrite like you talk.\nOpen with a question.\nAvoid jargon.\n');
  assert.equal(retro.sectionBody(STYLE, 'Video script'), '\n- Read it aloud.\n');
  assert.equal(retro.sectionBody(STYLE, 'LinkedIn'), '');
  assert.equal(retro.sectionBody(STYLE, 'X'), null);
});

test('WU02 a replace diff shows one line of context on each side, − find and + text', () => {
  assert.deepEqual(retro.changeDiff(STYLE, replace), [
    { kind: 'context', text: 'Write like you talk.' }, { kind: 'removed', text: 'Open with a question.' }, { kind: 'added', text: 'Open with the result.' }, { kind: 'context', text: 'Avoid jargon.' },
  ]);
});

test('WU03 an add diff shows the last line and + lines; an empty section says so', () => {
  assert.deepEqual(retro.changeDiff(STYLE, add), [{ kind: 'context', text: '- Read it aloud.' }, { kind: 'added', text: '- Short lines.' }, { kind: 'added', text: '- One idea each.' }]);
  assert.deepEqual(retro.changeDiff(STYLE, { ...add, section: 'LinkedIn' })[0], { kind: 'note', text: 'LinkedIn is empty' });
  assert.deepEqual(retro.changeDiff(STYLE, { ...add, section: 'X' })[0], { kind: 'note', text: 'X is missing from the writing style' });
});

test('WU04/WU06 a remove diff; a find on the first or last line has no context on that side', () => {
  assert.deepEqual(retro.changeDiff(STYLE, remove), [{ kind: 'removed', text: 'One heading per topic.' }]);
  assert.deepEqual(retro.changeDiff(STYLE, { ...replace, find: 'Write like you talk.' })[0], { kind: 'removed', text: 'Write like you talk.' });
  assert.deepEqual(retro.changeDiff(STYLE, { ...remove, section: 'General', find: 'Avoid jargon.' }), [{ kind: 'context', text: 'Open with a question.' }, { kind: 'removed', text: 'Avoid jargon.' }]);
});

test('WU05 a find no longer present gets a note, and replace still shows its text', () => {
  assert.deepEqual(retro.changeDiff(STYLE, { ...remove, find: 'Use H2 headings.' }), [{ kind: 'note', text: '"Use H2 headings." is not in Blog any more' }]);
  assert.equal(retro.changeDiff(STYLE, { ...replace, find: 'Gone.' }).at(-1).kind, 'added');
});

test('WU07 the Accept label counts the ticked changes', () => {
  assert.equal(retro.acceptLabel(3, 3).label, 'Accept 3 changes');
  assert.equal(retro.acceptLabel(1, 1).label, 'Accept 1 change');
  assert.equal(retro.acceptLabel(2, 3).label, 'Accept 2 of 3 changes');
  assert.deepEqual(retro.acceptLabel(0, 3), { label: 'Accept 0 of 3 changes', disabled: true, hint: 'Tick at least one change, or discard the proposal.' });
  assert.equal(retro.acceptLabel(2, 3).hint, null);
});

test('WU08 the badge: hidden at 0, the count, "99+" past 99, and its label', () => {
  assert.deepEqual([0, 1, 99, 100].map(retro.badgeText), [null, '1', '99', '99+']);
  assert.equal(retro.badgeLabel(1), '1 pending proposal');
  assert.equal(retro.badgeLabel(3), '3 pending proposals');
});

test('WU09 the retro status line for every status, and none without a retro', () => {
  const line = (r) => retro.retroStatusLine(r);
  assert.equal(line(null), null);
  assert.equal(line({ status: 'running', at: ISO(0) }).lead, 'Retro running');
  assert.deepEqual([line({ status: 'proposal', changeCount: 3, at: ISO(0) }).lead, line({ status: 'proposal', changeCount: 1, at: ISO(0) }).link], ['Retro: 3 style changes to review', 'proposals']);
  assert.deepEqual([line({ status: 'applied', changeCount: 2, at: ISO(0) }).lead, line({ status: 'applied', at: ISO(0) }).link], ['Retro: 2 style changes applied', 'history']);
  assert.equal(line({ status: 'discarded', at: ISO(0) }).lead, 'Retro: proposal discarded');
  assert.equal(line({ status: 'nothing', at: ISO(0) }).lead, 'Retro: Nothing to learn');
  assert.match(line({ status: 'skipped', at: ISO(0) }).detail, /only draft, unchanged/);
  assert.deepEqual([line({ status: 'failed', reason: 'boom', at: ISO(0) }).lead, line({ status: 'failed', at: ISO(0) }).failed], ['Retro failed: boom', true]);
});

test('WU10 the source line: drafts and rounds, platform and format, or Video script', () => {
  assert.equal(retro.draftsLine(4, 2), 'from 4 drafts in 2 rounds');
  assert.equal(retro.draftsLine(1, 1), 'from 1 draft in 1 round');
  assert.equal(retro.sourcePlatform(source()), 'Video script');
  assert.equal(retro.sourcePlatform(source({ platform: 'linkedin', format: 'text' })), 'LinkedIn · Text');
  assert.equal(retro.sourcePlatform(source({ platform: 'x', format: null })), 'X (Twitter) · ');
});

test('WU11 log rows say failed with the reason, or Nothing to learn; kind labels', () => {
  assert.equal(retro.logRowText({ status: 'failed', reason: 'The agent did not answer within 60 seconds.' }), 'Retro failed: The agent did not answer within 60 seconds.');
  assert.equal(retro.logRowText({ status: 'failed', reason: null }), 'Retro failed: unknown reason');
  assert.equal(retro.logRowText({ status: 'nothing', reason: null }), 'Nothing to learn');
  assert.equal(retro.logRowText({ status: 'skipped', reason: null }), 'Nothing to learn');
  assert.deepEqual(['script', 'post-text', 'article'].map((k) => retro.KIND_LABELS[k]), ['Script', 'Post text', 'Article']);
});

test('WU12 edit validation: find required for replace and remove, text required and at most 2,000', () => {
  assert.deepEqual(retro.editProblems({ action: 'replace', find: '', text: 'x' }), { find: 'Required' });
  assert.deepEqual(retro.editProblems({ action: 'remove', find: '' }), { find: 'Required' });
  assert.deepEqual(retro.editProblems({ action: 'add', text: '' }), { text: 'Required' });
  assert.deepEqual(retro.editProblems({ action: 'add', text: 'a'.repeat(2000) }), {});
  assert.deepEqual(retro.editProblems({ action: 'replace', find: 'f', text: '😀'.repeat(2001) }), { text: 'At most 2,000 characters' });
  assert.equal(retro.charCounter('a'.repeat(2000)), '2,000 of 2,000 characters');
});

test('WU13 the stale message names the change, its action and section', () => {
  const failed = { id: 2, section: 'LinkedIn', action: 'remove', reason: '"…" must occur exactly once in LinkedIn but occurs 2 times' };
  assert.equal(retro.staleMessage(failed, { ...remove, id: 2, section: 'LinkedIn', find: 'End with hashtags.' }), 'Change 3 (Remove from LinkedIn): "End with hashtags." no longer occurs exactly once in LinkedIn');
  assert.equal(retro.staleMessage({ ...failed, reason: 'the writing style would be over 50,000 characters' }, undefined), 'Change 3 (Remove from LinkedIn): the writing style would be over 50,000 characters');
});

test('WU14 the accept body: excluded ids; in Edit only changed fields of kept changes', () => {
  const changes = [replace, add, remove];
  assert.deepEqual(retro.acceptBody(changes, new Set(), null), {});
  assert.deepEqual(retro.acceptBody(changes, new Set([2, 0]), null), { exclude: [0, 2] });
  const edits = { 0: { find: 'Open with a question.', text: 'Lead with the number.' }, 1: { text: add.text }, 2: { find: 'x' } };
  assert.deepEqual(retro.acceptBody(changes, new Set([2]), edits), { exclude: [2], changes: [{ id: 0, text: 'Lead with the number.' }] });
});

test('WU15/WU16 history labels and when Run retro is offered', () => {
  assert.deepEqual(['person', 'agent', 'retro'].map(retro.historyWho), ['Person', 'Agent', 'Retro']);
  assert.equal(retro.canRunRetro('script', 'finalized', false, null), true);
  assert.equal(retro.canRunRetro('article', 'finalized', false, { status: 'failed', at: ISO(0) }), true);
  assert.equal(retro.canRunRetro('post-text', 'finalized', false, { status: 'running', at: ISO(0) }), false);
  assert.equal(retro.canRunRetro('image-set', 'finalized', false, null), false);
  assert.equal(retro.canRunRetro('script', 'drafting', false, null), false);
  assert.equal(retro.canRunRetro('script', 'finalized', true, null), false);
  assert.equal(retro.retroConflictText('post-text'), 'A retro is already running for this post text.');
});

// ---- store, through the daemon stand-in --------------------------------------

const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ conceptsById: {}, studioByAsset: {}, studioBlocked: {}, proposalsByProject: {}, retroLogByProject: {}, staleByProposal: {}, styleRevByProject: {} });
});
const store = () => useContentStore.getState();
const building = () => stub.content.byBuilding.get(B) ?? (contentApi.proposals(B), stub.content.byBuilding.get(B));
async function seed(proposals = [proposal(), proposal({ id: 'p2', summary: 'Second' })]) {
  await contentApi.proposals(B);
  stub.content.byBuilding.get(B).proposals = proposals;
}
const lastRequest = (path) => stub.content.requests.filter((r) => r.path === path).at(-1);

test('WS01/WS08 loading proposals sets the list and badge count; the retro log loads', async () => {
  await seed();
  stub.content.byBuilding.get(B).retroLog = [{ id: 'r1', at: ISO(-1), status: 'failed', reason: 'boom', source: source(), draftCount: 2, roundCount: 1 }];
  assert.equal((await store().loadProposals(B)).ok, true);
  assert.deepEqual(store().proposalsByProject[B].map((p) => p.id), ['p1', 'p2']);
  assert.equal((await store().loadRetroLog(B)).ok, true);
  assert.equal(store().retroLogByProject[B][0].reason, 'boom');
});

test('WS02/WS10 accept removes the proposal and bumps the style revision; a clean editor reloads, a dirty one does not', async () => {
  await seed();
  await store().loadProposals(B);
  assert.equal((await store().acceptProposal(B, 'p1', {})).ok, true);
  assert.deepEqual(store().proposalsByProject[B].map((p) => p.id), ['p2']);
  assert.equal(store().styleRevByProject[B], 1);
  assert.equal(building().history[0].who, 'retro');
  const doc = view.openDoc('v1', 'text');
  assert.equal(view.shouldReloadDoc(doc), true);
  assert.equal(view.shouldReloadDoc(null), true);
  assert.equal(view.shouldReloadDoc(view.editDoc(doc, 'mine')), false);
});

test('WS03/WS04 accept with exclusions sends exclude; edit then apply sends changes', async () => {
  await seed();
  await store().acceptProposal(B, 'p1', { exclude: [2] });
  assert.deepEqual(lastRequest('style-proposals/p1/accept').body, { exclude: [2] });
  await store().acceptProposal(B, 'p2', { changes: [{ id: 0, text: 'Mine' }] });
  assert.deepEqual(lastRequest('style-proposals/p2/accept').body, { changes: [{ id: 0, text: 'Mine' }] });
});

test('WS05 a stale 409 keeps the proposal and exposes the failing changes; a later success clears them', async () => {
  await seed();
  await store().loadProposals(B);
  stub.content.byBuilding.get(B).staleIds = [0];
  const result = await store().acceptProposal(B, 'p1', {});
  assert.deepEqual([result.ok, result.status], [false, 409]);
  assert.deepEqual(store().staleByProposal.p1.map((f) => [f.id, f.section, f.action]), [[0, 'General', 'replace']]);
  assert.equal(store().proposalsByProject[B].length, 2);
  assert.equal((await store().acceptProposal(B, 'p1', { exclude: [0] })).ok, true);
  assert.equal(store().staleByProposal.p1, undefined);
  assert.equal(view.failedChangesFrom(new Error('x')), null);
});

test('WS06 discard removes the proposal; the toast text says how to get a new one', async () => {
  await seed();
  await store().loadProposals(B);
  assert.equal((await store().discardProposal(B, 'p2')).ok, true);
  assert.deepEqual(store().proposalsByProject[B].map((p) => p.id), ['p1']);
  assert.equal((await store().discardProposal(B, 'nope')).status, 404);
  assert.equal(retro.DISCARD_TOAST, 'Proposal discarded. Run retro on the text to get a new one.');
});

test('WS07 Run retro marks the pane running; a second run is 409 in words', async () => {
  const c = await contentApi.createConcept(B, { title: 'T', brief: '', posts: [] });
  const aid = c.assets.find((a) => a.kind === 'script').id;
  await store().openStudio(B, c.id, aid);
  const pane = stub.content.studio.panes.get(aid);
  pane.drafts.push({ round: 1, text: 'draft', savedAt: ISO(0) });
  await store().studioAction(B, c.id, aid, 'finalize');
  assert.equal((await store().runRetro(B, aid, 'script')).ok, true);
  assert.equal(store().studioByAsset[aid].retro.status, 'running');
  const again = await store().runRetro(B, aid, 'script');
  assert.deepEqual([again.ok, again.error], [false, 'A retro is already running for this script.']);
  assert.equal((await store().runRetro(B, 'missing', 'script')).status, 404);
  assert.equal((await store().runRetro(B, c.posts[0]?.id ?? 'none', 'post-text')).ok, false);
});

test('WS09 the settings save sends autoApplyRetro', async () => {
  const saved = await contentApi.saveSettings(B, { autoApplyRetro: true });
  assert.equal(saved.autoApplyRetro, true);
  assert.deepEqual(lastRequest('settings').body, { autoApplyRetro: true });
});

test('WS11 a contentRetro event refetches what is shown; a late older studio view is dropped', async () => {
  await seed([]);
  await store().loadProposals(B);
  await store().loadRetroLog(B);
  stub.content.byBuilding.get(B).proposals = [proposal()];
  useWorldStore.setState({});
  store().applyStudioEvent({ type: 'contentRetro', buildingId: B, conceptId: 'c1', assetId: 'a1' });
  store().applyStudioEvent({ type: 'contentRetro', buildingId: 'unseen', conceptId: 'c1', assetId: 'a1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store().proposalsByProject[B].length, 1);
  assert.equal(store().proposalsByProject.unseen, undefined);
  const base = { conceptId: 'c1', assetId: 'a9', asset: { state: 'finalized', round: 1, finalizedAt: ISO(0), content: 'x' }, session: null, rounds: [], skillWarning: null };
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...base, rev: 5, retro: { status: 'proposal', at: ISO(0) } } });
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...base, rev: 4, retro: { status: 'running', at: ISO(0) } } });
  assert.equal(store().studioByAsset.a9.retro.status, 'proposal');
});

test('WS12 a read-only stand-in refuses with 409 and the store surfaces the error', async () => {
  await seed();
  stub.content.readOnly = true;
  for (const result of [await store().acceptProposal(B, 'p1', {}), await store().discardProposal(B, 'p1'), await store().runRetro(B, 'a1', 'script')]) {
    assert.deepEqual([result.ok, result.status, result.error], [false, 409, 'This Building is read-only.']);
  }
  stub.content.readOnly = false;
});

// ---- static renders ----------------------------------------------------------

const STYLE_TAB = 'src/ui/content/WritingStyleTab.tsx';
const noop = () => {};
const cardProps = (over = {}) => ({ proposal: proposal(), styleContent: STYLE, stale: undefined, readOnly: false, busy: false, onAccept: noop, onDiscard: noop, onOpenConcept: noop, now: NOW, ...over });
const listProps = (over = {}) => ({ proposals: [proposal()], styleContent: STYLE, staleByProposal: {}, readOnly: false, busyId: null, onAccept: noop, onDiscard: noop, onOpenConcept: noop, now: NOW, ...over });

test('C01 the Writing style badge shows the count with its label, nothing at 0, "99+" past 99', async () => {
  assert.match(await render(STYLE_TAB, 'ProposalBadge', { count: 3 }), /aria-label="3 pending proposals"[^>]*>3</);
  assert.equal(await render(STYLE_TAB, 'ProposalBadge', { count: 0 }), '');
  assert.match(await render(STYLE_TAB, 'ProposalBadge', { count: 120 }), />99\+</);
});

test('C02 pending proposals come before the editor', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/ui/content/WritingStyleTab.tsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function WritingStyleTab'));
  assert.ok(body.indexOf('<PendingProposals') < body.indexOf('<VersionedEditor'));
  assert.ok(body.indexOf('<RetroLog') < body.indexOf('<StyleHistory'));
  assert.match(source, /reloadKey=\{styleRev\}/);
});

test('C03 a card: source chips, title link, time, summary, and per change a ticked box, its reason and a labelled diff', async () => {
  const html = await render(STYLE_TAB, 'ProposalCard', cardProps());
  for (const text of ['Script', 'Video script', 'Launch week', 'from 4 drafts in 2 rounds', 'Lead with the result.', 'Every opening was rewritten', 'Replace in General', 'Add to Video script', 'Remove from Blog', 'Accept 3 changes', 'Edit', 'Discard']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/type="checkbox"[^>]*checked=""/g) ?? []).length, 3);
  assert.match(html, /role="group" aria-label="Diff of change 1"/);
  assert.match(html, /<time/);
  assert.match(html, /aria-label="Proposal from Script"/);
});

test('C04 no proposals shows the empty line', async () => {
  assert.match(await render(STYLE_TAB, 'PendingProposals', listProps({ proposals: [] })), /No pending proposals\. The next one appears/);
  assert.match(await render(STYLE_TAB, 'PendingProposals', listProps()), /Pending proposals <span[^>]*>\(1\)/);
});

test('C05 a refused accept shows an alert listing the change and tags it "Can\'t apply"', async () => {
  const stale = [{ id: 0, section: 'General', action: 'replace', reason: 'must occur exactly once in General' }];
  const html = await render(STYLE_TAB, 'ProposalCard', cardProps({ stale }));
  assert.match(html, /role="alert"/);
  assert.ok(html.includes('Change 1 (Replace in General): &quot;Open with a question.&quot; no longer occurs exactly once in General'));
  assert.ok(html.includes('Can&#x27;t apply'));
  assert.doesNotMatch(await render(STYLE_TAB, 'ProposalCard', cardProps()), /role="alert"/);
});

test('C06 an auto-apply refusal says the proposal waits', async () => {
  const html = await render(STYLE_TAB, 'ProposalCard', cardProps({ proposal: proposal({ autoApplyError: '"x" occurs 0 times' }) }));
  assert.match(html, /Auto-apply was refused, so this waits for you\./);
  assert.match(html, /occurs 0 times/);
});

test('C07 Edit mode: labelled find and text fields with a counter, Apply edited changes and Cancel; add has no find field', async () => {
  const html = await render(STYLE_TAB, 'ProposalCard', cardProps({ editing: true }));
  assert.match(html, /<label for="edit-p1-0-find"[^>]*>Find \(must occur exactly once in General\)/);
  assert.match(html, /<label for="edit-p1-0-text"[^>]*>Replace with/);
  assert.match(html, /Text to add at the end of Video script/);
  assert.equal(html.includes('edit-p1-1-find'), false);
  assert.equal(html.includes('edit-p1-2-text'), false);
  assert.match(html, /21 of 2,000 characters/);
  assert.match(html, /Apply edited changes/);
  assert.match(html, /Cancel/);
  const fields = await render(STYLE_TAB, 'ProposalEditFields', { proposal: proposal(), edits: { 0: { find: '' }, 1: { text: 'a'.repeat(2001) } }, disabled: false, onEdit: noop });
  assert.match(fields, /Required/);
  assert.match(fields, /At most 2,000 characters/);
});

test('C08 the retro log: a closed details with its count, rows in words, and an empty state', async () => {
  const entries = [
    { id: 'r1', at: ISO(-60), status: 'failed', reason: 'The agent did not answer within 60 seconds.', source: source({ assetKind: 'post-text', platform: 'x', format: 'text' }), draftCount: 2, roundCount: 1 },
    { id: 'r2', at: ISO(-90), status: 'nothing', reason: null, source: source(), draftCount: 2, roundCount: 1 },
  ];
  const html = await render(STYLE_TAB, 'RetroLog', { entries, onOpenConcept: noop, now: NOW });
  assert.match(html, /^<details[^>]*aria-label="Retro log"/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Retro log \(2\)/);
  assert.match(html, /Retro failed: The agent did not answer within 60 seconds\./);
  assert.match(html, /Nothing to learn/);
  assert.match(html, /X \(Twitter\) · Text/);
  assert.match(await render(STYLE_TAB, 'RetroLog', { entries: [], onOpenConcept: noop }), /No retros yet\./);
});

test('C09 a Retro history row carries the auto-applied tag', async () => {
  const html = await render(STYLE_TAB, 'StyleHistory', { entries: [{ id: 1, at: ISO(-5), who: 'retro', summary: 'Lead with the result. (+1 line)', autoApplied: true }, { id: 2, at: ISO(-9), who: 'person', summary: '+1 line', autoApplied: false }], error: null });
  assert.match(html, /Retro<span[^>]*>auto-applied<\/span>/);
  assert.equal((html.match(/auto-applied/g) ?? []).length, 1);
  assert.match(await render(STYLE_TAB, 'StyleHistory', { entries: [], error: null }), /No changes yet/);
});

test('C10/C11 read-only disables every button and box with the title but keeps the list; nothing ticked disables Accept with the hint', async () => {
  const ro = await render(STYLE_TAB, 'ProposalCard', cardProps({ readOnly: true }));
  assert.match(ro, /Lead with the result\./);
  assert.equal((ro.match(/type="checkbox"[^>]*disabled=""[^>]*title="This Building is read-only"/g) ?? []).length, 3);
  for (const label of ['Accept 3 changes', 'Edit', 'Discard']) assert.match(ro, new RegExp(`<button[^>]*disabled=""[^>]*title="This Building is read-only"[^>]*>${label}<`), label);
  assert.doesNotMatch(ro, /Tick at least one change/, 'no hint on a read-only Building');
  assert.equal(retro.acceptLabel(0, 3).disabled, true);
});

const PANE = 'src/ui/content/StudioPaneView.tsx';
const finalized = (retroStatus = null) => ({
  rev: 1, conceptId: 'c1', assetId: 'a1', asset: { state: 'finalized', round: 1, finalizedAt: ISO(-1), content: 'Final text' },
  session: { id: 's1', conceptId: 'c1', assetId: 'a1', tab: 'script', round: 1, state: 'ended', executorId: 'x', createdAt: ISO(-10), updatedAt: ISO(-10) },
  rounds: [{ round: 1, startedAt: ISO(-10), draft: { text: 'Final text', savedAt: ISO(-2) } }], skillWarning: null, retro: retroStatus,
});
const paneProps = (over = {}) => ({ view: finalized(), blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, renderTerminal: () => 'T', assetKind: 'script', retroError: null, onRunRetro: noop, onOpenStyle: noop, now: NOW, ...over });
const runButton = (html) => html.match(/<button[^>]*>Run retro<\/button>/)?.[0];

test('C12 the finalized pane offers Run retro beside Reopen and a polite status line', async () => {
  const html = await render(PANE, 'StudioPaneView', paneProps({ view: finalized({ status: 'proposal', changeCount: 3, proposalId: 'p1', at: ISO(-1) }) }));
  assert.ok(html.indexOf('>Reopen<') < html.indexOf('>Run retro<'));
  assert.match(html, /role="status" aria-live="polite"[^>]*aria-label="Retro status"/);
  assert.match(html, /Retro: 3 style changes to review/);
  assert.match(html, /Review in Writing style/);
  assert.match(await render(PANE, 'StudioPaneView', paneProps({ view: finalized({ status: 'failed', reason: 'boom', at: ISO(-1) }) })), /Retro failed: boom/);
  assert.match(await render(PANE, 'StudioPaneView', paneProps({ view: finalized({ status: 'applied', changeCount: 1, at: ISO(-1) }) })), /See Writing style history/);
  assert.match(await render(PANE, 'StudioPaneView', paneProps({ retroError: 'A retro is already running for this script.' })), /A retro is already running for this script\./);
  assert.doesNotMatch(await render(PANE, 'StudioPaneView', paneProps({ assetKind: 'video' })), /Run retro/);
});

test('C13 Run retro is disabled while running (with a spinner) and on read-only with the title', async () => {
  const running = await render(PANE, 'StudioPaneView', paneProps({ view: finalized({ status: 'running', at: ISO(0) }) }));
  assert.match(runButton(running), /disabled=""/);
  assert.match(running, /animate-spin[^"]*motion-reduce:animate-none/);
  assert.match(runButton(await render(PANE, 'StudioPaneView', paneProps({ readOnly: true }))), /disabled=""[^>]*title="This Building is read-only"/);
  assert.doesNotMatch(runButton(await render(PANE, 'StudioPaneView', paneProps())), /disabled=""/);
});

test('C14 no Run retro while drafting', async () => {
  const drafting = { ...finalized(), asset: { state: 'drafting', round: 1, finalizedAt: null, content: null }, session: { ...finalized().session, state: 'running' } };
  assert.doesNotMatch(await render(PANE, 'StudioPaneView', paneProps({ view: drafting })), /Run retro|Retro status/);
});

test('C15 the Settings checkbox, its help text and its read-only state', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/ui/content/SettingsTab.tsx', import.meta.url), 'utf8');
  assert.match(source, /type="checkbox" checked=\{autoApply\} disabled=\{disabled\} title=\{disabled \? READ_ONLY_TITLE : undefined\}/);
  assert.match(source, /Apply retro changes without review/);
  assert.match(source, /show in its history as auto-applied/);
  assert.match(source, /autoApplyRetro: autoApply/);
  assert.match(source, /setAutoApply\(loaded\.data\.autoApplyRetro\)/);
});

test('C16 a long Concept title wraps and a long diff scrolls at 14rem', async () => {
  const html = await render(STYLE_TAB, 'ProposalCard', cardProps({ proposal: proposal({ source: source({ conceptTitle: 'T'.repeat(300) }) }) }));
  assert.match(html, /\[overflow-wrap:anywhere\][^>]*data-wrap/);
  assert.match(html, /max-h-\[14rem\] overflow-auto[^>]*data-diff/);
});
