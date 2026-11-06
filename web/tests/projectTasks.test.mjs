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
const {
  buildOpenTaskRows,
  buildPlanningRows,
  buildCompletedRows,
  completesViaSession,
  canInterimCommit,
  canResumeSession,
  interimCommitNotice,
  planningSessionName,
  planningSessionTitle,
  firstLine,
  spentLabel,
  taskDescriptionText,
  taskMetrics,
  workerLabel,
  taskProgress,
  taskProgressLabel,
  worstAttention,
  planItemSpentMs,
  latestItemTask,
  planItemActions,
  archiveBlockedReason,
  itemCompletedAt,
  sortByCompletedDesc,
  buildArchivedRows,
} = await import('../src/lib/projectTasks.ts');
const { cardDetail } = await import('../src/lib/taskBoard.ts');

const NOW = new Date('2026-09-21T12:00:00.000Z').getTime();
const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString();

const usage = (total = 0) => ({ inputTokens: total, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });

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
  tokenUsage: usage(0),
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
const open = (items, tasks = [], extra = {}) =>
  buildOpenTaskRows({ items, tasksById: byId(...tasks), showArchived: false, now: NOW, ...extra });

test('a waiting dependent task carries the agent chosen at start; a started run wins over it', () => {
  const waiting = { options: { executorId: 'claude' }, reasons: [] };
  assert.equal(open([item('w1', { waiting })])[0].workerId, 'claude');
  assert.equal(open([item('w2', { waiting, executorId: 'codex' })])[0].workerId, 'codex');
  assert.equal(open([item('w3')])[0].workerId, null);
});

test('firstLine returns the first non-blank line, trimmed', () => {
  assert.equal(firstLine('  Add login\n\nEmail and password'), 'Add login');
  assert.equal(firstLine('\n\n  second line '), 'second line');
  assert.equal(firstLine('single'), 'single');
});

test('taskMetrics is null for no tasks, otherwise sums tokens, takes the earliest start and adds run time', () => {
  assert.equal(taskMetrics([], NOW), null);
  const metrics = taskMetrics(
    [
      task('a', { tokenUsage: usage(1000), createdAt: minutesAgo(120), completedAt: minutesAgo(100) }),
      task('b', { tokenUsage: usage(500), createdAt: minutesAgo(60), completedAt: minutesAgo(30) }),
    ],
    NOW,
  );
  assert.equal(metrics.tokens, 1500);
  assert.equal(metrics.startedAt, minutesAgo(120));
  assert.equal(metrics.spentMs, (20 + 30) * 60_000);
});

test('taskMetrics measures a developing task up to now, and a task with no completedAt up to its last update', () => {
  const developing = task('run', { status: 'developing', completedAt: null, createdAt: minutesAgo(40) });
  assert.equal(taskMetrics([developing], NOW).spentMs, 40 * 60_000);
  const stopped = task('stop', { status: 'stopped', completedAt: null, createdAt: minutesAgo(60), updatedAt: minutesAgo(45) });
  assert.equal(taskMetrics([stopped], NOW).spentMs, 15 * 60_000);
});

test('taskMetrics never reports negative run time for clock skew', () => {
  const skewed = task('skew', { createdAt: minutesAgo(10), completedAt: minutesAgo(20) });
  assert.equal(taskMetrics([skewed], NOW).spentMs, 0);
});

test('an unstarted item is not started, with a start action, no metrics, and every management control enabled', () => {
  const [row] = open([item('i1')]);
  assert.equal(row.state, 'todo');
  assert.equal(row.primary, 'start');
  assert.equal(row.metrics, null);
  assert.equal(row.workerId, null);
  assert.equal(row.latestTaskId, null);
  assert.equal(row.canEdit, true);
  assert.equal(row.canComplete, true);
  assert.equal(row.canDelete, true);
  assert.equal(row.canArchive, true, 'a plan item archives itself, run or not');
  assert.equal(row.canOpenSession, false);
});

test('a developing item is executing with a pause action and only session-opening allowed', () => {
  const t = task('t1', { status: 'developing', completedAt: null, tokenUsage: usage(31400) });
  const [row] = open([item('i1', { status: 'developing', taskIds: ['t1'], executorId: 'exec-claude' })], [t]);
  assert.equal(row.state, 'executing');
  assert.equal(row.primary, 'pause');
  assert.equal(row.metrics.tokens, 31400);
  assert.equal(row.canEdit, false);
  assert.equal(row.canComplete, false);
  assert.equal(row.canDelete, false);
  assert.equal(row.canArchive, false);
  assert.equal(row.canOpenSession, true);
});

