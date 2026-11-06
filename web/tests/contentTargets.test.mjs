import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';
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

/** Targets, post results and Insights in the web: pure helpers, the store through the stand-in, and static renders. */

const rules = await import('../src/lib/contentTargets.ts');
const results = await import('../src/lib/contentResults.ts');
const view = await import('../src/lib/contentView.ts');
const workspace = await import('../src/lib/contentWorkspace.ts');
const running = await import('../src/lib/runningCommands.ts');
const { useContentInsightsStore } = await import('../src/store/contentInsightsStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CONTENT_ROUTES } = await import('./contentStudioStub.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-27T12:00:00Z');
const full = (counts) => ({ impressions: null, views: null, likes: null, comments: null, shares: null, saves: null, followersGained: null, ...counts });
const empty = () => rules.emptyTargets();
const result = (overall, fields = [], over = {}) => ({ overall, fields, judgedFrom: null, progress: null, engagementRate: 2.5, ...over });
const field = (name, state, value, target) => ({ field: name, state, value, target });

test('WT01 the shared table gives the same engagement and rate as the server copy', () => {
  const cases = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/contentTargetCases.json', import.meta.url), 'utf8'));
  for (const c of cases) {
    assert.equal(rules.engagementOf(full(c.counts)), c.engagement, c.name);
    assert.equal(rules.engagementRateOf(c.platform, full(c.counts)), c.rate, c.name);
  }
});

test('WT02 evaluatePost: edges, overall results and the too-early progress', () => {
  const t = { ...empty(), views: 100 };
  const snap = (at, counts) => ({ capturedAt: at, counts: full(counts) });
  const judge = (snapshots, targets = t, days = 7, now = NOW) => rules.evaluatePost({ platform: 'instagram', publishedAt: NOW - 10 * DAY, snapshots, targets, windowDays: days, now });
  assert.equal(judge([snap(NOW - 3 * DAY, { views: 100 })]).overall, 'on-target');
  assert.equal(judge([snap(NOW - 3 * DAY, { views: 99 })]).overall, 'below-target');
  assert.equal(judge([snap(NOW - 3 * DAY, { views: null, likes: 1 })]).fields[0].state, 'no-data');
  assert.equal(judge([snap(NOW - 3 * DAY - 1, { views: 100 })]).overall, 'too-early', 'edge: one millisecond before 7 days is too early');
  assert.equal(judge([snap(NOW - 3 * DAY + 1, { views: 100 })]).overall, 'on-target');
  assert.equal(judge([], t).progress, null);
  assert.equal(judge([snap(NOW, { views: 100, likes: 1 })], { ...t, likes: 5 }).overall, 'partly');
  assert.equal(judge([snap(NOW, { views: 100 })], empty()).overall, 'no-target');
  const early = judge([snap(NOW - 8 * DAY, { views: 7 })], t, 30, NOW);
  assert.deepEqual([early.overall, early.progress.of, early.progress.counts.views, early.progress.day], ['too-early', 30, 7, 10]);
});

test('WT03 result badges: five results, each with a label, a tone and an icon', () => {
  assert.deepEqual(Object.keys(results.RESULT_BADGES), ['on-target', 'partly', 'below-target', 'too-early', 'no-target']);
  for (const badge of Object.values(results.RESULT_BADGES)) assert.ok(badge.label && badge.tone && badge.icon);
  assert.deepEqual(Object.values(results.RESULT_BADGES).map((b) => b.label), ['On target', 'Partly', 'Below target', 'Too early', 'No target']);
});

test('WT04 chip text and the per-platform views label', () => {
  assert.equal(results.chipText('linkedin', field('views', 'hit', 2140, 2000)), 'Hit · Impressions 2,140 / 2,000');
  assert.equal(results.chipText('instagram', field('views', 'missed', 12, 50)), 'Missed · Views 12 / 50');
  assert.equal(results.chipText('x', field('saves', 'no-data', null, 5)), 'No data · Saves');
  assert.equal(results.chipText('facebook', field('engagementRate', 'hit', 3.5, 3)), 'Hit · Engagement rate 3.5% / 3%');
  assert.equal(results.chipText('blog', field('likes', 'hit', 0, 0)), 'Hit · Likes 0 / 0');
  assert.equal(results.chipText('blog', field('likes', 'hit', 1e12, 1e12)), 'Hit · Likes 1,000,000,000,000 / 1,000,000,000,000');
  assert.equal(results.targetFieldLabel('facebook', 'views'), 'Views');
  assert.equal(results.targetFieldLabel('x', 'views'), 'Impressions');
});

test('WT05 the per-platform summary line', () => {
  const s = (over) => ({ platform: 'linkedin', judged: 0, onTarget: 0, tooEarly: 0, noTarget: 0, ...over });
  assert.equal(results.platformSummaryLine(s({ judged: 9, onTarget: 4 })), 'LinkedIn: 4 of 9 judged posts on target');
  assert.equal(results.platformSummaryLine(s({ judged: 1, onTarget: 1 })), 'LinkedIn: 1 of 1 judged post on target');
  assert.equal(results.platformSummaryLine(s({ tooEarly: 2 })), 'LinkedIn: 0 judged posts yet (2 too early)');
  assert.equal(results.platformSummaryLine(s({ noTarget: 3 })), 'LinkedIn: no targets set');
  assert.equal(results.platformSummaryLine(s({})), null);
  assert.deepEqual(results.platformSummaryLines([s({ judged: 2, onTarget: 1 }), s({ platform: 'x' })]), ['LinkedIn: 1 of 2 judged posts on target']);
});

test('WT06 the targets form: values, errors, body, dirty and the set count', () => {
  const saved = { ...empty(), views: 1000, engagementRate: 2.5 };
  const values = results.formFromTargets(saved);
  assert.deepEqual([values.views, values.likes, values.engagementRate], ['1000', '', '2.5']);
  assert.equal(results.targetsDirty(saved, values), false);
  assert.equal(results.targetsDirty(saved, { ...values, likes: '3' }), true);
  assert.equal(results.targetsSetCount(saved), 2);
  assert.deepEqual(results.targetBody({ ...values, views: '', likes: ' 3 ' }), { views: null, likes: 3, comments: null, shares: null, saves: null, engagementRate: 2.5, followersGained: null });
  for (const [f, text, bad] of [['likes', '1.5', true], ['likes', '-1', true], ['likes', '1000000000001', true], ['likes', '1000000000000', false], ['likes', '0', false], ['likes', '', false], ['likes', 'abc', true],
    ['engagementRate', '100', false], ['engagementRate', '100.01', true], ['engagementRate', '1.234', true], ['engagementRate', '99.99', false], ['engagementRate', '-1', true]]) {
    assert.equal(results.targetFieldError(f, text) !== null, bad, `${f} ${text}`);
  }
  assert.deepEqual(Object.keys(results.targetFormErrors({ ...values, likes: 'x', saves: '2.5' })), ['likes', 'saves']);
  for (const [text, bad] of [['0', true], ['91', true], ['7.5', true], ['abc', true], ['1', false], ['90', false]]) assert.equal(results.evaluationDaysError(text) !== null, bad, text);
});

test('WT07 lineDiff marks added and removed lines; identical is unchanged; the first version is all added', () => {
  const diff = results.lineDiff('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(diff.map((l) => l.mark + l.text), [' a', '−b', '+x', ' c']);
  assert.equal(results.diffChanged(results.lineDiff('a', 'a')), false);
  assert.deepEqual(results.lineDiff(null, 'a\nb').map((l) => l.kind), ['added', 'added']);
});

test('WT08 the insights view model: ready, running, failed, never run and read-only', () => {
  const dto = (over) => ({ state: 'ready', markdown: '## Summary', notes: '', notesVersion: 'v', lastError: null, updatedAt: '2026-10-27T10:00:00.000Z', postCount: 3, nextRefreshAt: null, ...over });
  const ready = results.insightsViewModel(dto({}), false, 'UTC', NOW);
  assert.match(ready.statusText, /Updated .* from 3 posts/);
  assert.deepEqual([ready.running, ready.canRefresh, ready.canEditNotes, ready.failure, ready.empty], [false, true, true, null, false]);
  const running = results.insightsViewModel(dto({ state: 'running' }), false, 'UTC', NOW);
  assert.deepEqual([running.statusText, running.running, running.canRefresh], ['Refreshing insights…', true, false]);
  const failed = results.insightsViewModel(dto({ state: 'failed', lastError: { reason: 'The agent did not answer', at: '2026-10-27T11:00:00.000Z' } }), false, 'UTC', NOW);
  assert.match(failed.failure, /^Last refresh failed: The agent did not answer \(/);
  assert.equal(failed.empty, false);
  const never = results.insightsViewModel(dto({ state: 'never-run', markdown: '', updatedAt: null, postCount: null }), false, 'UTC', NOW);
  assert.deepEqual([never.statusText, never.empty], ['No insights yet', true]);
  const readOnly = results.insightsViewModel(dto({}), true, 'UTC', NOW);
  assert.deepEqual([readOnly.canRefresh, readOnly.canEditNotes], [false, false]);
  assert.match(results.insightsViewModel(dto({ postCount: 1 }), false, 'UTC', NOW).statusText, /from 1 post$/);
  assert.equal(results.nextRefreshText(null, NOW), null);
  assert.equal(results.nextRefreshText(new Date(NOW + 7 * 60_000).toISOString(), NOW), 'Refreshes in about 7 minutes');
  assert.equal(results.nextRefreshText(new Date(NOW + 1000).toISOString(), NOW), 'Refreshes in about 1 minute');
  assert.match(results.insightsViewModel(dto({ nextRefreshAt: new Date(NOW + 60_000).toISOString() }), false, 'UTC', NOW).statusText, /Refreshes in about 1 minute/);
});

test('WT09 the Building tab list declares Targets and Insights once, self-guarded, after Writing style; the list filter sends the result', () => {
  const keys = workspace.CONTENT_TABS.map((t) => t.key);
  assert.deepEqual(keys, ['content', 'knowledge', 'style', 'targets', 'insights', 'settings']);
  assert.ok(workspace.CONTENT_TABS.every((t) => t.selfGuarded));
  assert.equal(view.listParams({ ...view.emptyFilters(), result: 'partly' }).result, 'partly');
  assert.equal(view.listParams(view.emptyFilters()).result, '');
  assert.equal(running.CONTENT_JOB_NAMES.insights, 'Insights');
  assert.match(src('ui/FooterListPopovers.tsx'), /contentKind === 'insights'\) return stopInsights/);
});

// ---- the store, through the stand-in ----------------------------------------------------------------------------------

const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentInsightsStore.setState({ targetsByProject: {}, targetHistoryByProject: {}, insightsByProject: {}, insightsHistoryByProject: {}, notesConflictByProject: {} });
});
const store = () => useContentInsightsStore.getState();

