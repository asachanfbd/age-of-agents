import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const kw = await import('../src/lib/seoKeywords.ts');
const pages = await import('../src/lib/seoPages.ts');
const workspace = await import('../src/lib/seoWorkspace.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { useSeoKeywordsStore } = await import('../src/store/seoKeywordsStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { seoKeywordsState } = await import('./seoKeywordsStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const shown = (clicks, impressions, ctr = 0.1, position = 4.25) => ({ clicks, impressions, ctr, position });
const cluster = (extra = {}) => ({ id: 'c1', name: 'Pricing tools', pinned: false, keywords: 3, current: shown(1234, 12_340), previous: shown(1000, 10_000), change: { abs: 234, pct: 0.234, isNew: false }, best: { key: 'a', keyword: 'saas pricing', clicks: 500 }, pages: 4, volume: { low: 1000, high: 10_000, exact: false, missing: 0 }, cannibalised: 0, ...extra });
const keyword = (extra = {}) => ({ key: 'a', keyword: 'Saas Pricing', sources: ['gsc'], status: 'tracking', pinned: false, clusterId: null, clusterName: null, targetPage: null, current: shown(5, 50), previous: null, change: null, pages: 2, cannibalised: false, volume: null, ...extra });

test('C1 a cluster row reads CTR as a percent, position to one decimal, change as +12% clicks, and no data as a dash', () => {
  const v = kw.clusterRowView(cluster({ change: { abs: 12, pct: 0.12, isNew: false } }), true);
  assert.deepEqual([v.name, v.keywords, v.clicks, v.impressions, v.ctr, v.position, v.best, v.pages], ['Pricing tools', '3', '1,234', '12,340', '10.0%', '4.3', 'saas pricing', '4']);
  assert.deepEqual(v.change, { text: '+12% clicks', tone: 'good' });
  assert.deepEqual(kw.changeView({ abs: -3, pct: -0.3, isNew: false }), { text: '-30% clicks', tone: 'bad' });
  assert.deepEqual(kw.changeView({ abs: 3, pct: null, isNew: true }), { text: 'new', tone: 'good' });
  assert.equal(kw.changeView(null), null);
  const none = kw.clusterRowView(cluster({ current: null, previous: null, change: null, best: null, volume: null }), false);
  assert.deepEqual([none.clicks, none.impressions, none.ctr, none.position, none.best, none.change], ['—', '—', '—', '—', '—', null]);
  assert.equal(kw.clusterRowView(cluster({ id: null, name: 'Unclustered' }), true).isUnclustered, true);
});

test('C2 a keyword row shows its numbers, status, target path and the no-data state', () => {
  const v = kw.keywordRowView(keyword({ status: 'target', targetPage: 'https://example.com/pricing', cannibalised: true }), false);
  assert.deepEqual([v.keyword, v.clicks, v.ctr, v.position, v.pages, v.status, v.target, v.cannibalised, v.noData], ['Saas Pricing', '5', '10.0%', '4.3', '2', 'target', '/pricing', true, false]);
  const gap = kw.keywordRowView(keyword({ current: null }), true);
  assert.deepEqual([gap.clicks, gap.noData, gap.target], ['—', true, '—']);
  assert.equal(kw.keywordRowView(keyword({ current: shown(0, 0, null, null) }), true).ctr, '—', 'zero impressions give no CTR');
});

test('C3 the volume cell shows exact or range, the Ads prompt when not connected, and a dash when connected but empty', () => {
  assert.equal(kw.volumeCell({ kind: 'exact', low: 1000, high: 1000, fetchedAt: '2026-03-01T00:00:00Z' }, true).text, '1,000 exact');
  const range = kw.volumeCell({ kind: 'range', low: 500, high: 1000, fetchedAt: '2026-03-01T00:00:00Z' }, true);
  assert.deepEqual([range.text, range.precision], ['500–1,000 range', 'range']);
  assert.match(range.title, /fetched 2026-03-01/);
  assert.equal(kw.volumeCell(null, false).text, 'Connect Google Ads for volume');
  assert.equal(kw.volumeCell(null, true).text, '—');
  assert.equal(kw.volumeSumCell({ low: 1120, high: 1120, exact: true, missing: 0 }, true).text, '1,120');
  const sum = kw.volumeSumCell({ low: 1120, high: 10_120, exact: false, missing: 2 }, true);
  assert.equal(sum.text, '1.1K–10.1K');
  assert.match(sum.title, /2 keywords have no volume/);
  assert.equal(kw.volumeSumCell(null, false).text, 'Connect Google Ads for volume');
});

test('C4 the compact range formatter at 999, 1000, 1500 and 10^6', () => {
  assert.equal(kw.compactNumber(999), '999');
  assert.equal(kw.compactNumber(1000), '1K');
  assert.equal(kw.compactNumber(1500), '1.5K');
  assert.equal(kw.compactNumber(1_000_000), '1M');
  assert.equal(kw.compactRange(1400, 2600), '1.4K–2.6K');
});

test('C5 expanded clusters survive a refetch; only clusters that are gone are dropped', () => {
  const expanded = new Set(['c1', 'c2', 'unclustered']);
  assert.deepEqual([...kw.keepExpanded(expanded, [{ id: 'c1' }, { id: null }])].sort(), ['c1', 'unclustered']);
  assert.equal(kw.expandKey(null), 'unclustered');
});

test('C6 the selection count and the bulk bar', () => {
  assert.deepEqual(kw.bulkBar(new Set()), { visible: false, label: '0 keywords selected' });
  const one = kw.toggleSelected(new Set(), 'a');
  assert.deepEqual(kw.bulkBar(one), { visible: true, label: '1 keyword selected' });
  assert.equal(kw.bulkBar(kw.toggleSelected(one, 'b')).label, '2 keywords selected');
  assert.deepEqual([...kw.toggleSelected(one, 'a')], []);
});

test('C7 hand-placed keywords and renamed clusters carry the pin badge', () => {
  assert.equal(kw.keywordRowView(keyword({ pinned: true }), true).pinBadge, true);
  assert.equal(kw.keywordRowView(keyword(), true).pinBadge, false);
  assert.equal(kw.clusterRowView(cluster({ pinned: true }), true).pinBadge, true);
  const ui = src('ui/SeoKeywords.tsx');
  assert.ok(ui.includes('v.pinBadge &&'));
  assert.ok(ui.includes('Placed by hand'));
});

test('C8 the run status model covers queued, running, succeeded, failed and stopped', () => {
  const run = (status, extra = {}) => ({ id: 'r', kind: 'cluster', status, startedAt: 't', finishedAt: null, progress: { done: 2, total: 5 }, notices: [], error: null, adsError: null, result: {}, ...extra });
  assert.deepEqual([kw.runView(run('queued')).label, kw.runView(run('queued')).active], ['Queued', true]);
  assert.deepEqual([kw.runView(run('running')).label, kw.runView(run('running')).progress, kw.runView(run('running')).tone], ['Running', '2 of 5 keywords', 'running']);
  assert.deepEqual([kw.runView(run('succeeded')).label, kw.runView(run('succeeded')).tone, kw.runView(run('succeeded')).active], ['Done', 'good', false]);
  assert.equal(kw.runView(run('failed', { error: 'overloaded' })).tone, 'bad');
  assert.equal(kw.runView(run('stopped')).label, 'Stopped');
  assert.equal(kw.runView(null), null);
  assert.match(kw.runOutcome(run('failed', { error: 'overloaded' })), /overloaded\. Your clusters are unchanged/);
  assert.match(kw.runOutcome(run('stopped')), /Your clusters are unchanged/);
  assert.match(kw.runOutcome(run('succeeded', { result: { placed: 12, clustersCreated: 2, suggestions: 1 } })), /Placed 12 keywords in 2 new clusters; 1 suggestion/);
  assert.match(kw.runOutcome(run('succeeded', { kind: 'research', result: { proposed: 3 } })), /3 new keyword ideas to review\. Nothing is tracked until you accept/);
});

test('C9 the cap message shows over the cap and is hidden under it', () => {
  const run = (notices) => ({ id: 'r', kind: 'cluster', status: 'succeeded', startedAt: 't', finishedAt: 't', progress: { done: 500, total: 500 }, notices, error: null, adsError: null, result: {} });
  const message = 'Processed 500 of 600 keywords this run (keywords without a cluster first, then highest impressions). Run again to place the rest.';
  assert.equal(kw.capMessage(run([message])), message);
  assert.equal(kw.capMessage(run([])), null);
  assert.equal(kw.capMessage(run(['Connect Google Ads for volume'])), null);
  assert.equal(kw.capMessage(null), null);
});

test('C10 the suggestions banner counts the suggested changes and says nothing was moved', () => {
  assert.equal(kw.suggestionsBanner(0), null);
  assert.match(kw.suggestionsBanner(1), /^1 suggested change for keywords you placed by hand\. Nothing was moved\.$/);
  assert.match(kw.suggestionsBanner(3), /^3 suggested changes/);
});

test('C11 the drill-down model: states, pages, and the intended target pill', () => {
  const detail = (extra = {}) => ({ gsc: { connected: true, coverage: {} }, current: shown(5, 50), pageList: [{ url: 'https://example.com/a', path: '/a', isTarget: true, ...shown(5, 50) }], ...extra });
  assert.equal(kw.keywordDrillState(detail()), 'ready');
  assert.equal(kw.keywordDrillState(detail({ gsc: { connected: false } })), 'gsc-not-connected');
  assert.equal(kw.keywordDrillState(detail({ current: null })), 'no-data');
  assert.equal(kw.keywordDrillState(detail({ pageList: [] })), 'no-pages');
  assert.ok(src('ui/SeoKeywords.tsx').includes('Intended target'));
});

test('C12 trend bars: gap days are grey and full height, the previous period is lighter', () => {
  const point = (day, clicks, period = 'current') => ({ day, period, clicks, impressions: null, ctr: null, position: null });
  const bars = kw.trendBars([point('d1', 10, 'previous'), point('d2', null), point('d3', 5)]);
  assert.deepEqual(bars.map((b) => b.tone), ['previous', 'gap', 'current']);
  assert.deepEqual(bars.map((b) => b.height), [100, 100, 50]);
  assert.equal(kw.trendBars([point('d', 0)])[0].height, 2, 'a real zero is a short bar, not a gap');
});

test('C13 the cannibalisation text states the rule with the server\'s numbers', () => {
  assert.match(kw.cannibalisationText({ flagged: true, rule: '', minImpressions: 5, minPages: 2, competingPages: [] }), /^2 or more pages each received at least 5 impressions for this keyword/);
  assert.match(kw.cannibalisationText({ flagged: true, rule: '', minImpressions: 20, minPages: 3, competingPages: [] }), /^3 or more pages each received at least 20 impressions/);
});

test('C14 a research proposal shows its source, volume and the reason; the Ads error alert text is kept', () => {
  const p = { id: 'p', key: 'k', keyword: 'delta force', origin: 'ads', reason: 'Suggested by Google Ads', status: 'pending', volume: { kind: 'range', low: 1000, high: 10_000, fetchedAt: '2026-03-01T00:00:00Z' }, createdAt: 't' };
  const v = kw.proposalView(p, true);
  assert.deepEqual([v.source, v.volume.text, v.pending], ['Google Ads', '1,000–10,000 range', true]);
  assert.equal(kw.proposalView({ ...p, origin: 'agent', volume: null }, false).volume.text, 'Connect Google Ads for volume');
  assert.equal(kw.proposalView({ ...p, origin: 'agent' }, true).source, 'Agent');
  const ui = src('ui/SeoKeywordResearch.tsx');
  assert.ok(ui.includes('Google Ads: {adsError}'));
  assert.ok(ui.includes('Keywords and volumes already saved are unchanged'));
});

test('C15 "Accept all remaining" applies only to pending rows', () => {
  const row = (id, status) => ({ id, key: id, keyword: id, origin: 'agent', reason: '', status, volume: null, createdAt: 't' });
  assert.deepEqual(kw.pendingIds([row('a', 'pending'), row('b', 'accepted'), row('c', 'rejected'), row('d', 'pending')]), ['a', 'd']);
  assert.deepEqual(kw.parseCompetitors('rival.com, other.org\nthird.net  '), ['rival.com', 'other.org', 'third.net']);
});

async function keywordBuilding() {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], newBuildingField: null, ...CLEAN_ERROR_STATE });
  assert.equal(await useWorldStore.getState().addProject('', undefined, 'seo', 'https://example.com/'), true);
  const b = useWorldStore.getState().projects.at(-1);
  const st = stub.seo.byProject.get(b.id);
  st.property = 'https://example.com/';
  const state = seoKeywordsState(st);
  state.clusters = [{ id: 'c1', name: 'One', pinned: false }, { id: 'c2', name: 'Two', pinned: false }];
  state.keywords = [{ key: 'a', keyword: 'A', clicks: 5, impressions: 50, clusterId: 'c1' }, { key: 'b', keyword: 'B', clicks: 3, impressions: 30, clusterId: 'c1' }, { key: 'c', keyword: 'C', clicks: 1, impressions: 10 }];
  useSeoKeywordsStore.setState({ clustersByProject: {}, keywordsByProject: {}, detailByProject: {}, runsByProject: {}, suggestionsByProject: {}, proposalsByProject: {} });
  return { stub, b, state };
}

