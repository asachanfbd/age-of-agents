import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';
import { loadModule, render } from './renderHelper.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

/** Line comments on the Script tab's draft: the pure helpers (WU), the API and store (WS) and the Result pane markup (C). */

const C = await import('../src/lib/scriptComments.ts');
const { READ_ONLY_TITLE } = await import('../src/lib/contentView.ts');
const serverComments = await import('../../server/src/content/studioComments.ts');
const serverLimits = await import('../../server/src/content/limits.ts');
const { useContentStore } = await import('../src/store/contentStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CONTENT_ROUTES } = await import('./contentStudioStub.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const NOW = Date.parse('2026-10-26T10:00:00Z');
const ISO = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();

// ---- WU: pure helpers ----

test('WU1 draftLines numbers lines exactly like the daemon on LF, CRLF and CR', () => {
  for (const text of ['a\n\nb\nc', 'a\r\n\r\nb\r\nc', 'a\r\rb\rc', 'single', '\nlead and trail\n']) {
    assert.deepEqual(C.draftLines(text).map((l) => l.text), serverComments.splitDraftLines(text), JSON.stringify(text));
    assert.deepEqual(C.draftLines(text).map((l) => l.n), serverComments.splitDraftLines(text).map((_, i) => i + 1));
  }
});

test('WU2 only non-blank lines take comments', () => {
  assert.deepEqual(C.draftLines('a\n\n   \nb').map((l) => l.commentable), [true, false, false, true]);
});

test('WU3 the web cap is the daemon cap', () => {
  assert.equal(C.COMMENT_MAX_CHARS, serverLimits.COMMENT_MAX_CHARS);
});

test('WU4 commentProblem: empty, at the cap, over it, and emoji counted once', () => {
  assert.equal(C.commentProblem(''), 'empty');
  assert.equal(C.commentProblem('   '), 'empty');
  assert.equal(C.commentProblem('a'.repeat(2000)), null);
  assert.equal(C.commentProblem('a'.repeat(2001)), 'Keep the comment to 2,000 characters.');
  assert.equal(C.commentProblem('😀'.repeat(2000)), null);
});

test('WU5 the counter text and over flag', () => {
  assert.deepEqual(C.commentCounter(''), { text: '0 / 2,000', over: false });
  assert.deepEqual(C.commentCounter('a'.repeat(2001)), { text: '2,001 / 2,000', over: true });
});

const S0 = () => C.initialComments('d1');
const run = (state, ...actions) => actions.reduce(C.commentsReducer, state);

test('WU6 open adds an empty idle box anchored to the line; opening it again keeps its text', () => {
  const opened = run(S0(), { type: 'open', line: 3, lineText: 'Three' });
  assert.deepEqual(opened.boxes[3], { text: '', status: 'idle', anchor: 'Three', error: null });
  const typed = run(opened, { type: 'edit', line: 3, text: 'draft' }, { type: 'open', line: 3, lineText: 'Three' });
  assert.equal(typed.boxes[3].text, 'draft');
});

test('WU7 edit updates the text and clears the error', () => {
  const s = run(S0(), { type: 'open', line: 1, lineText: 'x' }, { type: 'failed', line: 1, error: 'Boom' }, { type: 'edit', line: 1, text: 'y' });
  assert.deepEqual([s.boxes[1].text, s.boxes[1].error], ['y', null]);
});

test('WU8 several boxes keep their own text', () => {
  const s = run(S0(), { type: 'open', line: 1, lineText: 'a' }, { type: 'open', line: 4, lineText: 'd' }, { type: 'edit', line: 1, text: 'one' }, { type: 'edit', line: 4, text: 'four' });
  assert.deepEqual([s.boxes[1].text, s.boxes[4].text], ['one', 'four']);
});

test('WU9 cancel removes only that box', () => {
  const s = run(S0(), { type: 'open', line: 1, lineText: 'a' }, { type: 'open', line: 2, lineText: 'b' }, { type: 'cancel', line: 1 });
  assert.deepEqual(Object.keys(s.boxes), ['2']);
});

test('WU10 sending, then failed: back to idle with the error, text kept', () => {
  const sending = run(S0(), { type: 'open', line: 1, lineText: 'a' }, { type: 'edit', line: 1, text: 'keep me' }, { type: 'sending', line: 1 });
  assert.equal(sending.boxes[1].status, 'sending');
  const failed = run(sending, { type: 'failed', line: 1, error: 'Ended' });
  assert.deepEqual(failed.boxes[1], { text: 'keep me', status: 'idle', anchor: 'a', error: 'Ended' });
});

test('WU11 sent closes the box and adds a trimmed note; a second send on the line appends', () => {
  const s = run(S0(), { type: 'open', line: 2, lineText: 'b' }, { type: 'sent', line: 2, comment: '  first  ', at: ISO(0), draftAt: 'd1' },
    { type: 'open', line: 2, lineText: 'b' }, { type: 'sent', line: 2, comment: 'second', at: ISO(1), draftAt: 'd1' });
  assert.deepEqual(s.boxes, {});
  assert.deepEqual(s.sent[2], [{ comment: 'first', at: ISO(0) }, { comment: 'second', at: ISO(1) }]);
});

test('WU12 a newer draft clears every sent note, keeps unsent boxes on their line and sets the cleared flag', () => {
  const s = run(S0(), { type: 'sent', line: 1, comment: 'x', at: ISO(0), draftAt: 'd1' }, { type: 'open', line: 4, lineText: 'd' }, { type: 'edit', line: 4, text: 'unsent' },
    { type: 'draftChanged', savedAt: 'd2' });
  assert.deepEqual(s.sent, {});
  assert.equal(s.boxes[4].text, 'unsent');
  assert.equal(s.cleared, true);
  assert.equal(s.draftAt, 'd2');
});

test('WU13 the same draft refetched leaves the state as it was', () => {
  const s = run(S0(), { type: 'sent', line: 1, comment: 'x', at: ISO(0), draftAt: 'd1' });
  assert.equal(C.commentsReducer(s, { type: 'draftChanged', savedAt: 'd1' }), s);
});

test('WU14 line warnings: changed text, unchanged, and a line past the end that blocks Send', () => {
  const lines = C.draftLines('a\nNEW b');
  const box = { text: 't', status: 'idle', anchor: 'b', error: null };
  assert.deepEqual(C.lineWarning(box, lines, 2), { text: 'NEW b', blocksSend: false });
  assert.equal(C.lineWarning({ ...box, anchor: 'NEW b' }, lines, 2), null);
  assert.deepEqual(C.lineWarning(box, lines, 5), { text: 'Line 5 is no longer in the draft.', blocksSend: true });
});

test('WU15 a send that resolves after a newer draft arrived adds no note', () => {
  const s = run(S0(), { type: 'open', line: 1, lineText: 'a' }, { type: 'sending', line: 1 }, { type: 'draftChanged', savedAt: 'd2' },
    { type: 'sent', line: 1, comment: 'late', at: ISO(0), draftAt: 'd1' });
  assert.deepEqual(s.sent, {});
  assert.deepEqual(s.boxes, {});
});

test('WU16 sentHint: none, one, many, and after a clear', () => {
  assert.equal(C.sentHint(S0()), null);
  const one = run(S0(), { type: 'sent', line: 1, comment: 'x', at: ISO(0), draftAt: 'd1' });
  assert.equal(C.sentHint(one), '1 comment sent to the agent. It clears when the agent saves a new draft.');
  const three = run(one, { type: 'sent', line: 1, comment: 'y', at: ISO(0), draftAt: 'd1' }, { type: 'sent', line: 3, comment: 'z', at: ISO(0), draftAt: 'd1' });
  assert.equal(C.sentHint(three), '3 comments sent to the agent. They clear when the agent saves a new draft.');
  assert.equal(C.sentHint(run(three, { type: 'draftChanged', savedAt: 'd2' })), 'New draft saved. Sent comments were cleared because line numbers may have changed.');
});

test('WU17 commentBlock: finalized hides, read-only wins over no session, a live writable session is null', () => {
  assert.equal(C.commentBlock({ finalized: true, readOnly: true, live: false }), 'hidden');
  assert.equal(C.commentBlock({ finalized: false, readOnly: true, live: false }), READ_ONLY_TITLE);
  assert.equal(C.commentBlock({ finalized: false, readOnly: true, live: true }), READ_ONLY_TITLE);
  assert.equal(C.commentBlock({ finalized: false, readOnly: false, live: false }), 'Comments go to the live agent session. Press Resume to comment.');
  assert.equal(C.commentBlock({ finalized: false, readOnly: false, live: true }), null);
});

// ---- WS: API and store against the stand-in ----

const B = 'b1';
let stub;
const scriptPane = async () => {
  const c = await contentApi.createConcept(B, { title: 'T', brief: '', posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-10-28T09:00:00Z' }] });
  const aid = c.assets.find((a) => a.kind === 'script').id;
  await contentApi.startStudio(B, c.id, aid);
  return { cid: c.id, aid };
};
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ studioByAsset: {}, studioBlocked: {}, conceptsById: {} });
});

