import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';
import { createElement } from 'react';
import { loadModule, render } from './renderHelper.mjs';

/** The Post content, Captions and Blog tabs: pure helpers (W), the store through the stand-in (S) and static renders (C). */

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const tabs = await import('../src/lib/contentPostTabs.ts');
const limits = await import('../src/lib/contentLimits.ts');
const { useContentStore } = await import('../src/store/contentStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const CASES = JSON.parse(readFileSync(new URL('./fixtures/contentTextCases.json', import.meta.url), 'utf8'));
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const NOW = Date.parse('2026-10-26T10:00:00Z');
const ISO = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();
const textKind = (platform) => (platform === 'blog' ? 'article' : 'post-text');
const post = (id, platform, format, state = 'empty', over = {}) => ({
  id, conceptId: 'c1', platform, format, scheduledAt: ISO(60 * 24), status: 'draft', note: null, createdAt: ISO(-100),
  needs: [{ id: `a-${id}`, kind: textKind(platform), postId: id, state, content: null, finalizedAt: null, round: state === 'empty' ? 0 : 1 }], ...over,
});
const concept = (posts) => ({ id: 'c1', title: 'Launch', brief: '', archived: false, createdAt: ISO(-100), updatedAt: ISO(-100), posts, assets: [{ id: 'a-script', kind: 'script', postId: null, state: 'empty', content: null, finalizedAt: null, round: 0 }], progress: { finalized: 0, needed: posts.length } });

// ---- W: pure helpers ----

test('W01 the posts each tab covers, in the Concept order', () => {
  const posts = [post('p1', 'instagram', 'reel'), post('p2', 'linkedin', 'image'), post('p3', 'blog', 'article'), post('p4', 'x', 'video'), post('p5', 'facebook', 'text'), post('p6', 'instagram', 'image')];
  assert.deepEqual(tabs.postsForTab(posts, 'post-content').map((p) => p.id), ['p2', 'p4', 'p5']);
  assert.deepEqual(tabs.postsForTab(posts, 'captions').map((p) => p.id), ['p1', 'p6']);
  assert.deepEqual(tabs.postsForTab(posts, 'blog').map((p) => p.id), ['p3']);
  assert.equal(tabs.isPostTextTab('captions'), true);
  assert.equal(tabs.isPostTextTab('script'), false);
});

test('W02/W03 the default selection: first text not finalized, else the first; the text state decides, not the post status', () => {
  const a = post('a', 'linkedin', 'text', 'finalized', { status: 'draft' });
  const b = post('b', 'x', 'text', 'drafting', { status: 'finalized' });
  assert.equal(tabs.defaultPostId([a, b]), 'b');
  assert.equal(tabs.defaultPostId([a, post('c', 'facebook', 'text', 'finalized')]), 'a');
  assert.equal(tabs.defaultPostId([]), null);
  assert.equal(tabs.selectedPostId([a, b], 'a'), 'a');
  assert.equal(tabs.selectedPostId([a, b], 'gone'), 'b', 'a deleted choice falls back to the default');
  assert.equal(tabs.selectedPostId([a, b], null), 'b');
  assert.equal(tabs.selectedPostId([], 'a'), null);
  assert.equal(tabs.textAssetOf(post('d', 'blog', 'article')).kind, 'article');
});

test('W02b the selection taken when the tab opens stays on its post after that post\'s text is finalized', () => {
  const opened = [post('li', 'linkedin', 'text', 'finalized'), post('x', 'x', 'text', 'drafting'), post('fb', 'facebook', 'text')];
  const chosen = tabs.defaultPostId(opened);
  assert.equal(chosen, 'x');
  const afterFinalize = [opened[0], post('x', 'x', 'text', 'finalized'), opened[2]];
  assert.equal(tabs.selectedPostId(afterFinalize, chosen), 'x', 'no jump to Facebook, so no session starts there');
  assert.equal(tabs.defaultPostId(afterFinalize), 'fb', 'a default worked out again would have jumped');
  const source = src('ui/content/PostTextTab.tsx');
  assert.match(source, /useState<string \| null>\(\(\) => defaultPostId\(posts\)\)/, 'the default is taken once');
  assert.match(source, /if \(selectedId !== chosen\) setChosen\(selectedId\)/, 'a fallback is pinned');
  assert.match(src('ui/content/ConceptView.tsx'), /<PostTextTab key=\{tab\}/, 'each tab has its own selection');
});

test('W04 the chip model: platform label, format, date for RelativeTime, state words', () => {
  const chip = tabs.postChipModel(post('p', 'x', 'video'));
  assert.deepEqual(chip, { id: 'p', platform: 'x', platformLabel: 'X (Twitter)', format: 'Video', scheduledAt: ISO(60 * 24), state: 'empty', stateLabel: 'Not started' });
  assert.equal(tabs.postChipModel(post('q', 'instagram', 'reel', 'drafting')).stateLabel, 'Drafting');
  assert.equal(tabs.postChipModel(post('r', 'blog', 'article', 'finalized')).stateLabel, 'Finalized');
});

test('W05 arrow keys move and wrap at both ends', () => {
  assert.equal(tabs.nextChipIndex(0, 3, 'ArrowRight'), 1);
  assert.equal(tabs.nextChipIndex(2, 3, 'ArrowRight'), 0);
  assert.equal(tabs.nextChipIndex(0, 3, 'ArrowLeft'), 2);
  assert.equal(tabs.nextChipIndex(1, 3, 'Enter'), 1);
});

test('W06 the switcher label', () => {
  assert.equal(tabs.switcherLabel('post-content', 3), 'LinkedIn, X and Facebook posts · 3 posts');
  assert.equal(tabs.switcherLabel('captions', 1), 'Instagram posts · 1 post');
  assert.equal(tabs.switcherLabel('blog', 2), 'Blog posts · 2 posts');
});

test('W07 the context line: platform · format, the full date in the Building zone (right day near midnight), the rule', () => {
  const late = post('p', 'linkedin', 'text', 'empty', { scheduledAt: '2026-11-03T23:30:00Z' });
  const line = tabs.contextLine(late, 'Asia/Kolkata');
  assert.equal(line.title, 'LinkedIn · Text');
  assert.match(line.rest, /^scheduled Wednesday,? 4 November 2026 at 05:00 · Post text up to 3,000 characters$/);
  assert.match(tabs.contextLine(late, 'America/Los_Angeles').rest, /Tuesday,? 3 November 2026 at 15:30/);
});

test('W08/W09 counters: plain, near from 90%, at the limit, over, separators, meter clamped', () => {
  assert.deepEqual(tabs.counter(0, 3000, 'characters'), { label: '0 / 3,000 characters', status: '3,000 left', near: false, percent: 0 });
  assert.deepEqual(tabs.counter(2699, 3000, 'characters'), { label: '2,699 / 3,000 characters', status: '301 left', near: false, percent: (2699 / 3000) * 100 });
  assert.equal(tabs.counter(2700, 3000, 'characters').status, 'Near the limit · 300 left');
  assert.equal(tabs.counter(2700, 3000, 'characters').near, true);
  assert.equal(tabs.counter(3000, 3000, 'characters').status, 'At the limit');
  const over = tabs.counter(3010, 3000, 'characters');
  assert.deepEqual([over.status, over.percent], ['Over the limit by 10', 100]);
  assert.equal(tabs.counter(63206, 63206, 'characters').label, '63,206 / 63,206 characters');
  assert.equal(tabs.counter(5, 280, '').label, '5 / 280');
});

test('W10 hashtags count as on the server (same fixture table)', () => {
  for (const [text, n] of CASES.hashtags) assert.equal(limits.countHashtags(text), n, text);
  assert.deepEqual(tabs.textCounters('instagram', '#a #b text').map((c) => c.label), ['10 / 2,200 characters', '2 / 30 hashtags']);
  assert.deepEqual(tabs.textCounters('linkedin', '#a').map((c) => c.label), ['2 / 3,000 characters']);
});

test('W11 threads split as on the server (same fixture table)', () => {
  for (const [text, tweets] of CASES.threads) assert.deepEqual(limits.splitThread(text), tweets, JSON.stringify(text));
});

test('W12 the thread view: heading, tweet labels, per-tweet counts and the near warning from 252', () => {
  const view = tabs.threadView(['a'.repeat(251), 'b'.repeat(252), 'c'].join('\n---\n'));
  assert.equal(view.heading, 'Thread · 3 tweets (up to 25)');
  assert.deepEqual(view.tweets.map((t) => [t.label, t.counter.label, t.counter.near]), [['Tweet 1 of 3', '251 / 280', false], ['Tweet 2 of 3', '252 / 280', true], ['Tweet 3 of 3', '1 / 280', false]]);
  assert.equal(tabs.threadView('one').heading, 'Single tweet');
});

test('W13/W14 copy text and labels', () => {
  const thread = 'one\n---\ntwo';
  assert.equal(tabs.copyTextFor('x', thread), 'one\n\ntwo');
  assert.equal(tabs.threadView(thread).tweets[1].text, 'two');
  assert.equal(tabs.copyTextFor('blog', '# T\n\n**b**'), '# T\n\n**b**');
  assert.equal(tabs.copyTextFor('linkedin', 'hi\n---\nyou'), 'hi\n---\nyou', 'only X splits');
  assert.equal(tabs.copyLabelFor('x', thread), 'Copy thread');
  assert.equal(tabs.copyLabelFor('x', 'single'), 'Copy');
  assert.equal(tabs.copyLabelFor('blog', '# T'), 'Copy Markdown');
  assert.equal(tabs.copyLabelFor('instagram', 'c'), 'Copy');
  assert.equal(tabs.threadView(thread).tweets[1].copyLabel, 'Copy tweet 2');
});

test('W15 the blog counter has the allowed range and no meter', () => {
  assert.equal(tabs.blogCounter('a'.repeat(4820)), '4,820 characters · allowed 300 to 50,000');
});

test('W16 the finalized note names the text', () => {
  const words = (p) => { const n = tabs.finalizedNote(p); return `${n.before}${n.link}${n.after}`; };
  assert.equal(words('x'), 'This tweet is final. The post itself is finalized from Overview once all its assets are final.');
  assert.match(words('linkedin'), /^This post is final/);
  assert.match(words('instagram'), /^This caption is final/);
  assert.match(words('blog'), /^This article is final/);
});

test('W17 code points count like the server', () => {
  assert.equal(limits.charCount(CASES.emoji.text), CASES.emoji.count);
  assert.equal(limits.charCount('😀'.repeat(3)), 3);
});

test('W18 extreme dates render without throwing', () => {
  assert.match(tabs.contextLine(post('p', 'blog', 'article', 'empty', { scheduledAt: '1970-01-01T00:00:00.000Z' }), 'UTC').rest, /1 January 1970/);
  assert.match(tabs.contextLine(post('p', 'blog', 'article', 'empty', { scheduledAt: '9999-12-31T23:59:59.000Z' }), 'UTC').rest, /9999/);
});

// ---- S: the store through the daemon stand-in ----
const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ listByProject: {}, calendarByProject: {}, conceptsById: {}, missingByPost: {}, studioByAsset: {}, studioBlocked: {} });
});
const store = () => useContentStore.getState();
async function newConcept() {
  const c = await contentApi.createConcept(B, { title: 'T', brief: '', posts: [
    { platform: 'linkedin', format: 'text', scheduledAt: '2026-10-27T09:00:00Z' },
    { platform: 'linkedin', format: 'image', scheduledAt: '2026-10-28T09:00:00Z' },
    { platform: 'blog', format: 'article', scheduledAt: '2026-10-29T09:00:00Z' },
  ] });
  await store().loadConcept(B, c.id);
  const text = (i) => c.posts[i].needs.find((a) => a.kind === 'post-text' || a.kind === 'article').id;
  return { cid: c.id, posts: c.posts, a: text(0), b: text(1), article: text(2), images: c.posts[1].needs.find((a) => a.kind === 'image-set').id, video: c.assets.find((a) => a.kind === 'video').id };
}
const starts = (aid) => stub.content.requests.filter((r) => r.method === 'POST' && r.path.endsWith(`${aid}/session`)).length;
const addDraft = (aid, text) => { const pane = stub.content.studio.panes.get(aid); pane.drafts.push({ round: pane.rounds.at(-1).round, text, savedAt: new Date().toISOString() }); };

