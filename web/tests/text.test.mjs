import assert from 'node:assert/strict';
import { test } from 'node:test';

const { plural } = await import('../src/lib/text.ts');

test('plural leaves one singular and pluralises zero and many', () => {
  assert.equal(plural(1, 'task'), '1 task');
  assert.equal(plural(0, 'task'), '0 tasks');
  assert.equal(plural(3, 'file'), '3 files');
});