test('WT10 the stand-in answers each new route; targets load, save per platform, refuse with the field named and record history', async () => {
  const fresh = CONTENT_ROUTES.filter(([, route]) => /^(targets|insights)/.test(route));
  assert.equal(fresh.length, 8);
  for (const [method, route] of fresh) {
    const res = await fetch(`http://localhost:4500/api/projects/${B}/content/${route.replace(':platform', 'x')}`, { method, body: method === 'GET' ? undefined : JSON.stringify({}) });
    const body = await res.json().catch(() => ({}));
    assert.notEqual(body.error, 'not found', `${method} ${route}`);
    assert.notEqual(res.status, 500, `${method} ${route}`);
  }
  assert.equal((await store().loadTargets(B)).ok, true);
  assert.equal(store().targetsByProject[B].evaluationDays, 7);
  assert.equal(store().targetsByProject[B].targets.linkedin.views, null);
  const body = { ...empty(), views: 1000 };
  assert.equal((await store().saveTargets(B, 'linkedin', body)).ok, true);
  assert.equal(store().targetsByProject[B].targets.linkedin.views, 1000);
  const bad = await store().saveTargets(B, 'linkedin', { ...empty(), engagementRate: 101 });
  assert.deepEqual([bad.ok, bad.field, bad.status], [false, 'engagementRate', 400]);
  assert.equal(store().targetsByProject[B].targets.linkedin.engagementRate, null);
  await store().loadTargetHistory(B);
  assert.equal(store().targetHistoryByProject[B].length, 1);
  stub.content.readOnly = true;
  const frozen = await store().saveTargets(B, 'x', { ...empty(), likes: 1 });
  assert.deepEqual([frozen.ok, frozen.status], [false, 409]);
});