test('only an ongoing Task on a repository branch can be interim-committed', () => {
  assert.equal(canInterimCommit(task('t1', { status: 'developing', branch: 'main' })), true);
  assert.equal(canInterimCommit(task('t1', { status: 'blocked', branch: 'task/t1' })), true);
  assert.equal(canInterimCommit(task('t1', { status: 'developing' })), false, 'no branch means no repository to push to');
  assert.equal(canInterimCommit(task('t1', { status: 'stopped', branch: 'main' })), false, 'a settled Task has no working copy left');

  const rows = open(
    [item('i1'), item('i2', { status: 'developing', taskIds: ['t2'] })],
    [task('t2', { status: 'developing', completedAt: null, branch: 'main' })],
  );
  assert.deepEqual(rows.map((r) => r.canInterimCommit), [false, true]);
});

test('interimCommitNotice names the new commit, or says there was nothing to commit', () => {
  assert.equal(interimCommitNotice({ committed: true, message: 'Interim Commit 2026-09-25T10:00:00.000Z' }), 'Committed and pushed "Interim Commit 2026-09-25T10:00:00.000Z".');
  assert.match(interimCommitNotice({ committed: false, message: 'Interim Commit x' }), /Nothing new to commit/);
});

test('a stopped terminal item with a saved session is paused and resumable', () => {
  const t = task('t1', { status: 'stopped', executionMode: 'terminal', sessionId: 'sess-1' });
  const [row] = open([item('i1', { status: 'stopped', taskIds: ['t1'] })], [t]);
  assert.equal(row.state, 'paused');
  assert.equal(row.primary, 'resume');
  assert.equal(row.canComplete, true);
  assert.equal(row.completesViaSession, true, 'completing asks about the docs step, same as the session view');
  assert.equal(row.canArchive, true);
});

test('only a paused terminal session completes through its session; anything else is marked done directly', () => {
  const rows = open(
    [
      item('i1'),
      item('i2', { status: 'stopped', taskIds: ['t2'] }),
      item('i3', { status: 'failed', taskIds: ['t3'] }),
    ],
    [task('t2', { status: 'stopped', executionMode: 'structured' }), task('t3', { status: 'failed' })],
  );
  assert.deepEqual(rows.map((r) => r.completesViaSession), [false, false, false]);
});

test('completesViaSession matches a stopped terminal Task only', () => {
  assert.equal(completesViaSession(task('t1', { status: 'stopped' })), true);
  assert.equal(completesViaSession(task('t1', { status: 'stopped', executionMode: 'structured' })), false);
  assert.equal(completesViaSession(task('t1', { status: 'failed' })), false);
});

test('a stopped structured item, or a stopped terminal item with no saved session, is plainly stopped and re-runs from scratch', () => {
  const structured = task('t1', { status: 'stopped', executionMode: 'structured' });
  const noSession = task('t2', { status: 'stopped', executionMode: 'terminal', sessionId: null });
  const rows = open(
    [item('i1', { status: 'stopped', taskIds: ['t1'] }), item('i2', { status: 'stopped', taskIds: ['t2'] })],
    [structured, noSession],
  );
  assert.deepEqual(rows.map((r) => [r.state, r.primary]), [['stopped', 'start'], ['stopped', 'start']]);
});

test('a failed terminal item with a saved session offers resume; a failed one without offers a fresh start', () => {
  const withSession = task('t1', { status: 'failed', sessionId: 'sess-1' });
  const without = task('t2', { status: 'failed', sessionId: null });
  const rows = open(
    [item('i1', { status: 'failed', taskIds: ['t1'] }), item('i2', { status: 'failed', taskIds: ['t2'] })],
    [withSession, without],
  );
  assert.deepEqual(rows.map((r) => [r.state, r.primary]), [['failed', 'resume'], ['failed', 'start']]);
});

test('a blocked item has no play control (it is answered from its session) and cannot be completed or deleted', () => {
  const t = task('t1', { status: 'blocked', completedAt: null });
  const [row] = open([item('i1', { status: 'blocked', taskIds: ['t1'] })], [t]);
  assert.equal(row.state, 'blocked');
  assert.equal(row.primary, 'none');
  assert.equal(row.canComplete, false);
  assert.equal(row.canDelete, false);
});

