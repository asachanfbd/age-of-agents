import assert from 'node:assert/strict';
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

const { nextSort, sortIndicator, aggregateTotals, ingestLabel } = await import('../src/lib/notesWorkspace.ts');

test('nextSort ignores columns that are not sortable', () => {
  const current = { column: 'day', dir: 'asc' };
  assert.equal(nextSort(current, 'query', ['day', 'clicks']), current);
  assert.equal(nextSort(null, 'query', ['day']), null);
});

test('nextSort starts ascending then flips on the same column', () => {
  assert.deepEqual(nextSort(null, 'day', ['day']), { column: 'day', dir: 'asc' });
  assert.deepEqual(nextSort({ column: 'day', dir: 'asc' }, 'day', ['day']), { column: 'day', dir: 'desc' });
  assert.deepEqual(nextSort({ column: 'day', dir: 'desc' }, 'day', ['day']), { column: 'day', dir: 'asc' });
  assert.deepEqual(nextSort({ column: 'day', dir: 'desc' }, 'clicks', ['day', 'clicks']), { column: 'clicks', dir: 'asc' });
});

test('sortIndicator names the active direction only', () => {
  assert.equal(sortIndicator({ column: 'day', dir: 'asc' }, 'day'), 'ascending');
  assert.equal(sortIndicator({ column: 'day', dir: 'desc' }, 'day'), 'descending');
  assert.equal(sortIndicator({ column: 'day', dir: 'desc' }, 'page'), '');
  assert.equal(sortIndicator(null, 'day'), '');
});

test('aggregateTotals sums clicks and impressions and tolerates junk', () => {
  assert.deepEqual(aggregateTotals([]), { clicks: 0, impressions: 0, rows: 0 });
  assert.deepEqual(aggregateTotals([{ clicks: 2, impressions: 10 }, { clicks: '3', impressions: 'x' }]), { clicks: 5, impressions: 10, rows: 2 });
});

test('ingestLabel groups digits', () => {
  assert.equal(ingestLabel(1000000), `Add ${(1000000).toLocaleString()} rows`);
});

const { SETTINGS_SECTIONS, settingsSectionsFor, effectiveSection } = await import('../src/lib/settingsSections.ts');

test('settingsSectionsFor offers repository sections to repository types and Storage to storage types', () => {
  assert.deepEqual(settingsSectionsFor(undefined), ['general', 'workflow', 'git', 'commands']);
  assert.deepEqual(settingsSectionsFor({ repository: true, hasStorage: false }), ['general', 'workflow', 'git', 'commands', 'schedules', 'connections', 'activity']);
  assert.deepEqual(settingsSectionsFor({ repository: false, hasStorage: true }), ['general', 'schedules', 'connections', 'activity', 'storage']);
  assert.deepEqual(settingsSectionsFor({ repository: false, hasStorage: false }), ['general', 'schedules', 'connections', 'activity']);
  assert.deepEqual(settingsSectionsFor({ repository: true, hasStorage: true }), ['general', 'workflow', 'git', 'commands', 'schedules', 'connections', 'activity', 'storage']);
});

test('General is offered first for every type and is the fallback section', () => {
  assert.equal(SETTINGS_SECTIONS[0], 'general');
  for (const type of [undefined, { repository: true, hasStorage: false }, { repository: false, hasStorage: false }, { repository: false, hasStorage: true }]) {
    assert.equal(settingsSectionsFor(type)[0], 'general');
    assert.equal(effectiveSection('general', settingsSectionsFor(type)), 'general');
    assert.equal(effectiveSection('storage', ['general']), 'general');
  }
});

test('effectiveSection falls back to the first offered section', () => {
  assert.equal(effectiveSection('git', ['storage']), 'storage');
  assert.equal(effectiveSection('activity', ['schedules', 'activity']), 'activity');
  assert.equal(effectiveSection('storage', ['workflow', 'storage']), 'storage');
  assert.equal(effectiveSection('git', []), null);
});
