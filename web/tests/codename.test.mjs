import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCodename } from '../src/lib/codename.ts';

test('generateCodename returns two capitalized words separated by a space', () => {
  const name = generateCodename();
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
});

test('generateCodename is deterministic given a fixed random source', () => {
  assert.equal(generateCodename(() => 0), generateCodename(() => 0));
  const low = generateCodename(() => 0);
  const high = generateCodename(() => 0.999);
  assert.notEqual(low, high);
});

test('generateCodename varies across many calls (not always the same pair)', () => {
  const names = new Set(Array.from({ length: 30 }, () => generateCodename()));
  assert.ok(names.size > 1);
});
