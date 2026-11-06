import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetView, ConceptView, PostView } from '../src/content/concepts.ts';
import { assetsNeeded, ASSET_KINDS, isConceptAssetKind } from '../src/content/rules.ts';
import type { AssetKind, AssetState, Platform } from '../src/content/rules.ts';
import { assetsToStart, kindsToStartAfter, START_RULES } from '../src/content/studioDependencies.ts';
import { studioTabFor } from '../src/content/studioTabs.ts';

/** The dependency table that says which assets start after an upstream asset is finalized (pure). */

let n = 0;
const asset = (kind: AssetKind, postId: string | null, state: AssetState = 'empty'): AssetView => ({ id: `a${++n}`, kind, postId, state, content: null, finalizedAt: null, round: 0 });
/** The video and thumbnail are shared by every post that needs them; `thumbnailState` sets the thumbnail's own state. */
function concept(posts: [Platform, string][], state: AssetState = 'empty', thumbnailState: AssetState = state): ConceptView {
  const shared = { video: asset('video', null, state), thumbnail: asset('thumbnail', null, thumbnailState) } as Record<string, AssetView>;
  const views = posts.map(([platform, format], i): PostView => {
    const id = `p${i}`;
    const needs = assetsNeeded(platform, format).map((kind) => (isConceptAssetKind(kind) ? shared[kind]! : asset(kind, id, state)));
    return { id, conceptId: 'c', platform, format, scheduledAt: '', status: 'draft', note: null, createdAt: '', needs, publishedAt: null, liveUrl: null, stats: null, result: null, externalAssets: null };
  });
  return { id: 'c', title: '', brief: '', archived: false, imported: false, createdAt: '', updatedAt: '', posts: views, assets: [asset('script', null), shared.video!, shared.thumbnail!], progress: { finalized: 0, needed: 0 }, compositionId: null };
}
const never = () => false;
const kinds = (c: ConceptView, hasSession: (id: string) => boolean = never) => assetsToStart(c, 'script', hasSession).map((s) => s.kind);

test('U1/TU19 the script rule starts the video, post text, article, image set and thumbnail; the video starts the thumbnail', () => {
  assert.deepEqual(kindsToStartAfter('script'), ['video', 'post-text', 'article', 'image-set', 'thumbnail']);
  assert.deepEqual(kindsToStartAfter('video'), ['thumbnail']);
});

test('U2 finalizing a post text, article, image set or thumbnail starts nothing', () => {
  for (const kind of ['post-text', 'article', 'image-set', 'thumbnail'] as const) assert.deepEqual(kindsToStartAfter(kind), [], kind);
});

test('U3 an unknown trigger kind gives no rules', () => {
  assert.deepEqual(kindsToStartAfter('nothing' as AssetKind), []);
  assert.deepEqual(kindsToStartAfter('' as AssetKind), []);
});

test('U4 an added rule is found through the same lookup', () => {
  const rules = [...START_RULES, { after: 'thumbnail' as const, start: 'article' as const }];
  assert.deepEqual(kindsToStartAfter('thumbnail', rules), ['article']);
  assert.deepEqual(kindsToStartAfter('script', rules), kindsToStartAfter('script'));
});

test('U5 table integrity: no duplicates, no self-start, every started kind has a pane', () => {
  const keys = START_RULES.map((r) => `${r.after}>${r.start}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const rule of START_RULES) {
    assert.notEqual(rule.after, rule.start);
    assert.ok(ASSET_KINDS.includes(rule.after) && ASSET_KINDS.includes(rule.start));
    // image-set and post-text panes are per platform, so test with a platform each covers.
    assert.ok(studioTabFor(rule.start, isConceptAssetKind(rule.start) ? null : 'linkedin') ?? studioTabFor(rule.start, 'blog'), rule.start);
  }
});

test('U6/TU21 empty assets without a session are picked, in the posts\' order with the video and thumbnail once', () => {
  const c = concept([['linkedin', 'text'], ['instagram', 'reel'], ['blog', 'article'], ['linkedin', 'carousel'], ['facebook', 'video']]);
  assert.deepEqual(kinds(c), ['post-text', 'post-text', 'video', 'thumbnail', 'article', 'post-text', 'image-set', 'post-text']);
});

test('TU20 after the video: the empty thumbnail once across two video posts; never a started one, never without a video post', () => {
  const after = (c: ConceptView, hasSession: (id: string) => boolean = never) => assetsToStart(c, 'video', hasSession).map((s) => s.kind);
  const two = concept([['linkedin', 'video'], ['instagram', 'reel']], 'finalized', 'empty');
  assert.deepEqual(after(two), ['thumbnail']);
  assert.deepEqual(after(concept([['linkedin', 'video']], 'finalized', 'drafting')), []);
  assert.deepEqual(after(concept([['linkedin', 'video']], 'finalized', 'finalized')), []);
  const thumb = two.assets.find((a) => a.kind === 'thumbnail')!;
  assert.deepEqual(after(two, (id) => id === thumb.id), []);
  // A thumbnail kept after its last video post was deleted is in no post's needs, so nothing starts it.
  assert.deepEqual(after(concept([['linkedin', 'text']])), []);
});

test('U7/U8 drafting and finalized assets are skipped', () => {
  assert.deepEqual(kinds(concept([['linkedin', 'text'], ['blog', 'article']], 'drafting')), []);
  assert.deepEqual(kinds(concept([['linkedin', 'carousel'], ['instagram', 'reel']], 'finalized')), []);
});

test('U9 an empty asset that already has a session record is skipped', () => {
  const c = concept([['linkedin', 'text'], ['blog', 'article']]);
  const [first] = c.posts[0]!.needs;
  assert.deepEqual(kinds(c, (id) => id === first!.id), ['article']);
});

test('U10 an asset kind with no pane is skipped, and a Concept without a video post does not pick the video', () => {
  const c = concept([['linkedin', 'text']]);
  assert.deepEqual(kinds(c), ['post-text']);
  const noPane = concept([['linkedin', 'text']]);
  noPane.posts[0]!.needs.push(asset('script', 'p0'));
  assert.deepEqual(assetsToStart(noPane, 'script', never, [{ after: 'script', start: 'script' }]), []);
});

test('U11 the order is stable across calls', () => {
  const c = concept([['instagram', 'reel'], ['linkedin', 'carousel']]);
  assert.deepEqual(assetsToStart(c, 'script', never), assetsToStart(c, 'script', never));
  assert.equal(assetsToStart(c, 'script', never)[0]!.kind, 'post-text');
});
