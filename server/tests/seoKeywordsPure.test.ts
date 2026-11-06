import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SeoConflictError, SeoInputError, SeoNotFoundError } from '../src/seo/errors.ts';
import { parseClusterOutput, planClustering, selectCandidates, splitBatches } from '../src/seo/keywordClustering.ts';
import type { Candidate } from '../src/seo/keywordClustering.ts';
import { applyChanges, createCluster, deleteCluster, mergeClusters, moveKeywords, renameCluster, splitCluster } from '../src/seo/keywordClusters.ts';
import type { ClusterRec, EditState, KeywordRec } from '../src/seo/keywordClusters.ts';
import { csvCell, csvLine, MAX_CSV_ROWS, parseCsv, parseKeywordImport } from '../src/seo/keywordCsv.ts';
import { alignPrevious, bestOf, groupStats, trendOf, zeroSums } from '../src/seo/keywordMetrics.ts';
import type { KeywordStat } from '../src/seo/keywordMetrics.ts';
import { competitorDomain, competitorDomains, freshIdeas, parseResearchOutput } from '../src/seo/keywordResearch.ts';
import {
  CANNIBALISATION_MIN_IMPRESSIONS, cannibalisationRule, impressionsByPage, isCannibalised, MAX_KEYWORD_LENGTH, normalizeKeyword, nameKeyOf, requireKeyword, statusFromText, sumVolumes, volumeFrom,
} from '../src/seo/keywordRules.ts';
import { parseAdsVolume } from '../src/seo/metrics.ts';

/* ----- Normalisation ----- */

test('U1 case folds, so Foo and foo are one keyword', () => {
  assert.equal(normalizeKeyword('Foo'), normalizeKeyword('foo'));
});

test('U2 whitespace is trimmed and collapsed (tab, newline, no-break space)', () => {
  assert.equal(normalizeKeyword('  red\t\n shoes  sale '), 'red shoes sale');
});

test('U3 diacritics are stripped (café = cafe, Ñ = n)', () => {
  assert.equal(normalizeKeyword('Café'), 'cafe');
  assert.equal(normalizeKeyword('Ñandú'), 'nandu');
});

test('U4 composed and decomposed é and full-width forms are equal', () => {
  assert.equal(normalizeKeyword('café'), normalizeKeyword('café'));
  assert.equal(normalizeKeyword('ＳＥＯ ｔｏｏｌｓ'), 'seo tools');
});

test('U5 empty or whitespace-only text is refused', () => {
  assert.equal(normalizeKeyword(''), null);
  assert.equal(normalizeKeyword(' \t\n'), null);
  assert.throws(() => requireKeyword('  '), SeoInputError);
});

test('U6 text over 500 characters is refused, exactly 500 is kept', () => {
  assert.equal(normalizeKeyword('a'.repeat(MAX_KEYWORD_LENGTH + 1)), null);
  assert.equal(normalizeKeyword('a'.repeat(MAX_KEYWORD_LENGTH))?.length, MAX_KEYWORD_LENGTH);
});

test('U7 a value that is not text is refused', () => {
  for (const v of [null, undefined, 5, {}, ['a']]) assert.equal(normalizeKeyword(v), null);
});

test('U8 punctuation is kept so c++ is not c', () => {
  assert.notEqual(normalizeKeyword('c++'), normalizeKeyword('c'));
  assert.equal(normalizeKeyword('C++ Tips'), 'c++ tips');
});

/* ----- Metrics ----- */

const stat = (key: string, current: [number, number, number], previous: [number, number, number] = [0, 0, 0], pages: string[] = [], volume: KeywordStat['volume'] = null): KeywordStat => ({
  key, display: key, current: { clicks: current[0], impressions: current[1], positionImpressions: current[2] }, previous: { clicks: previous[0], impressions: previous[1], positionImpressions: previous[2] }, pages, volume,
});
const both = { current: true, previous: true };

test('U9 combined CTR is recomputed from the sums, not averaged (10 impressions at 10% plus 1000 at 1%)', () => {
  const g = groupStats([stat('a', [1, 10, 10]), stat('b', [10, 1000, 1000])], both);
  assert.equal(g.current!.clicks, 11);
  assert.equal(g.current!.impressions, 1010);
  assert.equal(g.current!.ctr, 11 / 1010);
});