test('a live terminal waiting for input overrides stale executing task-list state', () => {
  const t = task('t1', { status: 'developing', completedAt: null, runtimeStatus: 'waiting_input' });
  const [row] = open([item('i1', { status: 'developing', taskIds: ['t1'] })], [t]);
  assert.equal(row.state, 'blocked');
  assert.equal(row.primary, 'none');
});

test('a planning terminal waiting for input is not presented as running', () => {
  const t = task('t1', { kind: 'plan', status: 'developing', completedAt: null, runtimeStatus: 'waiting_input' });
  const [row] = buildPlanningRows({ taskIds: ['t1'], tasksById: byId(t), showArchived: false, now: NOW });
  assert.equal(row.live, 'blocked');
});

test('a planning row is titled with its session number, taken from any Task in the chain', () => {
  const first = task('t1', { kind: 'plan', description: 'Plan the backend', createdAt: minutesAgo(60), sessionId: 's1' });
  const followUp = task('t2', { kind: 'plan', description: 'One more thing', conversationId: 's1', sessionId: 's1', createdAt: minutesAgo(10), planningSessionNumber: 3 });
  const [row] = buildPlanningRows({ taskIds: ['t2', 't1'], tasksById: byId(first, followUp), showArchived: false, now: NOW });
  assert.equal(row.title, '3: Plan the backend');

  const [legacy] = buildPlanningRows({ taskIds: ['t9'], tasksById: byId(task('t9', { kind: 'plan', description: 'Old session' })), showArchived: false, now: NOW });
  assert.equal(legacy.title, 'Old session', 'a session that predates numbering keeps its plain title');
});

test('the worker shown is the saved assignment, falling back to the last Task\'s executor, then null', () => {
  const t = task('t1', { status: 'failed', executorId: 'exec-codex', sessionId: null });
  const rows = open(
    [
      item('assigned', { executorId: 'exec-claude' }),
      item('ran', { status: 'failed', taskIds: ['t1'] }),
      item('fresh'),
    ],
    [t],
  );
  assert.deepEqual(rows.map((r) => r.workerId), ['exec-claude', 'exec-codex', null]);
});

test('done items never appear among open rows', () => {
  assert.deepEqual(open([item('i1', { status: 'done' })]), []);
});

test('archiving is read from the latest Task, and the active and archived sets are disjoint', () => {
  const archived = task('t1', { status: 'failed', archived: true, sessionId: null });
  const items = [item('a', { status: 'failed', taskIds: ['t1'] }), item('b')];
  const tasksById = byId(archived);
  const active = buildOpenTaskRows({ items, tasksById, showArchived: false, now: NOW });
  const arch = buildOpenTaskRows({ items, tasksById, showArchived: true, now: NOW });
  assert.deepEqual(active.map((r) => r.id), ['b']);
  assert.deepEqual(arch.map((r) => r.id), ['a']);
});

test('an item whose Tasks have not loaded yet still builds a row with no metrics', () => {
  const [row] = open([item('i1', { status: 'stopped', taskIds: ['missing'] })]);
  assert.equal(row.metrics, null);
  assert.equal(row.latestTaskId, null);
  assert.equal(row.primary, 'start');
});

