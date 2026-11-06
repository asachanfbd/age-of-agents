import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { CSV_MAX_BYTES, CSV_MAX_ROWS, IMPORT_LAG_BUDGET_MS } from '../src/crm/limits.ts';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';

let t: CrmApi;
let id: string;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });
beforeEach(async () => { t.reset(); id = await t.createCrm(); });

const b64 = (csv: string) => Buffer.from(csv).toString('base64');
const mapping = (csv = 'email,name', extra: Record<string, unknown> = {}) => ({ channels: [{ column: 'email', type: 'email' }], ...(csv.split('\n', 1)[0]!.split(',').includes('name') ? { name: 'name' } : {}), ...extra });
const csvBody = (csv: string, extra: Record<string, unknown> = {}) => ({ fileName: 'leads.csv', contentBase64: b64(csv), mapping: mapping(csv), ...extra });
const preview = (csv: string, extra?: Record<string, unknown>) => t.send('POST', t.crm(id, '/import/csv/preview'), csvBody(csv, extra));
const commit = (csv: string, extra?: Record<string, unknown>) => t.send('POST', t.crm(id, '/import/csv/commit'), csvBody(csv, extra));
const counts = async () => {
  const { crmCtx } = await import('../src/crm/runtime.ts');
  const db = (await crmCtx((await t.projectsDb.get(id))!)).db;
  const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { contacts: n('contacts'), channels: n('channels'), batches: n('batches'), timeline: n('timeline') };
};

test('I022 a CSV preview saves nothing: contact, channel, batch and timeline counts are identical before and after', async () => {
  await commit('email,name\nseed@x.com,Seed\n');
  const before = await counts();
  const res = await preview('email,name\na@x.com,A\nb@x.com,B\nseed@x.com,Seed\n');
  assert.deepEqual([res.status, res.body.added, res.body.existing, res.body.committed, res.body.batchId], [200, 2, 1, false, null]);
  assert.deepEqual(await counts(), before);
});

test('I023 commit re-sends the file and recomputes; preview and commit counts agree with no token', async () => {
  const csv = 'email,name\na@x.com,A\nb@x.com,B\na@x.com,A again\nbad,Bad\n';
  const p = (await preview(csv)).body;
  const c = (await commit(csv)).body;
  for (const k of ['added', 'existing', 'duplicatesInFile', 'rejected']) assert.equal(c[k], p[k], k);
  assert.deepEqual([c.added, c.duplicatesInFile, c.rejected, c.committed], [2, 1, 1, true]);
  assert.equal((await t.send('POST', t.crm(id, '/import/csv/commit'), { ...csvBody(csv), contentBase64: undefined })).status, 400);
});

test('I024 added, already existing, duplicates in the file and rejected rows add up to the data rows', async () => {
  await commit('email,name\nold@x.com,Old\n');
  const csv = 'email,name\nold@x.com,Old\nnew@x.com,New\nnew@x.com,Dup\nnope,Bad\n,Empty\n';
  const r = (await commit(csv)).body;
  assert.equal(r.added + r.existing + r.duplicatesInFile + r.rejected, 5);
  assert.deepEqual([r.added, r.existing, r.duplicatesInFile, r.rejected], [1, 1, 1, 2]);
  assert.deepEqual(r.rejectedRows.map((x: { line: number; reason: string }) => [x.line, x.reason]), [[5, 'Invalid email: nope'], [6, 'No handle']]);
});

test('I025 existing handles are not overwritten; the new batch\'s tags and source go on the existing contact\'s timeline', async () => {
  const first = (await commit('email,name\na@x.com,Original\n')).body;
  const second = (await commit('email,name\na@x.com,Changed\n', { batchName: 'Spring list', tags: ['spring'] })).body;
  assert.deepEqual([second.added, second.existing], [0, 1]);
  const c = (await t.api(t.crm(id, '/contacts'))).body.rows[0];
  assert.deepEqual([c.name, c.tags, c.batchId], ['Original', [], first.batchId]);
  const entry = (await t.api(t.crm(id, `/contacts/${c.id}/timeline`))).body.rows[0];
  assert.deepEqual([entry.kind, entry.data.tags, entry.data.source], ['imported_again', ['spring'], 'import: Spring list']);
});

test('I026 a handle on a lost contact is reported as existing and Reopen is offered with the contact id', async () => {
  const c = (await commit('email,name\na@x.com,A\n')).body;
  const contact = (await t.api(t.crm(id, '/contacts'))).body.rows[0];
  await t.send('POST', t.crm(id, `/contacts/${contact.id}/lost`), { reason: 'Other' });
  const r = (await commit('email,name\nx@y.com,X\na@x.com,A\n')).body;
  assert.deepEqual([r.added, r.existing, r.reopenOffers], [1, 1, [{ contactId: contact.id, line: 3 }]]);
  assert.ok(c.batchId);
});

