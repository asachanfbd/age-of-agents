import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { CrmUpstreamError } from '../src/crm/errors.ts';
import { suggestPaste } from '../src/crm/imports.ts';
import { CSV_MAX_ROWS, IMPORT_LAG_BUDGET_MS } from '../src/crm/limits.ts';
import { rememberSecret } from '../src/redaction.ts';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';
import { harness } from './helpers/crmFakes.ts';

let t: CrmApi;
let id: string;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });
beforeEach(async () => { t.reset(); id = await t.createCrm(); });

const suggest = (body: Record<string, unknown>) => t.send('POST', t.crm(id, '/import/paste/suggest'), body);
const paste = (body: Record<string, unknown>) => t.send('POST', t.crm(id, '/import/paste'), body);
const nameAndPhone = { channels: [{ column: 'Column 2', type: 'phone' }], name: 'Column 1' };
const counts = async () => {
  const { crmCtx } = await import('../src/crm/runtime.ts');
  const db = (await crmCtx((await t.projectsDb.get(id))!)).db;
  const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { contacts: n('contacts'), channels: n('channels'), batches: n('batches'), timeline: n('timeline') };
};
const ambiguous = 'Tarun Gera,Acme,+919910166500\nAnn Lee,Beta,+919910166501\n';
const agentAnswer = JSON.stringify({ columns: [{ index: 0, role: 'name' }, { index: 1, role: 'company' }] });
const ruleMapping = { channels: [{ column: 'Column 3', type: 'phone' }] };

// ---- suggest --------------------------------------------------------------------
test('I01 suggest without the agent: a tab list with a header maps every column by rules', async () => {
  const fieldId = (await t.send('POST', t.crm(id, '/settings/custom-fields'), { name: 'City' })).body.id;
  const text = 'Name\tCompany\tEmail\tPhone\tCity\nAnn\tAcme\tann@x.com\t+4915111\tPune\nBo\tBeta\tbo@x.com\t+4915122\tGoa\nCy\tGamma\tcy@x.com\t+4915133\tDelhi\nDi\tDelta\tdi@x.com\t+4915144\tAgra\n';
  const r = await suggest({ text });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.separator, r.body.hasHeader, r.body.rows, r.body.agentUsed, r.body.agentError], ['tab', true, 4, false, undefined]);
  assert.deepEqual(r.body.columns.map((c: { name: string }) => c.name), ['Name', 'Company', 'Email', 'Phone', 'City']);
  assert.ok(r.body.columns.every((c: { samples: string[] }) => c.samples.length === 3));
  assert.deepEqual(r.body.mapping, { channels: [{ column: 'Email', type: 'email' }, { column: 'Phone', type: 'phone' }], name: 'Name', company: 'Company', custom: { [fieldId]: 'City' } });
  assert.deepEqual(t.agent.requests, []);
});

test('I02 I29 suggest with the agent: it fills the two open text columns, once, with a mapping turn', async () => {
  t.agent.reply = agentAnswer;
  const r = await suggest({ text: ambiguous });
  assert.deepEqual([r.status, r.body.agentUsed, r.body.agentError], [200, true, undefined]);
  assert.deepEqual(r.body.mapping, { channels: [{ column: 'Column 3', type: 'phone' }], name: 'Column 1', company: 'Column 2' });
  assert.deepEqual(r.body.columns.map((c: { byAgent: boolean }) => c.byAgent), [true, true, false]);
  assert.equal(t.agent.requests.length, 1);
  assert.equal(t.agent.requests[0]!.kind, 'mapping');
});

test('I03 I05 I06 I07 a failing agent, a non-JSON answer, a wrong column count or no agent keep the rule suggestion with a note', async () => {
  const replies: Array<string | Error> = [new Error('it broke'), 'Name is column 0', JSON.stringify({ columns: [0, 1, 2, 3].map((index) => ({ index, role: 'name' })) }), new CrmUpstreamError('No agent is available')];
  for (const reply of replies) {
    t.agent.reply = reply;
    const r = await suggest({ text: ambiguous });
    assert.equal(r.status, 200, String(reply));
    assert.deepEqual([r.body.agentUsed, r.body.mapping], [false, ruleMapping], String(reply));
    assert.equal(typeof r.body.agentError, 'string', String(reply));
  }
  assert.match((await suggest({ text: ambiguous })).body.agentError, /No agent is available/);
});

