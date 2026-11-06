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

const rp = await import('../src/lib/seoReports.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { useSeoReportsStore } = await import('../src/store/seoReportsStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { seoReportsState, sampleReport, tile } = await import('./seoReportsStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const view = (over) => rp.tileView(tile('clicks', 'Clicks', over));

test('C01 the selector offers four presets and a custom range, with no year-over-year option', () => {
  assert.deepEqual(rp.PRESET_OPTIONS.map((o) => o.key), ['week', 'month', 'last-28', 'custom']);
  assert.deepEqual(rp.PRESET_OPTIONS.map((o) => o.label), ['This week vs last week', 'This month vs last month', 'Last 28 days vs previous 28', 'Custom range']);
  assert.equal(rp.PRESET_OPTIONS.some((o) => /year/i.test(o.label)), false);
  const ui = src('ui/SeoReports.tsx');
  assert.match(ui, /controls\.preset === 'custom' && \(/);
  assert.match(ui, /aria-label="Compare from"/);
  assert.match(ui, /Leave the comparison empty to compare with the period of equal length right before/);
});

test('C02 the range line names both periods, the Monday rule and the lengths', () => {
  assert.equal(rp.rangeLine(sampleReport().period), '17 Sep – 14 Oct 2026 vs 20 Aug – 16 Sep 2026 · weeks start Monday · 28 days vs 28 days');
  assert.equal(rp.rangeLine({ ...sampleReport().period, current: null, lengths: { current: 0, previous: 1 } }), 'no data vs 20 Aug – 16 Sep 2026 · weeks start Monday · 0 days vs 1 day');
  assert.equal(rp.formatWindow({ from: '2025-12-28', to: '2026-01-03' }), '28 Dec 2025 – 3 Jan 2026');
  assert.equal(rp.formatWindow({ from: '2026-10-05', to: '2026-10-05' }), '5 Oct 2026');
});

test('C03 a tile shows value, change, percentage, glyph and word; position is inverted', () => {
  const up = view({ current: 1234, previous: 1000, change: 234, changePct: 23.4 });
  assert.deepEqual([up.value, up.comparison, up.change, up.glyph, up.word, up.tone], ['1,234', 'comparison 1,000', '▲ +234 (+23.4%) better', '▲', 'better', 'good']);
  const down = view({ current: 80, previous: 100, change: -20, changePct: -20, direction: 'down', verdict: 'worse', glyph: '▼' });
  assert.deepEqual([down.change, down.tone], ['▼ -20 (-20%) worse', 'bad']);
  const position = rp.tileView(tile('position', 'Average position', { unit: 'position', current: 4, previous: 5, change: -1, changePct: -20, direction: 'down', verdict: 'better', glyph: '▼' }));
  assert.deepEqual([position.value, position.change, position.word], ['4.0', '▼ -1.0 (-20%) better', 'better']);
  const ctr = rp.tileView(tile('ctr', 'CTR', { unit: 'percent', current: 6.5, previous: 7.5, change: -1, changePct: -13.3, direction: 'down', verdict: 'worse', glyph: '▼' }));
  assert.deepEqual([ctr.value, ctr.change], ['6.50%', '▼ -1.00 points (-13.3%) worse']);
  assert.equal(view({ isNew: true, change: 5, changePct: null, current: 5, previous: 0 }).change, '▲ +5 (new) better');
  const flat = view({ change: 0, changePct: null, direction: 'flat', verdict: 'flat', glyph: '■' });
  assert.deepEqual([flat.change, flat.tone], ['■ 0 flat', 'neutral']);
  assert.match(down.label_aria, /▼ -20 \(-20%\) worse/);
  const perDay = view({ perDay: true, change: 1.5, changePct: 10, current: 90, previous: 80 });
  assert.match(perDay.change, /\+1\.5 \(\+10%\) better per day/);
});

test('C04 a source that is not connected says so, offers the connection and never shows 0', () => {
  const v = rp.tileView(tile('sessions', 'Sessions', { state: 'not-connected', current: null, previous: null, change: null, direction: null, verdict: null, glyph: null }));
  assert.deepEqual([v.value, v.action, v.change, v.glyph], ['Not connected', 'connect', '', null]);
  assert.notEqual(v.value, '0');
  const links = rp.tileView(tile('newBacklinks', 'New backlinks', { state: 'not-available', current: null, previous: null }));
  assert.deepEqual([links.value, links.action], ['Not available yet', 'import']);
});

test('C05 a metric with no data shows "no data" and no change; one missing side keeps the other', () => {
  const none = rp.tileView(tile('clicks', 'Clicks', { state: 'no-data', current: null, previous: null, change: null, direction: null, verdict: null, glyph: null }));
  assert.deepEqual([none.value, none.change], ['no data', '']);
  const half = view({ current: 12, previous: null, change: null, direction: null, verdict: null, glyph: null, missing: 'previous' });
  assert.deepEqual([half.value, half.comparison, half.change], ['12', 'comparison: no data', '']);
});

test('C06 DR and UR tiles come only from the report, with the coverage line', () => {
  const dr = rp.tileView(tile('avgDr', 'Average DR', { current: 51.5, previous: 40, detail: '412 of 520 links have DR' }));
  assert.deepEqual([dr.value, dr.detail], ['51.5', '412 of 520 links have DR']);
  const report = sampleReport();
  assert.equal(report.tiles.some((t) => t.key === 'avgDr'), false);
  assert.match(src('ui/SeoReports.tsx'), /report\.backlinks\.coverage\.dr \?\? 'No DR in the imported data\.'/);
});

test('C07 notes for partial, out-of-window and per-day comparison show exactly what the report carries', () => {
  const notes = ['3 recent days are left out.', 'Search and analytics data is only kept back to 2025-10-15.'];
  assert.deepEqual(sampleReport({ notes }).notes, notes);
  assert.match(src('ui/SeoReports.tsx'), /report\.notes\.map\(\(n\) => <Alert key=\{n\}>/);
  assert.equal(sampleReport().notes.length, 0);
});

test('C08 an empty Building shows ordered setup guidance and an Open Connections action', () => {
  const ui = src('ui/SeoReports.tsx');
  assert.match(ui, /report\.state === 'setup'/);
  assert.match(ui, /<ol[^>]*>\{report\.setup\.map/);
  assert.match(ui, /Open Connections/);
});

test('C09 the partial-days toggle and the threshold map to the request', () => {
  assert.equal(rp.reportParams(rp.DEFAULT_CONTROLS).toString(), 'preset=last-28');
  const p = rp.reportParams({ ...rp.DEFAULT_CONTROLS, includePartial: true, minImpressions: 10 });
  assert.deepEqual([p.get('includePartial'), p.get('minImpressions')], ['true', '10']);
  const custom = rp.reportParams({ ...rp.DEFAULT_CONTROLS, preset: 'custom', from: '2026-09-01', to: '2026-09-10', compareFrom: '2026-08-01', compareTo: '2026-08-31' });
  assert.deepEqual([custom.get('from'), custom.get('to'), custom.get('compareFrom'), custom.get('compareTo')], ['2026-09-01', '2026-09-10', '2026-08-01', '2026-08-31']);
  assert.equal(rp.reportParams({ ...rp.DEFAULT_CONTROLS, from: '2026-01-01' }).has('from'), false, 'dates are sent only for a custom range');
  assert.equal(rp.controlsError({ ...rp.DEFAULT_CONTROLS, preset: 'custom' }), 'Choose a start and an end date.');
  assert.match(rp.controlsError({ ...rp.DEFAULT_CONTROLS, preset: 'custom', from: '2026-09-10', to: '2026-09-01' }), /not be after/);
  assert.match(rp.controlsError({ ...rp.DEFAULT_CONTROLS, preset: 'custom', from: '2026-09-01', to: '2026-09-10', compareFrom: '2026-08-01' }), /both comparison dates/);
  assert.match(rp.controlsError({ ...rp.DEFAULT_CONTROLS, minImpressions: -1 }), /whole number/);
  assert.equal(rp.controlsError(rp.DEFAULT_CONTROLS), null);
});

test('C10 chart geometry: two series, dashed comparison, gaps break the line, position runs upward as it improves', () => {
  const chart = sampleReport().charts[0];
  const m = rp.chartModel(chart);
  assert.deepEqual([m.previousDashed, m.min, m.max], [true, 1, 5]);
  assert.equal(m.currentPath, 'M0.0 36.0 M100.0 0.0', 'the null day lifts the pen');
  assert.equal(m.previousPath.startsWith('M0.0 '), true);
  assert.match(m.previousPath, /L50\.0/);
  assert.match(m.ariaLabel, /dashed line is the comparison period/);
  const position = rp.chartModel({ ...chart, key: 'position', label: 'Position', points: [{ n: 1, current: 1, previous: 9, currentDay: 'a', previousDay: 'b' }] });
  assert.match(position.ariaLabel, /lower is better/);
  const better = rp.chartModel({ ...chart, key: 'position', points: [{ n: 1, current: 1, previous: 1, currentDay: 'a', previousDay: 'b' }, { n: 2, current: 5, previous: 5, currentDay: 'a', previousDay: 'b' }] });
  assert.equal(better.currentPath, 'M0.0 0.0 L100.0 36.0', 'a lower position number is drawn higher');
  const after = rp.chartModel({ ...chart, points: chart.points.slice(0, 2) });
  assert.notEqual(after.currentPath, m.currentPath, 'geometry is recomputed for a new period');
  assert.equal(rp.chartModel({ ...chart, state: 'not-connected', points: [] }).ariaLabel, 'Clicks: not connected');
});

test('C11 winners and losers rows carry a glyph and a word; the threshold maps to the request; an empty list says why', () => {
  const report = sampleReport();
  const [row] = rp.moverRows(report.movers.pages.gains, 'gain', false);
  assert.deepEqual([row.name, row.clicks, row.change, row.glyph, row.word, row.position], ['https://example.com/a', '10 → 30', '+20', '▲', 'gain', '5.0 → 3.0']);
  assert.equal(rp.moverRows(report.movers.pages.gains, 'gain', true)[0].change, '+20.0 per day');
  const loss = rp.moverRows([{ ...report.movers.pages.gains[0], change: -4, positionCurrent: null }], 'loss', false)[0];
  assert.deepEqual([loss.change, loss.glyph, loss.position], ['-4', '▼', 'no data']);
  assert.equal(rp.moversEmptyText(report, report.movers.keywords), 'Nothing reached 50 impressions in both periods.');
  assert.equal(rp.moversEmptyText(report, report.movers.pages), null);
  assert.equal(rp.reportParams({ ...rp.DEFAULT_CONTROLS, minImpressions: 200 }).get('minImpressions'), '200');
  assert.equal(rp.positionRows([{ ...report.movers.pages.gains[0], positionChange: -2 }], 'gain')[0].change, '-2.0');
});

test('C12 the backlink table shows DR and UR or "no data"', () => {
  assert.deepEqual([rp.linkCell(60), rp.linkCell(0), rp.linkCell(null)], ['60', '0', 'no data']);
  const ui = src('ui/SeoReports.tsx');
  assert.match(ui, /linkCell\(l\.dr\)/);
  assert.match(ui, /linkCell\(l\.ur\)/);
});

test('C13 the indexing and internal-link sections have a "not available yet" and a "needs two crawls" state', () => {
  const ui = src('ui/SeoReports.tsx');
  assert.match(ui, /Not available yet\. Add sitemaps so pages can be checked/);
  assert.match(ui, /Not available yet\. Import backlinks in the Backlinks tab/);
  assert.match(ui, /<p className="m-0 text-sm text-muted-foreground">\{il\.reason\}<\/p>/);
  assert.match(sampleReport().internalLinks.reason, /two crawls/);
});

test('C14 the AI panel states: empty, generating, ready, stale and failed, and the button reads Regenerate once there is a summary', () => {
  const report = sampleReport();
  const summary = { paragraph: 'p', actions: [], generatedAt: 'x', periodKey: 'k', digest: report.digest, label: 'AI-generated' };
  assert.equal(rp.summaryStatus(null, report, false, null), 'empty');
  assert.equal(rp.summaryStatus(null, report, true, null), 'generating');
  assert.equal(rp.summaryStatus(summary, report, false, null), 'ready');
  assert.equal(rp.summaryStatus({ ...summary, digest: 'other' }, report, false, null), 'stale');
  assert.equal(rp.summaryStatus(null, report, false, 'model unavailable'), 'failed');
  assert.deepEqual(['empty', 'generating', 'ready', 'stale', 'failed'].map(rp.summaryButtonLabel), ['Write an AI summary', 'Writing…', 'Regenerate', 'Regenerate', 'Write an AI summary']);
  assert.equal(rp.summaryCaption(summary, report), 'AI-generated · for 17 Sep – 14 Oct 2026 vs 20 Aug – 16 Sep 2026');
  assert.match(rp.summaryCaption({ ...summary, digest: 'other' }, report), /written for different numbers/);
  assert.match(src('ui/SeoReports.tsx'), /The report below is complete without it/);
});

test('C15 saving validates the name, updates the history count and confirms in words', async () => {
  assert.equal(rp.saveNameError('x'.repeat(80)), null);
  assert.match(rp.saveNameError('x'.repeat(81)), /at most 80/);
  assert.equal(rp.savedCount(3), 'Saved reports (3)');
  assert.equal(rp.savedConfirmation({ name: 'Week 41' }, 1), 'Saved "Week 41". You now have 1 saved report.');
  const { b, state } = await building();
  const res = await useSeoReportsStore.getState().saveReport(b.id, rp.DEFAULT_CONTROLS, '  Q3  ');
  assert.equal(res.ok, true);
  assert.equal(res.saved.name, 'Q3');
  assert.equal(useSeoReportsStore.getState().savedByProject[b.id].length, 1);
  assert.equal(state.requests.find((r) => r.method === 'POST' && r.rest === 'reports').body.name, 'Q3');
  const tooLong = await useSeoReportsStore.getState().saveReport(b.id, rp.DEFAULT_CONTROLS, 'x'.repeat(81));
  assert.deepEqual([tooLong.ok, tooLong.status], [false, 400]);
});

test('C16 the saved list shows Scheduled, Manual and AI summary badges', () => {
  assert.deepEqual(rp.savedBadges({ source: 'scheduled', hasSummary: false }), ['Scheduled']);
  assert.deepEqual(rp.savedBadges({ source: 'manual', hasSummary: true }), ['Manual', 'AI summary']);
  assert.match(src('ui/SeoReports.tsx'), /savedBadges\(m\)\.map/);
});

test('C17 a saved report opens as a read-only snapshot: banner, no period controls, no Save, no regenerate', async () => {
  const { b } = await building();
  await useSeoReportsStore.getState().saveReport(b.id, rp.DEFAULT_CONTROLS, 'Saved one');
  const id = useSeoReportsStore.getState().savedByProject[b.id][0].id;
  assert.equal((await useSeoReportsStore.getState().openSaved(b.id, id)).ok, true);
  assert.equal(useSeoReportsStore.getState().openedByProject[b.id].name, 'Saved one');
  assert.match(rp.SAVED_BANNER, /Saved snapshot, independent of live data/);
  const ui = src('ui/SeoReports.tsx');
  const saved = ui.slice(ui.indexOf('function SavedArea'), ui.indexOf('/** The Reports tab'));
  assert.ok(saved.includes('SAVED_BANNER'));
  assert.equal(saved.includes('ControlsBar'), false);
  assert.equal(saved.includes('Save report'), false);
  assert.match(saved, /readOnly/);
  assert.match(ui, /if \(readOnly && !summary\) return null;/);
  assert.match(ui, /\{!readOnly && <Button/);
});

test('C18 the export menu lists CSV tables, Markdown and a print view, and the client paths match the daemon routes', () => {
  assert.deepEqual(rp.EXPORTS.map((e) => e.format), ['csv', 'csv', 'csv', 'csv', 'csv', 'md', 'html']);
  assert.equal(rp.exportPath('r1', rp.EXPORTS[0], rp.DEFAULT_CONTROLS), 'reports/r1/export?format=csv&table=scorecard');
  assert.equal(rp.exportPath(null, rp.EXPORTS[5], { ...rp.DEFAULT_CONTROLS, includePartial: true }), 'reports/live/export?preset=last-28&includePartial=true&format=md');
  const routes = readFileSync(new URL('../../server/src/api/seoReportRoutes.ts', import.meta.url), 'utf8');
  assert.match(routes, /`\$\{base\}\/live\/export`/);
  assert.match(routes, /`\$\{base\}\/:reportId\/export`/);
  const api = src('lib/serverApi.ts');
  for (const path of ['/seo/reports/live?', '/seo/reports/summary', '/seo/reports/schedule', '/seo/reports`', '/seo/reports/${encodeURIComponent(reportId)}']) assert.ok(api.includes(path), path);
});

test('C19 the schedule card shows the toggles when the scheduler runs and the manual note when it does not', async () => {
  assert.equal(rp.scheduleView(null).available, false);
  assert.match(rp.scheduleView({ available: false, schedules: [] }).note, /saved by hand/);
  const on = rp.scheduleView({ available: true, schedules: [{ id: 'j1', cadence: 'weekly', enabled: true, cron: '0 8 * * 1', nextRunAt: '2026-10-19T08:00:00.000Z' }] });
  assert.deepEqual(on.rows.map((r) => [r.cadence, r.enabled, r.next]), [['weekly', true, '2026-10-19T08:00:00.000Z'], ['monthly', false, null]]);
  const { b, state } = await building();
  assert.equal((await useSeoReportsStore.getState().setSchedule(b.id, 'weekly', true)).ok, true);
  assert.equal(state.schedules[0].actionId, 'report-weekly');
  assert.equal(useSeoReportsStore.getState().scheduleByProject[b.id].schedules.length, 1);
  await useSeoReportsStore.getState().setSchedule(b.id, 'weekly', false);
  assert.equal(state.schedules[0].enabled, false);
  state.schedulerRunning = false;
  await useSeoReportsStore.getState().loadSchedule(b.id);
  assert.equal(rp.scheduleView(useSeoReportsStore.getState().scheduleByProject[b.id]).available, false);
});

test('C20 a slow answer for an old period never overwrites a newer one', async () => {
  const { b, state } = await building();
  let release;
  state.gate = (params) => (params.get('preset') === 'week' ? new Promise((resolve) => { release = resolve; }) : undefined);
  const slow = useSeoReportsStore.getState().loadReport(b.id, { ...rp.DEFAULT_CONTROLS, preset: 'week' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await useSeoReportsStore.getState().loadReport(b.id, { ...rp.DEFAULT_CONTROLS, preset: 'month' });
  release();
  await slow;
  assert.equal(useSeoReportsStore.getState().reportByProject[b.id].period.preset, 'month');
});

test('C21 the Reports tab renders the panel in SeoWorkspace, and every good or bad colour is paired with a glyph and a word', () => {
  const shell = src('ui/SeoWorkspace.tsx');
  assert.ok(shell.includes('<SeoReports project={project} onOpenSettings='));
  assert.equal(shell.includes('EmptyTab'), false, 'the placeholder is gone');
  const ui = src('ui/SeoReports.tsx');
  assert.match(ui, /\{v\.change && <div className=\{`mt-1 text-xs font-medium \$\{TONE\[v\.tone\]\}`\}>\{v\.change\}<\/div>\}/);
  assert.match(ui, /\{r\.glyph\} \{r\.change\} \{r\.word === 'gain' \? 'gain' : 'loss'\}/);
  for (const t of [tile('a', 'A')]) assert.ok(rp.tileView(t).glyph);
  for (const verdict of ['better', 'worse']) {
    const v = view({ verdict, glyph: verdict === 'better' ? '▲' : '▼', change: 1, changePct: 1 });
    assert.match(v.change, new RegExp(`[▲▼].*${verdict}`));
  }
});

test('C22 deleting a saved report removes it from the store; an unknown one is a 404', async () => {
  const { b } = await building();
  await useSeoReportsStore.getState().saveReport(b.id, rp.DEFAULT_CONTROLS, 'Doomed');
  const id = useSeoReportsStore.getState().savedByProject[b.id][0].id;
  await useSeoReportsStore.getState().openSaved(b.id, id);
  assert.equal((await useSeoReportsStore.getState().deleteSaved(b.id, id)).ok, true);
  assert.deepEqual([useSeoReportsStore.getState().savedByProject[b.id], useSeoReportsStore.getState().openedByProject[b.id]], [[], null]);
  const again = await useSeoReportsStore.getState().deleteSaved(b.id, id);
  assert.deepEqual([again.ok, again.status], [false, 404]);
  assert.match(src('ui/SeoReports.tsx'), /Delete for good/);
});

test('C23 the stand-in answers the daemon\'s 400, 404 and 409 for the new routes', async () => {
  const { b, state } = await building();
  const bad = await useSeoReportsStore.getState().loadReport(b.id, { ...rp.DEFAULT_CONTROLS, preset: 'custom', from: '2026-09-10', to: '2026-09-01' });
  assert.deepEqual([bad.ok, bad.status, bad.error], [false, 400, 'from must not be after to']);
  const missing = await useSeoReportsStore.getState().openSaved(b.id, 'nope');
  assert.deepEqual([missing.ok, missing.status], [false, 404]);
  state.summaryBusy = true;
  const busy = await useSeoReportsStore.getState().writeSummary(b.id, rp.DEFAULT_CONTROLS);
  assert.deepEqual([busy.ok, busy.status], [false, 409]);
  state.summaryBusy = false;
  state.setup = true;
  const refused = await useSeoReportsStore.getState().saveReport(b.id, rp.DEFAULT_CONTROLS, '');
  assert.deepEqual([refused.ok, refused.status], [false, 409]);
});

test('the summary is requested once at a time, kept for saving, and a failure leaves the report in place', async () => {
  const { b, state } = await building();
  await useSeoReportsStore.getState().loadReport(b.id, rp.DEFAULT_CONTROLS);
  state.summaryFail = 'model unavailable';
  const failed = await useSeoReportsStore.getState().writeSummary(b.id, rp.DEFAULT_CONTROLS);
  assert.equal(failed.ok, false);
  assert.equal(useSeoReportsStore.getState().summaryError[b.id], 'model unavailable');
  assert.equal(useSeoReportsStore.getState().reportByProject[b.id].state, 'ok');
  state.summaryFail = null;
  assert.equal((await useSeoReportsStore.getState().writeSummary(b.id, rp.DEFAULT_CONTROLS)).ok, true);
  assert.equal(useSeoReportsStore.getState().summaryByProject[b.id].label, 'AI-generated');
  assert.equal(useSeoReportsStore.getState().summaryBusy[b.id], false);
  await useSeoReportsStore.getState().saveReport(b.id, rp.DEFAULT_CONTROLS, 'With summary');
  assert.equal(state.requests.find((r) => r.method === 'POST' && r.rest === 'reports').body.summary.paragraph, 'Clicks grew.');
  let release;
  state.summaryGate = () => new Promise((resolve) => { release = resolve; });
  const first = useSeoReportsStore.getState().writeSummary(b.id, rp.DEFAULT_CONTROLS);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await useSeoReportsStore.getState().writeSummary(b.id, rp.DEFAULT_CONTROLS)).status, 409);
  release();
  await first;
});

async function building() {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], newBuildingField: null, ...CLEAN_ERROR_STATE });
  assert.equal(await useWorldStore.getState().addProject('', undefined, 'seo', 'https://example.com/'), true);
  const b = useWorldStore.getState().projects.at(-1);
  const st = stub.seo.byProject.get(b.id);
  st.property = 'https://example.com/';
  const state = seoReportsState(st);
  useSeoReportsStore.setState({ reportByProject: {}, summaryByProject: {}, summaryBusy: {}, summaryError: {}, savedByProject: {}, openedByProject: {}, scheduleByProject: {} });
  return { stub, b, state };
}
