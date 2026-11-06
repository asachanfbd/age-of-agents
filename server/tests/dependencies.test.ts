import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanItemRecord } from '../src/domain/types.ts';
import {
  DependencyConflictError, MAX_DEPENDENCY_DEPTH, MAX_PARENTS, assertAcyclicAndShallow, chainDependencies, compareStartOrder, evaluateParent,
  isReadyForDependencies, parseDependsOn, unsatisfiedReasons,
} from '../src/projects/dependencies.ts';
import type { ParentFacts } from '../src/projects/dependencies.ts';
import { taskLabel } from '../src/projects/dependencyService.ts';

/** Unit cases U1 to U27 of task 10.018: the satisfaction rule, the graph rules, start order and the chain builder. */

const parents = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

function facts(overrides: Partial<ParentFacts> = {}): ParentFacts {
  return {
    parentId: 'p1', label: '#12', exists: true, archived: false, runStatus: 'completed', autoMerge: null,
    lastCommitPresent: false, mergeCommitPresent: false, noCommits: false, prMerged: false,
    targetBranch: 'main', checkedOutBranch: 'main', sync: null, ...overrides,
  };
}
const reasonOf = (overrides: Partial<ParentFacts>) => {
  const verdict = evaluateParent(facts(overrides));
  assert.equal(verdict.satisfied, false);
  return (verdict as { reason: { text: string; blocked: boolean; action?: string } }).reason;
};

test('U1 a parent whose last commit is in the checked-out branch is satisfied', () => {
  assert.deepEqual(evaluateParent(facts({ lastCommitPresent: true })), { satisfied: true });
});

test('U2 a squash or rebase merge leaves the last commit absent but the merge commit present: satisfied', () => {
  assert.deepEqual(evaluateParent(facts({ mergeCommitPresent: true, prMerged: true })), { satisfied: true });
});

test('U3 neither commit present, PR open and no auto-merge: unsatisfied with the manual-merge reason and toggle action (U9)', () => {
  const reason = reasonOf({});
  assert.equal(reason.text, 'Parent #12 isn\'t set to auto-merge: merge it manually or turn auto-merge on');
  assert.equal(reason.action, 'toggle-auto-merge');
  assert.equal(reason.blocked, false);
});

test('U4 merged into another branch than the checked-out one: the wrong-branch reason', () => {
  assert.equal(reasonOf({ prMerged: true, targetBranch: 'main', checkedOutBranch: 'develop' }).text, 'Different branch checked out than main');
});

test('U5 a parent that finished with no commits is satisfied', () => {
  assert.deepEqual(evaluateParent(facts({ noCommits: true })), { satisfied: true });
});

test('U7 a re-run or Request changes puts a satisfied parent back to waiting', () => {
  assert.deepEqual(evaluateParent(facts({ lastCommitPresent: true })), { satisfied: true });
  for (const runStatus of ['running', 'awaiting-approval', 'starting', 'completing'] as const) {
    assert.equal(reasonOf({ lastCommitPresent: true, runStatus }).text, 'Waiting for #12 to finish');
  }
});

test('U8 a parent that has not started, or is still running, is waited for', () => {
  assert.equal(reasonOf({ runStatus: null }).text, 'Waiting for #12 to finish');
  assert.equal(reasonOf({ runStatus: 'running' }).text, 'Waiting for #12 to finish');
});

test('U10 a finished parent with auto-merge on is waited for until it is merged', () => {
  assert.equal(reasonOf({ autoMerge: { enabled: true, state: 'merging' } }).text, 'Waiting for #12 to be merged');
});

test('U11 merged on the remote but the local branch is behind: pull needed, with the sync action', () => {
  const reason = reasonOf({ prMerged: true, sync: { status: 'behind' } });
  assert.equal(reason.text, 'Waiting for main to receive #12 (pull needed)');
  assert.equal(reason.action, 'sync');
});

test('U12 a blocked pull names the blocker', () => {
  const reason = reasonOf({ prMerged: true, sync: { status: 'behind', deferredReason: 'not pulled: a task is running in the main folder' } });
  assert.match(reason.text, /pull needed\) \(not pulled: a task is running in the main folder\)/);
});

test('U13 no branch checked out (detached HEAD) gives the wrong-branch reason without crashing', () => {
  assert.equal(reasonOf({ prMerged: true, checkedOutBranch: null }).text, 'Different branch checked out than main');
});

