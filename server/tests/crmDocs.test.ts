import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CRM_TABS, CSV_MAX_BYTES, CSV_MAX_ROWS, LIST_DEFAULT, LIST_LIMIT_MAX } from '../src/crm/limits.ts';

const doc = readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'crm-building.md'), 'utf8');

test('I113 the product doc states the page-size limits and the benchmark proxy, and lists the manual checks with the person as owner', () => {
  assert.equal(LIST_DEFAULT, 50);
  assert.equal(LIST_LIMIT_MAX, 200);
  assert.match(doc, /50 by default, \*\*200 maximum\*\*/);
  assert.match(doc, /sized-down run with extrapolation/);
  assert.match(doc, /unfinished run does not meet the criterion/);
  assert.match(doc, /## Manual checks \(owner: the person/);
  for (const check of ['real SMTP account', 'Real audio transcription', 'Real browser layout']) assert.match(doc, new RegExp(check, 'i'));
  assert.match(doc, /Whether a real transcription works has not been verified/);
});

test('I113 the doc names the binding tab order and the import limits as the code declares them', () => {
  assert.match(doc, new RegExp(CRM_TABS.map((t) => `\\*\\*${t.replace(/[()]/g, '\\$&')}\\*\\*`).join('.*')));
  assert.match(doc, new RegExp(`${CSV_MAX_BYTES / 1_048_576} MB`));
  assert.match(doc, new RegExp(`${CSV_MAX_ROWS.toLocaleString('en-US')}`));
  assert.match(doc, /crm\.connection_needs_attention/);
});