test('planning rows group a follow-up chain into one session titled by its original prompt', () => {
  const first = task('t1', { kind: 'plan', description: 'Plan the auth flow\nwith details', conversationId: 'c1', tokenUsage: usage(1000), createdAt: minutesAgo(90), completedAt: minutesAgo(80) });
  const followUp = task('t2', { kind: 'plan', description: 'Also cover password reset', conversationId: 'c1', tokenUsage: usage(2000), createdAt: minutesAgo(30), completedAt: minutesAgo(20) });
  const rows = buildPlanningRows({ taskIds: ['t2', 't1'], tasksById: byId(first, followUp), showArchived: false, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 't2', 'opens on the chain\'s latest Task');
  assert.equal(rows[0].title, 'Plan the auth flow');
  assert.equal(rows[0].description, 'Also cover password reset');
  assert.equal(rows[0].metrics.tokens, 3000);
  assert.equal(rows[0].metrics.startedAt, minutesAgo(90));
  assert.equal(rows[0].live, 'idle');
  assert.equal(rows[0].canArchive, true);
});

test('planning rows report a running or blocked turn as live and refuse to archive it', () => {
  const running = task('t1', { kind: 'plan', status: 'developing', completedAt: null });
  const blocked = task('t2', { kind: 'plan', status: 'blocked', completedAt: null, conversationId: 'other' });
  const rows = buildPlanningRows({ taskIds: ['t1', 't2'], tasksById: byId(running, blocked), showArchived: false, now: NOW });
  assert.deepEqual(rows.map((r) => [r.live, r.canArchive]), [['running', false], ['blocked', false]]);
});

test('planning rows ignore execute Tasks and split archived from active sessions', () => {
  const plan = task('t1', { kind: 'plan' });
  const archivedPlan = task('t2', { kind: 'plan', archived: true, conversationId: 'c2' });
  const exec = task('t3', { kind: 'execute' });
  const tasksById = byId(plan, archivedPlan, exec);
  const taskIds = ['t1', 't2', 't3'];
  assert.deepEqual(buildPlanningRows({ taskIds, tasksById, showArchived: false, now: NOW }).map((r) => r.id), ['t1']);
  assert.deepEqual(buildPlanningRows({ taskIds, tasksById, showArchived: true, now: NOW }).map((r) => r.id), ['t2']);
});

test('planning rows leave the description empty when a session has only its original prompt', () => {
  const only = task('t1', { kind: 'plan', description: 'Just one turn' });
  const [row] = buildPlanningRows({ taskIds: ['t1'], tasksById: byId(only), showArchived: false, now: NOW });
  assert.equal(row.description, '');
});

test('completed rows are done items and settled execute Tasks that have no listed plan item, together newest-completed first', () => {
  const doneTask = task('t1', { planItemId: 'i1', completedAt: minutesAgo(100), tokenUsage: usage(500) });
  const freeform = task('t2', { completedAt: minutesAgo(10), description: 'Freeform run\nmore' });
  const failedFreeform = task('t3', { status: 'failed', completedAt: null, updatedAt: minutesAgo(50), failureReason: 'exit 1' });
  const orphanedByDelete = task('t4', { planItemId: 'deleted-item', completedAt: minutesAgo(70) });
  const running = task('t5', { status: 'developing', completedAt: null });
  const planKind = task('t6', { kind: 'plan' });
  const rows = buildCompletedRows({
    items: [item('i1', { status: 'done', taskIds: ['t1'], title: 'Ship it' }), item('i2', { status: 'pending' }), item('i3', { status: 'done', order: 2, updatedAt: minutesAgo(1) })],
    taskIds: ['t1', 't2', 't3', 't4', 't5', 't6'],
    tasksById: byId(doneTask, freeform, failedFreeform, orphanedByDelete, running, planKind),
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => [r.id, r.kind]), [['i3', 'item'], ['t2', 'task'], ['t3', 'task'], ['t4', 'task'], ['i1', 'item']], 'by completion time, not plan order');
  assert.equal(rows[4].title, 'Ship it');
  assert.equal(rows[4].metrics.tokens, 500);
  assert.equal(rows[1].title, 'Freeform run');
  assert.equal(rows[2].failed, true);
  assert.equal(rows[2].description, 'exit 1');
});

// ---- Completion order ----

const wfRun = (id, patch = {}) => ({ id, projectId: 'p1', status: 'completed', createdAt: minutesAgo(300), updatedAt: minutesAgo(1), completedAt: null, ...patch });

test('itemCompletedAt prefers the run\'s completedAt, even over a later item update', () => {
  assert.equal(itemCompletedAt({ updatedAt: minutesAgo(1) }, task('t', { completedAt: minutesAgo(2) }), { completedAt: minutesAgo(40) }), minutesAgo(40));
});

test('itemCompletedAt without a finished run takes the later of the item\'s update and its latest Task\'s settle', () => {
  const settled = task('t', { completedAt: minutesAgo(20) });
  assert.equal(itemCompletedAt({ updatedAt: minutesAgo(5) }, settled, { completedAt: null }), minutesAgo(5), 'marked complete by hand after a stopped run');
  assert.equal(itemCompletedAt({ updatedAt: minutesAgo(50) }, settled, undefined), minutesAgo(20), 'finished by its Task');
  assert.equal(itemCompletedAt({ updatedAt: minutesAgo(50) }, task('t', { completedAt: null, updatedAt: minutesAgo(8) }), undefined), minutesAgo(8), 'a Task with no completedAt settles at its last update');
  assert.equal(itemCompletedAt({ updatedAt: minutesAgo(9) }, undefined, undefined), minutesAgo(9), 'done by hand, never run');
});

test('itemCompletedAt is null when no timestamp is known', () => {
  assert.equal(itemCompletedAt({ updatedAt: '' }, undefined, undefined), null);
  assert.equal(itemCompletedAt({ updatedAt: 'not a date' }, task('t', { completedAt: null, updatedAt: '' }), { completedAt: null }), null);
});

test('sortByCompletedDesc puts newest first, missing timestamps last, and keeps given order on ties', () => {
  const rows = [
    { id: 'none1', completedAt: null },
    { id: 'old', completedAt: minutesAgo(90) },
    { id: 'tieA', completedAt: minutesAgo(10) },
    { id: 'bad', completedAt: 'nope' },
    { id: 'new', completedAt: minutesAgo(1) },
    { id: 'tieB', completedAt: minutesAgo(10) },
    { id: 'none2', completedAt: null },
  ];
  assert.deepEqual(sortByCompletedDesc(rows).map((row) => row.id), ['new', 'tieA', 'tieB', 'old', 'none1', 'bad', 'none2']);
  assert.equal(rows[0].id, 'none1', 'the input is left untouched');
});

test('Completed orders a run-completed item by its run, and a hand-completed item by its update', () => {
  const items = [
    item('byRun', { status: 'developing', workflowRunId: 'r1', taskIds: ['t1'], updatedAt: minutesAgo(1) }),
    item('byHand', { status: 'done', updatedAt: minutesAgo(15) }),
    item('noTime', { status: 'done', updatedAt: '' }),
    item('older', { status: 'done', taskIds: ['t2'] }),
  ];
  const rows = buildCompletedRows({
    items,
    taskIds: [],
    tasksById: byId(task('t1', { planItemId: 'byRun', completedAt: minutesAgo(3) }), task('t2', { planItemId: 'older', completedAt: minutesAgo(45) })),
    workflowRuns: [wfRun('r1', { completedAt: minutesAgo(30) })],
    now: NOW,
  });
  assert.deepEqual(rows.map((row) => [row.id, row.completedAt]), [['byHand', minutesAgo(15)], ['byRun', minutesAgo(30)], ['older', minutesAgo(45)], ['noTime', null]]);
});

test('a newly completed item lands at the top of Completed, wherever it sits in plan order', () => {
  const settledBefore = [item('a', { status: 'done', order: 0, updatedAt: minutesAgo(60) }), item('b', { status: 'done', order: 1, updatedAt: minutesAgo(30) })];
  const justMarked = item('c', { status: 'pending', order: 2 });
  const before = buildCompletedRows({ items: [...settledBefore, justMarked], taskIds: [], tasksById: {}, now: NOW });
  assert.deepEqual(before.map((row) => row.id), ['b', 'a']);
  const byHand = buildCompletedRows({ items: [...settledBefore, { ...justMarked, status: 'done', updatedAt: minutesAgo(0) }], taskIds: [], tasksById: {}, now: NOW });
  assert.deepEqual(byHand.map((row) => row.id), ['c', 'b', 'a'], 'marked complete by hand');
  const byRun = buildCompletedRows({
    items: [...settledBefore, { ...justMarked, status: 'developing', workflowRunId: 'r' }],
    taskIds: [],
    tasksById: {},
    workflowRuns: [wfRun('r', { completedAt: minutesAgo(0) })],
    now: NOW,
  });
  assert.deepEqual(byRun.map((row) => row.id), ['c', 'b', 'a'], 'its run completed');
});

test('an item marked done by hand, with no Task, completes at its last update and cannot open a session', () => {
  const [row] = buildCompletedRows({
    items: [item('i1', { status: 'done', updatedAt: minutesAgo(5) })],
    taskIds: [],
    tasksById: {},
    now: NOW,
  });
  assert.equal(row.completedAt, minutesAgo(5));
  assert.equal(row.metrics, null);
  assert.equal(row.canOpenSession, false);
  assert.equal(row.canDelete, true);
});

test('completed and archived rows carry their item\'s WorkflowRun, so opening one shows the whole run rather than its last step', () => {
  const items = [
    item('run', { status: 'done', workflowRunId: 'r1', taskIds: ['t1', 't2'] }),
    item('plain', { status: 'done', taskIds: ['t3'] }),
    item('archivedRun', { status: 'done', archived: true, workflowRunId: 'r2', taskIds: ['t4'] }),
  ];
  const tasksById = byId(task('t1', { planItemId: 'run' }), task('t2', { planItemId: 'run' }), task('t3', { planItemId: 'plain' }), task('t4', { planItemId: 'archivedRun' }), task('free'));
  const completed = buildCompletedRows({ items, taskIds: ['free'], tasksById, now: NOW });
  const byRow = Object.fromEntries(completed.map((row) => [row.id, row]));
  assert.equal(byRow.run.workflowRunId, 'r1');
  assert.deepEqual(cardDetail(byRow.run), { kind: 'run', id: 'r1' }, 'not the last step\'s session t2');
  assert.equal(byRow.plain.workflowRunId, null);
  assert.deepEqual(cardDetail(byRow.plain), { kind: 'task', id: 't3' });
  assert.equal(byRow.free.workflowRunId, null, 'a bare Task row has no run');

  const [archived] = buildArchivedRows({ items, tasksById, now: NOW });
  assert.deepEqual(cardDetail(archived), { kind: 'run', id: 'r2' });
});

test('only completed plan items can be deleted — a bare Task has no delete endpoint yet', () => {
  const rows = buildCompletedRows({
    items: [item('i1', { status: 'done' })],
    taskIds: ['t1'],
    tasksById: byId(task('t1')),
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.canDelete]).sort(), [['item', true], ['task', false]]);
});