test('S01 a post text and an article open their own pane and start round 1 with their tab', async () => {
  const f = await newConcept();
  assert.equal((await store().openStudio(B, f.cid, f.a)).ok, true);
  assert.equal(store().studioByAsset[f.a].session.tab, 'post-content');
  assert.equal((await store().openStudio(B, f.cid, f.article)).ok, true);
  assert.equal(store().studioByAsset[f.article].session.tab, 'blog');
});

test('S02 switching A → B → A starts nothing new for A and keeps its view', async () => {
  const f = await newConcept();
  await store().openStudio(B, f.cid, f.a);
  const viewA = store().studioByAsset[f.a];
  await store().openStudio(B, f.cid, f.b);
  await store().openStudio(B, f.cid, f.a);
  assert.equal(starts(f.a), 1);
  assert.equal(stub.content.requests.some((r) => r.path.endsWith(`${f.a}/session/new-round`)), false);
  assert.equal(store().studioByAsset[f.a].session.id, viewA.session.id);
  assert.equal(store().studioByAsset[f.a].session.state, 'running');
});

test('S03/S04 an event for post A\'s text moves its chip state and leaves post B and its view untouched', async () => {
  const f = await newConcept();
  await store().openStudio(B, f.cid, f.b);
  const before = store().conceptsById[f.cid];
  const viewB = store().studioByAsset[f.b];
  const postB = before.posts[1];
  const view = { rev: Number.MAX_SAFE_INTEGER, conceptId: f.cid, assetId: f.a, asset: { state: 'drafting', round: 1, finalizedAt: null, content: null }, session: null, rounds: [], skillWarning: null };
  store().applyStudioEvent({ type: 'studioAsset', buildingId: B, view });
  const after = store().conceptsById[f.cid];
  assert.equal(after.posts[0].needs[0].state, 'drafting');
  assert.equal(tabs.postChipModel(after.posts[0]).stateLabel, 'Drafting');
  assert.equal(after.posts[1], postB, 'post B keeps its object');
  assert.equal(store().studioByAsset[f.b], viewB);
  assert.deepEqual(after.assets, before.assets, 'the Concept assets are untouched');
});

