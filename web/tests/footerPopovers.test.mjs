import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

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

const fp = await import('../src/lib/footerPopovers.ts');
const { footerPopoverReducer } = await import('../src/lib/footerPopoverState.ts');
const { summarizeWorkspaceCounts } = await import('../src/lib/workspaceCounts.ts');
const { summarizeProjectStatus } = await import('../src/lib/projectStatus.ts');
const { cardDetail } = await import('../src/lib/taskBoard.ts');
const { buildOpenTaskRows } = await import('../src/lib/projectTasks.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { reportedError, CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

const NOW = new Date('2026-10-04T12:00:00.000Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000).toISOString();
const usage = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });

const task = (id, patch = {}) => ({
  id, projectId: 'p1', executorId: 'exec-claude', executionMode: 'terminal', description: id, status: 'done', kind: 'execute',
  planItemId: null, sessionId: `sess-${id}`, blockedQuestion: null, failureReason: null, tokenUsage: usage(),
  createdAt: minutesAgo(600), updatedAt: minutesAgo(30), completedAt: minutesAgo(30), ...patch,
});
const planTask = (id, patch = {}) => task(id, { kind: 'plan', status: 'stopped', conversationId: id, ...patch });
const item = (id, patch = {}) => ({
  id, projectId: 'p1', title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [], executorId: null,
  createdAt: minutesAgo(600), updatedAt: minutesAgo(600), ...patch,
});
const steps = [{ id: 's1', name: 'Planning' }, { id: 's2', name: 'Development' }, { id: 's3', name: 'Review' }];
const run = (id, status, patch = {}) => ({
  id, projectId: 'p1', planItemId: 'i', workflowId: 'wf1', workflowSnapshot: { id: 'wf1', name: 'Dev', description: '', enabled: true, steps },
  status, currentStepId: null, executorId: 'exec-claude', prUrl: null, completionReport: null, attentionReason: null,
  loopRoundAllowance: 0, createdAt: minutesAgo(60), updatedAt: minutesAgo(1), completedAt: null, ...patch,
});
const ran = (id, runId, patch = {}) => item(id, { status: 'developing', workflowRunId: runId, taskIds: [`t-${id}`], ...patch });
const project = (id, name, status = 'idle') => ({ id, name, position: [0, 0], status, activeTaskId: null, taskCount: 0, sync: null });
const executors = [{ id: 'exec-claude', label: 'Claude' }];

/** One project's loaded board; pass `undefined` for `runs` to leave it loading. */
const board = (items, runs, taskIds = [], tasks = []) => ({ items, taskIds, runs, tasks });
function boards(projects, perProject) {
  const tasksById = {};
  for (const b of Object.values(perProject)) for (const t of b.tasks ?? []) tasksById[t.id] = t;
  return {
    projects,
    executors,
    tasksById,
    planByProject: Object.fromEntries(Object.entries(perProject).map(([id, b]) => [id, b.items && { items: b.items }])),
    taskIdsByProject: Object.fromEntries(Object.entries(perProject).map(([id, b]) => [id, b.taskIds])),
    workflowRunsByProject: Object.fromEntries(Object.entries(perProject).map(([id, b]) => [id, b.runs])),
  };
}
/** The popup's groups narrowed to one kind and ordered A-Z: lets the row-content tests read one state at a time. */
const taskGroups = (b, kind) => fp.buildTasksPopupGroups(b)
  .map((g) => ({ ...g, rows: g.rows.filter((r) => r.kind === kind) }))
  .filter((g) => g.rows.length > 0)
  .sort((a, z) => a.projectName.localeCompare(z.projectName, undefined, { sensitivity: 'base' }) || a.projectId.localeCompare(z.projectId));
const ids = (groups) => groups.flatMap((g) => g.rows.map((r) => r.id));

