import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, daysBetween } from '../src/seo/dates.ts';
import { SeoInputError } from '../src/seo/errors.ts';
import {
  buildReport, digestOf, indexedCounts, indexingChanges, internalLinkChanges, keyNumbers, linkChanges, liveAt, makeTile, positionBuckets, rankMovers, roundTo, summariseLinks,
} from '../src/seo/reportBuild.ts';
import type { CrawlDigest, DayTotals, IndexChange, LinkIn, MoverIn, ReportInputs, Side, TileInput } from '../src/seo/reportBuild.ts';
import { changeText, exportFileName, reportCsv, reportHtml, reportMarkdown, requireCsvTable, sideText } from '../src/seo/reportExport.ts';
import { defaultReportName, lastFullMonth, lastFullWeek, oldestRetainedDay, PERIOD_PRESETS, reportName, resolvePeriod } from '../src/seo/reportPeriod.ts';
import type { PeriodRequest } from '../src/seo/reportPeriod.ts';
import { parseSummary, readSentSummary, summaryInput } from '../src/seo/reportSummary.ts';

/*
 * The report maths with fixed data and an injected clock. "Now" is Thursday 15 October 2026, 12:00 UTC (Pacific: the 15th too).
 * With a 12-month window the oldest retained day is 2025-10-15.
 */
const NOW = new Date('2026-10-15T12:00:00Z');
const at = (iso: string) => new Date(`${iso}Z`);
const period = (request: Partial<PeriodRequest> & { preset: PeriodRequest['preset'] }, lastFinalDay: string | null = '2026-10-14', now = NOW, retentionMonths = 12) =>
  resolvePeriod({ includePartial: false, ...request }, { now, lastFinalDay, retentionMonths });
const win = (from: string, to: string) => ({ from, to });

// ---- periods ---------------------------------------------------------------------------------------------------------------

test('U01 this week vs last week: Monday to the last final day, against the full week before', () => {
  const p = period({ preset: 'week' });
  assert.deepEqual([p.current, p.previous], [win('2026-10-12', '2026-10-14'), win('2026-10-05', '2026-10-11')]);
  assert.deepEqual([p.lengths, p.perDay, p.weekStart], [{ current: 3, previous: 7 }, true, 'monday']);
});

test('U02 on a Monday with no final day in the week yet the current side has no data and nothing throws', () => {
  const p = period({ preset: 'week' }, '2026-10-10', at('2026-10-12T12:00:00'));
  assert.equal(p.current, null);
  assert.deepEqual(p.previous, win('2026-10-05', '2026-10-11'));
  assert.deepEqual(p.lengths, { current: 0, previous: 7 });
});

test('U03 on a Sunday the week runs Monday to Saturday (Sunday is today, not final)', () => {
  const p = period({ preset: 'week' }, '2026-10-17', at('2026-10-18T12:00:00'));
  assert.deepEqual(p.current, win('2026-10-12', '2026-10-17'));
  assert.equal(p.trimmedDays, 1);
});

test('U04 this month vs last month mid-month, lengths differ so totals go per day', () => {
  const p = period({ preset: 'month' });
  assert.deepEqual([p.current, p.previous, p.perDay], [win('2026-10-01', '2026-10-14'), win('2026-09-01', '2026-09-30'), true]);
});

test('U05 month presets cross a year end and handle February in leap and ordinary years', () => {
  assert.deepEqual(period({ preset: 'month' }, '2027-01-14', at('2027-01-15T12:00:00')).previous, win('2026-12-01', '2026-12-31'));
  assert.deepEqual(period({ preset: 'month' }, '2028-03-14', at('2028-03-15T12:00:00')).previous, win('2028-02-01', '2028-02-29'));
  assert.deepEqual(period({ preset: 'month' }, '2027-03-14', at('2027-03-15T12:00:00')).previous, win('2027-02-01', '2027-02-28'));
});

test('U06 last 28 days ends at the last final day and the previous 28 sit right before it without overlap', () => {
  const p = period({ preset: 'last-28' });
  assert.deepEqual([p.current, p.previous], [win('2026-09-17', '2026-10-14'), win('2026-08-20', '2026-09-16')]);
  assert.equal(daysBetween(p.current!.from, p.current!.to).length, 28);
  assert.equal(addDays(p.previous!.to, 1), p.current!.from);
  assert.equal(p.perDay, false);
});

test('U07 a custom range compares with the equal-length range right before it', () => {
  const p = period({ preset: 'custom', from: '2026-09-01', to: '2026-09-10' });
  assert.deepEqual([p.current, p.previous, p.perDay], [win('2026-09-01', '2026-09-10'), win('2026-08-22', '2026-08-31'), false]);
});

test('U08 a custom comparison of another length is honoured and compared per day', () => {
  const p = period({ preset: 'custom', from: '2026-09-01', to: '2026-09-10', compareFrom: '2026-08-01', compareTo: '2026-08-31' });
  assert.deepEqual([p.previous, p.lengths, p.perDay], [win('2026-08-01', '2026-08-31'), { current: 10, previous: 31 }, true]);
});

test('U09 a single day is a valid custom range', () => {
  const p = period({ preset: 'custom', from: '2026-09-10', to: '2026-09-10' });
  assert.deepEqual([p.current, p.previous], [win('2026-09-10', '2026-09-10'), win('2026-09-09', '2026-09-09')]);
});

test('U10 a reversed range is refused', () => {
  assert.throws(() => period({ preset: 'custom', from: '2026-09-10', to: '2026-09-01' }), /from must not be after to/);
});

test('U11 dates that are not YYYY-MM-DD are refused', () => {
  for (const bad of ['2026-9-1', '2026/09/01', '2026-09-01T00:00:00Z', 20260901, null, undefined]) {
    assert.throws(() => period({ preset: 'custom', from: bad, to: '2026-09-10' }), SeoInputError, String(bad));
  }
});