test('WT11 insights: load, refresh to running (409 when already running), stop, and owner notes with a stale-version conflict', async () => {
  await store().loadInsights(B);
  assert.equal(store().insightsByProject[B].state, 'never-run');
  assert.equal((await store().refreshInsights(B)).ok, true);
  assert.equal(store().insightsByProject[B].state, 'running');
  const again = await store().refreshInsights(B);
  assert.deepEqual([again.ok, again.status], [false, 409]);
  assert.equal((await store().stopInsights(B)).ok, true);
  assert.equal(store().insightsByProject[B].state, 'never-run');
  const first = store().insightsByProject[B].notesVersion;
  assert.equal((await store().saveNotes(B, 'Mine', first)).ok, true);
  assert.equal(store().insightsByProject[B].notes, 'Mine');
  const stale = await store().saveNotes(B, 'Other', first);
  assert.deepEqual([stale.ok, stale.status], [false, 409]);
  assert.equal(store().notesConflictByProject[B], store().insightsByProject[B].notesVersion);
  store().clearNotesConflict(B);
  assert.equal(store().notesConflictByProject[B], undefined);
  stub.content.byBuilding.get(B).insights.history = [{ id: 1, at: '2026-10-27T10:00:00.000Z', trigger: 'manual', markdown: 'x', postCount: 1 }];
  await store().loadInsightsHistory(B);
  assert.equal(store().insightsHistoryByProject[B].length, 1);
});

