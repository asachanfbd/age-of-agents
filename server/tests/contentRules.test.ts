import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as web from '../../web/src/lib/contentRules.ts';
import { monthBounds, parseMonth } from '../src/content/calendar.ts';
import { diffSummary, STYLE_SECTIONS, starterStyle } from '../src/content/style.ts';
import { versionOf } from '../src/content/files.ts';
import * as rules from '../src/content/rules.ts';
import { parseBrief, parseInstant, parseLimit, parseName, parseOffset, parsePostShape, parseTimezone, parseTitle } from '../src/content/validate.ts';
import { parseFileName } from '../src/content/brandFiles.ts';

const throwsField = (fn: () => unknown, field: string) => assert.throws(fn, (e: { field?: string }) => e.field === field);

test('SU01 the platform set is closed and case-sensitive', () => {
  assert.deepEqual([...rules.PLATFORMS], ['linkedin', 'instagram', 'x', 'facebook', 'blog']);
  for (const bad of ['LinkedIn', 'X', 'twitter', '', 'LINKEDIN', 4]) assert.equal(rules.isPlatform(bad), false, String(bad));
});

test('SU02/SU03 exactly the 15 listed pairs are valid', () => {
  const valid = Object.entries(rules.FORMATS_BY_PLATFORM).flatMap(([p, fs]) => fs.map((f) => `${p}/${f}`));
  assert.equal(valid.length, 15);
  for (const pair of ['blog/video', 'instagram/text', 'instagram/video', 'x/carousel', 'linkedin/reel', 'facebook/reel', 'blog/text', 'x/', 'x/nope']) {
    const [p, f] = pair.split('/');
    assert.equal(rules.isFormatOf(p as rules.Platform, f), false, pair);
    throwsField(() => parsePostShape(p, f), 'format');
  }
  assert.deepEqual(parsePostShape('x', 'text'), { platform: 'x', format: 'text' });
  throwsField(() => parsePostShape('myspace', 'text'), 'platform');
});

test('SU04/SU07 needed assets by platform and format; the script is never needed', () => {
  assert.deepEqual(rules.assetsNeeded('instagram', 'reel'), ['post-text', 'video', 'thumbnail']);
  assert.deepEqual(rules.assetsNeeded('x', 'image'), ['post-text', 'image-set']);
  assert.deepEqual(rules.assetsNeeded('linkedin', 'carousel'), ['post-text', 'image-set']);
  assert.deepEqual(rules.assetsNeeded('facebook', 'text'), ['post-text']);
  assert.deepEqual(rules.assetsNeeded('blog', 'article'), ['article']);
  for (const [p, fs] of Object.entries(rules.FORMATS_BY_PLATFORM)) for (const f of fs) assert.ok(!rules.assetsNeeded(p as rules.Platform, f).includes('script'));
  assert.deepEqual([rules.TEXT_NAMES.instagram, rules.TEXT_NAMES.linkedin, rules.TEXT_NAMES.facebook, rules.TEXT_NAMES.x], ['Caption', 'Post', 'Post', 'Tweet']);
});

test('TU01/TU02/TU03 the thumbnail is an asset kind, held once per Concept and needed by every video and reel post only', () => {
  assert.ok(rules.ASSET_KINDS.includes('thumbnail'));
  assert.deepEqual(rules.CONCEPT_ASSET_KINDS, ['script', 'video', 'thumbnail']);
  assert.ok(rules.isConceptAssetKind('thumbnail') && !rules.isConceptAssetKind('image-set'));
  for (const [p, f] of [['linkedin', 'video'], ['x', 'video'], ['facebook', 'video'], ['instagram', 'reel']] as const) {
    assert.deepEqual(rules.assetsNeeded(p, f), ['post-text', 'video', 'thumbnail'], `${p}/${f}`);
  }
  for (const [p, f] of [['linkedin', 'text'], ['x', 'image'], ['instagram', 'carousel'], ['facebook', 'image'], ['blog', 'article']] as const) {
    assert.ok(!rules.assetsNeeded(p, f).includes('thumbnail'), `${p}/${f}`);
  }
});