test('U10 position is weighted by impressions', () => {
  const g = groupStats([stat('a', [0, 10, 10 * 2]), stat('b', [0, 30, 30 * 6])], both);
  assert.equal(g.current!.position, (20 + 180) / 40);
});

test('U11 zero impressions give null CTR and null position', () => {
  const g = groupStats([stat('a', [0, 0, 0])], both);
  assert.equal(g.current!.ctr, null);
  assert.equal(g.current!.position, null);
  assert.equal(g.current!.clicks, 0);
});

test('U12 a window with no coverage gives null metrics, never zero', () => {
  const g = groupStats([stat('a', [0, 0, 0])], { current: false, previous: false });
  assert.equal(g.current, null);
  assert.equal(g.change, null);
  assert.equal(g.best, null);
});

test('U14 change is the relative change in clicks against the previous period', () => {
  const g = groupStats([stat('a', [15, 100, 100], [10, 100, 100])], both);
  assert.deepEqual(g.change, { abs: 5, pct: 0.5, isNew: false });
});

test('U15 previous 0 and current above 0 is "new"; both 0 is no change', () => {
  assert.deepEqual(groupStats([stat('a', [3, 10, 10], [0, 10, 10])], both).change, { abs: 3, pct: null, isNew: true });
  assert.equal(groupStats([stat('a', [0, 10, 10], [0, 10, 10])], both).change, null);
});

test('U16 compare off, or a previous side without data, gives null change', () => {
  assert.equal(groupStats([stat('a', [3, 10, 10], [1, 10, 10])], { current: true, previous: false }).change, null);
});

test('U17 best keyword is the most clicks, ties by impressions then alphabetical', () => {
  assert.equal(bestOf([stat('b', [5, 50, 0]), stat('a', [5, 50, 0]), stat('c', [5, 40, 0])])!.key, 'a');
  assert.equal(bestOf([stat('b', [5, 60, 0]), stat('a', [5, 50, 0])])!.key, 'b');
});

test('U18 an empty cluster has 0 keywords and no best', () => {
  const g = groupStats([], both);
  assert.equal(g.keywords, 0);
  assert.equal(g.best, null);
  assert.equal(g.pages, 0);
  assert.equal(g.volume, null);
});

test('U19 the page count is a union: a page shared by two keywords counts once', () => {
  const g = groupStats([stat('a', [1, 1, 1], undefined, ['https://x.com/p', 'https://x.com/q']), stat('b', [1, 1, 1], undefined, ['https://x.com/p'])], both);
  assert.equal(g.pages, 2);
});

test('U20 sums stop at 2^53-1 instead of silently losing digits', () => {
  const g = groupStats([stat('a', [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0]), stat('b', [5, 5, 0])], both);
  assert.equal(g.current!.clicks, Number.MAX_SAFE_INTEGER);
});

test('U21 ignored keywords are counted in sums (status is not part of the maths)', () => {
  const g = groupStats([stat('a', [4, 40, 40]), stat('ignored one', [6, 60, 60])], both);
  assert.equal(g.current!.clicks, 10);
});

/* ----- Volume ----- */

test('U22 1234 is exact; 10, 1000 and 10^7 are ranges', () => {
  assert.deepEqual(parseAdsVolume(1234), { kind: 'exact', value: 1234 });
  assert.deepEqual(parseAdsVolume(10), { kind: 'range', low: 10, high: 100 });
  assert.deepEqual(parseAdsVolume(1000), { kind: 'range', low: 1000, high: 10000 });
  assert.deepEqual(parseAdsVolume(10_000_000), { kind: 'range', low: 10_000_000, high: 100_000_000 });
});

test('U23 negative, NaN, a string and null are unknown', () => {
  for (const v of [-1, NaN, '100', null, undefined]) assert.equal(volumeFrom(v, 'now'), null);
});

test('U24 a volume past 2^53 or 1e15 is treated as unknown', () => {
  assert.equal(volumeFrom(2 ** 53 + 2, 'now'), null);
  assert.equal(volumeFrom(1e15, 'now'), null);
  assert.deepEqual(volumeFrom(1234, 'd'), { kind: 'exact', low: 1234, high: 1234, fetchedAt: 'd' });
});