test('U12 an impossible date is refused', () => {
  assert.throws(() => period({ preset: 'custom', from: '2026-02-30', to: '2026-09-10' }), /YYYY-MM-DD/);
});

test('U13 an end date after Pacific today is refused', () => {
  assert.throws(() => period({ preset: 'custom', from: '2026-10-01', to: '2026-10-16' }), /future/);
  assert.equal(period({ preset: 'custom', from: '2026-10-01', to: '2026-10-15' }, '2026-10-14').current!.to, '2026-10-14');
});

test('U14 exactly 400 days are accepted and 401 are refused', () => {
  assert.doesNotThrow(() => period({ preset: 'custom', from: addDays('2026-10-14', -399), to: '2026-10-14' }));
  assert.throws(() => period({ preset: 'custom', from: addDays('2026-10-14', -400), to: '2026-10-14' }), /at most 400 days/);
});

test('U15 extreme years are refused by the length and the future rules', () => {
  assert.throws(() => period({ preset: 'custom', from: '1000-01-01', to: '2026-10-14' }), /at most 400 days/);
  assert.throws(() => period({ preset: 'custom', from: '0001-01-01', to: '2026-10-14' }), SeoInputError);
  assert.throws(() => period({ preset: 'custom', from: '2026-10-01', to: '9999-12-31' }), /future/);
});

