import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { render } from './renderHelper.mjs';
import { NOW, STATES } from './contentImagesFixtures.mjs';
import { CONTENT_ROUTES } from './contentStudioStub.mjs';

/** Static markup of each Images tab state, the gallery and the preview popup (C01…C15 in the Test Case Planning list). */

const VIEW = 'src/ui/content/ImagesTab.tsx';
const RESULT = 'src/ui/content/ImagesResult.tsx';
const noop = () => {};
const props = (view, extra = {}) => ({
  view, blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, onStop: noop,
  renderTerminal: (id) => `TERMINAL:${id}`, now: NOW, ...extra,
});
const pane = (state, extra) => render(VIEW, 'ImagesPaneView', props(STATES[state], extra));
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const disabledButton = (html, label) => new RegExp(`<button[^>]*disabled=""[^>]*>(<svg[^>]*>.*?</svg>)?${label}</button>`).test(html);
const button = (html, label) => new RegExp(`<button[^>]*>(<svg[^>]*>.*?</svg>)?${label}</button>`).test(html);

test('C01 empty: the agent on the left and No images yet on the right', async () => {
  const html = await pane('empty');
  assert.match(html, /data-images-state="empty"/);
  assert.match(html, /TERMINAL:s1/);
  assert.match(html, /No images yet\. Tell the agent what you want\./);
  assert.match(html, /Finalize needs a rendered set: 2 to 20 images for an Instagram carousel\./);
});