test('U25 a sum of exact volumes is exact', () => {
  assert.deepEqual(sumVolumes([volumeFrom(120, 'd'), volumeFrom(30, 'd')]), { low: 150, high: 150, exact: true, missing: 0 });
});

test('U26 a sum with any range gives low and high, an exact value counting as low=high', () => {
  assert.deepEqual(sumVolumes([volumeFrom(1000, 'd'), volumeFrom(120, 'd')]), { low: 1120, high: 10120, exact: false, missing: 0 });
});

test('U27 no known volumes sum to null; some unknown is counted as missing', () => {
  assert.equal(sumVolumes([null, undefined]), null);
  assert.equal(sumVolumes([]), null);
  assert.deepEqual(sumVolumes([volumeFrom(120, 'd'), null]), { low: 120, high: 120, exact: true, missing: 1 });
});

/* ----- Cannibalisation ----- */

test('U28 two pages with at least the minimum impressions are flagged', () => {
  assert.equal(isCannibalised([5, 9]), true);
});

test('U29 boundary: 5 counts, 4 does not', () => {
  assert.equal(CANNIBALISATION_MIN_IMPRESSIONS, 5);
  assert.equal(isCannibalised([5, 5]), true);
  assert.equal(isCannibalised([5, 4]), false);
});

test('U30 a single page is not flagged however large', () => {
  assert.equal(isCannibalised([10_000]), false);
  assert.equal(isCannibalised([]), false);
});

test('U31 URL variants count as one page', () => {
  const byPage = impressionsByPage([
    { page: 'https://Example.com/a/', impressions: 3 }, { page: 'http://example.com/a?utm_source=x#f', impressions: 3 }, { page: 'not a url', impressions: 99 },
  ]);
  assert.deepEqual([...byPage], [['https://example.com/a', 6]]);
  assert.equal(isCannibalised(byPage.values()), false, 'one page, however its address is spelled');
});

test('U32 the rule text states the numbers used', () => {
  assert.match(cannibalisationRule(), /Two or more pages.*at least 5 impressions/);
});

/* ----- Trend ----- */

test('U33, U34 the daily series has null on days never fetched and zero on fetched days without rows', () => {
  const perDay = new Map([['2026-03-02', { clicks: 2, impressions: 10, positionImpressions: 30 }]]);
  const points = trendOf({ from: '2026-03-01', to: '2026-03-03' }, '2026-03-01', new Set(['2026-03-02', '2026-03-03']), perDay);
  assert.deepEqual(points.map((p) => p.clicks), [null, 2, 0]);
  assert.equal(points[1]!.position, 3);
  assert.equal(points[2]!.position, null);
  assert.equal(points[0]!.ctr, null);
});

test('U35 the previous period lines up by day offset', () => {
  const points = trendOf({ from: '2026-03-01', to: '2026-03-04' }, '2026-03-03', new Set(), new Map());
  const aligned = alignPrevious(points);
  assert.equal(aligned.length, 2);
  assert.deepEqual([aligned[0]!.previous!.day, aligned[0]!.current!.day], ['2026-03-01', '2026-03-03']);
});

/* ----- Clustering rules ----- */

const cand = (key: string, impressions: number, extra: Partial<Candidate> = {}): Candidate => ({ key, display: key, pinned: false, clusterId: null, impressions, ...extra });

test('U50 cap selection at 0, 499, 500 and 501 candidates', () => {
  for (const [count, selected, capped] of [[0, 0, false], [499, 499, false], [500, 500, false], [501, 500, true]] as const) {
    const s = selectCandidates(Array.from({ length: count }, (_, i) => cand(`k${i}`, i)), 500);
    assert.deepEqual([s.selected.length, s.capped, s.total], [selected, capped, count]);
  }
});

test('U50b the highest impressions are the ones kept', () => {
  const s = selectCandidates(Array.from({ length: 501 }, (_, i) => cand(`k${i}`, i)), 500);
  assert.ok(!s.selected.some((c) => c.key === 'k0'));
  assert.ok(s.selected.some((c) => c.key === 'k500'));
});