test('WS1 studioComment posts the body to the comment route; sendLineComment resolves ok with the time', async () => {
  const { cid, aid } = await scriptPane();
  const body = { line: 2, lineText: 'Second', comment: 'Tighter' };
  const result = await useContentStore.getState().sendLineComment(B, cid, aid, body);
  assert.equal(result.ok, true);
  assert.equal(typeof result.sentAt, 'string');
  const sent = stub.content.requests.at(-1);
  assert.deepEqual([sent.method, sent.path, sent.body], ['POST', `concepts/${cid}/assets/${aid}/session/comment`, body]);
});

test('WS2 a 400 or 409 resolves not ok with the daemon message unchanged', async () => {
  const { cid, aid } = await scriptPane();
  const empty = await useContentStore.getState().sendLineComment(B, cid, aid, { line: 1, lineText: 'a', comment: ' ' });
  assert.deepEqual([empty.ok, empty.status, empty.error], [false, 400, 'Write a comment before sending it']);
  stub.content.answers[`POST concepts/${cid}/assets/${aid}/session/comment`] = () => ({ status: 409, body: { error: 'The agent session has ended. Press Resume, then send the comment again.' } });
  const ended = await useContentStore.getState().sendLineComment(B, cid, aid, { line: 1, lineText: 'a', comment: 'x' });
  assert.deepEqual([ended.ok, ended.status, ended.error], [false, 409, 'The agent session has ended. Press Resume, then send the comment again.']);
});