test('C02 rendered: tiles in order with index badges and captions, a download per image, Download all (.zip), Finalize enabled', async () => {
  const html = await pane('rendered');
  const indexes = [...html.matchAll(/data-index="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(indexes, [1, 2, 3, 4, 5, 6, 7]);
  assert.match(html, /3 · 1080 × 1350/);
  assert.equal((html.match(/aria-label="Download image \d"/g) ?? []).length, 7);
  assert.match(html, /images\/rounds\/1\/image-03\.png\?download=1/);
  assert.match(html, /Download all \(\.zip\)/);
  assert.match(html, /href="[^"]*images\/rounds\/1\/images\.zip"/);
  assert.match(html, /7 images · 1080 × 1350 px · Instagram carousel default/);
  assert.ok(button(html, 'Finalize') && !disabledButton(html, 'Finalize'));
  assert.doesNotMatch(html, /data-finalize-hint/);
});

test('C03 rendering: "Rendering image 4 of 7", Stop, a rendering tile and waiting tiles', async () => {
  const html = await pane('rendering');
  assert.match(html, /Rendering image 4 of 7/);
  assert.match(html, /3 of 7 done · still-abc-slide-4/);
  assert.ok(button(html, 'Stop'));
  assert.equal((html.match(/data-slot="waiting"/g) ?? []).length, 3);
  assert.equal((html.match(/data-slot="rendering"/g) ?? []).length, 1);
  assert.match(html, /Rendering…/);
  assert.ok(disabledButton(html, 'Finalize'));
  assert.match(html, /title="Finalize is available once the render finishes\."/);
});

test('C04 queued: the waiting text names the other Concept, with Stop', async () => {
  const html = await pane('queued');
  assert.match(html, /Image render is queued/);
  assert.match(html, /Waiting for a video render in this Building to finish \(Concept (&quot;|")Spring reel(&quot;|")\)\. One render runs at a time\./);
  assert.ok(button(html, 'Stop'));
});

test('C05 failed: the alert names the image and the reason, and the rest are Not made', async () => {
  const html = await pane('failed');
  assert.match(html, /role="alert"[^>]*>The render failed: image 5 \(still-abc-slide-5\) timed out after 60 seconds\./);
  assert.equal((html.match(/data-slot="missing"/g) ?? []).length, 3);
  assert.match(html, /Not made/);
  assert.match(html, /4 of 7 images/);
  const stopped = await pane('stopped');
  assert.match(stopped, /The render was stopped after 2 images\./);
});

test('C06 misfit: Finalize disabled with the count reason as its title and under the action bar', async () => {
  const html = await pane('misfit');
  const reason = 'An X image post takes 1 to 4 images; this round has 5.';
  assert.ok(disabledButton(html, 'Finalize'));
  assert.ok(html.includes(`title="${reason}"`));
  assert.match(html, new RegExp(`data-finalize-hint="true">${reason.replace(/[.()]/g, '\\$&')}</p>`));
  assert.match(html, /5 images · 1600 × 900 px · X image default/);
});

test('C07 finalized: no terminal, the gallery full width, Reopen; no Finalize or Start a new session', async () => {
  const html = await pane('finalized');
  assert.doesNotMatch(html, /TERMINAL:/);
  assert.match(html, /data-images-state="finalized"/);
  assert.match(html, /Finalized/);
  assert.ok(button(html, 'Reopen'));
  assert.ok(!button(html, 'Finalize'));
  assert.doesNotMatch(html, />Start a new session</);
  assert.doesNotMatch(html, /lg:grid-cols-2/);
});

test('C08 read-only: the banner, changing controls disabled, downloads still there', async () => {
  const html = await pane('rendering', { readOnly: true });
  assert.match(html, /This Building is read-only/);
  assert.ok(disabledButton(html, 'Stop'));
  assert.ok(disabledButton(html, 'Finalize'));
  assert.ok(disabledButton(html, 'Start a new session'));
  assert.match(html, /aria-label="Download image 1"/);
  const done = await pane('rendered', { readOnly: true });
  assert.match(done, /Download all \(\.zip\)/);
});

const concept = (posts) => ({ id: 'c1', title: 'Launch', brief: '', archived: false, createdAt: '', updatedAt: '', assets: [], progress: { finalized: 0, needed: 0 }, posts });
const post = (id, platform, format, state = 'empty') => ({ id, conceptId: 'c1', platform, format, scheduledAt: '2026-11-03T09:00:00Z', status: 'draft', note: null, createdAt: '', stats: null, needs: [{ id: `${id}-t`, kind: 'post-text', state: 'empty', round: 0, finalizedAt: null, content: null }, ...(format === 'image' || format === 'carousel' ? [{ id: `${id}-i`, kind: 'image-set', state, round: 0, finalizedAt: null, content: null }] : [])] });

test('C09 the tab: a switcher of image and carousel posts opening on the first not finalized; none gives Go to Overview', async () => {
  const html = await render(VIEW, 'ImagesTab', { concept: concept([post('p0', 'linkedin', 'text'), post('p1', 'instagram', 'carousel', 'finalized'), post('p2', 'x', 'image')]), timeZone: 'UTC', renderPane: (cid, aid) => `PANE:${aid}`, onOverview: noop, now: NOW });
  assert.match(html, /Image and carousel posts · 2 posts/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  assert.match(html, /PANE:p2-i/);
  assert.match(html, /aria-selected="true"[^>]*data-post="p2"/);
  assert.match(html, /aria-selected="false"[^>]*data-post="p1"/);
  assert.match(html, /X \(Twitter\) · Image<\/b> · 1600 × 900 px · 1 to 4 images/);
  const none = await render(VIEW, 'ImagesTab', { concept: concept([post('p0', 'linkedin', 'text')]), timeZone: 'UTC', renderPane: () => 'PANE', onOverview: noop });
  assert.match(none, /No image or carousel posts in this Concept/);
  assert.match(none, />Go to Overview</);
});

test('C10 the preview: "Image 3 of 7", facts, zoom toolbar, previous and next, alt text with Copy, Download PNG, Close', async () => {
  const html = await render(RESULT, 'ImagePreviewBody', { view: STATES.rendered, target: { round: 1, position: 3 }, onTarget: noop, onClose: noop });
  assert.match(html, /aria-label="Zoom"/);
  for (const label of ['Zoom out', 'Zoom in', 'Previous image', 'Next image']) assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.match(html, />Fit</);
  assert.match(html, />100%</);
  assert.match(html, /Third slide/);
  assert.match(html, />Copy</);
  assert.match(html, /Download PNG/);
  assert.match(html, />Close</);
  assert.match(html, /Use ← and → to move between images\./);
  assert.match(src('ui/content/ImagesResult.tsx'), /<DialogTitle>\{previewNav\(props\.target\.position, images\.length, props\.noun\)\.title\}<\/DialogTitle>/, 'the title is "Image 3 of 7" (WU05)');
  assert.match(src('ui/content/ImagesResult.tsx'), /<DialogDescription[^>]*>\{previewFacts\(image\)\}/, 'size, PNG size and composition id (WU05)');
  const second = await render(RESULT, 'ImagePreviewBody', { view: STATES.rendered, target: { round: 1, position: 2 }, onTarget: noop, onClose: noop });
  assert.match(second, /<i[^>]*>No alt text<\/i>/);
});

test('C11 a single image hides the nav and the hint; a previous-round image shows the read-only note', async () => {
  const single = await render(RESULT, 'ImagePreviewBody', { view: STATES.single, target: { round: 1, position: 1 }, onTarget: noop, onClose: noop });
  assert.doesNotMatch(single, /Previous image|Next image|Use ← and →/);
  const old = await render(RESULT, 'ImagePreviewBody', { view: STATES.previous, target: { round: 1, position: 1 }, onTarget: noop, onClose: noop });
  assert.match(old, /From round 1\. Read-only/);
  const first = await render(RESULT, 'ImagePreviewBody', { view: STATES.rendered, target: { round: 1, position: 1 }, onTarget: noop, onClose: noop });
  assert.match(first, /aria-label="Previous image"[^>]*disabled=""|disabled=""[^>]*aria-label="Previous image"/);
  assert.equal(await render(RESULT, 'ImagePreviewBody', { view: STATES.rendered, target: { round: 1, position: 9 }, onTarget: noop, onClose: noop }), '');
});

test('C12 the alt text list with Copy; an image without a line is No alt text in italics', async () => {
  const html = await pane('rendered');
  assert.match(html, /aria-label="Alt text"/);
  assert.match(html, />Copy alt text</);
  assert.match(html, /<li[^>]*>A red logo<\/li>/);
  assert.equal((html.match(/<i class="text-muted-foreground">No alt text<\/i>/g) ?? []).length, 5);
  assert.doesNotMatch(await pane('empty'), /aria-label="Alt text"/);
});

test('C13 previous rounds: a collapsed details with a thumbnail strip per round', async () => {
  const html = await pane('previous');
  assert.match(html, /<details[^>]*aria-label="Previous rounds"/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Round 1 · 7 images/);
  assert.equal((html.match(/aria-label="Open round 1 image \d"/g) ?? []).length, 7);
  assert.doesNotMatch(await pane('rendered'), /Previous rounds/);
});

test('C14 the footer row reads Image render with Stop', () => {
  const footer = src('ui/FooterListPopovers.tsx');
  assert.match(footer, /aria-label=\{runningStopLabel\(row, group\.projectName\)\}/);
  assert.match(src('lib/runningCommands.ts'), /: `Stop \$\{row\.name\}`\);/);
  assert.match(src('lib/runningCommands.ts'), /images: 'Image render'/);
});

test('C15 source pins: reuses PostSwitcher, StudioPaneView and the media preview zoom; no hidden attribute; the fade respects reduced motion', () => {
  const tab = src('ui/content/ImagesTab.tsx');
  const result = src('ui/content/ImagesResult.tsx');
  assert.match(tab, /<PostSwitcher /);
  assert.match(tab, /<StudioPaneView/);
  assert.match(result, /import \{ ZoomableImage \} from '.\/MediaPreviewDialog'/);
  assert.match(result, /zoom=\{zoom\} onZoom=\{setZoom\}/, 'the dialog holds the zoom, so next keeps it');
  assert.doesNotMatch(`${tab}${result}`, /\shidden[=\s{]/);
  assert.match(result, /motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150/);
  assert.match(src('ui/ContentStudioWorkspace.tsx'), /renderImages=\{\(conceptId, assetId\) => <ImagesPane key=\{assetId\} /);
  const routes = CONTENT_ROUTES.map(([m, r]) => `${m} ${r}`);
  for (const route of ['GET assets/:aid/images/rounds/:round/:file', 'GET assets/:aid/images/rounds/:round/images.zip', 'POST assets/:aid/images/renders/:rid/stop']) assert.ok(routes.includes(route), route);
});

test('setup and setup failure show in the agent column', async () => {
  assert.match(await pane('setup'), /Setting up Remotion…/);
  assert.match(await pane('setupfail'), /Remotion setup failed: npm exited with code 1/);
  assert.match(await pane('ended'), /Session ended/);
  assert.match(await pane('rendered', { initialPreview: { round: 1, position: 1 } }), /data-images-state="rendered"/);
});

test('C04b images tab, blocked: the reason, the shared hint and an enabled Start; while Remotion sets up the setup note replaces the reason', async () => {
  const html = await pane('empty', { view: { ...STATES.empty, session: null, blockedReason: 'No default coding agent is set.' }, blocked: 'No default coding agent is set.' });
  assert.match(html, /No default coding agent is set\./);
  assert.match(html, /default coding agent from the footer/);
  assert.ok(button(html, 'Start') && !disabledButton(html, 'Start'));
  assert.doesNotMatch(html, /TERMINAL:/);
  const setting = await render(VIEW, 'ImagesPaneView', props({ ...STATES.empty, session: null, images: { ...STATES.empty.images, setup: { status: 'running', error: null, percent: 40 } } }));
  assert.match(setting, /Setting up Remotion/);
  assert.doesNotMatch(setting, /No default coding agent/);
});
