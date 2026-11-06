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

const { countProjectTasks, summarizeWorkspaceCounts } = await import('../src/lib/workspaceCounts.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { buildPlanningQueue } = await import('../src/lib/projectTasks.ts');
const { cardStartedLabel } = await import('../src/lib/taskBoard.ts');
const { summarizeProjectStatus } = await import('../src/lib/projectStatus.ts');

const NOW = new Date('2026-10-04T12:00:00.000Z').getTime();
const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString();
const usage = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });

const task = (id, patch = {}) => ({
  id, projectId: 'p1', executorId: 'exec-claude', executionMode: 'terminal', description: id, status: 'done', kind: 'execute',
  planItemId: null, sessionId: `sess-${id}`, blockedQuestion: null, failureReason: null, tokenUsage: usage(),
  createdAt: minutesAgo(60), updatedAt: minutesAgo(30), completedAt: minutesAgo(30), ...patch,
});
const item = (id, patch = {}) => ({
  id, projectId: 'p1', title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [], executorId: null,
  createdAt: minutesAgo(600), updatedAt: minutesAgo(600), ...patch,
});
const run = (id, status, projectId = 'p1') => ({
  id, projectId, planItemId: 'i', workflowId: 'wf1', workflowSnapshot: { id: 'wf1', name: 'Dev', description: '', enabled: true, steps: [] },
  status, currentStepId: null, executorId: 'exec-claude', prUrl: null, completionReport: null, attentionReason: null,
  loopRoundAllowance: 0, createdAt: minutesAgo(60), updatedAt: minutesAgo(1), completedAt: null,
});
/** A planning conversation Task; follow-ups share its `conversationId`, so they chain into one session. */
const planTask = (id, patch = {}) => task(id, { kind: 'plan', status: 'stopped', conversationId: patch.conversationId ?? id, ...patch });
const byId = (...tasks) => Object.fromEntries(tasks.map((t) => [t.id, t]));
const board = (projectId, items, taskIds, runs) => ({ projectId, items, taskIds, runs });
/** The store-shaped input `summarizeWorkspaceCounts` reads, built from per-project boards. */
const workspace = (boards, tasksById = {}) => ({
  projects: boards.map((b) => ({ id: b.projectId })),
  planByProject: Object.fromEntries(boards.map((b) => [b.projectId, b.items && { items: b.items }])),
  taskIdsByProject: Object.fromEntries(boards.map((b) => [b.projectId, b.taskIds])),
  workflowRunsByProject: Object.fromEntries(boards.map((b) => [b.projectId, b.runs])),
  tasksById,
});
/** An item already executing through a run with this status. */
const ranItem = (id, runId, projectId = 'p1') => item(id, { projectId, status: 'developing', workflowRunId: runId });

test('no projects returns all zeros', () => {
  assert.deepEqual(summarizeWorkspaceCounts(workspace([])), { tasks: { active: 0, blocked: 0, pending: 0 } });
});

test('active counts cards whose run is running or completing, summed across projects', () => {
  const projects = [
    board('p1', [ranItem('a', 'ra'), ranItem('b', 'rb')], [], [run('ra', 'running'), run('rb', 'completing')]),
    board('p2', [], [], []),
    board('p3', [ranItem('c', 'rc', 'p3')], [], [run('rc', 'running', 'p3')]),
  ];
  assert.equal(summarizeWorkspaceCounts(workspace(projects)).tasks.active, 3);
});

test('blocked counts runs waiting on a person, failed or stopped, plus a run-less task waiting on input', () => {
  const tasksById = byId(task('t-wait', { status: 'blocked', completedAt: null }));
  const projects = [
    board('p1', [ranItem('a', 'ra'), ranItem('b', 'rb'), item('w', { status: 'blocked', taskIds: ['t-wait'] })], ['t-wait'], [run('ra', 'awaiting-approval'), run('rb', 'needs-attention')]),
    board('p2', [ranItem('c', 'rc', 'p2'), ranItem('d', 'rd', 'p2')], [], [run('rc', 'failed', 'p2'), run('rd', 'stopped', 'p2')]),
  ];
  assert.equal(summarizeWorkspaceCounts(workspace(projects, tasksById)).tasks.blocked, 5);
});

test('pending counts only not-started Planning cards, including ready tasks nested under an open session', () => {
  const session = planTask('plan-1', { planningSessionNumber: 4, planningCreatedTaskCount: 2 });
  const items = [
    item('loose'),
    item('nested-1', { planningRef: { session: 4, task: 1 }, planningTaskId: 'plan-1' }),
    item('nested-2', { planningRef: { session: 4, task: 2 }, planningTaskId: 'plan-1' }),
    // Run before and halted: in Planning, but not "not started".
    item('halted', { status: 'stopped', taskIds: ['t-halted'] }),
  ];
  const tasksById = byId(session, task('t-halted', { status: 'stopped', executionMode: 'background' }));
  const counts = countProjectTasks(board('p1', items, ['plan-1', 't-halted'], []), tasksById);
  assert.equal(counts.pending, 3);
});