test('TU04 the finalize rule names a missing thumbnail, after the video', () => {
  for (const state of ['empty', 'drafting'] as const) {
    assert.deepEqual(rules.finalizeCheck(['post-text', 'video', 'thumbnail'], (k) => (k === 'thumbnail' ? state : 'finalized')), { ok: false, missing: ['thumbnail'] });
  }
  assert.deepEqual(rules.finalizeCheck(['post-text', 'video', 'thumbnail'], (k) => (k === 'post-text' ? 'finalized' : 'empty')), { ok: false, missing: ['video', 'thumbnail'] });
});

test('SU05/SU06 image set ranges', () => {
  assert.deepEqual(rules.imageRange('x', 'image'), { min: 1, max: 4 });
  assert.deepEqual(rules.imageRange('linkedin', 'image'), { min: 1, max: 1 });
  assert.deepEqual(rules.imageRange('instagram', 'carousel'), { min: 2, max: 20 });
  assert.deepEqual(rules.imageRange('facebook', 'carousel'), { min: 2, max: 10 });
  assert.equal(rules.imageRange('linkedin', 'video'), null);
});

test('SU08/SU10 the finalize rule lists what is missing, and drafting demotes a finalized post only', () => {
  const states: Record<string, rules.AssetState> = { 'post-text': 'finalized', video: 'drafting' };
  assert.deepEqual(rules.finalizeCheck(['post-text', 'video'], (k) => states[k]), { ok: false, missing: ['video'] });
  assert.deepEqual(rules.finalizeCheck(['post-text', 'image-set'], (k) => states[k]), { ok: false, missing: ['image-set'] });
  assert.deepEqual(rules.finalizeCheck([], () => undefined), { ok: true, missing: [] });
  assert.deepEqual(rules.finalizeCheck(['post-text'], (k) => states[k]), { ok: true, missing: [] });
  assert.deepEqual((['draft', 'finalized', 'published'] as const).map(rules.statusAfterAssetDrafting), ['draft', 'draft', 'published']);
});

test('SU27 the Concept tab bar order and enable rules', () => {
  assert.deepEqual(rules.CONCEPT_TABS.map((t) => t.label), ['Overview', 'Script', 'Video', 'Thumbnail', 'Remotion', 'Images', 'Post content', 'Captions', 'Blog']);
  const enabled = (posts: rules.PostShape[]) => rules.conceptTabStates(posts).filter((t) => t.enabled).map((t) => t.key);
  assert.deepEqual(enabled([]), ['overview', 'script']);
  assert.deepEqual(enabled([{ platform: 'instagram', format: 'reel' }]), ['overview', 'script', 'thumbnail', 'captions']);
  assert.deepEqual(enabled([{ platform: 'linkedin', format: 'carousel' }]), ['overview', 'script', 'images', 'post-content']);
  assert.deepEqual(enabled([{ platform: 'blog', format: 'article' }]), ['overview', 'script', 'blog']);
  const off = rules.conceptTabStates([]).find((t) => t.key === 'blog')!;
  assert.equal(off.enabled, false);
  assert.match(off.reason!, /blog/i);
});

test('W05/W06 Video also needs a finalized script; Remotion does not; the reason names what is missing', () => {
  const reel = [{ platform: 'instagram', format: 'reel' }] as rules.PostShape[];
  const video = (posts: rules.PostShape[], scriptFinalized: boolean) => rules.conceptTabStates(posts, { scriptFinalized }).find((t) => t.key === 'video')!;
  assert.deepEqual([video(reel, true).enabled, video(reel, true).reason], [true, null]);
  assert.deepEqual([video(reel, false).enabled, video(reel, false).reason], [false, 'Finalize the script to use this tab']);
  assert.deepEqual([video([], true).enabled, video([], true).reason], [false, 'Add a video or reel post to use this tab']);
  assert.equal(video([], false).reason, 'Add a video or reel post and finalize the script to use this tab');
  assert.equal(rules.conceptTabStates(reel, { scriptFinalized: false, compositionReady: true }).find((t) => t.key === 'remotion')!.enabled, true);
});

