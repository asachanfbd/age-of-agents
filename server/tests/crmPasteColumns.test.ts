import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guessMapping } from '../../web/src/lib/crmImport.ts';
import { createCrmAgent } from '../src/crm/crmAgent.ts';
import { csvRecords, parseCsv } from '../src/crm/csv.ts';
import { importPaste } from '../src/crm/imports.ts';
import { CSV_MAX_ROWS, PASTE_AGENT_TIMEOUT_MS, WORK_SUMMARY_TIMEOUT_MS } from '../src/crm/limits.ts';
import {
  AGENT_SAMPLE_LINES, DETECT_LINES, MOST, columnSamples, detectHeader, detectSeparator, guessRoles, mappingPrompt, mergeAgent, parseAgentMapping, readPaste, toMapping, valueKind,
} from '../src/crm/pasteColumns.ts';
import type { PasteTable } from '../src/crm/pasteColumns.ts';
import { rememberSecret } from '../src/redaction.ts';
import { harness } from './helpers/crmFakes.ts';

const read = (text: string, opts: { separator?: 'tab' | 'comma' | 'semicolon' | 'pipe' | 'none'; hasHeader?: boolean; countryCode?: string | null } = {}) =>
  readPaste(text, { countryCode: null, ...opts });
const roles = (text: string, opts: { countryCode?: string | null; customFields?: Array<{ id: string; name: string }> } = {}) => {
  const table = read(text, { countryCode: opts.countryCode ?? null });
  const g = guessRoles(table, { countryCode: opts.countryCode ?? null, customFields: opts.customFields ?? [] });
  return { table, ...g, mapping: toMapping(table.headers, g.roles) };
};

// ---- separator ------------------------------------------------------------------
test('U01–U05 the separator is detected: tab, comma, semicolon, pipe, and none for one handle per line', () => {
  assert.equal(detectSeparator('Ann\tAcme\tann@x.com\nBo\tBeta\tbo@x.com\n'), 'tab');
  assert.equal(detectSeparator('Ann,Acme,ann@x.com\nBo,Beta,bo@x.com\n'), 'comma');
  assert.equal(detectSeparator('Ann;Acme;ann@x.com\nBo;Beta;bo@x.com\n'), 'semicolon');
  assert.equal(detectSeparator('Ann|Acme|ann@x.com\nBo|Beta|bo@x.com\n'), 'pipe');
  assert.equal(detectSeparator('ann@x.com\nbo@x.com\n'), 'none');
  assert.deepEqual(read('ann@x.com\nbo@x.com\n').headers, ['Column 1']);
});

test('U06 the most consistent count wins: commas inside tab-separated cells do not split the line', () => {
  const text = 'Shah, Rohan\tAcme\t+919910166500\nGera, Tarun, Jr\tBeta\t+919910166501\nAnn\tGamma\t+919910166502\n';
  assert.equal(detectSeparator(text), 'tab');
  assert.deepEqual(read(text).rows.map((r) => r.cells[0]), ['Shah, Rohan', 'Gera, Tarun, Jr', 'Ann']);
});

test('U07 a quoted cell keeps its comma', () => {
  const t = read('"Shah, Rohan", Acme, +15551234567\n"Gera, Tarun", Beta, +15551234568\n');
  assert.equal(t.separator, 'comma');
  assert.equal(t.headers.length, 3);
  assert.equal(t.rows[0]!.cells[0], 'Shah, Rohan');
});

test(`U08 only the first ${DETECT_LINES} lines are sampled: a later irregular line does not change the separator`, () => {
  const lines = Array.from({ length: DETECT_LINES }, (_, i) => `u${i}@x.com`);
  assert.equal(detectSeparator([...lines, 'a;b;c', 'd;e;f', 'g;h;i'].join('\n')), 'none');
  const tabbed = Array.from({ length: DETECT_LINES }, (_, i) => `N${i}\tu${i}@x.com`);
  assert.equal(detectSeparator([...tabbed, ...Array.from({ length: 30 }, () => 'a,b,c')].join('\n')), 'tab');
});