test('I04 an agent that never answers times out and the rule suggestion is kept', async () => {
  const h = harness();
  h.ctx.deps.agent = { run: () => new Promise<string>(() => undefined) };
  const r = await suggestPaste(h.ctx, { text: ambiguous }, 10);
  assert.deepEqual([r.agentUsed, r.agentError, r.mapping], [false, 'The agent took too long', ruleMapping]);
});

test('I08 I09 suggest saves nothing and is allowed on a read-only Building', async () => {
  const before = await counts();
  t.agent.reply = agentAnswer;
  assert.equal((await suggest({ text: ambiguous })).status, 200);
  assert.deepEqual(await counts(), before);
  await t.projectsDb.update(id, { readOnlyReason: 'Frozen for the test' });
  assert.equal((await suggest({ text: ambiguous })).status, 200);
});

test('I10 separator and header overrides are honoured; invalid values are 400', async () => {
  const one = (await suggest({ text: 'Ann,a@x.com\nBo,b@x.com\n', separator: 'none' })).body;
  assert.deepEqual([one.separator, one.columns.length], ['none', 1]);
  const named = (await suggest({ text: 'Name,Email\nAnn,a@x.com\n', hasHeader: false })).body;
  assert.deepEqual(named.columns.map((c: { name: string }) => c.name), ['Column 1', 'Column 2']);
  assert.equal((await suggest({ text: 'a', separator: 'TAB' })).status, 400);
  assert.equal((await suggest({ text: 'a', hasHeader: 'yes' })).status, 400);
});

test('I11 suggest refuses empty, whitespace or non-text input and more than 50,000 lines', async () => {
  for (const text of ['', '  \n ', 5]) assert.equal((await suggest({ text })).status, 400, String(text));
  const lines = Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `u${i}@x.com`).join('\n');
  const r = await suggest({ text: lines });
  assert.deepEqual([r.status, r.body.error], [400, 'The list has more than 50,000 lines.']);
});

test('I12 only a few sample lines reach the agent', async () => {
  t.agent.reply = agentAnswer;
  const lines = Array.from({ length: 20 }, (_, i) => `Person${i}QQ,Firm${i}QQ,+91991016${String(6500 + i)}`);
  await suggest({ text: lines.join('\n') });
  const prompt = t.agent.requests[0]!.prompt;
  for (let i = 0; i < 5; i++) assert.ok(prompt.includes(`Person${i}QQ`), `line ${i + 1}`);
  for (let i = 5; i < 20; i++) for (const v of [`Person${i}QQ`, `Firm${i}QQ`, `+91991016${6500 + i}`]) assert.ok(!prompt.includes(v), v);
});

test('I13 a stored secret in the pasted text never reaches the agent', async () => {
  const secret = 'sk-live-0123456789abcdef';
  rememberSecret(secret, true);
  t.agent.reply = agentAnswer;
  await suggest({ text: `Tarun Gera,${secret},+919910166500\nAnn Lee,Beta,+919910166501\n` });
  assert.ok(!t.agent.requests[0]!.prompt.includes(secret));
});

