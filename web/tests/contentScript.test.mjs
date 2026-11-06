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

/** 37.006: the Script footer (word count, length, speaking speed), the edge-to-edge pane layout and the Settings speed field. */

const s = await import('../src/lib/contentScript.ts');
const { useContentStore } = await import('../src/store/contentStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

// ---- formulas ----------------------------------------------------------------------------------------------------

test('WU01/WU02 empty or blank text is 0 words; runs of whitespace split once', () => {
  assert.equal(s.countWords(''), 0);
  assert.equal(s.countWords('  \n\t '), 0);
  assert.equal(s.countWords('a  b\t\tc\n\nd'), 4);
});

test('WU03 Hindi/Hinglish counts by whitespace; ZWJ/ZWNJ inside a Devanagari word do not split it', () => {
  assert.equal(s.countWords('दोस्तों, aaj hum baat karenge WhatsApp replies ki।'), 8);
  assert.equal(s.countWords('क्‍ष क्‌ष'), 2);
});

test('WU04 NBSP, em space and ideographic space split; a zero-width space does not', () => {
  for (const space of [' ', ' ', '　']) assert.equal(s.countWords(`one${space}two`), 2, space.codePointAt(0).toString(16));
  assert.equal(s.countWords('one​two'), 1);
});

test('WU05 emoji: a word plus emoji, a skin-tone emoji, a ZWJ family', () => {
  assert.equal(s.countWords('Great 🔥'), 2);
  assert.equal(s.countWords('👍🏽'), 1);
  assert.equal(s.countWords('👨‍👩‍👧‍👦'), 1);
});

test('WU06 a 12,000-word script', () => {
  assert.equal(s.countWords(Array.from({ length: 12_000 }, () => 'word').join(' ')), 12_000);
});

test('WU07-WU11 length: "—" with no words, ~m:ss rounded half up with a 1 s floor, minutes not capped', () => {
  assert.equal(s.formatLength(null, 150), '—');
  assert.equal(s.formatLength(0, 150), '—');
  assert.equal(s.formatLength(180, 150), '~1:12');
  assert.equal(s.formatLength(150, 150), '~1:00');
  assert.equal(s.formatLength(1, 150), '~0:01');
  assert.equal(s.formatLength(149, 150), '~1:00', '59.6 s rounds to a minute, never ~0:60');
  assert.equal(s.formatLength(5, 120), '~0:03', '2.5 s rounds half up');
  assert.equal(s.formatLength(12_000, 150), '~80:00');
  assert.equal(s.formatLength(12_000, 20), '~600:00');
  assert.equal(s.formatLength(400, 400), '~1:00');
  assert.equal(s.formatLength(20, 20), '~1:00');
});

test('WU12 words label: 0, 1, 1,234', () => {
  assert.deepEqual([0, 1, 1234].map(s.wordsLabel), ['0 words', '1 word', '1,234 words']);
});

test('WU13 the footer input: ASCII digits 20 to 400 only', () => {
  for (const [text, wpm] of [[' 150 ', 150], ['20', 20], ['400', 400], ['0150', 150]]) assert.deepEqual(s.parseSpeedInput(text), { ok: true, wpm }, text);
  for (const text of ['', '19', '401', '0', 'abc', '150.5', '1e2', '+150', '-150', '१५०']) {
    assert.deepEqual(s.parseSpeedInput(text), { ok: false, error: 'Use a whole number from 20 to 400. Nothing was saved.' }, text);
  }
});

test('WU14 the speed field: same value saves nothing, a change saves once, invalid errs, Esc reverts, Enter then blur saves once', () => {
  const run = (state, ...events) => events.reduce((acc, e) => { const step = s.speedFieldStep(acc.state, e); return { state: step.state, saves: step.save === null ? acc.saves : [...acc.saves, step.save] }; }, { state, saves: [] });
  const start = s.initialSpeedField(150);
  assert.deepEqual(run(start, { type: 'commit', saved: 150 }).saves, []);
  const changed = run(start, { type: 'edit', text: '180' }, { type: 'commit', saved: 150 });
  assert.deepEqual([changed.saves, changed.state.saving], [[180], true]);
  const bad = run(start, { type: 'edit', text: '19' }, { type: 'commit', saved: 150 });
  assert.deepEqual([bad.saves, bad.state.text, bad.state.error], [[], '19', s.SPEED_INPUT_ERROR]);
  const esc = run(start, { type: 'edit', text: '999' }, { type: 'revert', saved: 150 }, { type: 'commit', saved: 150 });
  assert.deepEqual([esc.saves, esc.state.text, esc.state.error], [[], '150', null]);
  const enterBlur = run(start, { type: 'edit', text: '200' }, { type: 'commit', saved: 150 }, { type: 'commit', saved: 150 });
  assert.deepEqual(enterBlur.saves, [200], 'the blur after Enter sends nothing while the save is in flight');
  const done = run(enterBlur.state, { type: 'saved', saved: 200 });
  assert.deepEqual(done.state, { text: '200', error: null, saving: false });
  const failed = run(enterBlur.state, { type: 'failed', error: 'The request failed' });
  assert.deepEqual(failed.state, { text: '200', error: 'The request failed · not saved', saving: false });
});

test('WU15 source labels for the footer and the Settings chip', () => {
  assert.deepEqual([s.footerSourceLabel({ source: 'default', sampleCount: 0 }), s.footerSourceLabel({ source: 'manual', sampleCount: 0 })], ['default', 'set by you']);
  assert.deepEqual([s.settingsSourceLabel('default'), s.settingsSourceLabel('manual')], ['Default', 'Set by you']);
});

test('WU16 the Settings payload carries the speed only when it changed', () => {
  const loaded = { speakingWpm: 150, source: 'default', sampleCount: 0 };
  assert.deepEqual(s.speedPatch('150', loaded), {});
  assert.deepEqual(s.speedPatch(' 150 ', loaded), {});
  assert.deepEqual(s.speedPatch('180', loaded), { speakingWpm: 180 });
});

test('WU17 the Settings field error; an invalid speed blocks the whole Save', () => {
  for (const bad of ['19', '401', '7.5', 'abc', '']) assert.equal(s.speakingSpeedError(bad), 'Speaking speed must be a whole number from 20 to 400.', bad);
  for (const good of ['20', '400']) assert.equal(s.speakingSpeedError(good), null);
  const tab = src('ui/content/SettingsTab.tsx');
  assert.match(tab, /const problem = evaluationDaysError\(days\) \?\? speakingSpeedError\(wpm\);\n\s+if \(problem\) \{ setError\(problem\); setSaved\(false\); return; \}/);
  assert.match(tab, /\.\.\.speedPatch\(wpm, speed\)/);
});

test('WU18 the stats come from the shown text: a draft, the finalized text, or no draft', () => {
  assert.deepEqual(s.scriptStats(null, 150), { words: 0, length: '—' });
  assert.deepEqual(s.scriptStats('one two three', 150), { words: 3, length: '~0:01' });
  assert.match(src('ui/content/StudioPane.tsx'), /<ScriptStats text=\{view \? shownText\(view\) : null\}/);
});

test('WU19 the stats are memoised on the text and the speed only, not the terminal', () => {
  const view = src('ui/content/ScriptStats.tsx');
  assert.match(view, /useMemo\(\(\) => scriptStats\(text, speed\.speakingWpm\), \[text, speed\.speakingWpm\]\)/);
  assert.doesNotMatch(view, /terminal/i);
});

// ---- the stand-in and the store ------------------------------------------------------------------------------------

const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ speakingSpeedByProject: {}, speakingSamplesByProject: {} });
});
const store = () => useContentStore.getState();