test('S05 finalizing a text makes its chip Finalized; the Overview finalizes a text post and names what an image post misses', async () => {
  const f = await newConcept();
  for (const aid of [f.a, f.b]) { await store().openStudio(B, f.cid, aid); addDraft(aid, 'Ready'); assert.equal((await store().studioAction(B, f.cid, aid, 'finalize')).ok, true); }
  const c = store().conceptsById[f.cid];
  assert.equal(tabs.postChipModel(c.posts[0]).stateLabel, 'Finalized');
  assert.equal(starts(f.article), 0, 'finalizing starts no session on another post');
  assert.equal((await store().finalizePost(B, f.cid, f.posts[0].id)).ok, true);
  const image = await store().finalizePost(B, f.cid, f.posts[1].id);
  assert.equal(image.status, 409);
  assert.deepEqual(store().missingByPost[f.posts[1].id], ['image-set']);
});

test('S06 deleting a post drops it, its pane and its blocked reason; the selection falls back', async () => {
  const f = await newConcept();
  await store().openStudio(B, f.cid, f.a);
  useContentStore.setState((s) => ({ studioBlocked: { ...s.studioBlocked, [f.a]: 'why', [f.article]: 'keep' } }));
  assert.equal((await store().deletePost(B, f.cid, f.posts[0].id)).ok, true);
  assert.equal(store().studioByAsset[f.a], undefined);
  assert.equal(store().studioBlocked[f.a], undefined);
  assert.equal(store().studioBlocked[f.article], 'keep');
  const left = tabs.postsForTab(store().conceptsById[f.cid].posts, 'post-content');
  assert.deepEqual(left.map((p) => p.id), [f.posts[1].id]);
  assert.equal(tabs.selectedPostId(left, f.posts[0].id), f.posts[1].id);
});