test('C16 the store sends the range, compare, sort, search, filter and offset the controls ask for', async () => {
  const { b, state } = await keywordBuilding();
  const controls = { ...kw.DEFAULT_KEYWORD_CONTROLS, days: 7, compare: false, sort: 'impressions', dir: 'asc', filter: 'pinned', search: 'alp' };
  assert.equal((await useSeoKeywordsStore.getState().loadClusters(b.id, controls, '2026-03-14', 50)).ok, true);
  const q = new URLSearchParams(state.requests.at(-1).query);
  assert.deepEqual([q.get('from'), q.get('to'), q.get('compare'), q.get('sort'), q.get('dir'), q.get('filter'), q.get('search'), q.get('offset'), q.get('limit')], ['2026-03-08', '2026-03-14', 'none', 'impressions', 'asc', 'pinned', 'alp', '50', '50']);
  await useSeoKeywordsStore.getState().loadClusterKeywords(b.id, kw.DEFAULT_KEYWORD_CONTROLS, null, 'c1', 0);
  const k = new URLSearchParams(state.requests.at(-1).query);
  assert.deepEqual([k.get('cluster'), k.get('compare'), k.get('sort'), k.get('from')], ['c1', 'previous', 'clicks', null]);
  const byName = kw.clustersParams({ ...kw.DEFAULT_KEYWORD_CONTROLS, filter: 'no-cluster' }, null, 0);
  assert.equal(byName.get('filter'), 'unclustered', 'a keyword-level filter maps to the cluster-level one');
  assert.equal(kw.keywordsParams({ ...kw.DEFAULT_KEYWORD_CONTROLS, sort: 'name' }, null, 'c1', 0).get('sort'), 'clicks');
  assert.deepEqual(kw.nextClusterSort({ sort: 'clicks', dir: 'desc' }, 'clicks'), { sort: 'clicks', dir: 'asc' });
  assert.deepEqual(kw.nextClusterSort({ sort: 'clicks', dir: 'desc' }, 'name'), { sort: 'name', dir: 'asc' });
});