// A realistic mixed workspace used by several tests.
function sample() {
  const session = planTask('plan-1', { planningSessionNumber: 4, planningCreatedTaskCount: 2, title: 'Build login' });
  const itemsA = [
    ran('a-run', 'r-a', { title: '1.001: Build API' }),
    ran('a-wait', 'r-w'),
    item('a-todo', { title: 'Loose todo' }),
    item('a-nested', { title: 'Nested', planningRef: { session: 4, task: 2 }, planningTaskId: 'plan-1' }),
    item('a-archived', { archived: true }),
  ];
  const runsA = [
    run('r-a', 'running', { currentStepId: 's2', currentStepRoundStartedAt: minutesAgo(12) }),
    run('r-w', 'awaiting-approval', { updatedAt: minutesAgo(180) }),
  ];
  const itemsB = [ranItem('b-fail', 'r-f', 'Zed task'), item('b-todo')];
  const runsB = [run('r-f', 'failed', { projectId: 'p2' })];
  return boards(
    [project('p1', 'alpha', 'developing'), project('p2', 'Beta', 'blocked'), project('p3', 'gamma', 'idle'), project('p4', 'delta', 'developing')],
    {
      p1: board(itemsA, runsA, ['plan-1', 't-a-run', 't-a-wait'], [session, task('t-a-run', { status: 'developing' }), task('t-a-wait', { status: 'developing' })]),
      p2: board(itemsB, runsB, ['t-b-fail'], [task('t-b-fail', { projectId: 'p2', status: 'developing' })]),
      p3: board([], [], [], []),
      p4: board(undefined, undefined, undefined),
    },
  );
}
function ranItem(id, runId, title) { return ran(id, runId, { projectId: 'p2', title }); }

test('every list has exactly as many rows as its footer number', () => {
  const b = sample();
  const status = summarizeProjectStatus(b.projects);
  const { tasks } = summarizeWorkspaceCounts(b);
  assert.equal(fp.buildProjectRows(b, 'working').length, status.working);
  assert.equal(fp.buildProjectRows(b, 'blocked').length, status.blocked);
  assert.equal(ids(taskGroups(b, 'active')).length, tasks.active);
  assert.equal(ids(taskGroups(b, 'blocked')).length, tasks.blocked);
  assert.equal(ids(taskGroups(b, 'pending')).length, tasks.pending);
  assert.deepEqual([tasks.active, tasks.blocked, tasks.pending], [1, 2, 3]);
});

test('working and blocked project lists are disjoint, and idle projects are in neither', () => {
  const b = sample();
  const working = fp.buildProjectRows(b, 'working').map((r) => r.projectId);
  const blocked = fp.buildProjectRows(b, 'blocked').map((r) => r.projectId);
  assert.deepEqual(working, ['p1', 'p4']);
  assert.deepEqual(blocked, ['p2']);
  assert.ok(!working.includes('p3') && !blocked.includes('p3'));
});

test('project rows sort A-Z ignoring case, with name ties broken by id, and carry running and needs-you counts', () => {
  const b = sample();
  b.projects.push(project('p0', 'Alpha', 'developing'), project('p9', 'alpha', 'developing'));
  b.planByProject.p0 = { items: [] }; b.taskIdsByProject.p0 = []; b.workflowRunsByProject.p0 = [];
  const rows = fp.buildProjectRows(b, 'working');
  assert.deepEqual(rows.map((r) => r.projectId), ['p0', 'p1', 'p9', 'p4']);
  assert.deepEqual(rows.find((r) => r.projectId === 'p1'), { projectId: 'p1', name: 'alpha', running: 1, needsYou: 1 });
});

test('a working project with 0 running is still listed; a loading project shows no counts', () => {
  const b = sample();
  const rows = fp.buildProjectRows(b, 'working');
  const delta = rows.find((r) => r.projectId === 'p4');
  assert.deepEqual(delta, { projectId: 'p4', name: 'delta', running: null, needsYou: null });
  b.projects.push(project('p5', 'echo', 'developing'));
  b.planByProject.p5 = { items: [] }; b.taskIdsByProject.p5 = []; b.workflowRunsByProject.p5 = [];
  assert.equal(fp.buildProjectRows(b, 'working').find((r) => r.projectId === 'p5').running, 0);
});

test('project row counts read "2 running · 1 needs you", omitting zeros and nothing at all when empty or loading', () => {
  assert.equal(fp.projectRowCounts({ running: 2, needsYou: 1 }), '2 running · 1 needs you');
  assert.equal(fp.projectRowCounts({ running: 0, needsYou: 3 }), '3 needs you');
  assert.equal(fp.projectRowCounts({ running: 2, needsYou: 0 }), '2 running');
  assert.equal(fp.projectRowCounts({ running: 0, needsYou: 0 }), '');
  assert.equal(fp.projectRowCounts({ running: null, needsYou: null }), '');
});

