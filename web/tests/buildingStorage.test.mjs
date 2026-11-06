import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
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

const storage = await import('../src/lib/buildingStorage.ts');
const config = await import('../src/lib/typeConfig.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('C7 every list request carries a limit and there is no way to ask for all rows', () => {
  assert.equal(storage.dataQueryString({}), 'limit=50');
  assert.equal(new URLSearchParams(storage.dataQueryString({ limit: 100000 })).get('limit'), '200');
  assert.equal(new URLSearchParams(storage.dataQueryString({ limit: 0 })).get('limit'), '1');
  assert.equal(new URLSearchParams(storage.dataQueryString({ limit: Number.NaN })).get('limit'), '50');
  for (const file of ['ui/NotesWorkspace.tsx', 'ui/project-popup/StorageSettings.tsx']) {
    assert.ok(!/limit=(all|0|-1)|limit:\s*(Infinity|0)/.test(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').toString()), file);
  }
});

test('C8 search, sort, filter and page changes build the right query', () => {
  const q = new URLSearchParams(storage.dataQueryString({ sort: 'clicks', dir: 'desc', search: '  seo ', filters: [{ col: 'page', op: 'eq', value: '/a:b' }, { col: 'day', op: 'gte', value: '' }], cursor: 'abc', limit: 25 }));
  assert.deepEqual([q.get('sort'), q.get('dir'), q.get('search'), q.get('cursor'), q.get('limit')], ['clicks', 'desc', 'seo', 'abc', '25']);
  assert.deepEqual(q.getAll('filter'), ['page:eq:/a:b']);
});

test('U71 the pager reports page, rows shown, and next/previous at the first page, last page and an empty set', () => {
  const first = { history: [], nextCursor: 'c1' };
  assert.deepEqual(storage.pagerInfo(first, 50), { page: 1, canPrev: false, canNext: true, label: 'Rows 1 to 50' });
  const second = storage.nextPager(first, null, 'c2');
  assert.deepEqual(storage.pagerInfo(second, 50), { page: 2, canPrev: true, canNext: true, label: 'Rows 51 to 100' });
  const last = storage.nextPager(second, 'c1', null);
  assert.deepEqual(storage.pagerInfo(last, 7), { page: 3, canPrev: true, canNext: false, label: 'Rows 101 to 107' });
  assert.deepEqual(storage.pagerInfo({ history: [], nextCursor: null }, 0), { page: 1, canPrev: false, canNext: false, label: 'No rows' });
  const back = storage.prevPager(last);
  assert.equal(back.cursor, 'c1');
  assert.deepEqual(back.pager.history, [null]);
  assert.equal(storage.prevPager(first).cursor, null);
});

test('U46 sizes read in B, KB, MB and GB, and a typed size parses back', () => {
  assert.equal(storage.formatBytes(0), '0 B');
  assert.equal(storage.formatBytes(512), '512 B');
  assert.equal(storage.formatBytes(1536), '1.5 KB');
  assert.equal(storage.formatBytes(5 * 1024 ** 2), '5.0 MB');
  assert.equal(storage.formatBytes(2 * 1024 ** 3), '2.0 GB');
  assert.equal(storage.formatBytes(-5), '0 B');
  assert.equal(storage.parseSize('2 GB'), 2 * 1024 ** 3);
  assert.equal(storage.parseSize('1.5gb'), Math.floor(1.5 * 1024 ** 3));
  assert.equal(storage.parseSize('500'), 500);
  for (const bad of ['', 'big', '-3 MB', '0 MB', '2 XB']) assert.equal(storage.parseSize(bad), null, bad);
});

test('C9 the storage section shows size against the threshold, the retention rule, the last backup, and run-now state', () => {
  const status = { bytes: 3 * 1024 ** 3, warningBytes: 2 * 1024 ** 3, level: 'warning', retention: { rule: { table: 'metrics', months: 12, mode: 'discard' }, description: 'Rows older than 12 months are discarded.' }, lastBackup: { file: '/x', at: '2026-02-03T10:00:00Z', reason: 'migration' }, readOnlyReason: null, ingestionStoppedReason: null, secrets: [] };
  const view = storage.storageSummary(status, false);
  assert.deepEqual([view.size, view.threshold, view.percent, view.warning, view.canRunRetention], ['3.0 GB', '2.0 GB', 100, true, true]);
  assert.equal(view.backupText, 'Before a migration on 2026-02-03');
  assert.equal(view.retentionText, 'Rows older than 12 months are discarded.');
  assert.equal(storage.storageSummary(status, true).canRunRetention, false, 'run now is disabled while it runs');
  assert.equal(storage.storageSummary({ ...status, lastBackup: null }, false).backupText, 'No backup yet');
  assert.equal(storage.storageSummary({ ...status, retention: { rule: null, description: 'none' } }, false).canRunRetention, false);
  const failed = storage.storageSummary({ ...status, readOnlyReason: 'Migration to version 2 failed' }, false);
  assert.deepEqual([failed.banner, failed.canRunRetention], ['Migration to version 2 failed', false]);
  assert.match(storage.storageSummary({ ...status, ingestionStoppedReason: 'the disk is full' }, false).banner, /disk is full/);
});

test('ingest and retention jobs show progress, cancel only while running, and say how they ended', () => {
  const job = (patch) => ({ id: 'j', kind: 'ingest', status: 'running', done: 0, total: 0, ...patch });
  assert.deepEqual(storage.jobSummary(job({ done: 2500, total: 10000 })), { percent: 25, label: '25% (2,500 of 10,000 rows)', running: true, canCancel: true });
  assert.equal(storage.jobSummary(job({})).percent, 0);
  assert.equal(storage.jobSummary(job({ done: 10, total: 10, phase: 'indexing' })).label, 'All rows added. Building indexes…');
  assert.deepEqual(storage.jobSummary(job({ status: 'done', done: 10, total: 10 })), { percent: 100, label: 'Finished', running: false, canCancel: false });
  assert.match(storage.jobSummary(job({ status: 'cancelled', done: 5000, total: 10000 })).label, /Cancelled after 5,000 rows/);
  assert.match(storage.jobSummary(job({ status: 'failed', error: 'disk full' })).label, /Failed: disk full/);
});

test('C10 an invalid threshold is rejected before any request', () => {
  assert.deepEqual(storage.checkThreshold('1 GB'), { bytes: 1024 ** 3 });
  assert.match(storage.checkThreshold('lots').error, /Enter a size/);
  assert.match(storage.checkThreshold('0').error, /Enter a size/);
});

test('the API client sends the threshold, lists data with a limit, and the stub mirrors the daemon', async () => {
  const stub = installServerStub();
  stub.buildings.rows.set('b1', Array.from({ length: 120 }, (_, i) => ({ id: i + 1 })));
  const first = await serverApi.listBuildingData('b1', 'metrics', {});
  assert.equal(first.rows.length, 50);
  assert.ok(first.nextCursor);
  const second = await serverApi.listBuildingData('b1', 'metrics', { cursor: first.nextCursor, limit: 500 });
  assert.equal(second.rows.length, 70);
  assert.equal(second.nextCursor, null);
  assert.ok(stub.buildings.dataRequests.every((r) => /limit=\d+/.test(r)), 'no request went out without a limit');
  const status = await serverApi.setStorageThreshold('b1', 10000);
  assert.deepEqual([status.warningBytes, status.level], [10000, 'ok']);
  await assert.rejects(serverApi.setStorageThreshold('b1', -1), /positive/);
});

test('C19 a saved credential is sent once and never read back into the store or the UI state', () => {
  assert.ok(!/useWorldStore|set\(\{[^}]*secret/i.test(src('lib/buildingStorage.ts')));
  const settings = src('ui/project-popup/StorageSettings.tsx');
  assert.match(settings, /hasSecret/);
  assert.match(settings, /type="password"/);
});

const slot = (patch = {}) => ({
  slot: { id: 'feature', label: 'Build a feature', usedWhen: 'x', defaultWorkflowId: 'software-development' },
  configuredWorkflowId: null, effectiveWorkflowId: 'software-development', fellBack: null, customised: false,
  workflow: { id: 'software-development', name: 'Software Development', description: 'd' },
  steps: [{ id: 'dev', name: 'Development', defaultAgentId: 'engineer', configuredAgentId: null, effectiveAgentId: 'engineer', agentFellBack: false }, { id: 'docs', name: 'Docs', defaultAgentId: 'docs-agent', configuredAgentId: null, effectiveAgentId: 'docs-agent', agentFellBack: false }],
  ...patch,
});

test('U69/C11 a slot card shows Default or Customised, and "set all steps" skips steps already on their own agent', () => {
  assert.equal(config.slotBadge(slot()), 'Default');
  assert.equal(config.slotBadge(slot({ customised: true })), 'Customised');
  assert.deepEqual(config.allStepsTo(slot(), 'reviewer'), { dev: 'reviewer', docs: 'reviewer' });
  assert.deepEqual(config.allStepsTo(slot(), 'engineer'), { dev: null, docs: 'engineer' }, 'a step already on its default is reset instead of customised');
  assert.deepEqual(config.allStepsTo(slot(), null), { dev: null, docs: null });
});

test('U70/C14 a deleted workflow or agent shows a notice naming the fallback', () => {
  const fell = slot({ fellBack: { configuredId: 'old-flow', defaultId: 'software-development' } });
  assert.match(config.fallbackNotice(fell, () => 'Software Development'), /old-flow.*no longer in the Catalog.*Software Development is used/);
  assert.equal(config.fallbackNotice(slot(), () => 'x'), null);
  assert.match(config.stepAgentNotice({ ...slot().steps[0], agentFellBack: true }), /no longer in the Catalog.*engineer runs it/);
  assert.equal(config.stepAgentNotice(slot().steps[0]), null);
});

test('C12/C13/C15 edits track dirtiness, only changed slots are saved, a workflow change warns first and clears step agents, and reset clears edits', () => {
  assert.equal(config.isDirty({}), false);
  let edits = config.editStepAgent({}, 'feature', 'dev', 'reviewer');
  assert.equal(config.isDirty(edits), true);
  assert.deepEqual(config.changedSlots({ ...edits, bug: {} }), [['feature', { stepAgents: { dev: 'reviewer' } }]]);
  edits = config.editWorkflow(edits, 'feature', 'alt-flow');
  assert.deepEqual(edits.feature, { workflowId: 'alt-flow', stepAgents: {} });
  const customised = slot({ customised: true, steps: [{ ...slot().steps[0], configuredAgentId: 'reviewer' }] });
  assert.match(config.workflowChangeWarning(customised, 'alt-flow'), /clears the agents you chose/);
  assert.equal(config.workflowChangeWarning(slot(), 'alt-flow'), null, 'nothing to lose, no warning');
  assert.equal(config.workflowChangeWarning(customised, 'software-development'), null, 'same workflow, no warning');
  assert.equal(config.isDirty(config.editWorkflow({}, 'feature', null)), true, 'choosing the default again is still a change to save');
  assert.match(config.APPLIES_TO_NEW_RUNS, /new runs.*already in progress keep/);
});

test('C16 the write controls check read-only before acting', () => {
  assert.match(src('ui/ProjectWorkspaceModal.tsx'), /isBuildingReadOnly|readOnlyNotice/);
  assert.match(src('ui/NotesWorkspace.tsx'), /readOnly/);
});

test('review #8 Run now asks first, naming the table, the cutoff date and that it cannot be undone; the secrets text no longer promises a declaration', () => {
  assert.equal(storage.retentionCutoffDate(12, new Date('2026-03-15T10:00:00Z')), '2025-03-15');
  assert.equal(storage.retentionCutoffDate(1, new Date('2026-01-31T00:00:00Z')), '2025-12-31');
  const text = storage.retentionConfirmText({ table: 'metrics', months: 12, mode: 'discard' }, new Date('2026-03-15T00:00:00Z'));
  assert.match(text, /"metrics" dated before 2025-03-15\? This cannot be undone\. Roll-up totals are reduced/);
  assert.match(storage.retentionConfirmText({ table: 'metrics', months: 12, mode: 'rollup' }, new Date()), /keep covering/);
  const settings = src('ui/project-popup/StorageSettings.tsx');
  assert.match(settings, /setConfirmingRetention\(true\)/, 'Run now only opens the confirmation');
  assert.ok(!/declares no secrets/.test(settings));
});

test('review #8 a read-only Building\'s Tasks board and Software panels sit in a disabled fieldset', () => {
  const modal = src('ui/ProjectWorkspaceModal.tsx');
  const body = src('ui/WorkspaceBody.tsx');
  assert.match(body, /<fieldset disabled=\{isBuildingReadOnly\(project\)\}/);
  assert.equal((modal.match(/<WorkspaceBody /g) ?? []).length, 2, 'the Software panels and the Notes panels both go through the one body');
  assert.doesNotMatch(modal, /<fieldset|<ReadOnlyFieldset/);
});