test('C17 an older response never overwrites a newer one', async () => {
  const { b, state } = await keywordBuilding();
  let release;
  const held = new Promise((r) => { release = r; });
  state.gate = async (params) => { if (params.get('search') === 'old') await held; };
  const older = useSeoKeywordsStore.getState().loadClusters(b.id, { ...kw.DEFAULT_KEYWORD_CONTROLS, search: 'old' }, null, 0);
  const newer = await useSeoKeywordsStore.getState().loadClusters(b.id, { ...kw.DEFAULT_KEYWORD_CONTROLS, search: '' }, null, 0);
  assert.equal(newer.ok, true);
  release();
  await older;
  assert.equal(useSeoKeywordsStore.getState().clustersByProject[b.id].total, 3, 'the newer answer (all clusters) is still shown');
});

test('C18 a move shows at once and is put back when the daemon answers 400, 404 or 409', async () => {
  const { b, state } = await keywordBuilding();
  await useSeoKeywordsStore.getState().loadClusterKeywords(b.id, kw.DEFAULT_KEYWORD_CONTROLS, null, 'c1', 0);
  const before = useSeoKeywordsStore.getState().keywordsByProject[b.id];
  assert.equal(before.c1.rows.length, 2);
  for (const status of [400, 404, 409]) {
    state.refuseMove = { status, error: `refused ${status}` };
    const result = await useSeoKeywordsStore.getState().moveKeywords(b.id, ['a'], 'c2');
    assert.deepEqual([result.ok, result.status, result.error], [false, status, `refused ${status}`]);
    assert.deepEqual(useSeoKeywordsStore.getState().keywordsByProject[b.id], before, `reverted after ${status}`);
  }
  state.refuseMove = null;
  assert.equal((await useSeoKeywordsStore.getState().moveKeywords(b.id, ['a'], 'c2')).ok, true);
  assert.deepEqual(useSeoKeywordsStore.getState().keywordsByProject[b.id].c1.rows.map((r) => r.key), ['b'], 'the moved keyword leaves its cluster');
  assert.equal(state.keywords.find((k) => k.key === 'a').clusterId, 'c2');
  assert.equal(state.keywords.find((k) => k.key === 'a').pinned, true);
});