test('spentLabel formats total run time', () => {
  assert.equal(spentLabel({ tokens: 0, startedAt: minutesAgo(90), spentMs: 72 * 60_000 }), '1h 12m spent');
});

test('workerLabel names the executor, says Unassigned for none, and falls back to the raw id for a deleted one', () => {
  const executors = [{ id: 'exec-claude', label: 'Claude' }, { id: 'exec-codex', label: 'Codex (work)' }];
  assert.equal(workerLabel(executors, 'exec-codex'), 'Codex (work)');
  assert.equal(workerLabel(executors, null), 'Unassigned');
  assert.equal(workerLabel(executors, 'gone'), 'gone');
});

test('an open row needs attention only when blocked (waiting for input) or failed', () => {
  const blocked = task('t1', { status: 'blocked', completedAt: null });
  const failed = task('t2', { status: 'failed', sessionId: null });
  const stopped = task('t3', { status: 'stopped', sessionId: 'sess-3' });
  const running = task('t4', { status: 'developing', completedAt: null });
  const rows = open(
    [
      item('blocked', { status: 'blocked', taskIds: ['t1'] }),
      item('failed', { status: 'failed', taskIds: ['t2'] }),
      item('paused', { status: 'stopped', taskIds: ['t3'] }),
      item('running', { status: 'developing', taskIds: ['t4'] }),
      item('fresh'),
    ],
    [blocked, failed, stopped, running],
  );
  assert.deepEqual(rows.map((r) => [r.id, r.attention]), [['blocked', 'input'], ['failed', 'failed'], ['paused', null], ['running', null], ['fresh', null]]);
});

