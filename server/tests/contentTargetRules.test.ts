import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as web from '../../web/src/lib/contentTargets.ts';
import { PLATFORMS } from '../src/content/rules.ts';
import type { Platform } from '../src/content/rules.ts';
import { DAY_MS, emptyTargets, engagementOf, engagementRateOf, evaluatePost, viewsOfPlatform } from '../src/content/targetRules.ts';
import type { RuleCounts, SnapshotLike, Targets } from '../src/content/targetRules.ts';
import { parseTargets } from '../src/content/targets.ts';
import { parseInsightsAnswer } from '../src/content/insightsAnswer.ts';
import { parsePerformanceQuery } from '../src/content/performance.ts';

interface Case { name: string; platform: Platform; counts: Partial<RuleCounts>; views: number | null; engagement: number | null; rate: number | null }
const CASES = JSON.parse(readFileSync(new URL('./fixtures/contentTargetCases.json', import.meta.url), 'utf8')) as Case[];
const full = (counts: Partial<RuleCounts>): RuleCounts => ({ impressions: null, views: null, likes: null, comments: null, shares: null, saves: null, followersGained: null, ...counts });
const throwsField = (fn: () => unknown, field?: string) => assert.throws(fn, (e: { field?: string }) => e.field === field);

test('U01-U13 engagement, the views rule and the rate, on the shared table, equal on server and web', () => {
  for (const c of CASES) {
    const counts = full(c.counts);
    assert.equal(viewsOfPlatform(c.platform, counts), c.views, c.name);
    assert.equal(engagementOf(counts), c.engagement, c.name);
    assert.equal(engagementRateOf(c.platform, counts), c.rate, c.name);
    assert.equal(web.viewsOfPlatform(c.platform, counts), c.views, c.name);
    assert.equal(web.engagementOf(counts), c.engagement, c.name);
    assert.equal(web.engagementRateOf(c.platform, counts), c.rate, c.name);
  }
});

const D = DAY_MS;
const PUBLISHED = Date.parse('2026-10-01T00:00:00Z');
const targets = (t: Partial<Targets>): Targets => ({ ...emptyTargets(), ...t });
const snap = (atMs: number, counts: Partial<RuleCounts>): SnapshotLike => ({ capturedAt: atMs, counts: full(counts) });
const judge = (t: Partial<Targets>, snapshots: SnapshotLike[], more: { platform?: Platform; windowDays?: number; now?: number } = {}) =>
  evaluatePost({ platform: more.platform ?? 'instagram', publishedAt: PUBLISHED, snapshots, targets: targets(t), windowDays: more.windowDays ?? 7, now: more.now ?? PUBLISHED + 20 * D });

test('U27-U32 a field is hit at the target, missed one under, always hit at 0, no data on null', () => {
  const at = (views: number | null) => judge({ views: 100 }, [snap(PUBLISHED + 7 * D, { views })]).fields[0]!;
  assert.equal(at(100).state, 'hit');
  assert.equal(at(99).state, 'missed');
  assert.equal(at(null).state, 'no-data');
  assert.equal(judge({ likes: 0 }, [snap(PUBLISHED + 8 * D, { views: 1, likes: 0 })]).fields[0]!.state, 'hit');
  assert.equal(judge({ likes: 0 }, [snap(PUBLISHED + 8 * D, { views: 1, likes: 5 })]).fields[0]!.state, 'hit');
  assert.deepEqual(judge({ likes: 1 }, [snap(PUBLISHED + 8 * D, { likes: 1 })]).fields.map((f) => f.field), ['likes']);
  const rate = judge({ engagementRate: 5 }, [snap(PUBLISHED + 8 * D, { views: 200, likes: 10 })]);
  assert.deepEqual([rate.fields[0]!.value, rate.fields[0]!.state], [5, 'hit']);
  assert.equal(judge({ engagementRate: 5 }, [snap(PUBLISHED + 8 * D, { likes: 10 })]).fields[0]!.state, 'no-data');
});

test('U33-U39 the window edge, the latest eligible snapshot, ties, other windows and the too-early progress', () => {
  assert.equal(judge({ views: 1 }, [snap(PUBLISHED + 7 * D, { views: 5 })]).overall, 'on-target');
  const early = judge({ views: 1 }, [snap(PUBLISHED + 7 * D - 1, { views: 5 })]);
  assert.equal(early.overall, 'too-early');
  assert.equal(judge({ views: 10 }, [snap(PUBLISHED + 9 * D, { views: 50 }), snap(PUBLISHED + 8 * D, { views: 1 })]).fields[0]!.value, 50, 'the newest eligible snapshot wins');
  assert.equal(judge({ views: 1 }, [snap(PUBLISHED + 2 * D, { views: 5 })], { windowDays: 1 }).overall, 'on-target');
  assert.equal(judge({ views: 1 }, [snap(PUBLISHED + 89 * D, { views: 5 })], { windowDays: 90 }).overall, 'too-early');
  assert.equal(judge({ views: 1 }, [snap(PUBLISHED + 90 * D, { views: 5 })], { windowDays: 90 }).overall, 'on-target');
  const progress = judge({ views: 1 }, [snap(PUBLISHED + 2 * D, { views: 5 })], { now: PUBLISHED + 3 * D + 5 }).progress;
  assert.deepEqual(progress, { day: 3, of: 7, judgedOn: new Date(PUBLISHED + 7 * D).toISOString(), counts: { ...emptyTargets(), views: 5 } });
  assert.equal(judge({ views: 1 }, [snap(PUBLISHED + 2 * D, { views: 5 })], { now: PUBLISHED + 30 * D }).progress!.day, 7, 'the day never passes the window');
});