test('C19 the stub\'s keyword routes mirror the daemon: 400 for bad input, 404 for unknown ids, 409 for duplicates and busy runs', async () => {
  const { b } = await keywordBuilding();
  const s = useSeoKeywordsStore.getState();
  assert.equal((await s.clusterAction(b.id, { type: 'create', name: '  ' })).status, 400);
  assert.equal((await s.clusterAction(b.id, { type: 'create', name: 'one' })).status, 409);
  assert.equal((await s.clusterAction(b.id, { type: 'rename', clusterId: 'nope', name: 'x' })).status, 404);
  assert.equal((await s.clusterAction(b.id, { type: 'merge', sourceIds: ['c1'], targetId: 'c1' })).status, 400);
  assert.equal((await s.updateKeyword(b.id, { key: 'zzz', status: 'target' })).status, 404);
  assert.equal((await s.updateKeyword(b.id, { key: 'a', status: 'odd' })).status, 400);
  assert.equal((await s.stopRun(b.id, 'cluster')).status, 409);
  assert.equal((await s.startRun(b.id, 'cluster')).ok, true);
  assert.equal((await s.startRun(b.id, 'cluster')).status, 409);
  assert.equal((await s.decideProposals(b.id, 'accept', ['nope'])).status, 404);
  assert.equal((await s.setMarket(b.id, 'en', '2840')).status, 400);
  assert.equal((await s.loadClusterKeywords(b.id, kw.DEFAULT_KEYWORD_CONTROLS, null, 'nope', 0)).status, 404);
});

