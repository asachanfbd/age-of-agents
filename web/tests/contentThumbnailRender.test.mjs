import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { render, loadModule } from './renderHelper.mjs';
import { NOW, TSTATES, tcall, thumbnailView, tround } from './contentThumbnailFixtures.mjs';

/** Static markup of each Thumbnail tab state, the gallery, the preview and the Concept wiring (TC01… in the Test Case Planning list). */

const TAB = 'src/ui/content/ThumbnailTab.tsx';
const noop = () => {};
const props = (view, extra = {}) => ({
  view, blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, onStop: noop, onFinalize: noop,
  renderTerminal: (id) => `TERMINAL:${id}`, now: NOW, ...extra,
});
const pane = (state, extra) => render(TAB, 'ThumbnailPaneView', props(typeof state === 'string' ? TSTATES[state] : state, extra));
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const buttonWith = (html, label, attr) => new RegExp(`<button[^>]*${attr}[^>]*>(<svg[^>]*>.*?</svg>)?${label}</button>`).test(html);
const disabled = (html, label) => buttonWith(html, label, 'disabled=""');
const present = (html, label) => new RegExp(`<button[^>]*>(<svg[^>]*>.*?</svg>)?${label}</button>`).test(html);
const choice = { round: 1, name: 'thumb-02.png' };

const concept = (formats) => ({
  id: 'c1', title: 'Launch teaser', brief: '', archived: false, createdAt: '2026-10-26T09:00:00.000Z', updatedAt: '2026-10-26T09:00:00.000Z', compositionId: null, progress: { finalized: 0, needed: 1 },
  assets: [{ id: 's1', kind: 'script', postId: null, state: 'finalized', round: 1 }, { id: 't1', kind: 'thumbnail', postId: null, state: 'empty', round: 0 }],
  posts: formats.map((format, i) => ({ id: `p${i}`, conceptId: 'c1', platform: 'linkedin', format, scheduledAt: '2026-11-03T09:00:00Z', status: 'draft', note: null, createdAt: '2026-10-26T09:00:00.000Z', publishedAt: null, liveUrl: null, needs: [], stats: null, result: null })),
});
const body = (c, extra = {}) => render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: c, missingByPost: {}, error: null, onSave: noop, timeZone: 'UTC', readOnly: false, tab: 'overview', onTab: noop, onBack: noop, onChanged: noop, renderStudio: () => 'STUDIO', renderImages: () => 'IMG', renderThumbnail: (_c, aid) => `THUMB:${aid}`, ...extra });

test('TC01/TC02 the tab bar lists Thumbnail after Video; enabled with a video post, disabled with the reason otherwise', async () => {
  const on = await body(concept(['video']), { tab: 'thumbnail' });
  assert.ok(on.indexOf('>Video</button>') < on.indexOf('>Thumbnail</button>') && on.indexOf('>Thumbnail</button>') < on.indexOf('>Remotion</button>'));
  assert.doesNotMatch(on, /title="Add a video or reel post to use this tab"[^>]*>Thumbnail/);
  assert.match(on, /THUMB:t1/);
  assert.match(on, /<b>Launch teaser<\/b> · Thumbnail for the video and reel posts/);
  assert.doesNotMatch(on, /PostSwitcher|Image and carousel posts/);
  const off = await body(concept(['image']), { tab: 'thumbnail' });
  assert.match(off, /title="Add a video or reel post to use this tab"[^>]*>Thumbnail/);
  assert.match(off, /<p[^>]*>Add a video or reel post to use this tab<\/p>/);
});

test('TC03 the Overview asset list links the thumbnail row for video and reel Concepts only', async () => {
  const video = await body(concept(['reel']));
  assert.match(video, /<button[^>]*w-16[^>]*>Thumbnail<\/button>/);
  const image = await body(concept(['image']));
  assert.doesNotMatch(image, /w-16[^>]*>Thumbnail</);
});

