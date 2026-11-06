import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { render } from './renderHelper.mjs';
import { item, media, NOW, render as renderDto, STATES, videoView } from './contentVideoFixtures.mjs';
import { CONTENT_ROUTES } from './contentStudioStub.mjs';

/** Static markup of each Video tab state, the media column and the preview popup (C01…C28 in the Test Case Planning list). */

const VIEW = 'src/ui/content/VideoTabView.tsx';
const noop = () => {};
const actions = Object.fromEntries(['onStart', 'onResume', 'onDiscard', 'onFinalize', 'onReopen', 'onTick', 'onLink', 'onConfirm', 'onStopRender', 'onFiles', 'onCancelUpload', 'onRenameMedia', 'onDeleteMedia', 'onDragCount'].map((k) => [k, noop]));
const studioOf = (pane, over = {}) => ({
  view: { state: pane === 'running' || pane === 'fallback' ? 'running' : pane === 'failed' ? 'failed' : pane === 'stopped' ? 'stopped' : 'starting', url: pane === 'running' || pane === 'fallback' ? 'http://127.0.0.1:3047' : null, error: pane === 'failed' ? 'Studio exited with code 1' : null, log: [], waitingForSetup: pane === 'waiting' },
  pane, setupPercent: null, busy: false, error: null, start: noop, stop: noop, ...over,
});
const props = (view, extra = {}) => ({ view, readOnly: false, uploads: [], busy: false, error: null, dragCount: null, studio: studioOf('running'), renderTerminal: (id) => `TERMINAL:${id}`, now: NOW, ...actions, ...extra });
const tab = (state, extra) => render(VIEW, 'VideoTabView', props(STATES[state], extra));
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const disabledButton = (html, label) => new RegExp(`<button[^>]*disabled=""[^>]*>(<svg[^>]*>.*?</svg>)?${label}</button>`).test(html);

test('C01 setup: Setting up Remotion with a progress bar', async () => {
  const html = await tab('setup');
  assert.match(html, /data-state="setup"/);
  assert.match(html, /Setting up Remotion…/);
  assert.match(html, /width:64%/);
});

test('C02 setup failed: the error and Retry setup', async () => {
  const html = await tab('setupfail');
  assert.match(html, /Remotion setup failed: npm exited with code 1/);
  assert.match(html, />Retry setup</);
});

test('C03 blocked: the reason and Start', async () => {
  const html = await tab('blocked');
  assert.match(html, /No default coding agent is set\./);
  assert.match(html, />Start</);
});