test('C20 the window maths for 50,000 rows draws only the visible rows plus overscan', () => {
  const at = (scrollTop) => kw.windowRange({ count: 50_000, rowHeight: 40, scrollTop, viewport: 360, overscan: 5 });
  assert.deepEqual(at(0), { start: 0, end: 15, padTop: 0, padBottom: 49_985 * 40 });
  const middle = at(40 * 25_000);
  assert.deepEqual([middle.start, middle.end], [24_995, 25_015]);
  assert.equal(middle.padTop + (middle.end - middle.start) * 40 + middle.padBottom, 50_000 * 40, 'spacers plus rows add up to the full height');
  const last = at(40 * 49_999 + 5000);
  assert.equal(last.end, 50_000);
  assert.equal(last.padBottom, 0);
  assert.deepEqual(kw.windowRange({ count: 0, rowHeight: 40, scrollTop: 0, viewport: 360, overscan: 5 }), { start: 0, end: 0, padTop: 0, padBottom: 0 });
});

test('C21 the window stays put when rows load at the end, and expanding a cluster adds rows without moving the ones in view', () => {
  const input = (count) => ({ count, rowHeight: 40, scrollTop: 800, viewport: 360, overscan: 5 });
  const few = kw.windowRange(input(60));
  const more = kw.windowRange(input(110));
  assert.deepEqual([few.start, few.end, few.padTop], [more.start, more.end, more.padTop], 'rows appended below do not shift the visible window');
  assert.equal(more.padBottom - few.padBottom, 50 * 40);
  assert.equal(kw.windowRange({ ...input(10), scrollTop: 99_999 }).end, 10, 'a stale scroll position past the end is clamped');
});

