import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { TSTATES, tcall, thumbnailView, tround } from './contentThumbnailFixtures.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const th = await import('../src/lib/contentThumbnail.ts');
const { CONCEPT_TABS, conceptTabStates } = await import('../src/lib/contentRules.ts');
const images = await import('../src/lib/contentImages.ts');
const { previewNav, stepPreview, queuedImagesText, gallerySlots, shownRound, altLines, altFor, altCopyText } = images;
const { assetStateLabel } = await import('../src/lib/contentView.ts');

/** The Thumbnail tab's pure rules (web/src/lib/contentThumbnail.ts, contentRules.ts). Case ids follow the Test Case Planning list (TU01…). */

const reasonOf = (formats, key = 'thumbnail', ctx) => conceptTabStates(formats.map((format) => ({ platform: 'linkedin', format })), ctx).find((t) => t.key === key);
const R = 'Add a video or reel post to use this tab';

test('TU01 Thumbnail sits right after Video in the tab list', () => {
  assert.deepEqual(CONCEPT_TABS.map((t) => t.key), ['overview', 'script', 'video', 'thumbnail', 'remotion', 'images', 'post-content', 'captions', 'blog']);
});

test('TU03-TU06 enabled for a video or reel post, with or without the script finalized', () => {
  assert.equal(reasonOf(['video']).enabled, true);
  assert.equal(conceptTabStates([{ platform: 'instagram', format: 'reel' }]).find((t) => t.key === 'thumbnail').enabled, true);
  assert.equal(reasonOf(['video'], 'thumbnail', { scriptFinalized: false }).enabled, true);
  assert.equal(reasonOf(['image', 'video']).enabled, true);
});

test('TU07/TU08 disabled with the reason for text, image, carousel, blog posts and no posts', () => {
  for (const formats of [['text'], ['image'], ['carousel'], ['article'], []]) assert.deepEqual(reasonOf(formats), { key: 'thumbnail', label: 'Thumbnail', enabled: false, reason: R }, formats.join());
});

test('TU09 the other tabs keep their states', () => {
  assert.equal(reasonOf(['video'], 'video').reason, 'Finalize the script to use this tab');
  assert.equal(reasonOf(['video'], 'remotion').reason, 'Start the video in the Video tab first');
  assert.equal(reasonOf(['text'], 'images').reason, 'Add an image or carousel post to use this tab');
});

test('TU11-TU21 thumbnailState names each pane state', () => {
  const expected = { empty: 'empty', rendering: 'rendering', queued: 'queued', rendered: 'rendered', failed: 'failed', stopped: 'stopped', finalized: 'finalized', setup: 'setup', setupfail: 'setupfail' };
  for (const [name, state] of Object.entries(expected)) assert.equal(th.thumbnailState(TSTATES[name]), state, name);
  assert.equal(th.thumbnailState(null), 'loading');
});

test('TU22-TU26 the Finalize hint: read-only, ended session, the server reason, then the missing pick', () => {
  const view = TSTATES.rendered;
  assert.equal(th.thumbnailFinalizeHint(view, false, 'RO', null), th.CHOOSE_THUMBNAIL_HINT);
  assert.equal(th.thumbnailFinalizeHint(view, false, 'RO', 'thumb-02.png'), null);
  assert.equal(th.thumbnailFinalizeHint(view, true, 'RO', 'thumb-02.png'), 'RO');
  assert.equal(th.thumbnailFinalizeHint(TSTATES.rendering, false, 'RO', 'thumb-01.png'), 'Finalize is available once the render finishes.');
  assert.equal(th.thumbnailFinalizeHint({ ...view, session: { ...view.session, state: 'ended' } }, false, 'RO', 'thumb-01.png'), 'Resume the session to finalize.');
  assert.equal(th.thumbnailFinalizeHint(TSTATES.finalized, false, 'RO', null), null);
});

test('TU27-TU30 the pick is kept in its round and file set; a lone variant is preselected', () => {
  const view = TSTATES.rendered;
  assert.equal(th.effectiveChoice({ round: 1, name: 'thumb-02.png' }, view), 'thumb-02.png');
  assert.equal(th.effectiveChoice({ round: 2, name: 'thumb-02.png' }, view), null, 'a new round clears it');
  const fewer = thumbnailView({ rounds: [tround(1, tcall({ total: 2, done: 2 }), 2)] });
  assert.equal(th.effectiveChoice({ round: 1, name: 'thumb-03.png' }, fewer), null, 'a re-render with fewer variants');
  assert.equal(th.effectiveChoice(null, TSTATES.single), 'thumb-01.png');
  assert.equal(th.effectiveChoice(null, view), null);
  assert.equal(th.effectiveChoice({ round: 1, name: 'thumb-02.png' }, TSTATES.finalized), null);
  assert.equal(th.effectiveChoice(null, null), null);
});