test('a planning session waiting on an answer needs input; a running or idle one does not', () => {
  const blocked = task('t1', { kind: 'plan', status: 'blocked', completedAt: null });
  const running = task('t2', { kind: 'plan', status: 'developing', completedAt: null, conversationId: 'c2' });
  const idle = task('t3', { kind: 'plan', conversationId: 'c3' });
  const rows = buildPlanningRows({ taskIds: ['t1', 't2', 't3'], tasksById: byId(blocked, running, idle), showArchived: false, now: NOW });
  assert.deepEqual(rows.map((r) => r.attention), ['input', null, null]);
});

test('a completed row needs attention only for a failed task with no plan item; a finished one never does', () => {
  const rows = buildCompletedRows({
    items: [item('i1', { status: 'done' })],
    taskIds: ['t1', 't2'],
    tasksById: byId(task('t1', { status: 'failed', completedAt: null }), task('t2')),
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => [r.kind === 'item' ? r.id : r.id, r.attention]).sort(), [['i1', null], ['t1', 'failed'], ['t2', null]]);
});

test('worstAttention ranks waiting on the user above a failure, and is null when nothing needs attention', () => {
  assert.equal(worstAttention([]), null);
  assert.equal(worstAttention([{ attention: null }, { attention: null }]), null);
  assert.equal(worstAttention([{ attention: null }, { attention: 'failed' }]), 'failed');
  assert.equal(worstAttention([{ attention: 'failed' }, { attention: 'input' }]), 'input');
});

