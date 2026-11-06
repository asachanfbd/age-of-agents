import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHORT_LABEL_MAX_CHARS, summarizeProgress, trimShortLabel } from '../src/worker/stepProgress.ts';
import type { StepProgressItem, StepRunProgress } from '../src/domain/types.ts';

const progress = (checklist: StepProgressItem[], estimate: string | null = null): StepRunProgress => ({ checklist, currentActivity: null, estimate, estimatedAt: null });

test('US01 a two-word label is kept as it is', () => {
  assert.equal(trimShortLabel('writing code'), 'writing code');
});

test('US02 three or more words keep the first two', () => {
  assert.equal(trimShortLabel('reviewing the diff'), 'reviewing the');
  assert.equal(trimShortLabel('one two three four five'), 'one two');
});

test('US03 exactly 24 characters are kept; 25 become 23 plus an ellipsis', () => {
  const exact = `${'a'.repeat(12)} ${'b'.repeat(11)}`;
  assert.equal(exact.length, SHORT_LABEL_MAX_CHARS);
  assert.equal(trimShortLabel(exact), exact);
  const over = `${'a'.repeat(12)} ${'b'.repeat(12)}`;
  const trimmed = trimShortLabel(over)!;
  assert.equal([...trimmed].length, 24);
  assert.equal(trimmed, `${over.slice(0, 23)}…`);
});

test('US04 tabs, newlines and repeated spaces are one separator, collapsed to one space', () => {
  assert.equal(trimShortLabel('  writing\t\n   code  '), 'writing code');
});

test('US05 empty, whitespace-only and missing labels are null', () => {
  assert.equal(trimShortLabel(''), null);
  assert.equal(trimShortLabel(' \t\n '), null);
  assert.equal(trimShortLabel(null), null);
  assert.equal(trimShortLabel(undefined), null);
});

test('US06 emoji and CJK count by code point and a surrogate pair is never split', () => {
  assert.equal(trimShortLabel('🚀🚀 テスト'), '🚀🚀 テスト');
  const emoji = '😀'.repeat(30);
  const trimmed = trimShortLabel(emoji)!;
  assert.equal([...trimmed].length, 24);
  assert.ok(trimmed.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(trimmed), 'no lone high surrogate');
});

test('US07 a single 10,000-character word becomes 24 characters ending in an ellipsis', () => {
  const trimmed = trimShortLabel('x'.repeat(10_000))!;
  assert.equal(trimmed.length, 24);
  assert.ok(trimmed.endsWith('…'));
});

test('US08 the summary\'s currentLabel is the first in-progress item\'s label', () => {
  const summary = summarizeProgress(progress([
    { text: 'Plan', state: 'done', note: null, short: 'planning' },
    { text: 'Build', state: 'in-progress', note: null, short: 'writing code' },
    { text: 'Test', state: 'in-progress', note: null, short: 'running tests' },
    { text: 'Extra', state: 'skipped', note: null, short: null },
  ], '~5 min'));
  assert.deepEqual(summary, { total: 4, done: 1, estimate: '~5 min', currentLabel: 'writing code' });
  assert.equal(summarizeProgress(progress([{ text: 'Plan', state: 'done', note: null, short: 'planning' }])).currentLabel, null, 'nothing in progress');
  assert.equal(summarizeProgress(progress([{ text: 'Build', state: 'in-progress', note: null, short: null }])).currentLabel, null, 'in progress with no label');
});

test('US09 progress stored before labels existed has no currentLabel and the same counts', () => {
  const summary = summarizeProgress(progress([{ text: 'Build', state: 'in-progress', note: null }, { text: 'Plan', state: 'done', note: null }]));
  assert.deepEqual(summary, { total: 2, done: 1, estimate: null, currentLabel: null });
});