test('TU32-TU34 tile ratio and size caption come from the real size', () => {
  assert.equal(th.tileRatio({ width: 1280, height: 720 }), '1280 / 720');
  assert.equal(th.tileRatio({ width: 1080, height: 1920 }), '1080 / 1920');
  assert.equal(th.tileRatio({ width: 1080, height: 1080 }), '1080 / 1080');
  for (const bad of [{ width: 0, height: 720 }, { width: 1280, height: 0 }, {}]) assert.equal(th.tileRatio(bad), '16 / 9');
  assert.equal(th.sizeCaption({ width: 7680, height: 4320 }), '7680 × 4320');
  assert.equal(th.sizeCaption({ width: 65535, height: 65535 }), '65535 × 65535');
});

test('TU35 the size line counts variants', () => {
  assert.equal(th.thumbnailSizeLine(TSTATES.rendered), '1280 × 720 · 3 variants');
  assert.equal(th.thumbnailSizeLine(TSTATES.single), '1280 × 720 · 1 variant');
  assert.equal(th.thumbnailSizeLine(TSTATES.empty), '1280 × 720');
  assert.equal(th.thumbnailSizeLine({ ...TSTATES.empty, thumbnail: undefined }), null);
});

test('TU36 gallery slots for 1, 3 and 5 stills', () => {
  for (const [name, n] of [['single', 1], ['rendered', 3], ['five', 5]]) assert.equal(gallerySlots(shownRound(th.thumbnailAsImages(TSTATES[name]))).length, n, name);
  const slots = gallerySlots(shownRound(th.thumbnailAsImages(TSTATES.rendering)));
  assert.deepEqual(slots.map((s) => s.kind), ['done', 'rendering', 'waiting']);
  assert.deepEqual(gallerySlots(shownRound(th.thumbnailAsImages(TSTATES.failed))).map((s) => s.kind), ['done', 'missing', 'missing']);
});

test('TU37 the shown round is the current one; previous rounds are newest first, empty ones left out', () => {
  const adapted = th.thumbnailAsImages(TSTATES.previous);
  assert.equal(images.shownRound(adapted).round, 2);
  assert.deepEqual(images.previousImageRounds(adapted).map((r) => r.round), [1]);
  assert.equal(images.shownRound(th.thumbnailAsImages(TSTATES.empty)), null);
  const emptyOld = thumbnailView({ asset: { round: 3 }, rounds: [tround(3, tcall(), 3), tround(2, tcall({ done: 0 }), 0), tround(1, tcall(), 3)] });
  assert.deepEqual(images.previousImageRounds(th.thumbnailAsImages(emptyOld)).map((r) => r.round), [1]);
});

test('TU38/TU39 rendering and queue texts', () => {
  assert.equal(th.renderingThumbnailText(tcall({ done: 1, total: 3 })), 'Rendering thumbnail 2 of 3…');
  assert.equal(th.renderingThumbnailText(tcall({ done: 3, total: 3 })), 'Rendering thumbnail 3 of 3…');
  for (const [kind, what] of [['video', 'a video render'], ['images', 'an image render'], ['thumbnail', 'a thumbnail render']]) {
    assert.match(queuedImagesText(tcall({ waitingFor: { conceptTitle: 'X', kind } })), new RegExp(`Waiting for ${what}`));
  }
});

test('TU41 alt lines: one per variant, blanks, long unbroken text, copy text', () => {
  const lines = altLines(th.thumbnailAsImages(TSTATES.rendered));
  assert.deepEqual(lines, ['Bold title on blue', 'Portrait of the host', 'Product on white']);
  assert.equal(altFor(['a', ' '], 2), null);
  const long = 'x'.repeat(500);
  assert.equal(altFor([long], 1), long);
  assert.equal(altCopyText(lines), lines.join('\n'));
  assert.deepEqual(altLines(th.thumbnailAsImages(TSTATES.empty)), []);
});