test('WI01 the stand-in serves the speed: default, a valid save is manual, a bad one is 400 speakingWpm', async () => {
  assert.deepEqual((await contentApi.settings(B)).speakingSpeed, { speakingWpm: 150, source: 'default', sampleCount: 0 });
  assert.deepEqual((await contentApi.saveSettings(B, { speakingWpm: 180 })).speakingSpeed, { speakingWpm: 180, source: 'manual', sampleCount: 0 });
  await assert.rejects(contentApi.saveSettings(B, { speakingWpm: 401 }), (e) => e.status === 400);
  const last = stub.content.requests.at(-1);
  assert.equal(last.path, 'settings');
});

test('WI02 the footer save sends only the speed and shows "set by you"', async () => {
  await store().loadSpeakingSpeed(B);
  assert.deepEqual(store().speakingSpeedByProject[B], { speakingWpm: 150, source: 'default', sampleCount: 0 });
  assert.deepEqual(await store().saveSpeakingWpm(B, 180), { ok: true });
  assert.deepEqual(stub.content.requests.at(-1).body, { speakingWpm: 180 });
  assert.deepEqual(store().speakingSpeedByProject[B], { speakingWpm: 180, source: 'manual', sampleCount: 0 });
});

test('WI03 a failed footer save keeps the source and reports the error', async () => {
  await store().loadSpeakingSpeed(B);
  stub.content.answers['PATCH settings'] = () => ({ status: 500, body: { error: 'Disk full' } });
  const result = await store().saveSpeakingWpm(B, 180);
  assert.equal(result.ok, false);
  assert.match(result.error, /Disk full/);
  assert.deepEqual(store().speakingSpeedByProject[B], { speakingWpm: 150, source: 'default', sampleCount: 0 });
  const step = s.speedFieldStep({ text: '180', error: null, saving: true }, { type: 'failed', error: result.error });
  assert.deepEqual([step.state.text, step.state.error.endsWith('· not saved')], ['180', true]);
});

