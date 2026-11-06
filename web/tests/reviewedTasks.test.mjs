import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_REVIEWED_TASKS, REVIEWED_TASKS_STORAGE_KEY, readReviewedTaskIds, writeReviewedTaskIds,
} from '../src/lib/reviewedTasks.ts';

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

test('nothing is reviewed when storage is empty or unavailable', () => {
  assert.deepEqual(readReviewedTaskIds(memoryStorage()), {});
  assert.deepEqual(readReviewedTaskIds(undefined), {});
  assert.deepEqual(readReviewedTaskIds(throwingStorage), {});
});

test('reviewed task ids survive a write and a later read', () => {
  const storage = memoryStorage();
  writeReviewedTaskIds({ 'task-1': true, 'task-2': true }, storage);
  assert.deepEqual(readReviewedTaskIds(storage), { 'task-1': true, 'task-2': true });
});

test('a corrupt or wrongly shaped stored value reads as nothing reviewed', () => {
  for (const stored of ['not json', '{"task-1":true}', '"task-1"', 'null']) {
    assert.deepEqual(readReviewedTaskIds(memoryStorage({ [REVIEWED_TASKS_STORAGE_KEY]: stored })), {});
  }
});

test('non-string entries in the stored list are ignored', () => {
  const storage = memoryStorage({ [REVIEWED_TASKS_STORAGE_KEY]: JSON.stringify(['task-1', 7, null, 'task-2']) });
  assert.deepEqual(readReviewedTaskIds(storage), { 'task-1': true, 'task-2': true });
});

test('only the newest marks are stored once the cap is passed', () => {
  const storage = memoryStorage();
  const reviewed = Object.fromEntries(Array.from({ length: MAX_REVIEWED_TASKS + 2 }, (_, index) => [`task-${index}`, true]));
  writeReviewedTaskIds(reviewed, storage);
  const stored = readReviewedTaskIds(storage);
  assert.equal(Object.keys(stored).length, MAX_REVIEWED_TASKS);
  assert.equal(stored['task-0'], undefined);
  assert.equal(stored['task-1'], undefined);
  assert.equal(stored[`task-${MAX_REVIEWED_TASKS + 1}`], true);
});

test('a failing write is swallowed, and a missing storage is a no-op', () => {
  assert.doesNotThrow(() => writeReviewedTaskIds({ 'task-1': true }, throwingStorage));
  assert.doesNotThrow(() => writeReviewedTaskIds({ 'task-1': true }, undefined));
});
