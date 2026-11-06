import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { call, imagesView, round, STATES } from './contentImagesFixtures.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const im = await import('../src/lib/contentImages.ts');
const { clampZoom, zoomBy, zoomFit, ZOOM_MAX, ZOOM_MIN } = await import('../src/lib/contentVideo.ts');
const { buildRunningGroups, CONTENT_JOB_NAMES } = await import('../src/lib/runningCommands.ts');
const { conceptTabStates } = await import('../src/lib/contentRules.ts');

/** The Images tab's pure rules (web/src/lib/contentImages.ts). Case ids follow the Test Case Planning list (WU01…). */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contentImageCases.json', import.meta.url), 'utf8'));
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('WU01 the size table equals the server copy (shared fixture; the server test pins the Finalize cases)', () => {
  for (const { platform, format, size } of fixture.sizes) assert.deepEqual(im.defaultImageSize(platform, format), size, `${platform} ${format}`);
  for (const { platform, format } of fixture.noSize) assert.equal(im.defaultImageSize(platform, format), null);
  const pairs = Object.entries(im.IMAGE_SIZES).flatMap(([p, f]) => Object.keys(f).map((x) => `${p}/${x}`)).sort();
  assert.deepEqual(pairs, fixture.sizes.map((s) => `${s.platform}/${s.format}`).sort());
  assert.equal(im.imageRange('linkedin', 'text'), null);
});

test('WU02 the size line: default, custom, requested while rendering, made of asked after a failure; none before a render', () => {
  assert.equal(im.sizeLine(STATES.rendered), '7 images · 1080 × 1350 px · Instagram carousel default');
  assert.equal(im.sizeLine(imagesView({ rounds: [round(1, call({ width: 1200 }), 7)] })), '7 images · 1200 × 1350 px · Custom size');
  assert.equal(im.sizeLine(STATES.rendering), '7 images requested · 1080 × 1350 px · Instagram carousel default');
  assert.equal(im.sizeLine(STATES.failed), '4 of 7 images · 1080 × 1350 px · Instagram carousel default');
  assert.equal(im.sizeLine(STATES.single), '1 image · 1080 × 1350 px · Instagram image default');
  assert.equal(im.sizeLine(STATES.empty), null);
  assert.equal(im.sizeLine({ ...STATES.empty, images: undefined }), null);
});

test('WU03 Finalize eligibility and the hint in every state', () => {
  const ro = 'Read-only';
  assert.equal(im.imagesFinalizeHint(STATES.empty, false, ro), 'Finalize needs a rendered set: 2 to 20 images for an Instagram carousel.');
  assert.equal(im.imagesFinalizeHint(STATES.rendering, false, ro), 'Finalize is available once the render finishes.');
  assert.equal(im.imagesFinalizeHint(STATES.queued, false, ro), 'Finalize is available once the render finishes.');
  assert.equal(im.imagesFinalizeHint(STATES.misfit, false, ro), 'An X image post takes 1 to 4 images; this round has 5.');
  assert.match(im.imagesFinalizeHint(STATES.failed, false, ro), /no complete set/);
  assert.match(im.imagesFinalizeHint(STATES.stopped, false, ro), /no complete set/);
  assert.equal(im.imagesFinalizeHint(STATES.rendered, false, ro), null);
  assert.equal(im.imagesFinalizeHint(STATES.finalized, false, ro), null);
  assert.equal(im.imagesFinalizeHint(STATES.rendered, true, ro), ro);
  assert.equal(im.imagesFinalizeHint(STATES.ended, false, ro), 'Resume the session to finalize.');
  assert.equal(im.imagesFinalizeHint({ ...STATES.rendered, images: undefined }, false, ro), null);
  // The daemon's reason wins even where the call looks complete (a finished call whose files went missing on disk).
  const missing = { ...STATES.rendered, images: { ...STATES.rendered.images, finalizeBlocked: 'The last render did not finish, so there is no complete set. Render again to finalize.' } };
  assert.match(im.imagesFinalizeHint(missing, false, ro), /no complete set/);
  const states = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [k, im.imagesState(v)]));
  assert.deepEqual(states, { empty: 'empty', rendering: 'rendering', queued: 'queued', rendered: 'rendered', misfit: 'rendered', failed: 'failed', stopped: 'stopped', finalized: 'finalized', setup: 'setup', setupfail: 'setupfail', ended: 'rendered', previous: 'rendered', single: 'rendered' });
  assert.equal(im.imagesState(null), 'loading');
});