test('WI04 the types carry the speed', () => {
  assert.match(src('lib/contentTypes.ts'), /speakingSpeed: SpeakingSpeedDto \}/);
  assert.match(src('lib/contentApi.ts'), /speakingWpm\?: number \}\) => request<T\.ContentSettingsDto>/);
});

// ---- rendering -----------------------------------------------------------------------------------------------------

const PANE = 'src/ui/content/StudioPaneView.tsx';
const NOW = Date.parse('2026-10-26T10:00:00Z');
const ISO = (min) => new Date(NOW + min * 60_000).toISOString();
const noop = () => {};
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const studioView = ({ text = null, state = 'drafting' } = {}) => ({
  rev: 1, conceptId: 'c1', assetId: 'a1', skillWarning: null, blockedReason: null, retro: null,
  asset: { state, round: 1, finalizedAt: state === 'finalized' ? ISO(-1) : null, content: state === 'finalized' ? text : null },
  session: { id: 's1', conceptId: 'c1', assetId: 'a1', tab: 'script', round: 1, state: state === 'finalized' ? 'ended' : 'running', executorId: 'x', createdAt: ISO(-10), updatedAt: ISO(-10) },
  rounds: [{ round: 1, startedAt: ISO(-10), draft: text === null ? null : { text, savedAt: ISO(-2) } }],
});
const stats = (over = {}) => render('src/ui/content/ScriptStats.tsx', 'ScriptStats', { text: null, speed: { speakingWpm: 150, source: 'default', sampleCount: 0 }, readOnly: false, onSaveSpeed: async () => ({ ok: true }), ...over });
const paneProps = (over = {}) => ({ view: studioView({ text: words(179) }), blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, renderTerminal: () => 'TERMINAL', assetKind: 'script', retroError: null, onRunRetro: noop, onOpenStyle: noop, now: NOW, ...over });
/** The pane with the Script stats in its footer, as StudioPane passes them. */
async function scriptPane(view) {
  const { loadModule } = await import('./renderHelper.mjs');
  const [{ createElement }, { renderToStaticMarkup }, pane, footer] = await Promise.all([import('react'), import('react-dom/server'), loadModule(PANE), loadModule('src/ui/content/ScriptStats.tsx')]);
  const text = view.asset.state === 'finalized' ? view.asset.content : view.rounds.at(-1).draft?.text ?? null;
  const node = createElement(footer.ScriptStats, { text, speed: { speakingWpm: 150, source: 'default', sampleCount: 0 }, readOnly: false, onSaveSpeed: async () => ({ ok: true }) });
  return renderToStaticMarkup(createElement(pane.StudioPaneView, paneProps({ view, stats: node })));
}

test('WC01 a 179-word draft: 179 words, ~1:12, the speed field at 150 and "default"', async () => {
  const html = await stats({ text: words(179) });
  assert.match(html, /aria-label="Script stats"/);
  assert.match(html, /179 words/);
  assert.match(html, /Length <span[^>]*>~1:12<\/span>/);
  assert.match(html, /<input[^>]*value="150"/);
  assert.match(html, /· default/);
});