// ---- preview and commit ---------------------------------------------------------
test('I14 I15 I28 "Tarun Gera, +919910166500": preview saves nothing (200), commit stores name and phone (201), counts agree, no agent', async () => {
  const body = { text: 'Tarun Gera, +919910166500\n', mapping: nameAndPhone, separator: 'comma', hasHeader: false };
  const before = await counts();
  const p = await paste({ ...body, commit: false });
  assert.deepEqual([p.status, p.body.added, p.body.committed, p.body.batchId], [200, 1, false, null]);
  assert.deepEqual(await counts(), before);
  const c = await paste({ ...body, commit: true });
  assert.equal(c.status, 201);
  for (const k of ['added', 'existing', 'duplicatesInFile', 'rejected']) assert.equal(c.body[k], p.body[k], k);
  const contact = (await t.api(t.crm(id, '/contacts'))).body.rows[0];
  assert.deepEqual([contact.name, contact.channels[0].type, contact.channels[0].handle, contact.source], ['Tarun Gera', 'phone', '+919910166500', 'pasted list']);
  const batch = (await t.api(t.crm(id, '/batches'))).body.batches[0];
  assert.deepEqual([batch.kind, batch.name], ['paste', 'Pasted list 2026-03-16']);
  assert.deepEqual(t.agent.requests, []);
});

test('I16 a header row maps by name; rejected lines count from the physical line (the first data row is line 2)', async () => {
  const r = await paste({ text: 'Name,Email\nAnn,ann@x.com\nBo,nope\n', mapping: { channels: [{ column: 'Email', type: 'email' }], name: 'Name' }, commit: true });
  assert.deepEqual([r.status, r.body.added, r.body.rejectedRows], [201, 1, [{ line: 3, reason: 'Invalid email: nope' }]]);
  assert.equal((await t.api(t.crm(id, '/contacts'))).body.rows[0].name, 'Ann');
});

test('I17 existing, duplicate in the list, a name in the phone column and a short row are counted with line numbers', async () => {
  await paste({ text: 'Old One, +919910166000', mapping: nameAndPhone });
  const text = 'Old One, +919910166000\nNew One, +919910166001\nNew Again, +919910166001\n+919910166002, Tarun Gera\nShort\n';
  const r = (await paste({ text, mapping: nameAndPhone, separator: 'comma', commit: false })).body;
  assert.deepEqual([r.added, r.existing, r.duplicatesInFile, r.rejected], [1, 1, 1, 2]);
  assert.deepEqual(r.rejectedRows, [{ line: 4, reason: 'Invalid phone: Tarun Gera' }, { line: 5, reason: 'Wrong column count' }]);
});

test('I18 a quoted name keeps its comma', async () => {
  await paste({ text: '"Shah, Rohan", +919910166500\n"Gera, Tarun", +919910166501\n', mapping: nameAndPhone });
  assert.deepEqual((await t.api(t.crm(id, '/contacts'))).body.rows.map((c: { name: string }) => c.name).sort(), ['Gera, Tarun', 'Shah, Rohan']);
});

test('I20 a read-only Building refuses paste preview and commit with 409 and writes nothing', async () => {
  await t.projectsDb.update(id, { readOnlyReason: 'Frozen for the test' });
  for (const commit of [false, true]) {
    const r = await paste({ text: 'Tarun Gera, +919910166500', mapping: nameAndPhone, commit });
    assert.deepEqual([r.status, r.body.error], [409, 'Frozen for the test']);
  }
  assert.equal((await counts()).contacts, 0);
});

test('I21 mapping errors are 400: no channel, unknown column, two columns on one channel, unknown custom field', async () => {
  const text = 'a@x.com,b@x.com\n';
  for (const mapping of [{ channels: [] }, { channels: [{ column: 'Nope', type: 'email' }] }, { channels: [{ column: 'Column 1', type: 'email' }, { column: 'Column 2', type: 'email' }] }, { channels: [{ column: 'Column 1', type: 'email' }], custom: { nope: 'Column 2' } }]) {
    assert.equal((await paste({ text, mapping, commit: false })).status, 400, JSON.stringify(mapping));
  }
});

test('I22 a tags column, batch tags and a custom field are stored on new contacts', async () => {
  const fieldId = (await t.send('POST', t.crm(id, '/settings/custom-fields'), { name: 'City' })).body.id;
  const r = await paste({ text: 'ann@x.com|vip;new|Pune\n', separator: 'pipe', mapping: { channels: [{ column: 'Column 1', type: 'email' }], tags: 'Column 2', custom: { [fieldId]: 'Column 3' } }, tags: ['spring'] });
  assert.equal(r.status, 201, r.text);
  const c = (await t.api(t.crm(id, '/contacts'))).body.rows[0];
  assert.deepEqual([[...c.tags].sort(), c.custom[fieldId]], [['new', 'spring', 'vip'], 'Pune']);
});

