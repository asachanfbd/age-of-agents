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

const bl = await import('../src/lib/seoBacklinks.ts');
const tasks = await import('../src/lib/seoTasks.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { useSeoBacklinksStore } = await import('../src/store/seoBacklinksStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { seoBacklinksState } = await import('./seoBacklinksStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const repo = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const link = (extra = {}) => ({ uid: 'l1', sourceUrl: 'https://a.com/p', sourceHost: 'a.com', targetUrl: 'https://example.com/x', anchor: 'hi', linkType: 'follow', firstSeen: '2026-10-01', lastSeen: '2026-10-10', status: 'live', lostAt: null, sourceDr: null, sourceUr: null, sourceTraffic: null, pageDr: null, pageUr: null, pageTraffic: null, otherHost: false, extras: {}, note: '', ...extra });

test('W1 a missing value is a dash, a stored 0 is 0 and thousands are separated', () => {
  assert.equal(bl.formatCell(null), '—');
  assert.equal(bl.formatCell(undefined), '—');
  assert.equal(bl.formatCell(0), '0');
  assert.equal(bl.formatCell(12400), '12,400');
  assert.equal(bl.formatCell(62.54), '62.5');
});

test('W2 the summary strip says how many links have DR, and shows a dash when none do', () => {
  const tiles = bl.summaryTiles({ total: 1248, referringDomains: 310, newInPeriod: 40, lostInPeriod: 7, averageDr: 41.3, withDr: 906 });
  assert.equal(tiles[0].note, '906 of 1,248 links have DR');
  assert.equal(tiles[4].value, '41.3');
  const none = bl.summaryTiles({ total: 10, referringDomains: 4, newInPeriod: 0, lostInPeriod: 0, averageDr: null, withDr: 0 });
  assert.equal(none[0].note, '0 of 10 links have DR');
  assert.deepEqual([none[4].value, none[4].note], ['—', 'No DR in the imported data']);
});

test('W3/W5 status labels carry a tone, and the other-host badge is only in the table for flagged links', () => {
  assert.deepEqual(bl.STATUS_LABEL.lost, { label: 'Lost', tone: 'bad' });
  assert.equal(bl.STATUS_LABEL.new.label, 'New');
  const ui = src('ui/SeoBacklinks.tsx');
  assert.match(ui, /l\.otherHost && <span[^>]*>Other host/);
});

test('W4 the extras cell shows a count with a tooltip, or a dash', () => {
  assert.deepEqual(bl.extrasView({}), { text: '—', title: '' });
  assert.deepEqual(bl.extrasView({ Title: 'A', Lang: 'en' }), { text: '2 extras', title: 'Title: A\nLang: en' });
  assert.equal(bl.extrasView({ Title: 'A' }).text, '1 extra');
});

test('W6/W21 pairs and rollup cells show dashes for missing numbers', () => {
  assert.equal(bl.pairView(62, 38), '62 / 38');
  assert.equal(bl.pairView(null, null), '— / —');
  assert.equal(bl.pairView(0, null), '0 / —');
});

test('W7/W8 the five views, the periods and which views list links', () => {
  assert.deepEqual(bl.VIEWS.map((v) => v.label), ['All links', 'New in period', 'Lost in period', 'Referring domains', 'Target pages']);
  assert.deepEqual(bl.PERIODS.map((p) => p.days), [7, 28, 90]);
  assert.equal(bl.DEFAULT_PERIOD, 28);
  assert.deepEqual(bl.VIEWS.filter((v) => bl.isListView(v.key)).map((v) => v.key), ['all', 'new', 'lost']);
});

test('W9 the query leaves out empty values, sends the rest, and blocks a DR minimum above the maximum', () => {
  const p = bl.listParams({ ...bl.DEFAULT_CONTROLS, view: 'new', search: ' a&b ', drMin: '10', status: 'lost', domain: 'x.com' }, 50);
  assert.deepEqual([p.get('view'), p.get('search'), p.get('drMin'), p.get('drMax'), p.get('status'), p.get('domain'), p.get('type'), p.get('offset'), p.get('period')], ['new', 'a&b', '10', null, 'lost', 'x.com', null, '50', '28']);
  assert.equal(bl.listParams({ ...bl.DEFAULT_CONTROLS, view: 'domains' }).get('view'), 'all');
  assert.equal(bl.drRangeError('60', '10'), 'The lowest DR cannot be above the highest.');
  assert.equal(bl.drRangeError('abc', ''), 'DR must be a number from 0 to 100.');
  assert.equal(bl.drRangeError('101', ''), 'DR must be a number from 0 to 100.');
  assert.equal(bl.drRangeError('0', '100'), null);
  assert.equal(bl.drRangeError('', ''), null);
});

test('W10 Next needs a usable file and an explicit full-or-partial choice', () => {
  assert.equal(bl.canContinueFromFile(false, null, 'full'), false);
  assert.equal(bl.canContinueFromFile(true, 'bad file', 'full'), false);
  assert.equal(bl.canContinueFromFile(true, null, null), false);
  assert.equal(bl.canContinueFromFile(true, null, 'partial'), true);
});

test('W11/W12 a preset or saved mapping skips the mapping step; a manual mapping must name the source and target and use each column once', () => {
  assert.equal(bl.stepAfterFile({ needsMapping: false }), 'preview');
  assert.equal(bl.stepAfterFile({ needsMapping: true }), 'mapping');
  assert.match(bl.mappingError({ targetUrl: 'b' }), /Source URL needs a column/);
  assert.match(bl.mappingError({ sourceUrl: 'a' }), /Target URL needs a column/);
  assert.match(bl.mappingError({ sourceUrl: 'a', targetUrl: 'a' }), /one field only/);
  assert.equal(bl.mappingError({ sourceUrl: 'a', targetUrl: 'b', anchor: '' }), null);
});

test('W13 the file checks use the daemon\'s wording', () => {
  assert.match(bl.fileError({ name: 'a.xlsx', size: 10 }), /not a CSV or TSV file/);
  assert.match(bl.fileError({ name: 'a.csv', size: 15_000_001 }), /15 MB limit/);
  assert.equal(bl.fileError({ name: 'A.TSV', size: 15_000_000 }), null);
});

test('W14/W15/W16/W17 the confirm label, the problem list, the lost warning and the completion text', () => {
  assert.deepEqual(bl.confirmLabel(40, 3), { text: 'Import 40 valid rows', disabled: false });
  assert.deepEqual(bl.confirmLabel(40, 0), { text: 'Import 40 rows', disabled: false });
  assert.equal(bl.confirmLabel(0, 5).disabled, true);
  assert.deepEqual(bl.problemLines([{ row: 57, message: 'Duplicate of row 12' }], 3), ['Row 57: Duplicate of row 12', 'and 2 more']);
  assert.equal(bl.lostWarning('full', 4), '4 links will be marked lost');
  assert.equal(bl.lostWarning('full', 1), '1 link will be marked lost');
  assert.equal(bl.lostWarning('partial', 4), null);
  assert.equal(bl.lostWarning('full', 0), null);
  const done = bl.completionText({ batch: { fileName: 'a.csv' }, counts: { added: 5, updated: 2, unchanged: 1, lost: 3, returned: 0 }, skipped: 2 });
  assert.equal(done, 'Imported a.csv: 5 added, 2 updated, 1 unchanged, 3 marked lost, 2 problem rows skipped.');
});

test('W18 deleting needs a confirm click; choosing another link starts over', () => {
  assert.deepEqual(bl.nextDeleteState('idle', 'delete'), { state: 'confirming', deleted: false });
  assert.deepEqual(bl.nextDeleteState('confirming', 'confirm'), { state: 'idle', deleted: true });
  assert.deepEqual(bl.nextDeleteState('idle', 'confirm'), { state: 'idle', deleted: false }, 'confirm without a prior delete does nothing');
  assert.deepEqual(bl.nextDeleteState('confirming', 'cancel'), { state: 'idle', deleted: false });
  assert.deepEqual(bl.nextDeleteState('confirming', 'select'), { state: 'idle', deleted: false });
});

test('W19/W20 the tracking-task shortcut is hidden until the Tasks panel exists, and its payload names source, target, anchor and status', () => {
  assert.equal(bl.canCreateTask(false), false);
  assert.equal(bl.canCreateTask(true), true);
  const task = tasks.prefill.backlink(link({ anchor: '', sourceUrl: `https://a.com/${'p'.repeat(400)}` }));
  assert.equal(task.title, 'Follow up on backlink from a.com');
  assert.match(task.notes, /Anchor: \(none\)\nStatus: live$/);
  assert.deepEqual(task.link, { type: 'backlink', ref: 'l1' });
});

async function backlinkBuilding() {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], newBuildingField: null, ...CLEAN_ERROR_STATE });
  assert.equal(await useWorldStore.getState().addProject('', undefined, 'seo', 'https://example.com/'), true);
  const b = useWorldStore.getState().projects.at(-1);
  const state = seoBacklinksState(stub.seo.byProject.get(b.id));
  useSeoBacklinksStore.setState({ listByProject: {}, overviewByProject: {}, domainsByProject: {}, targetsByProject: {}, batchesByProject: {}, mappingsByProject: {} });
  return { b, state };
}
const upload = { fileName: 'links.csv', content: 'YQ==', mode: 'full' };