test('TC04/TC32/WC17 layout: full-height column, panes scroll inside, action bar pinned in the result pane, no horizontal overflow classes', async () => {
  const html = await pane(thumbnailView({ rounds: [tround(1, tcall({ total: 5, done: 5 }), 5)], alt: `${'x'.repeat(300)}\nb\nc\nd\ne` }));
  assert.match(html, /<div class="flex min-h-0 flex-1 flex-col" data-thumbnail-state="rendered"/);
  assert.match(html, /overflow-y-auto px-4 pb-4 sm:px-6 pt-3" aria-label="Result body"/, 'the gallery scrolls inside the result pane (37.006)');
  assert.match(html, /class="grid shrink-0 gap-2 border-t border-border px-4 py-3 sm:px-6" aria-label="Pane footer"/);
  assert.match(html, /aria-label="Pane footer"[\s\S]*>Finalize<[\s\S]*>Start a new session</, 'WC17: Finalize and Start a new session in the footer');
  assert.match(html, /\[overflow-wrap:anywhere\]">x{300}/, 'a long unbroken alt line wraps');
  assert.doesNotMatch(html, /overflow-x-scroll|w-\[\d{4,}px\]/);
  assert.match(src('ui/content/ConceptView.tsx'), /thumbnailTab = tab === 'thumbnail' && open\?\.enabled/);
  assert.match(src('ui/ContentStudioWorkspace.tsx'), /renderThumbnail=\{\(conceptId, assetId\) => <ThumbnailPane/);
});

test('TC05/TC06/TC08 setup, setup failed, starting', async () => {
  const setup = await pane('setup');
  assert.match(setup, /Setting up Remotion…/);
  assert.doesNotMatch(setup, /TERMINAL/);
  assert.match(await pane('setupfail'), /role="alert"[^>]*>Remotion setup failed: npm exited with code 1/);
  assert.match(await pane(thumbnailView({ session: null })), /Starting the agent…/);
});

test('TC07 blocked: the reason and a Start button, no Finalize', async () => {
  const html = await pane(thumbnailView({ session: null }), { blocked: 'No default coding agent is set.' });
  assert.match(html, /No default coding agent is set\./);
  assert.ok(present(html, 'Start'));
  assert.ok(!present(html, 'Finalize'));
});

test('TC09/TC10 running: status box with Stop and progress; queued message', async () => {
  const running = await pane('rendering');
  assert.match(running, /role="status"[^>]*>.*Rendering thumbnail 2 of 3…/);
  assert.match(running, /Stop<\/button>/);
  assert.ok(disabled(running, 'Finalize'));
  assert.match(running, /title="Finalize is available once the render finishes\."/);
  const queued = await pane('queued');
  assert.match(queued, /Thumbnail render is queued/);
  assert.match(queued, /Waiting for a video render in this Building to finish \(Concept &quot;Spring reel&quot;\)/);
});

test('TC11 failed and stopped alerts keep the thumbnails already made', async () => {
  const failed = await pane('failed');
  assert.match(failed, /role="alert"[^>]*>The render failed: thumb-abc-2 timed out after 60 seconds\./);
  assert.match(failed, /aria-label="Open thumbnail 1"/);
  const stopped = await pane('stopped');
  assert.match(stopped, /The render was stopped after 2 images\.|stopped after 2 thumbnails\./);
  assert.match(stopped, /aria-label="Open thumbnail 2"/);
});

test('TC12 tile anatomy: open button, aspect ratio, caption, Download, radiogroup with Use this one / Final choice', async () => {
  const html = await pane('rendered', { initialChoice: choice });
  assert.match(html, /aria-label="Open thumbnail 1"/);
  assert.match(html, /style="aspect-ratio:1280 \/ 720"/);
  assert.match(html, />1280 × 720</);
  assert.match(html, /1280 × 720 · 3 variants/);
  assert.match(html, /aria-label="Download thumbnail 1"[^>]*>|href="[^"]*thumb-01\.png\?download=1"/);
  assert.match(html, /role="radiogroup" aria-label="Choose the final thumbnail"/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 3);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.equal((html.match(/>Use this one</g) ?? []).length, 2);
  assert.match(html, />Final choice</);
  assert.doesNotMatch(html, /\.zip|Download all/);
});

test('TC13-TC16 one, vertical, five and zero variants', async () => {
  const single = await pane('single');
  assert.equal((single.match(/role="radio"/g) ?? []).length, 1);
  assert.match(single, /aria-checked="true"/, 'a lone variant is preselected');
  assert.ok(!disabled(single, 'Finalize'));
  assert.match(await pane('vertical'), /aspect-ratio:1080 \/ 1920/);
  assert.equal(((await pane('five')).match(/role="radio"/g) ?? []).length, 5);
  assert.match(await pane('empty'), /No thumbnails yet\. The agent&#x27;s renders appear here\./);
});

test('TC17 rendering, waiting and missing slots', async () => {
  const rendering = await pane('rendering');
  assert.match(rendering, /data-slot="rendering"[^>]*>.*Rendering…/);
  assert.match(rendering, /data-slot="waiting"[^>]*>.*Waiting/);
  assert.match(await pane('failed'), /data-slot="missing"[^>]*>.*Not made/);
});

test('TC18 alt text with Copy, a blank line becomes No alt text', async () => {
  const html = await pane(thumbnailView({ rounds: [tround(1, tcall(), 3)], alt: 'First\n\nThird' }));
  assert.match(html, /aria-label="Alt text"/);
  assert.match(html, />Copy alt text</);
  assert.match(html, /<i[^>]*>No alt text<\/i>/);
});

test('TC19/TC20 Finalize matrix and the hint equals the title', async () => {
  const states = {
    nothingChosen: [TSTATES.rendered, {}, true, 'Choose a thumbnail to finalize.'],
    chosen: [TSTATES.rendered, { initialChoice: choice }, false, null],
    rendering: [TSTATES.rendering, { initialChoice: choice }, true, 'Finalize is available once the render finishes.'],
    queued: [TSTATES.queued, {}, true, 'Finalize is available once the render finishes.'],
    failed: [TSTATES.failed, {}, true, 'The last render did not finish. Render again to finalize.'],
    readOnly: [TSTATES.rendered, { readOnly: true, initialChoice: choice }, true, 'This Building is read-only'],
  };
  for (const [name, [view, extra, off, text]] of Object.entries(states)) {
    const html = await pane(view, extra);
    assert.equal(disabled(html, 'Finalize'), off, name);
    if (text) {
      assert.match(html, new RegExp(`<button[^>]*title="${text}"[^>]*>(<svg[^>]*>.*?</svg>)?Finalize`), `${name} title`);
      if (name !== 'readOnly') assert.match(html, new RegExp(`data-finalize-hint[^>]*>${text}</p>`), `${name} hint`);
    } else assert.doesNotMatch(html, /data-finalize-hint/);
  }
});

test('TC21 Previous rounds', async () => {
  const html = await pane('previous');
  assert.match(html, /Previous rounds \(1\)/);
  assert.match(html, /aria-label="Open round 1 image 1"/);
});

test('TC22/TC23 finalized: full width, the final with Download and Reopen, no Finalize or terminal', async () => {
  const html = await pane('finalized');
  assert.match(html, /grid-cols-1/);
  assert.doesNotMatch(html, /TERMINAL|aria-label="Agent terminal"/);
  assert.match(html, /aria-label="Final thumbnail"/);
  assert.match(html, />Final choice</);
  assert.match(html, /thumb-02\.png\?download=1/);
  assert.ok(present(html, 'Reopen'));
  assert.ok(!present(html, 'Finalize'));
  assert.ok(present(html, 'Start a new session'), 'offered on the finalized view too');
  const blocked = await pane('finalized', { reopenBlocked: 'Used by a published post' });
  assert.ok(disabled(blocked, 'Reopen') && disabled(blocked, 'Start a new session'));
  assert.ok(disabled(await pane('finalized', { readOnly: true }), 'Start a new session'));
  const { STATES } = await import('./contentImagesFixtures.mjs');
  const images = await render('src/ui/content/ImagesTab.tsx', 'ImagesPaneView', { view: STATES.finalized, blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, onStop: noop, renderTerminal: noop, now: NOW });
  assert.doesNotMatch(images, />Start a new session</, 'the Images tab is unchanged');
  assert.match(src('ui/content/ThumbnailTab.tsx'), /onAction\(a === 'session\/new-round' && view\?\.asset\.state === 'finalized' \? 'reopen' : a\)/, 'on a finalized asset the new session is a Reopen');
  assert.match(blocked, /title="Used by a published post"/);
});

test('TC24 read-only: the info strip, disabled changing buttons, Download and preview still there', async () => {
  const html = await pane('rendered', { readOnly: true });
  assert.match(html, /This Building is read-only\. You can look at and download the thumbnails/);
  assert.ok(disabled(html, 'Finalize'));
  assert.match(html, /aria-label="Download thumbnail 1"/);
  assert.match(html, /aria-label="Open thumbnail 1"/);
  assert.equal((html.match(/role="radio"[^>]*disabled=""|disabled=""[^>]*role="radio"/g) ?? []).length, 3, 'nothing can be chosen');
});

test('TC25 the preview: title, Download PNG, navigation, hint (the dialog wraps this body)', async () => {
  const PREVIEW = 'src/ui/content/ImagesResult.tsx';
  const { thumbnailAsImages } = await loadModule('src/lib/contentThumbnail.ts');
  const open = (view, position) => render(PREVIEW, 'ImagePreviewBody', { view: thumbnailAsImages(view), target: { round: 1, position }, onTarget: noop, onClose: noop, noun: 'thumbnail' });
  const first = await open(TSTATES.rendered, 1);
  assert.match(first, /Download PNG/);
  assert.match(first, /aria-label="Previous thumbnail"[^>]*disabled=""/);
  assert.match(first, /Use ← and → to move between thumbnails\./);
  assert.match(first, /Bold title on blue/);
  assert.match(await open(TSTATES.rendered, 3), /aria-label="Next thumbnail"[^>]*disabled=""/);
  assert.doesNotMatch(await open(TSTATES.single, 1), /Previous thumbnail|Next thumbnail/);
  assert.match(src('ui/content/ImagesResult.tsx'), /previewNav\(props\.target\.position, images\.length, props\.noun\)\.title/);
  assert.match(src('ui/content/ThumbnailTab.tsx'), /<ImagePreviewDialog[^>]*noun="thumbnail"/);
});

test('TC26 the new-session confirm names the round and shows only when opened', async () => {
  const confirm = await render('src/ui/content/StudioPaneView.tsx', 'NewSessionConfirmBody', { round: 1 });
  assert.match(confirm, /End round 1 and start round 2\?/);
  assert.doesNotMatch(await pane('rendered'), /Start a new session<\/h|End round 1/);
});

test('TC27 the Publish dialog: thumbnail row for a video post, the not-finalized hint, none for a text post', async () => {
  const post = (format) => ({ id: 'p1', conceptId: 'c1', platform: 'linkedin', format, scheduledAt: '2026-11-03T09:00:00Z', status: 'finalized', needs: [] });
  const form = (p, media) => render('src/ui/content/PublishDialog.tsx', 'PublishForm', {
    post: p, mode: 'publish', media, urls: { image: () => '', zip: '', video: '', thumbnail: 'http://x/thumb' }, timeZone: 'UTC', url: '', at: '', errors: {}, error: null, pending: false, readOnly: false,
    onUrl: noop, onAt: noop, onCopy: noop, onSubmit: noop, onCancel: noop,
  });
  const base = { text: 'Hello', images: null, video: { name: 'v.mp4', missing: false } };
  assert.match(await form(post('video'), { ...base, thumbnail: { name: 'thumb-02.png', missing: false } }), /aria-label="Thumbnail"[^]*thumb-02\.png[^]*Download/);
  assert.match(await form(post('video'), { ...base, thumbnail: { name: 'thumb-02.png', missing: true } }), /File missing/);
  assert.match(await form(post('reel'), { ...base, thumbnail: null }), /No final thumbnail yet\. Finalize it in the Thumbnail tab\./);
  const linked = await render('src/ui/content/PublishDialog.tsx', 'PublishForm', { post: post('video'), mode: 'publish', media: { ...base, thumbnail: null }, urls: { image: () => '', zip: '', video: '', thumbnail: '' }, timeZone: 'UTC', url: '', at: '', errors: {}, error: null, pending: false, readOnly: false, onUrl: noop, onAt: noop, onCopy: noop, onSubmit: noop, onCancel: noop, onOpenThumbnail: noop });
  assert.match(linked, /<button[^>]*>Open the Thumbnail tab<\/button>/);
  assert.doesNotMatch(await form(post('video'), { ...base, thumbnail: null }), /Open the Thumbnail tab/);
  assert.doesNotMatch(await form(post('text'), { text: 'Hello', images: null, video: null, thumbnail: null }), /thumbnail/i);
});

test('TC28 accessibility: labelled radiogroup, labelled icon buttons', async () => {
  const html = await pane('rendered');
  assert.match(html, /role="radiogroup" aria-label=/);
  assert.match(html, /aria-label="Open thumbnail 1"/);
});

test('TC29 the Images tab still draws its pane the same way after the shared pieces changed', async () => {
  const { STATES } = await import('./contentImagesFixtures.mjs');
  const html = await render('src/ui/content/ImagesTab.tsx', 'ImagesPaneView', { view: STATES.setup, blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, onStop: noop, renderTerminal: noop, now: NOW });
  assert.match(html, /Setting up Remotion…/);
});