test('WS3 the stand-in lists and answers the comment route', async () => {
  assert.ok(CONTENT_ROUTES.some(([m, r]) => m === 'POST' && r === 'concepts/:cid/assets/:aid/session/comment'));
  const { cid, aid } = await scriptPane();
  const res = await contentApi.studioComment(B, cid, aid, { line: 1, lineText: 'a', comment: 'x' });
  assert.equal(res.line, 1);
  assert.ok(stub.content.requests.some((r) => r.path.endsWith('/session/comment')));
});

test('WS4 sending a comment leaves the stored studio views untouched', async () => {
  const { cid, aid } = await scriptPane();
  await useContentStore.getState().openStudio(B, cid, aid, false);
  const before = useContentStore.getState().studioByAsset;
  await useContentStore.getState().sendLineComment(B, cid, aid, { line: 1, lineText: 'a', comment: 'x' });
  assert.equal(useContentStore.getState().studioByAsset, before);
});

// ---- C: the Result pane ----

const DRAFT = 'Open strong\n\nThe middle beat\nThe hook line with a very long URL https://example.com/' + 'x'.repeat(120);
const session = (state = 'running') => ({ id: 's1', conceptId: 'c1', assetId: 'a1', tab: 'script', round: 1, state, executorId: 'x', createdAt: ISO(-10), updatedAt: ISO(-10) });
const mkView = (text = DRAFT, over = {}) => ({
  rev: 1, conceptId: 'c1', assetId: 'a1', asset: { state: 'drafting', round: 1, finalizedAt: null, content: null }, session: session(),
  rounds: [{ round: 1, startedAt: ISO(-10), draft: text === null ? null : { text, savedAt: ISO(-2) } }], skillWarning: null, retro: null, ...over,
});
const noop = () => {};
const comments = (state = C.initialComments(ISO(-2)), block = null) => ({ state, block, onOpen: noop, onEdit: noop, onCancel: noop, onSend: async () => true });
const pane = (over = {}) => render('src/ui/content/StudioPaneView.tsx', 'StudioPaneView', {
  view: mkView(), blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop,
  renderTerminal: (id) => `TERMINAL:${id}`, assetKind: 'script', retroError: null, onRunRetro: noop, onOpenStyle: noop, now: NOW, comments: comments(), ...over,
});
const withBox = (line, lineText, patch = {}) => ({ ...C.initialComments(ISO(-2)), boxes: { [line]: { text: '', status: 'idle', anchor: lineText, error: null, ...patch } } });
const lineButtons = (html) => html.match(/<button[^>]*aria-label="Comment on line \d+"[^>]*>/g) ?? [];
const buttonOf = (html, label) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];

test('C1 a live draft is a list with one row per line, an aria-hidden gutter and a button on non-blank lines only', async () => {
  const html = await pane();
  assert.match(html, /<ol[^>]*aria-label="Draft lines"/);
  assert.equal((html.match(/<li[^>]*data-line=/g) ?? []).length, 4);
  assert.match(html, /<span aria-hidden="true"[^>]*>1<\/span>/);
  const buttons = lineButtons(html);
  assert.deepEqual(buttons.map((b) => b.match(/line (\d+)/)[1]), ['1', '3', '4']);
  for (const b of buttons) assert.match(b, /aria-expanded="false"/);
});