test('WC02/WC03 no draft is "0 words" and "—"; one word is "1 word" and ~0:01', async () => {
  const none = await stats({ text: null });
  assert.match(none, /0 words/);
  assert.match(none, /data-length="true">—</);
  const one = await stats({ text: 'Namaste.' });
  assert.match(one, />1 word</);
  assert.match(one, /~0:01/);
});

test('WC04 a finalized script: stats across the full width from the finalized text, speed editable, Reopen and Run retro in the footer', async () => {
  const html = await scriptPane(studioView({ text: words(300), state: 'finalized' }));
  assert.match(html, /grid-cols-1 grid-rows-\[minmax\(0,1fr\)\]/);
  assert.doesNotMatch(html, /TERMINAL/);
  assert.match(html, /300 words/);
  assert.match(html, /~2:00/);
  assert.doesNotMatch(html, /<input[^>]*disabled=""/);
  const footer = html.slice(html.indexOf('aria-label="Pane footer"'));
  assert.match(footer, /Script stats/);
  assert.match(footer, />Reopen</);
  assert.match(footer, />Run retro</);
});

test('WC05 a read-only Building disables the speed field with the read-only title', async () => {
  assert.match(await stats({ readOnly: true }), /<input[^>]*disabled=""[^>]*title="This Building is read-only"|<input[^>]*title="This Building is read-only"[^>]*disabled=""/);
});

test('WC06 a saved speed reads "set by you"', async () => {
  const html = await stats({ speed: { speakingWpm: 180, source: 'manual', sampleCount: 0 } });
  assert.match(html, /· set by you/);
  assert.match(html, /value="180"/);
});

test('WC07 an invalid speed: aria-invalid and the error in the footer (source pins, the state is client-only)', () => {
  const view = src('ui/content/ScriptStats.tsx');
  assert.match(view, /aria-invalid=\{field\.error \? true : undefined\}/);
  assert.match(view, /\{field\.error && <p id=\{`\$\{id\}-error`\} role="alert"/);
  assert.match(view, /aria-\[invalid=true\]:border-destructive/);
});

test('WC08 the pane grid: no gap or outer border; a 1px divider; stacked rows 2fr/3fr with minimums', async () => {
  const html = await render(PANE, 'StudioPaneView', paneProps());
  assert.match(html, /class="grid min-h-0 flex-1 overflow-y-auto lg:overflow-hidden grid-rows-\[minmax\(12rem,2fr\)_minmax\(16rem,3fr\)\] lg:grid-cols-2 lg:grid-rows-\[minmax\(0,1fr\)\]"/);
  const terminal = html.match(/<div class="([^"]*)" aria-label="Agent terminal">/)[1];
  assert.match(terminal, /border-b border-border lg:border-b-0 lg:border-r/);
  assert.doesNotMatch(terminal, /rounded-card/);
  assert.doesNotMatch(html, /gap-4/);
});

test('WC09/WC10 the result pane pins its head and footer and scrolls its body; the actions sit in its footer', async () => {
  const html = await render(PANE, 'StudioPaneView', paneProps());
  assert.match(html, /class="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-3 sm:px-6" aria-label="Result heading">[\s\S]*?Copy/);
  assert.match(html, /class="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 pb-4 sm:px-6" aria-label="Result body"/);
  assert.match(html, /class="grid shrink-0 gap-2 border-t border-border px-4 py-3 sm:px-6" aria-label="Pane footer"/);
  const column = html.slice(html.indexOf('aria-label="Result column"'));
  assert.ok(column.includes('aria-label="Pane footer"'), 'the footer is inside the result pane');
  assert.match(html, /class="ml-auto flex flex-wrap items-center justify-end gap-2" aria-label="Pane actions"/);
  assert.doesNotMatch(html, /border-t pt-3/);
});

test('WC11/WC12 the plain result and the empty state have no box; the line list has no border', async () => {
  const pre = await render(PANE, 'StudioPaneView', paneProps({ view: studioView({ text: 'Plain' }), comments: undefined }));
  assert.match(pre, /<pre class="m-0 whitespace-pre-wrap font-sans text-sm \[overflow-wrap:anywhere\]" data-result="true">Plain<\/pre>/);
  const empty = await render(PANE, 'StudioPaneView', paneProps({ view: studioView({ text: null }) }));
  assert.match(empty, /<p class="m-0 py-6 text-center text-sm text-muted-foreground" data-result="true">/);
  assert.doesNotMatch(empty, /border-dashed/);
  assert.match(src('ui/content/DraftComments.tsx'), /<ol className="m-0 grid list-none gap-0\.5 p-0 text-sm" data-result aria-label="Draft lines">/);
});