test('a project whose plan, tasks or runs are still loading contributes no task rows', () => {
  const b = sample();
  for (const kind of ['active', 'blocked', 'pending']) {
    assert.ok(!taskGroups(b, kind).some((g) => g.projectId === 'p4'));
  }
  b.workflowRunsByProject.p1 = undefined;
  assert.ok(!taskGroups(b, 'active').some((g) => g.projectId === 'p1'));
});

test('archived items never appear, and a task with a run is not pending', () => {
  const b = sample();
  assert.ok(!ids(taskGroups(b, 'pending')).includes('a-archived'));
  assert.ok(!ids(taskGroups(b, 'pending')).includes('a-run'));
});

test('pending includes ready tasks nested under a planning session, and names the session as the source', () => {
  const b = sample();
  const rows = taskGroups(b, 'pending').find((g) => g.projectId === 'p1').rows;
  const nested = rows.find((r) => r.id === 'a-nested');
  assert.equal(nested.detail, 'From planning session 4: Build login');
  assert.equal(rows.find((r) => r.id === 'a-todo').detail, '');
});

test('the source falls back to the planning task number, then to a bare "planning session"', () => {
  const b = sample();
  b.planByProject.p1.items.push(item('a-by-task', { planningTaskId: 'plan-1' }), item('a-gone', { planningTaskId: 'missing' }));
  const rows = taskGroups(b, 'pending').find((g) => g.projectId === 'p1').rows;
  assert.equal(rows.find((r) => r.id === 'a-by-task').detail, 'From planning session 4: Build login');
  assert.equal(rows.find((r) => r.id === 'a-gone').detail, 'From a planning session');
});

test('a rename re-sorts projects that tie on rank and ratio', () => {
  const b = boards([project('p1', 'Alpha'), project('p2', 'Beta')], { p1: board([item('x')], []), p2: board([item('y')], []) });
  assert.deepEqual(fp.buildTasksPopupGroups(b).map((g) => g.projectName), ['Alpha', 'Beta']);
  b.projects[0] = { ...b.projects[0], name: 'Zulu' };
  assert.deepEqual(fp.buildTasksPopupGroups(b).map((g) => g.projectName), ['Beta', 'Zulu']);
});

test('a project deleted from the store drops its rows', () => {
  const b = sample();
  b.projects = b.projects.filter((p) => p.id !== 'p2');
  assert.deepEqual(fp.buildTasksPopupGroups(b).map((g) => g.projectId), ['p1']);
});

test('active detail is the current step and progress, or "Running" without a current step', () => {
  const b = sample();
  assert.equal(taskGroups(b, 'active')[0].rows[0].detail, 'Development · step 2 of 3');
  b.workflowRunsByProject.p1[0] = run('r-a', 'running', { currentStepId: null });
  assert.equal(taskGroups(b, 'active')[0].rows[0].detail, 'Running');
});

test('blocked detail names each reason', () => {
  const statuses = { 'awaiting-approval': 'Awaiting approval', 'needs-attention': 'Needs attention', failed: 'Failed', stopped: 'Stopped' };
  for (const [status, text] of Object.entries(statuses)) {
    const b = boards([project('p1', 'a')], { p1: board([ran('x', 'rx')], [run('rx', status)], [], []) });
    assert.equal(taskGroups(b, 'blocked')[0].rows[0].detail, text);
  }
  const waiting = boards([project('p1', 'a')], { p1: board([item('w', { status: 'blocked', taskIds: ['t-w'] })], [], ['t-w'], [task('t-w', { status: 'blocked', completedAt: null, updatedAt: minutesAgo(5) })]) });
  const row = taskGroups(waiting, 'blocked')[0].rows[0];
  assert.equal(row.detail, 'Waiting for your answer');
  assert.equal(row.inStateSince, minutesAgo(5));
});

test('a run-less blocked task with no loaded Task record has no state-change time', () => {
  const b = boards([project('p1', 'a')], { p1: board([item('w', { status: 'blocked' })], [], [], []) });
  const [row] = taskGroups(b, 'blocked')[0].rows;
  assert.equal(row.inStateSince, null);
  assert.equal(fp.taskRowTimeLabel('blocked', row, NOW), '');
});

