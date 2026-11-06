import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
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

const rules = await import('../src/lib/contentRules.ts');
const { assetLabel, missingMessage } = await import('../src/lib/contentView.ts');
const { KIND_LABELS } = await import('../src/lib/contentRetro.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { buildRunningGroups } = await import('../src/lib/runningCommands.ts');
const { queuedImagesText } = await import('../src/lib/contentImages.ts');
const { useContentStore } = await import('../src/store/contentStore.ts');

/** The web side of the thumbnail asset (task 37.004): the rules copy, labels, the Publish dialog row, the footer job and the studio event. The Thumbnail tab is a later task. */

const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const noop = () => {};

test('TW01 the rules copy: thumbnail is an asset kind, held by the Concept, needed by video and reel posts only', () => {
  assert.ok(rules.ASSET_KINDS.includes('thumbnail'));
  assert.deepEqual(rules.CONCEPT_ASSET_KINDS, ['script', 'video', 'thumbnail']);
  for (const [p, f] of [['linkedin', 'video'], ['x', 'video'], ['facebook', 'video'], ['instagram', 'reel']]) assert.deepEqual(rules.assetsNeeded(p, f), ['post-text', 'video', 'thumbnail'], `${p}/${f}`);
  for (const [p, f] of [['linkedin', 'text'], ['instagram', 'carousel'], ['blog', 'article']]) assert.ok(!rules.assetsNeeded(p, f).includes('thumbnail'), `${p}/${f}`);
});

test('TW02 labels: "Thumbnail" everywhere, and in the not-ready message', () => {
  assert.equal(assetLabel('thumbnail'), 'Thumbnail');
  assert.equal(assetLabel('thumbnail', 'instagram'), 'Thumbnail');
  assert.equal(KIND_LABELS.thumbnail, 'Thumbnail');
  assert.equal(missingMessage(['video', 'thumbnail'], 'linkedin'), 'Not ready: Video, Thumbnail not finalized');
});

test('TW03 the thumbnail download URL', () => {
  assert.match(contentApi.thumbnailUrl('b1', 'c1', 'p1'), /\/api\/projects\/b1\/content\/concepts\/c1\/posts\/p1\/media\/thumbnail$/);
});

const urls = { image: (i) => `/img/${i}`, zip: '/zip', video: '/video', thumbnail: '/thumb' };
const post = (format) => ({ id: 'p1', conceptId: 'c1', platform: 'linkedin', format, scheduledAt: '2026-10-27T09:00:00.000Z', status: 'finalized', note: null, createdAt: '2026-10-26T09:00:00.000Z', needs: [], publishedAt: null, liveUrl: null, stats: null });
const form = (media, format = 'video') => render('src/ui/content/PublishDialog.tsx', 'PublishForm', {
  post: post(format), mode: 'publish', media, urls, timeZone: 'UTC', url: '', at: '2026-10-26T11:00', errors: {}, error: null, pending: false, readOnly: false,
  onUrl: noop, onAt: noop, onCopy: noop, onSubmit: noop, onCancel: noop,
});

test('TW04/TW07 a video post\'s Publish dialog lists the thumbnail after the video, with its Download link', async () => {
  const html = await form({ text: 'Hello', images: null, video: { name: 'render-1.mp4', missing: false }, thumbnail: { name: 'thumb-02.png', missing: false } });
  assert.match(html, /aria-label="Thumbnail"/);
  assert.match(html, /<a[^>]*href="\/thumb"[^>]*download=""[^>]*aria-label="Download thumb-02.png"/);
  assert.match(html, /<span class="min-w-0 truncate">thumb-02.png<\/span>/);
  const order = ['aria-label="Text"', 'aria-label="Video"', 'aria-label="Thumbnail"'].map((s) => html.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], 'Text, Video, Thumbnail');
});

test('TW05 a missing thumbnail file shows "File missing" and no Download link', async () => {
  const html = await form({ text: null, images: null, video: null, thumbnail: { name: 'thumb-02.png', missing: true } });
  assert.match(html, /aria-label="Thumbnail"[\s\S]*File missing/);
  assert.doesNotMatch(html, /Download thumb-02.png/);
});

