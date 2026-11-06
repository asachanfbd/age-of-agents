// A browser zone far ahead of UTC must not leak into anything the Building zone decides.
process.env.TZ = 'Pacific/Kiritimati';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const S = await import('../src/lib/contentStats.ts');
const cal = await import('../src/lib/contentCalendar.ts');
const view = await import('../src/lib/contentView.ts');
const server = await import('../../server/src/content/stats.ts');

const NOW = Date.parse('2026-10-26T10:00:00Z');
const counts = (over = {}) => ({ impressions: null, reach: null, views: null, likes: null, comments: null, shares: null, saves: null, linkClicks: null, profileVisits: null, followersGained: null, ...over });
const stat = (id, capturedAt, c, enteredAt = capturedAt) => ({ id, capturedAt, enteredAt, counts: counts(c), watchTime: null, note: '', sources: [] });

test('WU01/WU02/WU03 fields per platform use the platform labels; watch time is video and reel only', () => {
  assert.deepEqual(S.PLATFORM_STAT_FIELDS.linkedin.map((f) => f.label), ['Impressions', 'Reactions', 'Comments', 'Reposts', 'Clicks', 'Followers gained']);
  assert.deepEqual(S.PLATFORM_STAT_FIELDS.instagram.map((f) => f.key), ['reach', 'views', 'likes', 'comments', 'shares', 'saves', 'profileVisits', 'followersGained']);
  const labelOf = (platform, key) => S.PLATFORM_STAT_FIELDS[platform].find((f) => f.key === key)?.label;
  assert.deepEqual([labelOf('linkedin', 'likes'), labelOf('x', 'saves'), labelOf('x', 'impressions'), labelOf('blog', 'likes')], ['Reactions', 'Bookmarks', 'Views', undefined]);
  assert.deepEqual(S.PLATFORM_STAT_FIELDS.blog.map((f) => f.key), ['views', 'linkClicks', 'comments']);
  assert.deepEqual(S.PLATFORM_STAT_FIELDS.facebook.map((f) => f.label), ['Reach', 'Views', 'Reactions', 'Comments', 'Shares', 'Link clicks']);
  assert.deepEqual(['video', 'reel', 'image', 'text', 'article', 'carousel'].map(S.hasWatchTime), [true, true, false, false, false, false]);
});

test('WU04 the fields, labels and limits are the server copy', () => {
  assert.deepEqual(S.STAT_FIELDS, [...server.STAT_FIELDS]);
  assert.deepEqual(S.PLATFORM_STAT_FIELDS, server.PLATFORM_STAT_FIELDS);
  const limits = await_limits();
  assert.deepEqual([S.COUNT_MAX, S.LIVE_URL_MAX, S.NOTE_MAX, S.WATCH_TIME_MAX, S.FUTURE_TOLERANCE_MS, S.EXTRACT_TEXT_MAX, S.EXTRACT_IMAGES_MAX, S.EXTRACT_IMAGE_MAX_BYTES],
    [limits.COUNT_MAX, limits.LIVE_URL_MAX, limits.STATS_NOTE_MAX, limits.WATCH_TIME_MAX, limits.FUTURE_TOLERANCE_MS, limits.EXTRACT_TEXT_MAX, limits.EXTRACT_IMAGES_MAX, limits.EXTRACT_IMAGE_MAX_BYTES]);
});
function await_limits() { return limitsModule; }
const limitsModule = await import('../../server/src/content/limits.ts');

test('WU05 count formatting: unknown is a dash, zero is 0, big numbers have separators', () => {
  assert.deepEqual([S.formatCount(null), S.formatCount(undefined), S.formatCount(0), S.formatCount(1_000_000_000_000), S.formatCount(12345)], ['—', '—', '0', '1,000,000,000,000', '12,345']);
  assert.equal(S.formatWatchTime(null), '—');
  assert.equal(S.formatWatchTime(12.5), '12.5s');
});

test('WU06/WU07 delta: sign, zero, unknown either side, no previous; latest and previous from an unsorted list', () => {
  const d = S.statsDelta(counts({ views: 10, likes: 5, saves: null, comments: 3 }), counts({ views: 4, likes: 9, saves: 1, comments: 3 }));
  assert.deepEqual([d.views, d.likes, d.saves, d.comments, d.reach], [6, -4, null, 0, null]);
  assert.equal(S.statsDelta(counts({ views: 1 }), null), null);
  assert.deepEqual([S.formatDelta(6), S.formatDelta(-4), S.formatDelta(0), S.formatDelta(null), S.formatDelta(1234)], ['+6', '−4', '0', '—', '+1,234']);
  const list = [stat('a', '2026-10-25T08:00:00Z', { views: 1 }), stat('c', '2026-10-26T08:00:00Z', { views: 30 }), stat('b', '2026-10-25T20:00:00Z', { views: 10 }), stat('d', '2026-10-26T08:00:00Z', { views: 31 }, '2026-10-26T09:00:00Z')];
  const r = S.latestAndPrevious(list);
  assert.deepEqual([r.latest.id, r.previous.id, r.delta.views], ['d', 'c', 1]);
  assert.deepEqual(S.latestAndPrevious([]), { latest: null, previous: null, delta: null });
  assert.equal(S.latestAndPrevious([list[0]]).delta, null);
  assert.deepEqual(S.sortStats(list).map((x) => x.id), ['d', 'c', 'b', 'a']);
});