test('active and blocked rows are longest-in-state first; rows with no state-change time follow, then title breaks ties', () => {
  const items = [ran('c', 'rc', { title: 'C' }), ran('a', 'ra', { title: 'A' }), ran('b', 'rb', { title: 'B' }), ran('n2', 'rn2', { title: 'N2' }), ran('n1', 'rn1', { title: 'N1' }), ran('d', 'rd', { title: 'D' })];
  const runs = [
    run('rc', 'running', { currentStepRoundStartedAt: minutesAgo(5) }),
    run('ra', 'running', { currentStepRoundStartedAt: minutesAgo(50) }),
    run('rb', 'running', { currentStepRoundStartedAt: minutesAgo(50) }),
    run('rn2', 'running'),
    run('rn1', 'running'),
    run('rd', 'running', { currentStepRoundStartedAt: minutesAgo(20) }),
  ];
  const rows = taskGroups(boards([project('p1', 'a')], { p1: board(items, runs) }), 'active')[0].rows;
  assert.deepEqual(rows.map((r) => r.title), ['A', 'B', 'D', 'C', 'N1', 'N2']);
  const reversed = taskGroups(boards([project('p1', 'a')], { p1: board([...items].reverse(), runs) }), 'active')[0].rows;
  assert.deepEqual(reversed.map((r) => r.title), rows.map((r) => r.title));
});

test('blocked rows order by how long the run has needed you', () => {
  const items = [ran('new', 'rn', { title: 'New' }), ran('old', 'ro', { title: 'Old' })];
  const runs = [run('rn', 'failed', { updatedAt: minutesAgo(3) }), run('ro', 'stopped', { updatedAt: minutesAgo(300) })];
  const rows = taskGroups(boards([project('p1', 'a')], { p1: board(items, runs) }), 'blocked')[0].rows;
  assert.deepEqual(rows.map((r) => r.id), ['old', 'new']);
});

test('pending rows follow the Planning column order, not a time sort', () => {
  const session = planTask('plan-1', { planningSessionNumber: 1, planningQueueOrder: 10 });
  const items = [
    item('z-loose', { title: 'Z loose', planningQueueOrder: 5, createdAt: minutesAgo(1) }),
    item('n2', { title: 'Nested two', planningRef: { session: 1, task: 2 }, planningTaskId: 'plan-1' }),
    item('n1', { title: 'Nested one', planningRef: { session: 1, task: 1 }, planningTaskId: 'plan-1' }),
    item('a-loose', { title: 'A loose', planningQueueOrder: 20 }),
  ];
  const b = boards([project('p1', 'a')], { p1: board(items, [], ['plan-1'], [session]) });
  assert.deepEqual(taskGroups(b, 'pending')[0].rows.map((r) => r.id), ['z-loose', 'n1', 'n2', 'a-loose']);
});

test('pending rows with equal Planning rank fall back to title', () => {
  const items = [item('b', { title: 'B', planningQueueOrder: 1 }), item('a', { title: 'A', planningQueueOrder: 1 })];
  const b = boards([project('p1', 'a')], { p1: board(items, []) });
  assert.deepEqual(taskGroups(b, 'pending')[0].rows.map((r) => r.id), ['a', 'b']);
});

test('the sequence number shows once: kept when the title has it, added from the planning reference when not, absent otherwise', () => {
  assert.equal(fp.titleWithNumber(item('x', { title: '6.001: Footer popovers', planningRef: { session: 6, task: 1 } }), 'x'), '6.001: Footer popovers');
  assert.equal(fp.titleWithNumber(item('x', { title: 'Footer popovers', planningRef: { session: 6, task: 1 } }), 'x'), '6.001: Footer popovers');
  assert.equal(fp.titleWithNumber(item('x', { title: 'Hand typed' }), 'x'), 'Hand typed');
  assert.equal(fp.titleWithNumber(undefined, 'Fallback'), 'Fallback');
});

test('the coding agent is the assigned executor label, a run\'s executor, the raw id if unknown, or null', () => {
  const b = sample();
  const active = taskGroups(b, 'active')[0].rows[0];
  assert.equal(active.agent, 'Claude');
  assert.equal(taskGroups(b, 'pending')[0].rows[0].agent, null);
  b.planByProject.p1.items.find((i) => i.id === 'a-todo').executorId = 'exec-gone';
  assert.equal(taskGroups(b, 'pending')[0].rows.find((r) => r.id === 'a-todo').agent, 'exec-gone');
});