test('WT12 results reach the consumers in the server shape: the list filters by result and summarises; the window changes a result', async () => {
  const c = await contentApi.createConcept(B, { title: 'T', brief: '', posts: [{ platform: 'linkedin', format: 'text', scheduledAt: '2026-11-03T09:00:00Z' }] });
  const raw = stub.content.byBuilding.get(B).concepts.find((x) => x.id === c.id);
  for (const a of [...raw.posts[0].own, ...raw.assets]) Object.assign(a, { state: 'finalized', content: 'Hello' });
  const published = new Date(Date.parse('2026-10-27T12:00:00Z') - 10 * DAY).toISOString();
  await contentApi.finalizePost(B, c.id, c.posts[0].id);
  Object.assign(raw.posts[0], { status: 'published', publishedAt: published });
  raw.posts[0].statList.push({ id: 's1', capturedAt: new Date(Date.parse(published) + 8 * DAY).toISOString(), enteredAt: published, counts: { impressions: 2000, likes: 100 } });
  await store().saveTargets(B, 'linkedin', { ...empty(), views: 1000 });
  const page = await contentApi.concepts(B, { result: 'on-target' });
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].posts[0].result.overall, 'on-target');
  assert.deepEqual(page.summary.find((s) => s.platform === 'linkedin'), { platform: 'linkedin', judged: 1, onTarget: 1, tooEarly: 0, noTarget: 0 });
  assert.equal((await contentApi.concepts(B, { result: 'partly' })).rows.length, 0);
  assert.equal((await contentApi.saveSettings(B, { evaluationDays: 30 })).evaluationDays, 30);
  assert.equal((await contentApi.concept(B, c.id)).posts[0].result.overall, 'too-early');
  await assert.rejects(contentApi.saveSettings(B, { evaluationDays: 0 }), /whole number/);
});

// ---- static renders ---------------------------------------------------------------------------------------------------