test('C22 the next page is requested near the end, once, and a merged page cannot duplicate rows', () => {
  const base = { loaded: 50, total: 120, windowEnd: 38, pending: false, threshold: 10 };
  assert.equal(kw.shouldLoadMore(base), false);
  assert.equal(kw.shouldLoadMore({ ...base, windowEnd: 40 }), true);
  assert.equal(kw.shouldLoadMore({ ...base, windowEnd: 40, pending: true }), false, 'no duplicate request while one is in flight');
  assert.equal(kw.shouldLoadMore({ ...base, loaded: 120, windowEnd: 120 }), false, 'everything is loaded');
  const first = Array.from({ length: 50 }, (_, i) => i);
  assert.deepEqual(kw.mergePage(first, [50, 51], 50), [...first, 50, 51]);
  assert.equal(kw.mergePage([...first, 50, 51], [50, 51], 50).length, 52, 'asking for the same page again replaces it');
});

test('C23 an unreadable import file shows an error, and the export link downloads the file under the range\'s name', () => {
  const ui = src('ui/SeoKeywords.tsx');
  assert.ok(ui.includes("setError('That file could not be read.')"));
  assert.ok(ui.includes('file.text()'));
  assert.ok(ui.includes('download={exportFileName(data.range)}'));
  assert.equal(kw.exportFileName({ from: '2026-02-15', to: '2026-03-14' }), 'keywords-2026-02-15-to-2026-03-14.csv');
  assert.equal(kw.importSummary({ added: 2, existing: 1, duplicates: 0, rejected: [] }), '2 added, 1 already tracked');
  assert.equal(kw.importSummary({ added: 0, existing: 0, duplicates: 2, rejected: [{ line: 3, reason: 'x' }] }), '0 added, 0 already tracked, 2 repeated in the file, 1 rejected');
});

test('C24 the tab is registered, cluster rows expose aria-expanded, and the buttons carry labels', () => {
  const shell = src('ui/SeoWorkspace.tsx');
  assert.ok(shell.includes("tab === 'keywords' ? <SeoKeywords project={project} />"));
  const ui = src('ui/SeoKeywords.tsx');
  assert.ok(ui.includes('aria-expanded={open}'));
  assert.ok(ui.includes("aria-label={`${open ? 'Collapse' : 'Expand'} ${row.name}`}"));
  for (const label of ['Cluster keywords', 'Research keywords', 'Import CSV', 'Export CSV', 'Move to cluster', 'Search keywords and clusters']) assert.ok(ui.includes(label), label);
});

test('C25 a read-only Building disables every control that changes keywords', () => {
  const ui = src('ui/SeoKeywords.tsx');
  assert.ok(ui.includes('project.readOnly === true'));
  for (const control of ["disabled={readOnly || view?.active}", 'disabled={readOnly || !adding.trim()}', 'disabled={readOnly || !newName.trim()}', 'disabled={readOnly || !moveTo}', 'disabled={readOnly} onClick={() => fileInput.current?.click()}']) assert.ok(ui.includes(control), control);
  assert.ok(ui.includes('This Building is read-only'));
  const research = src('ui/SeoKeywordResearch.tsx');
  for (const control of ['disabled={readOnly || view?.active}', "disabled={readOnly} onClick={() => void decide('accept', [p.id])}", "disabled={readOnly} onClick={() => void decide('reject', [p.id])}"]) assert.ok(research.includes(control), control);
});