test('relative time: started plus time in state for active and blocked, started only without it, created for pending', () => {
  const row = { startedAt: minutesAgo(180), inStateSince: minutesAgo(12), createdAt: minutesAgo(60 * 24 * 5) };
  assert.equal(fp.taskRowTimeLabel('active', row, NOW), 'Started 3h ago · step started 12m ago');
  assert.equal(fp.taskRowTimeLabel('blocked', row, NOW), 'Started 3h ago · needs you since 12m ago');
  assert.equal(fp.taskRowTimeLabel('active', { ...row, inStateSince: null }, NOW), 'Started 3h ago');
  assert.equal(fp.taskRowTimeLabel('active', { ...row, startedAt: null, inStateSince: null }, NOW), '');
  assert.equal(fp.taskRowTimeLabel('pending', row, NOW), 'Created 5d ago');
  assert.equal(fp.taskRowTimeLabel('pending', { ...row, createdAt: minutesAgo(-5) }, NOW), 'Created in 5m', 'a future time reads forward, not clamped');
  const later = new Date(NOW.getTime() + 60 * 60_000);
  assert.equal(fp.taskRowTimeLabel('pending', { ...row, createdAt: minutesAgo(30) }, later), 'Created 1h ago');
});

test('started time is the board card\'s own instant: the earliest task\'s start', () => {
  const b = sample();
  const row = taskGroups(b, 'active')[0].rows[0];
  const [boardRow] = buildOpenTaskRows({ items: b.planByProject.p1.items, tasksById: b.tasksById, showArchived: false, now: 0 }).filter((r) => r.id === 'a-run');
  assert.equal(row.startedAt, boardRow.metrics.startedAt);
});

test('a row opens what a board card click opens', () => {
  const b = sample();
  const row = taskGroups(b, 'active')[0].rows[0];
  assert.deepEqual(row.open, { kind: 'run', id: 'r-a' });
  const [boardRow] = buildOpenTaskRows({ items: b.planByProject.p1.items, tasksById: b.tasksById, showArchived: false, now: 0 }).filter((r) => r.id === 'a-run');
  assert.deepEqual(row.open, cardDetail(boardRow));
  assert.deepEqual(taskGroups(b, 'pending')[0].rows.find((r) => r.id === 'a-todo').open, { kind: 'item', id: 'a-todo' });
});

test('empty lists give a message', () => {
  const b = boards([project('p1', 'a')], { p1: board([], []) });
  assert.deepEqual(fp.buildProjectRows(b, 'working'), []);
  assert.deepEqual(fp.buildTasksPopupGroups(b), []);
  assert.equal(fp.EMPTY_PROJECT_MESSAGES.working, 'No working projects');
  assert.equal(fp.EMPTY_PROJECT_MESSAGES.blocked, 'No blocked projects');
  assert.equal(fp.EMPTY_TASKS_MESSAGE, 'No active, blocked or pending tasks');
  assert.equal(fp.EMPTY_TASK_MESSAGES, undefined);
});

test('a task moving from Running to Needs you changes state under its project', () => {
  const b = sample();
  const kindOf = (id) => fp.buildTasksPopupGroups(b).flatMap((g) => g.rows).find((r) => r.id === id)?.kind;
  assert.equal(kindOf('a-run'), 'active');
  assert.deepEqual(fp.buildTasksPopupGroups(b).map((g) => g.projectId), ['p1', 'p2'], '2 of 4 ties 1 of 2, so name decides');
  b.workflowRunsByProject.p1[0] = run('r-a', 'awaiting-approval');
  assert.equal(kindOf('a-run'), 'blocked');
  assert.equal(fp.buildTasksPopupGroups(b).find((g) => g.projectId === 'p1').counts.active, 0);
  assert.equal(ids(taskGroups(b, 'blocked')).length, summarizeWorkspaceCounts(b).tasks.blocked);
});