test('U09 a tie goes to tab, then comma, then semicolon, then pipe', () => {
  assert.equal(detectSeparator('a\tb,c\nd\te,f\n'), 'tab');
  assert.equal(detectSeparator('a,b;c\nd,e;f\n'), 'comma');
  assert.equal(detectSeparator('a;b|c\nd;e|f\n'), 'semicolon');
});

test('U10 blank lines, CRLF and CR endings and a leading BOM are ignored', () => {
  const t = read('﻿Ann,ann@x.com\r\n\r\n   \rBo,bo@x.com\r\n');
  assert.equal(t.separator, 'comma');
  assert.deepEqual(t.rows.map((r) => [r.line, r.cells[0]]), [[1, 'Ann'], [4, 'Bo']]);
  assert.equal(detectSeparator('﻿\n\nAnn\tann@x.com\r\nBo\tbo@x.com'), 'tab');
});

test('U11 the CSV record splitter takes a separator; quotes, "" escapes and multi-line cells keep their starting line; comma stays the default', () => {
  assert.deepEqual(csvRecords('a\tb\nc\td', '\t').map((r) => r.cells), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(csvRecords('a;b', ';')[0]!.cells, ['a', 'b']);
  assert.deepEqual(csvRecords('a|"b|c"', '|')[0]!.cells, ['a', 'b|c']);
  assert.deepEqual(csvRecords('a,b|c')[0]!.cells, ['a', 'b|c']);
  assert.deepEqual(csvRecords('a,b', null)[0]!.cells, ['a,b']);
  const multi = csvRecords('x\t"say ""hi""\nthere"\ny\tz\n', '\t');
  assert.deepEqual(multi.map((r) => [r.line, r.cells[1]]), [[1, 'say "hi"\nthere'], [3, 'z']]);
  assert.deepEqual(parseCsv('a,b\n1,2\n').rows[0]!.cells, ['1', '2']);
});

test('U12 a line with a different cell count is rejected as Wrong column count with its line number', () => {
  const t = read('Ann,ann@x.com\nBo,bo@x.com\nCy,cy@x.com,extra\nDi\n');
  assert.deepEqual(t.rejected, [{ line: 3, reason: 'Wrong column count' }, { line: 4, reason: 'Wrong column count' }]);
  assert.equal(t.rows.length, 2);
});

test('U13 an unterminated quote rejects that line and the rest is not read', () => {
  const t = read('Ann,ann@x.com\nBo,bo@x.com\n"Cy,cy@x.com\nDi,di@x.com\n');
  assert.deepEqual(t.rejected, [{ line: 3, reason: 'Unterminated quote: the rest of the file was not read' }]);
  assert.equal(t.rows.length, 2);
  assert.throws(() => read('"Name,Email\nann@x.com', { hasHeader: true }), /header row has an unterminated quote/);
});

// ---- header ---------------------------------------------------------------------
test('U14 a first line of names over email and phone data is a header and its names are used', () => {
  const t = read('Name,Email,Phone\nAnn,ann@x.com,+4915111\nBo,bo@x.com,+4915122\n');
  assert.equal(t.hasHeader, true);
  assert.deepEqual(t.headers, ['Name', 'Email', 'Phone']);
  assert.equal(t.rows[0]!.line, 2);
});

test('U15 U16 lines that are already data have no header: columns are "Column 1", "Column 2"; one line is never a header', () => {
  const t = read('Tarun Gera, +919910166500\nAnn Lee, +919910166501\n');
  assert.equal(t.hasHeader, false);
  assert.deepEqual(t.headers, ['Column 1', 'Column 2']);
  assert.equal(read('Name, Email').hasHeader, false);
  assert.equal(detectHeader([], null), false);
});

test('U17 all-text columns are a header when a name is a known header word', () => {
  assert.equal(read('Name, Company\nTarun, Acme\nAnn, Beta\n').hasHeader, true);
  assert.equal(read('Tarun, Acme\nAnn, Beta\n').hasHeader, false);
});

test('U18 an empty or repeated first-line cell means no header; forcing hasHeader then refuses with the CSV wording', () => {
  assert.equal(read('Name,,Email\nAnn,x,ann@x.com\n').hasHeader, false);
  assert.equal(read('Email,email\nann@x.com,bo@x.com\n').hasHeader, false);
  assert.throws(() => read('Name,,Email\nAnn,x,ann@x.com\n', { hasHeader: true }), /Every column needs a header name\./);
  assert.throws(() => read('Email,email\nann@x.com,bo@x.com\n', { hasHeader: true }), /Two columns have the same header name\./);
  assert.throws(() => read('Name,Email', { hasHeader: true }), /Paste at least one line/);
});

// ---- roles ----------------------------------------------------------------------
test('U19 a column where most values are emails (any case) is email', () => {
  assert.deepEqual(roles('ANN@X.COM\nbo@x.com\n').mapping.channels, [{ column: 'Column 1', type: 'email' }]);
});

test('U20 phone spellings are a phone column, with and without a default country code', () => {
  const values = ['+919910166500', '00 91 99101 66500', '+91 99101-66500', '(099) 1016 6500', '+９１９９１０１６６５００'];
  for (const cc of [null, '91']) for (const v of values) assert.equal(valueKind(v, cc), 'phone', `${v} with ${cc}`);
  assert.deepEqual(roles(values.join('\n'), { countryCode: '91' }).mapping.channels, [{ column: 'Column 1', type: 'phone' }]);
});

test('U21 profile URLs pick their network: LinkedIn (with or without scheme, lnkd.in), Instagram, Facebook and fb.com', () => {
  for (const v of ['https://www.linkedin.com/in/x', 'linkedin.com/in/x', 'lnkd.in/abc']) assert.equal(valueKind(v, null), 'linkedin', v);
  assert.equal(valueKind('instagram.com/x', null), 'instagram');
  for (const v of ['facebook.com/x', 'https://fb.com/x']) assert.equal(valueKind(v, null), 'facebook', v);
  assert.deepEqual(roles('Ann,linkedin.com/in/ann\nBo,linkedin.com/in/bo\n').mapping, { channels: [{ column: 'Column 2', type: 'linkedin' }], name: 'Column 1' });
});

test(`U22 "most" means more than ${MOST * 100}% of non-empty values: 3 of 4 emails is email, 1 of 4 is not`, () => {
  assert.equal(roles('a@x.com\nb@x.com\nc@x.com\nnope\n').mapping.channels[0]!.type, 'email');
  assert.deepEqual(roles('a@x.com\nAnn\nBo\nCy\n').mapping.channels, []);
});

test('U23 empty cells are ignored and an all-empty column is ignored', () => {
  const r = roles('Ann,,a@x.com\nBo,,\nCy,,c@x.com\n');
  assert.deepEqual(r.roles[1], { role: 'ignore' });
  assert.deepEqual(r.mapping, { channels: [{ column: 'Column 3', type: 'email' }], name: 'Column 1' });
  assert.deepEqual(r.open, []);
});

test('U24 header names win via the guessMapping rules: Company, Title or Role, Tags', () => {
  const r = roles('Name,Company,Role,Tags,Email\nAnn,Acme,CEO,vip,ann@x.com\n'.replace('\n', '\n') + 'Bo,Beta,CTO,new,bo@x.com\n');
  assert.deepEqual(r.mapping, { channels: [{ column: 'Email', type: 'email' }], name: 'Name', company: 'Company', title: 'Role', tags: 'Tags' });
  assert.equal(roles('Title,Email\nCEO,ann@x.com\n').mapping.title, 'Title');
});

test('the server header rules agree with the web guessMapping for every header the CSV test uses', () => {
  const headers = ['Full Name', 'Work Email', 'Mobile', 'Company', 'Job Title', 'Instagram', 'LinkedIn URL', 'Tags', 'Notes'];
  const table: PasteTable = { separator: 'comma', hasHeader: true, headers, rows: [{ line: 2, cells: headers.map(() => '') }], rejected: [] };
  const server = toMapping(headers, guessRoles(table, { countryCode: null, customFields: [] }).roles);
  assert.deepEqual(server, guessMapping(headers));
});

test('U25 two text columns without a header: a company marker makes that column company and the other name; otherwise both stay open', () => {
  const r = roles('Tarun Gera,Acme Pvt Ltd,+919910166500\nAnn Lee,Beta Inc,+919910166501\nBo,Gamma GmbH,+919910166502\n');
  assert.deepEqual(r.mapping, { channels: [{ column: 'Column 3', type: 'phone' }], name: 'Column 1', company: 'Column 2' });
  for (const marker of ['LLC', 'Inc', 'GmbH', 'Pvt Ltd']) assert.equal(roles(`Ann,Acme ${marker},a@x.com\n`).mapping.company, 'Column 2', marker);
  const open = roles('Tarun Gera,Acme,+919910166500\nAnn Lee,Beta,+919910166501\n');
  assert.deepEqual(open.open, [0, 1]);
  assert.deepEqual(open.mapping, { channels: [{ column: 'Column 3', type: 'phone' }] });
});

test('U26 exactly one text column next to a channel column is the name', () => {
  const r = roles('Tarun Gera, +919910166500\nAnn Lee, +919910166501\n');
  assert.deepEqual(r.mapping, { channels: [{ column: 'Column 2', type: 'phone' }], name: 'Column 1' });
  assert.deepEqual(r.open, []);
});

test('U27 a second phone column is left open: two columns cannot share one channel', () => {
  const r = roles('+919910166500,+919910166600\n+919910166501,+919910166601\n');
  assert.deepEqual(r.mapping.channels, [{ column: 'Column 1', type: 'phone' }]);
  assert.deepEqual(r.open, [1]);
});

test('U28 a bare @handle is an open column (which network is unknown); a digits-only value is a phone', () => {
  assert.equal(valueKind('@ann', null), 'at');
  assert.deepEqual(roles('@ann\n@bo\n').open, [0]);
  assert.equal(valueKind('98765', null), 'phone');
  assert.equal(valueKind('123', null), 'text');
});

test('U29 a header equal to a custom field name (any case) maps to that custom field', () => {
  const r = roles('Email,city\nann@x.com,Pune\n', { customFields: [{ id: 'f1', name: 'City' }] });
  assert.deepEqual(r.mapping, { channels: [{ column: 'Email', type: 'email' }], custom: { f1: 'city' } });
});

test('U30 U31 the result is a CSV-shaped mapping plus the open columns; the same input gives the same output; nothing open means no agent', () => {
  const text = 'Tarun Gera,Acme,+919910166500\nAnn,Beta,+919910166501\n';
  assert.deepEqual(roles(text), roles(text));
  assert.ok(Array.isArray(roles(text).mapping.channels));
  assert.deepEqual(roles('Ann,a@x.com\n').open, []);
});

test('columns show their first few non-empty samples', () => {
  const t = read('Ann,a@x.com\n,b@x.com\nCy,c@x.com\nDi,d@x.com\n');
  assert.deepEqual(columnSamples(t), [['Ann', 'Cy', 'Di'], ['a@x.com', 'b@x.com', 'c@x.com']]);
});

// ---- agent prompt ---------------------------------------------------------------
test(`U32 the agent prompt holds the header and at most ${AGENT_SAMPLE_LINES} sample lines`, () => {
  const lines = Array.from({ length: 100 }, (_, i) => `Person${i}ZZ,u${i}@x.com`);
  const prompt = mappingPrompt(read(['Who,Where', ...lines].join('\n'), { hasHeader: true }));
  assert.match(prompt, /Header: \["Who","Where"\]/);
  assert.ok(prompt.includes('Person4ZZ'));
  assert.ok(!prompt.includes('Person5ZZ'), 'line 6 of the data is not sent');
  assert.match(mappingPrompt(read(lines.join('\n'))), /no header row/);
});

test('U33 a stored secret inside a pasted line is removed from the prompt, in every encoding', () => {
  const secret = 'pa"ss/w0rd?&secret';
  rememberSecret(secret, true);
  const prompt = mappingPrompt(read(`Ann,${secret}\nBo,b@x.com\n`));
  assert.match(prompt, /\[secret\]/);
  for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) assert.ok(!prompt.includes(form), form);
});