test('U51 equal impressions break ties by keyword, deterministically', () => {
  const s = selectCandidates([cand('b', 5), cand('c', 5), cand('a', 5)], 2);
  assert.deepEqual(s.selected.map((c) => c.key), ['a', 'b']);
});

test('U52 the cap message carries the numbers and is absent under the cap', () => {
  const over = selectCandidates([cand('a', 1), cand('b', 2), cand('c', 3)], 2);
  assert.match(over.message!, /Processed 2 of 3 keywords/);
  assert.equal(selectCandidates([cand('a', 1)], 2).message, null);
});

test('U50c keywords nobody placed come before placed ones, and pinned ones last', () => {
  const s = selectCandidates([cand('pinned', 99, { pinned: true, clusterId: 'c' }), cand('placed', 50, { clusterId: 'c' }), cand('new', 1)], 3);
  assert.deepEqual(s.selected.map((c) => c.key), ['new', 'placed', 'pinned']);
});

test('U53 batches split with a last partial batch', () => {
  assert.deepEqual(splitBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(splitBatches([], 2), []);
});

test('U48 malformed agent output is refused: not a list, empty name, long name, no keywords list', () => {
  const allowed = new Set(['a']);
  for (const bad of [null, {}, { clusters: 'x' }, { clusters: [{ name: '', keywords: [] }] }, { clusters: [{ name: 'x'.repeat(501), keywords: [] }] }, { clusters: [{ name: 'ok' }] }, { clusters: [null] }]) {
    assert.throws(() => parseClusterOutput(bad, allowed), SeoInputError);
  }
});

test('U46 a keyword the batch did not contain is dropped; names are tidied', () => {
  const groups = parseClusterOutput({ clusters: [{ name: '  Shoes   sale ', keywords: ['A', 'invented', 5] }] }, new Set(['a']));
  assert.deepEqual(groups, [{ name: 'Shoes sale', keys: ['a'] }]);
});

const state = (keywords: Record<string, { pinned?: boolean; clusterId?: string | null }>, clusters: Array<[string, string]> = []) => ({
  sent: new Map(Object.entries(keywords).map(([k, v]) => [k, { pinned: v.pinned ?? false, clusterId: v.clusterId ?? null }])),
  clusters: new Map(clusters.map(([id, name]) => [id, { id, name, nameKey: nameKeyOf(name) }])),
});

test('U43 agent output is applied to new and unpinned keywords, creating the named cluster once', () => {
  const plan = planClustering(state({ a: {}, b: {}, c: { clusterId: 'old' } }, [['old', 'Old']]), [{ name: 'Shoes', keys: ['a', 'b'] }, { name: 'shoes', keys: ['c'] }]);
  assert.deepEqual(plan.createdNames, ['Shoes']);
  assert.equal(plan.moves.length, 3);
  assert.ok(plan.moves.every((m) => m.clusterId === null && m.newName === 'Shoes'));
});

test('U44 a pinned keyword is never moved; a suggestion is made instead', () => {
  const plan = planClustering(state({ a: { pinned: true, clusterId: 'c1' } }, [['c1', 'Mine']]), [{ name: 'Other', keys: ['a'] }]);
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.suggestions, [{ key: 'a', fromClusterId: 'c1', toName: 'Other' }]);
  assert.deepEqual(plan.createdNames, [], 'a cluster is not created only to hold a suggestion');
});

test('U44b a pinned keyword the agent leaves in its own cluster makes no suggestion', () => {
  const plan = planClustering(state({ a: { pinned: true, clusterId: 'c1' } }, [['c1', 'Mine']]), [{ name: 'MINE', keys: ['a'] }]);
  assert.deepEqual([plan.moves, plan.suggestions], [[], []]);
});

test('U45 a keyword returned twice ends in exactly one cluster (the first)', () => {
  const plan = planClustering(state({ a: {} }), [{ name: 'One', keys: ['a'] }, { name: 'Two', keys: ['a'] }]);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0]!.newName, 'One');
  assert.deepEqual(plan.createdNames, ['One']);
});

