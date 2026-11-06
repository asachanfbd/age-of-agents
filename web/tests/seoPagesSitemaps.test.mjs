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

const pages = await import('../src/lib/seoPages.ts');
const maps = await import('../src/lib/seoSitemaps.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { useSeoStore } = await import('../src/store/seoStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const column = (key) => pages.METRIC_COLUMNS.find((c) => c.key === key);
const both = { gsc: true, ga4: true };

test('C1 cells read as a value, no data, or Not connected, and a real zero is 0', () => {
  assert.deepEqual(pages.metricCell(column('clicks'), 1234, both), { kind: 'value', text: '1,234' });
  assert.deepEqual(pages.metricCell(column('clicks'), 0, both), { kind: 'value', text: '0' });
  assert.deepEqual(pages.metricCell(column('clicks'), null, both), { kind: 'no-data', text: '—' });
  assert.deepEqual(pages.metricCell(column('ctr'), 0.1234, both), { kind: 'value', text: '12.3%' });
  assert.deepEqual(pages.metricCell(column('position'), 4.25, both), { kind: 'value', text: '4.3' });
  assert.deepEqual(pages.metricCell(column('sessions'), 5, { gsc: true, ga4: false }), { kind: 'not-connected', text: 'Not connected' });
  assert.deepEqual(pages.metricCell(column('clicks'), 5, { gsc: false, ga4: true }), { kind: 'not-connected', text: 'Not connected' });
});

test('C1 change colours: up is good, down is bad, and a lower position is good', () => {
  assert.deepEqual(pages.deltaView('clicks', { abs: 5, pct: 0.5, isNew: false }), { text: '+5 (+50%)', tone: 'good' });
  assert.equal(pages.deltaView('clicks', { abs: -5, pct: -0.5, isNew: false }).tone, 'bad');
  assert.equal(pages.deltaView('position', { abs: -2, pct: -0.4, isNew: false }).tone, 'good');
  assert.equal(pages.deltaView('position', { abs: 2, pct: 0.4, isNew: false }).tone, 'bad');
  assert.deepEqual(pages.deltaView('clicks', { abs: 3, pct: null, isNew: true }), { text: 'new', tone: 'good' });
  assert.equal(pages.deltaView('clicks', null), null);
  assert.equal(pages.deltaView('ctr', { abs: 0.02, pct: 0.2, isNew: false }).text, '+2.0 pts');
});

test('C2 banners say what to connect and when data is partial', () => {
  const cov = (state) => ({ current: { covered: 3, total: 28, state }, previous: null });
  assert.deepEqual(pages.banners({ gsc: { connected: false, coverage: cov('none') }, ga4: { connected: false, coverage: cov('none') } }).length, 2);
  assert.match(pages.banners({ gsc: { connected: false, coverage: cov('none') }, ga4: { connected: true, coverage: cov('full') } })[0], /Connect Search Console to see/);
  assert.match(pages.banners({ gsc: { connected: true, coverage: cov('partial') }, ga4: { connected: true, coverage: cov('full') } })[0], /3 of 28 days/);
  assert.match(pages.banners({ gsc: { connected: true, coverage: cov('none') }, ga4: { connected: true, coverage: cov('full') } })[0], /no data for this range/);
});

test('C3 sort toggle: the same column flips, a new column starts high to low (names and position start ascending)', () => {
  assert.deepEqual(pages.nextSort({ sort: 'clicks', dir: 'desc' }, 'clicks'), { sort: 'clicks', dir: 'asc' });
  assert.deepEqual(pages.nextSort({ sort: 'clicks', dir: 'asc' }, 'clicks'), { sort: 'clicks', dir: 'desc' });
  assert.deepEqual(pages.nextSort({ sort: 'clicks', dir: 'desc' }, 'impressions'), { sort: 'impressions', dir: 'desc' });
  assert.deepEqual(pages.nextSort({ sort: 'clicks', dir: 'desc' }, 'path'), { sort: 'path', dir: 'asc' });
  assert.deepEqual(pages.nextSort({ sort: 'clicks', dir: 'desc' }, 'position'), { sort: 'position', dir: 'asc' });
});

test('C5 drill-down states and wording', () => {
  const gsc = (connected) => ({ connected, coverage: { current: { covered: 1, total: 1, state: 'full' }, previous: null } });
  assert.equal(pages.drillState({ gsc: gsc(false), current: { impressions: null } }), 'gsc-not-connected');
  assert.equal(pages.drillState({ gsc: gsc(true), current: { impressions: null } }), 'no-data');
  assert.equal(pages.drillState({ gsc: gsc(true), current: { impressions: 0 } }), 'no-impressions');
  assert.equal(pages.drillState({ gsc: gsc(true), current: { impressions: 4 } }), 'ready');
  assert.deepEqual(pages.crawlLabel({ available: false, title: null, description: null }), { title: 'Not crawled yet', description: 'Not crawled yet' });
  assert.match(pages.indexingLabel({ state: 'indexed', reason: null, raw: null, inspectedAt: 'x', waitingForQuota: false, error: null }), /Indexed \(may be out of date\)/);
  assert.match(pages.indexingLabel({ state: 'not-indexed', reason: 'Crawled', raw: null, inspectedAt: 'x', waitingForQuota: false, error: null }), /Not indexed: Crawled/);
  assert.equal(pages.indexingLabel({ state: 'never', reason: null, raw: null, inspectedAt: null, waitingForQuota: false, error: null }), 'Not inspected yet');
  const series = pages.trendSeries({ trend: [{ day: 'd1', period: 'current', clicks: null }, { day: 'd2', period: 'current', clicks: 0 }] }, 'clicks');
  assert.deepEqual(series.map((p) => p.value), [null, 0]);
});

test('C6 range and compare map to request parameters; compare off sends compare=none', () => {
  assert.equal(pages.pagesParams(pages.DEFAULT_CONTROLS, null).get('from'), null);
  assert.equal(pages.pagesParams(pages.DEFAULT_CONTROLS, null).get('compare'), 'previous');
  const off = pages.pagesParams({ ...pages.DEFAULT_CONTROLS, compare: false }, null);
  assert.equal(off.get('compare'), 'none');
  const seven = pages.pagesParams({ ...pages.DEFAULT_CONTROLS, days: 7 }, '2026-03-14');
  assert.deepEqual([seven.get('from'), seven.get('to')], ['2026-03-08', '2026-03-14']);
  const custom = pages.pagesParams({ ...pages.DEFAULT_CONTROLS, days: 'custom', from: '2026-01-01', to: '2026-01-31', search: 'x', prefix: '/blog', filter: 'changed' }, null);
  assert.deepEqual([custom.get('from'), custom.get('search'), custom.get('prefix'), custom.get('filter')], ['2026-01-01', 'x', '/blog', 'changed']);
});

async function seoBuilding() {
  useWorldStore.setState({ projects: [], newBuildingField: null, ...CLEAN_ERROR_STATE });
  assert.equal(await useWorldStore.getState().addProject('', undefined, 'seo', 'https://example.com/'), true);
  return useWorldStore.getState().projects.at(-1);
}
const controls = (extra = {}) => ({ ...pages.DEFAULT_CONTROLS, ...extra });

test('C7 an older Pages response never overwrites a newer one', async () => {
  const stub = installServerStub();
  const b = await seoBuilding();
  let release;
  const held = new Promise((r) => { release = r; });
  stub.seo.pagesGate = async (params) => { if (params.get('sort') === 'impressions') await held; };
  const older = useSeoStore.getState().loadPages(b.id, controls({ sort: 'impressions' }), null);
  const newer = await useSeoStore.getState().loadPages(b.id, controls({ sort: 'clicks' }), null);
  assert.equal(newer.ok, true);
  release();
  await older;
  assert.equal(useSeoStore.getState().pagesByProject[b.id].rows[0].path, '/clicks');
});

test('C8 the store surfaces a 404 for an unknown Building and a 409 message', async () => {
  const stub = installServerStub();
  const b = await seoBuilding();
  const missing = await useSeoStore.getState().loadPages('nope', controls(), null);
  assert.deepEqual([missing.ok, missing.status], [false, 404]);
  stub.seo.submitRefused = true;
  const refused = await useSeoStore.getState().submitIndexNow(b.id, { mode: 'selected', urls: ['https://example.com/a'] });
  assert.deepEqual([refused.ok, refused.status], [false, 429]);
  assert.match(refused.error, /one per minute/);
});

test('C18 re-read is disabled while running, and a conflict shows its message', async () => {
  const stub = installServerStub();
  const b = await seoBuilding();
  const [a, c] = await Promise.all([useSeoStore.getState().readSitemaps(b.id), useSeoStore.getState().readSitemaps(b.id)]);
  assert.deepEqual([a.ok, c.ok], [true, true]);
  assert.equal(stub.seo.requests.filter((r) => r.rest === 'sitemaps/read').length, 1);
  stub.seo.sitemapsBusy = true;
  const busy = await useSeoStore.getState().readSitemaps(b.id);
  assert.deepEqual([busy.ok, busy.status], [false, 409]);
  assert.match(busy.error, /Another sitemap action/);
});

test('C19 the log refreshes after a submit and a failed submit leaves the log alone', async () => {
  const stub = installServerStub();
  const b = await seoBuilding();
  const ok = await useSeoStore.getState().submitIndexNow(b.id, { mode: 'selected', urls: ['https://example.com/a'] });
  assert.equal(ok.ok, true);
  assert.equal(useSeoStore.getState().logByProject[b.id].length, 1);
  stub.seo.submitRefused = true;
  await useSeoStore.getState().submitIndexNow(b.id, { mode: 'selected', urls: ['https://example.com/b'] });
  assert.equal(useSeoStore.getState().logByProject[b.id].length, 1);
});

const sitemap = (extra = {}) => ({ url: 'https://e.com/s.xml', kind: 'urlset', parent: null, sources: ['gsc'], status: 'ok', error: null, warnings: [], warningCount: 0, urlCount: 5, showingFirst: null, otherHostCount: 0, children: [], fetchedAt: null, gsc: { warnings: 0, errors: 0, submitted: 5, indexed: null, lastSubmitted: null, lastDownloaded: null, isPending: false, type: null }, ...extra });

test('C9 sitemap tags: OK, warnings, errors, failures, not in GSC, first N and other hosts', () => {
  assert.deepEqual(maps.sitemapTags(sitemap()).map((t) => t.label), ['OK']);
  assert.deepEqual(maps.sitemapTags(sitemap({ warningCount: 2 }))[0], { label: '2 warnings', tone: 'warning' });
  assert.equal(maps.sitemapTags(sitemap({ status: 'fetch-failed' }))[0].label, 'Fetch failed');
  assert.equal(maps.sitemapTags(sitemap({ status: 'malformed' }))[0].label, 'Malformed XML');
  assert.ok(maps.sitemapTags(sitemap({ gsc: null })).some((t) => t.label === 'Not in GSC'));
  assert.ok(maps.sitemapTags(sitemap({ showingFirst: 50000 })).some((t) => t.label === 'Showing first 50,000'));
  assert.ok(maps.sitemapTags(sitemap({ otherHostCount: 3 })).some((t) => /3 on other hosts \(not counted\)/.test(t.label)));
  assert.ok(maps.sitemapTags(sitemap({ gsc: { errors: 1, warnings: 2 } })).some((t) => t.label === '1 GSC error'));
  assert.equal(maps.submittedIndexedLabel(sitemap()), '5 submitted · no data indexed');
  assert.equal(maps.submittedIndexedLabel(sitemap({ gsc: null })), 'Connect GSC to see this');
  assert.equal(maps.typeLabel(sitemap({ kind: 'index' })), 'Index');
});

test('C10 the quota meter shows used, total, percent, the reserve and the reset time', () => {
  const q = { day: 'd', used: 1850, limit: 2000, manualReserve: 200, backgroundLimit: 1800, remaining: 150, exhausted: false, resetsAt: '2026-03-16T07:00:00.000Z' };
  const m = maps.quotaMeter(q);
  assert.deepEqual([m.used, m.limit, m.percent], [1850, 2000, 93]);
  assert.match(m.reserveText, /stops at 1,800; the last 200 are kept for your own requests/);
  assert.equal(m.statusText, '150 left today');
  assert.match(maps.quotaMeter({ ...q, used: 2000, remaining: 0, exhausted: true }).statusText, /waiting for quota/);
});

test('C11 URL status tags and the last-inspected label', () => {
  const idx = (extra) => ({ state: 'indexed', reason: null, raw: null, inspectedAt: null, waitingForQuota: false, error: null, ...extra });
  assert.equal(maps.urlStatusTag(idx({})).label, 'Indexed');
  assert.equal(maps.urlStatusTag(idx({ state: 'not-indexed', reason: 'Crawled - currently not indexed' })).label, 'Not indexed: Crawled - currently not indexed');
  assert.equal(maps.urlStatusTag(idx({ state: 'unknown', raw: 'weird' })).label, 'Unknown (Google said: weird)');
  assert.equal(maps.urlStatusTag(idx({ state: 'never' })).label, 'Not inspected yet');
  assert.equal(maps.urlStatusTag(idx({ waitingForQuota: true })).label, 'Waiting for quota (resumes tomorrow)');
  const now = new Date('2026-03-15T12:00:00Z');
  assert.equal(maps.lastInspectedLabel(null, now), 'Never inspected');
  assert.equal(maps.lastInspectedLabel('2026-03-15T09:00:00Z', now), '3 hours ago');
  assert.equal(maps.lastInspectedLabel('2026-03-10T12:00:00Z', now), '5 days ago');
  assert.equal(maps.lastInspectedLabel('2026-02-01T12:00:00Z', now), '2026-02-01');
  assert.equal(maps.lastInspectedLabel('2026-03-15T11:30:00Z', now), 'Less than an hour ago');
});

test('C12 the Bing column shows information only when connected', () => {
  assert.equal(maps.bingCell({ state: 'not-connected' }), 'Not connected');
  assert.equal(maps.bingCell({ state: 'unchecked' }), 'Not checked');
  assert.equal(maps.bingCell({ state: 'unavailable', checkedAt: 'x' }), 'Unavailable');
  assert.match(maps.bingCell({ state: 'known', checkedAt: 'x', discoveredAt: null, lastCrawledAt: '2026-03-01T00:00:00Z', httpCode: 200 }), /crawled 2026-03-01 \(HTTP 200\)/);
});

test('C13 and C17 selection: labels, disabled states and toggling', () => {
  const quota = { exhausted: false };
  assert.deepEqual([maps.selectionActions(0, quota).inspectDisabled, maps.selectionActions(0, quota).submitDisabled], [true, true]);
  assert.equal(maps.selectionActions(3, quota).submitLabel, 'Submit 3 to IndexNow');
  assert.equal(maps.selectionActions(3, quota).inspectDisabled, false);
  assert.equal(maps.selectionActions(3, { exhausted: true }).inspectDisabled, true);
  const one = maps.toggle(new Set(), 'a');
  assert.deepEqual([...one], ['a']);
  assert.deepEqual([...maps.toggle(one, 'a')], []);
});

test('C14 the confirm text names the count, the whole sitemap, and the batch split', () => {
  assert.match(maps.confirmText({ mode: 'selected', count: 1 }), /1 selected URL to IndexNow/);
  assert.match(maps.confirmText({ mode: 'selected', count: 3 }), /3 selected URLs/);
  assert.match(maps.confirmText({ mode: 'sitemap', count: 25000 }), /all 25,000 URLs of this sitemap.*3 requests of up to 10,000/);
  assert.match(maps.confirmText({ mode: 'new-or-changed', count: 4 }), /4 new or changed URLs/);
  assert.match(maps.confirmText({ mode: 'selected', count: 2 }), /does not confirm indexing/);
});

test('C15 the IndexNow note is plain about no indexed status, and the key file tags and guidance cover each state', () => {
  assert.match(maps.INDEXNOW_NOTE, /never reports whether a page was indexed, so there is no indexed status/);
  assert.equal(maps.keyFileTag('reachable').tone, 'good');
  assert.equal(maps.keyFileTag('not-found').label, 'Key file not reachable (404)');
  assert.match(maps.keyFileTag('mismatch').label, /does not match/);
  assert.equal(maps.keyFileTag('checking').label, 'Checking…');
  assert.match(maps.keyFileGuidance(null), /Settings → Connections/);
  assert.match(maps.keyFileGuidance({ status: 'not-found', keyFileName: 'abcd…ef.txt' }), /abcd…ef\.txt/);
  assert.match(maps.keyFileGuidance({ status: 'reachable', keyFileName: 'x' }), /can verify ownership/);
});

test('C16 log rows say accepted is not an indexing confirmation and show rejection reasons', () => {
  const entry = (result, message) => ({ at: 'x', batchId: 'b', url: 'u', endpoint: 'e', httpStatus: 200, result, message });
  assert.equal(maps.logEntryLabel(entry('accepted', 'ok')), 'Accepted (not an indexing confirmation)');
  assert.equal(maps.logEntryLabel(entry('rejected', 'Rejected: the key is not valid (HTTP 403).')), 'Rejected: the key is not valid (HTTP 403).');
  assert.match(maps.logEntryLabel(entry('error', 'IndexNow had a problem (HTTP 503).')), /^Error: /);
});

test('C20 to C23 source checks: tab wiring, no Submit sitemap to GSC control, no key values, theme tokens only', () => {
  const workspace = src('ui/SeoWorkspace.tsx');
  assert.match(workspace, /<SeoPages project=\{project\} onOpenInternalLinks=\{openInternalLinks\} \/>/);
  assert.match(workspace, /<SeoSitemaps project=\{project\} \/>/);
  for (const file of ['ui/SeoSitemaps.tsx', 'ui/SeoPages.tsx', 'lib/seoSitemaps.ts']) assert.doesNotMatch(src(file), /Submit sitemap to GSC/i);
  for (const file of ['ui/SeoSitemaps.tsx', 'ui/SeoPages.tsx']) {
    assert.doesNotMatch(src(file), /#[0-9a-fA-F]{3,8}\b/, `${file} has a hard-coded colour`);
    assert.doesNotMatch(src(file), /\bkeyValue\b|indexNowKey\b/);
  }
  const keyView = maps.keyFileGuidance({ status: 'not-found', keyFileName: 'abcd…ef.txt' });
  assert.ok(!keyView.includes('SECRET-KEY-VALUE'));
  const routes = readFileSync(new URL('./serverStub.mjs', import.meta.url), 'utf8');
  for (const route of ['sitemaps/urls/inspect', 'indexnow/submit', 'pages/detail']) assert.ok(routes.includes(route), route);
});

test('C24 Check Bing is offered only when Bing is connected, for 1 to 50 selected rows, and the store reloads the URL list', async () => {
  const stub = installServerStub();
  const b = await seoBuilding();
  assert.equal(maps.bingAction(0, [{ bing: { state: 'not-connected' } }]).visible, false);
  const connected = [{ bing: { state: 'unchecked' } }];
  assert.deepEqual([maps.bingAction(0, connected).visible, maps.bingAction(0, connected).disabled], [true, true]);
  assert.deepEqual([maps.bingAction(2, connected).disabled, maps.bingAction(2, connected).label], [false, 'Check 2 in Bing']);
  assert.equal(maps.bingAction(51, connected).disabled, true);
  stub.seo.requests.length = 0;
  const result = await useSeoStore.getState().checkBing(b.id, ['https://example.com/a'], new URLSearchParams({ limit: '100' }));
  assert.equal(result.ok, true);
  assert.deepEqual(stub.seo.bingChecked, ['https://example.com/a']);
  assert.deepEqual(stub.seo.requests.map((r) => r.rest), ['sitemaps/bing-check', 'sitemaps/urls']);
  assert.match(src('ui/SeoSitemaps.tsx'), /checkBing\(id, \[\.\.\.selected\]/);
});

test('C25 submitting a whole index counts the URLs below it', () => {
  const s = (url, extra) => ({ url, urlCount: null, children: [], ...extra });
  const all = [s('i', { children: ['a', 'b', 'i'] }), s('a', { urlCount: 3 }), s('b', { urlCount: 4 })];
  assert.equal(maps.submissionCount(all[0], all), 7);
  assert.equal(maps.submissionCount(all[1], all), 3);
});