test('I23 a failure mid-commit leaves no batch, contacts or timeline', async () => {
  const { crmCtx } = await import('../src/crm/runtime.ts');
  const ctx = await crmCtx((await t.projectsDb.get(id))!);
  ctx.db.exec("CREATE TRIGGER boom BEFORE INSERT ON contacts WHEN NEW.name = 'BOOM' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const r = await paste({ text: 'Fine, +919910166500\nBOOM, +919910166501\nFine, +919910166502\n', mapping: nameAndPhone });
  ctx.db.exec('DROP TRIGGER boom');
  assert.equal(r.status, 500);
  assert.deepEqual(await counts(), { contacts: 0, channels: 0, batches: 0, timeline: 0 });
});

test('I24 two commits of the same list started together run one after the other: the second finds them existing', async () => {
  const body = { text: 'Ann, +919910166500\nBo, +919910166501\n', mapping: nameAndPhone };
  const [a, b] = await Promise.all([paste(body), paste(body)]);
  assert.deepEqual([a.body.added + b.body.added, a.body.existing + b.body.existing], [2, 2]);
  assert.equal((await counts()).contacts, 2);
});

test('I25 I27 50,000 data lines under a header commit within the event-loop budget; 50,001 are refused; a body over 25 MB is 413', async () => {
  const lines = Array.from({ length: CSV_MAX_ROWS }, (_, i) => `User ${i},u${i}@x.com`);
  let worst = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 10);
  const ok = await paste({ text: ['Name,Email', ...lines].join('\n'), mapping: { channels: [{ column: 'Email', type: 'email' }], name: 'Name' } });
  clearInterval(timer);
  assert.deepEqual([ok.status, ok.body.added], [201, CSV_MAX_ROWS]);
  assert.ok(worst < IMPORT_LAG_BUDGET_MS, `the longest event-loop stall was ${Math.round(worst)} ms (budget ${IMPORT_LAG_BUDGET_MS} ms)`);
  const over = await paste({ text: [...lines, 'One more,one@more.com'].join('\n'), mapping: { channels: [{ column: 'Column 2', type: 'email' }] }, commit: false });
  assert.deepEqual([over.status, over.body.error], [400, 'The list has more than 50,000 lines.']);
  assert.equal((await paste({ text: 'x'.repeat(26 * 1_048_576), channel: 'email' })).status, 413);
});

test('I26 a batch name over 120 characters is 400, a blank one falls back, and the default uses the Building-timezone date', async () => {
  const body = { text: 'a@x.com', mapping: { channels: [{ column: 'Column 1', type: 'email' }] } };
  assert.equal((await paste({ ...body, batchName: 'x'.repeat(121) })).status, 400);
  assert.equal((await t.send('PATCH', t.crm(id, '/settings'), { timezone: 'Asia/Kolkata' })).status, 200);
  t.clock.now = Date.parse('2026-12-31T19:00:00Z'); // 00:30 on 1 Jan in India
  await paste({ ...body, batchName: '   ' });
  assert.equal((await t.api(t.crm(id, '/batches'))).body.batches[0].name, 'Pasted list 2027-01-01');
});

test('I30 paste and suggest on a Building that is not a CRM are 404', async () => {
  const seo = (await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' })).body;
  for (const suffix of ['/import/paste', '/import/paste/suggest']) assert.equal((await t.send('POST', t.crm(seo.id, suffix), { text: 'a@x.com', channel: 'email' })).status, 404, suffix);
});

test('I31 the product doc describes paste detection and lists the suggest route', () => {
  const doc = readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'crm-building.md'), 'utf8');
  const section = doc.slice(doc.indexOf('Import (Import tab)'));
  assert.match(section, /detects the columns/i);
  assert.match(section, /rules first/i);
  assert.match(section, /Suggested without the agent/);
  assert.match(doc, /import\/paste\/suggest/);
});
