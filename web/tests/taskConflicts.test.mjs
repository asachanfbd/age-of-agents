import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
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

const { taskConflictOf, conflictView } = await import('../src/lib/taskConflicts.ts');
const { ApiError } = await import('../src/lib/serverApi.ts');

const limitDetails = (overrides = {}) => ({
  projectName: 'Age of Agents', limit: 6, inUse: 2, hasRepository: true,
  occupants: [
    { taskId: 't1', planItemId: 'p1', number: '4.002', title: 'Fix login', state: 'running' },
    { taskId: 't2', planItemId: 'p2', number: null, title: 'Write docs', state: 'waiting_input' },
  ],
  ...overrides,
});
const refusal = (code, details) => new ApiError('text', 409, { error: 'text', code, details });

test('the three situations are told apart by code, not by message text', () => {
  assert.equal(taskConflictOf(refusal('task_limit_reached', limitDetails())).kind, 'limit');
  assert.equal(taskConflictOf(refusal('session_still_running', { taskId: 't', title: 'Plan' })).kind, 'session');
  assert.equal(taskConflictOf(new ApiError('Project is at its limit', 409, { error: 'x' })), null);
  assert.equal(taskConflictOf(new ApiError('boom', 500, { code: 'task_limit_reached', details: limitDetails() })), null);
  assert.equal(taskConflictOf(new Error('plain')), null);
});

test('the limit message states the limit, lists the occupants with their states, and never mentions documentation', () => {
  const view = conflictView(taskConflictOf(refusal('task_limit_reached', limitDetails())), {});
  assert.equal(view.title, 'Age of Agents is running its maximum of 6 tasks');
  assert.match(view.body, /waiting for your input still count/);
  assert.match(view.body, /stop one/);
  assert.deepEqual(view.rows.map((row) => [row.label, row.stateLabel]), [['4.002 Fix login', 'Running'], ['Write docs', 'Waiting for your input']]);
  assert.deepEqual(view.rows[0].target, { taskId: 't1', planItemId: 'p1' });
  assert.doesNotMatch(`${view.title} ${view.body}`, /docs\/|\.md|architecture/);
});

test('a project without a repository explains why it allows one task and how to lift that', () => {
  const view = conflictView(taskConflictOf(refusal('task_limit_reached', limitDetails({ limit: 1, hasRepository: false, occupants: [limitDetails().occupants[0]] }))), {});
  assert.equal(view.title, 'Age of Agents can run only one task at a time');
  assert.match(view.body, /no linked repository/);
  assert.match(view.body, /link a repository/);
});

test('the list follows live tasks: a finished task drops out, a blocked one shows as waiting, and a free slot becomes retryable', () => {
  const conflict = taskConflictOf(refusal('task_limit_reached', limitDetails({ limit: 2 })));
  assert.equal(conflictView(conflict, {}).retryable, false);
  const live = conflictView(conflict, { t1: { status: 'blocked' }, t2: { status: 'developing' } });
  assert.deepEqual(live.rows.map((row) => row.stateLabel), ['Waiting for your input', 'Running']);
  const freed = conflictView(conflict, { t1: { status: 'done' }, t2: { status: 'developing' } });
  assert.deepEqual(freed.rows.map((row) => row.key), ['t2']);
  assert.equal(freed.retryable, true);
});

test('a run still starting stays labelled Starting while its task is developing', () => {
  const conflict = taskConflictOf(refusal('task_limit_reached', limitDetails({ occupants: [{ taskId: 't1', planItemId: null, number: null, title: 'Boot', state: 'starting' }] })));
  assert.equal(conflictView(conflict, { t1: { status: 'developing' } }).rows[0].stateLabel, 'Starting');
});

test('the still-running session message names the session and offers to open it', () => {
  const view = conflictView(taskConflictOf(refusal('session_still_running', { taskId: 'plan-1', title: 'Plan login' })), {});
  assert.equal(view.title, 'This planning session is still running');
  assert.match(view.body, /Plan login/);
  assert.deepEqual(view.rows[0].target, { taskId: 'plan-1', planItemId: null });
  assert.equal(view.retryable, false);
  assert.match(conflictView({ kind: 'session', details: { taskId: 'p', title: '' } }, {}).body, /^The session is still running/);
});
