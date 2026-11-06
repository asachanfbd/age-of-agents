import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginStartupStep,
  currentStartupStep,
  failStartupStep,
  finishStartupStep,
  isStartupIncomplete,
  normalizeStartup,
  planStartup,
  resetStartup,
  startupKindOf,
} from '../src/worker/runStartup.ts';
import { UNSETTLED_RUN_STATUSES } from '../src/worker/projectFolderGuard.ts';

const ids = (kind: Parameters<typeof planStartup>[0]) => planStartup(kind, false).steps.map((step) => step.id);

test('U14-U17 the step plan: a new branch has all four steps in order, a conflict run has no naming step, an in-place run only launches', () => {
  assert.deepEqual(ids('branch'), ['name', 'worktree', 'hooks', 'launch']);
  assert.deepEqual(ids('conflict'), ['worktree', 'hooks', 'launch']);
  assert.deepEqual(ids('in-place'), ['launch']);
  assert.deepEqual(planStartup('branch', false).steps.map((step) => step.name), [
    'Choosing branch name', 'Creating worktree', 'Installing CLI hooks', 'Launching agent',
  ]);
  for (const kind of ['branch', 'conflict', 'in-place'] as const) assert.equal(startupKindOf(planStartup(kind, false)), kind);
});

test('U19 steps go pending to running to done; a failure records its reason and leaves later steps pending', () => {
  let startup = planStartup('branch', true);
  assert.equal(startup.reuseBranch, true);
  startup = beginStartupStep(startup, 'name');
  assert.equal(currentStartupStep(startup)!.id, 'name');
  startup = failStartupStep(startup, 'name', 'boom');
  assert.deepEqual(startup.steps.map((step) => step.state), ['failed', 'pending', 'pending', 'pending']);
  assert.equal(startup.steps[0]!.reason, 'boom');
  assert.equal(currentStartupStep(startup)!.id, 'name', 'a failed step reads as current when nothing is running');
  assert.equal(isStartupIncomplete(startup), true);
  assert.deepEqual(resetStartup(startup).steps.map((step) => step.state), ['pending', 'pending', 'pending', 'pending']);
  assert.equal(resetStartup(startup).steps[0]!.reason, undefined);
});

test('isStartupIncomplete is false for no start-up (a record from before this phase) and for one whose steps all finished', () => {
  assert.equal(isStartupIncomplete(undefined), false);
  const done = planStartup('in-place', false);
  assert.equal(isStartupIncomplete(finishStartupStep(done, 'launch')), false);
});

const legacyStartup = (stackState: 'done' | 'pending') => ({
  reuseBranch: false,
  steps: [
    { id: 'stack', name: "Checking previous task's branch", state: stackState },
    ...planStartup('branch', false).steps,
  ],
}) as unknown as Parameters<typeof normalizeStartup>[0];
test('a start-up saved with the old stack step reads as the current plan, whether that step was done or still pending', () => {
  for (const stackState of ['done', 'pending'] as const) {
    const legacy = legacyStartup(stackState);
    assert.deepEqual(normalizeStartup(legacy).steps.map((step) => step.id), ['name', 'worktree', 'hooks', 'launch']);
    assert.equal(startupKindOf(normalizeStartup(legacy)), 'branch');
    assert.equal(isStartupIncomplete(legacy), true, 'the remaining steps are still pending');
    assert.deepEqual(resetStartup(legacy).steps.map((step) => step.id), ['name', 'worktree', 'hooks', 'launch']);
  }
});

test('a legacy start-up whose stack step is the only unfinished one is not incomplete', () => {
  const finished = planStartup('branch', false);
  const legacy = { ...finished, steps: [{ id: 'stack', name: 'x', state: 'pending' }, ...finished.steps.map((step) => ({ ...step, state: 'done' }))] } as unknown as Parameters<typeof normalizeStartup>[0];
  assert.equal(isStartupIncomplete(legacy), false);
});

test('U24 a starting run is unsettled, so the folder guard and archive/delete rules count it', () => {
  assert.ok(UNSETTLED_RUN_STATUSES.includes('starting'));
});