test('a terminal task waiting for input is shown as needing input even while its plan item is still developing', () => {
  const t = task('t1', { status: 'developing', completedAt: null, executionMode: 'terminal', runtimeStatus: 'waiting_input' });
  const [row] = open([item('i1', { status: 'developing', taskIds: ['t1'] })], [t]);
  assert.equal(row.state, 'blocked');
  assert.equal(row.attention, 'input');
  assert.equal(row.primary, 'none');
});

test('taskDescriptionText prefers the plan item description and falls back to the task prompt', () => {
  assert.equal(taskDescriptionText({ description: 'Title\n\nBody' }, { description: ' What I typed ' }), 'What I typed');
  assert.equal(taskDescriptionText({ description: ' Title only ' }, { description: '  ' }), 'Title only');
  assert.equal(taskDescriptionText({ description: 'Chat prompt' }, null), 'Chat prompt');
  assert.equal(taskDescriptionText({ description: 'Chat prompt' }), 'Chat prompt');
});

test('open rows keep plan order, executing or not, and carry no priority or queue fields', () => {
  const items = [item('a'), item('b', { status: 'developing', taskIds: ['tb'] }), item('c')];
  const rows = open(items, [task('tb', { status: 'developing' })]);
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
  for (const field of ['priority', 'queueEntryId', 'queuePosition', 'holdsExecutor']) assert.equal(field in rows[0], false, field);
});

test('a stopped non-resumable item never blocks another: it just offers a fresh start', () => {
  const rows = open([item('old', { status: 'stopped', taskIds: ['t1'] }), item('new')], [task('t1', { status: 'stopped', executionMode: 'structured', sessionId: null })]);
  assert.deepEqual(rows.map((row) => [row.id, row.state, row.primary]), [['old', 'stopped', 'start'], ['new', 'todo', 'start']]);
});

test('taskProgress splits items into done, in progress (running or blocked) and pending', () => {
  const statuses = ['done', 'done', 'developing', 'blocked', 'pending', 'stopped', 'failed'];
  assert.deepEqual(taskProgress(statuses.map((status) => ({ status }))), { done: 2, inProgress: 2, pending: 3, total: 7 });
});

test('taskProgress of an empty plan is all zeros', () => {
  assert.deepEqual(taskProgress([]), { done: 0, inProgress: 0, pending: 0, total: 0 });
});

test('taskProgressLabel names all three counts', () => {
  assert.equal(taskProgressLabel({ done: 3, inProgress: 1, pending: 2, total: 6 }), '3 done · 1 in progress · 2 pending');
});

// ---- Task details header helpers ----

test('planItemSpentMs sums every Task\'s (end − start), counting a live one up to now', () => {
  const settled = task('t1', { createdAt: minutesAgo(90), completedAt: minutesAgo(60) });
  const stoppedNoCompletion = task('t2', { status: 'stopped', createdAt: minutesAgo(50), updatedAt: minutesAgo(40), completedAt: null });
  const live = task('t3', { status: 'developing', createdAt: minutesAgo(20), completedAt: null });
  const tasksById = byId(settled, stoppedNoCompletion, live);
  assert.equal(planItemSpentMs(item('i', { taskIds: ['t1', 't2', 't3'] }), tasksById, NOW), (30 + 10 + 20) * 60_000);
  assert.equal(planItemSpentMs(item('i', { taskIds: ['t3'] }), tasksById, NOW + 60_000), 21 * 60_000, 'ticks while live');
  assert.equal(planItemSpentMs(item('i'), tasksById, NOW), 0, 'nothing run yet');
  assert.equal(planItemSpentMs(item('i', { taskIds: ['not-loaded'] }), tasksById, NOW), 0);
});

test('latestItemTask is the item\'s last Task, undefined before it has run', () => {
  const tasksById = byId(task('t1'), task('t2', { sessionId: 'sess-2' }));
  assert.equal(latestItemTask(item('i', { taskIds: ['t1', 't2'] }), tasksById).sessionId, 'sess-2');
  assert.equal(latestItemTask(item('i'), tasksById), undefined);
});

test('archive is refused (with a reason) only while developing', () => {
  assert.equal(archiveBlockedReason({ status: 'developing' }), 'Stop the task before archiving it.');
  for (const status of ['pending', 'blocked', 'stopped', 'failed', 'done']) assert.equal(archiveBlockedReason({ status }), null, status);
});