test('WT13 the targets form renders five-field cards with labels, placeholders, errors and the read-only state', async () => {
  const saved = { ...empty(), views: 1000 };
  const props = (over) => ({ platform: 'linkedin', saved, values: results.formFromTargets(saved), errors: {}, readOnly: false, onChange() {}, onSave() {}, ...over });
  const card = await render('src/ui/content/TargetsTab.tsx', 'PlatformTargetsCard', props({}));
  for (const text of ['LinkedIn targets', '1 of 7 set', 'Impressions', 'Likes', 'Comments', 'Shares', 'Saves', 'Engagement rate (%)', 'Followers gained', 'placeholder="Not set"', 'Save LinkedIn']) assert.ok(card.includes(text), text);
  assert.match(await render('src/ui/content/TargetsTab.tsx', 'PlatformTargetsCard', props({ platform: 'facebook', saved: empty(), values: results.formFromTargets(empty()) })), /No targets set\. Posts on Facebook show &quot;No target&quot;[\s\S]*Views/);
  const errors = await render('src/ui/content/TargetsTab.tsx', 'PlatformTargetsCard', props({ values: { ...results.formFromTargets(saved), likes: 'x' }, errors: { likes: 'A whole number from 0 to 1,000,000,000,000' } }));
  assert.match(errors, /aria-invalid="true"[^>]*aria-describedby="target-linkedin-likes-error"/);
  assert.match(errors, /Fix 1 field to save/);
  const frozen = await render('src/ui/content/TargetsTab.tsx', 'PlatformTargetsCard', props({ readOnly: true }));
  assert.match(frozen, /read-only/);
  assert.doesNotMatch(frozen, /Save LinkedIn/);
  assert.match(frozen, /disabled=""/);
  const history = await render('src/ui/content/TargetsTab.tsx', 'TargetHistoryList', { entries: [{ id: 1, at: '2026-10-27T10:00:00.000Z', who: 'person', platform: 'x', before: empty(), after: { ...empty(), likes: 5 } }], timeZone: 'UTC' });
  assert.match(history, /You[\s\S]*X \(Twitter\):[\s\S]*Likes — → 5/);
  assert.match(await render('src/ui/content/TargetsTab.tsx', 'TargetHistoryList', { entries: [], timeZone: 'UTC' }), /No changes yet/);
});

test('WT14 post results render chips with an icon and a word, the overall badge and the too-early progress', async () => {
  const platform = 'linkedin';
  const withFields = result('partly', [field('views', 'hit', 2140, 2000), field('likes', 'missed', 12, 50), field('saves', 'no-data', null, 5)]);
  const markup = await render('src/ui/content/ResultViews.tsx', 'PostResultView', { platform, result: withFields, timeZone: 'UTC' });
  for (const text of ['data-result="partly"', 'Hit · Impressions 2,140 / 2,000', 'Missed · Likes 12 / 50', 'No data · Saves', 'data-state="missed"', 'Engagement rate 2.5%']) assert.ok(markup.includes(text), text);
  const early = result('too-early', [], { progress: { day: 3, of: 7, judgedOn: '2026-11-03T00:00:00.000Z', counts: { ...empty(), views: 40 } }, engagementRate: null });
  const earlyMarkup = await render('src/ui/content/ResultViews.tsx', 'PostResultView', { platform, result: early, timeZone: 'UTC', now: NOW });
  assert.match(earlyMarkup, /Too early[\s\S]*Judged on[\s\S]*Day 3 of 7[\s\S]*Impressions 40/);
  assert.match(earlyMarkup, /Engagement rate —/);
  assert.doesNotMatch(earlyMarkup, /data-state/);
  assert.match(await render('src/ui/content/ResultViews.tsx', 'PostResultView', { platform, result: result('no-target'), timeZone: 'UTC', onSetTargets() {} }), /No targets set for LinkedIn\.[\s\S]*Set targets/);
  const zero = await render('src/ui/content/ResultViews.tsx', 'PostResultView', { platform: 'blog', result: result('on-target', [field('likes', 'hit', 0, 0)]), timeZone: 'UTC' });
  assert.match(zero, /Hit · Likes 0 \/ 0/);
});

