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

const { buildCompletedRows } = await import('../src/lib/projectTasks.ts');
const {
  buildTaskGroups,
  findWorkflowRun,
  isBlockedWaiting,
  needsYouSeverity,
} = await import('../src/lib/workflowTaskGroups.ts');

const NOW = new Date('2026-09-26T12:00:00.000Z').getTime();
const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString();

const usage = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });

const task = (id, patch = {}) => ({
  id,
  projectId: 'p1',
  executorId: 'exec-claude',
  executionMode: 'terminal',
  description: id,
  status: 'done',
  kind: 'execute',
  planItemId: null,
  sessionId: 'sess',
  blockedQuestion: null,
  failureReason: null,
  tokenUsage: usage(),
  createdAt: minutesAgo(60),
  updatedAt: minutesAgo(30),
  completedAt: minutesAgo(30),
  ...patch,
});

const item = (id, patch = {}) => ({
  id,
  projectId: 'p1',
  title: `Item ${id}`,
  description: '',
  status: 'pending',
  order: 0,
  taskIds: [],
  executorId: null,
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(600),
  ...patch,
});

const byId = (...tasks) => Object.fromEntries(tasks.map((t) => [t.id, t]));

const step = (id, name) => ({ id, name, agentId: 'agent-1', instructions: '', canEditCode: true, requiresApproval: false });

const run = (id, patch = {}) => ({
  id,
  projectId: 'p1',
  planItemId: 'i1',
  workflowId: 'wf1',
  workflowSnapshot: {
    id: 'wf1',
    name: 'Software development',
    description: '',
    enabled: true,
    steps: [step('ui', 'UI Planning'), step('dev', 'Development')],
  },
  status: 'running',
  currentStepId: null,
  executorId: 'exec-claude',
  prUrl: null,
  completionReport: null,
  attentionReason: null,
  loopRoundAllowance: 0,
  createdAt: minutesAgo(60),
  updatedAt: minutesAgo(1),
  completedAt: null,
  ...patch,
});

function groupsFor(items, tasks, runs) {
  return buildTaskGroups({
    items,
    tasksById: byId(...tasks),
    workflowRunsByProject: { p1: runs },
    projectId: 'p1',
    showArchived: false,
    now: NOW,
  });
}