test('WU22 the row summary lists only counts that have a value, in the platform order with their change', () => {
  const line = S.summaryLine('linkedin', stat('a', '2026-10-26T08:00:00Z', { impressions: 100, likes: 0, saves: 9 }), counts({ impressions: 60, likes: null }));
  assert.deepEqual(line, [{ label: 'Impressions', value: '100', delta: '+60' }, { label: 'Reactions', value: '0', delta: '—' }]);
  assert.equal(S.summaryLine('x', stat('a', '2026-10-26T08:00:00Z', { views: 5 }), null).length, 0, 'views is not an X field');
  assert.equal(S.summaryLine('blog', stat('a', '2026-10-26T08:00:00Z', { views: 5 }), null)[0].delta, null, 'no previous snapshot, no change shown');
});

test('WU08 typed counts are plain digits from 0 to 10^12; empty is unknown', () => {
  assert.deepEqual(['', ' ', '12', '007', '0', '1000000000000'].map(S.parseTypedCount), [null, null, 12, 7, 0, 1e12]);
  for (const bad of ['1.5', '-1', '1e3', '1000000000001', '12,345', 'abc', '99999999999999999999']) assert.equal(S.parseTypedCount(bad), undefined, bad);
  assert.deepEqual(['', '5', '12.3', '0.5'].map(S.parseTypedWatchTime), [null, 5, 12.3, 0.5]);
  for (const bad of ['12.34', '-1', 'x', '86401']) assert.equal(S.parseTypedWatchTime(bad), undefined, bad);
});

const ctx = { format: 'text', publishedAt: '2026-10-26T08:00:00Z', now: NOW };
test('WU10 the stats form mirrors the server rules', () => {
  const ok = { ...S.emptyStatForm('2026-10-26T09:00:00Z'), counts: { views: '5' } };
  assert.equal(S.checkStatForm(ok, ctx).ok, true);
  assert.equal(S.checkStatForm({ ...ok, capturedAt: '2026-10-26T10:05:00Z' }, ctx).ok, true, 'five minutes ahead is fine');
  assert.match(S.checkStatForm({ ...ok, capturedAt: '2026-10-26T10:05:01Z' }, ctx).errors.capturedAt, /future/);
  assert.match(S.checkStatForm({ ...ok, capturedAt: '2026-10-26T07:59:00Z' }, ctx).errors.capturedAt, /before/);
  assert.equal(S.checkStatForm({ ...ok, capturedAt: '2026-10-26T08:00:00Z' }, ctx).ok, true, 'equal to the published time is fine');
  assert.match(S.checkStatForm({ ...ok, capturedAt: null }, ctx).errors.capturedAt, /Pick/);
  assert.match(S.checkStatForm({ ...ok, counts: {} }, ctx).errors.counts, /at least one/);
  assert.match(S.checkStatForm({ ...ok, counts: { views: ' ' } }, ctx).errors.counts, /at least one/);
  assert.match(S.checkStatForm({ ...ok, counts: { views: '1.5' } }, ctx).errors.views, /Whole number/);
  assert.match(S.checkStatForm({ ...ok, note: 'x'.repeat(1001) }, ctx).errors.note, /1,000/);
  assert.equal(S.checkStatForm({ ...ok, note: 'x'.repeat(1000) }, ctx).ok, true);
  assert.match(S.checkStatForm({ ...ok, watchTime: '3' }, ctx).errors.watchTime, /video and reel/);
  assert.equal(S.checkStatForm({ ...ok, watchTime: '3.5' }, { ...ctx, format: 'reel' }).ok, true);
  assert.match(S.checkStatForm({ ...ok, watchTime: '3.55' }, { ...ctx, format: 'reel' }).errors.watchTime, /1 decimal/);
});

