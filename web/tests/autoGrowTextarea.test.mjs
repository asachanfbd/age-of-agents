import assert from 'node:assert/strict';
import { test } from 'node:test';

const { autoGrowSize, AUTO_GROW_MAX_LINES } = await import('../src/lib/autoGrowTextarea.ts');

const LINE = 20;
const size = (lines, over = {}) => autoGrowSize({ contentHeight: lines * LINE, lineHeight: LINE, minLines: 1, ...over });

test('empty content and a single line stay at one line', () => {
  assert.deepEqual(size(0), { lines: 1, scrolls: false });
  assert.deepEqual(size(1), { lines: 1, scrolls: false });
});

test('content grows line by line up to the 5-line cap without scrolling', () => {
  for (const n of [2, 3, 4, 5]) assert.deepEqual(size(n), { lines: n, scrolls: false });
});

test('beyond the cap the height stays at 5 lines and the textarea scrolls', () => {
  assert.equal(AUTO_GROW_MAX_LINES, 5);
  assert.deepEqual(size(6), { lines: 5, scrolls: true });
  assert.deepEqual(size(500), { lines: 5, scrolls: true });
});

test('shrinking content returns the smaller height', () => {
  assert.equal(size(8).lines, 5);
  assert.deepEqual(size(2), { lines: 2, scrolls: false });
});

test('a minimum of two lines holds for empty and one-line content, and still caps at five', () => {
  assert.deepEqual(size(0, { minLines: 2 }), { lines: 2, scrolls: false });
  assert.deepEqual(size(1, { minLines: 2 }), { lines: 2, scrolls: false });
  assert.deepEqual(size(9, { minLines: 2 }), { lines: 5, scrolls: true });
});

test('sub-pixel rounding does not add a phantom line', () => {
  assert.equal(autoGrowSize({ contentHeight: 2 * LINE + 0.1, lineHeight: LINE, minLines: 1 }).lines, 2);
  assert.equal(autoGrowSize({ contentHeight: 2 * LINE + 1, lineHeight: LINE, minLines: 1 }).lines, 3);
});

test('odd inputs clamp instead of throwing', () => {
  assert.deepEqual(size(3, { minLines: 9 }), { lines: 5, scrolls: false });
  assert.deepEqual(size(3, { minLines: 0 }), { lines: 3, scrolls: false });
  assert.deepEqual(size(3, { minLines: -2, maxLines: 0 }), { lines: 1, scrolls: true });
  assert.deepEqual(autoGrowSize({ contentHeight: 100, lineHeight: 0, minLines: 2 }), { lines: 2, scrolls: false });
  assert.deepEqual(autoGrowSize({ contentHeight: 0, lineHeight: LINE, minLines: 2 }), { lines: 2, scrolls: false });
});
