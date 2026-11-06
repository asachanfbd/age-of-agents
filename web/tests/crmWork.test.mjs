import assert from 'node:assert/strict';
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

const work = await import('../src/lib/crmWork.ts');

const T = Date.UTC(2026, 9, 22, 9, 5);
const entry = (o = {}) => ({ id: 1, at: T, phase: 'finished', taskTitle: 'Fix login', summary: 'We fixed the login page.', rewritten: true, backfilled: false, ...o });
const building = (o = {}) => ({ buildingId: 'b1', attachedAt: 1, peek: { state: 'ok', name: 'App', typeId: 'software', status: 'idle', summary: null }, workLog: [], workLogTotal: 0, ...o });
const customer = (b) => ({ id: 1, name: 'Ann Lee', company: 'Acme', title: 'CEO', tags: [], custom: {}, segment: 'customer', stage: null, customerAt: T, createdAt: 1, dnc: false, channels: [], buildings: b });
const row = (b, o = {}) => render('src/ui/crm/CustomersTab.tsx', 'AttachedRow', { projectId: 'p', customer: customer(b), disabled: false, readOnly: false, onChanged() {}, onError() {}, ...o });

test('WU01 the heading reads Started or Finished with the task', () => {
  assert.equal(work.workHeading('started', 'Fix login'), 'Started: Fix login');
  assert.equal(work.workHeading('finished', 'Fix login'), 'Finished: Fix login');
});

test('WU02 a finished row shows its summary and a started row none', () => {
  const rows = work.workLogRows(building({ workLog: [entry({ id: 2 }), entry({ id: 1, phase: 'started', summary: 'ignored' })] }));
  assert.deepEqual(rows.map((r) => r.summary), ['We fixed the login page.', '']);
});

test('WU03 badges: not rewritten, backfilled, both, neither', () => {
  assert.deepEqual(work.workBadges(entry({ rewritten: false })), ['Not rewritten']);
  assert.deepEqual(work.workBadges(entry({ backfilled: true })), ['Backfilled']);
  assert.deepEqual(work.workBadges(entry({ rewritten: false, backfilled: true })), ['Not rewritten', 'Backfilled']);
  assert.deepEqual(work.workBadges(entry()), []);
  assert.deepEqual(work.workBadges(entry({ phase: 'started', rewritten: false })), []);
});

test('WU04 the label uses the total, not the rows kept', () => {
  assert.equal(work.workLogLabel({ workLog: Array.from({ length: 50 }, (_, i) => entry({ id: i })), workLogTotal: 60 }), 'Work log (60)');
});

test('WU05 rows are newest first even if the server order differs; equal times go by id descending', () => {
  const rows = work.workLogRows(building({ workLog: [entry({ id: 1, at: 10 }), entry({ id: 3, at: 20 }), entry({ id: 2, at: 20 })] }));
  assert.deepEqual(rows.map((r) => r.id), [3, 2, 1]);
});

test('WU06 dates format at the extremes and never read Invalid Date', () => {
  assert.match(work.workWhen(0), /1970/);
  assert.match(work.workWhen(8.64e15), /275760/);
  for (const bad of [Number.NaN, Infinity, 8.64e15 + 1]) assert.equal(work.workWhen(bad), 'No date');
  assert.equal(work.workWhen(T, 'UTC'), 'Oct 22, 2026, 9:05 AM');
});

test('WU07 a Building without workLog or total acts as empty, null the same as omitted', () => {
  for (const b of [{}, { workLog: null, workLogTotal: null }]) {
    assert.equal(work.workLogLabel(b), 'Work log (0)');
    assert.deepEqual(work.workLogRows(b), []);
  }
});

test('WU08 the empty state text', () => assert.equal(work.WORK_LOG_EMPTY, 'No work updates yet. Updates appear here when tasks on this Building start or finish.'));

test('WU09 a missing task title or summary shows the generic label and never "undefined"', () => {
  const [r] = work.workLogRows(building({ workLog: [{ id: 1, at: T, phase: 'finished' }] }));
  assert.equal(r.heading, 'Finished: Untitled task');
  assert.doesNotMatch(JSON.stringify(r), /undefined/);
  assert.equal(work.workTimelineView({ data: { phase: 'finished' } }).heading, 'Finished: Untitled task');
});

test('C01 each attached Building row shows a Work log button with aria-expanded', async () => {
  const html = await row([building({ workLogTotal: 3 })]);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>Work log \(3\)<\/button>/);
});

test('C02 an expanded log lists entries newest first with date, task and summary', async () => {
  const html = await render('src/ui/crm/WorkLog.tsx', 'WorkLog', { initiallyOpen: true, timeZone: 'UTC', building: building({ workLog: [entry({ id: 1, at: T - 1000, phase: 'started', taskTitle: 'Old' }), entry({ id: 2 })], workLogTotal: 2 }) });
  assert.ok(html.indexOf('Finished: Fix login') < html.indexOf('Started: Old'));
  assert.match(html, /We fixed the login page\./); assert.match(html, /Oct 22, 2026, 9:05 AM/); assert.match(html, /aria-expanded="true"/);
});

test('C03 an empty log shows the empty state', async () => {
  assert.match(await render('src/ui/crm/WorkLog.tsx', 'WorkLog', { initiallyOpen: true, building: building() }), /No work updates yet/);
});

test('C04 an unavailable Building row still has its Work log, Detach and its earlier entries', async () => {
  const html = await row([building({ peek: { state: 'unavailable' }, workLogTotal: 1, workLog: [entry()] })]);
  assert.match(html, /Unavailable/); assert.match(html, /Work log \(1\)/); assert.match(html, />Detach</);
});

test('C05 a read-only CRM Building disables Attach and Detach but not the Work log toggle', async () => {
  const html = await row([building()], { disabled: true, readOnly: true });
  assert.match(html, /<button[^>]*disabled[^>]*>Detach<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Work log/);
});

test('C06 C07 a timeline Building-work entry shows the heading, Building, summary and badges', async () => {
  const html = await render('src/ui/crm/WorkLog.tsx', 'WorkEntryBody', { entry: { id: 1, kind: 'building_work', at: T, text: '', deleted: false, data: { phase: 'finished', taskTitle: 'Fix login', buildingName: 'App', summary: 'Fixed.', rewritten: false, backfilled: true } } });
  for (const text of ['Finished: Fix login', 'App', 'Fixed.', 'Not rewritten', 'Backfilled']) assert.match(html, new RegExp(text));
});

test('C10 the attach hint says finished updates from the last 30 days are added', async () => {
  assert.match(await row([]), /finished updates for tasks completed in the last 30 days/);
});

test('C11 long text wraps', async () => {
  const html = await render('src/ui/crm/WorkLog.tsx', 'WorkLog', { initiallyOpen: true, building: building({ workLog: [entry({ taskTitle: 'x'.repeat(300) })], workLogTotal: 1 }) });
  assert.match(html, /break-words/);
});

test('C08 C09 C12 only comments have a menu, no filter chip exists, other kinds keep their wording', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/ui/crm/ContactPanel.tsx', import.meta.url), 'utf8');
  assert.match(src, /e\.kind === 'comment' && !e\.deleted \? \(/);
  assert.match(src, /e\.kind === 'building_work' \? 'Building work' : e\.kind\.replace/);
  assert.doesNotMatch(src, /Building work<\/|All \/ Building work/);
});