test('C2 Copy is still offered and copies the plain text unchanged', async () => {
  assert.match(await pane(), /<button[^>]*>.*?Copy<\/button>/);
  assert.match(src('ui/content/StudioPaneView.tsx'), /copyText: \(text\) => text,/);
  assert.match(src('ui/content/StudioPaneView.tsx'), /<CopyButton text=\{format\.copyText\(text\)\}/);
});

test('C3 the line text, sent notes and the textarea wrap anywhere', async () => {
  const state = { ...withBox(1, 'Open strong'), sent: { 3: [{ comment: 'long', at: ISO(-1) }] } };
  const html = await pane({ comments: comments(state) });
  assert.match(html, /<span class="[^"]*\[overflow-wrap:anywhere\][^"]*">The hook line/);
  assert.match(html, /<p class="[^"]*\[overflow-wrap:anywhere\][^"]*">long<\/p>/);
  assert.match(html, /<textarea[^>]*class="[^"]*\[overflow-wrap:anywhere\]/);
});

test('C4 an open box: label, textarea, counter, Cancel, disabled Send and the button expanded', async () => {
  const html = await pane({ comments: comments(withBox(3, 'The middle beat')) });
  assert.match(html, /<label[^>]*>Comment on line <!-- -->3<\/label>|<label[^>]*>Comment on line 3<\/label>/);
  assert.match(html, /<textarea/);
  assert.match(html, /0 \/ 2,000/);
  assert.ok(buttonOf(html, 'Cancel'));
  assert.match(buttonOf(html, 'Send'), /disabled=""/);
  assert.match(lineButtons(html).find((b) => /line 3"/.test(b)), /aria-expanded="true"/);
});

test('C5 over the limit: red counter, the message, aria-invalid and Send disabled', async () => {
  const html = await pane({ comments: comments(withBox(1, 'Open strong', { text: 'a'.repeat(2001) })) });
  assert.match(html, /<span class="[^"]*text-destructive[^"]*" data-counter="true">2,001 \/ 2,000/);
  assert.match(html, /Keep the comment to 2,000 characters\./);
  assert.match(html, /<textarea[^>]*aria-invalid="true"/);
  assert.match(buttonOf(html, 'Send'), /disabled=""/);
});

test('C6 sending: the textarea and Cancel are disabled and the button reads Sending…', async () => {
  const html = await pane({ comments: comments(withBox(1, 'Open strong', { text: 'x', status: 'sending' })) });
  assert.match(html, /<textarea[^>]*disabled=""/);
  assert.match(buttonOf(html, 'Cancel'), /disabled=""/);
  assert.match(html, /Sending…<\/button>/);
});

test('C7 a failed send shows the error in the box and keeps the text', async () => {
  const html = await pane({ comments: comments(withBox(1, 'Open strong', { text: 'keep this', error: 'The agent session has ended. Press Resume, then send the comment again.' })) });
  const box = html.slice(html.indexOf('data-comment-box="1"'));
  assert.match(box, /role="alert"[\s\S]*The agent session has ended/);
  assert.match(html, /<textarea[^>]*>keep this<\/textarea>/);
});

test('C8 sent notes: Sent, a time, the comment in pre-wrap, and the count hint', async () => {
  const state = { ...C.initialComments(ISO(-2)), sent: { 1: [{ comment: 'one\ntwo', at: ISO(-1) }], 3: [{ comment: 'three', at: ISO(-1) }] } };
  const html = await pane({ comments: comments(state) });
  assert.match(html, /Sent · <time/);
  assert.match(html, /<p class="[^"]*whitespace-pre-wrap[^"]*">one\ntwo<\/p>/);
  assert.match(html, /data-comment-hint="true">2 comments sent to the agent\. They clear when the agent saves a new draft\./);
});

test('C9 after a new draft: no notes, the cleared hint, and the unsent box still on line 3 warning about its new text', async () => {
  const before = { ...withBox(3, 'The middle beat', { text: 'unsent words' }), sent: { 1: [{ comment: 'x', at: ISO(-1) }] } };
  const state = C.commentsReducer(before, { type: 'draftChanged', savedAt: ISO(-1) });
  const html = await pane({ view: mkView('Open strong\n\nA rewritten middle\nEnd'), comments: comments(state) });
  assert.doesNotMatch(html, /data-sent/);
  assert.match(html, /New draft saved\. Sent comments were cleared because line numbers may have changed\./);
  assert.match(html, /data-comment-box="3"/);
  assert.match(html, /<textarea[^>]*>unsent words<\/textarea>/);
  assert.match(html, /data-line-warning="true">This line changed in the new draft\. It now reads: “A rewritten middle”/);
});

test('C10 no live session: buttons disabled with the reason, the hint shows it, and an open box cannot send', async () => {
  const html = await pane({ view: mkView(DRAFT, { session: session('ended') }), comments: comments(withBox(1, 'Open strong', { text: 'x' }), C.NO_SESSION_TITLE) });
  for (const b of lineButtons(html)) { assert.match(b, /disabled=""/); assert.match(b, /title="Comments go to the live agent session\. Press Resume to comment\."/); }
  assert.match(html, /data-comment-hint="true">Comments go to the live agent session/);
  assert.match(html.match(/<button[^>]*>Send<\/button>/)[0], /disabled=""[^>]*title="Comments go to the live agent session/);
});

test('C11 read-only: buttons disabled with the read-only title', async () => {
  const html = await pane({ readOnly: true, comments: comments(undefined, READ_ONLY_TITLE) });
  const buttons = lineButtons(html);
  assert.equal(buttons.length, 3);
  for (const b of buttons) assert.match(b, /disabled=""[^>]*title="This Building is read-only"/);
});

test('C12 finalized: the plain text, no list, no buttons, no hint', async () => {
  const html = await pane({ view: mkView(DRAFT, { asset: { state: 'finalized', round: 1, finalizedAt: ISO(-1), content: DRAFT }, session: session('ended') }), comments: comments(undefined, 'hidden') });
  assert.match(html, /<pre[^>]*data-result="true">Open strong/);
  assert.doesNotMatch(html, /<ol/);
  assert.equal(lineButtons(html).length, 0);
  assert.doesNotMatch(html, /data-comment-hint/);
});

test('C13 no draft yet: the empty text and no buttons', async () => {
  const html = await pane({ view: mkView(null) });
  assert.match(html, /data-result="true">[^<]*draft/i);
  assert.equal(lineButtons(html).length, 0);
});

test('C14 keyboard: Ctrl/Cmd+Enter sends, Esc cancels, and Cancel and Send return focus to the line button', () => {
  const s = src('ui/content/DraftComments.tsx');
  assert.match(s, /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)\) \{ e\.preventDefault\(\); send\(\); \}/);
  assert.match(s, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); cancel\(\); \}/);
  assert.match(s, /const cancel = \(\) => \{ comments\.onCancel\(line\); focusButton\(\); \}/);
  assert.match(s, /\.then\(\(ok\) => \{ if \(ok\) focusButton\(\); \}\)/);
});