test('completed, done and archived items are not counted, and a failed run counts as blocked not active', () => {
  const items = [
    item('lagging', { status: 'developing', workflowRunId: 'r-done' }),
    item('done', { status: 'done' }),
    item('archived', { archived: true }),
    ranItem('broken', 'r-failed'),
  ];
  const counts = countProjectTasks(board('p1', items, [], [run('r-done', 'completed'), run('r-failed', 'failed')]), {});
  assert.deepEqual(counts, { active: 0, blocked: 1, pending: 0 });
});

test('a run is matched only within its own project\'s run list', () => {
  const projects = [
    board('p1', [ranItem('a', 'shared-id')], [], []),
    board('p2', [], [], [run('shared-id', 'running', 'p2')]),
  ];
  // p1's card has no run of its own loaded, so p2's running run must not make it active.
  assert.equal(summarizeWorkspaceCounts(workspace(projects)).tasks.active, 0);
});

test('every open card lands in at most one of active, blocked and pending', () => {
  const items = [ranItem('a', 'ra'), ranItem('b', 'rb'), ranItem('c', 'rc'), item('d'), item('e', { status: 'stopped', workflowRunId: 'r-unknown' })];
  const { active, blocked, pending } = countProjectTasks(board('p1', items, [], [run('ra', 'running'), run('rb', 'failed'), run('rc', 'stopped')]), {});
  assert.deepEqual({ active, blocked, pending }, { active: 1, blocked: 2, pending: 1 });
  assert.ok(active + blocked + pending <= items.length);
});

test('a project still loading its plan, tasks or runs counts nothing and does not throw', () => {
  const items = [item('a'), ranItem('b', 'rb')];
  const runs = [run('rb', 'running')];
  for (const partial of [board('p1', undefined, [], runs), board('p1', items, undefined, runs), board('p1', items, [], undefined)]) {
    assert.deepEqual(countProjectTasks(partial, {}), { active: 0, blocked: 0, pending: 0 });
  }
});

test('the counts match what the project\'s Tasks board shows in each column', () => {
  const session = planTask('plan-1', { planningSessionNumber: 2, planningCreatedTaskCount: 1 });
  const tasksById = byId(session, task('t-wait', { status: 'blocked', completedAt: null }));
  const items = [
    ranItem('run-1', 'r1'), ranItem('run-2', 'r2'), ranItem('appr', 'r3'), ranItem('fail', 'r4'),
    item('wait', { status: 'blocked', taskIds: ['t-wait'] }),
    item('todo-1'), item('todo-2'), item('nested', { planningRef: { session: 2, task: 1 } }),
    item('finished', { status: 'done' }),
  ];
  const runs = [run('r1', 'running'), run('r2', 'completing'), run('r3', 'awaiting-approval'), run('r4', 'failed')];
  const taskIds = ['plan-1', 't-wait'];
  const groups = buildTaskGroups({ items, tasksById, workflowRunsByProject: { p1: runs }, projectId: 'p1', showArchived: false, now: NOW });
  const queue = buildPlanningQueue({ items, taskIds, tasksById, now: NOW, openRows: groups.open });
  const planningCards = queue.flatMap((entry) => entry.kind === 'task' ? [entry.task] : entry.session.ready);
  const notStarted = planningCards.filter((row) => cardStartedLabel(row.metrics, new Date(NOW)) === 'Not started');

  const counts = countProjectTasks(board('p1', items, taskIds, runs), tasksById);
  assert.deepEqual(counts, { active: groups.running.length, blocked: groups.needsYou.length, pending: notStarted.length });
  assert.deepEqual(counts, { active: 2, blocked: 3, pending: 3 });
});

test('project counts keep their definitions: working and blocked are exclusive subsets of the total', () => {
  const projects = [{ status: 'developing' }, { status: 'blocked' }, { status: 'idle' }, { status: 'developing' }];
  assert.deepEqual(summarizeProjectStatus(projects), { total: 4, working: 2, blocked: 1 });
});

test('a task only waiting for its parents counts as pending, a blocked one as blocked, never active', () => {
  const waiting = (state) => ({ options: {}, state, reasons: [{ text: 'Waiting for #1', blocked: state === 'blocked' }], since: minutesAgo(5), longWaitNotified: false, updatedAt: minutesAgo(5) });
  const items = [ranItem('r', 'rr'), item('w1', { waiting: waiting('waiting') }), item('w2', { waiting: waiting('waiting') }), item('wb', { waiting: waiting('blocked') })];
  assert.deepEqual(countProjectTasks(board('p1', items, [], [run('rr', 'running')]), {}), { active: 1, blocked: 1, pending: 2 });
});

test('a run-less task that is executing (the docs bootstrap) counts as active, not pending', () => {
  const tasksById = byId(task('t-setup', { planItemId: 'setup', status: 'developing', completedAt: null }));
  const projects = [board('p1', [item('setup', { status: 'developing', taskIds: ['t-setup'] })], ['t-setup'], [])];
  assert.deepEqual(summarizeWorkspaceCounts(workspace(projects, tasksById)).tasks, { active: 1, blocked: 0, pending: 0 });
});