test('W22 loading fills the list and the summary', async () => {
  const { b, state } = await backlinkBuilding();
  state.links = [link({ sourceDr: 50 }), link({ uid: 'l2', sourceHost: 'b.com' })];
  const store = useSeoBacklinksStore.getState();
  await store.loadList(b.id, bl.DEFAULT_CONTROLS);
  await store.loadOverview(b.id, 28);
  assert.equal(useSeoBacklinksStore.getState().listByProject[b.id].total, 2);
  const summary = useSeoBacklinksStore.getState().overviewByProject[b.id].summary;
  assert.deepEqual([summary.total, summary.withDr, summary.averageDr], [2, 1, 50]);
});

test('W23 a stale list response is ignored', async () => {
  const { b, state } = await backlinkBuilding();
  state.links = [link()];
  let release;
  const held = new Promise((r) => { release = r; });
  state.gate = async (params) => { if (params.get('search') === 'old') await held; };
  const store = useSeoBacklinksStore.getState();
  const older = store.loadList(b.id, { ...bl.DEFAULT_CONTROLS, search: 'old' });
  await store.loadList(b.id, { ...bl.DEFAULT_CONTROLS, search: 'a.com' });
  release();
  await older;
  assert.equal(useSeoBacklinksStore.getState().listByProject[b.id].total, 1);
  assert.equal(state.requests.filter((r) => r.rest === 'backlinks').length, 2);
});