test('RS-U38 the Remotion tab needs a video post, then the composition the Video tab scaffolds; the script state does not matter', () => {
  const reel = [{ platform: 'instagram', format: 'reel' }] as rules.PostShape[];
  const remotion = (posts: rules.PostShape[], context: rules.TabContext) => rules.conceptTabStates(posts, context).find((t) => t.key === 'remotion')!;
  for (const scriptFinalized of [false, true]) {
    assert.deepEqual(remotion([], { scriptFinalized, compositionReady: false }), { key: 'remotion', label: 'Remotion', enabled: false, reason: 'Add a video or reel post to use this tab' });
    assert.equal(remotion([], { scriptFinalized, compositionReady: true }).reason, 'Add a video or reel post to use this tab', 'the missing post comes first');
    assert.deepEqual([remotion(reel, { scriptFinalized, compositionReady: false }).enabled, remotion(reel, { scriptFinalized, compositionReady: false }).reason], [false, 'Start the video in the Video tab first']);
    assert.deepEqual([remotion(reel, { scriptFinalized, compositionReady: true }).enabled, remotion(reel, { scriptFinalized, compositionReady: true }).reason], [true, null]);
  }
  assert.equal(remotion(reel, { scriptFinalized: true }).enabled, false, 'an omitted composition flag means none yet');
});

test('RS-U39 the Thumbnail tab needs a video or reel post, whatever the script state', () => {
  const thumbnail = (posts: rules.PostShape[], scriptFinalized = false) => rules.conceptTabStates(posts, { scriptFinalized }).find((t) => t.key === 'thumbnail')!;
  assert.deepEqual(thumbnail([]), { key: 'thumbnail', label: 'Thumbnail', enabled: false, reason: 'Add a video or reel post to use this tab' });
  assert.equal(thumbnail([{ platform: 'linkedin', format: 'image' }, { platform: 'linkedin', format: 'text' }]).enabled, false);
  for (const scriptFinalized of [false, true]) {
    assert.equal(thumbnail([{ platform: 'linkedin', format: 'video' }], scriptFinalized).enabled, true);
    assert.equal(thumbnail([{ platform: 'instagram', format: 'reel' }], scriptFinalized).reason, null);
  }
  assert.deepEqual(rules.CONCEPT_TABS.map((t) => t.key).slice(2, 5), ['video', 'thumbnail', 'remotion']);
});

test('SU28 the web copy of the rules matches the server copy', () => {
  for (const name of ['PLATFORMS', 'PLATFORM_LABELS', 'FORMATS_BY_PLATFORM', 'ASSET_KINDS', 'CONCEPT_ASSET_KINDS', 'ASSET_STATES', 'POST_STATUSES', 'TEXT_NAMES', 'CONCEPT_TABS'] as const) {
    assert.deepEqual((web as Record<string, unknown>)[name], (rules as Record<string, unknown>)[name], name);
  }
  for (const [p, fs] of Object.entries(rules.FORMATS_BY_PLATFORM)) for (const f of fs) {
    const platform = p as rules.Platform;
    assert.deepEqual(web.imageRange(platform, f), rules.imageRange(platform, f), `${p}/${f}`);
    assert.deepEqual(web.assetsNeeded(platform, f), rules.assetsNeeded(platform, f), `${p}/${f}`);
    const posts = [{ platform, format: f }];
    assert.deepEqual(web.conceptTabStates(posts), rules.conceptTabStates(posts));
    assert.deepEqual(web.conceptTabStates(posts, { scriptFinalized: true }), rules.conceptTabStates(posts, { scriptFinalized: true }));
    // RS-U40: one shared table of the Remotion conditions.
    for (const context of [{ scriptFinalized: false, compositionReady: false }, { scriptFinalized: false, compositionReady: true }, { scriptFinalized: true, compositionReady: true }]) {
      assert.deepEqual(web.conceptTabStates(posts, context), rules.conceptTabStates(posts, context));
    }
  }
  assert.deepEqual(web.conceptTabStates([]), rules.conceptTabStates([]));
  assert.deepEqual(web.finalizeCheck(['article'], () => 'empty'), rules.finalizeCheck(['article'], () => 'empty'));
  assert.equal(web.statusAfterAssetDrafting('finalized'), rules.statusAfterAssetDrafting('finalized'));
});