test('WT15 the Content list renders the result filter, the per-platform summary and a Concept\'s badges', async () => {
  const filter = await render('src/ui/content/ResultViews.tsx', 'ResultFilter', { value: '', onChange() {} });
  for (const text of ['aria-label="Overall result"', 'Any result', 'On target', 'Partly', 'Below target', 'Too early', 'No target']) assert.ok(filter.includes(text), text);
  const summary = await render('src/ui/content/ResultViews.tsx', 'PlatformSummary', { summary: [{ platform: 'linkedin', judged: 9, onTarget: 4, tooEarly: 0, noTarget: 0 }, { platform: 'x', judged: 0, onTarget: 0, tooEarly: 0, noTarget: 0 }] });
  assert.match(summary, /LinkedIn: 4 of 9 judged posts on target/);
  assert.doesNotMatch(summary, /X \(Twitter\)/);
  assert.equal(await render('src/ui/content/ResultViews.tsx', 'PlatformSummary', { summary: undefined }), '');
  const badges = await render('src/ui/content/ResultViews.tsx', 'ConceptResultBadges', { posts: [{ id: 'p1', platform: 'linkedin', result: result('on-target') }, { id: 'p2', platform: 'x', result: null }] });
  assert.match(badges, /LinkedIn[\s\S]*On target/);
  assert.doesNotMatch(badges, /X \(Twitter\)/);
  assert.equal(await render('src/ui/content/ResultViews.tsx', 'ConceptResultBadges', { posts: [] }), '');
  assert.match(await render('src/ui/content/ConceptList.tsx', 'ListFiltersBar', { filters: view.emptyFilters(), onChange() {} }), /aria-label="Overall result"/);
  assert.match(src('ui/content/OverviewTab.tsx'), /post\.result && <PostResultView/);
  assert.match(src('ui/content/SettingsTab.tsx'), /Judge a post after N days/);
});

const insightsDto = (over) => ({ state: 'ready', markdown: '## Summary\n\nHooks work.', notes: 'Never mention prices.', notesVersion: 'v1', lastError: null, updatedAt: '2026-10-27T10:00:00.000Z', postCount: 12, nextRefreshAt: null, ...over });
const panel = (over = {}) => render('src/ui/content/InsightsTab.tsx', 'InsightsPanel', {
  dto: insightsDto({}), readOnly: false, timeZone: 'UTC', notes: 'Never mention prices.', notesDirty: false, conflict: false, error: null, versions: [], openVersion: null, now: NOW,
  onNotes() {}, onSaveNotes() {}, onReload() {}, onOverwrite() {}, onRefresh() {}, onStop() {}, onToggleVersion() {}, ...over,
});

test('WT16 the Insights view: ready with notes on top and a read-only document; running shows Stop; failed keeps the document; never run and read-only', async () => {
  const ready = await panel();
  assert.ok(ready.indexOf('Owner notes') < ready.indexOf('Generated insights'));
  for (const text of ['Updated', 'from 12 posts', 'Refresh insights', 'Hooks work.', 'Save notes']) assert.ok(ready.includes(text), text);
  assert.doesNotMatch(ready, /<textarea[^>]*Hooks work/);
  const running = await panel({ dto: insightsDto({ state: 'running' }) });
  assert.match(running, /Refreshing insights…/);
  assert.match(running, />Stop</);
  assert.doesNotMatch(running, /Refresh insights</);
  const failed = await panel({ dto: insightsDto({ state: 'failed', lastError: { reason: 'The agent did not answer', at: '2026-10-27T11:00:00.000Z' } }) });
  assert.match(failed, /role="alert"[^>]*>Last refresh failed: The agent did not answer \([^)]*\)\. The previous document is kept\./);
  assert.match(failed, /Hooks work\./);
  assert.doesNotMatch(failed, /sonner|toast/i);
  const never = await panel({ dto: insightsDto({ state: 'never-run', markdown: '', updatedAt: null, postCount: null }) });
  assert.match(never, /No insights yet/);
  const frozen = await panel({ readOnly: true });
  assert.match(frozen, /<button[^>]*disabled=""[^>]*>Refresh insights/);
  assert.match(frozen, /<textarea[^>]*disabled=""/);
  assert.doesNotMatch(frozen, /Save notes/);
  assert.match(frozen, /Hooks work\./);
  const conflict = await panel({ conflict: true });
  assert.match(conflict, /Changed since you opened it[\s\S]*Reload[\s\S]*Overwrite/);
});

