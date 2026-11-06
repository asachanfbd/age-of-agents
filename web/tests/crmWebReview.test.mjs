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

const customers = await import('../src/lib/crmCustomers.ts');
const merge = await import('../src/lib/crmMerge.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('C022 (stage choice) a lost prospect can be reopened at a picked stage; a lost customer returns as a customer', () => {
  assert.equal(customers.reopenLabel('lost_prospect'), 'Reopen (stage New)');
  assert.equal(customers.reopenLabel('lost_prospect', 'Engaged'), 'Reopen (stage Engaged)');
  assert.equal(customers.reopenLabel('lost_customer', 'Engaged'), 'Reopen as customer');
  assert.deepEqual([...customers.REOPEN_STAGES], ['New', 'Contacted', 'Engaged', 'Meeting set', 'Proposal']);
  assert.equal(customers.reopenStageParam('lost_prospect', 'New'), undefined);
  assert.equal(customers.reopenStageParam('lost_prospect', 'Proposal'), 'Proposal');
  assert.equal(customers.reopenStageParam('lost_customer', 'Proposal'), undefined);
  for (const file of ['ui/crm/LostTab.tsx', 'ui/crm/ContactPanel.tsx']) assert.match(src(file), /Stage to reopen at/, file);
});

test('C018 (picker) Merge picks contacts by search, not by typed ids, and offers the segment choice for both manual merge and accepted suggestions', () => {
  assert.equal(merge.contactLabel({ id: 7, name: 'Ann', company: 'Fang', channels: [] }), 'Ann (Fang) · #7');
  assert.equal(merge.contactLabel({ id: 8, name: null, company: null, channels: [{ handle: '@tom' }] }), '@tom · #8');
  assert.equal(merge.contactLabel({ id: 9, name: null, company: null, channels: [] }), 'No name · #9');
  const ui = src('ui/crm/MergeTab.tsx');
  assert.match(ui, /<ContactPicker/);
  assert.ok(!/First contact id/.test(ui));
  assert.match(ui, /Keep segment when accepting/);
  assert.match(ui, /Keep segment of/);
});

test('the calendar and the Expand Today series refresh through the explicit tick, never through a read', () => {
  assert.match(src('lib/crmApi.ts'), /tick: \(id: string\)[^\n]*\/tick`, json\('POST'/);
  assert.match(src('ui/crm/CalendarTab.tsx'), /if \(!readOnly\) await crmApi\.tick/);
  assert.match(src('ui/crm/ExpandToday.tsx'), /if \(!readOnly\) await crmApi\.tick/);
});