// ---- agent answer ---------------------------------------------------------------
test('U34 a valid agent answer is read', () => {
  assert.deepEqual(parseAgentMapping('{"columns":[{"index":0,"role":"name"},{"index":1,"role":"channel","channelType":"phone"},{"index":2,"role":"channel","channelType":"other","label":" Skype "}]}', 3),
    [{ index: 0, role: 'name' }, { index: 1, role: 'channel', channelType: 'phone' }, { index: 2, role: 'channel', channelType: 'other', label: 'Skype' }]);
  assert.deepEqual(parseAgentMapping('{"columns":[]}', 2), []);
});

test('U35 an unknown role or channel type makes the whole answer invalid', () => {
  assert.equal(parseAgentMapping('{"columns":[{"index":0,"role":"name"},{"index":1,"role":"phone_number"}]}', 2), null);
  assert.equal(parseAgentMapping('{"columns":[{"index":0,"role":"channel","channelType":"fax"}]}', 1), null);
  assert.equal(parseAgentMapping('{"columns":[{"index":0,"role":"name","channelType":"email"}]}', 1), null);
  assert.equal(parseAgentMapping('{"columns":[{"index":0,"role":"channel","channelType":"other","label":5}]}', 1), null);
});

test('U36 an index out of range, not an integer or a string is invalid', () => {
  for (const index of ['2', '-1', '1.5', '"0"']) assert.equal(parseAgentMapping(`{"columns":[{"index":${index},"role":"name"}]}`, 2), null, index);
});

