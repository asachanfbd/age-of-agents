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
const { groupTaskChains, chainFor, chainHistoryIds } = await import('../src/lib/taskChain.ts');

const task = (id, patch = {}) => ({
  id,
  projectId: 'p1',
  executorId: 'test-claude',
  description: id,
  status: 'done',
  kind: 'execute',
  planItemId: null,
  blockedQuestion: null,
  failureReason: null,
  ...patch,
});

test('groupTaskChains puts a Task with no follow-ups in its own single-item chain', () => {
  const t1 = task('t1');
  const chains = groupTaskChains(['t1'], { t1 }, 'execute');
  assert.deepEqual(chains, [[t1]]);
});

test('groupTaskChains links a followed-up Task to its prior Task via conversationId, most-recent-first', () => {
  // followUpTask sets the new Task's conversationId to the prior's conversationId ?? sessionId ?? id
  // (server/src/worker/workerManager.ts) — t1 has no conversationId of its own, so t2 links via
  // t1's sessionId, and that becomes the shared chain key for both.
  const t1 = task('t1', { sessionId: 'sess-1' });
  const t2 = task('t2', { conversationId: 'sess-1', sessionId: 'sess-1', description: 'follow-up' });
  // taskIdsByProject is most-recent-first — see worldStore.ts.
  const tasksById = { t1, t2 };
  const chains = groupTaskChains(['t2', 't1'], tasksById, 'execute');

  assert.equal(chains.length, 1, 'both Tasks land in one chain, not two');
  assert.deepEqual(chains[0], [t2, t1], 'most-recent (the follow-up) first');
});

test('groupTaskChains keeps chains of a different kind separate even when ids collide across kinds', () => {
  const plan = task('shared-id', { kind: 'plan' });
  const execute = task('other-id', { kind: 'execute' });
  const tasksById = { 'shared-id': plan, 'other-id': execute };

  const planChains = groupTaskChains(['shared-id', 'other-id'], tasksById, 'plan');
  const executeChains = groupTaskChains(['shared-id', 'other-id'], tasksById, 'execute');

  assert.deepEqual(planChains, [[plan]]);
  assert.deepEqual(executeChains, [[execute]]);
});

test('groupTaskChains ignores an id missing from tasksById rather than throwing', () => {
  const t1 = task('t1');
  const chains = groupTaskChains(['t1', 'ghost'], { t1 }, 'execute');
  assert.deepEqual(chains, [[t1]]);
});

test('groupTaskChains separates two independent (non-linked) chains of the same kind', () => {
  const a = task('a', { sessionId: 'sess-a' });
  const b = task('b', { sessionId: 'sess-b' });
  const chains = groupTaskChains(['b', 'a'], { a, b }, 'execute');
  assert.equal(chains.length, 2);
});

test('chainFor finds the chain containing a given taskId, regardless of which link is passed', () => {
  const t1 = task('t1', { sessionId: 'sess-1' });
  const t2 = task('t2', { conversationId: 'sess-1', sessionId: 'sess-1' });
  const chains = groupTaskChains(['t2', 't1'], { t1, t2 }, 'execute');

  assert.deepEqual(chainFor('t1', chains), [t2, t1]);
  assert.deepEqual(chainFor('t2', chains), [t2, t1]);
});

test('chainFor returns undefined when the taskId is not in any chain (e.g. still loading)', () => {
  assert.equal(chainFor('unknown', []), undefined);
});

test('chainHistoryIds returns every earlier linked Task, oldest-first, excluding the chain head', () => {
  const t1 = task('t1', { sessionId: 'sess-1' });
  const t2 = task('t2', { conversationId: 'sess-1', sessionId: 'sess-1' });
  const t3 = task('t3', { conversationId: 'sess-1', sessionId: 'sess-1' });
  // most-recent-first, as a chain is built.
  const chain = [t3, t2, t1];

  assert.deepEqual(chainHistoryIds(chain), ['t1', 't2']);
});

test('chainHistoryIds is empty for a single-Task chain and for undefined (chain not found yet)', () => {
  assert.deepEqual(chainHistoryIds([task('t1')]), []);
  assert.deepEqual(chainHistoryIds(undefined), []);
});