test('WU10b the request body sends unknown counts as null and keeps zero', () => {
  const form = { ...S.emptyStatForm('2026-10-26T09:00:00Z'), counts: { likes: '0', views: '12' }, note: ' hi ', watchTime: '4.5' };
  const body = S.statBody(form, 'instagram', 'e1');
  assert.deepEqual([body.counts.likes, body.counts.views, body.counts.saves, body.watchTime, body.note, body.extractionId], [0, 12, null, 4.5, 'hi', 'e1']);
  assert.equal('extractionId' in S.statBody(form, 'instagram'), false);
  assert.deepEqual(Object.keys(S.statBody(form, 'blog').counts), ['views', 'linkClicks', 'comments']);
  const edit = S.formFromStat({ ...stat('a', '2026-10-26T09:00:00Z', { views: 0, likes: 7 }), watchTime: 2, note: 'n' });
  assert.deepEqual([edit.counts, edit.watchTime, edit.note], [{ views: '0', likes: '7' }, '2', 'n']);
});

test('WU11 the publish form: URL rules and the future limit', () => {
  const at = '2026-10-26T09:00:00Z';
  assert.equal(S.checkPublishForm('', at, NOW).ok, true);
  assert.equal(S.checkPublishForm('https://example.com/p', at, NOW).ok, true);
  for (const bad of ['ftp://x.com', 'javascript:1', 'example.com', '/rel']) assert.match(S.checkPublishForm(bad, at, NOW).errors.liveUrl, /http/, bad);
  const url = (n) => `https://example.com/${'a'.repeat(n - 20)}`;
  assert.equal(S.checkPublishForm(url(2000), at, NOW).ok, true);
  assert.match(S.checkPublishForm(url(2001), at, NOW).errors.liveUrl, /2,?000/);
  assert.match(S.checkPublishForm('', '2026-10-26T10:05:01Z', NOW).errors.publishedAt, /future/);
  assert.equal(S.checkPublishForm('', '2026-10-26T10:05:00Z', NOW).ok, true);
  assert.match(S.checkPublishForm('', null, NOW).errors.publishedAt, /Pick/);
});

test('WU12 actions by status', () => {
  const a = (s) => S.postActions(s);
  assert.deepEqual(a('draft'), { publish: false, editPublish: false, unpublish: false, finalize: true, unfinalize: false, delete: true, addStats: false });
  assert.deepEqual(a('finalized'), { publish: true, editPublish: false, unpublish: false, finalize: false, unfinalize: true, delete: true, addStats: false });
  assert.deepEqual(a('published'), { publish: false, editPublish: true, unpublish: true, finalize: false, unfinalize: false, delete: false, addStats: true });
});

test('WU13 Reopen is blocked by a published post that needs the asset, and free again after unpublish', () => {
  const text = { id: 'a-text', kind: 'post-text' }, video = { id: 'a-video', kind: 'video' }, script = { id: 'a-script', kind: 'script' };
  const concept = (status) => ({ posts: [{ status, needs: [text, video] }, { status: 'draft', needs: [{ id: 'other', kind: 'post-text' }] }] });
  assert.equal(S.reopenBlockReason(concept('published'), text), 'Used by a published post');
  assert.equal(S.reopenBlockReason(concept('published'), video), 'Used by a published post');
  assert.equal(S.reopenBlockReason(concept('published'), { id: 'other' }), null, 'only the draft post uses it');
  assert.equal(S.reopenBlockReason(concept('published'), script), null);
  assert.equal(S.reopenBlockReason(concept('finalized'), text), null);
});

test('WU14 calendar day: published day, scheduled otherwise, with the zone ahead of UTC and back after unpublish', () => {
  const p = (status, publishedAt) => ({ id: 'p', conceptId: 'c', conceptTitle: 'C', platform: 'x', format: 'text', status, scheduledAt: '2026-11-03T09:00:00.000Z', publishedAt });
  // 23:30 UTC on 25 October is already the 26th at +05:30.
  assert.equal(S.placedDay(p('published', '2026-10-25T19:00:00.000Z'), 'Asia/Kolkata'), '2026-10-26');
  assert.equal(S.placedDay(p('published', '2026-10-25T19:00:00.000Z'), 'UTC'), '2026-10-25');
  assert.equal(S.placedDay(p('finalized', null), 'UTC'), '2026-11-03');
  assert.equal(S.placedDay(p('published', null), 'UTC'), '2026-11-03', 'a published post without a time falls back');
  const grid = cal.monthGrid('2026-10', [p('published', '2026-10-25T19:00:00.000Z')], 'Asia/Kolkata');
  assert.deepEqual(grid.flat().filter((c) => c.posts.length).map((c) => c.day), ['2026-10-26']);
  assert.deepEqual(cal.monthGrid('2026-11', [p('finalized', null)], 'UTC').flat().filter((c) => c.posts.length).map((c) => c.day), ['2026-11-03']);
});