test('U37 more entries than columns, or a repeated index, is invalid', () => {
  assert.equal(parseAgentMapping('{"columns":[{"index":0,"role":"name"},{"index":1,"role":"company"}]}', 1), null);
  assert.equal(parseAgentMapping('{"columns":[{"index":0,"role":"name"},{"index":0,"role":"company"}]}', 2), null);
});

test('U38 non-JSON, empty text, a top-level array, a missing columns list or a code fence are invalid', () => {
  for (const text of ['not json', '', '[{"index":0,"role":"name"}]', '{"cols":[]}', '```json\n{"columns":[]}\n```', '{"columns":[5]}', 'null'])
    assert.equal(parseAgentMapping(text, 2), null, text);
});

test('U39 a channel without a channel type is invalid; an other channel without a label is labelled "other"', () => {
  assert.equal(parseAgentMapping('{"columns":[{"index":0,"role":"channel"}]}', 1), null);
  assert.deepEqual(parseAgentMapping('{"columns":[{"index":0,"role":"channel","channelType":"other"}]}', 1), [{ index: 0, role: 'channel', channelType: 'other', label: 'other' }]);
});

test('U40 U41 U42 the agent fills only open columns: a decided column keeps its role, a taken channel is skipped, ignore stays unmapped', () => {
  const r = roles('Tarun Gera,Acme,+919910166500,x\nAnn,Beta,+919910166501,y\n');
  assert.deepEqual(r.open, [0, 1, 3]);
  const merged = mergeAgent(r, [
    { index: 2, role: 'name' }, { index: 0, role: 'name' }, { index: 1, role: 'channel', channelType: 'phone' }, { index: 3, role: 'ignore' },
  ]);
  assert.deepEqual(merged.filled, [0]);
  assert.deepEqual(toMapping(r.table.headers, merged.roles), { channels: [{ column: 'Column 3', type: 'phone' }], name: 'Column 1' });
  const other = mergeAgent(r, [{ index: 1, role: 'channel', channelType: 'other', label: 'Skype' }, { index: 3, role: 'channel', channelType: 'other', label: 'skype' }]);
  assert.deepEqual(toMapping(r.table.headers, other.roles).channels, [{ column: 'Column 2', type: 'other', label: 'Skype' }, { column: 'Column 3', type: 'phone' }]);
});