test('WU04 gallery slots before and after a progress tick, and after a failure', () => {
  const kinds = (v) => im.gallerySlots(im.shownRound(v)).map((s) => s.kind);
  assert.deepEqual(kinds(STATES.rendering), ['done', 'done', 'done', 'rendering', 'waiting', 'waiting', 'waiting']);
  const tick = imagesView({ rounds: [round(1, call({ status: 'running', done: 4, finishedAt: null }), 4)] });
  assert.deepEqual(kinds(tick), ['done', 'done', 'done', 'done', 'rendering', 'waiting', 'waiting']);
  assert.deepEqual(kinds(STATES.failed), ['done', 'done', 'done', 'done', 'missing', 'missing', 'missing']);
  assert.deepEqual(kinds(STATES.queued), Array(7).fill('waiting'));
  assert.deepEqual(kinds(STATES.rendered), Array(7).fill('done'));
  assert.deepEqual(im.gallerySlots(null), []);
  assert.deepEqual(im.gallerySlots({ round: 1, call: null, images: [], zipUrl: null }), []);
  const c = im.shownRound(STATES.rendering).call;
  assert.equal(im.renderingText(c), 'Rendering image 4 of 7');
  assert.equal(im.renderingDetail(c), '3 of 7 done · still-abc-slide-4');
  assert.equal(im.queuedImagesText(im.shownRound(STATES.queued).call), 'Image render is queued. Waiting for a video render in this Building to finish (Concept "Spring reel"). One render runs at a time.');
  assert.equal(im.queuedImagesText({ ...c, waitingFor: { conceptTitle: 'X', kind: 'images' } }), 'Image render is queued. Waiting for an image render in this Building to finish (Concept "X"). One render runs at a time.');
  assert.equal(im.failedText(im.shownRound(STATES.failed).call), 'The render failed: image 5 (still-abc-slide-5) timed out after 60 seconds.');
  assert.equal(im.failedText(im.shownRound(STATES.stopped).call), 'The render was stopped after 2 images.');
  assert.equal(im.tileCaption({ index: 3, width: 1080, height: 1350 }), '3 · 1080 × 1350');
});

test('WU05 preview navigation: no wrap, ← and → clamp at the ends, a single image has no nav', () => {
  assert.deepEqual(im.previewNav(1, 7), { title: 'Image 1 of 7', hasPrevious: false, hasNext: true, single: false });
  assert.deepEqual(im.previewNav(7, 7), { title: 'Image 7 of 7', hasPrevious: true, hasNext: false, single: false });
  assert.deepEqual(im.previewNav(1, 1), { title: 'Single image', hasPrevious: false, hasNext: false, single: true });
  assert.equal(im.stepPreview(7, 7, 'ArrowRight'), 7);
  assert.equal(im.stepPreview(1, 7, 'ArrowLeft'), 1);
  assert.equal(im.stepPreview(3, 7, 'ArrowRight'), 4);
  assert.equal(im.stepPreview(3, 7, 'Enter'), 3);
  // The zoom mode is held by the dialog, not the image, so moving on keeps it (the component pins the wiring, C15).
  const zoomed = zoomBy(zoomFit(1), 1.25);
  const afterNext = { ...zoomed };
  assert.deepEqual(afterNext, zoomed);
  assert.equal(im.previewFacts(im.shownRound(STATES.rendered).images[2]), '1080 × 1350 px · 402 KB · still-abc-slide-3');
  assert.equal(im.formatPngSize(3_500_000), '3.3 MB');
});

test('WU06 zoom is clamped to 10% and 800%', () => {
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  assert.equal(clampZoom(99), ZOOM_MAX);
  let z = zoomFit(1);
  for (let i = 0; i < 40; i++) z = zoomBy(z, 1.25);
  assert.equal(z.scale, 8);
  for (let i = 0; i < 80; i++) z = zoomBy(z, 0.8);
  assert.equal(z.scale, 0.1);
});

test('WU07 alt text lines map to images; a missing line is No alt text; Copy keeps the order; extra lines are ignored on tiles', () => {
  const lines = im.altLines(STATES.rendered);
  assert.deepEqual(lines, ['A red logo', '', 'Third slide']);
  assert.equal(im.altFor(lines, 1), 'A red logo');
  assert.equal(im.altFor(lines, 2), null);
  assert.equal(im.altFor(lines, 9), null);
  assert.equal(im.altCopyText(lines), 'A red logo\n\nThird slide');
  assert.deepEqual(im.altLines(STATES.empty), []);
  assert.equal(im.NO_ALT_TEXT, 'No alt text');
  const prev = imagesView({ asset: { round: 2 }, previousAlt: { 1: 'Old one' } });
  assert.deepEqual(im.altLines(prev, 1), ['Old one']);
});

const post = (id, platform, format, state = 'empty') => ({ id, conceptId: 'c1', platform, format, scheduledAt: '2026-11-03T09:00:00Z', status: 'draft', note: null, createdAt: '', needs: [{ id: `${id}-t`, kind: 'post-text', state: 'empty' }, ...(format === 'image' || format === 'carousel' ? [{ id: `${id}-i`, kind: 'image-set', state }] : [])] });