test('C15 the comment button shows on hover and focus, and always on touch screens', () => {
  const s = src('ui/content/DraftComments.tsx');
  for (const cls of ['group-hover:opacity-100', 'group-focus-within:opacity-100', 'focus-visible:opacity-100', '[@media(hover:none)]:opacity-100']) assert.ok(s.includes(cls), cls);
  assert.doesNotMatch(s, /\shidden[=\s>]/);
});

test('C16 the post tabs keep their own result with no comment buttons', async () => {
  const { postResultFormat } = await loadModule('src/ui/content/PostTextTab.tsx');
  for (const platform of ['x', 'blog']) {
    const format = postResultFormat(platform, { blogView: 'rendered', onBlogView: noop, onOverview: noop });
    const html = await pane({ view: mkView('# Title\n\nFirst\n\nSecond'), format, comments: undefined });
    assert.equal(lineButtons(html).length, 0, platform);
  }
  assert.match(src('ui/content/StudioPane.tsx'), /const comments: LineComments \| undefined = format \? undefined :/);
});

test('C17 StudioPane wires sendLineComment, the live session, controlsDisabled(readOnly) and the draft time', () => {
  const s = src('ui/content/StudioPane.tsx');
  assert.match(s, /await sendLineComment\(projectId, conceptId, assetId, \{ line, lineText, comment \}\)/);
  assert.match(s, /commentBlock\(\{ finalized: view\?\.asset\.state === 'finalized', readOnly: controlsDisabled\(readOnly\), live: view\?\.session\?\.state === 'running' \}\)/);
  assert.match(s, /useEffect\(\(\) => \{ dispatch\(\{ type: 'draftChanged', savedAt \}\); \}, \[savedAt\]\)/);
  assert.match(s, /comments=\{comments\}/);
});
