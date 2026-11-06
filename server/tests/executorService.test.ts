import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';

let executorService: typeof import('../src/executors/executorService.ts');

before(async () => {
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  executorService = await import('../src/executors/executorService.ts');
});

test('listExecutors reads the configured fixture, claude-cli and codex-cli entries alike', async () => {
  const executors = await executorService.listExecutors();
  assert.ok(executors.some((e) => e.id === 'test-claude-cli' && e.kind === 'claude-cli'));
  assert.ok(executors.some((e) => e.id === 'test-codex-cli' && e.kind === 'codex-cli'));
});

test('getExecutor finds by id and returns undefined for an unknown one', async () => {
  assert.equal((await executorService.getExecutor('test-claude-cli'))?.label, 'Test Claude CLI');
  assert.equal(await executorService.getExecutor('does-not-exist'), undefined);
});

test('getDefaultExecutor returns the first configured entry', async () => {
  const [first] = await executorService.listExecutors();
  assert.deepEqual(await executorService.getDefaultExecutor(), first);
});
