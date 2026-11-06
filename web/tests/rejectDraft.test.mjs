import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { clearRejectDraft, readRejectDraft, rejectDraftStorageKey, saveRejectDraft } = await import('../src/lib/rejectDraft.ts');

function memoryStorage() {
  const values = new Map();
  return { values, getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
}
const throwing = (...names) => Object.fromEntries(names.map((n) => [n, () => { throw new Error('storage unavailable'); }]));

test('each run has its own key, even with awkward ids', () => {
  const ids = ['run-a', 'run-b', 'a/b', 'a:b', 'a b', 'ünï 🚀'];
  assert.equal(new Set(ids.map(rejectDraftStorageKey)).size, ids.length);
  assert.ok(rejectDraftStorageKey('a/b').startsWith('agent-visual-os.reject-draft.'));
});

test('reads empty when nothing is saved, and round-trips newlines, emoji and long text', () => {
  const storage = memoryStorage();
  assert.equal(readRejectDraft('r1', storage), '');
  const text = `line one\nline two 🚀\n${'x'.repeat(20000)}`;
  saveRejectDraft('r1', text, storage);
  assert.equal(readRejectDraft('r1', storage), text);
});

test('saving empty text removes the draft; clearing one run keeps the other', () => {
  const storage = memoryStorage();
  saveRejectDraft('r1', 'one', storage);
  saveRejectDraft('r2', 'two', storage);
  saveRejectDraft('r1', '', storage);
  assert.equal(readRejectDraft('r1', storage), '');
  clearRejectDraft('r1', storage);
  assert.equal(readRejectDraft('r2', storage), 'two');
  clearRejectDraft('r2', storage);
  assert.equal(storage.values.size, 0);
});

test('unavailable, full or missing storage never throws', () => {
  assert.equal(readRejectDraft('r1', throwing('getItem')), '');
  assert.doesNotThrow(() => saveRejectDraft('r1', 'x', throwing('setItem')));
  assert.doesNotThrow(() => clearRejectDraft('r1', throwing('removeItem')));
  assert.equal(readRejectDraft('r1', undefined), '');
  assert.doesNotThrow(() => saveRejectDraft('r1', 'x', undefined));
});