test('U46 a keyword that was not sent is ignored', () => {
  assert.deepEqual(planClustering(state({ a: {} }), [{ name: 'One', keys: ['zzz'] }]).moves, []);
});

test('U47 an omitted keyword keeps its cluster', () => {
  const plan = planClustering(state({ a: { clusterId: 'c1' }, b: {} }, [['c1', 'Keep']]), [{ name: 'New', keys: ['b'] }]);
  assert.deepEqual(plan.moves.map((m) => m.key), ['b']);
});

test('U49 a name matching an existing cluster (case-insensitive) reuses it', () => {
  const plan = planClustering(state({ a: {} }, [['c1', 'Running Shoes']]), [{ name: 'running SHOES', keys: ['a'] }]);
  assert.deepEqual(plan.moves, [{ key: 'a', clusterId: 'c1', newName: null }]);
  assert.deepEqual(plan.createdNames, []);
});

test('U55 a cluster mixing pinned and unpinned keywords moves only the unpinned ones', () => {
  const plan = planClustering(state({ a: { pinned: true }, b: {} }), [{ name: 'Group', keys: ['a', 'b'] }]);
  assert.deepEqual(plan.moves.map((m) => m.key), ['b']);
  assert.deepEqual(plan.suggestions.map((s) => s.key), ['a']);
});

test('U54 an existing cluster is never renamed by a run: the plan has no rename', () => {
  const plan = planClustering(state({ a: {} }, [['c1', 'My Name']]), [{ name: 'my name', keys: ['a'] }]);
  assert.ok(!('renames' in plan));
  assert.deepEqual(plan.createdNames, []);
});

/* ----- Edit operations ----- */

function world(): EditState {
  let n = 0;
  const cluster = (id: string, name: string): ClusterRec => ({ id, name, nameKey: nameKeyOf(name), pinned: false, createdAt: 't' });
  const kw = (key: string, clusterId: string | null, pinned = false): KeywordRec => ({ key, display: key, sources: [], status: 'tracking', pinned, clusterId, targetPage: '', createdAt: 't' });
  return {
    clusters: new Map([['c1', cluster('c1', 'One')], ['c2', cluster('c2', 'Two')]]),
    keywords: new Map([kw('a', 'c1'), kw('b', 'c1', true), kw('c', 'c1'), kw('d', 'c2')].map((k) => [k.key, k])),
    gscDisplay: (key) => (key === 'from gsc' ? 'From GSC' : null),
    newId: () => `n${++n}`,
    now: () => 'now',
  };
}

test('U57 rename pins the cluster name and refuses a duplicate or empty name', () => {
  const s = world();
  const changes = renameCluster(s, 'c1', '  Uno  ');
  assert.deepEqual([changes.clusters.get('c1')!.name, changes.clusters.get('c1')!.pinned], ['Uno', true]);
  assert.throws(() => renameCluster(s, 'c1', 'two'), SeoConflictError);
  assert.throws(() => renameCluster(s, 'c1', '  '), SeoInputError);
  assert.throws(() => renameCluster(s, 'nope', 'x'), SeoNotFoundError);
  assert.doesNotThrow(() => renameCluster(s, 'c1', 'ONE'), 'the cluster may be renamed to its own name in another case');
});

test('U58 moving a keyword pins it, including one only Search Console has seen', () => {
  const s = world();
  const changes = moveKeywords(s, ['A', 'from gsc'], 'c2');
  assert.deepEqual([changes.keywords.get('a')!.clusterId, changes.keywords.get('a')!.pinned], ['c2', true]);
  assert.deepEqual([changes.keywords.get('from gsc')!.clusterId, changes.keywords.get('from gsc')!.display], ['c2', 'From GSC']);
  assert.throws(() => moveKeywords(s, ['unknown keyword'], 'c2'), SeoNotFoundError);
  assert.throws(() => moveKeywords(s, ['a'], 'nope'), SeoNotFoundError);
});

test('U58b a move to Unclustered (null) pins the keyword in place', () => {
  const changes = moveKeywords(world(), ['a'], null);
  assert.deepEqual([changes.keywords.get('a')!.clusterId, changes.keywords.get('a')!.pinned], [null, true]);
});

