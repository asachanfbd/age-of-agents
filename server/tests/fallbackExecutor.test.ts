import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { ExecutorProfile } from '../src/domain/types.ts';
import { DefaultExecutorService } from '../src/executors/defaultExecutor.ts';
import { ExecutorNotFoundError } from '../src/executors/executorService.ts';
import { createFallbackExecutor } from '../src/executors/fallbackExecutor.ts';
import { defaultAgentUsage } from '../src/scheduler/defaultAgentUsage.ts';

/** Bug 19.001.001: a run started with no agent choice uses the owner's selected default, not the first configured agent. */

const cli = (id: string): ExecutorProfile => ({ id, label: id.toUpperCase(), kind: 'claude-cli', bin: 'claude', env: {} });
const A = cli('a');
const B = cli('b');
const NOT_CLI = { id: 'odd', label: 'Odd', kind: 'unsupported', bin: 'x', env: {} } as unknown as ExecutorProfile;

const resolverFor = (stored: string | null, executors: ExecutorProfile[]) =>
  createFallbackExecutor({ current: async () => stored, listExecutors: async () => executors });

test('the stored default wins over the first configured agent', async () => {
  assert.equal((await resolverFor('b', [A, B])()).id, 'b');
});

test('with no stored default, the first configured CLI agent is used', async () => {
  assert.equal((await resolverFor(null, [A, B])()).id, 'a');
});

test('a stored default that was removed falls back to the first CLI agent without throwing', async () => {
  assert.equal((await resolverFor('gone', [A, B])()).id, 'a');
});

test('a stored default that is not a CLI kind falls back to the first CLI agent, skipping non-CLI entries', async () => {
  assert.equal((await resolverFor('odd', [NOT_CLI, B])()).id, 'b');
});

test('no CLI agent configured at all is an ExecutorNotFoundError', async () => {
  await assert.rejects(resolverFor(null, [NOT_CLI])(), ExecutorNotFoundError);
  await assert.rejects(resolverFor(null, [])(), ExecutorNotFoundError);
});

test('resolving the fallback never reads any agent\'s quota, whether a default is stored, absent or removed', async () => {
  let reads = 0;
  let stored: { executorId: string; label: string } | undefined;
  const service = new DefaultExecutorService({
    listExecutors: async () => [A, B],
    readLimits: async () => { reads += 1; return null; },
    store: {
      get: async () => stored ? { id: 'default', ...stored } : undefined,
      set: async (value) => { stored = value; },
      clear: async () => { stored = undefined; },
    },
    raise: async () => {},
    resolve: async () => {},
  });
  const resolve = createFallbackExecutor({ current: () => service.current(), listExecutors: async () => [A, B] });
  assert.equal((await resolve()).id, 'a');
  stored = { executorId: 'b', label: 'B' };
  assert.equal((await resolve()).id, 'b');
  stored = { executorId: 'gone', label: 'Gone' };
  assert.equal((await resolve()).id, 'a');
  assert.equal(reads, 0);
  const source = await readFile(path.join(import.meta.dirname, '..', 'src', 'executors', 'fallbackExecutor.ts'), 'utf-8');
  assert.doesNotMatch(source, /claudeUsage|\.recheck\(|readLimits/);
});

test('the scheduler gates on the usage of the resolved default agent', async () => {
  const limits = { observedAt: 1, fiveHour: null, sevenDay: null };
  const asked: string[] = [];
  const usage = await defaultAgentUsage(resolverFor('b', [A, B]), async (executor) => { asked.push(executor.id); return limits; });
  assert.deepEqual(asked, ['b']);
  assert.equal(usage, limits);
});