test('U14 a failed, stopped or input-blocked parent blocks the child', () => {
  assert.equal(reasonOf({ runStatus: 'failed' }).text, 'Blocked: parent #12 failed');
  assert.equal(reasonOf({ runStatus: 'stopped' }).text, 'Blocked: parent #12 was stopped');
  const needs = reasonOf({ runStatus: 'needs-attention' });
  assert.equal(needs.text, 'Blocked: parent #12 needs input');
  assert.equal(needs.blocked, true);
  assert.equal(needs.action, 'retry-parent');
});

test('U15 a parent archived without a merge blocks; archived and merged is satisfied', () => {
  const blocked = reasonOf({ archived: true });
  assert.equal(blocked.text, 'Blocked: parent #12 was archived without being merged');
  assert.equal(blocked.action, 'remove-dependency');
  assert.equal(reasonOf({ archived: true, runStatus: null }).blocked, true);
  assert.deepEqual(evaluateParent(facts({ archived: true, lastCommitPresent: true, prMerged: true })), { satisfied: true });
});

test('U16 a deleted parent blocks and offers removing the dependency', () => {
  const reason = reasonOf({ exists: false });
  assert.equal(reason.text, 'Blocked: a parent task was deleted');
  assert.equal(reason.action, 'remove-dependency');
});

test('U17 a blocked parent outranks a merely waiting one in the displayed reasons', () => {
  const reasons = unsatisfiedReasons([
    evaluateParent(facts({ parentId: 'a', runStatus: 'running' })),
    { satisfied: true },
    evaluateParent(facts({ parentId: 'b', runStatus: 'failed' })),
  ]);
  assert.deepEqual(reasons.map((reason) => reason.parentId), ['b', 'a']);
});

test('U18/U19/U20 a self-dependency, a direct cycle and a three-task cycle are refused', () => {
  assert.throws(() => assertAcyclicAndShallow('a', ['a'], parents({})), DependencyConflictError);
  assert.throws(() => assertAcyclicAndShallow('a', ['b'], parents({ b: ['a'] })), /cycle/);
  assert.throws(() => assertAcyclicAndShallow('a', ['b'], parents({ b: ['c'], c: ['a'] })), /cycle/);
});

test('U21 a diamond (two parents sharing a grandparent) is allowed', () => {
  assertAcyclicAndShallow('d', ['b', 'c'], parents({ b: ['a'], c: ['a'] }));
});

test('U22 a chain exactly at the depth cap is accepted and one more is refused', () => {
  const chain: Record<string, string[]> = {};
  for (let i = 1; i < MAX_DEPENDENCY_DEPTH - 1; i += 1) chain[`t${i + 1}`] = [`t${i}`];
  assertAcyclicAndShallow(`t${MAX_DEPENDENCY_DEPTH}`, [`t${MAX_DEPENDENCY_DEPTH - 1}`], parents(chain));
  chain[`t${MAX_DEPENDENCY_DEPTH}`] = [`t${MAX_DEPENDENCY_DEPTH - 1}`];
  assert.throws(() => assertAcyclicAndShallow(`t${MAX_DEPENDENCY_DEPTH + 1}`, [`t${MAX_DEPENDENCY_DEPTH}`], parents(chain)), new RegExp(`at most ${MAX_DEPENDENCY_DEPTH} tasks`));
});

test('U22b the cap also counts the children below the changed task', () => {
  const chain: Record<string, string[]> = {};
  for (let i = 2; i <= MAX_DEPENDENCY_DEPTH; i += 1) chain[`t${i}`] = [`t${i - 1}`];
  assert.throws(() => assertAcyclicAndShallow('t1', ['top'], parents(chain)), /at most/);
});

test('U23 duplicate parent ids are deduplicated and ids trimmed', () => {
  assert.deepEqual(parseDependsOn(['a', ' a ', 'b']), ['a', 'b']);
});

test('I1 (parsing) malformed dependsOn values are refused', () => {
  for (const bad of [undefined, null, 'a', {}, [1], [''], ['  '], [['a']], Array.from({ length: MAX_PARENTS + 1 }, (_, i) => `t${i}`), Array.from({ length: 10_000 }, (_, i) => `t${i}`)]) {
    assert.equal(parseDependsOn(bad), null);
  }
  assert.deepEqual(parseDependsOn([]), []);
});