test('U16 a range inside the retained window has no clip', () => {
  const p = period({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(p.clipped, { current: null, previous: null });
});

test('U17 starting on the oldest retained day is fine; one day earlier is clipped', () => {
  assert.equal(oldestRetainedDay(12, NOW), '2025-10-15');
  assert.equal(period({ preset: 'custom', from: '2025-10-15', to: '2025-10-24' }).clipped.current, null);
  const early = period({ preset: 'custom', from: '2025-10-14', to: '2025-10-24' });
  assert.equal(early.clipped.current, 'partly');
});

test('U18 a current range reaching before the window is clipped and the oldest day is named in the report', () => {
  const p = period({ preset: 'custom', from: '2025-10-01', to: '2025-10-31' });
  assert.deepEqual(p.current, win('2025-10-15', '2025-10-31'));
  const report = buildReport(inputs({ period: p }));
  assert.ok(report.notes.some((n) => n.includes('2025-10-15') && /reaches before/.test(n)));
});

test('U19 a comparison entirely before the window is "no data" while the current side still shows', () => {
  const p = period({ preset: 'custom', from: '2025-10-15', to: '2025-10-24' });
  assert.deepEqual([p.current, p.previous, p.clipped.previous], [win('2025-10-15', '2025-10-24'), null, 'before']);
});

test('U20 both ranges before the window give no data on both sides and no throw', () => {
  const p = period({ preset: 'custom', from: '2025-01-01', to: '2025-01-10' });
  assert.deepEqual([p.current, p.previous], [null, null]);
  const report = buildReport(inputs({ period: p }));
  assert.equal(report.tiles.find((t) => t.key === 'clicks')!.state, 'no-data');
  assert.ok(report.notes.some((n) => n.includes('2025-10-15')));
});

test('U21 the Building\'s own retention setting sets the window', () => {
  assert.equal(oldestRetainedDay(6, NOW), '2026-04-15');
  const p = period({ preset: 'custom', from: '2026-04-01', to: '2026-04-30' }, '2026-10-14', NOW, 6);
  assert.deepEqual(p.current, win('2026-04-15', '2026-04-30'));
});

test('U22 no year-over-year preset exists and a comparison a year back is clipped by the same rule', () => {
  assert.deepEqual([...PERIOD_PRESETS], ['week', 'month', 'last-28', 'custom']);
  const p = period({ preset: 'custom', from: '2026-09-01', to: '2026-09-10', compareFrom: '2025-09-01', compareTo: '2025-09-10' });
  assert.equal(p.previous, null);
  assert.equal(p.clipped.previous, 'before');
});

test('U23 today (Pacific) is left out by default and counted as trimmed', () => {
  const p = period({ preset: 'last-28' }, null);
  assert.equal(p.current!.to, '2026-10-14');
  const custom = period({ preset: 'custom', from: '2026-10-01', to: '2026-10-15' }, null);
  assert.deepEqual([custom.current!.to, custom.trimmedDays], ['2026-10-14', 1]);
});

test('U24 days after the last final day (Search Console\'s late days) are left out by default', () => {
  const p = period({ preset: 'custom', from: '2026-10-01', to: '2026-10-14' }, '2026-10-12');
  assert.deepEqual([p.current!.to, p.trimmedDays], ['2026-10-12', 2]);
});

test('U25 including partial days brings in today and the late days, and the report says so', () => {
  const p = period({ preset: 'last-28', includePartial: true });
  assert.equal(p.current!.to, '2026-10-15');
  const report = buildReport(inputs({ period: p }));
  assert.ok(report.notes.some((n) => /Partial days are included/.test(n)));
});

test('U26 Pacific time decides "today": at 06:30 UTC on the 15th it is still the 14th', () => {
  const early = at('2026-10-15T06:30:00');
  const p = period({ preset: 'last-28' }, null, early);
  assert.equal(p.current!.to, '2026-10-13');
  assert.throws(() => period({ preset: 'custom', from: '2026-10-01', to: '2026-10-15' }, null, early), /future/);
});

test('U27 a missing day inside the range makes the period partial and values cover the fetched days only', () => {
  const p = period({ preset: 'last-28' });
  const days = fetchedDays(p).filter((d) => d !== '2026-10-01');
  const report = buildReport(inputs({ period: p, gscDays: new Set(days) }));
  assert.equal(report.coverage.gsc.current, 27);
  assert.equal(tile(report, 'clicks').current, 27 * 12);
  assert.ok(report.notes.some((n) => /covers 27 of 28 days/.test(n)));
});

test('U28 Search Console and Analytics coverage are computed on their own', () => {
  const p = period({ preset: 'last-28' });
  const report = buildReport(inputs({ period: p, ga4Days: new Set(daysBetween(p.current!.from, p.current!.to).slice(0, 12)) }));
  assert.equal(report.coverage.gsc.current, 28);
  assert.equal(report.coverage.ga4.current, 12);
});

// ---- comparison maths ---------------------------------------------------------------------------------------------------------

const ok = (key: TileInput['key'], current: number | null, previous: number | null, days = [1, 1]): TileInput => ({
  key, state: 'ok', current: { value: current, days: days[0]! }, previous: { value: previous, days: days[1]! },
});

test('U29 totals of different lengths are compared per day and rates directly', () => {
  const clicks = makeTile(ok('clicks', 310, 300, [31, 30]), true);
  assert.deepEqual([clicks.perDay, clicks.change, clicks.direction], [true, 0, 'flat']);
  assert.match(clicks.note ?? '', /per day \(31 vs 30 days\)/);
  const ctr = makeTile(ok('ctr', 0.1, 0.08, [31, 30]), true);
  assert.deepEqual([ctr.perDay, ctr.change], [false, 2]);
});

test('U30 totals of equal length are compared directly with no per-day note', () => {
  const t = makeTile(ok('clicks', 120, 100, [28, 28]), false);
  assert.deepEqual([t.perDay, t.change, t.changePct, t.note], [false, 20, 20, null]);
});

test('U31 CTR is total clicks over total impressions, not the mean of daily CTRs', () => {
  const p = period({ preset: 'last-28' });
  const report = buildReport(inputs({ period: p, dayOverride: (d, w) => (w === 'current' && d === p.current!.from ? { clicks: 100, impressions: 100, positionImpressions: 100 } : null) }));
  const days = fetchedDays(p);
  assert.ok(days.length > 0);
  const clicks = 27 * 12 + 100;
  const impressions = 27 * 100 + 100;
  assert.equal(tile(report, 'ctr').current, roundTo((clicks / impressions) * 100, 2));
});

test('U32 CTR is a percentage with 2 decimals, rounded half away from zero', () => {
  assert.equal(makeTile(ok('ctr', 0.02045, 0.01), false).current, 2.05);
  assert.equal(makeTile(ok('ctr', 0.020449, 0.01), false).current, 2.04);
  assert.equal(roundTo(-1.005, 2), -1.01);
  assert.equal(roundTo(0.5, 0), 1);
  assert.equal(roundTo(-0.5, 0), -1);
});

test('U33 average position is weighted by impressions, not a mean of days', () => {
  const p = period({ preset: 'last-28' });
  const report = buildReport(inputs({ period: p, dayOverride: (d, w) => (w === 'current' && d === p.current!.from ? { clicks: 0, impressions: 900, positionImpressions: 900 * 1 } : null) }));
  const weighted = (27 * 400 + 900) / (27 * 100 + 900);
  assert.equal(tile(report, 'position').current, roundTo(weighted, 1));
});

test('U34 position rounds to 1 decimal and zero impressions give "no data", not 0', () => {
  assert.equal(makeTile(ok('position', 2.25, 3), false).current, 2.3);
  assert.equal(makeTile(ok('position', 2.249, 3), false).current, 2.2);
  const p = period({ preset: 'last-28' });
  const report = buildReport(inputs({ period: p, dayOverride: () => ({ clicks: 0, impressions: 0, positionImpressions: 0 }) }));
  assert.deepEqual([tile(report, 'position').current, tile(report, 'ctr').current], [null, null]);
  assert.equal(tile(report, 'position').state, 'no-data');
});

test('U35 from zero is "new" with no percentage; zero to zero is flat; a missing side gives no change', () => {
  const fresh = makeTile(ok('clicks', 5, 0), false);
  assert.deepEqual([fresh.isNew, fresh.changePct, fresh.change, fresh.direction], [true, null, 5, 'up']);
  const none = makeTile(ok('clicks', 0, 0), false);
  assert.deepEqual([none.isNew, none.changePct, none.direction], [false, null, 'flat']);
  const missing = makeTile(ok('clicks', 5, null), false);
  assert.deepEqual([missing.change, missing.direction, missing.missing], [null, null, 'previous']);
});

test('U36 each metric has its own good direction and every cue has a glyph and a word', () => {
  const clicksUp = makeTile(ok('clicks', 12, 10), false);
  assert.deepEqual([clicksUp.glyph, clicksUp.verdict], ['▲', 'better']);
  const positionDown = makeTile(ok('position', 4, 5), false);
  assert.deepEqual([positionDown.glyph, positionDown.verdict, positionDown.change], ['▼', 'better', -1]);
  const positionUp = makeTile(ok('position', 6, 5), false);
  assert.deepEqual([positionUp.glyph, positionUp.verdict], ['▲', 'worse']);
  const lostUp = makeTile(ok('lostBacklinks', 7, 3), false);
  assert.deepEqual([lostUp.glyph, lostUp.verdict], ['▲', 'worse']);
  assert.match(changeText(positionUp), /▲.*worse/);
});

test('U37 a change that rounds to zero is flat', () => {
  const t = makeTile(ok('position', 3.04, 3.0), false);
  assert.deepEqual([t.change, t.direction, t.verdict, t.glyph], [0, 'flat', 'flat', '■']);
});

test('U38 the percentage change of position is relative to the previous position', () => {
  assert.equal(makeTile(ok('position', 3, 4), false).changePct, -25);
});

test('U39 snapshot metrics are not divided per day', () => {
  const t = makeTile(ok('referringDomains', 120, 100, [31, 30]), true);
  assert.deepEqual([t.perDay, t.change], [false, 20]);
});

test('U40 data in only one period shows that value and no change', () => {
  const t = makeTile(ok('sessions', null, 40), false);
  assert.deepEqual([t.current, t.previous, t.change, t.missing, t.state], [null, 40, null, 'current', 'ok']);
});

test('U41 not connected, no data and a real zero are three different states', () => {
  const p = period({ preset: 'last-28' });
  const off = buildReport(inputs({ period: p, sources: { gsc: true, ga4: false } }));
  assert.equal(tile(off, 'sessions').state, 'not-connected');
  assert.equal(tile(off, 'sessions').current, null);
  const noData = buildReport(inputs({ period: p, ga4Days: new Set() }));
  assert.equal(tile(noData, 'sessions').state, 'no-data');
  const zero = buildReport(inputs({ period: p, ga4Zero: true }));
  assert.deepEqual([tile(zero, 'sessions').state, tile(zero, 'sessions').current], ['ok', 0]);
});

test('U42 backlinks not imported are "not available yet"; imported with none new is a real 0', () => {
  const p = period({ preset: 'last-28' });
  assert.equal(tile(buildReport(inputs({ period: p })), 'newBacklinks').state, 'not-available');
  const imported = buildReport(inputs({ period: p, backlinks: { imported: true, links: [link({ firstSeen: '2020-01-01' })] } }));
  assert.deepEqual([tile(imported, 'newBacklinks').state, tile(imported, 'newBacklinks').current], ['ok', 0]);
});

test('U43 a Building with nothing connected or imported gets setup guidance, not an empty report', () => {
  const p = period({ preset: 'last-28' });
  const empty = buildReport(inputs({ period: p, sources: { gsc: false, ga4: false }, nothing: true }));
  assert.equal(empty.state, 'setup');
  assert.ok(empty.setup.length >= 3);
  assert.deepEqual(empty.tiles, []);
});

test('U44 tasks completed count inclusively on the first and last day and ignore the rest', () => {
  const p = period({ preset: 'last-28' });
  const items = [
    { id: 'a', title: 'first day', kind: 'content', at: '2026-09-17' }, { id: 'b', title: 'last day', kind: 'content', at: '2026-10-14' },
    { id: 'c', title: 'before', kind: 'content', at: '2026-09-16' }, { id: 'd', title: 'after', kind: 'content', at: '2026-10-15' },
  ];
  const report = buildReport(inputs({ period: p, work: { completedTasks: items, agentRuns: [], anyTasks: true } }));
  assert.equal(tile(report, 'tasksCompleted').current, 2);
  assert.equal(tile(report, 'tasksCompleted').previous, 1);
  assert.deepEqual(report.work.tasks.map((t) => t.id), ['a', 'b']);
});

// ---- keywords ----------------------------------------------------------------------------------------------------------------------

test('U45 top 3, 10 and 20 boundaries', () => {
  assert.deepEqual(positionBuckets([3.0]), { top3: 1, top10: 1, top20: 1 });
  assert.deepEqual(positionBuckets([3.01]), { top3: 0, top10: 1, top20: 1 });
  assert.deepEqual(positionBuckets([10.0, 10.01]), { top3: 0, top10: 1, top20: 2 });
  assert.deepEqual(positionBuckets([20.0, 20.01]), { top3: 0, top10: 0, top20: 1 });
});

test('U46 the counts are cumulative', () => {
  const b = positionBuckets([1, 2, 5, 8, 15, 40]);
  assert.ok(b.top3 <= b.top10 && b.top10 <= b.top20);
  assert.deepEqual(b, { top3: 2, top10: 4, top20: 5 });
});

test('U47 keywords with no usable position are ignored', () => {
  assert.deepEqual(positionBuckets([0, Number.NaN, null, undefined, -1, Number.POSITIVE_INFINITY]), { top3: 0, top10: 0, top20: 0 });
});

test('U48 a keyword\'s position is its impression-weighted average over the period, not per day', () => {
  const p = period({ preset: 'last-28' });
  const report = buildReport(inputs({ period: p, keywordPositions: { current: [(1 * 10 + 9 * 90) / 100], previous: [(1 * 10 + 9 * 90) / 100] } }));
  assert.equal(tile(report, 'top10').current, 1);
  assert.equal(tile(report, 'top3').current, 0);
});

// ---- winners and losers -------------------------------------------------------------------------------------------------------------

const mover = (name: string, c: [number, number], i: [number, number], pos: [number | null, number | null] = [5, 5]): MoverIn => ({
  name, clicksCurrent: c[0], clicksPrevious: c[1], impressionsCurrent: i[0], impressionsPrevious: i[1], positionCurrent: pos[0], positionPrevious: pos[1],
});
const same = { daysCurrent: 28, daysPrevious: 28 };

test('U49 the impressions threshold includes exactly-at and excludes one below, in both periods', () => {
  const r = rankMovers([mover('at', [20, 10], [50, 50]), mover('below', [30, 0], [49, 50]), mover('priorBelow', [30, 0], [50, 49])], { minImpressions: 50, ...same });
  assert.deepEqual(r.gains.map((m) => m.name), ['at']);
  assert.equal(r.belowThreshold, 2);
});

test('U50 ranking is by absolute click change; ties go to more impressions, then alphabetical', () => {
  const r = rankMovers([mover('b', [20, 10], [100, 100]), mover('a', [20, 10], [100, 100]), mover('c', [20, 10], [300, 100]), mover('big', [50, 10], [60, 60])], { minImpressions: 0, ...same });
  assert.deepEqual(r.gains.map((m) => m.name), ['big', 'c', 'a', 'b']);
});

test('U51 gains and losses are separate, no change appears in neither, each list is capped at 10', () => {
  const rows = [...Array.from({ length: 12 }, (_, i) => mover(`up${String(i).padStart(2, '0')}`, [20 + i, 10], [100, 100])), mover('down', [1, 11], [100, 100]), mover('steady', [10, 10], [100, 100])];
  const r = rankMovers(rows, { minImpressions: 0, ...same });
  assert.equal(r.gains.length, 10);
  assert.deepEqual(r.losses.map((m) => m.name), ['down']);
  assert.ok(![...r.gains, ...r.losses].some((m) => m.name === 'steady'));
});

test('U52 position movers need a position on both sides', () => {
  const r = rankMovers([mover('better', [10, 10], [100, 100], [3, 6]), mover('worse', [10, 10], [100, 100], [9, 4]), mover('gone', [10, 10], [100, 100], [null, 4])], { minImpressions: 0, ...same });
  assert.deepEqual(r.positionGains.map((m) => m.name), ['better']);
  assert.deepEqual(r.positionLosses.map((m) => m.name), ['worse']);
});

test('U53 totals compared per day when the periods differ in length', () => {
  const r = rankMovers([mover('page', [30, 70], [100, 100])], { minImpressions: 0, daysCurrent: 3, daysPrevious: 7 });
  assert.deepEqual([r.gains.length, r.losses.length], [0, 0]);
  const r2 = rankMovers([mover('page', [60, 70], [100, 100])], { minImpressions: 0, daysCurrent: 3, daysPrevious: 7 });
  assert.deepEqual(r2.gains.map((m) => m.change), [10]);
});

test('U54 the threshold input is a whole number from 0', async () => {
  const { parseReportQuery } = await import('../src/seo/reportData.ts');
  assert.equal(parseReportQuery({ minImpressions: '0' }).minImpressions, 0);
  assert.equal(parseReportQuery({}).minImpressions, 50);
  for (const bad of ['-1', '1.5', 'abc', String(2 ** 53 + 2), '1e3']) assert.throws(() => parseReportQuery({ minImpressions: bad }), /minImpressions/, bad);
});

test('U55 nothing meeting the threshold gives empty lists, not null', () => {
  const r = rankMovers([mover('tiny', [2, 1], [3, 3])], { minImpressions: 50, ...same });
  assert.deepEqual([r.gains, r.losses, r.positionGains, r.positionLosses, r.belowThreshold], [[], [], [], [], 1]);
});

// ---- backlinks --------------------------------------------------------------------------------------------------------------------------

const link = (over: Partial<LinkIn> = {}): LinkIn => ({ sourceUrl: 'https://a.test/x', sourceHost: 'a.test', targetUrl: 'https://example.com/', firstSeen: '2026-01-01', lostAt: '', sourceDr: null, sourceUr: null, ...over });

test('U56 new is first seen in the period and lost is lost in it, ends inclusive', () => {
  const w = win('2026-09-17', '2026-10-14');
  const r = linkChanges([link({ sourceUrl: 'in1', firstSeen: '2026-09-17' }), link({ sourceUrl: 'in2', firstSeen: '2026-10-14' }), link({ sourceUrl: 'out', firstSeen: '2026-09-16' }), link({ sourceUrl: 'l1', lostAt: '2026-10-14' }), link({ sourceUrl: 'l2', lostAt: '2026-09-16' })], w);
  assert.deepEqual(r.added.map((l) => l.sourceUrl), ['in1', 'in2']);
  assert.deepEqual(r.lost.map((l) => l.sourceUrl), ['l1']);
});

test('U57 a link first seen and lost in the same period counts as both', () => {
  const r = linkChanges([link({ firstSeen: '2026-09-20', lostAt: '2026-10-01' })], win('2026-09-17', '2026-10-14'));
  assert.deepEqual([r.added.length, r.lost.length], [1, 1]);
});

test('U58 the links live at the end of each period decide referring domains and DR/UR', () => {
  const links = [link({ sourceHost: 'a', firstSeen: '2026-01-01', sourceDr: 50 }), link({ sourceHost: 'b', firstSeen: '2026-10-01', sourceDr: 70 }), link({ sourceHost: 'c', firstSeen: '2026-01-01', lostAt: '2026-09-20', sourceDr: 10 })];
  assert.equal(liveAt(links, '2026-09-16').length, 2);
  assert.equal(liveAt(links, '2026-10-14').length, 2);
  assert.equal(summariseLinks(liveAt(links, '2026-09-16')).avgDr, 30);
  assert.equal(summariseLinks(liveAt(links, '2026-10-14')).avgDr, 60);
});

test('U59 averages count only links with a value; a DR of 0 counts', () => {
  const s = summariseLinks([link({ sourceDr: 0, sourceUr: 20 }), link({ sourceDr: 40, sourceHost: 'b' }), link({ sourceHost: 'c' })]);
  assert.deepEqual([s.avgDr, s.withDr, s.avgUr, s.withUr, s.links], [20, 2, 20, 1, 3]);
});

test('U60 no DR or UR anywhere hides the tile; partial coverage is spelled out', () => {
  const p = period({ preset: 'last-28' });
  const none = buildReport(inputs({ period: p, backlinks: { imported: true, links: [link()] } }));
  assert.equal(none.tiles.some((t) => t.key === 'avgDr'), false);
  const some = buildReport(inputs({ period: p, backlinks: { imported: true, links: [link({ sourceDr: 40 }), link({ sourceHost: 'b' })] } }));
  assert.equal(tile(some, 'avgDr').detail, '1 of 2 links have DR');
  assert.equal(some.tiles.some((t) => t.key === 'avgUr'), false);
});

test('U61 lists sort by DR descending with missing last, ties by source', () => {
  const r = linkChanges([link({ sourceUrl: 'z', firstSeen: '2026-10-01', sourceDr: 10 }), link({ sourceUrl: 'm', firstSeen: '2026-10-01' }), link({ sourceUrl: 'b', firstSeen: '2026-10-01', sourceDr: 10 }), link({ sourceUrl: 'h', firstSeen: '2026-10-01', sourceDr: 80 })], win('2026-09-17', '2026-10-14'));
  assert.deepEqual(r.added.map((l) => l.sourceUrl), ['h', 'b', 'z', 'm']);
  assert.equal(r.added[3]!.dr, null);
});

test('U62 referring domains are distinct source hosts', () => {
  assert.equal(summariseLinks([link(), link({ sourceUrl: 'x2' }), link({ sourceHost: 'b.test' })]).referringDomains, 2);
});

// ---- indexing and internal links -----------------------------------------------------------------------------------------------------

const change = (url: string, toState: string, at: string): IndexChange => ({ url, toState, at });

test('U63 newly indexed and newly excluded come from the change log', () => {
  const log = [change('a', 'not-indexed', '2026-08-01T00:00:00Z'), change('a', 'indexed', '2026-10-01T00:00:00Z'), change('b', 'indexed', '2026-08-01T00:00:00Z'), change('b', 'not-indexed', '2026-10-02T00:00:00Z'), change('c', 'indexed', '2026-10-03T00:00:00Z')];
  const r = indexingChanges(log, win('2026-09-17', '2026-10-14'));
  assert.deepEqual([r.newlyIndexed, r.newlyExcluded], [['a'], ['b']], 'c was first inspected inside the window: a baseline, not a change');
});

test('U63b with no log before the window nothing is listed as a change', () => {
  assert.deepEqual(indexingChanges([change('a', 'indexed', '2026-10-03T00:00:00Z')], win('2026-09-17', '2026-10-14')), { newlyIndexed: [], newlyExcluded: [] });
});

test('U64 a URL that goes out and back in during the period appears in neither list', () => {
  const log = [change('a', 'indexed', '2026-08-01T00:00:00Z'), change('a', 'not-indexed', '2026-10-01T00:00:00Z'), change('a', 'indexed', '2026-10-05T00:00:00Z')];
  assert.deepEqual(indexingChanges(log, win('2026-09-17', '2026-10-14')), { newlyIndexed: [], newlyExcluded: [] });
});

test('U65 indexed versus submitted at each period end', () => {
  const submitted = [{ url: 'a', firstSeen: '2026-01-01' }, { url: 'b', firstSeen: '2026-01-01' }, { url: 'c', firstSeen: '2026-10-10' }];
  const log = [change('a', 'indexed', '2026-02-01T00:00:00Z'), change('c', 'indexed', '2026-10-11T00:00:00Z')];
  assert.deepEqual(indexedCounts(submitted, log, '2026-09-30'), { submitted: 2, indexed: 1 });
  assert.deepEqual(indexedCounts(submitted, log, '2026-10-14'), { submitted: 3, indexed: 2 });
});

const crawl = (edges: string[], orphans = 0, outbound: Record<string, number> = {}): CrawlDigest => ({ finishedAt: '2026-10-01T00:00:00Z', edges, outbound, orphans });

test('U65b a period ending before the earliest known state is "no data", never a count of 0', () => {
  const submitted = [{ url: 'a', firstSeen: '2026-01-01' }];
  const log = [change('a', 'indexed', '2026-10-01T00:00:00Z')];
  assert.equal(indexedCounts(submitted, log, '2026-09-30'), null);
  assert.deepEqual(indexedCounts(submitted, log, '2026-10-01'), { submitted: 1, indexed: 1 });
  assert.equal(indexedCounts(submitted, [], '2026-10-01'), null);
  const p = period({ preset: 'last-28' });
  const base = inputs({ period: p });
  const report = buildReport({ ...base, indexing: { submitted, changes: log } });
  const t = tile(report, 'indexed');
  assert.deepEqual([t.current, t.previous, t.missing, t.change], [1, null, 'previous', null]);
  assert.ok(report.notes.some((n) => /Indexing is known from 2026-10-01/.test(n)));
});

test('U66 two crawls give added and removed links, the orphan change and pages newly over 100 outgoing links', () => {
  const r = internalLinkChanges(crawl(['a > b', 'a > c'], 3, { p: 90 }), crawl(['a > b', 'a > d'], 1, { p: 101, q: 5 }));
  assert.deepEqual([r.available, r.added, r.removed, r.orphansBefore, r.orphansAfter, r.newlyOverLimit], [true, 1, 1, 3, 1, ['p']]);
});

test('U67 fewer than two crawls is "not available yet"', () => {
  const r = internalLinkChanges(null, crawl([]));
  assert.equal(r.available, false);
  assert.match(r.reason ?? '', /two crawls/);
});

test('U68 completed tasks and agent runs in the period are listed with counts; others are left out', () => {
  const p = period({ preset: 'last-28' });
  const report = buildReport(inputs({ period: p, work: {
    completedTasks: [{ id: 't1', title: 'in', kind: 'content', at: '2026-10-01' }, { id: 't2', title: 'out', kind: 'content', at: '2026-08-01' }],
    agentRuns: [{ id: 'r1', title: 'run in', kind: 'audit', at: '2026-10-02' }, { id: 'r2', title: 'run out', kind: 'audit', at: '2026-01-02' }], anyTasks: true,
  } }));
  assert.deepEqual([report.work.tasks.map((t) => t.id), report.work.agentRuns.map((t) => t.id)], [['t1'], ['r1']]);
});

// ---- snapshot and exports ---------------------------------------------------------------------------------------------------------------------

test('U69 the report holds everything the view needs and survives JSON unchanged', () => {
  const report = buildReport(inputs({ period: period({ preset: 'last-28' }), backlinks: { imported: true, links: [link({ firstSeen: '2026-10-01', sourceDr: 50 })] } }));
  const copy = JSON.parse(JSON.stringify(report));
  assert.deepEqual(copy, report);
  for (const key of ['period', 'tiles', 'charts', 'movers', 'backlinks', 'indexing', 'internalLinks', 'work', 'notes', 'coverage', 'digest']) assert.ok(key in copy, key);
  assert.equal(digestOf(copy), report.digest);
});

const evil = '<script>alert("x")</script>';

function richReport() {
  const p = period({ preset: 'last-28' });
  return buildReport(inputs({
    period: p, pages: [mover('=SUM(A1)', [30, 10], [100, 100]), mover('https://x.test/a|b?q="1"', [1, 20], [100, 100])],
    backlinks: { imported: true, links: [link({ sourceUrl: `https://ev.test/${evil}`, firstSeen: '2026-10-01', sourceDr: 50, sourceUr: 20 })] },
    work: { completedTasks: [{ id: 't', title: `+${evil}`, kind: 'content', at: '2026-10-01' }], agentRuns: [], anyTasks: true },
  }));
}

test('U70b the print view and CSV cover internal links, DR/UR coverage and the unavailable states', () => {
  const p = period({ preset: 'last-28' });
  const rich = buildReport(inputs({ period: p, backlinks: { imported: true, links: [link({ firstSeen: '2026-10-01', sourceDr: 50 }), link({ sourceHost: 'b' })] } }));
  const html = reportHtml(rich, { name: 'n', savedAt: null });
  assert.match(html, /<h2>Internal links<\/h2>/);
  assert.match(html, /1 of 2 links have DR/);
  const bare = reportHtml(buildReport(inputs({ period: p })), { name: 'n', savedAt: null });
  assert.match(bare, /Not available yet: import backlinks first/);
  assert.match(bare, /Needs two crawls/);
  assert.match(reportCsv(rich, 'backlinks'), /coverage,1 of 2 links have DR,no data/);
  assert.match(reportCsv(rich, 'internal-links'), /^Item,Value\nstatus,Needs two crawls/);
  const two = { ...rich, internalLinks: { ...rich.internalLinks, available: true, reason: null, added: 2, removed: 1, orphansBefore: 1, orphansAfter: 0, addedSample: ['a > b'] } };
  assert.match(reportCsv(two, 'internal-links'), /links added,2\nlinks removed,1/);
  assert.match(reportCsv(two, 'internal-links'), /added,a > b/);
});

test('U70 CSV neutralises formula starts, quotes and commas, and writes "no data" and "Not connected" as text', () => {
  const report = richReport();
  const pages = reportCsv(report, 'pages');
  assert.match(pages, /'=SUM\(A1\)/);
  assert.match(pages, /"https:\/\/x\.test\/a\|b\?q=""1"""/);
  const scorecard = reportCsv(buildReport(inputs({ period: period({ preset: 'last-28' }), sources: { gsc: true, ga4: false }, ga4Days: new Set() })), 'scorecard');
  assert.match(scorecard, /Sessions,Not connected,Not connected/);
  assert.match(reportCsv(report, 'backlinks'), /'?\+?.*script/);
  assert.match(reportCsv(report, 'work'), /'\+<script>/);
  assert.throws(() => requireCsvTable('nope'), /table must be one of/);
});

test('U71 Markdown has headings and tables, escapes pipes and marks the AI summary', () => {
  const report = richReport();
  const withSummary = { ...report, summary: { paragraph: 'Clicks grew.', actions: ['Refresh page A.'], generatedAt: 'x', periodKey: report.period.key, digest: report.digest, label: 'AI-generated' as const } };
  const md = reportMarkdown(withSummary, { name: 'Week 41 2026', savedAt: '2026-10-15T00:00:00Z' });
  assert.match(md, /^# Week 41 2026/);
  assert.match(md, /## Summary \(AI-generated\)/);
  assert.match(md, /## Scorecard/);
  assert.match(md, /\| Metric \| Current \| Comparison \| Change \|/);
  assert.match(md, /a\\\|b/);
  assert.doesNotMatch(reportMarkdown(report, { name: 'n', savedAt: null }), /AI-generated/);
});

test('U72 the printable page escapes markup in URLs, keywords, task titles and AI text', () => {
  const report = richReport();
  const html = reportHtml({ ...report, summary: { paragraph: evil, actions: [evil], generatedAt: 'x', periodKey: 'k', digest: 'd', label: 'AI-generated' } }, { name: evil, savedAt: null });
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&#60;script&#62;/);
  assert.match(html, /&#34;/);
});

test('U73 key numbers hold null for metrics with no data, never 0', () => {
  const report = buildReport(inputs({ period: period({ preset: 'last-28' }), sources: { gsc: true, ga4: false } }));
  const numbers = keyNumbers(report);
  assert.equal(numbers.sessions, null);
  assert.equal(numbers.newBacklinks, null);
  assert.equal(numbers.clicks, 336);
  assert.equal(numbers.ctr, 12);
});

test('U74 the AI input has the period and numbers but no secrets; the answer is one paragraph plus actions', () => {
  const report = richReport();
  const json = JSON.stringify(summaryInput('building-1', report));
  assert.match(json, /2026-09-17 to 2026-10-14/);
  assert.match(json, /Clicks/);
  for (const secret of ['REFRESH', 'ACCESS-TOKEN', 'properties/', 'sc-domain']) assert.equal(json.includes(secret), false, secret);
  assert.deepEqual(parseSummary({ paragraph: ' Hello. ', actions: [' a ', '', 5, 'b'] }), { paragraph: 'Hello.', actions: ['a', 'b'] });
  for (const bad of [null, {}, { paragraph: '', actions: [] }, { paragraph: 'x', actions: 'no' }, { paragraph: 'x'.repeat(2001), actions: [] }]) assert.throws(() => parseSummary(bad), /summary|too long/, JSON.stringify(bad));
  assert.throws(() => readSentSummary({ paragraph: 'x', actions: [] }), SeoInputError);
  assert.equal(readSentSummary(undefined), null);
});

// ---- scheduling and names ---------------------------------------------------------------------------------------------------------------------

test('U75 a weekly run gives the last full Monday-to-Sunday week and the one before; a monthly run the last two months', () => {
  assert.deepEqual(lastFullWeek('2026-10-12'), { current: win('2026-10-05', '2026-10-11'), previous: win('2026-09-28', '2026-10-04') });
  assert.deepEqual(lastFullWeek('2026-10-15'), lastFullWeek('2026-10-12'));
  assert.deepEqual(lastFullMonth('2026-11-01'), { current: win('2026-10-01', '2026-10-31'), previous: win('2026-09-01', '2026-09-30') });
  assert.deepEqual(lastFullMonth('2026-11-20'), lastFullMonth('2026-11-01'));
});

test('U76 default names follow the ISO week and the month', () => {
  assert.equal(defaultReportName('weekly', win('2026-10-05', '2026-10-11')), 'Week 41 2026');
  assert.equal(defaultReportName('weekly', win('2026-12-28', '2027-01-03')), 'Week 53 2026');
  assert.equal(defaultReportName('monthly', win('2026-09-01', '2026-09-30')), 'September 2026');
});

test('U77 a report name is trimmed, falls back when empty and stops at 80 characters', () => {
  assert.equal(reportName('  My report ', 'x'), 'My report');
  assert.equal(reportName('   ', 'fallback'), 'fallback');
  assert.equal(reportName(undefined, 'fallback'), 'fallback');
  assert.equal(reportName('a'.repeat(80), 'x').length, 80);
  assert.throws(() => reportName('a'.repeat(81), 'x'), /at most 80/);
  assert.throws(() => reportName(5, 'x'), /text/);
  assert.equal(exportFileName('Week 41 / 2026!', 'csv'), 'week-41-2026.csv');
  assert.equal(sideText(makeTile({ key: 'clicks', state: 'ok', current: { value: null, days: 1 }, previous: { value: 1, days: 1 } }, false), 'current'), 'no data');
});

// ---- fixtures -----------------------------------------------------------------------------------------------------------------------------------

function fetchedDays(p: ReturnType<typeof period>): string[] {
  return [p.current, p.previous].flatMap((w) => (w ? daysBetween(w.from, w.to) : []));
}

interface Fixture {
  period: ReturnType<typeof period>;
  sources?: { gsc: boolean; ga4: boolean };
  gscDays?: Set<string>;
  ga4Days?: Set<string>;
  ga4Zero?: boolean;
  dayOverride?: (day: string, which: 'current' | 'previous') => DayTotals | { clicks: number; impressions: number; positionImpressions: number } | null;
  pages?: MoverIn[];
  backlinks?: ReportInputs['backlinks'];
  keywordPositions?: ReportInputs['keywordPositions'];
  work?: ReportInputs['work'];
  nothing?: boolean;
}

/** Search Console: 12 clicks and 100 impressions a day (position 4) now, 10 clicks and position 5 before. Analytics: 5 sessions a day. */
function inputs(f: Fixture): ReportInputs {
  const sources = f.sources ?? { gsc: true, ga4: true };
  const gscDaily = new Map<string, DayTotals>();
  const ga4Daily = new Map<string, DayTotals>();
  for (const [which, w] of [['current', f.period.current], ['previous', f.period.previous]] as const) {
    if (!w) continue;
    for (const d of daysBetween(w.from, w.to)) {
      const override = f.dayOverride?.(d, which);
      const base: DayTotals = which === 'current' ? { clicks: 12, impressions: 100, positionImpressions: 400, sessions: 0, keyEvents: 0 } : { clicks: 10, impressions: 100, positionImpressions: 500, sessions: 0, keyEvents: 0 };
      gscDaily.set(d, { ...base, ...(override ?? {}) });
      ga4Daily.set(d, { clicks: 0, impressions: 0, positionImpressions: 0, sessions: f.ga4Zero ? 0 : 5, keyEvents: f.ga4Zero ? 0 : 1 });
    }
  }
  const all = new Set(fetchedDays(f.period));
  return {
    period: f.period, siteHost: 'example.com', generatedAt: '2026-10-15T12:00:00.000Z', sources,
    gsc: { daily: gscDaily, days: f.gscDays ?? all }, ga4: { daily: ga4Daily, days: f.ga4Days ?? all },
    minImpressions: 50, pages: f.pages ?? [], keywords: [], clusters: [], keywordPositions: f.keywordPositions ?? { current: [2, 8], previous: [2, 15] },
    backlinks: f.backlinks ?? { imported: false, links: [] },
    indexing: { submitted: f.nothing ? [] : [{ url: 'https://example.com/a', firstSeen: '2026-01-01' }], changes: [change('https://example.com/a', 'indexed', '2026-02-01T00:00:00Z')] },
    crawl: { count: f.nothing ? 0 : 2, before: null, after: null },
    work: f.work ?? { completedTasks: [], agentRuns: [], anyTasks: !f.nothing }, capped: false,
  };
}

function tile(report: ReturnType<typeof buildReport>, key: string) {
  const found = report.tiles.find((t) => t.key === key);
  assert.ok(found, `tile ${key}`);
  return found;
}

void (null as unknown as Side);