// ---- agent kind -----------------------------------------------------------------
test('U43 the mapping turn has no tools (the message list), a JSON-only instruction and its own purpose label', async () => {
  const seen: Array<{ appendSystemPrompt: string; disallowedTools: string[]; onProcess: () => unknown }> = [];
  const purposes: string[] = [];
  const agent = createCrmAgent(() => 'b1', async () => '/w', {
    selectExecutor: async () => ({}),
    runTurn: async (_e: unknown, o: never, meta: { purpose: string }) => { seen.push(o); purposes.push(meta.purpose); (o as { onProcess: () => unknown }).onProcess(); return { status: 'done', message: 'ok', extra: { text: '{}' } }; },
  } as never);
  await agent.run({ kind: 'mapping', prompt: 'p' });
  await agent.run({ kind: 'message', prompt: 'p' });
  assert.deepEqual(seen[0]!.disallowedTools, seen[1]!.disallowedTools);
  assert.ok(seen[0]!.disallowedTools.includes('Bash'));
  assert.match(seen[0]!.appendSystemPrompt, /Do not use any tools.*only the JSON object/);
  assert.deepEqual(purposes, ['CRM paste column mapping', 'CRM message draft']);
});

test('U44 the agent wait is 60 seconds, the same as a work update', () => {
  assert.equal(PASTE_AGENT_TIMEOUT_MS, 60_000);
  assert.equal(PASTE_AGENT_TIMEOUT_MS, WORK_SUMMARY_TIMEOUT_MS);
});