test('I027 one row with an email and a phone makes one contact with two channels; a row matching two existing contacts reports existing and merges nothing', async () => {
  const m = { channels: [{ column: 'email', type: 'email' }, { column: 'phone', type: 'phone' }], name: 'name' };
  const r = (await t.send('POST', t.crm(id, '/import/csv/commit'), { fileName: 'f.csv', contentBase64: b64('email,phone,name\na@x.com,+49 151 111,A\nb@x.com,+49 151 222,B\n'), mapping: m })).body;
  assert.equal(r.added, 2);
  const rows = (await t.api(t.crm(id, '/contacts'))).body.rows;
  assert.deepEqual(rows.map((x: { channels: unknown[] }) => x.channels.length), [2, 2]);
  const both = (await t.send('POST', t.crm(id, '/import/csv/commit'), { fileName: 'g.csv', contentBase64: b64('email,phone,name\na@x.com,+49 151 222,Mix\n'), mapping: m })).body;
  assert.deepEqual([both.added, both.existing], [0, 1]);
  assert.equal((await t.api(t.crm(id, '/contacts'))).body.total, 2);
});

test('I028 the same handle in rows 3 and 9 makes row 9 a duplicate in the file; a row with one duplicate and one new handle adds the channel to the first contact', async () => {
  const m = { channels: [{ column: 'email', type: 'email' }, { column: 'phone', type: 'phone' }], name: 'name' };
  const lines = ['email,phone,name', 'a@x.com,,A', 'b@x.com,,B', ...Array.from({ length: 5 }, (_, i) => `f${i}@x.com,,F${i}`), 'a@x.com,+49 151 999,A2'];
  const r = (await t.send('POST', t.crm(id, '/import/csv/commit'), { fileName: 'f.csv', contentBase64: b64(lines.join('\n')), mapping: m })).body;
  assert.deepEqual([r.added, r.duplicatesInFile], [7, 1]);
  const a = (await t.api(t.crm(id, '/contacts?search=a@x.com'))).body.rows[0];
  assert.deepEqual(a.channels.map((c: { type: string }) => c.type), ['email', 'phone']);
  const same = (await commit('email,name\nz@x.com,Z\nq@x.com,Q\nq@x.com,Q2\n')).body;
  assert.equal(same.duplicatesInFile, 1);
});

test('I029 mapping per channel type plus name, company, title, tags and custom fields; unmapped columns are ignored; bad mappings are 400', async () => {
  const field = (await t.send('POST', t.crm(id, '/settings/custom-fields'), { name: 'Region' })).body;
  const csv = 'Mail,Who,Org,Role,Labels,Where,Ignored\na@x.com,Ann,Co,CTO,"a;b",EU,zzz\n';
  const body = { fileName: 'f.csv', contentBase64: b64(csv), mapping: { channels: [{ column: 'Mail', type: 'email' }], name: 'Who', company: 'Org', title: 'Role', tags: 'Labels', custom: { [field.id]: 'Where' } } };
  assert.equal((await t.send('POST', t.crm(id, '/import/csv/commit'), body)).body.added, 1);
  const c = (await t.api(t.crm(id, '/contacts'))).body.rows[0];
  assert.deepEqual([c.name, c.company, c.title, c.tags, c.custom[field.id]], ['Ann', 'Co', 'CTO', ['a', 'b'], 'EU']);
  const send = (mapping: unknown) => t.send('POST', t.crm(id, '/import/csv/preview'), { ...body, mapping });
  assert.equal((await send({ channels: [{ column: 'Nope', type: 'email' }] })).status, 400);
  assert.equal((await send({ channels: [{ column: 'Mail', type: 'email' }, { column: 'Who', type: 'email' }] })).status, 400);
  assert.equal((await send({ channels: [] })).status, 400);
  assert.equal((await send({ channels: [{ column: 'Mail', type: 'fax' }] })).status, 400);
  assert.equal((await send({ channels: [{ column: 'Mail', type: 'email' }], custom: { bogus: 'Where' } })).status, 400);
});

test('I030 the batch is named "<file> <date>" by default, a custom name wins, and a blank name falls back', async () => {
  await commit('email\na@x.com\n');
  await commit('email\nb@x.com\n', { batchName: 'Trade show' });
  await commit('email\nc@x.com\n', { batchName: '   ' });
  const names = (await t.api(t.crm(id, '/batches'))).body.batches.map((b: { name: string }) => b.name);
  assert.deepEqual(names, ['leads.csv 2026-03-16', 'Trade show', 'leads.csv 2026-03-16']);
  assert.equal((await t.send('POST', t.crm(id, '/import/csv/commit'), csvBody('email\nd@x.com\n', { batchName: 'x'.repeat(121) }))).status, 400);
});