test('TU25-TU26 preview navigation says thumbnail', () => {
  assert.equal(previewNav(1, 3, 'thumbnail').title, 'Thumbnail 1 of 3');
  assert.equal(previewNav(1, 1, 'thumbnail').title, 'Single thumbnail');
  assert.equal(previewNav(1, 3).title, 'Image 1 of 3');
  assert.deepEqual([stepPreview(1, 3, 'ArrowLeft'), stepPreview(3, 3, 'ArrowRight'), stepPreview(2, 3, 'ArrowRight')], [1, 3, 3]);
});

const post = (id, format, status = 'draft', needs = []) => ({ id, platform: 'linkedin', format, status, needs });
test('TU42 Reopen is blocked only by a published post that needs the thumbnail', () => {
  const t = { id: 't1', kind: 'thumbnail', state: 'finalized' };
  assert.equal(th.thumbnailReopenBlock({ posts: [post('p1', 'video', 'published', [t])] }, 't1'), 'Used by a published post');
  assert.equal(th.thumbnailReopenBlock({ posts: [post('p1', 'video', 'draft', [t]), post('p2', 'reel', 'finalized', [t])] }, 't1'), null);
  assert.equal(th.thumbnailReopenBlock({ posts: [post('p3', 'image', 'published', [{ id: 'i1' }])] }, 't1'), null);
});

test('TU43/TU44 the thumbnail asset and its Overview row exist only for video and reel Concepts', () => {
  const t = { id: 't1', kind: 'thumbnail', state: 'drafting' };
  const s = { id: 's1', kind: 'script', state: 'empty' };
  assert.equal(th.thumbnailAssetOf({ posts: [post('p1', 'image')], assets: [s, t] }), null);
  assert.equal(th.thumbnailAssetOf({ posts: [post('p1', 'reel')], assets: [s, t] }), t);
  assert.equal(th.thumbnailAssetOf({ posts: [post('p1', 'video')], assets: [s] }), null);
  assert.deepEqual(th.conceptAssets({ posts: [post('p1', 'image')], assets: [s, t] }), [s]);
  assert.deepEqual(th.conceptAssets({ posts: [post('p1', 'video')], assets: [s, t] }), [s, t]);
  assert.deepEqual(['empty', 'drafting', 'finalized'].map(assetStateLabel).length, 3);
});

test('TU45 an unchanged thumbnail part keeps its reference', () => {
  const part = TSTATES.rendered.thumbnail;
  assert.equal(th.shareThumbnail(part, JSON.parse(JSON.stringify(part))), part);
  const changed = { ...part, finalizeBlocked: 'x' };
  assert.equal(th.shareThumbnail(part, changed), changed);
  assert.equal(th.shareThumbnail(undefined, part), part);
});

test('TU47 the finalized view carries the final file; a part-less view has no images part', () => {
  assert.equal(TSTATES.finalized.thumbnail.final.name, 'thumb-02.png');
  assert.equal(th.thumbnailAsImages(null), null);
  const bare = { ...TSTATES.empty, thumbnail: undefined };
  assert.equal(th.thumbnailAsImages(bare), bare);
  assert.equal(th.thumbnailState(bare), 'loading');
});

test('TU48 failedText names the noun and counts it', () => {
  assert.equal(images.failedText(tcall({ status: 'stopped', done: 1 }), 'thumbnail'), 'The render was stopped after 1 thumbnail.');
  assert.equal(images.failedText(tcall({ status: 'stopped', done: 2 }), 'thumbnail'), 'The render was stopped after 2 thumbnails.');
  assert.equal(images.failedText(tcall({ status: 'stopped', done: 2 })), 'The render was stopped after 2 images.');
  assert.equal(images.failedText(tcall({ status: 'failed', error: 'image 2 timed out' }), 'thumbnail'), 'The render failed: image 2 timed out.');
});

test('TU49 singleFlight drops a call made while another is in flight, then runs again', async () => {
  const run = th.singleFlight();
  let release;
  let calls = 0;
  const work = () => { calls += 1; return new Promise((resolve) => { release = () => resolve('done'); }); };
  const first = run(work);
  assert.equal(await run(work), null);
  release();
  assert.equal(await first, 'done');
  assert.equal(calls, 1);
  const second = run(work);
  release();
  assert.equal(await second, 'done');
  await assert.rejects(run(async () => { throw new Error('x'); }), /x/);
  assert.equal(await run(async () => 1), 1, 'a failed run frees the slot');
});