test('TW06 text and image posts have no Thumbnail section', async () => {
  const text = await form({ text: 'Hello', images: null, video: null, thumbnail: null }, 'text');
  assert.doesNotMatch(text, /Thumbnail/);
  const image = await form({ text: 'Hello', images: [{ index: 0, name: 'image-01.png', missing: false }], video: null, thumbnail: null }, 'image');
  assert.doesNotMatch(image, /Thumbnail/);
  assert.match(image, /aria-label="Images"/);
});

test('TW08/TW09 a thumbnail job in the footer: its name, progress, asset and Stop route', () => {
  const job = { id: 'j1', buildingId: 'b1', kind: 'thumbnail', status: 'running', startedAt: '2026-10-26T10:00:00Z', conceptId: 'c1', assetId: 'a1', renderId: 'tr1', done: 2, total: 3 };
  const [group] = buildRunningGroups({ projects: [{ id: 'b1', name: 'Acme' }], commandRunsById: {}, testRunsById: {}, contentJobsById: { j1: job } });
  assert.deepEqual(group.rows[0], {
    key: 'content:j1', kind: 'content', runId: 'tr1', projectId: 'b1', name: 'Thumbnail render', where: 'Content Studio', startedAt: '2026-10-26T10:00:00Z',
    startedByAgent: true, progress: '2 of 3 thumbnails', stoppable: true, contentKind: 'thumbnail', conceptId: 'c1', assetId: 'a1',
  });
  assert.match(src('ui/FooterListPopovers.tsx'), /row\.contentKind === 'thumbnail'\) return stopThumbnailRender\(row\.projectId, row\.assetId!, row\.runId\)/);
  assert.match(src('store/worldStore.ts'), /serverApi\.contentStopThumbnailRender\(projectId, assetId, renderId\)/);
  assert.match(src('lib/serverApi.ts'), /\/content\/assets\/\$\{encodeURIComponent\(assetId\)\}\/thumbnail\/renders\/\$\{encodeURIComponent\(renderId\)\}\/stop/);
});

test('TW10 an image call waiting behind a thumbnail render says so', () => {
  const call = { id: 'c', status: 'queued', compositionIds: ['x'], width: 1, height: 1, done: 0, total: 1, error: null, queuePosition: 1, waitingFor: { conceptTitle: 'Launch', kind: 'thumbnail' }, createdAt: '', finishedAt: null };
  assert.equal(queuedImagesText(call), 'Image render is queued. Waiting for a thumbnail render in this Building to finish (Concept "Launch"). One render runs at a time.');
});

test('TW12 the Overview names the thumbnail in a video post\'s needs and in the Concept assets', async () => {
  const asset = (kind, postId = null) => ({ id: `a-${kind}`, kind, postId, state: 'empty', content: null, finalizedAt: null, round: 0 });
  const reel = { ...post('reel'), platform: 'instagram', status: 'draft', needs: [asset('post-text', 'p1'), asset('video'), asset('thumbnail')] };
  const concept = { id: 'c1', title: 'Launch', brief: '', archived: false, createdAt: '', updatedAt: '', posts: [reel], assets: [asset('script'), asset('video'), asset('thumbnail')], progress: { finalized: 0, needed: 3 }, compositionId: null };
  const html = await render('src/ui/content/OverviewTab.tsx', 'OverviewTab', { projectId: 'b1', concept, missingByPost: {}, timeZone: 'UTC', readOnly: false, onChanged: noop });
  assert.match(html, /<span>Thumbnail<\/span>[\s\S]*?Not started/);
  assert.match(html, /<span class="w-16">Thumbnail<\/span>/);
});

test('TW13 the content store keeps a thumbnail asset\'s studio event with its thumbnail part', () => {
  const thumbnail = { setup: { status: 'ready', error: null, percent: null }, blockedReason: null, defaultSize: { width: 1280, height: 720 }, stills: ['thumb-a-x'], rounds: [], finalizeBlocked: null, final: null };
  const view = { rev: 10, conceptId: 'c-thumb', assetId: 'a-thumb', asset: { state: 'drafting', round: 1, finalizedAt: null, content: null }, session: null, rounds: [], skillWarning: null, blockedReason: null, retro: null, thumbnail };
  useContentStore.getState().applyStudioEvent({ type: 'studioAsset', buildingId: 'b1', view });
  assert.deepEqual(useContentStore.getState().studioByAsset['a-thumb'].thumbnail, thumbnail);
});