test('S07 the stand-in opens an image set in the images pane (32.006)', async () => {
  const f = await newConcept();
  const res = await store().openStudio(B, f.cid, f.images);
  assert.equal(res.ok, true);
  assert.equal(store().studioByAsset[f.images].session.tab, 'images');
});

// ---- C: static renders ----
const noop = () => {};
const { postResultFormat } = await loadModule('src/ui/content/PostTextTab.tsx');
const fmt = (platform, blogView = 'rendered', onOverview = noop) => postResultFormat(platform, { blogView, onBlogView: noop, onOverview });
const session = (state = 'running') => ({ id: 's1', conceptId: 'c1', assetId: 'a1', tab: 'post-content', round: 1, state, executorId: 'x', createdAt: ISO(-10), updatedAt: ISO(-10) });
const viewWith = (text, over = {}) => ({
  rev: 1, conceptId: 'c1', assetId: 'a1', asset: { state: 'drafting', round: 1, finalizedAt: null, content: null }, session: session(),
  rounds: [{ round: 1, startedAt: ISO(-10), draft: text === null ? null : { text, savedAt: ISO(-2) } }], skillWarning: null, ...over,
});
const finalized = (text) => viewWith(text, { asset: { state: 'finalized', round: 1, finalizedAt: ISO(-1), content: text }, session: session('ended') });
const pane = (view, format, over = {}) => render('src/ui/content/StudioPaneView.tsx', 'StudioPaneView', {
  view, blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop,
  renderTerminal: (id) => `TERMINAL:${id}`, now: NOW, format, ...over,
});
const tabProps = (tab, posts, over = {}) => ({ tab, concept: concept(posts), timeZone: 'UTC', renderStudio: (_c, aid) => createElement('div', { 'data-studio': aid }), onOverview: noop, now: NOW, ...over });
const btn = (html, label) => html.match(new RegExp(`<button[^>]*>(?:<svg[\\s\\S]*?</svg>)?${label}</button>`))?.[0];

