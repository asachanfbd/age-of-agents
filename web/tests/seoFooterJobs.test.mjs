import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const lib = await import('../src/lib/runningCommands.ts');
const { SEO_TABS, seoTabForJob } = await import('../src/lib/seoWorkspace.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const projects = [{ id: 'p-a', name: 'Alpha' }, { id: 'p-b', name: 'Beta' }];
const job = (id, buildingId, patch = {}) => ({ id, buildingId, kind: 'crawl', status: 'running', startedAt: new Date(T0).toISOString(), progress: { fetched: 42, queued: 120, failed: 1 }, ...patch });
const groupsOf = (jobs, list = projects) => lib.buildRunningGroups({ projects: list, commandRunsById: {}, testRunsById: {}, seoJobsById: Object.fromEntries(jobs.map((j) => [j.id, j])) });

test('a running crawl is one seo row with its name, progress and start, grouped by project', () => {
  const [group] = groupsOf([job('r1', 'p-a')]);
  assert.equal(group.projectId, 'p-a');
  assert.deepEqual(group.rows.map((r) => [r.key, r.kind, r.name, r.progress, r.stoppable, r.startedAt]), [['seo:r1', 'seo', 'Internal links crawl', '42 fetched, 120 queued', true, new Date(T0).toISOString()]]);
});

test('settled jobs and jobs of an unlisted Building are not rows; non-crawl jobs have no Stop and no progress text', () => {
  assert.equal(lib.countRunningRows(groupsOf([job('a', 'p-a', { status: 'complete' }), job('b', 'p-a', { status: 'failed' }), job('c', 'p-gone')])), 0);
  const [group] = groupsOf([job('s', 'p-a', { kind: 'sitemaps', progress: undefined }), job('i', 'p-a', { kind: 'inspection', progress: undefined })]);
  assert.deepEqual(group.rows.map((r) => [r.name, r.stoppable, r.progress]).sort(), [['Sitemap fetch', false, undefined], ['URL inspection', false, undefined]]);
});

test('the footer count mixes command, test and seo rows; several jobs of one Building have separate rows', () => {
  const groups = lib.buildRunningGroups({
    projects,
    commandRunsById: { c: { id: 'c', projectId: 'p-a', commandName: 'dev', status: 'running', origin: 'saved', location: { kind: 'main' }, startedAt: new Date(T0).toISOString() } },
    testRunsById: {},
    seoJobsById: { r1: job('r1', 'p-a'), r2: job('r2', 'p-a', { kind: 'sitemaps' }) },
  });
  assert.equal(lib.countRunningRows(groups), 3);
  assert.equal(lib.countRunningRows(lib.buildRunningGroups({ projects, commandRunsById: {}, testRunsById: {} })), 0, 'the seo source is optional');
});

test('every job kind maps to a real SEO tab', () => {
  const keys = SEO_TABS.map((t) => t.key);
  for (const kind of ['crawl', 'sitemaps', 'inspection', 'keywords-research', 'keywords-cluster']) assert.ok(keys.includes(seoTabForJob(kind)), kind);
  assert.equal(seoTabForJob('crawl'), 'internal-links');
});

const baseState = () => ({ seoJobsById: {}, settledSeoJobIds: {} });
const apply = (state, event) => ({ ...state, ...mergeWorkerEvent(state, event) });

test('seoJob events add the row, update its progress and remove it on each ending status; Stop row disappears with the end event', () => {
  for (const status of ['complete', 'stopped', 'failed']) {
    let state = apply(baseState(), { type: 'seoJob', job: job('r1', 'p-a') });
    assert.deepEqual(Object.keys(state.seoJobsById), ['r1']);
    state = apply(state, { type: 'seoJob', job: job('r1', 'p-a', { progress: { fetched: 50, queued: 90, failed: 1 } }) });
    assert.equal(state.seoJobsById.r1.progress.fetched, 50);
    state = apply(state, { type: 'seoJob', job: job('r1', 'p-a', { status }) });
    assert.deepEqual(state.seoJobsById, {}, status);
    assert.equal(lib.countRunningRows(groupsOf(Object.values(state.seoJobsById))), 0);
  }
});

test('a progress event that arrives after the end does not bring the row back', () => {
  let state = apply(baseState(), { type: 'seoJob', job: job('r1', 'p-a', { status: 'stopped' }) });
  state = apply(state, { type: 'seoJob', job: job('r1', 'p-a') });
  assert.deepEqual(state.seoJobsById, {});
});

function resetStore() {
  useWorldStore.setState({ projects: [{ id: 'p-a', name: 'Alpha' }], seoJobsById: {}, settledSeoJobIds: {}, seoTabRequest: null, workspaceProjectId: null, notificationCenterOpen: true });
}

test('loadSeoJobs replaces the stored jobs: one that ended while disconnected drops out, a settled one is not resurrected', async () => {
  resetStore();
  useWorldStore.setState({ seoJobsById: { old: job('old', 'p-a') }, settledSeoJobIds: { late: true } });
  const original = serverApi.seoRunningJobs;
  serverApi.seoRunningJobs = async () => ({ jobs: [job('new', 'p-a'), job('late', 'p-a')] });
  try { await useWorldStore.getState().loadSeoJobs(); } finally { serverApi.seoRunningJobs = original; }
  assert.deepEqual(Object.keys(useWorldStore.getState().seoJobsById), ['new']);
});

test('loadProjects reloads the jobs, which is also what runs on every /ws reconnect', async () => {
  const source = await read('../src/store/worldStore.ts');
  assert.match(source, /void get\(\)\.loadBuildingTypes\(\);\s*void get\(\)\.loadSeoJobs\(\);/);
  assert.match(source, /\(\) => \{\s*set\(\{ wsConnected: true \}\);\s*void get\(\)\.loadProjects\(\);/);
});

test('openSeoFromFooter opens the Building with a fresh tab request, closes the drawer, and ignores an unknown Building', () => {
  resetStore();
  useWorldStore.getState().openSeoFromFooter('p-gone', 'internal-links');
  assert.equal(useWorldStore.getState().seoTabRequest, null);
  assert.equal(useWorldStore.getState().workspaceProjectId, null);
  useWorldStore.getState().openSeoFromFooter('p-a', 'internal-links');
  const state = useWorldStore.getState();
  assert.equal(state.workspaceProjectId, 'p-a');
  assert.equal(state.notificationCenterOpen, false);
  assert.deepEqual(state.seoTabRequest, { projectId: 'p-a', tab: 'internal-links' });
  useWorldStore.getState().clearSeoTabRequest();
  assert.equal(useWorldStore.getState().seoTabRequest, null);
  useWorldStore.getState().openSeoFromFooter('p-a', 'internal-links');
  assert.notEqual(useWorldStore.getState().seoTabRequest, state.seoTabRequest, 'a repeat request is a new object');
});

test('stopSeoCrawlFromFooter calls the stop route for the Building', async () => {
  const calls = [];
  const original = serverApi.seoStopCrawl;
  serverApi.seoStopCrawl = async (id) => { calls.push(id); return null; };
  try { await useWorldStore.getState().stopSeoCrawlFromFooter('p-a'); } finally { serverApi.seoStopCrawl = original; }
  assert.deepEqual(calls, ['p-a']);
});

test('the popover row: Stop is a sibling of the open button (never nested), stops propagation, only crawl rows carry it, and a click opens the owning tab', async () => {
  const lists = await read('../src/ui/FooterListPopovers.tsx');
  assert.match(lists, /<li key=\{row\.key\} className="flex items-center gap-1">\s*<button type="button" className=\{ROW\}/);
  const openButton = lists.slice(lists.indexOf('onClick={() => open(row)}'), lists.indexOf('{row.stoppable && ('));
  assert.match(openButton, /<\/button>\s*$/, 'the open button closes before the Stop button starts');
  assert.match(lists, /\{row\.stoppable && \(\s*<button[^>]*onClick=\{\(event\) => \{ event\.stopPropagation\(\); void stopRow\(row\); \}\}/);
  assert.match(lists, /if \(row\.kind === 'seo'\) return stopSeoCrawl\(row\.projectId\);\s*if \(row\.contentKind === 'remotion-studio'\) return stopStudio\(row\.projectId\);\s*if \(row\.contentKind === 'insights'\) return stopInsights\(row\.projectId\);\s*if \(row\.contentKind === 'thumbnail'\) return stopThumbnailRender\(row\.projectId, row\.assetId!, row\.runId\);\s*return row\.assetId \? stopImageRender\(row\.projectId, row\.assetId, row\.runId\) : stopRender\(row\.projectId, row\.conceptId!, row\.runId\);/);
  assert.match(lists, /openSeoFromFooter\(row\.projectId, seoTabForJob\(row\.jobKind!\)\)/);
  assert.match(lists, /\{row\.progress && /);
  assert.match(await read('../src/ui/StatusFooter.tsx'), /buildRunningGroups\(\{ projects, commandRunsById, testRunsById, seoJobsById, contentJobsById \}\)/);
});

test('SeoWorkspace applies a tab request for its Building even when already open on another tab, then clears it', async () => {
  const source = await read('../src/ui/SeoWorkspace.tsx');
  assert.match(source, /if \(!tabRequest \|\| tabRequest\.projectId !== project\.id\) return;\s*setTab\(tabRequest\.tab\);\s*clearTabRequest\(\);/);
  assert.match(source, /\[tabRequest, project\.id, clearTabRequest\]/);
});
