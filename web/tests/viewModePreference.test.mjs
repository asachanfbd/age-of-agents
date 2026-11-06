import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_VIEW_MODE, VIEW_MODE_STORAGE_KEY, isViewMode, readViewMode, writeViewMode,
} from '../src/lib/viewModePreference.ts';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

const throwingStorage = {
  getItem() { throw new Error('storage blocked'); },
  setItem() { throw new Error('quota exceeded'); },
};

test('isViewMode accepts only the two supported modes', () => {
  assert.equal(isViewMode('world'), true);
  assert.equal(isViewMode('cards'), true);
  for (const value of ['', '3d', 'list', null, undefined, 1]) assert.equal(isViewMode(value), false);
});

test('the 3D world is the default view', () => {
  assert.equal(DEFAULT_VIEW_MODE, 'world');
  assert.equal(readViewMode(memoryStorage()), 'world');
});

test('a written mode is read back on the next load', () => {
  const storage = memoryStorage();
  writeViewMode('cards', storage);
  assert.equal(storage.values.get(VIEW_MODE_STORAGE_KEY), 'cards');
  assert.equal(readViewMode(storage), 'cards');
});

test('an unrecognised stored value falls back to the default', () => {
  assert.equal(readViewMode(memoryStorage({ [VIEW_MODE_STORAGE_KEY]: 'hologram' })), 'world');
});

test('missing or failing storage never throws', () => {
  assert.equal(readViewMode(undefined), 'world');
  assert.equal(readViewMode(throwingStorage), 'world');
  assert.doesNotThrow(() => writeViewMode('cards', throwingStorage));
  assert.doesNotThrow(() => writeViewMode('cards', undefined));
});