test('C01 Post content: a tablist of 3 chips, the selected one is the only Tab stop', async () => {
  const html = await render('src/ui/content/PostTextTab.tsx', 'PostTextTab', tabProps('post-content', [post('p1', 'linkedin', 'text', 'finalized'), post('p2', 'x', 'text'), post('p3', 'facebook', 'image'), post('p4', 'instagram', 'reel')]));
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
  assert.match(html, /aria-selected="false" tabindex="-1" data-post="p1"/);
  assert.match(html, /aria-selected="true" tabindex="0" data-post="p2"/, 'opens on the first text that is not final');
  assert.match(html, /aria-selected="false" tabindex="-1" data-post="p3"/);
  assert.match(html, /LinkedIn, X and Facebook posts · 3 posts/);
  assert.match(html, /aria-label="X \(Twitter\)"/);
  assert.match(html, /data-studio="a-p2"/);
  assert.match(html, /Finalized/);
  assert.match(html, /Not started/);
});

test('C02 Captions with one Instagram post: character and hashtag counters', async () => {
  const html = await render('src/ui/content/PostTextTab.tsx', 'PostTextTab', tabProps('captions', [post('p1', 'instagram', 'reel')]));
  assert.match(html, /Instagram posts · 1 post/);
  const result = await pane(viewWith('Hello #one #two'), fmt('instagram'));
  assert.match(result, /15 \/ 2,200 characters/);
  assert.match(result, /2 \/ 30 hashtags/);
  assert.match(result, />Copy</);
});