test('WC13 the Concept wrapper: the agent tabs run edge to edge; Video keeps its padding', () => {
  const view = src('ui/content/ConceptView.tsx');
  assert.match(view, /agentTab \? 'mt-3 flex min-h-64 min-w-0 flex-1 flex-col border-t border-border' : videoTab \? 'flex min-h-64 min-w-0 flex-1 flex-col p-4 sm:px-6'/);
  assert.match(view, /const agentTab = !concept\.imported && \(\(tab === 'script' && !!script\) \|\| textTab \|\| imagesTab \|\| thumbnailTab\);/);
});

test('WC14 Post content and Captions: the switcher and context line sit in a padded strip', () => {
  const STRIP = 'className="grid shrink-0 gap-3 border-b border-border px-4 py-3 sm:px-6" aria-label="Post context"';
  assert.ok(src('ui/content/PostTextTab.tsx').includes(STRIP));
  assert.ok(src('ui/content/ImagesTab.tsx').includes(STRIP));
});

test('WC16 Images, read-only: the note is a full-width strip, not a rounded box', () => {
  for (const file of ['ui/content/ImagesTab.tsx', 'ui/content/ThumbnailTab.tsx']) {
    const view = src(file);
    assert.match(view, /readOnly && <p role="status" className="m-0 shrink-0 border-b border-info\/40 bg-info\/10 px-4 py-2 text-sm sm:px-6">/, file);
    assert.doesNotMatch(view, /rounded-card border border-info/, file);
  }
});

