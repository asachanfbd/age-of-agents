import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCsv, exportCell, parseCsv, toCsv } from '../src/crm/csv.ts';
import { CrmInputError } from '../src/crm/errors.ts';
import { CSV_MAX_BYTES, CSV_MAX_ROWS, MB } from '../src/crm/limits.ts';

test('U015 a quoted cell with a newline is one row and the next row keeps its physical line number', () => {
  const p = parseCsv('name,email\n"A\nB",a@x.com\nC,c@x.com\n');
  assert.deepEqual(p.rows.map((r) => [r.line, r.cells[0]]), [[2, 'A\nB'], [4, 'C']]);
});
test('U016 CRLF, LF, CR, a BOM and a trailing newline parse the same', () => {
  const variants = ['a,b\n1,2\n3,4', 'a,b\r\n1,2\r\n3,4\r\n', 'a,b\r1,2\r3,4', '﻿a,b\n1,2\n3,4\n'];
  const parsed = variants.map((v) => { const p = parseCsv(decodeCsv(Buffer.from(v))); return JSON.stringify([p.headers, p.rows.map((r) => r.cells)]); });
  assert.equal(new Set(parsed).size, 1);
});
test('U017 escaped quotes, commas in quotes, empty cells and space-only cells', () => {
  const p = parseCsv('a,b,c\n"say ""hi""","x,y",\n  ,,z\n');
  assert.deepEqual(p.rows.map((r) => r.cells), [['say "hi"', 'x,y', ''], ['  ', '', 'z']]);
});
test('U018 an unterminated quote rejects the rest with its line; earlier rows still parse', () => {
  const p = parseCsv('a,b\n1,2\n3,"oops\n4,5\n');
  assert.deepEqual(p.rows.map((r) => r.line), [2]);
  assert.equal(p.rejected.length, 1);
  assert.equal(p.rejected[0]!.line, 3);
  assert.match(p.rejected[0]!.reason, /Unterminated quote/);
});
test('U019 ragged rows are rejected "Wrong column count" with their line', () => {
  const p = parseCsv('a,b\n1\n2,3,4\n5,6\n');
  assert.deepEqual(p.rejected, [{ line: 2, reason: 'Wrong column count' }, { line: 3, reason: 'Wrong column count' }]);
  assert.deepEqual(p.rows.map((r) => r.line), [4]);
});
test('U020 blank lines are skipped but still advance the line counter; header-only and empty give zero rows', () => {
  const p = parseCsv('a,b\n\n1,2\n   \n3,4');
  assert.deepEqual(p.rows.map((r) => r.line), [3, 5]);
  assert.equal(parseCsv('a,b\n').rows.length, 0);
  assert.deepEqual(parseCsv('').headers, []);
});
test('U021 duplicate or empty header names are refused', () => {
  assert.throws(() => parseCsv('a,A\n1,2'), CrmInputError);
  assert.throws(() => parseCsv('a,\n1,2'), CrmInputError);
});
test('U022 exactly 50,000 data rows parse; 50,001 is refused', () => {
  const body = (n: number) => `a\n${Array.from({ length: n }, (_, i) => i).join('\n')}`;
  assert.equal(parseCsv(body(CSV_MAX_ROWS)).rows.length, CSV_MAX_ROWS);
  assert.throws(() => parseCsv(body(CSV_MAX_ROWS + 1)), /more than 50,000/);
});
test('U023 15 MB decodes, 15 MB + 1 byte is refused; MB is 1,048,576 bytes', () => {
  assert.equal(MB, 1_048_576);
  assert.equal(CSV_MAX_BYTES, 15 * 1_048_576);
  assert.doesNotThrow(() => decodeCsv(Buffer.alloc(CSV_MAX_BYTES, 0x61)));
  assert.throws(() => decodeCsv(Buffer.alloc(CSV_MAX_BYTES + 1, 0x61)), /15 MB/);
});
test('U024 cells starting = + - @ are read as plain text unchanged', () => {
  const p = parseCsv('a\n=SUM(A1)\n+1\n-2\n@x\n');
  assert.deepEqual(p.rows.map((r) => r.cells[0]), ['=SUM(A1)', '+1', '-2', '@x']);
});
test('U025 export prefixes one apostrophe on = + - @ cells; a cell already starting with \' or a space is not prefixed', () => {
  assert.equal(exportCell('=1+1'), "'=1+1");
  assert.equal(exportCell('+1'), "'+1");
  assert.equal(exportCell('-1'), "'-1");
  assert.equal(exportCell('@x'), "'@x");
  assert.equal(exportCell("'=1"), "'=1");
  assert.equal(exportCell(' =1'), ' =1');
});
test('U026 export quotes commas, quotes and newlines; null cells are empty, never 0', () => {
  const csv = toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', null], [0, undefined]]);
  assert.equal(csv, 'a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n0,\r\n');
});
test('I032 (pure part) non-UTF-8 bytes and binary content are refused, never crash', () => {
  assert.throws(() => decodeCsv(Buffer.from([0xff, 0xfe, 0x41, 0x80])), CrmInputError);
  assert.throws(() => decodeCsv(Buffer.from([0x50, 0x4b, 0x00, 0x01])), /binary/);
  assert.deepEqual(parseCsv('').rows, []);
});