function item(id: string, extra: Partial<PlanItemRecord> = {}): PlanItemRecord {
  return {
    id, projectId: 'p', title: id, description: '', status: 'pending', order: 0, taskIds: [], milestoneId: null, workflowRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

test('U25 ready children start in planning order, then group order, then task number', () => {
  const standalone = item('standalone', { planningQueueOrder: 5 });
  const early = item('early', { planningQueueOrder: -3, planningRef: { session: 2, task: 4 } });
  const sameA = item('sameA', { planningQueueOrder: 1, planningGroupOrder: 2, planningRef: { session: 1, task: 3 } });
  const sameB = item('sameB', { planningQueueOrder: 1, planningGroupOrder: 1, planningRef: { session: 1, task: 9 } });
  const unqueued = item('unqueued', { planningRef: { session: 1, task: 1 } });
  const sorted = [unqueued, standalone, sameA, early, sameB].sort(compareStartOrder).map((entry) => entry.id);
  assert.deepEqual(sorted, ['early', 'sameB', 'sameA', 'standalone', 'unqueued']);
  const equal = [item('b', { planningQueueOrder: 1, createdAt: '2026-01-02T00:00:00.000Z' }), item('a', { planningQueueOrder: 1 })];
  assert.deepEqual(equal.sort(compareStartOrder).map((entry) => entry.id), ['a', 'b']);
});

test('U27 the chain builder links only ready tasks in group order and changes nothing else', () => {
  const group = [
    item('t1', { planningGroupOrder: 1, planningRef: { session: 1, task: 1 } }),
    item('t2', { planningGroupOrder: 2, planningRef: { session: 1, task: 2 } }),
    item('started', { status: 'developing', workflowRunId: 'r', planningGroupOrder: 3, planningRef: { session: 1, task: 3 } }),
    item('archived', { archived: true, planningRef: { session: 1, task: 4 } }),
    item('t5', { planningGroupOrder: 4, dependsOn: ['x'], planningRef: { session: 1, task: 5 } }),
  ];
  const snapshot = JSON.stringify(group);
  assert.deepEqual(chainDependencies(group), [{ itemId: 't2', dependsOn: ['t1'] }, { itemId: 't5', dependsOn: ['x', 't2'] }]);
  assert.equal(JSON.stringify(group), snapshot);
  assert.deepEqual(chainDependencies([]), []);
  assert.deepEqual(chainDependencies([group[0]!]), []);
  assert.equal(isReadyForDependencies(group[2]!), false);
});

test('task labels use the planning number when the title has one, else the title', () => {
  assert.equal(taskLabel({ title: '10.018: Dependent tasks' }), '#10.018');
  assert.equal(taskLabel({ title: 'B.3: A bug' }), '#B.3');
  assert.equal(taskLabel({ title: 'Plain task' }), '"Plain task"');
});

test('U22c a wide layered graph is judged quickly: depth is memoised per task, not per path', () => {
  const layers = MAX_DEPENDENCY_DEPTH;
  const width = 20;
  const graph: Record<string, string[]> = {};
  for (let layer = 1; layer < layers; layer += 1) {
    for (let i = 0; i < width; i += 1) graph[`l${layer}-${i}`] = Array.from({ length: width }, (_, j) => `l${layer - 1}-${j}`);
  }
  const topLayer = Array.from({ length: width }, (_, j) => `l${layers - 1}-${j}`);
  const started = Date.now();
  assert.throws(() => assertAcyclicAndShallow('top', topLayer, parents(graph)), /at most/);
  assert.ok(Date.now() - started < 1_000, 'no exponential walk');
  assertAcyclicAndShallow('top', Array.from({ length: width }, (_, j) => `l${layers - 2}-${j}`), parents(graph));
});

test('the chain builder leaves a task that is already waiting out of the chain', () => {
  const waiting = { options: {}, state: 'waiting' as const, reasons: [], since: '', longWaitNotified: false, updatedAt: '' };
  const group = [
    item('a', { planningGroupOrder: 1, planningRef: { session: 1, task: 1 } }),
    item('w', { planningGroupOrder: 2, waiting, planningRef: { session: 1, task: 2 } }),
    item('b', { planningGroupOrder: 3, planningRef: { session: 1, task: 3 } }),
  ];
  assert.deepEqual(chainDependencies(group), [{ itemId: 'b', dependsOn: ['a'] }]);
});
