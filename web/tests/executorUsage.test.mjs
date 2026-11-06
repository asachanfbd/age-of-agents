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
const { sortExecutorsByUsage } = await import('../src/lib/executorUsage.ts');

const executor = (id, totalTokens, patch = {}) => ({
  id,
  label: id,
  kind: 'claude-cli',
  usage: { totalTokens, taskCount: totalTokens > 0 ? 1 : 0 },
  ...patch,
});

test('sortExecutorsByUsage returns an empty list for no executors', () => {
  assert.deepEqual(sortExecutorsByUsage([]), []);
});

test('sortExecutorsByUsage puts the most-used executor first', () => {
  const executors = [executor('low', 10), executor('high', 500), executor('mid', 100)];
  assert.deepEqual(sortExecutorsByUsage(executors).map((e) => e.id), ['high', 'mid', 'low']);
});

test('sortExecutorsByUsage breaks ties by label so unused executors keep a stable order', () => {
  const executors = [executor('zebra', 0), executor('apple', 0), executor('mango', 0)];
  assert.deepEqual(sortExecutorsByUsage(executors).map((e) => e.id), ['apple', 'mango', 'zebra']);
});

test('sortExecutorsByUsage does not mutate the input array', () => {
  const executors = [executor('low', 10), executor('high', 500)];
  const original = executors.slice();
  sortExecutorsByUsage(executors);
  assert.deepEqual(executors, original);
});
