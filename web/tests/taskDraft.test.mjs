import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const { clearTaskDraft, readTaskDraft, saveTaskDraft, taskDraftStorageKey } = await import('../src/lib/taskDraft.ts');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('task drafts are stored separately for each project', () => {
  const storage = memoryStorage();
  saveTaskDraft('project-a', 'Draft for A', storage);
  saveTaskDraft('project-b', 'Draft for B', storage);

  assert.equal(readTaskDraft('project-a', storage), 'Draft for A');
  assert.equal(readTaskDraft('project-b', storage), 'Draft for B');
  assert.notEqual(taskDraftStorageKey('project-a'), taskDraftStorageKey('project-b'));
});

test('clearing a task draft removes it from browser storage', () => {
  const storage = memoryStorage();
  saveTaskDraft('project-a', 'Finished task', storage);
  clearTaskDraft('project-a', storage);

  assert.equal(readTaskDraft('project-a', storage), '');
});

test('saving an empty draft removes stale text', () => {
  const storage = memoryStorage();
  saveTaskDraft('project-a', 'No longer needed', storage);
  saveTaskDraft('project-a', '', storage);

  assert.equal(readTaskDraft('project-a', storage), '');
});

test('storage failures do not break the task composer', () => {
  const storage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };

  assert.equal(readTaskDraft('project-a', storage), '');
  assert.doesNotThrow(() => saveTaskDraft('project-a', 'Keep typing', storage));
  assert.doesNotThrow(() => clearTaskDraft('project-a', storage));
});