test('a row whose run is awaiting-approval, needs-attention or failed lands in Needs-you', () => {
  const items = [
    item('a', { status: 'developing', taskIds: ['ta'], workflowRunId: 'ra' }),
    item('b', { status: 'developing', taskIds: ['tb'], workflowRunId: 'rb' }),
    item('c', { status: 'stopped', taskIds: ['tc'], workflowRunId: 'rc' }),
  ];
  const tasks = [task('ta', { status: 'developing', completedAt: null }), task('tb', { status: 'developing', completedAt: null }), task('tc', { status: 'stopped' })];
  const runs = [run('ra', { status: 'awaiting-approval' }), run('rb', { status: 'needs-attention' }), run('rc', { status: 'failed' })];
  const groups = groupsFor(items, tasks, runs);
  assert.deepEqual(groups.needsYou.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(groups.running, []);
  assert.deepEqual(groups.open, []);
});

test('a row whose run is running or completing lands in Running', () => {
  const items = [
    item('a', { status: 'developing', taskIds: ['ta'], workflowRunId: 'ra' }),
    item('b', { status: 'developing', taskIds: ['tb'], workflowRunId: 'rb' }),
  ];
  const tasks = [task('ta', { status: 'developing', completedAt: null }), task('tb', { status: 'developing', completedAt: null })];
  const runs = [run('ra', { status: 'running' }), run('rb', { status: 'completing' })];
  const groups = groupsFor(items, tasks, runs);
  assert.deepEqual(groups.running.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(groups.needsYou, []);
});

test('a row whose run was stopped (its item blocked) lands in Needs-you, with Resume as its card action', () => {
  const items = [item('a', { status: 'blocked', taskIds: ['ta'], workflowRunId: 'ra' })];
  const tasks = [task('ta', { status: 'stopped' })];
  const runs = [run('ra', { status: 'stopped' })];
  const groups = groupsFor(items, tasks, runs);
  assert.deepEqual(groups.needsYou.map((r) => [r.id, r.primary]), [['a', 'resume']]);
  assert.deepEqual(groups.open, []);
  assert.deepEqual(groups.running, []);
  assert.equal(needsYouSeverity(groups.needsYou[0], runs[0]), 'input', 'amber, not red');
});

test('archived items are left out of every column', () => {
  const items = [
    item('new', { archived: true }),
    item('running', { status: 'developing', taskIds: ['tr'], workflowRunId: 'rr', archived: true }),
    item('stopped', { status: 'blocked', taskIds: ['ts'], workflowRunId: 'rs', archived: true }),
    item('kept'),
  ];
  const tasks = [task('tr', { status: 'developing' }), task('ts', { status: 'stopped' })];
  const groups = groupsFor(items, tasks, [run('rr', { status: 'running' }), run('rs', { status: 'stopped' })]);
  assert.deepEqual([...groups.open, ...groups.running, ...groups.needsYou].map((r) => r.id), ['kept']);
});

test('a row with no workflowRunId falls back to today\'s classification: blocked goes to Needs-you, everything else (including failed) stays in New (open)', () => {
  const items = [
    item('blocked', { status: 'blocked', taskIds: ['tb'] }),
    item('failed', { status: 'failed', taskIds: ['tf'] }),
    item('fresh'),
  ];
  const tasks = [task('tb', { status: 'blocked', completedAt: null }), task('tf', { status: 'failed', sessionId: null })];
  const groups = groupsFor(items, tasks, []);
  assert.deepEqual(groups.needsYou.map((r) => r.id), ['blocked']);
  assert.deepEqual(groups.open.map((r) => r.id).sort(), ['failed', 'fresh']);
  assert.deepEqual(groups.running, []);
});

test('a row is matched to its run by id, not just by being in the project\'s run list', () => {
  const items = [item('a', { taskIds: [], workflowRunId: 'ra' })];
  // Two runs on the project; only 'ra' belongs to this row.
  const runs = [run('other', { status: 'failed' }), run('ra', { status: 'running' })];
  const groups = groupsFor(items, [], runs);
  assert.deepEqual(groups.running.map((r) => r.id), ['a']);
  assert.deepEqual(groups.needsYou, []);
});

test('findWorkflowRun is null with no workflowRunId, or when the id is not among the given runs', () => {
  assert.equal(findWorkflowRun({ workflowRunId: null }, [run('a')]), null);
  assert.equal(findWorkflowRun({ workflowRunId: 'missing' }, [run('a')]), null);
  assert.equal(findWorkflowRun({ workflowRunId: 'a' }, [run('a')]).id, 'a');
});

test('needsYouSeverity is red for a failed run, amber for anything else needing a decision, and the row\'s own attention with no run', () => {
  assert.equal(needsYouSeverity({ attention: null }, run('a', { status: 'failed' })), 'failed');
  assert.equal(needsYouSeverity({ attention: null }, run('a', { status: 'awaiting-approval' })), 'input');
  assert.equal(needsYouSeverity({ attention: 'input' }, null), 'input');
  assert.equal(needsYouSeverity({ attention: null }, null), null);
});

test('an item whose run completed lands in Completed, never New, even when its own status still says developing', () => {
  const items = [item('i1', { status: 'developing', taskIds: ['t1'], workflowRunId: 'r1' })];
  const tasksById = byId(task('t1', { planItemId: 'i1', workflowRunId: 'r1' }));
  const runs = [run('r1', { status: 'completed' })];

  const groups = buildTaskGroups({ items, tasksById, workflowRunsByProject: { p1: runs }, projectId: 'p1', showArchived: false, now: NOW });
  assert.deepEqual([groups.open, groups.running, groups.needsYou].map((rows) => rows.length), [0, 0, 0]);

  const completed = buildCompletedRows({ items, taskIds: ['t1'], tasksById, workflowRuns: runs, now: NOW });
  assert.deepEqual(completed.map((row) => [row.id, row.kind]), [['i1', 'item']]);
});

test('without its runs, Completed still only lists items marked done', () => {
  const items = [item('i1', { status: 'developing', workflowRunId: 'r1' }), item('i2', { status: 'done' })];
  assert.deepEqual(buildCompletedRows({ items, taskIds: [], tasksById: {}, now: NOW }).map((row) => row.id), ['i2']);
});

const autoMerge = (state) => ({ enabled: true, state, reasons: [], prNumber: 7, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: minutesAgo(1) });
const finishedWithAutoMerge = (state, patch = {}) => item('i1', { status: 'done', taskIds: ['t1'], workflowRunId: 'r1', autoMerge: autoMerge(state), ...patch });
const projection = (items) => {
  const tasksById = byId(task('t1', { planItemId: 'i1', workflowRunId: 'r1' }));
  const runs = [run('r1', { status: 'completed' })];
  const groups = buildTaskGroups({ items, tasksById, workflowRunsByProject: { p1: runs }, projectId: 'p1', showArchived: false, now: NOW });
  const completed = buildCompletedRows({ items, taskIds: ['t1'], tasksById, workflowRuns: runs, now: NOW });
  return { groups, completed: completed.map((row) => row.id) };
};

for (const state of ['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent']) {
  test(`a finished Auto-merge task whose PR is ${state} sits in "PR not merged yet", not Completed`, () => {
    const { groups, completed } = projection([finishedWithAutoMerge(state)]);
    assert.deepEqual(groups.prNotMerged.map((row) => row.id), ['i1']);
    assert.equal(groups.prNotMerged[0].primary, 'none');
    assert.deepEqual([groups.needsYou, groups.running, groups.open].map((rows) => rows.length), [0, 0, 0]);
    assert.deepEqual(completed, []);
  });
}

for (const state of ['failed', 'cannot-merge', 'no-pr']) {
  test(`a finished Auto-merge task in state ${state} needs you, with red severity`, () => {
    const { groups, completed } = projection([finishedWithAutoMerge(state)]);
    assert.deepEqual(groups.needsYou.map((row) => row.id), ['i1']);
    assert.equal(groups.prNotMerged.length, 0);
    assert.deepEqual(completed, []);
    assert.equal(needsYouSeverity(groups.needsYou[0], run('r1', { status: 'completed' })), 'failed');
  });
}

test('a merged Auto-merge task is Completed', () => {
  const { groups, completed } = projection([finishedWithAutoMerge('merged')]);
  assert.deepEqual([groups.needsYou, groups.prNotMerged, groups.running, groups.open].map((rows) => rows.length), [0, 0, 0, 0]);
  assert.deepEqual(completed, ['i1']);
});

test('with Auto-merge off, or on a run-less or conflict item, a finished task is Completed', () => {
  const off = { ...autoMerge('merging'), enabled: false };
  assert.deepEqual(projection([finishedWithAutoMerge('merging', { autoMerge: off })]).completed, ['i1']);
  assert.deepEqual(projection([finishedWithAutoMerge('merging', { workflowRunId: undefined })]).completed, ['i1']);
  assert.deepEqual(projection([finishedWithAutoMerge('merging', { prConflict: { prNumber: 1 } })]).completed, ['i1']);
});

test('a task whose run completed but whose item still says developing is held too', () => {
  const { groups, completed } = projection([finishedWithAutoMerge('merging', { status: 'developing' })]);
  assert.deepEqual(groups.prNotMerged.map((row) => row.id), ['i1']);
  assert.deepEqual(completed, []);
});

test('an archived held task is on neither board row', () => {
  const { groups } = projection([finishedWithAutoMerge('merging', { archived: true })]);
  assert.equal(groups.prNotMerged.length, 0);
});

test('a task still running with Auto-merge waiting stays in Running', () => {
  const items = [item('i1', { status: 'developing', taskIds: ['t1'], workflowRunId: 'r1', autoMerge: autoMerge('waiting') })];
  const groups = buildTaskGroups({ items, tasksById: byId(task('t1', { planItemId: 'i1', status: 'developing' })), workflowRunsByProject: { p1: [run('r1', { status: 'running' })] }, projectId: 'p1', showArchived: false, now: NOW });
  assert.deepEqual([groups.running.length, groups.prNotMerged.length], [1, 0]);
});

test('a started task with no run that waits for its parents lands in Waiting, not Running', () => {
  const waiting = (state) => ({ options: {}, state, reasons: [{ text: 'Waiting for #1 to finish', blocked: state === 'blocked' }], since: minutesAgo(5), longWaitNotified: false, updatedAt: minutesAgo(5) });
  const groups = groupsFor([item('w', { waiting: waiting('waiting') }), item('x', { waiting: waiting('blocked') })], [], []);
  assert.deepEqual(groups.waiting.map((r) => r.id), ['w', 'x']);
  assert.deepEqual(groups.running, []);
  assert.deepEqual(groups.open, []);
  assert.deepEqual(groups.waiting.map(isBlockedWaiting), [false, true]);
});

test('a run-less task whose Task is executing (the docs bootstrap) lands in Running, without step progress', () => {
  const items = [item('setup', { status: 'developing', taskIds: ['ts'] })];
  const groups = groupsFor(items, [task('ts', { planItemId: 'setup', status: 'developing', completedAt: null })], []);
  assert.deepEqual(groups.running.map((r) => r.id), ['setup']);
  assert.equal(groups.running[0].progress, undefined);
  assert.deepEqual([groups.open, groups.needsYou, groups.waiting], [[], [], []]);
});

test('a run-less task waiting on input still goes to Needs-you, not Running', () => {
  const items = [item('setup', { status: 'blocked', taskIds: ['ts'] })];
  const groups = groupsFor(items, [task('ts', { planItemId: 'setup', status: 'blocked', completedAt: null })], []);
  assert.deepEqual(groups.needsYou.map((r) => r.id), ['setup']);
  assert.deepEqual(groups.running, []);
});

test('an executing row whose run is not loaded yet, or that waits for its parents, does not jump to Running', () => {
  const waiting = { options: {}, state: 'waiting', reasons: [], since: minutesAgo(5), longWaitNotified: false, updatedAt: minutesAgo(5) };
  const items = [item('unloaded', { status: 'developing', workflowRunId: 'r-missing' }), item('w', { status: 'developing', waiting })];
  const groups = groupsFor(items, [], []);
  assert.deepEqual(groups.running, []);
  assert.deepEqual(groups.open.map((r) => r.id), ['unloaded']);
  assert.deepEqual(groups.waiting.map((r) => r.id), ['w']);
});