test('resolveCardDetail keeps a detail whose record exists and falls back to the board when it is gone', () => {
  const b = sample();
  assert.equal(fp.resolveCardDetail(null, 'p1', b), null);
  assert.deepEqual(fp.resolveCardDetail({ kind: 'run', id: 'r-a' }, 'p1', b), { kind: 'run', id: 'r-a' });
  assert.equal(fp.resolveCardDetail({ kind: 'run', id: 'r-gone' }, 'p1', b), null);
  assert.equal(fp.resolveCardDetail({ kind: 'run', id: 'r-a' }, 'nope', b), null);
  assert.deepEqual(fp.resolveCardDetail({ kind: 'task', id: 'plan-1' }, 'p1', b), { kind: 'task', id: 'plan-1' });
  assert.equal(fp.resolveCardDetail({ kind: 'task', id: 'gone' }, 'p1', b), null);
  assert.deepEqual(fp.resolveCardDetail({ kind: 'item', id: 'a-todo' }, 'p1', b), { kind: 'item', id: 'a-todo' });
  assert.equal(fp.resolveCardDetail({ kind: 'item', id: 'gone' }, 'p1', b), null);
  assert.equal(fp.resolveCardDetail({ kind: 'item', id: 'a-todo' }, 'p4', b), null);
});

test('popover state: one open at a time, hover previews close on leave, a click pins and a second click closes', () => {
  const r = footerPopoverReducer;
  assert.deepEqual(r(null, { type: 'preview', id: 'a' }), { id: 'a', pinned: false });
  assert.deepEqual(r({ id: 'a', pinned: true }, { type: 'preview', id: 'a' }), { id: 'a', pinned: true });
  assert.deepEqual(r({ id: 'a', pinned: true }, { type: 'preview', id: 'b' }), { id: 'b', pinned: false }, 'opening another closes the first');
  assert.equal(r({ id: 'a', pinned: false }, { type: 'unpreview', id: 'a' }), null);
  assert.deepEqual(r({ id: 'a', pinned: true }, { type: 'unpreview', id: 'a' }), { id: 'a', pinned: true });
  assert.deepEqual(r({ id: 'a', pinned: false }, { type: 'unpreview', id: 'b' }), { id: 'a', pinned: false });
  assert.deepEqual(r({ id: 'a', pinned: false }, { type: 'toggle', id: 'a' }), { id: 'a', pinned: true });
  assert.equal(r({ id: 'a', pinned: true }, { type: 'toggle', id: 'a' }), null);
  assert.deepEqual(r({ id: 'a', pinned: true }, { type: 'toggle', id: 'b' }), { id: 'b', pinned: true });
  assert.equal(r({ id: 'a', pinned: true }, { type: 'close' }), null);
});

// ---- open actions through the store ----

const T = '2026-10-04T10:00:00.000Z';
function seedStore() {
  const stub = installServerStub();
  useWorldStore.setState({
    projects: [], tasksById: {}, taskIdsByProject: {}, lastTaskIdByProject: {}, planByProject: {}, workflowRunsByProject: {},
    workspaceProjectId: null, workspaceTab: 'tasks', workspaceDetailTaskId: null, workspaceCardDetailRequest: null,
    catalogOpen: false, notificationCenterOpen: false, ...CLEAN_ERROR_STATE,
  });
  for (const id of ['p1', 'p2']) stub.projects.set(id, { id, name: id, slug: id, relativePath: `projects/${id}`, status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: T, updatedAt: T });
  useWorldStore.setState({
    planByProject: { p1: { items: [item('i1')] }, p2: { items: [] } },
    workflowRunsByProject: { p1: [run('r1', 'running')], p2: [] },
  });
}

test('a project row opens that project on its Tasks tab with no details', () => {
  seedStore();
  useWorldStore.setState({ workspaceTab: 'settings', workspaceDetailTaskId: 'old' });
  useWorldStore.getState().openWorkspaceCardDetail('p1', null);
  const s = useWorldStore.getState();
  assert.equal(s.workspaceProjectId, 'p1');
  assert.equal(s.workspaceTab, 'tasks');
  assert.equal(s.workspaceDetailTaskId, null);
  assert.deepEqual(s.workspaceCardDetailRequest, { detail: null });
});

test('a task row opens the project Tasks tab with its details requested', () => {
  seedStore();
  useWorldStore.getState().openWorkspaceCardDetail('p1', { kind: 'run', id: 'r1' });
  assert.deepEqual(useWorldStore.getState().workspaceCardDetailRequest, { detail: { kind: 'run', id: 'r1' } });
  assert.equal(useWorldStore.getState().workspaceProjectId, 'p1');
});