test('C03/C04 Blog: Rendered shows headings, Raw a pre, the toggle follows; no script and no javascript: link', async () => {
  const text = '# Big title\n\n## Part\n\nBody <script>alert(1)</script> and [x](javascript:alert(1))';
  const rendered = await pane(viewWith(text), fmt('blog', 'rendered'));
  assert.match(rendered, /<h1>Big title<\/h1>/);
  assert.match(rendered, /<h2>Part<\/h2>/);
  assert.match(rendered, /aria-pressed="true"[^>]*>Rendered</);
  assert.match(rendered, /aria-pressed="false"[^>]*>Raw Markdown</);
  assert.doesNotMatch(rendered, /<script/);
  assert.doesNotMatch(rendered, /href="javascript:/);
  assert.ok(btn(rendered, 'Copy Markdown'));
  assert.match(rendered, /\d+ characters · allowed 300 to 50,000/);
  assert.doesNotMatch(rendered, /bg-success/, 'no meter on the blog');
  const raw = await pane(viewWith(text), fmt('blog', 'raw'));
  assert.match(raw, /<pre[^>]*data-result[^>]*># Big title/);
  assert.match(raw, /aria-pressed="true"[^>]*>Raw Markdown</);
});

test('C05 an X thread: one card per tweet with its count and Copy, and Copy thread', async () => {
  const html = await pane(viewWith('one\n---\ntwo two\n---\nthree\n---\nfour'), fmt('x'));
  assert.equal((html.match(/data-tweet="/g) ?? []).length, 4);
  assert.match(html, /Thread · 4 tweets \(up to 25\)/);
  assert.match(html, /Tweet 2 of 4/);
  assert.match(html, /7 \/ 280/);
  assert.ok(btn(html, 'Copy thread'));
  assert.match(html, /aria-label="Copy tweet 2"/);
});

test('C06 an X single tweet', async () => {
  const html = await pane(viewWith('just one'), fmt('x'));
  assert.match(html, /Single tweet/);
  assert.ok(btn(html, 'Copy'));
  assert.doesNotMatch(html, /Copy thread/);
});

test('C07 LinkedIn near and at the limit say so in words and the warning colour', async () => {
  const near = await pane(viewWith('a'.repeat(2700)), fmt('linkedin'));
  assert.match(near, /data-near="true"/);
  assert.match(near, /bg-warning/);
  assert.match(near, /Near the limit · 300 left/);
  assert.match(await pane(viewWith('a'.repeat(3000)), fmt('linkedin')), /At the limit/);
  assert.doesNotMatch(await pane(viewWith('short'), fmt('linkedin')), /data-near/);
});

test('C08 no draft yet: the empty text, Finalize disabled, no counters', async () => {
  const html = await pane(viewWith(null), fmt('facebook'));
  assert.match(html, /No draft yet\. Ask the agent to write one\./);
  assert.match(btn(html, 'Finalize'), /disabled=""/);
  assert.doesNotMatch(html, /data-counter/);
});

test('C09 finalized: no left pane, Reopen, the note with an Overview link that switches tab', async () => {
  let opened = false;
  const format = fmt('x', 'rendered', () => { opened = true; });
  const html = await pane(finalized('Final tweet'), format);
  assert.doesNotMatch(html, /TERMINAL:/);
  assert.doesNotMatch(html, /aria-label="Agent"/);
  assert.ok(btn(html, 'Reopen'));
  assert.match(html, /This tweet is final\. The post itself is finalized from <button[^>]*>Overview<\/button> once all its assets are final\./);
  format.finalizedNote.props.onOverview();
  assert.equal(opened, true);
  assert.match(src('ui/content/ConceptView.tsx'), /onOverview=\{\(\) => onTab\('overview'\)\}/);
  assert.doesNotMatch(await pane(viewWith('draft'), fmt('x')), /is final/);
});

test('C10/C11 session ended shows Resume; round 2 or later shows Previous rounds', async () => {
  assert.ok(btn(await pane(viewWith('t', { session: session('ended') }), fmt('linkedin')), 'Resume'));
  const round2 = viewWith('second', { asset: { state: 'drafting', round: 2, finalizedAt: null, content: null }, rounds: [{ round: 1, startedAt: ISO(-30), draft: { text: 'first', savedAt: ISO(-29) } }, { round: 2, startedAt: ISO(-10), draft: { text: 'second', savedAt: ISO(-2) } }] });
  assert.match(await pane(round2, fmt('linkedin')), /Previous rounds \(1\)/);
});

test('C12 the context line shows each platform rule', async () => {
  const cases = [['post-content', post('p', 'linkedin', 'text'), 'Post text up to 3,000 characters'], ['post-content', post('p', 'facebook', 'text'), 'Post text up to 63,206 characters'], ['post-content', post('p', 'x', 'text'), 'One tweet up to 280 characters'], ['captions', post('p', 'instagram', 'image'), 'Caption up to 2,200 characters and 30 hashtags'], ['blog', post('p', 'blog', 'article'), 'Markdown article starting with a # title']];
  for (const [tab, p, rule] of cases) {
    const html = await render('src/ui/content/PostTextTab.tsx', 'PostTextTab', tabProps(tab, [p]));
    assert.match(html, /data-context="true"><b>[^<]+ · [^<]+<\/b> · scheduled /);
    assert.ok(html.includes(rule), rule);
  }
});

test('C13 the three tabs draw their switcher instead of Coming soon; a tab with no post of its kind stays disabled with its reason', async () => {
  const c = concept([post('p1', 'linkedin', 'text'), post('p2', 'instagram', 'reel'), post('p3', 'blog', 'article')]);
  const body = (tab, value = c) => render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: value, missingByPost: {}, error: null, onSave: noop, timeZone: 'UTC', readOnly: false, renderStudio: (_c, aid) => createElement('div', { 'data-studio': aid }), tab, onTab: noop, onBack: noop, onChanged: noop });
  for (const [tab, aid] of [['post-content', 'a-p1'], ['captions', 'a-p2'], ['blog', 'a-p3']]) {
    const html = await body(tab);
    assert.doesNotMatch(html, /<p[^>]*>Coming soon<\/p>/, tab);
    assert.match(html, /aria-label="Post switcher"/);
    assert.match(html, new RegExp(`data-studio="${aid}"`));
  }
  const onlyLinkedIn = concept([post('p1', 'linkedin', 'text')]);
  const captions = await body('captions', onlyLinkedIn);
  assert.match(captions, /disabled=""[^>]*title="Add an Instagram post to use this tab"[^>]*>Captions/);
  assert.doesNotMatch(captions, /aria-label="Post switcher"/);
});

test('C14 a long text and a 25-tweet thread wrap long words and scroll with the Result column (36.001)', async () => {
  const long = await pane(viewWith(`https://example.com/${'a'.repeat(2900)}`), fmt('linkedin'));
  assert.match(long, /<pre class="[^"]*\[overflow-wrap:anywhere\][^"]*" data-result/);
  assert.doesNotMatch(long, /max-h-\[32rem\]/, 'the Result column is the one scroller');
  const thread = await pane(viewWith(Array.from({ length: 25 }, (_, i) => `tweet ${i}`).join('\n---\n')), fmt('x'));
  assert.match(thread, /<ol class="[^"]*" aria-label="Tweets"/);
  assert.doesNotMatch(thread, /max-h-\[32rem\]/);
  assert.match(thread, /Thread · 25 tweets/);
  assert.match(src('ui/content/PostTextTab.tsx'), /whitespace-pre-wrap text-sm \[overflow-wrap:anywhere\]/);
});

test('C15 a read-only Building: the switcher still works, the pane starts nothing and its actions are disabled', async () => {
  const html = await render('src/ui/content/PostTextTab.tsx', 'PostTextTab', tabProps('post-content', [post('p1', 'linkedin', 'text'), post('p2', 'x', 'text')]));
  assert.doesNotMatch(html, /<button[^>]*role="tab"[^>]*disabled/);
  const ro = await pane(viewWith('t'), fmt('linkedin'), { readOnly: true });
  assert.match(btn(ro, 'Finalize'), /disabled=""/);
  assert.match(btn(ro, 'Start a new session'), /disabled=""/);
  assert.ok(btn(ro, 'Copy') && !/disabled=""/.test(btn(ro, 'Copy')));
  assert.match(src('ui/content/StudioPane.tsx'), /openStudio\(projectId, conceptId, assetId, !readOnly\)/);
  assert.match(src('ui/ContentStudioWorkspace.tsx'), /<StudioPane key=\{assetId\}[^>]*readOnly=\{readOnly\}/);
});

test('C16 nine posts wrap onto more rows', async () => {
  const posts = Array.from({ length: 9 }, (_, i) => post(`p${i}`, ['linkedin', 'x', 'facebook'][i % 3], 'text'));
  const html = await render('src/ui/content/PostTextTab.tsx', 'PostTextTab', tabProps('post-content', posts));
  assert.equal((html.match(/role="tab"/g) ?? []).length, 9);
  assert.match(html, /role="tablist"[^>]*class="flex flex-wrap gap-2"/);
});