test('W24/W28 preview saves nothing; commit saves and refreshes the list, the summary and the batches', async () => {
  const { b, state } = await backlinkBuilding();
  const store = useSeoBacklinksStore.getState();
  const previewed = await store.previewImport(b.id, upload);
  assert.equal(previewed.ok, true);
  assert.equal(previewed.preview.willBeLost, 1);
  assert.equal(state.links.length, 0);
  const committed = await store.commitImport(b.id, { ...upload, confirm: true }, bl.DEFAULT_CONTROLS);
  assert.equal(committed.ok, true);
  const now = useSeoBacklinksStore.getState();
  assert.equal(now.listByProject[b.id].total, 1);
  assert.equal(now.overviewByProject[b.id].summary.total, 1);
  assert.equal(now.batchesByProject[b.id][0].fileName, 'links.csv');
});

test('W24/W25 a refused commit keeps the message; 400 and 413 from the daemon are surfaced', async () => {
  const { b, state } = await backlinkBuilding();
  const store = useSeoBacklinksStore.getState();
  state.refuseCommit = 'Another import is running';
  const refused = await store.commitImport(b.id, upload, bl.DEFAULT_CONTROLS);
  assert.deepEqual([refused.ok, refused.status, refused.error], [false, 409, 'Another import is running']);
  assert.equal(state.links.length, 0);
  const wrong = await store.previewImport(b.id, { ...upload, fileName: 'a.xlsx' });
  assert.deepEqual([wrong.ok, wrong.status], [false, 400]);
  const big = await store.previewImport(b.id, { ...upload, content: 'x'.repeat(2000) });
  assert.deepEqual([big.ok, big.status, big.error], [false, 413, 'The file is larger than the 15 MB limit.']);
});