test('I030b the default batch date is the Building-timezone day', async () => {
  assert.equal((await t.send('PATCH', t.crm(id, '/settings'), { timezone: 'Asia/Kolkata' })).status, 200);
  t.clock.now = Date.parse('2026-12-31T19:00:00Z'); // 00:30 on 1 Jan in India
  await commit('email\na@x.com\n');
  assert.equal((await t.api(t.crm(id, '/batches'))).body.batches[0].name, 'leads.csv 2027-01-01');
});

test('I031 formula-looking cells are stored as text and exported with an apostrophe', async () => {
  await commit('email,name\na@x.com,=HYPERLINK("http://evil")\nb@x.com,+1\nc@x.com,@sum\n');
  const names = (await t.api(t.crm(id, '/contacts'))).body.rows.map((r: { name: string }) => r.name).sort();
  assert.deepEqual(names, ['+1', '=HYPERLINK("http://evil")', '@sum']);
  const batch = (await t.api(t.crm(id, '/batches'))).body.batches[0];
  assert.equal(batch.counts.added, 3);
  const { crmCtx } = await import('../src/crm/runtime.ts');
  const ctx = await crmCtx((await t.projectsDb.get(id))!);
  await t.send('POST', t.crm(id, '/contacts'), { channels: [{ type: 'email', handle: 'hand@x.com' }] });
  ctx.db.prepare("UPDATE contacts SET source = '=bad' WHERE batchId IS NULL").run();
  const csv = (await t.api(t.crm(id, '/reports/export?table=by-source&period=day'))).text;
  assert.match(csv, /'=bad/);
});

test('I032 a 0-byte file, a header-only file, non-UTF-8 bytes and a BOM never give a 500', async () => {
  const send = (bytes: Buffer) => t.send('POST', t.crm(id, '/import/csv/preview'), { fileName: 'f.csv', contentBase64: bytes.toString('base64'), mapping: mapping(bytes.toString('utf8').replace(/^\ufeff/, '')) });
  assert.equal((await send(Buffer.alloc(0))).status, 400);
  assert.equal((await t.send('POST', t.crm(id, '/import/csv/preview'), { fileName: 'f.csv', contentBase64: '', mapping: mapping() })).status, 400);
  const headerOnly = await send(Buffer.from('email,name\n'));
  assert.deepEqual([headerOnly.status, headerOnly.body.added], [200, 0]);
  assert.equal((await send(Buffer.from([0xff, 0xfe, 0x41, 0x80, 0x81]))).status, 400);
  const bom = await send(Buffer.from('﻿email,name\na@x.com,A\n'));
  assert.deepEqual([bom.status, bom.body.added], [200, 1]);
});

test('I033 50,000 rows are accepted and 50,001 refused; 15 MB is accepted and 15 MB + 1 refused; nothing is saved when refused', async () => {
  const rows = (n: number) => `email\n${Array.from({ length: n }, (_, i) => `u${i}@x.com`).join('\n')}\n`;
  const over = await commit(rows(CSV_MAX_ROWS + 1));
  assert.deepEqual([over.status, /50,000/.test(over.body.error)], [400, true]);
  assert.equal((await counts()).contacts, 0);
  const ok = await commit(rows(CSV_MAX_ROWS));
  assert.deepEqual([ok.status, ok.body.added], [201, CSV_MAX_ROWS]);
  const filler = (bytes: number) => `email\n${'x'.repeat(bytes - 7)}\n`;
  const tooBig = await commit(filler(CSV_MAX_BYTES + 1));
  assert.deepEqual([tooBig.status, /15 MB/.test(tooBig.body.error)], [400, true]);
  const exact = await commit(filler(CSV_MAX_BYTES));
  assert.equal(exact.status, 201);
  assert.equal(exact.body.rejected, 1, 'the one huge cell is not an email');
});

test('I034 a 15 MB file full of quotes and newlines fits the 25 MB JSON body and is accepted', async () => {
  const cell = '"a ""quoted"" cell\nwith lines\nand more ""quotes"" ' + 'y'.repeat(320) + '"';
  let csv = 'name,email\n';
  for (let i = 0; csv.length < CSV_MAX_BYTES - 400; i++) csv += `${cell},q${i}@x.com\n`;
  assert.ok(csv.length <= CSV_MAX_BYTES && csv.length > CSV_MAX_BYTES - 1000);
  const res = await commit(csv);
  assert.equal(res.status, 201, `${res.status} ${res.text.slice(0, 300)}`);
  assert.ok(res.body.added > 30_000 && res.body.rejected === 0);
  const sample = (await t.api(t.crm(id, '/contacts?limit=1'))).body.rows[0];
  assert.match(sample.name, /^a "quoted" cell\nwith lines/);
});

test('I035 an error mid-commit leaves no half-imported batch, and a 50,000-row commit keeps the event loop responsive', async () => {
  const { crmCtx } = await import('../src/crm/runtime.ts');
  const ctx = await crmCtx((await t.projectsDb.get(id))!);
  ctx.db.exec("CREATE TRIGGER boom BEFORE INSERT ON contacts WHEN NEW.name = 'BOOM' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const bad = await commit('email,name\na@x.com,Fine\nb@x.com,BOOM\nc@x.com,Fine\n');
  assert.equal(bad.status, 500);
  assert.deepEqual(await counts(), { contacts: 0, channels: 0, batches: 0, timeline: 0 });
  ctx.db.exec('DROP TRIGGER boom');
  let worst = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 10);
  const rows = `email,name\n${Array.from({ length: CSV_MAX_ROWS }, (_, i) => `u${i}@x.com,User ${i}`).join('\n')}\n`;
  const ok = await commit(rows);
  clearInterval(timer);
  assert.equal(ok.body.added, CSV_MAX_ROWS);
  assert.ok(worst < IMPORT_LAG_BUDGET_MS, `the longest event-loop stall was ${Math.round(worst)} ms (budget ${IMPORT_LAG_BUDGET_MS} ms)`);
});

test('I036 paste: one handle per line on the chosen channel; blank lines skipped; invalid lines rejected with their line numbers', async () => {
  await t.send('POST', t.crm(id, '/contacts'), { channels: [{ type: 'instagram', handle: '@old' }] });
  const text = '@new1\n\n  \nhttps://instagram.com/new2/\n@NEW1\n@@@\n@old\n';
  const r = await t.send('POST', t.crm(id, '/import/paste'), { text, channel: 'instagram', batchName: 'Pasted today' });
  assert.deepEqual([r.status, r.body.added, r.body.duplicatesInFile, r.body.existing, r.body.rejected], [201, 2, 1, 1, 1]);
  assert.deepEqual(r.body.rejectedRows, [{ line: 6, reason: 'No handle: @@@' }]);
  const bad = await t.send('POST', t.crm(id, '/import/paste'), { text: 'a@x.com\nnot an email\n', channel: 'email' });
  assert.deepEqual(bad.body.rejectedRows, [{ line: 2, reason: 'Invalid email: not an email' }]);
  const dry = await t.send('POST', t.crm(id, '/import/paste'), { text: '@z', channel: 'instagram', commit: false });
  assert.deepEqual([dry.body.added, dry.body.committed], [1, false]);
  assert.equal((await t.api(t.crm(id, '/contacts?search=%40z'))).body.total, 0);
});

test('I037 a pasted list is a named batch with source "pasted list"; an empty paste is 400; more than 50,000 lines is 400', async () => {
  await t.send('POST', t.crm(id, '/import/paste'), { text: 'a@x.com', channel: 'email' });
  const c = (await t.api(t.crm(id, '/contacts'))).body.rows[0];
  assert.deepEqual([c.source, (await t.api(t.crm(id, '/batches'))).body.batches[0].name], ['pasted list', 'Pasted list 2026-03-16']);
  assert.equal((await t.send('POST', t.crm(id, '/import/paste'), { text: '  \n ', channel: 'email' })).status, 400);
  assert.equal((await t.send('POST', t.crm(id, '/import/paste'), { text: 'a@x.com', channel: 'fax' })).status, 400);
  const lines = Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `u${i}@x.com`).join('\n');
  assert.equal((await t.send('POST', t.crm(id, '/import/paste'), { text: lines, channel: 'email' })).status, 400);
});

test('I038 batches can be listed and used to filter contacts and reports; an unknown batch is 400 in a query', async () => {
  const a = (await commit('email\na@x.com\nb@x.com\n', { batchName: 'One' })).body;
  await commit('email\nc@x.com\n', { batchName: 'Two' });
  assert.equal((await t.api(t.crm(id, '/batches'))).body.batches.length, 2);
  assert.equal((await t.api(t.crm(id, `/contacts?batch=${a.batchId}`))).body.total, 2);
  assert.equal((await t.api(t.crm(id, `/reports?period=day&batch=${a.batchId}`))).body.period.metrics.prospectsAdded, 2);
  assert.equal((await t.api(t.crm(id, '/reports?period=day&batch=999'))).status, 400);
  assert.equal((await t.api(t.crm(id, '/contacts?batch=999'))).body.total, 0);
});
