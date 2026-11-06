import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeExecutorUsage } from '../src/executors/executorUsage.ts';
import type { ExecutorProfile, TaskRecord, TokenUsage } from '../src/domain/types.ts';

const executor = (id: string, label = id): ExecutorProfile => ({ id, label, kind: 'claude-cli', bin: 'claude', env: {} });

const usage = (patch: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
  ...patch,
});

const task = (executorId: string, tokenUsage: TaskRecord['tokenUsage']): TaskRecord => ({
  id: `${executorId}-${Math.random()}`,
  projectId: 'p1',
  templateId: 't1',
  executorId,
  description: 'do a thing',
  status: 'done',
  autonomy: 'auto',
  manager: false,
  kind: 'execute',
  planItemId: null,
  sessionId: null,
  blockedQuestion: null,
  failureReason: null,
  tokenUsage,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
});

test('summarizeExecutorUsage reports zero usage for an executor with no Tasks', () => {
  const result = summarizeExecutorUsage([executor('a')], []);
  assert.deepEqual(result, [{ ...executor('a'), usage: { totalTokens: 0, taskCount: 0 } }]);
});

test('summarizeExecutorUsage sums every token field across every Task for the same executor', () => {
  const tasks = [
    task('a', usage({ inputTokens: 100, outputTokens: 40 })),
    task('a', usage({ cacheCreationInputTokens: 5, cacheReadInputTokens: 20 })),
  ];
  const [result] = summarizeExecutorUsage([executor('a')], tasks);
  assert.deepEqual(result!.usage, { totalTokens: 165, taskCount: 2 });
});

test('summarizeExecutorUsage keeps each executor\'s usage separate', () => {
  const tasks = [task('a', usage({ inputTokens: 100 })), task('b', usage({ inputTokens: 5 }))];
  const result = summarizeExecutorUsage([executor('a'), executor('b')], tasks);
  assert.equal(result.find((e) => e.id === 'a')?.usage.totalTokens, 100);
  assert.equal(result.find((e) => e.id === 'b')?.usage.totalTokens, 5);
});

test('summarizeExecutorUsage counts a Task with no usage data toward taskCount but contributes zero tokens', () => {
  const tasks = [task('a', undefined as unknown as TokenUsage)];
  const [result] = summarizeExecutorUsage([executor('a')], tasks);
  assert.deepEqual(result!.usage, { totalTokens: 0, taskCount: 1 });
});

test('summarizeExecutorUsage ignores Tasks belonging to an executor no longer configured', () => {
  const tasks = [task('unknown-executor', usage({ inputTokens: 50 }))];
  const result = summarizeExecutorUsage([executor('a')], tasks);
  assert.deepEqual(result, [{ ...executor('a'), usage: { totalTokens: 0, taskCount: 0 } }]);
});