test('W26/W27 deleting removes the row and refreshes the summary; notes save and clear', async () => {
  const { b, state } = await backlinkBuilding();
  state.links = [link(), link({ uid: 'l2' })];
  const store = useSeoBacklinksStore.getState();
  await store.loadList(b.id, bl.DEFAULT_CONTROLS);
  assert.equal((await store.saveNote(b.id, 'l1', ' call ')).ok, true);
  assert.equal(useSeoBacklinksStore.getState().listByProject[b.id].links[0].note, 'call');
  await store.saveNote(b.id, 'l1', '');
  assert.equal(useSeoBacklinksStore.getState().listByProject[b.id].links[0].note, '');
  assert.equal((await store.saveNote(b.id, 'nope', 'x')).status, 404);
  assert.equal((await store.deleteLink(b.id, 'l1', bl.DEFAULT_CONTROLS)).ok, true);
  const now = useSeoBacklinksStore.getState();
  assert.deepEqual(now.listByProject[b.id].links.map((l) => l.uid), ['l2']);
  assert.equal(now.overviewByProject[b.id].summary.total, 1);
  assert.equal((await store.deleteLink(b.id, 'l1', bl.DEFAULT_CONTROLS)).status, 404);
});

test('W30 the Backlinks tab is wired into the workspace', () => {
  assert.match(src('ui/SeoWorkspace.tsx'), /tab === 'backlinks' \? <SeoBacklinks project=\{project\} \/>/);
  assert.ok(src('lib/seoWorkspace.ts').includes("{ key: 'backlinks', label: 'Backlinks' }"));
});

test('W31 the tab never turns a missing metric into 0', () => {
  for (const file of ['ui/SeoBacklinks.tsx', 'lib/seoBacklinks.ts']) assert.doesNotMatch(src(file), /\?\? 0\b|\|\| 0\b/, file);
});

test('W32 the wizard previews and commits in separate calls, and commit only runs from the confirm button', () => {
  const ui = src('ui/SeoBacklinkImport.tsx');
  assert.match(ui, /previewImport\(/);
  assert.match(ui, /commitImport\(/);
  assert.equal(ui.match(/commitImport\(/g).length, 1, 'one call site');
  assert.match(ui, /step === 'preview' && <Button[^>]*onClick=\{\(\) => void commit\(\)\}/);
});

test('W33 delete needs the confirm control and Create task is gated by the Tasks panel check', () => {
  const ui = src('ui/SeoBacklinks.tsx');
  assert.match(ui, /Confirm delete/);
  assert.match(ui, /canCreateTask\(HAS_TASKS_PANEL\) &&/);
});

test('W34 the tab uses the same shadcn components as the Keywords tab', () => {
  const keywords = src('ui/SeoKeywords.tsx');
  const ui = src('ui/SeoBacklinks.tsx');
  for (const imp of ["@/components/ui/alert", "@/components/ui/button", "@/components/ui/input"]) { assert.ok(keywords.includes(imp)); assert.ok(ui.includes(imp)); }
});

test('W35 the docs cover Backlinks, the four formats and full vs partial; testing.md has a Backlinks section', () => {
  const doc = repo('docs/seo-building.md');
  for (const word of ['Backlinks', 'Ahrefs', 'Semrush', 'Moz', 'Search Console', 'full export', 'partial update']) assert.ok(doc.includes(word), word);
  assert.match(repo('.docs/testing.md'), /Backlinks/);
});