test('WU15 "Most views" ranks by the best published post latest views; none stays empty', () => {
  const post = (status, c) => ({ status, stats: { latest: { counts: counts(c) } } });
  assert.equal(S.conceptViews({ posts: [] }), null);
  assert.equal(S.conceptViews({ posts: [post('published', { views: 5 }), post('published', { views: 9 })] }), 9);
  assert.equal(S.conceptViews({ posts: [post('published', { impressions: 7 })] }), 7, 'X reports its views as impressions');
  assert.equal(S.conceptViews({ posts: [post('published', { views: 0 })] }), 0);
  assert.equal(S.conceptViews({ posts: [post('finalized', { views: 5 })] }), null);
  assert.equal(S.conceptViews({ posts: [{ status: 'published', stats: { latest: null } }] }), null);
  assert.deepEqual(view.listParams({ ...view.emptyFilters(), sort: 'views' }, 0, 50).sort, 'views');
  assert.equal('sort' in view.listParams(view.emptyFilters()), false);
});

test('WU16/WU17/WU18 applying an extraction marks only values it read; editing clears the mark; a failure keeps the form', () => {
  const form = { ...S.emptyStatForm('2026-10-26T09:00:00Z'), counts: { likes: '3' }, note: 'mine' };
  const reply = { ok: true, extractionId: 'e1', counts: { views: 1200, likes: null, saves: 0 }, capturedAt: null, unused: ['Hearts', 'Dwell'] };
  const { form: filled, unused } = S.applyExtraction(form, reply);
  assert.deepEqual(filled.counts, { likes: '3', views: '1200', saves: '0' });
  assert.deepEqual(filled.fromAgent.sort(), ['saves', 'views']);
  assert.equal(filled.capturedAt, form.capturedAt, 'no time read keeps the form value');
  assert.equal(filled.note, 'mine');
  assert.equal(S.unusedText(unused), 'Not used: Hearts, Dwell');
  assert.equal(S.unusedText([]), null);
  const timed = S.applyExtraction(form, { ...reply, capturedAt: '2026-10-25T20:00:00Z' });
  assert.deepEqual([timed.form.capturedAt, timed.form.fromAgent.includes('capturedAt')], ['2026-10-25T20:00:00Z', true]);
  assert.deepEqual(S.clearMark(filled, 'views').fromAgent, ['saves']);
  assert.equal(S.failureText('the agent took longer than 120 seconds'), 'Could not read the stats: the agent took longer than 120 seconds');
});

test('WU19 upload checks before sending: something to read, 20,000 characters, 10 images, types and 10 MB', () => {
  const png = { type: 'image/png', size: 5 };
  assert.equal(S.checkUpload('x', []), null);
  assert.equal(S.checkUpload('', [png]), null);
  assert.match(S.checkUpload('  ', []), /Paste/);
  assert.equal(S.checkUpload('x'.repeat(20000), []), null);
  assert.match(S.checkUpload('x'.repeat(20001), []), /20,000/);
  assert.equal(S.checkUpload('', Array(10).fill(png)), null);
  assert.match(S.checkUpload('', Array(11).fill(png)), /At most 10/);
  assert.match(S.checkUpload('', [{ type: 'image/gif', size: 1 }]), /PNG, JPEG or WebP/);
  assert.equal(S.checkUpload('', [{ type: 'image/webp', size: 10 * 1048576 }]), null);
  assert.match(S.checkUpload('', [{ type: 'image/png', size: 10 * 1048576 + 1 }]), /10 MB/);
});

test('WU20 an extraction is discarded on close unless it was saved', () => {
  assert.deepEqual([S.shouldDiscard('e1', false), S.shouldDiscard('e1', true), S.shouldDiscard(null, false)], [true, false, false]);
});

test('WU09 Captured at is read in the Building zone whatever the browser zone is', async () => {
  const zone = await import('../src/lib/contentZone.ts');
  assert.equal(new Date(2026, 9, 26, 12).getTimezoneOffset(), -840, 'the process runs at +14:00');
  assert.equal(zone.localTextToInstant('2026-10-26T00:30', 'Asia/Kolkata'), '2026-10-25T19:00:00.000Z');
  assert.equal(zone.localTextToInstant('2026-10-26T00:30', 'UTC'), '2026-10-26T00:30:00.000Z');
  assert.equal(zone.instantToLocalText('2026-10-25T19:00:00.000Z', 'Asia/Kolkata'), '2026-10-26T00:30');
  assert.equal(zone.localTextToInstant('2026-03-29T02:30', 'Europe/Berlin'), '2026-03-29T01:30:00.000Z', 'a time in the daylight-saving gap lands after it');
  assert.equal(zone.localTextToInstant('', 'UTC'), null);
});
