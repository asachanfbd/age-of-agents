// Runs in India so the host zone differs from UTC; node --test gives each file its own process.
process.env.TZ = 'Asia/Kolkata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
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

const outreach = await import('../src/lib/crmOutreach.ts');
const prospects = await import('../src/lib/crmProspects.ts');
const work = await import('../src/lib/crmWork.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const KOLKATA = 'Asia/Kolkata';

test('L01 the response default is local wall time and round-trips through the datetime-local input', () => {
  const at = Date.parse('2026-10-27T12:00:00+05:30');
  const value = outreach.localDateTimeInputValue(at);
  assert.equal(value, '2026-10-27T12:00');
  assert.equal(new Date(value).getTime(), at);
});

test('L02 just after local midnight the default keeps the local day, not the UTC one', () => {
  assert.equal(outreach.localDateTimeInputValue(Date.parse('2026-10-26T00:30:00+05:30')), '2026-10-26T00:30');
  assert.equal(outreach.localDateTimeInputValue(Date.parse('2026-01-05T09:07:00+05:30')), '2026-01-05T09:07');
});

test('L03 the Response form builds its default from local date parts', () => {
  const form = src('ui/crm/ResponseForm.tsx');
  assert.match(form, /const inOneDay = \(\) => localDateTimeInputValue\(Date\.now\(\) \+ 86_400_000\);/);
  assert.doesNotMatch(form, /toISOString\(\)\.slice/);
});

test('L04 plannedDueAt reads the due time of planned entries only', () => {
  assert.equal(prospects.plannedDueAt({ kind: 'followup_planned', data: { dueAt: 5 } }), 5);
  assert.equal(prospects.plannedDueAt({ kind: 'reachout_planned', data: { dueAt: 7 } }), 7);
  assert.equal(prospects.plannedDueAt({ kind: 'followup_planned', data: {} }), null);
  assert.equal(prospects.plannedDueAt({ kind: 'followup_planned', data: { dueAt: '2026-10-27T09:30:00Z' } }), null);
  assert.equal(prospects.plannedDueAt({ kind: 'followup_planned', data: { dueAt: Number.NaN } }), null);
  assert.equal(prospects.plannedDueAt({ kind: 'comment', data: { dueAt: 5 } }), null);
});

test('L05 a planned timeline entry reads "planned for" with its due time in the Building zone and no ISO', async () => {
  const entry = { id: 1, contactId: 1, kind: 'followup_planned', at: 1, text: 'Call Ann planned', data: { dueAt: Date.parse('2026-10-27T09:30:00Z') }, deleted: false, editedAt: null };
  const html = await render('src/ui/crm/ContactPanel.tsx', 'TimelineText', { entry, timeZone: KOLKATA });
  assert.match(html, /^Call Ann planned for <time [^>]*title="Tue 27 Oct, 15:00"/);
  assert.doesNotMatch(html.replace(/dateTime="[^"]*"/, ''), /\d{4}-\d{2}-\d{2}T/);
  const plain = await render('src/ui/crm/ContactPanel.tsx', 'TimelineText', { entry: { ...entry, kind: 'stage_changed', text: 'Moved to Engaged' }, timeZone: KOLKATA });
  assert.equal(plain, 'Moved to Engaged');
});

test('L06 Customer since shows the Building-zone day at a day boundary', async () => {
  const customer = { id: 1, name: 'Ann Lee', company: 'Acme', title: 'CEO', tags: [], custom: {}, segment: 'customer', stage: null, customerAt: Date.parse('2026-10-22T00:30:00+05:30'), createdAt: 1, dnc: false, channels: [], buildings: [] };
  const props = { customer, projectId: 'p', disabled: false, readOnly: false, starred: false, onStar() {}, onOpen() {}, onChanged() {}, onError() {} };
  assert.match(await render('src/ui/crm/CustomersTab.tsx', 'PersonCard', { ...props, timeZone: KOLKATA }), /title="Thu 22 Oct, 00:30"/);
  assert.match(await render('src/ui/crm/CustomersTab.tsx', 'PersonCard', { ...props, customerAt: null, customer: { ...customer, customerAt: null, createdAt: Number.NaN } }), /No date/);
  assert.doesNotMatch(src('lib/crmCustomers.ts'), /timeZone: 'UTC'|sinceText/);
});

test('L07 the resurface date shows the Building-zone day at a day boundary', async () => {
  const resurfaceAt = Date.parse('2026-04-15T00:30:00+05:30');
  const [status] = prospects.rowStatuses({ id: 1, dnc: false, noResponse: true, resurfaceAt, channels: [] });
  assert.deepEqual(status, { kind: 'no_response', label: 'No response', resurfaceAt });
  const html = await render('src/ui/crm/shared.tsx', 'StatusText', { status, timeZone: KOLKATA });
  assert.match(html, /^No response · resurfaces <time [^>]*title="Wed 15 Apr, 00:30"/);
  assert.equal(await render('src/ui/crm/shared.tsx', 'StatusText', { status: { kind: 'dnc', label: 'Do not contact' } }), 'Do not contact');
  assert.doesNotMatch(src('lib/crmProspects.ts'), /toISOString\(\)\.slice/);
});

test('L08 work log times fall back to the browser zone, not UTC, and still honour an explicit zone', () => {
  const T = Date.UTC(2026, 9, 22, 9, 5);
  assert.equal(work.workWhen(T), 'Oct 22, 2026, 2:35 PM');
  assert.equal(work.workWhen(T, 'UTC'), 'Oct 22, 2026, 9:05 AM');
  const [row] = work.workLogRows({ workLog: [{ id: 1, at: T, phase: 'finished' }] });
  assert.equal(row.when, 'Oct 22, 2026, 2:35 PM');
  for (const file of ['ui/crm/CustomersTab.tsx', 'ui/crm/CalendarTab.tsx', 'ui/crm/WorkLog.tsx', 'lib/crmWork.ts']) assert.doesNotMatch(src(file), /'UTC'/, file);
});