test('U59 merge moves keywords, keeps their pins, keeps the target name and deletes the sources', () => {
  const s = world();
  const changes = mergeClusters(s, ['c1'], 'c2');
  assert.equal(changes.clusters.get('c1'), null);
  assert.deepEqual([changes.keywords.get('b')!.clusterId, changes.keywords.get('b')!.pinned, changes.keywords.get('a')!.pinned], ['c2', true, false]);
  assert.equal(changes.clusters.has('c2'), false);
});

test('U60 merge into itself, or with no source, is refused', () => {
  assert.throws(() => mergeClusters(world(), ['c1'], 'c1'), SeoInputError);
  assert.throws(() => mergeClusters(world(), [], 'c1'), SeoInputError);
});

test('U61 split creates a new pinned cluster from the selected keywords', () => {
  const { changes, cluster } = splitCluster(world(), 'c1', ['a'], 'Split off');
  assert.equal(changes.keywords.get('a')!.clusterId, cluster.id);
  assert.equal(changes.keywords.get('a')!.pinned, true);
  assert.equal(changes.clusters.get(cluster.id)!.name, 'Split off');
});

test('U62 split with nothing selected, everything selected, or a keyword from elsewhere is refused', () => {
  assert.throws(() => splitCluster(world(), 'c1', [], 'x'), SeoInputError);
  assert.throws(() => splitCluster(world(), 'c1', ['a', 'b', 'c'], 'x'), SeoInputError);
  assert.throws(() => splitCluster(world(), 'c1', ['d'], 'x'), SeoInputError);
});

test('U63 deleting a cluster sends its keywords to Unclustered, unpinned', () => {
  const changes = deleteCluster(world(), 'c1');
  assert.equal(changes.clusters.get('c1'), null);
  for (const key of ['a', 'b', 'c']) assert.deepEqual([changes.keywords.get(key)!.clusterId, changes.keywords.get(key)!.pinned], [null, false]);
  assert.ok(!changes.keywords.has('d'));
});

test('U64 create refuses a duplicate, empty or over-long name', () => {
  assert.throws(() => createCluster(world(), 'one'), SeoConflictError);
  assert.throws(() => createCluster(world(), ''), SeoInputError);
  assert.throws(() => createCluster(world(), 'x'.repeat(501)), SeoInputError);
  assert.equal(createCluster(world(), 'x'.repeat(500)).cluster.name.length, 500);
});

test('I47 after any sequence of edits every keyword is in exactly one existing cluster (or none)', () => {
  let s = world();
  const apply = (changes: Parameters<typeof applyChanges>[1]) => { const next = applyChanges(s, changes); s = { ...s, ...next }; };
  const steps: Array<() => void> = [
    () => apply(moveKeywords(s, ['a', 'd'], 'c2')),
    () => apply(createCluster(s, 'Three').changes),
    () => apply(mergeClusters(s, ['c2'], 'c1')),
    () => apply(deleteCluster(s, 'c1')),
    () => apply(moveKeywords(s, ['a'], null)),
  ];
  for (const step of steps) {
    step();
    for (const k of s.keywords.values()) assert.ok(k.clusterId === null || s.clusters.has(k.clusterId), `${k.key} points at a missing cluster`);
  }
});

/* ----- CSV ----- */

test('U65 a basic file parses', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('U66 quoted fields may hold commas, quotes and line breaks', () => {
  assert.deepEqual(parseCsv('k,n\n"a, ""b""","line1\nline2"\n'), [['k', 'n'], ['a, "b"', 'line1\nline2']]);
});

test('U67 a byte-order mark and CRLF line ends are accepted', () => {
  assert.deepEqual(parseCsv('﻿keyword,status\r\nred shoes,target\r\n'), [['keyword', 'status'], ['red shoes', 'target']]);
});

test('U68 header variants and unknown columns are accepted, a missing keyword column is refused', () => {
  const ok = parseKeywordImport('Query,Notes,Target Page\nRed Shoes,x,https://example.com/shoes/\n');
  assert.equal(ok.rows[0]!.keyword, 'red shoes');
  assert.equal(ok.rows[0]!.targetPage, 'https://example.com/shoes');
  assert.throws(() => parseKeywordImport('name,notes\na,b\n'), /keyword/);
  assert.throws(() => parseKeywordImport('   '), SeoInputError);
  assert.throws(() => parseKeywordImport(42), SeoInputError);
});

test('U69 duplicates inside the file are counted by normalised key, rows without a usable keyword are rejected with the line', () => {
  const r = parseKeywordImport('keyword\nCafé\ncafe \n \n' + 'x'.repeat(501) + '\n');
  assert.equal(r.rows.length, 1);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.rejected.map((x) => x.line), [4, 5]);
});