test('SU11/SU12/SU13 name, title and brief limits count characters', () => {
  assert.equal(parseName('  Acme  '), 'Acme');
  throwsField(() => parseName('   '), 'name');
  throwsField(() => parseName(5), 'name');
  throwsField(() => parseName('x'.repeat(81)), 'name');
  assert.equal(parseName('x'.repeat(80)).length, 80);
  assert.equal([...parseName('😀'.repeat(80))].length, 80);
  assert.equal(parseTitle('t'.repeat(200)).length, 200);
  throwsField(() => parseTitle('t'.repeat(201)), 'title');
  throwsField(() => parseTitle(' '), 'title');
  assert.equal(parseBrief(undefined), '');
  assert.equal(parseBrief(''), '');
  assert.equal(parseBrief('b'.repeat(5000)).length, 5000);
  throwsField(() => parseBrief('b'.repeat(5001)), 'brief');
  throwsField(() => parseBrief(7), 'brief');
});

test('SU14 timezone is a listed IANA name', () => {
  assert.equal(parseTimezone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(parseTimezone('UTC'), 'UTC');
  for (const bad of ['Mars/Phobos', '', 'UTC+2', 'europe/berlin', ' Europe/Berlin', 4, undefined]) throwsField(() => parseTimezone(bad), 'timezone');
});

test('SU15 scheduledAt is an ISO instant with Z or an offset', () => {
  assert.equal(parseInstant('2026-10-26T09:30:00Z'), Date.parse('2026-10-26T09:30:00Z'));
  assert.equal(parseInstant('2026-10-26T09:30:00+02:00'), Date.parse('2026-10-26T07:30:00Z'));
  assert.equal(parseInstant('2026-10-26T09:30Z'), Date.parse('2026-10-26T09:30:00Z'));
  for (const bad of ['2026-10-26', '2026-10-26T09:30:00', 'yesterday', 5, undefined, '2026-13-40T00:00:00Z']) throwsField(() => parseInstant(bad), 'scheduledAt');
});

test('SU16 month parameter shapes', () => {
  assert.deepEqual(parseMonth('2026-10'), { year: 2026, month: 10 });
  assert.deepEqual(parseMonth('2026-01'), { year: 2026, month: 1 });
  for (const bad of ['2026-13', '2026-00', '2026-1', '2026-10-01', '', 'abcd-ef', '0000-05', undefined, ['2026-10', '2026-11']]) throwsField(() => parseMonth(bad), 'month');
});

test('SU17 month bounds follow the Building time zone, including a DST month', () => {
  const berlin = monthBounds(2026, 10, 'Europe/Berlin');
  assert.equal(new Date(berlin.start).toISOString(), '2026-09-30T22:00:00.000Z');
  assert.equal(new Date(berlin.end).toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal((berlin.end - berlin.start) / 3_600_000, 31 * 24 + 1, 'the October clock change adds an hour');
  assert.equal(new Date(monthBounds(2026, 12, 'America/Los_Angeles').end).toISOString(), '2027-01-01T08:00:00.000Z');
  assert.equal(new Date(monthBounds(2026, 5, 'Pacific/Auckland').start).toISOString(), '2026-04-30T12:00:00.000Z');
});

test('SU18 paging parameters', () => {
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit('500'), 200);
  assert.equal(parseLimit('7'), 7);
  for (const bad of ['0', '-1', '1.5', 'abc', '1e2']) throwsField(() => parseLimit(bad), 'limit');
  assert.equal(parseOffset(undefined), 0);
  assert.equal(parseOffset('20'), 20);
  throwsField(() => parseOffset('-2'), 'offset');
});

test('SU21 the version changes with any byte and is stable', () => {
  assert.equal(versionOf('abc'), versionOf('abc'));
  assert.notEqual(versionOf('abc'), versionOf('abd'));
});

test('SU23 file names are plain', () => {
  assert.equal(parseFileName(' logo.png '), 'logo.png');
  for (const bad of ['../a', '/etc/passwd', 'a\\b', '', '.', '..', '.env', 'a\u0001b', 'x'.repeat(201), undefined]) throwsField(() => parseFileName(bad), 'name');
});

test('SU24 the diff summary counts added and removed lines', () => {
  assert.equal(diffSummary('a\nb', 'a\nb'), 'No changes');
  assert.equal(diffSummary('', 'x'), '+1 line, -1 line');
  assert.equal(diffSummary('a\nb\nc', 'a\nb\nc\nd\ne'), '+2 lines');
  assert.equal(diffSummary('a\nb\nc', 'a'), '-2 lines');
  assert.match(starterStyle(), /## Video script/);
  assert.equal(STYLE_SECTIONS.length, 7);
});