test('planItemActions: mark complete hides once done; a run-backed item can complete or delete while it runs', () => {
  assert.deepEqual(planItemActions({ status: 'pending' }), { canArchive: true, canComplete: true, canDelete: true });
  assert.deepEqual(planItemActions({ status: 'done', workflowRunId: 'r' }), { canArchive: true, canComplete: false, canDelete: true });
  assert.deepEqual(planItemActions({ status: 'developing', workflowRunId: 'r' }), { canArchive: false, canComplete: true, canDelete: true });
  assert.deepEqual(planItemActions({ status: 'blocked', workflowRunId: 'r' }), { canArchive: true, canComplete: true, canDelete: true });
  assert.deepEqual(planItemActions({ status: 'developing' }), { canArchive: false, canComplete: false, canDelete: false }, 'a pre-workflow live Task');
});

test('archived items leave both the open list and Completed; a run-backed item completes through its plan item', () => {
  const items = [item('a', { archived: true }), item('b'), item('c', { status: 'done', archived: true }), item('d', { status: 'done' })];
  assert.deepEqual(open(items).map((r) => r.id), ['b']);
  assert.deepEqual(open(items, [], { showArchived: true }).map((r) => r.id), ['a']);
  const archivedTask = task('t9', { archived: true });
  assert.deepEqual(buildCompletedRows({ items, taskIds: ['t9'], tasksById: byId(archivedTask), now: NOW }).map((r) => r.id), ['d']);
  const [row] = open([item('r', { status: 'stopped', taskIds: ['t'], workflowRunId: 'run' })], [task('t', { status: 'stopped' })]);
  assert.equal(row.completesViaSession, false);
});

test('a planning session is titled by its generated title, numbered, with its opening prompt as the description', () => {
  const titled = task('t1', { kind: 'plan', description: 'Let us plan the notification system\nin detail', title: 'Plan the notification delivery system', planningSessionNumber: 4 });
  const [row] = buildPlanningRows({ taskIds: ['t1'], tasksById: byId(titled), showArchived: false, now: NOW });
  assert.equal(row.title, '4: Plan the notification delivery system');
  assert.equal(row.description, 'Let us plan the notification system', 'title and description no longer repeat each other');
});

test('planningSessionTitle takes the title from any Task of the chain, else the earliest prompt, in any order', () => {
  const first = task('t1', { kind: 'plan', description: 'Plan the auth flow', createdAt: minutesAgo(60) });
  const followUp = task('t2', { kind: 'plan', description: 'One more thing', createdAt: minutesAgo(10) });
  assert.equal(planningSessionTitle([followUp, first]), 'Plan the auth flow');
  assert.equal(planningSessionTitle([followUp, { ...first, title: 'Design the auth flow' }]), 'Design the auth flow');
  assert.equal(planningSessionTitle([{ ...followUp, planningSessionNumber: 2 }, first]), '2: Plan the auth flow');
});

test('canResumeSession: a settled, unarchived terminal session with a saved session id', () => {
  for (const status of ['done', 'failed', 'stopped']) assert.equal(canResumeSession(task('t1', { status })), true, status);
  assert.equal(canResumeSession(task('t1', { status: 'developing' })), false, 'still live');
  assert.equal(canResumeSession(task('t1', { archived: true })), false, 'archived');
  assert.equal(canResumeSession(task('t1', { sessionId: null })), false, 'nothing to resume');
  assert.equal(canResumeSession(task('t1', { executionMode: 'structured' })), false, 'not a terminal session');
});

test('planningSessionName is the title without the session number', () => {
  const titled = task('t1', { kind: 'plan', title: 'Plan the auth flow', planningSessionNumber: 3 });
  assert.equal(planningSessionName([titled]), 'Plan the auth flow');
  assert.equal(planningSessionTitle([titled]), '3: Plan the auth flow');
});

test('taskProgress does not count a finished task with an unmerged Auto-merge PR as done', () => {
  const am = (state) => ({ enabled: true, state, reasons: [] });
  const base = { status: 'done', workflowRunId: 'r1' };
  const progress = taskProgress([{ ...base, autoMerge: am('merging') }, { ...base, autoMerge: am('merged') }, { ...base }]);
  assert.deepEqual(progress, { done: 2, inProgress: 1, pending: 0, total: 3 });
});