test('U70 status spelling variants are accepted and others are refused', () => {
  const r = parseKeywordImport('keyword,status\na,Tracking\nb,TARGET\nc,Ignored\nd,maybe\n');
  assert.deepEqual(r.rows.map((x) => x.status), ['tracking', 'target', 'ignored']);
  assert.match(r.rejected[0]!.reason, /maybe/);
  assert.equal(statusFromText(' Target '), 'target');
  assert.equal(statusFromText('x'), null);
});

test('U71 a file over the row limit is refused', () => {
  const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `k${i}`).join('\n');
  assert.throws(() => parseKeywordImport(`keyword\n${rows}`), /more than/);
});

test('U72 export text starting with = + - @ is made safe against formulas', () => {
  for (const text of ['=SUM(A1)', '+1', '-1', '@cmd']) assert.equal(csvCell(text), `'${text}`);
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

test('U73 export writes null as empty (not 0), numbers as numbers, and a negative number is not a formula', () => {
  assert.equal(csvLine([null, undefined, 0, -0.5, 'x']), ',,0,-0.5,x');
  assert.equal(csvCell(Number.NaN), '');
});

/* ----- Research ----- */

test('U75 a competitor URL becomes a bare lower-case domain and duplicates are removed', () => {
  assert.equal(competitorDomain('https://Rival.com/path?x=1'), 'rival.com');
  assert.deepEqual(competitorDomains(['rival.com', 'HTTPS://rival.com/', 'other.org']), ['rival.com', 'other.org']);
  assert.deepEqual(competitorDomains(undefined), []);
});

test('U76 refused: more than 10 domains, a long host, localhost, IP addresses, non-http schemes, not text', () => {
  assert.throws(() => competitorDomains(Array.from({ length: 11 }, (_, i) => `site${i}.com`)), /at most 10/);
  assert.doesNotThrow(() => competitorDomains(Array.from({ length: 10 }, (_, i) => `site${i}.com`)));
  assert.throws(() => competitorDomain(`${'a'.repeat(250)}.com`), SeoInputError);
  for (const bad of ['localhost', 'http://localhost:3000', '127.0.0.1', 'http://[::1]/', 'ftp://rival.com', 'javascript:alert(1)', '', 5, 'nodot']) assert.throws(() => competitorDomain(bad), SeoInputError, String(bad));
  assert.throws(() => competitorDomains('rival.com'), SeoInputError);
});

test('U74 ideas are de-duplicated against tracked, rejected and pending keywords by normalised key, and within the run', () => {
  const fresh = freshIdeas(
    [{ keyword: 'Café', origin: 'agent', reason: '' }, { keyword: 'new idea', origin: 'agent', reason: '' }, { keyword: 'NEW  idea', origin: 'ads', reason: '' }, { keyword: '', origin: 'agent', reason: '' }],
    new Set(['cafe']),
  );
  assert.deepEqual(fresh.map((i) => i.key), ['new idea']);
  assert.equal(fresh[0]!.origin, 'agent', 'the first idea wins');
});

test('U74b research output is read from objects or plain strings, anything else is refused', () => {
  assert.deepEqual(parseResearchOutput({ keywords: [{ keyword: 'a', reason: 'because' }, 'b'] }), [{ keyword: 'a', reason: 'because' }, { keyword: 'b', reason: '' }]);
  assert.throws(() => parseResearchOutput({}), SeoInputError);
  assert.throws(() => parseResearchOutput({ keywords: [{ keyword: 5 }] }), SeoInputError);
});

test('zeroSums is a fresh object each time', () => {
  assert.notEqual(zeroSums(), zeroSums());
});