test('WT17 the version history shows a diff to the previous version with + and − marks', async () => {
  const versions = [
    { id: 2, at: '2026-10-27T10:00:00.000Z', trigger: 'stats', markdown: 'a\nnew\nc', postCount: 4 },
    { id: 1, at: '2026-10-26T10:00:00.000Z', trigger: 'manual', markdown: 'a\nold\nc', postCount: 3 },
  ];
  const closed = await render('src/ui/content/InsightsTab.tsx', 'InsightsHistoryList', { versions, timeZone: 'UTC', openId: null, onToggle() {} });
  assert.match(closed, /4 posts · stats changed[\s\S]*Show changes[\s\S]*3 posts · refreshed by hand/);
  const open = await render('src/ui/content/InsightsTab.tsx', 'InsightsHistoryList', { versions, timeZone: 'UTC', openId: 2, onToggle() {} });
  assert.match(open, /Hide changes/);
  assert.match(open, /data-kind="removed"[^>]*>[^<]*<span[^>]*>−<\/span>old/);
  assert.match(open, /data-kind="added"[^>]*>[^<]*<span[^>]*>\+<\/span>new/);
  const first = await render('src/ui/content/InsightsTab.tsx', 'InsightsHistoryList', { versions: [versions[1]], timeZone: 'UTC', openId: 1, onToggle() {} });
  assert.doesNotMatch(first, /data-kind="removed"/);
  assert.match(await render('src/ui/content/InsightsTab.tsx', 'InsightsHistoryList', { versions: [], timeZone: 'UTC', openId: null, onToggle() {} }), /No versions yet/);
  assert.match(await render('src/ui/content/InsightsTab.tsx', 'DiffView', { lines: results.lineDiff('same', 'same') }), /No changes/);
});

test('WT18 the status footer lists a running Insights job with its Stop', () => {
  const groups = running.buildRunningGroups({
    projects: [{ id: B, name: 'Acme' }], commandRunsById: {}, testRunsById: {},
    contentJobsById: { j1: { id: 'j1', buildingId: B, kind: 'insights', status: 'running', startedAt: '2026-10-27T10:00:00.000Z' } },
  });
  const row = groups[0].rows[0];
  assert.deepEqual([row.name, row.contentKind, row.stoppable], ['Insights', 'insights', true]);
  assert.equal(running.runningStopLabel(row, 'Acme'), 'Stop Insights for Acme');
});

test('WT19 the Targets note names the window and the formula; the long-title wrap and the 320 px layout are pinned', async () => {
  const note = await render('src/ui/content/TargetsTab.tsx', 'TargetsNote', { evaluationDays: 7, onOpenSettings() {} });
  assert.match(note, /Posts are judged 7 days after publishing[\s\S]*change in Settings/);
  assert.match(note, /likes \+ comments \+ shares \+ saves/);
  assert.match(note, /engagement divided by views \(impressions on LinkedIn and X\)/);
  const rows = await render('src/ui/content/ConceptList.tsx', 'ConceptRows', { page: { rows: [{ id: 'c1', title: 'A'.repeat(300), brief: '', archived: false, createdAt: '', updatedAt: '', posts: [], assets: [], progress: { finalized: 0, needed: 0 } }], total: 1, limit: 50, offset: 0, hasMore: false, summary: [] }, loading: false, error: null, timeZone: 'UTC', onOpen() {}, onNew() {} });
  assert.match(rows, /min-w-0[^"]*\[overflow-wrap:anywhere\]">A{300}/);
  for (const file of ['ui/content/TargetsTab.tsx', 'ui/content/InsightsTab.tsx', 'ui/content/ResultViews.tsx']) assert.doesNotMatch(src(file), /\b(w|min-w)-\[\d+px\]/, `${file} has no fixed width`);
  assert.match(src('ui/content/TargetsTab.tsx'), /grid gap-2\.5 sm:grid-cols-2/);
  assert.match(src('ui/content/TargetsTab.tsx'), /grid min-w-0 gap-3/);
  assert.doesNotMatch(src('ui/content/TargetsTab.tsx') + src('ui/content/InsightsTab.tsx'), /hard-coded|#[0-9a-fA-F]{6}\b/);
});

test('WT20 the footer Stop for an Insights job calls the insights stop route', async () => {
  const { useWorldStore } = await import('../src/store/worldStore.ts');
  await store().refreshInsights(B);
  assert.equal(stub.content.byBuilding.get(B).insights.state, 'running');
  await useWorldStore.getState().stopInsightsFromFooter(B);
  assert.equal(stub.content.byBuilding.get(B).insights.state, 'never-run');
  assert.ok(stub.content.requests.some((r) => r.method === 'POST' && r.path === 'insights/stop'));
});