test('WU08 the switcher: image and carousel posts of every platform; opens on the first not finalized; a deleted post falls back', () => {
  const posts = [post('p0', 'linkedin', 'text'), post('p1', 'instagram', 'carousel', 'finalized'), post('p2', 'x', 'image'), post('p3', 'facebook', 'carousel'), post('p4', 'linkedin', 'image')];
  assert.deepEqual(im.imagePosts(posts).map((p) => p.id), ['p1', 'p2', 'p3', 'p4']);
  const shown = im.imagePosts(posts);
  assert.equal(im.defaultImagePostId(shown), 'p2');
  assert.equal(im.defaultImagePostId(shown.map((p) => ({ ...p, needs: p.needs.map((a) => ({ ...a, state: 'finalized' })) }))), 'p1');
  assert.equal(im.defaultImagePostId([]), null);
  assert.equal(im.selectedImagePostId(shown, 'p1'), 'p1', 'finalizing keeps the selection');
  assert.equal(im.selectedImagePostId(shown, 'gone'), 'p2');
  assert.deepEqual(im.imageChipModel(shown[0]), { id: 'p1', platform: 'instagram', platformLabel: 'Instagram', format: 'Carousel', scheduledAt: '2026-11-03T09:00:00Z', state: 'finalized', stateLabel: 'Finalized' });
  assert.equal(im.imageSwitcherLabel(1), 'Image and carousel posts · 1 post');
  assert.equal(im.imageSwitcherLabel(4), 'Image and carousel posts · 4 posts');
  assert.deepEqual(im.imageContextLine(shown[1]), { title: 'X (Twitter) · Image', rest: '1600 × 900 px · 1 to 4 images' });
  assert.equal(im.imageSetOf(posts[0]), undefined);
});

test('WU09 the footer row: Image render, "3 of 7 images", stoppable, started by the agent, queued jobs not listed; Stop uses the images route', () => {
  assert.equal(CONTENT_JOB_NAMES.images, 'Image render');
  const job = (over) => ({ id: 'j1', buildingId: 'b1', kind: 'images', status: 'running', startedAt: '2026-10-26T10:00:00Z', conceptId: 'c1', assetId: 'a1', renderId: 'ir1', done: 3, total: 7, ...over });
  const [group] = buildRunningGroups({ projects: [{ id: 'b1', name: 'Acme' }], commandRunsById: {}, testRunsById: {}, contentJobsById: { j1: job() } });
  assert.deepEqual(group.rows[0], {
    key: 'content:j1', kind: 'content', runId: 'ir1', projectId: 'b1', name: 'Image render', where: 'Content Studio', startedAt: '2026-10-26T10:00:00Z',
    startedByAgent: true, progress: '3 of 7 images', stoppable: true, contentKind: 'images', conceptId: 'c1', assetId: 'a1',
  });
  assert.deepEqual(buildRunningGroups({ projects: [{ id: 'b1', name: 'Acme' }], commandRunsById: {}, testRunsById: {}, contentJobsById: { j1: job({ status: 'complete' }) } }), []);
  const video = buildRunningGroups({ projects: [{ id: 'b1', name: 'Acme' }], commandRunsById: {}, testRunsById: {}, contentJobsById: { v: { id: 'v', buildingId: 'b1', kind: 'render', status: 'running', startedAt: '', conceptId: 'c1', renderId: 'r1', percent: 46 } } })[0].rows[0];
  assert.deepEqual([video.progress, video.assetId], ['46%', undefined]);
  const footer = src('ui/FooterListPopovers.tsx');
  assert.match(footer, /row\.assetId \? stopImageRender\(row\.projectId, row\.assetId, row\.runId\)/);
  assert.match(src('store/worldStore.ts'), /serverApi\.contentStopImageRender\(projectId, assetId, renderId\)/);
});

test('WU10 the Images tab is enabled with an image or carousel post and disabled with its reason otherwise; it is not Coming soon', () => {
  const tabs = (posts) => conceptTabStates(posts, { scriptFinalized: false }).find((t) => t.key === 'images');
  assert.deepEqual(tabs([{ platform: 'linkedin', format: 'carousel' }]), { key: 'images', label: 'Images', enabled: true, reason: null });
  assert.deepEqual(tabs([{ platform: 'linkedin', format: 'text' }]), { key: 'images', label: 'Images', enabled: false, reason: 'Add an image or carousel post to use this tab' });
  assert.match(src('ui/content/ConceptView.tsx'), /imagesTab\s*\? <ImagesTab /);
});

test('WU11 the stop routes build their path from ids with encodeURIComponent', () => {
  assert.match(src('lib/contentApi.ts'), /assets\/\$\{encodeURIComponent\(aid\)\}\/images\/renders\/\$\{encodeURIComponent\(rid\)\}\/stop/);
  assert.match(src('lib/serverApi.ts'), /content\/assets\/\$\{encodeURIComponent\(assetId\)\}\/images\/renders\/\$\{encodeURIComponent\(renderId\)\}\/stop/);
});

test('shareImages keeps an unchanged images part and replaces a changed one', () => {
  const a = STATES.rendered.images;
  assert.equal(im.shareImages(a, structuredClone(a)), a);
  const changed = { ...structuredClone(a), finalizeBlocked: 'x' };
  assert.equal(im.shareImages(a, changed), changed);
  assert.equal(im.shareImages(undefined, changed), changed);
  assert.deepEqual(im.previousImageRounds(STATES.previous).map((r) => r.round), [1]);
});