// ---- paste body -----------------------------------------------------------------
const email = { channels: [{ column: 'Column 1', type: 'email' }] };

test(`U45 exactly ${CSV_MAX_ROWS.toLocaleString('en-US')} data lines are accepted, one more is refused; a header line does not count`, () => {
  const lines = Array.from({ length: CSV_MAX_ROWS }, (_, i) => `u${i}@x.com`);
  assert.equal(read(lines.join('\n')).rows.length, CSV_MAX_ROWS);
  assert.equal(read(['Email', ...lines].join('\n'), { hasHeader: true }).rows.length, CSV_MAX_ROWS);
  assert.throws(() => read([...lines, 'one@more.com'].join('\n')), /The list has more than 50,000 lines\./);
});

test('U46 mapping checks are the CSV ones: unknown column, two columns on one channel, no channel', async () => {
  const h = harness();
  const text = 'a@x.com,b@x.com\n';
  await assert.rejects(importPaste(h.ctx, { text, mapping: { channels: [{ column: 'Column 9', type: 'email' }] } }), /Column "Column 9" is not in the file/);
  await assert.rejects(importPaste(h.ctx, { text, mapping: { channels: [{ column: 'Column 1', type: 'email' }, { column: 'Column 2', type: 'email' }] } }), /Two columns are mapped to email/);
  await assert.rejects(importPaste(h.ctx, { text, mapping: { channels: [] } }), /Map at least one column to a channel/);
});

test('U47 the older { text, channel, label } body is a one-column mapping; other keeps its label', async () => {
  const h = harness();
  const r = await importPaste(h.ctx, { text: 'Tarun Gera, +919910166500', channel: 'other', label: 'Skype', commit: false });
  assert.deepEqual([r.added, r.rejected], [1, 0]);
  const noLabel = await importPaste(h.ctx, { text: 'x', channel: 'other', commit: false });
  assert.deepEqual(noLabel.rejectedRows, [{ line: 1, reason: 'Label required: x' }]);
  const one = await importPaste(h.ctx, { text: 'a@x.com,b@x.com', channel: 'email', commit: false });
  assert.deepEqual(one.rejectedRows, [{ line: 1, reason: 'Invalid email: a@x.com,b@x.com' }]);
});

test('U48 a body with both channel and mapping is refused', async () => {
  await assert.rejects(importPaste(harness().ctx, { text: 'a@x.com', channel: 'email', mapping: email }), /Send either mapping or channel/);
});

test('U49 wrong types are refused naming the field', async () => {
  const h = harness();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ text: 5, mapping: email }, /Paste at least one line/], [{ text: 'a@x.com', mapping: email, hasHeader: 'true' }, /hasHeader/],
    [{ text: 'a@x.com', mapping: email, separator: 'TAB' }, /separator/], [{ text: 'a@x.com', mapping: email, separator: '\t' }, /separator/],
    [{ text: 'a@x.com', mapping: email, commit: 'yes' }, /commit/],
  ];
  for (const [body, re] of cases) await assert.rejects(importPaste(h.ctx, body), (e: Error & { field?: string }) => re.test(e.message), JSON.stringify(body));
});