test('C26 the default range and compare match the Pages tab', () => {
  assert.equal(kw.DEFAULT_KEYWORD_CONTROLS.days, pages.DEFAULT_CONTROLS.days);
  assert.equal(kw.DEFAULT_KEYWORD_CONTROLS.compare, pages.DEFAULT_CONTROLS.compare);
  assert.equal(kw.DEFAULT_KEYWORD_CONTROLS.sort, pages.DEFAULT_CONTROLS.sort);
  const params = kw.clustersParams(kw.DEFAULT_KEYWORD_CONTROLS, null, 0);
  assert.deepEqual([params.get('from'), params.get('compare')], [null, 'previous']);
});

test('C27 the empty states: no Search Console, no keywords, no search match', () => {
  const data = (connected, keywords) => ({ gsc: { connected }, totals: { keywords } });
  assert.match(kw.emptyMessage(data(false, 0), false), /Connect Search Console/);
  assert.match(kw.emptyMessage(data(true, 0), false), /No keywords yet/);
  assert.equal(kw.emptyMessage(data(true, 5), false), null);
  assert.equal(kw.emptyMessage(data(true, 5), true), 'No clusters or keywords match your search.');
});

test('C28 the Settings connection card shows the Ads quota or access error', () => {
  const card = workspace.connectionCard({ service: 'ads', state: 'needs-attention', reason: 'Google Ads keyword ideas: quota exceeded' });
  assert.equal(card.statusLabel, 'Needs attention');
  assert.equal(card.detail, 'Google Ads keyword ideas: quota exceeded');
  assert.equal(card.tone, 'warning');
});

test('C28b Settings → Connections sets the Keyword Planner language and location, and research only points there', async () => {
  const { b } = await keywordBuilding();
  const ui = src('ui/SeoConnections.tsx');
  assert.ok(ui.includes('aria-label="Language id"') && ui.includes('aria-label="Location id"'));
  assert.ok(ui.includes('Save language and location'));
  assert.ok(ui.includes('setMarket(id,'));
  assert.ok(!src('ui/SeoKeywordResearch.tsx').includes('Save market'));
  assert.ok(src('ui/SeoKeywordResearch.tsx').includes('Settings → Connections → Google Ads'));
  const { useSeoStore } = await import('../src/store/seoStore.ts');
  assert.equal((await useSeoKeywordsStore.getState().setMarket(b.id, 'en', '2840')).status, 400);
  assert.equal((await useSeoKeywordsStore.getState().setMarket(b.id, '1000', '2840')).ok, true);
  await useSeoStore.getState().loadConnections(b.id);
  assert.deepEqual(useSeoStore.getState().connectionsByProject[b.id].keywordMarket, { languageId: '1000', locationId: '2840' });
});

test('keywords load, expand and refetch through the store with the stub', async () => {
  const { b } = await keywordBuilding();
  const s = useSeoKeywordsStore.getState();
  await s.loadClusters(b.id, kw.DEFAULT_KEYWORD_CONTROLS, null, 0);
  const rows = useSeoKeywordsStore.getState().clustersByProject[b.id].rows;
  assert.deepEqual(rows.map((r) => [r.name, r.keywords]), [['One', 2], ['Two', 0], ['Unclustered', 1]]);
  assert.equal((await s.loadDetail(b.id, 'a', kw.DEFAULT_KEYWORD_CONTROLS, null)).ok, true);
  assert.equal(useSeoKeywordsStore.getState().detailByProject[b.id].pageList[0].isTarget, true);
  await s.loadDetail(b.id, null, kw.DEFAULT_KEYWORD_CONTROLS, null);
  assert.equal(useSeoKeywordsStore.getState().detailByProject[b.id], null);
  assert.equal((await s.addKeywords(b.id, ['fresh'])).result.added, 1);
  assert.equal((await s.importCsv(b.id, 'keyword\nx\ny\n')).result.added, 2);
});
