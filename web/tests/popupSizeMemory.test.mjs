import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  POPUP_SIZE_MEMORY_LIMIT, createPopupSizeMemory, matchPopupSize, parsePopupSizeEntries, rememberPopupSize, viewportKey,
} from '../src/lib/popupSizeMemory.ts';

const hook = await readFile(new URL('../src/lib/useResizablePopup.ts', import.meta.url), 'utf8');
const dialog = await readFile(new URL('../src/components/ui/dialog.tsx', import.meta.url), 'utf8');
const workspace = await readFile(new URL('../src/ui/ProjectWorkspaceModal.tsx', import.meta.url), 'utf8');

const KEY = 'test.popup-size';
const laptop = { width: 1440, height: 900 };
const monitor = { width: 2560, height: 1440 };

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); values.set(key, value); },
  };
}

const throwingStorage = {
  getItem() { throw new Error('storage blocked'); },
  setItem() { throw new Error('quota exceeded'); },
};

test('a viewport key is its rounded width x height', () => {
  assert.equal(viewportKey({ width: 1440.4, height: 899.6 }), '1440x900');
});

test('a user resize is saved under the current viewport', () => {
  const storage = memoryStorage();
  createPopupSizeMemory(KEY, storage).saveUserResize(laptop, { width: 1000, height: 700 });
  assert.deepEqual(JSON.parse(storage.values.get(KEY)), { '1440x900': { width: 1000, height: 700 } });
});

test('a saved size is restored when the viewport matches exactly', () => {
  const storage = memoryStorage();
  const memory = createPopupSizeMemory(KEY, storage);
  memory.saveUserResize(laptop, { width: 1000, height: 700 });
  memory.saveUserResize(monitor, { width: 2000, height: 1200 });
  assert.deepEqual(memory.restore(laptop), { width: 1000, height: 700 });
  assert.deepEqual(memory.restore(monitor), { width: 2000, height: 1200 });
});

test('a viewport with no saved entry restores nothing, keeping the default size', () => {
  const storage = memoryStorage();
  const memory = createPopupSizeMemory(KEY, storage);
  memory.saveUserResize(laptop, { width: 1000, height: 700 });
  assert.equal(memory.restore({ width: 1440, height: 901 }), null);
  assert.equal(memory.restore(monitor), null);
});

test('a restored size is clamped to the current viewport', () => {
  const entries = { '1440x900': { width: 5000, height: 10 } };
  assert.deepEqual(matchPopupSize(entries, laptop), { width: 1340, height: 200 });
});

test('restoring never writes to storage', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ '1440x900': { width: 1000, height: 700 } }) });
  const memory = createPopupSizeMemory(KEY, storage);
  memory.restore(laptop);
  memory.restore(monitor);
  assert.deepEqual(storage.writes, []);
});

test('the hook saves only from a finished drag, never from a restore', () => {
  const saves = hook.match(/saveUserResize\(/g) ?? [];
  assert.equal(saves.length, 1);
  assert.match(hook, /const onPointerUp[\s\S]*if \(dragged\) memory\?\.saveUserResize\(viewportSize\(\), dragged\)/);
  assert.match(hook, /setTimeout\(\(\) => setSize\(memory\.restore\(viewportSize\(\)\)\), VIEWPORT_RESTORE_DEBOUNCE_MS\)/);
});

test('the project workspace popup opts into size memory through the shared dialog', () => {
  assert.match(dialog, /useResizablePopup\(sizeMemoryKey\)/);
  assert.match(workspace, /sizeMemoryKey=\{WORKSPACE_SIZE_STORAGE_KEY\}/);
});

test('re-saving a viewport replaces its entry and makes it the newest', () => {
  let entries = rememberPopupSize({}, laptop, { width: 900, height: 600 });
  entries = rememberPopupSize(entries, monitor, { width: 2000, height: 1200 });
  entries = rememberPopupSize(entries, laptop, { width: 1000, height: 700 });
  assert.deepEqual(Object.keys(entries), ['2560x1440', '1440x900']);
  assert.deepEqual(entries['1440x900'], { width: 1000, height: 700 });
});

test('saving past the limit evicts the oldest entry', () => {
  let entries = {};
  for (let i = 0; i <= POPUP_SIZE_MEMORY_LIMIT; i += 1) {
    entries = rememberPopupSize(entries, { width: 1000 + i, height: 800 }, { width: 500, height: 400 });
  }
  const keys = Object.keys(entries);
  assert.equal(keys.length, POPUP_SIZE_MEMORY_LIMIT);
  assert.ok(!keys.includes('1000x800'));
  assert.equal(keys.at(-1), `${1000 + POPUP_SIZE_MEMORY_LIMIT}x800`);
});

test('malformed stored data is ignored rather than breaking the popup', () => {
  assert.deepEqual(parsePopupSizeEntries(null), {});
  assert.deepEqual(parsePopupSizeEntries('not json'), {});
  assert.deepEqual(parsePopupSizeEntries('[1,2]'), {});
  assert.deepEqual(parsePopupSizeEntries('"text"'), {});
  assert.deepEqual(
    parsePopupSizeEntries(JSON.stringify({ a: { width: 1, height: 2 }, b: { width: 'x' }, c: null })),
    { a: { width: 1, height: 2 } },
  );
});

test('storage that throws is survived: nothing restored, save is a no-op', () => {
  const memory = createPopupSizeMemory(KEY, throwingStorage);
  assert.equal(memory.restore(laptop), null);
  assert.doesNotThrow(() => memory.saveUserResize(laptop, { width: 1000, height: 700 }));
});

test('missing storage (no window) behaves like an empty memory', () => {
  const memory = createPopupSizeMemory(KEY, undefined);
  assert.equal(memory.restore(laptop), null);
  assert.doesNotThrow(() => memory.saveUserResize(laptop, { width: 1000, height: 700 }));
});

test('without a window the default storage is absent', () => {
  const memory = createPopupSizeMemory(KEY);
  assert.equal(memory.restore(laptop), null);
});