test('U39 a published post with no snapshot is too early with no progress', () => {
  const r = judge({ views: 1 }, []);
  assert.deepEqual([r.overall, r.progress, r.judgedFrom], ['too-early', null, null]);
});

test('U40-U47 the overall result, with no target outranking too early and other platforms ignored', () => {
  const s = [snap(PUBLISHED + 8 * D, { views: 100, likes: 1 })];
  assert.equal(judge({ views: 100, likes: 1 }, s).overall, 'on-target');
  assert.equal(judge({ views: 100, likes: 5 }, s).overall, 'partly');
  assert.equal(judge({ views: 100, comments: 5 }, s).overall, 'partly', 'one hit, one no data');
  assert.equal(judge({ views: 101, likes: 2 }, s).overall, 'below-target');
  assert.equal(judge({ comments: 1, shares: 1 }, s).overall, 'below-target', 'every set field without data');
  assert.equal(judge({ views: 100 }, s).overall, 'on-target');
  assert.equal(judge({}, s).overall, 'no-target');
  assert.equal(judge({}, []).overall, 'no-target');
  assert.equal(judge({}, [snap(PUBLISHED, { views: 1 })]).overall, 'no-target', 'no target outranks too early');
});

test('U14-U26 target validation names the field and enforces whole numbers 0 to 10^12 and a 0-100 rate with 2 decimals', () => {
  const base = emptyTargets();
  assert.equal(parseTargets({ likes: 0, views: 1_000_000_000_000 }, base).views, 1_000_000_000_000);
  for (const bad of [1_000_000_000_001, -1, 1.5, '5', true, [], NaN, Infinity, 1e13, {}]) throwsField(() => parseTargets({ likes: bad }, base), 'likes');
  assert.equal(parseTargets({ likes: 3 }, base).likes, 3);
  assert.equal(parseTargets({ likes: null }, { ...base, likes: 3 }).likes, null, 'null clears');
  assert.equal(parseTargets({}, { ...base, likes: 3 }).likes, 3, 'an omitted key is kept');
  throwsField(() => parseTargets({ clicks: 1 }, base), 'clicks');
  for (const ok of [0, 12.5, 99.99, 100]) assert.equal(parseTargets({ engagementRate: ok }, base).engagementRate, ok);
  for (const bad of [100.01, -0.01, 1.234, '3.50', '1e1']) throwsField(() => parseTargets({ engagementRate: bad }, base), 'engagementRate');
  for (const body of [[], 'x', null]) throwsField(() => parseTargets(body, base), undefined);
});

test('U48-U53 the insights answer is strict JSON {markdown}, fenced allowed, at most 30,000 code points', () => {
  assert.equal(parseInsightsAnswer('{"markdown":"## Summary"}'), '## Summary');
  assert.equal(parseInsightsAnswer('```json\n{"markdown":"x"}\n```'), 'x');
  for (const bad of ['{"markdown":"x","extra":1}', '{}', '{"markdown":4}', '[]', 'plain text', '{"markdown":"x"} trailing', '{"markdown":"  "}', '']) assert.throws(() => parseInsightsAnswer(bad), bad);
  assert.equal(parseInsightsAnswer(JSON.stringify({ markdown: 'a'.repeat(30_000) })).length, 30_000);
  assert.throws(() => parseInsightsAnswer(JSON.stringify({ markdown: 'a'.repeat(30_001) })));
  assert.equal([...parseInsightsAnswer(JSON.stringify({ markdown: '😀'.repeat(30_000) }))].length, 30_000);
  assert.throws(() => parseInsightsAnswer(JSON.stringify({ markdown: '😀'.repeat(30_001) })));
});

test('U87 get_performance arguments: closed values, limit 1-100 refused (not clamped) outside it, default 20', () => {
  assert.equal(parsePerformanceQuery({}).limit, 20);
  assert.deepEqual(parsePerformanceQuery({ platform: 'x', format: 'text', result: 'partly', limit: '100' }), { platform: 'x', format: 'text', result: 'partly', limit: 100 });
  assert.equal(parsePerformanceQuery({ limit: 1 }).limit, 1);
  for (const limit of [0, 101, 20.5, 'x', '-1', '1.5']) throwsField(() => parsePerformanceQuery({ limit }), 'limit');
  throwsField(() => parsePerformanceQuery({ platform: 'LinkedIn' }), 'platform');
  throwsField(() => parsePerformanceQuery({ format: 'gif' }), 'format');
  throwsField(() => parsePerformanceQuery({ result: 'good' }), 'result');
});

test('the platform list used by the views rule is the closed set', () => {
  assert.deepEqual(PLATFORMS.filter((p) => viewsOfPlatform(p, { impressions: 1, views: 2 }) === 1), ['linkedin', 'x']);
});