test('WC18 the non-script tabs draw no Script stats', async () => {
  const html = await render(PANE, 'StudioPaneView', paneProps({ assetKind: 'post-text' }));
  assert.doesNotMatch(html, /Script stats|wpm/);
  const assets = [{ id: 'script-1', kind: 'script' }, { id: 'video-1', kind: 'video' }];
  assert.equal(s.isScriptAsset(assets, 'script-1'), true);
  assert.equal(s.isScriptAsset(assets, 'video-1'), false);
  assert.equal(s.isScriptAsset(assets, 'post-text-1'), false, 'a post text lives under posts[].needs, never in assets');
  assert.equal(s.isScriptAsset(undefined, 'script-1'), false, 'a Concept not loaded yet shows no stats');
  assert.match(src('ui/content/StudioPane.tsx'), /const script = useContentStore\(\(s\) => isScriptAsset\(s\.conceptsById\[conceptId\]\?\.assets, assetId\)\);/);
  assert.match(src('ui/content/StudioPane.tsx'), /stats=\{script \? <ScriptStats/);
});

test('WC19 the skill warning is a strip above the panes', async () => {
  const html = await render(PANE, 'StudioPaneView', paneProps({ view: { ...studioView({ text: 'x' }), skillWarning: 'Skill file missing' } }));
  assert.match(html, /<p role="status" class="m-0 shrink-0 border-b border-warning\/40 bg-warning\/10 px-4 py-2 text-sm sm:px-6">Skill file missing<\/p>/);
  assert.ok(html.indexOf('Skill file missing') < html.indexOf('aria-label="Agent terminal"'));
});

test('WC20 the Settings tab has the speed field with its source chip and help, disabled when read-only', () => {
  const tab = src('ui/content/SettingsTab.tsx');
  for (const part of ['Speaking speed (words per minute)', 'settingsSourceLabel(speed.source)', 'id="content-speaking-wpm"', 'disabled={disabled}', 'Whole number from 20 to 400']) assert.ok(tab.includes(part), part);
  assert.match(tab, /const disabled = controlsDisabled\(readOnly\);/);
});

test('WC21 dead code: the pane source no longer has the gap, the dashed box or the old full-width footer; Video is untouched', () => {
  const view = src('ui/content/StudioPaneView.tsx');
  for (const gone of ['gap-4', 'border-dashed', 'border-t pt-3', 'rounded-card border border-border p-3 font-sans']) assert.equal(view.includes(gone), false, gone);
  assert.doesNotMatch(src('ui/content/VideoTabView.tsx'), /Script stats|speakingWpm/);
});

test('WC15 Blog: Rendered/Raw toggle and Copy Markdown in the result head, the counter stays, no Script stats', async () => {
  const { loadModule } = await import('./renderHelper.mjs');
  const [{ createElement }, { renderToStaticMarkup }, pane, post] = await Promise.all([import('react'), import('react-dom/server'), loadModule(PANE), loadModule('src/ui/content/PostTextTab.tsx')]);
  const format = post.postResultFormat('blog', { blogView: 'raw', onBlogView: noop, onOverview: noop });
  const html = renderToStaticMarkup(createElement(pane.StudioPaneView, paneProps({ view: studioView({ text: `# Title\n${'word '.repeat(400)}` }), assetKind: 'article', format })));
  const head = html.slice(html.indexOf('aria-label="Result heading"'), html.indexOf('aria-label="Result body"'));
  assert.match(head, /aria-label="Article view"/);
  assert.match(head, /Copy Markdown/);
  assert.match(html, /data-counter/);
  assert.doesNotMatch(html, /Script stats/);
});

test('WC16 Images, read-only: the strip above the panes; the finalize hint sits under the actions in the result footer', async () => {
  const { STATES, NOW: IMAGES_NOW } = await import('./contentImagesFixtures.mjs');
  const props = (view, extra = {}) => ({ view, blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, onStop: noop, renderTerminal: (id) => `TERMINAL:${id}`, now: IMAGES_NOW, ...extra });
  const readOnly = await render('src/ui/content/ImagesTab.tsx', 'ImagesPaneView', props(STATES.rendered, { readOnly: true }));
  assert.match(readOnly, /<p role="status" class="m-0 shrink-0 border-b border-info\/40 bg-info\/10 px-4 py-2 text-sm sm:px-6">This Building is read-only/);
  const misfit = await render('src/ui/content/ImagesTab.tsx', 'ImagesPaneView', props(STATES.misfit));
  const footer = misfit.slice(misfit.indexOf('aria-label="Pane footer"'));
  assert.ok(footer.indexOf('aria-label="Pane actions"') < footer.indexOf('data-finalize-hint'));
});

// ---- 37.007: detected speed ------------------------------------------------------------------------------------------

const sample = (over = {}) => ({ id: 'sm1', mediaId: 'm1', conceptId: 'c1', mediaName: 'facecam.mp4', wordsPerMinute: 141.6, words: 1234, durationSeconds: 523, createdAt: '2026-10-26T10:00:00.000Z', ...over });

test('WU20..WU24 source wording: default, manual, detected with N recordings or one', () => {
  assert.equal(s.footerSourceLabel({ source: 'default', sampleCount: 0 }), 'default');
  assert.equal(s.footerSourceLabel({ source: 'manual', sampleCount: 3 }), 'set by you');
  assert.equal(s.footerSourceLabel({ source: 'detected', sampleCount: 3 }), 'average of 3 recordings');
  assert.equal(s.footerSourceLabel({ source: 'detected', sampleCount: 1 }), 'from 1 recording');
  assert.equal(s.settingsSourceLabel('detected'), 'Detected');
});

test('WU25 "Use detected speed" shows only for a manual value with recordings', () => {
  assert.equal(s.canUseDetected({ source: 'manual', sampleCount: 2 }), true);
  for (const speed of [{ source: 'manual', sampleCount: 0 }, { source: 'detected', sampleCount: 2 }, { source: 'default', sampleCount: 0 }]) assert.equal(s.canUseDetected(speed), false);
});

test('WU26 the footer length follows the detected speed', () => {
  assert.notEqual(s.scriptStats(words(179), 142).length, s.scriptStats(words(179), 150).length);
});

test('WU27 a sample row rounds the rate, formats the duration and keeps the whole name', () => {
  const long = 'a'.repeat(120) + '.mp4';
  assert.deepEqual(s.sampleRow(sample({ mediaName: long })), { id: 'sm1', name: long, wpm: '142 wpm', detail: '1,234 words · 8:43' });
});

test('WU28 an edit while the source is detected is sent as a manual value', () => {
  assert.deepEqual(s.speedPatch('160', { speakingWpm: 142, source: 'detected', sampleCount: 3 }), { speakingWpm: 160 });
  assert.deepEqual(s.speedPatch('142', { speakingWpm: 142, source: 'detected', sampleCount: 3 }), {});
});

test('WC30 the footer reads "average of 3 recordings" and has no action for a detected speed', async () => {
  const html = await stats({ speed: { speakingWpm: 142, source: 'detected', sampleCount: 3 } });
  assert.match(html, /<label[^>]*>Speed<\/label>/);
  assert.match(html, /value="142"/);
  assert.match(html, /· average of 3 recordings/);
  assert.doesNotMatch(html, /Use detected speed/);
});

test('WC31 a manual value with recordings offers "Use detected speed"; read-only hides it', async () => {
  assert.match(await stats({ speed: { speakingWpm: 180, source: 'manual', sampleCount: 2 } }), /Use detected speed/);
  assert.doesNotMatch(await stats({ speed: { speakingWpm: 180, source: 'manual', sampleCount: 2 }, readOnly: true }), /Use detected speed/);
  assert.doesNotMatch(await stats({ speed: { speakingWpm: 180, source: 'manual', sampleCount: 0 } }), /Use detected speed/);
});

test('WC32 the Settings tab lists recordings with a delete each, an empty state and the Building-wide hint; no undo toast', () => {
  const tab = src('ui/content/SettingsTab.tsx');
  for (const part of ['Detected recordings', 'No recordings yet', 'for all Concepts', 'Use detected speed', 'deleteSpeakingSample(projectId, row.id)', 'title={row.name}', 'truncate', 'SAMPLE_LIST_SCROLL_FROM', 'max-h-72 overflow-y-auto']) assert.ok(tab.includes(part), part);
  assert.doesNotMatch(tab, /Undo/);
  assert.doesNotMatch(src('ui/content/ScriptStats.tsx'), /Detected recordings/);
});

test('WC33 the long list scrolls from 12 recordings', () => {
  assert.equal(s.SAMPLE_LIST_SCROLL_FROM, 12);
});

test('WI05 deleting a recording and "Use detected speed" go through the daemon and update the store', async () => {
  await contentApi.settings(B);
  const building = stub.content.byBuilding.get(B);
  building.speakingSamples = [sample({ id: 'a', words: 300, durationSeconds: 120 }), sample({ id: 'b', words: 100, durationSeconds: 60 })];
  await store().saveSpeakingWpm(B, 200);
  assert.deepEqual(store().speakingSpeedByProject[B], { speakingWpm: 200, source: 'manual', sampleCount: 2 });
  assert.deepEqual(await store().clearManualSpeed(B), { ok: true });
  assert.deepEqual(store().speakingSpeedByProject[B], { speakingWpm: 133, source: 'detected', sampleCount: 2 });
  await store().loadSpeakingSamples(B);
  assert.equal(store().speakingSamplesByProject[B].length, 2);
  assert.deepEqual(await store().deleteSpeakingSample(B, 'a'), { ok: true });
  assert.deepEqual(store().speakingSpeedByProject[B], { speakingWpm: 100, source: 'detected', sampleCount: 1 });
  assert.deepEqual(store().speakingSamplesByProject[B].map((x) => x.id), ['b']);
  assert.equal((await store().deleteSpeakingSample(B, 'zz')).ok, false);
});

test('WI06 a video view event rereads the speed and the recordings already on screen', async () => {
  await contentApi.settings(B);
  const building = stub.content.byBuilding.get(B);
  await store().loadSpeakingSpeed(B);
  await store().loadSpeakingSamples(B);
  building.speakingSamples = [sample({ id: 'new', words: 300, durationSeconds: 120 })];
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: { ...studioView(), assetId: 'v1', video: {} } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(store().speakingSpeedByProject[B], { speakingWpm: 150, source: 'detected', sampleCount: 1 });
  assert.deepEqual(store().speakingSamplesByProject[B].map((x) => x.id), ['new']);
});

test('WI07 a non-video view event does not reread the speed', async () => {
  await store().loadSpeakingSpeed(B);
  const before = stub.content.requests.length;
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view: studioView() });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stub.content.requests.length, before);
});

test('WC34 the footer action calls the store action that clears the manual value', () => {
  assert.match(src('ui/content/StudioPane.tsx'), /onUseDetected=\{\(\) => clearManualSpeed\(projectId\)\}/);
});