test('a task row whose record has vanished still opens the board without an error', () => {
  seedStore();
  useWorldStore.getState().openWorkspaceCardDetail('p1', { kind: 'run', id: 'gone' });
  const s = useWorldStore.getState();
  assert.deepEqual(s.workspaceCardDetailRequest, { detail: null });
  assert.equal(reportedError(), null);
});

test('clicking a row replaces another project\'s popup, and re-applies for the same project', () => {
  seedStore();
  useWorldStore.getState().openWorkspace('p2');
  useWorldStore.getState().openWorkspaceCardDetail('p1', { kind: 'item', id: 'i1' });
  assert.equal(useWorldStore.getState().workspaceProjectId, 'p1');
  const first = useWorldStore.getState().workspaceCardDetailRequest;
  useWorldStore.getState().openWorkspaceCardDetail('p1', null);
  const second = useWorldStore.getState().workspaceCardDetailRequest;
  assert.notEqual(first, second, 'a fresh request object, so the board re-applies it');
  assert.equal(useWorldStore.getState().workspaceProjectId, 'p1');
});

test('clicking a row closes the Catalog and the Notifications drawer, and leaves a closed drawer closed', () => {
  seedStore();
  useWorldStore.setState({ catalogOpen: true, notificationCenterOpen: true });
  useWorldStore.getState().openWorkspaceCardDetail('p1', null);
  assert.equal(useWorldStore.getState().catalogOpen, false);
  assert.equal(useWorldStore.getState().notificationCenterOpen, false);
  useWorldStore.getState().openWorkspaceCardDetail('p1', null);
  assert.equal(useWorldStore.getState().notificationCenterOpen, false);
});

test('the board clears a request once applied', () => {
  seedStore();
  useWorldStore.getState().openWorkspaceCardDetail('p1', null);
  useWorldStore.getState().clearWorkspaceCardDetailRequest();
  assert.equal(useWorldStore.getState().workspaceCardDetailRequest, null);
});

test('closing the workspace drops a footer request the board never applied', () => {
  seedStore();
  useWorldStore.getState().openWorkspaceCardDetail('p1', { kind: 'run', id: 'r1' });
  useWorldStore.getState().openWorkspace(null);
  assert.equal(useWorldStore.getState().workspaceCardDetailRequest, null);
});

test('a task waiting for its parents is listed as Waiting under pending, with the reason, and the totals agree', () => {
  const waiting = (state, text) => ({ options: {}, state, reasons: [{ text, blocked: state === 'blocked' }], since: minutesAgo(5), longWaitNotified: false, updatedAt: minutesAgo(5) });
  const items = [
    ran('run', 'r1'),
    item('a-todo', { title: 'Aaa todo' }),
    item('w', { title: 'Wait', status: 'developing', waiting: waiting('waiting', 'Waiting for #10.009 to finish') }),
    item('wb', { title: 'Blocked wait', status: 'developing', waiting: waiting('blocked', 'Parent #10.009 failed') }),
  ];
  const b = boards([project('p1', 'alpha', 'developing')], { p1: board(items, [run('r1', 'running')], ['t-run'], [task('t-run', { status: 'developing' })]) });
  const rows = fp.buildTasksPopupGroups(b)[0].rows;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.w.kind, 'pending');
  assert.equal(byId.w.label, 'Waiting');
  assert.equal(byId.w.detail, 'Waiting for #10.009 to finish');
  assert.equal(byId.w.agent, null);
  assert.equal(byId.wb.kind, 'blocked');
  assert.equal(byId.wb.label, 'Needs you');
  assert.equal(byId.wb.detail, 'Parent #10.009 failed');
  assert.equal(byId['a-todo'].label, 'Pending');
  assert.deepEqual(rows.filter((r) => r.kind === 'pending').map((r) => r.id), ['w', 'a-todo'], 'waiting rows come before the planning queue');
  assert.equal(rows.filter((r) => r.kind === 'active').length, 1);
  const { tasks } = summarizeWorkspaceCounts(b);
  assert.deepEqual([tasks.active, tasks.blocked, tasks.pending], [1, 1, 2]);
});