test('C04 waiting for the checklist, with the terminal on the left', async () => {
  const html = await tab('waiting');
  assert.match(html, /Waiting for the agent(&#x27;|')s checklist/);
  assert.match(html, /TERMINAL:s1/);
});

test('C05/C06 the checklist: items, Link or Change files, Confirm disabled with its reason until every item is ticked', async () => {
  const html = await tab('checklist');
  assert.match(html, /Assets the agent needs/);
  assert.match(html, /1 of 3 ticked/);
  assert.match(html, /Label clip/);
  assert.match(html, /Detail logo/);
  assert.match(html, />Change files</);
  assert.match(html, />Link files</);
  assert.ok(disabledButton(html, 'Confirm assets'));
  assert.match(html, /Tick every item to confirm · 2 left/);
  const ready = await tab('ready');
  assert.ok(!disabledButton(ready, 'Confirm assets'));
  assert.match(ready, /Every item is ticked/);
});

test('C01/C02 after Confirm the right pane embeds Studio at the composition: header, confirmed link, Open in a new browser tab', async () => {
  const html = await tab('preview');
  assert.match(html, /data-state="preview"/);
  assert.match(html, /<iframe title="Remotion Studio: concept-c1" src="http:\/\/127.0.0.1:3047\/concept-c1"/);
  assert.match(html, /Round 1 · Live preview/);
  assert.match(html, /Assets confirmed · 2 items/);
  assert.match(html, /<a href="http:\/\/127.0.0.1:3047\/concept-c1" target="_blank"[^>]*>Open in a new browser tab/);
  assert.doesNotMatch(html, /<video/);
  assert.match(html, /minmax\(360px,44%\)/);
  assert.match(await tab('checklist'), /minmax\(320px,34%\)/);
  assert.match(html, /Finalize renders the final MP4 \(a few minutes\), then locks this round\./);
});

test('C03/C04 Studio setting up or starting: its own text and a bar; Finalize stays enabled', async () => {
  const setting = await tab('preview', { studio: studioOf('waiting', { setupPercent: 40 }) });
  assert.match(setting, /Setting up Remotion…/);
  assert.match(setting, /width:40%/);
  const starting = await tab('preview', { studio: studioOf('starting') });
  assert.match(starting, /Starting Remotion Studio…/);
  assert.ok(!disabledButton(starting, 'Finalize'));
});

test('C05/C06/C07 Studio stopped, failed or not embeddable: the card explains it and Finalize still works', async () => {
  const stopped = await tab('preview', { studio: studioOf('stopped') });
  assert.match(stopped, /Remotion Studio is not running\./);
  assert.match(stopped, />Start Studio</);
  assert.ok(!disabledButton(stopped, 'Finalize'));
  const failed = await tab('preview', { studio: studioOf('failed') });
  assert.match(failed, /Studio exited with code 1/);
  assert.match(failed, />Retry</);
  assert.ok(!disabledButton(failed, 'Finalize'));
  const fallback = await tab('preview', { studio: studioOf('fallback') });
  assert.match(fallback, /Studio can(&#x27;|')t be shown inside this app/);
  assert.match(fallback, /127\.0\.0\.1:3047\/concept-c1/);
  assert.doesNotMatch(fallback, /<iframe/);
  assert.ok(!disabledButton(fallback, 'Finalize'));
  assert.match(await tab('preview', { studio: studioOf('stopped', { error: 'Could not start' }) }), /Could not start/);
});

test('C08 rendering: the progress box with Stop, the preview kept, Finalize disabled with its reason', async () => {
  const html = await tab('rendering');
  assert.match(html, /Rendering final video/);
  assert.match(html, /46% · frame 581 of 1,260/);
  assert.match(html, />Stop</);
  assert.match(html, /<iframe/);
  assert.ok(disabledButton(html, 'Finalize'));
  assert.match(html, /Finalize waits until the render finishes or is stopped\./);
  assert.doesNotMatch(html, /Render 1 is queued|Rendering render/);
});

test('C09/C16 queued: the final-render wording naming the other Concept, with Stop; a long title wraps', async () => {
  const html = await tab('queued');
  assert.match(html, /Final render is queued\. Waiting for &quot;Pricing explained&quot; to finish rendering\. One render at a time\./);
  assert.match(html, />Stop</);
  const long = videoView({ checklist: STATES.queued.video.checklist, renders: [renderDto(1, { status: 'queued', queuePosition: 1, waitingFor: 'T'.repeat(200), fileUrl: null })] });
  assert.match(await render(VIEW, 'VideoTabView', props(long)), /\[overflow-wrap:anywhere\][^>]*>Final render is queued/);
});

test('C10/C16 failed or stopped: the alert above the preview, Finalize enabled again, a long path wraps', async () => {
  const failed = await tab('failed');
  assert.match(failed, /role="alert"[^>]*>Final render failed: Cannot find file/);
  assert.match(failed, /Nothing was finalized\./);
  assert.ok(failed.indexOf('Final render failed') < failed.indexOf('<iframe'), 'above the preview');
  assert.match(failed, /\[overflow-wrap:anywhere\]/);
  assert.ok(!disabledButton(failed, 'Finalize'));
  const stopped = await tab('stopped');
  assert.match(stopped, /The final render was stopped\. Nothing was finalized\./);
  assert.ok(!disabledButton(stopped, 'Finalize'));
});

test('C11/C14/C15 drafting shows no render list, no player and none of the old render texts', async () => {
  const withLegacy = videoView({ checklist: STATES.preview.video.checklist, renders: [renderDto(1)] });
  for (const html of [await tab('preview'), await tab('failed'), await render(VIEW, 'VideoTabView', props(withLegacy))]) {
    assert.doesNotMatch(html, /<video|aria-label="Renders"|Renders this round|No render yet|The agent got this error too|Latest/);
  }
  const html = await tab('preview');
  assert.ok(!disabledButton(html, 'Finalize'));
  assert.match(html, /Discard the session, start a new session/);
  assert.doesNotMatch(await tab('checklist'), /render_video/);
});

test('C12 ended session: the preview and Finalize stay and the agent column offers Resume and Discard; unconfirmed keeps the checklist', async () => {
  const html = await tab('ended');
  assert.match(html, /Session ended/);
  assert.match(html, />Resume</);
  assert.match(html, /<iframe/);
  assert.ok(!disabledButton(html, 'Finalize'));
  assert.doesNotMatch(html, /TERMINAL:/);
  const unconfirmed = await tab('endedUnconfirmed');
  assert.match(unconfirmed, /Assets the agent needs/);
  assert.match(unconfirmed, /Session ended/);
  assert.doesNotMatch(unconfirmed, /<iframe/);
});

test('C13 finalized: no agent column, the Final badge, Download and Reopen', async () => {
  const html = await tab('finalized');
  assert.doesNotMatch(html, /aria-label="Agent/);
  assert.match(html, /Final/);
  assert.match(html, />Reopen</);
  assert.match(html, /renders\/r2\/file\?download=1/);
  assert.doesNotMatch(html, />Finalize</);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /<video[^>]*controls=""[^>]*src="[^"]*renders\/r2\/file"/);
  assert.doesNotMatch(html, /[Ff]ullscreen/);
  assert.match(html, /aria-label="Renders"/);
  assert.match(html, /Render 2<\/b> · 0:42/);
  assert.match(html, /minmax\(112px,10%\)_1fr\]/);
});

test('C14 read-only: the banner, write controls disabled, the drop zone says Read-only', async () => {
  const html = await tab('preview', { readOnly: true });
  assert.match(html, /This Building is read-only/);
  assert.match(html, /<iframe/);
  assert.ok(disabledButton(html, 'Finalize'));
  assert.ok(disabledButton(await tab('rendering', { readOnly: true }), 'Stop'));
  assert.match(html, /disabled=""[^>]*title="This Building is read-only"[^>]*>Discard/);
  assert.match(html, />Read-only</);
  assert.match(html, /disabled=""[^>]*>Add files/);
  const list = await tab('checklist', { readOnly: true });
  assert.ok(disabledButton(list, 'Confirm assets'));
});

test('C15/C16 the media column: lazy thumbnails, durations, names, actions; the empty state', async () => {
  const html = await tab('preview');
  assert.match(html, /<img[^>]*loading="lazy"/);
  assert.match(html, /0:48/);
  assert.match(html, /clip\.mp4/);
  assert.match(html, /aria-label="Actions for logo\.png"/);
  assert.match(html, /3 files · 3 MB/);
  const empty = await render(VIEW, 'VideoTabView', props(videoView({ mediaList: [] })));
  assert.match(empty, /No media yet\. Drop clips, photos, logos or music here\./);
  assert.match(empty, /0 of 200 files/);
});

test('C17/C18 uploading rows with progress, waiting and a dismissable error; the drag-over state', async () => {
  const uploads = [
    { key: 'u1', name: 'b-roll.mp4', size: 1_181_116_006, loaded: 432_013_312, status: 'uploading', error: null },
    { key: 'u2', name: 'logo-dark.svg', size: 10, loaded: 0, status: 'waiting', error: null },
    { key: 'u3', name: 'brand-notes.pdf', size: 10, loaded: 0, status: 'error', error: 'Unsupported file type. Use video, image or audio.' },
  ];
  const html = await tab('preview', { uploads, dragCount: 3 });
  assert.match(html, /aria-label="Uploading b-roll\.mp4"/);
  assert.match(html, /36% · 412 MB of 1\.1 GB/);
  assert.match(html, /Waiting…/);
  assert.match(html, /role="alert"[^>]*>.*brand-notes\.pdf.*Unsupported file type\. Use video, image or audio\..*Dismiss/);
  assert.match(html, /Drop to add 3 files/);
  assert.match(html, /data-over="true"/);
  assert.match(html, /<aside[^>]*aria-label="Media"[^>]*data-over="true"/);
});

test('C1-C5 drag-over highlights the whole column; idle and read-only do not; one label', async () => {
  const over = await tab('preview', { dragCount: 3 });
  assert.match(over, /<aside[^>]*border-primary bg-primary\/10[^>]*aria-label="Media"/);
  assert.equal(over.match(/data-over="true"/g).length, 2);
  assert.equal(over.match(/Drop to add/g).length, 1);
  assert.match(await tab('preview', { dragCount: 1 }), /Drop to add 1 file</);
  const idle = await tab('preview');
  assert.doesNotMatch(idle, /data-over|border-primary/);
  assert.match(idle, /Drop files here/);
  const ro = await tab('preview', { readOnly: true, dragCount: 2 });
  assert.doesNotMatch(ro, /data-over|Drop to add/);
  assert.match(ro, /Read-only/);
});

test('C6-C8 source: handlers sit on the aside only; list, uploads and picker stay inside it', () => {
  const col = src('ui/content/MediaColumn.tsx');
  const aside = col.slice(col.indexOf('<aside'), col.indexOf('</aside>'));
  assert.match(aside.slice(0, aside.indexOf('>\n') + 1), /mediaDropHandlers\(/);
  assert.doesNotMatch(col, /onDragOver=|onDrop=|onDragLeave=/);
  for (const part of ['aria-label="Media files"', 'mediaFooter(media)', 'aria-label="Choose media files"', 'accept={MEDIA_ACCEPT}', 'multiple', 'Add files']) assert.ok(aside.includes(part), part);
  assert.match(src('ui/content/VideoTabView.tsx'), /dragCount=\{[^}]+\}[\s\S]*onDragCount=\{[^}]+\}[\s\S]*onFiles=\{[^}]+\}/);
  assert.match(readFileSync(new URL('../../docs/content-studio-building.md', import.meta.url), 'utf8'), /whole media column accepts file drops/);
});

const PREVIEW = 'src/ui/content/MediaPreviewDialog.tsx';
const previewProps = (m, extra = {}) => ({ media: m, otherNames: ['taken.png'], readOnly: false, onRename: noop, onDelete: noop, onClose: noop, ...extra });

test('C19/C20 the preview: image zoom toolbar; video and audio with native controls; unknown audio length', async () => {
  const image = await render(PREVIEW, 'MediaPreviewBody', previewProps(media('m2', 'logo.png', 'image')));
  for (const label of ['Zoom out', 'Zoom in']) assert.match(image, new RegExp(`aria-label="${label}"`));
  assert.match(image, />Fit</);
  assert.match(image, />100%</);
  assert.match(image, /aria-pressed="true"[^>]*>Fit/);
  assert.match(await render(PREVIEW, 'MediaPreviewBody', previewProps(media('m1', 'clip.mp4', 'video'))), /<video controls=""/);
  const audio = await render(PREVIEW, 'MediaPreviewBody', previewProps(media('m3', 'vo.wav', 'audio', { durationMs: null })));
  assert.match(audio, /<audio controls=""/);
  assert.match(audio, /The length shows once the file is read\./);
});

test('C21 long names wrap in the popup title and the path shown is relative', () => {
  const dialog = src('ui/content/MediaPreviewDialog.tsx');
  assert.match(dialog, /<DialogTitle className="break-all/);
  assert.match(dialog, /<code className="break-all">\{media\.path\}<\/code>/);
  assert.match(media('m1', 'x.mp4', 'video').path, /^concepts\//);
});

test('C22 rename: the extension is a fixed suffix; name taken, bad characters and empty are shown', async () => {
  const editing = await render(PREVIEW, 'MediaPreviewBody', previewProps(media('m2', 'logo.png', 'image'), { renaming: true }));
  assert.match(editing, /aria-label="File name"[^>]*value="logo"/);
  assert.match(editing, /aria-label="Extension">\.png</);
  assert.match(editing, /<button[^>]*type="submit"[^>]*disabled=""/, 'Save is off while unchanged');
  const taken = await render(PREVIEW, 'RenameField', { media: media('m2', 'logo.png', 'image'), otherNames: [], saveError: 'Another file already has that name', onSave: noop, onCancel: noop });
  assert.match(taken, /Another file already has that name/);
  const helpers = src('lib/contentVideo.ts');
  for (const text of ['Enter a name.', 'Use letters, digits, spaces, dots, dashes and underscores only.']) assert.ok(helpers.includes(text), text);
  const readOnly = await render(PREVIEW, 'MediaPreviewBody', previewProps(media('m2', 'logo.png', 'image'), { renaming: true, readOnly: true }));
  assert.doesNotMatch(readOnly, /aria-label="File name"/);
});

test('C23/C24 the delete and discard dialogs use the agreed texts and round numbers', () => {
  const view = src('ui/content/VideoTabView.tsx');
  assert.match(view, /deleteMediaText\(shown\.name, linkedLabels\)/);
  assert.match(view, /discardText\(view\.asset\.round\)/);
  assert.match(view, /Discard and start round \{view\.asset\.round \+ 1\}/);
  assert.match(view, /DISCARD_KEEPS/);
});

test('C25 the confirmed checklist, read-only', async () => {
  const html = await render(VIEW, 'ConfirmedChecklist', { list: STATES.preview.video.checklist, media: STATES.preview.video.media });
  assert.match(html, /✓ Label clip/);
  assert.match(html, /clip\.mp4/);
  assert.match(html, /No file linked/);
  assert.doesNotMatch(html, /<input|<button/);
});

test('C26 previous rounds: a collapsed list of earlier rounds\' renders', async () => {
  const view = videoView({ asset: { round: 2 }, checklist: { items: [item('a', true)], confirmedAt: 'x' }, renders: [renderDto(2, { round: 1, id: 'o2' }), renderDto(1, { round: 1, id: 'o1' })] });
  const html = await render(VIEW, 'VideoTabView', props(view));
  assert.match(html, /<details[^>]*aria-label="Previous rounds"/);
  assert.match(html, /aria-label="Video">(?:(?!<\/section>)[\s\S])*aria-label="Previous rounds"/, 'scrolls inside the right pane, not under the grid');
  assert.match(html, /Previous rounds \(1\)/);
  assert.match(html, /Play round 1 render 2/);
  assert.match(html, /Read-only\./);
});

const tagOf = (html, label) => html.match(new RegExp(`<[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';

test('B.027 layout: the tab fills the height, columns share one capped row and each scrolls inside', async () => {
  for (const state of ['checklist', 'preview', 'finalized']) {
    const html = await tab(state);
    assert.match(tagOf(html, 'Video tab'), /flex min-h-0 flex-1 flex-col/, state);
    assert.match(html, /<div class="grid min-h-0 flex-1 gap-3 overflow-y-auto min-\[960px\]:grid-rows-\[minmax\(0,1fr\)\] min-\[960px\]:overflow-hidden/, `${state} grid`);
    assert.match(tagOf(html, 'Video'), /min-h-0[^"]*overflow-y-auto/, `${state} right pane`);
    assert.match(tagOf(html, 'Media'), /min-h-0/, `${state} media column`);
    assert.match(tagOf(html, 'Media files'), /min-h-0 flex-1[^"]*overflow-y-auto/, `${state} media list`);
  }
  const running = tagOf(await tab('checklist'), 'Agent terminal');
  assert.match(running, /min-h-64[^"]*min-\[960px\]:min-h-0/);
  assert.doesNotMatch(running, /min-h-\[24rem\]/);
  for (const state of ['setup', 'blocked']) assert.match(tagOf(await tab(state), 'Agent'), /min-h-0 min-w-0 overflow-y-auto/, state);
});

test('C27 the Concept tab bar draws the Video and Remotion tabs from the shared rule', () => {
  const concept = src('ui/content/ConceptView.tsx');
  assert.match(concept, /const tabs = conceptTabStates\(/);
  assert.doesNotMatch(concept, /withComingSoon/);
  assert.match(concept, /tab === 'video' && video\s*\? renderVideo\(concept\.id, video\.id\)/);
  assert.match(src('ui/ContentStudioWorkspace.tsx'), /renderVideo=\{\(conceptId, assetId\) => <VideoTab /);
});

test('C28 every new route is answered by the stand-in', () => {
  const routes = CONTENT_ROUTES.map(([m, r]) => `${m} ${r}`);
  for (const route of [
    'GET concepts/:cid/media', 'POST concepts/:cid/media', 'PATCH concepts/:cid/media/:mid', 'DELETE concepts/:cid/media/:mid', 'GET concepts/:cid/media/:mid/file', 'GET concepts/:cid/media/:mid/thumbnail',
    'GET concepts/:cid/video/checklist', 'PATCH concepts/:cid/video/checklist/:itemId', 'POST concepts/:cid/video/confirm', 'GET concepts/:cid/video/renders', 'GET concepts/:cid/video/renders/:rid/file', 'POST concepts/:cid/video/renders/:rid/stop',
  ]) assert.ok(routes.includes(route), route);
});

test('the wired tab never auto-starts a session on open, and sends uploads as raw bytes', () => {
  assert.match(src('ui/content/VideoTab.tsx'), /openStudio\(projectId, conceptId, assetId, false\)/);
  const api = src('lib/contentApi.ts');
  assert.match(api, /'content-type', 'application\/octet-stream'/);
  assert.doesNotMatch(api.slice(api.indexOf('function sendRaw'), api.indexOf('/** The Content Studio')), /base64|JSON\.stringify\(file/);
});

test('every Discard button opens the confirm dialog; only the dialog itself discards', () => {
  const view = src('ui/content/VideoTabView.tsx');
  assert.equal(view.match(/props\.onDiscard\(/g)?.length, 1, 'onDiscard from the props is called in one place');
  assert.match(view, /<Button type="button" disabled=\{busy\} onClick=\{\(\) => \{ props\.onDiscard\(\); setDialog\(null\); \}\}>Discard and start round/);
  assert.match(view, /const actions: VideoTabActions = \{ \.\.\.props, onDiscard: \(\) => setDialog\(\{ kind: 'discard' \}\) \};/);
  assert.equal(view.match(/actions=\{props\}/g), null, 'no column gets the raw props as its actions');
  assert.match(view, /<AgentColumn [^>]*actions=\{actions\}/);
  assert.match(view, /<RightPane [^>]*actions=\{actions\}/);
  assert.equal(view.match(/<DiscardButton [^>]*onClick=\{actions\.onDiscard\}/g)?.length, 2);
});
