import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const bugs = await import('../src/lib/bugs.ts');
const {
  bugReportCountsLabel, bugReportHistory, buildArchivedRows, buildCompletedRows, buildOpenTaskRows, buildPlanningQueue, buildPlanningRows,
  planningHistoryCountsLabel, planningQueueOrderEntries, planningTaskHistory, queueCardId,
} = await import('../src/lib/projectTasks.ts');
const { boardKeyAction, canDragCard, canDropOn, dropAnnouncement, planBoardDrop, splitTaskNumber, taskItemInfo } = await import('../src/lib/taskBoard.ts');
const { buildPlanningTaskPanel, detailBackTarget, planningRowDetail, sessionHistoryView, sessionPanelWording } = await import('../src/lib/planningTaskPanel.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { planAndBugsDraftStorageKey, clearPlanAndBugsDraft, readPlanAndBugsDraft, savePlanAndBugsDraft } = await import('../src/lib/planAndBugsDraft.ts');
const { taskDraftStorageKey } = await import('../src/lib/taskDraft.ts');
const { resolveExecutorChoice } = await import('../src/lib/executorAvailability.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

// The bug tracker on the Tasks board. Decisions are tested against the pure helpers (lib/bugs.ts and
// the board view-models), the store against the server stub, and component wiring by source pins:
// the web has no render harness, so nothing here proves how a card looks or drags in a browser.

const AT = '2026-10-01T10:00:00.000Z';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const at = (minutes) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

const item = (id, patch = {}) => ({
  id, projectId: 'p1', title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [],
  executorId: null, createdAt: AT, updatedAt: AT, ...patch,
});
const INTRO = { planItemId: 'intro', number: '4.002', title: 'Add login', commit: 'abc1234def' };
const attributes = (patch = {}) => ({
  severity: null, infoStatus: 'enough', introducedBy: INTRO, suspectedLocation: null, foundWhileWorkingOn: null,
  reportSessionNumber: null, testRef: null, groupOrder: null, regressions: [], ...patch,
});
const bug = (id, bugPatch = {}, patch = {}) => item(id, { type: 'bug', title: `B.00${id.length}: Bug ${id}`, bug: attributes(bugPatch), ...patch });
const introducer = (patch = {}) => item('intro', { title: '4.002: Add login', status: 'done', ...patch });
const session = (id, patch = {}) => ({
  id, projectId: 'p1', executorId: 'exec-claude', executionMode: 'terminal', description: `Session ${id}`, status: 'stopped', autonomy: 'auto',
  kind: 'plan', planItemId: null, sessionId: `sess-${id}`, blockedQuestion: null, failureReason: null, createdAt: AT, updatedAt: AT, completedAt: null,
  planningSessionNumber: 1, planningCreatedTaskCount: 0, ...patch,
});
const reportSession = (id, patch = {}) => session(id, { planningPurpose: 'bug-report', ...patch });

const byId = (records) => Object.fromEntries(records.map((record) => [record.id, record]));
const queueOf = (items, sessions = []) => buildPlanningQueue({ items, taskIds: sessions.map((s) => s.id), tasksById: byId(sessions), now: NOW });
const shape = (queue) => queue.map((entry) => entry.kind === 'reference'
  ? ['reference', entry.id, entry.reference.bugs.map((row) => row.id)]
  : entry.kind === 'session'
    ? ['session', entry.id, entry.session.ready.map((row) => row.id), (entry.session.references ?? []).map((group) => [group.id, group.bugs.map((row) => row.id)])]
    : ['task', entry.id]);
const referenceOf = (queue, id = 'intro') => queue.find((entry) => entry.kind === 'reference' && entry.id === id)?.reference
  ?? queue.flatMap((entry) => entry.kind === 'session' ? entry.session.references ?? [] : []).find((group) => group.id === id);
const rowOf = (planItem, others = []) => buildOpenTaskRows({ items: [planItem, ...others], tasksById: {}, showArchived: false, now: NOW })[0];

// ---- Badges and labels (W1–W5) ----

test('W1 a bug gets the "Bug" badge; an item with no type gets none; a bug never gets the Planning label', () => {
  assert.equal(bugs.BUG_BADGE_LABEL, 'Bug');
  assert.ok(rowOf(bug('a')).bug);
  assert.equal(rowOf(item('plain')).bug, undefined);
  assert.equal('bug' in rowOf(item('plain')), false);
  assert.equal(rowOf(bug('a')).typeLabel, undefined, 'no Planning (or any other) type label');
  assert.equal(bugs.isBugItem(item('plain')), false);
  assert.equal(bugs.isBugItem(bug('a')), true);
});

test('W2 the severity badge reads "<Level> severity" for each of the four, and there is none when unset', () => {
  assert.deepEqual(['critical', 'high', 'medium', 'low'].map(bugs.severityBadgeLabel), ['Critical severity', 'High severity', 'Medium severity', 'Low severity']);
  assert.equal(bugs.severityBadgeLabel(null), null);
  assert.equal(rowOf(bug('a', { severity: 'high' })).bug.severityLabel, 'High severity');
  assert.equal(rowOf(bug('a')).bug.severityLabel, null);
});

test('W3 "Needs more info" is a badge, "Enough info" is footer text, and an unset flag shows neither', () => {
  const info = (infoStatus) => { const { needsMoreInfo, footer } = rowOf(bug('a', { infoStatus })).bug; return { needsMoreInfo, footer }; };
  assert.deepEqual(info('needs-more-info'), { needsMoreInfo: true, footer: null });
  assert.deepEqual(info('enough'), { needsMoreInfo: false, footer: 'Enough info' });
  assert.deepEqual(info(null), { needsMoreInfo: false, footer: null });
});

test('W4 a bug\'s status is the same as a task\'s in every state, and it has none before it starts', () => {
  for (const status of ['pending', 'developing', 'blocked', 'stopped', 'failed']) {
    assert.equal(rowOf(bug('a', {}, { status })).state, rowOf(item('a', { status })).state, status);
  }
  assert.equal(rowOf(bug('a')).state, 'todo');
  const done = (planItem) => buildCompletedRows({ items: [planItem], taskIds: [], tasksById: {}, now: NOW })[0].statusBadge;
  assert.equal(done(bug('a', {}, { status: 'done' })), done(item('a', { status: 'done' })));
  assert.equal(done(bug('a', {}, { status: 'done' })), 'Completed');
});

test('W5 "Introduced by" shows the number, title and short commit; it links only while that task exists; nothing when unknown', () => {
  assert.equal(bugs.introducedByText(INTRO), '4.002: Add login · abc1234');
  assert.equal(bugs.introducedByText({ ...INTRO, commit: null }), '4.002: Add login');
  assert.equal(bugs.introducedByText({ ...INTRO, number: null, commit: null }), 'Add login');
  assert.deepEqual(rowOf(bug('a'), [introducer()]).bug.introducedBy, { text: '4.002: Add login · abc1234', taskId: 'intro' });
  assert.deepEqual(rowOf(bug('a')).bug.introducedBy, { text: '4.002: Add login · abc1234', taskId: null }, 'removed: the stored text, no link');
  assert.equal(rowOf(bug('a', { introducedBy: null })).bug.introducedBy, null);
});

test('a bug number splits off the title like a task number, and a bug says where it came from', () => {
  assert.deepEqual(splitTaskNumber('4.002.001: Crash'), { number: '4.002.001', name: 'Crash' });
  assert.deepEqual(splitTaskNumber('B.004: Crash'), { number: 'B.004', name: 'Crash' });
  assert.deepEqual(splitTaskNumber('3.002: Add login'), { number: '3.002', name: 'Add login' });
  assert.deepEqual(splitTaskNumber('Typed by hand'), { number: null, name: 'Typed by hand' });
  assert.equal(taskItemInfo(bug('a', { reportSessionNumber: 7 }), {}).provenance, 'From bug report session 7');
  assert.equal(taskItemInfo(bug('a'), {}).provenance, 'Found by a coding agent');
  assert.equal(taskItemInfo(item('plain'), {}).provenance, 'Added manually');
});

test('unreadable bug attributes from the daemon read as absent, never as an error', () => {
  const empty = bugs.readBugAttributes(null);
  assert.ok(Object.entries(empty).every(([key, value]) => (key === 'regressions' ? Array.isArray(value) && value.length === 0 : value === null)));
  assert.deepEqual(bugs.readBugAttributes('broken'), empty);
  assert.deepEqual(bugs.readBugAttributes({ severity: 'urgent', infoStatus: 'maybe', introducedBy: 'x', groupOrder: 'first', testRef: {} }), empty);
  assert.deepEqual(bugs.readBugAttributes(attributes({ severity: 'low', groupOrder: 2 })), attributes({ severity: 'low', groupOrder: 2 }));
  assert.ok(rowOf(item('a', { type: 'bug' })).bug, 'a bug with no attributes at all still shows as a bug');
});

// ---- Planning queue building (W6–W19) ----

test('W6 a ready bug with a Completed introducing task: a top-level reference entry with the bug nested, and the task is not also an entry', () => {
  const queue = queueOf([introducer(), bug('a')]);
  assert.deepEqual(shape(queue), [['reference', 'intro', ['a']]]);
  const reference = referenceOf(queue);
  assert.deepEqual({ number: reference.number, title: reference.title, status: reference.status, removed: reference.removed }, { number: '4.002', title: 'Add login', status: 'Completed', removed: false });
});

test('W7 the reference card shows the introducing task\'s badge in every state, archived-completed included', () => {
  const statusFor = (patch, tasksById = {}) => referenceOf(buildPlanningQueue({ items: [introducer(patch), bug('a')], taskIds: [], tasksById, now: NOW })).status;
  assert.equal(statusFor({ status: 'developing' }), 'Running');
  assert.equal(statusFor({ status: 'blocked' }), 'Needs you');
  assert.equal(statusFor({ status: 'stopped' }), 'Stopped');
  assert.equal(statusFor({ status: 'failed' }), 'Failed');
  assert.equal(statusFor({ status: 'done' }), 'Completed');
  assert.equal(statusFor({ status: 'done', archived: true }), 'Completed');
  const waiting = { id: 't1', executionMode: 'terminal', runtimeStatus: 'waiting_input' };
  assert.equal(statusFor({ status: 'developing', taskIds: ['t1'] }, { t1: waiting }), 'Needs you', 'a CLI waiting on the person');
});

test('W8 W19 when the introducing task\'s conversation is on the board, the reference sits in that group after its ready tasks, not at top level', () => {
  const conversation = session('plan-1', { planningSessionNumber: 4, planningCreatedTaskCount: 2 });
  const items = [
    introducer({ planningRef: { session: 4, task: 2 } }),
    item('ready', { title: '4.003: Still ready', planningRef: { session: 4, task: 3 } }),
    bug('a'), bug('bb'),
  ];
  const queue = queueOf(items, [conversation]);
  assert.deepEqual(shape(queue), [['session', 'plan-1', ['ready'], [['intro', ['a', 'bb']]]]]);
  assert.equal(queue.some((entry) => entry.kind === 'reference'), false, 'absent from the top-level list');
  assert.equal(queue[0].session.ready.some((row) => row.id === 'intro'), false, 'the introducing task is not nested among the ready tasks');
});

test('W9 conversation archived, completed or deleted, or a standalone introducing task: the reference is at top level', () => {
  const items = [introducer({ planningRef: { session: 4, task: 2 } }), bug('a')];
  const archived = session('plan-1', { planningSessionNumber: 4, archived: true, planningCompletedAt: at(5) });
  assert.deepEqual(shape(queueOf(items, [archived])), [['reference', 'intro', ['a']]]);
  assert.deepEqual(shape(queueOf(items, [])), [['reference', 'intro', ['a']]], 'conversation deleted');
  assert.deepEqual(shape(queueOf([introducer(), bug('a')])), [['reference', 'intro', ['a']]], 'standalone introducing task');
  const report = reportSession('report-1', { planningSessionNumber: 4 });
  assert.deepEqual(shape(queueOf([introducer({ planningRef: { session: 9, task: 1 } }), bug('a')], [report])).map(([kind]) => kind).sort(), ['reference', 'session']);
});

test('W10 a bug with no introducing task is a top-level entry of its own, draggable like a standalone card', () => {
  const queue = queueOf([bug('solo', { introducedBy: null })]);
  assert.deepEqual(shape(queue), [['task', 'solo']]);
  assert.ok(queue[0].task.bug);
  assert.equal(canDragCard('planning', { id: 'solo' }), true);
});

test('W11 a deleted introducing task: the reference shows "Removed" from the stored text, opens nothing, and keeps its bugs', () => {
  const items = [bug('a'), bug('bb')];
  const reference = referenceOf(queueOf(items));
  assert.deepEqual({ number: reference.number, title: reference.title, status: reference.status, removed: reference.removed }, { number: '4.002', title: 'Add login', status: 'Removed', removed: true });
  assert.deepEqual(reference.bugs.map((row) => row.id), ['a', 'bb']);
  assert.equal(planningRowDetail(items, {}, 'intro'), null, 'nothing to open');
  assert.equal(boardKeyAction('reference', { key: 'Enter', altKey: false }, reference.removed), null);
});

test('W12 the reference disappears when its last ready bug starts, is archived or is deleted', () => {
  const before = queueOf([introducer(), bug('a')]);
  assert.deepEqual(shape(before), [['reference', 'intro', ['a']]]);
  assert.deepEqual(shape(queueOf([introducer(), bug('a', {}, { archived: true })])), []);
  assert.deepEqual(shape(queueOf([introducer()])), [], 'deleted');
  const started = [introducer(), bug('a', {}, { status: 'developing', workflowRunId: 'run-1' })];
  const groups = buildTaskGroups({ items: started, tasksById: {}, workflowRunsByProject: { p1: [{ id: 'run-1', status: 'running', workflowSnapshot: { steps: [] }, currentStepId: null }] }, projectId: 'p1', showArchived: false, now: NOW });
  assert.deepEqual(shape(buildPlanningQueue({ items: started, taskIds: [], tasksById: {}, now: NOW, openRows: groups.open })), [], 'started');
  assert.deepEqual(shape(queueOf([introducer(), bug('a', {}, { status: 'developing', workflowRunId: 'run-1' }), bug('bb')])).at(-1), ['reference', 'intro', ['bb']], 'one ready bug left keeps it');
});

test('W13 a started bug is a Running row with its Bug badge and "Introduced by" link, in no group', () => {
  const items = [introducer(), bug('a', { severity: 'high' }, { status: 'developing', workflowRunId: 'run-1' })];
  const groups = buildTaskGroups({ items, tasksById: {}, workflowRunsByProject: { p1: [{ id: 'run-1', status: 'running', workflowSnapshot: { steps: [] }, currentStepId: null }] }, projectId: 'p1', showArchived: false, now: NOW });
  assert.deepEqual(groups.running.map((row) => row.id), ['a']);
  assert.deepEqual(groups.running[0].bug.introducedBy, { text: '4.002: Add login · abc1234', taskId: 'intro' });
  assert.equal(groups.running[0].bug.severityLabel, 'High severity');
  assert.equal(groups.open.some((row) => row.id === 'a'), false);
  const completed = buildCompletedRows({ items: [introducer(), bug('a', {}, { status: 'done' })], taskIds: [], tasksById: {}, now: NOW });
  assert.ok(completed.find((row) => row.id === 'a').bug.introducedBy.taskId, 'Completed too');
  assert.ok(buildArchivedRows({ items: [bug('a', {}, { status: 'done', archived: true })], tasksById: {}, now: NOW })[0].bug, 'and Archived');
});

test('W14 two bugs from two report sessions under one task share one reference', () => {
  const queue = queueOf([introducer(), bug('a', { reportSessionNumber: 1 }), bug('bb', { reportSessionNumber: 2 })]);
  assert.deepEqual(shape(queue), [['reference', 'intro', ['a', 'bb']]]);
});

test('W15 a report session entry nests no bugs: they sit under their introducing tasks', () => {
  const report = reportSession('report-1', { planningSessionNumber: 3, planningCreatedTaskCount: 2 });
  const queue = queueOf([introducer(), bug('a', { reportSessionNumber: 3 }), bug('solo', { reportSessionNumber: 3, introducedBy: null })], [report]);
  const entry = queue.find((candidate) => candidate.kind === 'session');
  assert.deepEqual(entry.session.ready, []);
  assert.equal(entry.session.references, undefined);
  assert.equal(entry.session.readyBugCount, 2);
  assert.deepEqual(shape(queue).map(([kind, id]) => `${kind}:${id}`).sort(), ['reference:intro', 'session:report-1', 'task:solo']);
});

test('W16 with no bugs the queue, the rows and the planning rows are exactly what they were', () => {
  const conversation = session('plan-1', { planningSessionNumber: 4, planningCreatedTaskCount: 1 });
  const items = [item('ready', { title: '4.001: Ready', planningRef: { session: 4, task: 1 } }), item('solo', { planningQueueOrder: 5 })];
  const queue = queueOf(items, [conversation]);
  assert.deepEqual(queue.map((entry) => entry.kind), ['session', 'task']);
  assert.deepEqual(Object.keys(queue[0].session).sort(), ['archived', 'archivedCount', 'attention', 'canArchive', 'cliNotStarted', 'completedAt', 'completedCount', 'createdTaskCount', 'description', 'id', 'kind', 'live', 'metrics', 'queueOrder', 'ready', 'removedCount', 'sessionNumber', 'startedCount', 'title', 'workerId'], 'no bug fields on a planning group');
  for (const row of [...queue[0].session.ready, queue[1].task]) assert.equal('bug' in row, false);
  const withTyped = queueOf(items.map((planItem) => ({ ...planItem })), [conversation]);
  assert.deepEqual(withTyped, queue);
});

test('W17 a group orders positioned bugs first, then unpositioned by creation time, then id', () => {
  const items = [
    introducer(),
    bug('late', {}, { createdAt: at(30) }),
    bug('second', { groupOrder: 1 }),
    bug('early-b', {}, { createdAt: at(10) }),
    bug('early-a', {}, { createdAt: at(10) }),
    bug('first', { groupOrder: 0 }, { createdAt: at(50) }),
  ];
  assert.deepEqual(referenceOf(queueOf(items)).bugs.map((row) => row.id), ['first', 'second', 'early-a', 'early-b', 'late']);
});

test('W18 a reference and a standalone bug sort in the shared top-level order with sessions and tasks', () => {
  const conversation = session('plan-1', { planningSessionNumber: 4, planningQueueOrder: 2 });
  const items = [
    introducer(),
    bug('a', {}, { planningQueueOrder: 1 }), bug('bb', {}, { planningQueueOrder: 1 }),
    bug('solo', { introducedBy: null }, { planningQueueOrder: 0 }),
    item('task', { planningQueueOrder: 3 }),
  ];
  const queue = queueOf(items, [conversation]);
  assert.deepEqual(queue.map((entry) => `${entry.kind}:${entry.id}`), ['task:solo', 'reference:intro', 'session:plan-1', 'task:task']);
  assert.equal(queueCardId(queue[1]), 'reference:intro', 'its board card id never collides with the task it stands for');
  assert.equal(queueCardId(queue[0]), 'solo');
  assert.deepEqual(planningQueueOrderEntries(queue, ['reference:intro', 'solo', 'plan-1', 'task']), [
    { kind: 'reference', id: 'intro' }, { kind: 'task', id: 'solo' }, { kind: 'session', id: 'plan-1' }, { kind: 'task', id: 'task' },
  ]);
  assert.equal(planningQueueOrderEntries(queue, ['solo', 'not-in-planning']), null, 'another column\'s reorder');
});

// ---- Counts (W20–W25) ----

test('W20 "Bugs · N ready" is the number of nested cards', () => {
  assert.equal(bugs.bugGroupCountLabel(1), 'Bugs · 1 ready');
  assert.equal(bugs.bugGroupCountLabel(2), 'Bugs · 2 ready');
  const reference = referenceOf(queueOf([introducer(), bug('a'), bug('bb'), bug('started', {}, { status: 'developing' }), bug('gone', {}, { archived: true })]));
  assert.equal(bugs.bugGroupCountLabel(reference.bugs.length), 'Bugs · 2 ready');
});

test('W21 the conversation expander adds its bugs after the unchanged task count, and omits them at zero', () => {
  assert.equal(bugs.conversationExpanderLabel(1, 2), 'Planning · 1 task ready · 2 bugs');
  assert.equal(bugs.conversationExpanderLabel(2, 1), 'Planning · 2 tasks ready · 1 bug');
  assert.equal(bugs.conversationExpanderLabel(0, 0), 'Planning · 0 tasks ready');
  assert.equal(bugs.nestedBugCount(undefined), 0);
  const conversation = session('plan-1', { planningSessionNumber: 4, planningCreatedTaskCount: 3 });
  const second = item('intro-2', { title: '4.003: Add logout', status: 'developing', planningRef: { session: 4, task: 3 } });
  const items = [
    introducer({ planningRef: { session: 4, task: 2 } }), second,
    item('ready', { title: '4.001: Ready', planningRef: { session: 4, task: 1 } }),
    bug('a'), bug('bb'), bug('ccc', { introducedBy: { planItemId: 'intro-2', number: '4.003', title: 'Add logout', commit: null } }),
  ];
  const group = queueOf(items, [conversation]).find((entry) => entry.kind === 'session').session;
  assert.equal(bugs.conversationExpanderLabel(group.ready.length, bugs.nestedBugCount(group.references)), 'Planning · 1 task ready · 3 bugs', 'the sum of its reference cards\' counts');
});

test('W22 W61 the Planning header counts top-level entries: 7 here, and a reference under a conversation adds 0', () => {
  const conversation = session('plan-1', { planningSessionNumber: 1, planningCreatedTaskCount: 1 });
  const nestedIntroducer = item('nested-intro', { title: '1.001: In a conversation', status: 'done', planningRef: { session: 1, task: 1 } });
  const other = (id) => ({ planItemId: id, number: null, title: id, commit: null });
  const items = [
    nestedIntroducer, bug('n1', { introducedBy: { planItemId: 'nested-intro', number: '1.001', title: 'In a conversation', commit: null } }),
    item('top-1', { status: 'done' }), bug('t1', { introducedBy: other('top-1') }), bug('t1b', { introducedBy: other('top-1') }),
    item('top-2', { status: 'done' }), bug('t2', { introducedBy: other('top-2') }),
    bug('solo', { introducedBy: null }),
    item('standalone-task'),
  ];
  const sessions = [conversation, reportSession('report-1', { planningSessionNumber: 2 }), reportSession('report-2', { planningSessionNumber: 3, cliNotStarted: true, executorId: '' })];
  const queue = queueOf(items, sessions);
  assert.equal(queue.length, 7, '1 conversation + 2 top-level references + 1 standalone bug + 2 report sessions + 1 standalone task');
  assert.deepEqual(queue.map((entry) => entry.kind).sort(), ['reference', 'reference', 'session', 'session', 'session', 'task', 'task']);
  assert.equal(queueOf(items.filter((planItem) => planItem.id !== 'n1'), sessions).length, 7, 'the nested reference added nothing');
  assert.ok(queue.find((entry) => entry.id === 'report-2').session.cliNotStarted, 'a not-started session counts 1 like any other');
});

test('W23 a conversation\'s history counts are unchanged by bugs filed against its tasks', () => {
  const tasks = [introducer({ planningRef: { session: 4, task: 1 } }), item('ready', { planningRef: { session: 4, task: 2 } })];
  const withBugs = [...tasks, bug('a', { reportSessionNumber: 9 }), bug('bb', { reportSessionNumber: 9 }, { status: 'developing' })];
  assert.deepEqual(planningTaskHistory(withBugs, 4, 2), planningTaskHistory(tasks, 4, 2));
  assert.equal(planningHistoryCountsLabel(planningTaskHistory(withBugs, 4, 3)), '1 task ready · 1 completed · 1 removed');
});

test('W24 a report session\'s history uses the same categories over the bugs it filed; removed is filed minus existing', () => {
  const items = [
    bug('r1', { reportSessionNumber: 3 }), bug('r2', { reportSessionNumber: 3 }, { createdAt: at(5) }),
    bug('s1', { reportSessionNumber: 3 }, { status: 'stopped' }),
    bug('d1', { reportSessionNumber: 3 }, { status: 'done', archived: true }),
    bug('x1', { reportSessionNumber: 3 }, { archived: true }),
    bug('other', { reportSessionNumber: 4 }), item('task', { planningRef: { session: 3, task: 1 } }),
  ];
  const history = bugReportHistory(items, 3, 7);
  assert.deepEqual(history.ready.map((planItem) => planItem.id), ['r1', 'r2']);
  assert.equal(bugReportCountsLabel(history), '2 bugs ready · 1 started · 1 completed · 1 archived · 2 removed');
  assert.equal(bugReportCountsLabel(bugReportHistory(items.slice(0, 3), 3, 3)), '2 bugs ready · 1 started');
  assert.equal(bugReportCountsLabel(bugReportHistory([items[0]], 3, 1)), '1 bug ready');
  assert.equal(bugReportCountsLabel(bugReportHistory([], null, 0)), '0 bugs ready');
  assert.equal(sessionHistoryView({ items, sessionNumber: 3, createdTaskCount: 7, kind: 'bug-report' }).countsLabel, bugReportCountsLabel(history));
});

test('W25 the default Planning rows leave open report sessions out unless asked', () => {
  const sessions = [session('plan-1'), reportSession('report-1', { planningSessionNumber: 2 }), reportSession('report-2', { planningSessionNumber: 3, archived: true })];
  const ids = sessions.map((s) => s.id);
  assert.deepEqual(buildPlanningRows({ taskIds: ids, tasksById: byId(sessions), showArchived: false, now: NOW }).map((row) => row.id), ['plan-1']);
  assert.deepEqual(buildPlanningRows({ taskIds: ids, tasksById: byId(sessions), showArchived: false, now: NOW, includeBugReports: true }).map((row) => row.id).sort(), ['plan-1', 'report-1']);
  assert.deepEqual(buildPlanningRows({ taskIds: ids, tasksById: byId(sessions), showArchived: true, now: NOW, includeBugReports: true }).map((row) => row.id), ['report-2'], 'the Archived tab lists completed report sessions');
});

// ---- Expand and collapse (W26–W28) ----

test('W26 a group is expanded by default while its introducing task is Running or Needs you, collapsed otherwise', () => {
  assert.deepEqual(['Running', 'Needs you'].map(bugs.expandsByDefault), [true, true]);
  assert.deepEqual(['Completed', 'Stopped', 'Failed', 'Removed', null].map(bugs.expandsByDefault), [false, false, false, false, false]);
  assert.equal(referenceOf(queueOf([introducer({ status: 'developing' }), bug('a')])).expandedByDefault, true);
  assert.equal(referenceOf(queueOf([introducer(), bug('a')])).expandedByDefault, false);
  assert.equal(referenceOf(queueOf([bug('a')])).expandedByDefault, false, 'removed');
});

test('W27 a toggle beats the default and survives the task changing state while the view is mounted', () => {
  const running = referenceOf(queueOf([introducer({ status: 'developing' }), bug('a')]));
  const completed = referenceOf(queueOf([introducer(), bug('a')]));
  assert.equal(bugs.isGroupExpanded({}, running), true);
  assert.equal(bugs.isGroupExpanded({}, completed), false);
  const closedByHand = { intro: false };
  assert.equal(bugs.isGroupExpanded(closedByHand, running), false);
  assert.equal(bugs.isGroupExpanded(closedByHand, completed), false, 'the same toggle after the task completed');
  assert.equal(bugs.isGroupExpanded({ intro: true }, completed), true);
  assert.equal(bugs.isGroupExpanded({ other: true }, completed), false, 'another group\'s toggle');
});

test('W28 a collapsed conversation hides its reference and bugs but still counts them', async () => {
  const board = await readFile(new URL('../src/ui/project-popup/TaskBoard.tsx', import.meta.url), 'utf8');
  assert.match(board, /\{planAndBugs \? planAndBugsExpanderLabel\(row\.readyTaskCount \?\? 0, row\.readyBugCount \?\? 0, row\.createdTaskCount\) : conversationExpanderLabel\(row\.ready\.length, nestedBugCount\(row\.references\)\)\}\s*<\/Button>\s*\{expanded && <div data-group-list=\{row\.id\}[^>]*>\{row\.ready\.map\(renderTask\)\}\{row\.references\?\.map\(renderReference\)\}/, 'the count is outside the collapsible list; the references are inside it');
});

// ---- Drag and drop model (W29–W34) ----

/** The board's Planning cards as the panel builds them: top-level entries, then every nested card with its group. */
function planningCards(queue) {
  const top = queue.map((entry) => entry.kind === 'task' ? entry.task : { id: queueCardId(entry), primary: undefined, locked: entry.kind === 'reference' });
  const groups = queue.flatMap((entry) => entry.kind === 'reference' ? [entry.reference] : entry.kind === 'session' ? entry.session.references ?? [] : []);
  const nested = [
    ...queue.flatMap((entry) => entry.kind === 'session' ? entry.session.ready.map((row) => ({ ...row, group: entry.id })) : []),
    ...groups.flatMap((group) => group.bugs.map((row) => ({ ...row, group: bugs.bugGroupKey(group.id) }))),
  ];
  return [...top, ...nested];
}

function dragBoard() {
  const conversation = session('plan-1', { planningSessionNumber: 4, planningQueueOrder: 0, planningCreatedTaskCount: 3 });
  const other = { planItemId: 'intro-2', number: null, title: 'Other', commit: null };
  const items = [
    introducer({ planningRef: { session: 4, task: 1 } }),
    item('ready', { title: '4.002: Ready', planningRef: { session: 4, task: 2 } }),
    item('ready-2', { title: '4.003: Ready two', planningRef: { session: 4, task: 3 } }),
    bug('n1', { groupOrder: 0 }), bug('n2', { groupOrder: 1 }), bug('n3', { groupOrder: 2 }),
    item('intro-2', { status: 'done' }), bug('o1', { introducedBy: other }, { planningQueueOrder: 1 }),
    bug('solo', { introducedBy: null }, { planningQueueOrder: 2 }),
  ];
  const columns = { planning: planningCards(queueOf(items, [conversation])), running: [], needsYou: [], done: [] };
  return { columns, group: bugs.bugGroupKey('intro'), otherGroup: bugs.bugGroupKey('intro-2') };
}

test('W29 a reference card is never draggable; standalone and nested bugs are', () => {
  const { columns, otherGroup } = dragBoard();
  const reference = columns.planning.find((card) => card.id === 'reference:intro-2');
  assert.equal(reference.locked, true);
  assert.equal(canDragCard('planning', reference), false);
  assert.equal(canDropOn(columns, reference.id, 'planning'), false);
  assert.equal(planBoardDrop(columns, reference.id, { column: 'planning', index: 0 }), null);
  assert.equal(planBoardDrop(columns, reference.id, { column: 'running', index: 0 }), null, 'nothing can be started from it');
  assert.equal(canDragCard('planning', columns.planning.find((card) => card.id === 'solo')), true);
  assert.equal(canDragCard('planning', columns.planning.find((card) => card.id === 'o1')), true);
  assert.equal(columns.planning.find((card) => card.id === 'o1').group, otherGroup);
  assert.equal(columns.planning.some((card) => card.id === 'reference:intro'), false, 'a reference under a conversation is not a top-level card at all');
});

test('W30 a nested bug dropped in its own group returns the new id sequence', () => {
  const { columns, group } = dragBoard();
  assert.deepEqual(planBoardDrop(columns, 'n3', { column: 'planning', group, index: 0 }), { kind: 'reorderGroup', group, ids: ['n3', 'n1', 'n2'] });
  assert.deepEqual(planBoardDrop(columns, 'n1', { column: 'planning', group, index: 3 }), { kind: 'reorderGroup', group, ids: ['n2', 'n3', 'n1'] });
  assert.equal(planBoardDrop(columns, 'n1', { column: 'planning', group, index: 0 }), null, 'back onto its own place');
  assert.equal(bugs.bugGroupIntroducerId(group), 'intro', 'the group names the introducing task whose order is saved');
  assert.equal(bugs.bugGroupIntroducerId('plan-1'), null, 'a planning session\'s group is not a bug group');
});

test('W31 a nested bug dropped at top level, in another bug group or in a conversation group cancels', () => {
  const { columns, otherGroup } = dragBoard();
  assert.equal(planBoardDrop(columns, 'n1', { column: 'planning', index: 0 }), null, 'top level');
  assert.equal(planBoardDrop(columns, 'n1', { column: 'planning', group: otherGroup, index: 0 }), null, 'another bug group');
  assert.equal(planBoardDrop(columns, 'n1', { column: 'planning', group: 'plan-1', index: 0 }), null, 'its conversation\'s task list');
  assert.equal(canDropOn(columns, 'n1', 'planning', otherGroup), false);
});

test('W32 a planning task or a standalone bug dropped into a bug group cancels', () => {
  const { columns, group } = dragBoard();
  assert.equal(planBoardDrop(columns, 'ready', { column: 'planning', group, index: 0 }), null);
  assert.equal(planBoardDrop(columns, 'solo', { column: 'planning', group, index: 0 }), null);
  assert.deepEqual(planBoardDrop(columns, 'ready-2', { column: 'planning', group: 'plan-1', index: 0 }), { kind: 'reorderGroup', group: 'plan-1', ids: ['ready-2', 'ready'] }, 'planning tasks still reorder in their own group');
});

test('W33 a nested bug dropped on Running opens the guarded start and keeps its place until accepted', () => {
  const { columns } = dragBoard();
  const drop = planBoardDrop(columns, 'n2', { column: 'running', index: 0 });
  assert.equal(drop.kind, 'start');
  assert.equal(drop.card.id, 'n2');
  assert.deepEqual(columns.planning.filter((card) => card.group === bugs.bugGroupKey('intro')).map((card) => card.id), ['n1', 'n2', 'n3'], 'the drop decision moves nothing');
  assert.equal(dropAnnouncement(drop, 'up'), 'Opening start options.');
});

test('W34 no drop can place an entry between a conversation and its nested reference', () => {
  const { columns } = dragBoard();
  const topLevel = columns.planning.filter((card) => !card.group).map((card) => card.id);
  assert.deepEqual(topLevel, ['plan-1', 'reference:intro-2', 'solo'], 'the nested reference holds no top-level slot to drop beside');
  for (let index = 0; index <= topLevel.length; index += 1) {
    const drop = planBoardDrop(columns, 'solo', { column: 'planning', index });
    if (drop) assert.deepEqual([...drop.ids].sort(), [...topLevel].sort(), 'a top-level drop only reorders top-level entries');
  }
});

// ---- Keyboard (W35–W41) ----

test('W35 Alt+Up on the first and Alt+Down on the last bug do nothing; a middle move swaps and is announced like a nested planning task\'s', () => {
  const { columns, group } = dragBoard();
  const move = (id, key) => {
    const peers = columns.planning.filter((card) => card.group === group);
    const index = peers.findIndex((card) => card.id === id);
    return planBoardDrop(columns, id, { column: 'planning', group, index: key === 'ArrowUp' ? index - 1 : index + 2 });
  };
  assert.equal(move('n1', 'ArrowUp'), null, 'the first cannot move up');
  assert.equal(move('n3', 'ArrowDown'), null, 'the last cannot move down');
  assert.deepEqual(move('n2', 'ArrowUp'), { kind: 'reorderGroup', group, ids: ['n2', 'n1', 'n3'] });
  assert.deepEqual(move('n2', 'ArrowDown'), { kind: 'reorderGroup', group, ids: ['n1', 'n3', 'n2'] });
  assert.equal(dropAnnouncement(move('n2', 'ArrowUp'), 'up'), 'Moved bug up within its introducing task\'s group.');
  assert.equal(dropAnnouncement(move('n2', 'ArrowDown'), 'down'), 'Moved bug down within its introducing task\'s group.');
  assert.equal(dropAnnouncement({ kind: 'reorderGroup', group: 'plan-1', ids: [] }, 'up'), 'Moved task up within its planning group.', 'a planning task\'s wording is unchanged');
  assert.equal(dropAnnouncement({ kind: 'reorder', ids: [] }, 'down'), 'Moved card down.');
});

test('W36 Alt+Up/Down does nothing on a reference card and moves a standalone bug at the top level', () => {
  const { columns } = dragBoard();
  assert.equal(boardKeyAction('reference', { key: 'ArrowUp', altKey: true }), null);
  assert.equal(boardKeyAction('reference', { key: 'ArrowDown', altKey: true }), null);
  assert.equal(planBoardDrop(columns, 'reference:intro-2', { column: 'planning', index: 0 }), null);
  assert.deepEqual(planBoardDrop(columns, 'solo', { column: 'planning', index: 1 }), { kind: 'reorder', ids: ['plan-1', 'solo', 'reference:intro-2'] });
});

test('W37 W38 a keyboard move keeps focus on the moved bug, and a refused save restores the order and reports why', async () => {
  const dnd = await readFile(new URL('../src/ui/project-popup/useBoardDnd.ts', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/ui/project-popup/TasksPanel.tsx', import.meta.url), 'utf8');
  // The moved card keeps its React key (its plan item id), so the focused element moves with it rather than being remounted.
  assert.match(panel, /function nestedCard\(row: OpenTaskRow\) \{\s*return <OpenTaskCard key=\{row\.id\}/);
  assert.match(dnd, /event\.preventDefault\(\);\s*onDrop\(drop\);\s*setAnnouncement\(dropAnnouncement\(drop/);
  assert.match(panel, /void saved\.catch\(\(error\) => actions\.reportError\(error\)\);/, 'a refusal is shown in the board\'s alert');
  assert.match(panel, /<p className="sr-only" aria-live="polite">\{dnd\.announcement\}<\/p>/);
});

test('W39 card: Enter and Space open the bug; on a reference they open the introducing task; a removed reference has no action', () => {
  for (const key of ['Enter', ' ']) {
    assert.equal(boardKeyAction('card', { key, altKey: false }), 'open');
    assert.equal(boardKeyAction('reference', { key, altKey: false }), 'open');
    assert.equal(boardKeyAction('reference', { key, altKey: false }, true), null);
  }
  assert.equal(boardKeyAction('card', { key: 'a', altKey: false }), null);
  assert.equal(boardKeyAction('card', { key: 'ArrowUp', altKey: true }), 'reorder');
  assert.equal(boardKeyAction('card', { key: 'ArrowUp', altKey: false }), null);
  const items = [introducer({ workflowRunId: 'run-9' }), bug('a')];
  assert.deepEqual(planningRowDetail(items, {}, 'intro'), { kind: 'run', id: 'run-9' }, 'the introducing task\'s normal detail view');
  assert.deepEqual(planningRowDetail([introducer(), bug('a')], {}, 'intro'), { kind: 'item', id: 'intro' });
});

test('W40 handle: Alt+arrows reorder; Enter and Space never open the detail', () => {
  assert.equal(boardKeyAction('handle', { key: 'ArrowUp', altKey: true }), 'reorder');
  assert.equal(boardKeyAction('handle', { key: 'ArrowDown', altKey: true }), 'reorder');
  for (const key of ['Enter', ' ']) assert.equal(boardKeyAction('handle', { key, altKey: false }), null);
  assert.equal(boardKeyAction('handle', { key: 'ArrowUp', altKey: false }), null);
});

test('W41 expander: Enter and Space toggle only, and it states aria-expanded', async () => {
  for (const key of ['Enter', ' ']) assert.equal(boardKeyAction('expander', { key, altKey: false }), 'toggle');
  assert.equal(boardKeyAction('expander', { key: 'ArrowUp', altKey: true }), null);
  assert.equal(boardKeyAction('expander', { key: 'Enter', altKey: true }), null);
  const cards = await readFile(new URL('../src/ui/project-popup/BugCards.tsx', import.meta.url), 'utf8');
  assert.match(cards, /<Button type="button"[^>]*aria-expanded=\{expanded\} onClick=\{onToggle\}>/);
});

// ---- Start task dialog (W42–W48) ----

const choice = (patch = {}) => bugs.startWorkflowChoice({ bug: true, projectDefaultId: 'software-development', enabledIds: ['software-development', 'bug-fix', 'hotfix'], bugWorkflowId: 'bug-fix', ...patch });

test('W42 a bug preselects the bug slot\'s effective workflow, Bug Fix by default', () => {
  assert.deepEqual(choice(), { workflowId: 'bug-fix', fallbackNote: null });
  assert.equal(bugs.bugSlotWorkflowId(undefined), 'bug-fix', 'until the type configuration has loaded');
  assert.equal(bugs.bugSlotWorkflowId([{ slot: { id: 'feature' }, effectiveWorkflowId: 'software-development' }, { slot: { id: 'bug' }, effectiveWorkflowId: 'bug-fix' }]), 'bug-fix');
});

test('W43 a slot re-pointed to another enabled workflow preselects that one', () => {
  const bugWorkflowId = bugs.bugSlotWorkflowId([{ slot: { id: 'bug' }, effectiveWorkflowId: 'hotfix' }]);
  assert.deepEqual(choice({ bugWorkflowId }), { workflowId: 'hotfix', fallbackNote: null });
});

test('W44 Bug Fix disabled or missing: the Project default is selected and a line says so; no line otherwise', () => {
  const fallback = choice({ enabledIds: ['software-development'] });
  assert.equal(fallback.workflowId, 'software-development');
  assert.match(fallback.fallbackNote, /Bug Fix workflow is disabled or missing.*default workflow is selected/);
  assert.equal(choice().fallbackNote, null);
});

test('W45 a task preselects the Project default with no line, whatever the bug slot says', () => {
  assert.deepEqual(choice({ bug: false }), { workflowId: 'software-development', fallbackNote: null });
  assert.deepEqual(choice({ bug: false, enabledIds: ['software-development'] }), { workflowId: 'software-development', fallbackNote: null });
});

test('W46 W48 the person\'s pick is held by the open dialog, and Start sends the chosen workflow id', async () => {
  const dialogs = await readFile(new URL('../src/ui/project-popup/TaskDialogs.tsx', import.meta.url), 'utf8');
  // The initial id only seeds the state, so a live update that changes the preselection never overwrites a pick.
  assert.match(dialogs, /const \[workflowId, setWorkflowId\] = useState\(initialWorkflowId\);/);
  assert.doesNotMatch(dialogs, /useEffect\([^)]*initialWorkflowId/);
  assert.match(dialogs, /await onStart\(startOptions\(\{ executorId, createBranch, hasRepository, autoMerge, workflowId, skippedStepIds: skipped \}\)\);/);
});

test('W47 "Needs more info" shows the warning line; nothing else does', () => {
  assert.match(bugs.startInfoWarning(bug('a', { infoStatus: 'needs-more-info' })), /marked "Needs more info".*You can still start it\./);
  assert.equal(bugs.startInfoWarning(bug('a', { infoStatus: 'enough' })), null);
  assert.equal(bugs.startInfoWarning(bug('a', { infoStatus: null })), null);
  assert.equal(bugs.startInfoWarning(item('task')), null);
  assert.equal(bugs.startInfoWarning(undefined), null);
});

// ---- Detail and session views (W49–W53) ----

test('W49 the Info switch is enabled only while the bug has not started', () => {
  assert.equal(bugs.canChangeInfoStatus(bug('a')), true);
  for (const status of ['developing', 'blocked', 'stopped', 'failed', 'done']) assert.equal(bugs.canChangeInfoStatus(bug('a', {}, { status })), false, status);
  assert.equal(bugs.canChangeInfoStatus(item('task')), false);
});

test('W50 the detail rows: severity, Info status, Introduced by ("Unknown" when empty), Suspected location, Found while working on', () => {
  const full = bug('a', { severity: 'critical', infoStatus: 'needs-more-info', suspectedLocation: 'web/login', foundWhileWorkingOn: { planItemId: 'gone', number: '5.001', title: 'Other work' } });
  assert.deepEqual(bugs.bugDetailRows(full), [
    { label: 'Severity', text: 'Critical' },
    { label: 'Info status', text: 'Needs more info' },
    { label: 'Introduced by', text: '4.002: Add login · abc1234' },
    { label: 'Suspected location', text: 'web/login' },
    { label: 'Found while working on', text: '5.001: Other work' },
  ]);
  assert.deepEqual(bugs.bugDetailRows(bug('a', { infoStatus: null, introducedBy: null })), [
    { label: 'Severity', text: 'Not set' },
    { label: 'Info status', text: 'Not set' },
    { label: 'Introduced by', text: 'Unknown' },
    { label: 'Suspected location', text: 'Unknown' },
  ]);
  assert.deepEqual(bugs.bugDetailRows(item('task')), []);
});

test('W51 Back from a task opened through a reference returns to the board', async () => {
  assert.equal(detailBackTarget(null, {}), null);
  const panel = await readFile(new URL('../src/ui/project-popup/TasksPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /function openTaskById\(itemId: string\) \{\s*const detail = planningRowDetail\(items, tasksById, itemId\);\s*if \(detail\) showDetail\(detail\);/, 'opened with no origin session, so Back leads to the board');
  assert.match(panel, /onOpen=\{\(\) => openTaskById\(group\.id\)\}/);
});

test('W52 W53 the Session bugs panel: filed bugs in creation order with badges, ready rows expand, started rows open, archived-unfinished and removed left out', () => {
  const items = [
    bug('second', { reportSessionNumber: 3 }, { createdAt: at(10), status: 'developing', title: 'B.002: Second' }),
    bug('first', { reportSessionNumber: 3 }, { createdAt: at(5), title: 'B.001: First' }),
    bug('third', { reportSessionNumber: 3 }, { createdAt: at(15), status: 'done', archived: true, title: 'B.003: Third' }),
    bug('hidden', { reportSessionNumber: 3 }, { createdAt: at(20), archived: true }),
    bug('other', { reportSessionNumber: 4 }),
  ];
  const panel = buildPlanningTaskPanel({ items, tasksById: {}, sessionNumber: 3, createdTaskCount: 5, kind: 'bug-report' });
  assert.deepEqual(panel.rows.map((row) => [row.id, row.number, row.badge.label, row.action]), [
    ['first', 'B.001', 'Ready', 'expand'],
    ['second', 'B.002', 'Running', 'open'],
    ['third', 'B.003', 'Completed', 'open'],
  ]);
  assert.equal(panel.countsLabel, '1 bug ready · 1 started · 1 completed · 1 archived · 1 removed');
  assert.equal(panel.empty, false);
  const empty = buildPlanningTaskPanel({ items: [], tasksById: {}, sessionNumber: 3, createdTaskCount: 0, kind: 'bug-report' });
  assert.equal(empty.empty, true);
  assert.deepEqual(sessionPanelWording('bug-report'), { heading: 'Session bugs and tasks', historyHeading: 'Bug report history', emptyText: 'Bugs and tasks this session files will appear here.' });
  assert.equal(sessionPanelWording('planning').heading, 'Session tasks');
  assert.deepEqual(buildPlanningTaskPanel({ items, tasksById: {}, sessionNumber: 3, createdTaskCount: 0, kind: 'planning' }).rows, [], 'a planning session of the same number lists no bugs');
});

// ---- Report bug dialog and session card (W54–W61) ----

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('W54 the Plan & bugs draft is kept per Project, apart from the Task draft', () => {
  const storage = memoryStorage();
  assert.notEqual(planAndBugsDraftStorageKey('a'), planAndBugsDraftStorageKey('b'));
  assert.notEqual(planAndBugsDraftStorageKey('a'), taskDraftStorageKey('a'));
  storage.setItem(taskDraftStorageKey('a'), 'Task text');
  savePlanAndBugsDraft('a', 'The note vanished', storage);
  assert.equal(readPlanAndBugsDraft('a', storage), 'The note vanished');
  assert.equal(readPlanAndBugsDraft('b', storage), '');
  clearPlanAndBugsDraft('a', storage);
  assert.equal(readPlanAndBugsDraft('a', storage), '');
  assert.equal(storage.getItem(taskDraftStorageKey('a')), 'Task text');
});

test('W55 with an agent available the dialog sends; with none the prompt stays usable, with a notice and "Create session"', () => {
  assert.deepEqual(bugs.reportDialogState(true), { sendLabel: 'Send', notice: null });
  const none = bugs.reportDialogState(false);
  assert.equal(none.sendLabel, 'Create session');
  assert.match(none.notice, /No coding agent is available right now\. You can still describe the work and create the session/);
});

test('W57 the not-started view: Start needs a selected agent and a non-blank description; the shared picker only selects an available one', () => {
  const can = (description, executorId) => bugs.canStartDeferredSession({ description, executorId });
  assert.equal(can('The note vanished', 'codex'), true);
  assert.equal(can('   ', 'codex'), false);
  assert.equal(can('The note vanished', ''), false, 'no agent selected');
  // An agent out of quota is never selected, so Start stays off.
  const spent = { id: 'spent', label: 'Spent', kind: 'claude-cli', limits: { fiveHour: { usedPercentage: 100, resetsAt: null }, sevenDay: null } };
  assert.equal(resolveExecutorChoice([spent], 'spent'), '');
});

test('W58 the session is always labelled "Bug report"; its status is Reporting, Needs you, none between turns, or CLI not started', () => {
  assert.equal(bugs.BUG_REPORT_LABEL, 'Bug report');
  assert.equal(bugs.bugReportStatusLabel({ live: 'running', cliNotStarted: false }), 'Reporting');
  assert.equal(bugs.bugReportStatusLabel({ live: 'blocked', cliNotStarted: false }), 'Needs you');
  assert.equal(bugs.bugReportStatusLabel({ live: 'idle', cliNotStarted: false }), null);
  assert.equal(bugs.bugReportStatusLabel({ live: 'idle', cliNotStarted: true }), 'CLI not started');
  assert.equal(bugs.isBugReportSession(reportSession('r')), true);
  assert.equal(bugs.isBugReportSession(session('p')), false);
  assert.equal(bugs.isBugReportSession({ kind: 'execute', planningPurpose: 'bug-report' }), false);
  assert.equal(bugs.isBugReportSession(undefined), false);
  const rows = buildPlanningRows({ taskIds: ['r', 'n'], tasksById: byId([reportSession('r', { status: 'developing' }), reportSession('n', { cliNotStarted: true, planningSessionNumber: 2 })]), showArchived: false, now: NOW, includeBugReports: true });
  assert.deepEqual(rows.map((row) => [row.id, row.live, row.kind, row.cliNotStarted]), [['r', 'running', 'bug-report', false], ['n', 'idle', 'bug-report', true]]);
});

test('an archived session card says "planning" for a conversation and "bug report" for a report session', async () => {
  assert.equal(bugs.archivedSessionLabel({ completedAt: AT, kind: 'planning' }), 'Completed planning');
  assert.equal(bugs.archivedSessionLabel({ completedAt: null, kind: 'planning' }), 'Archived planning');
  assert.equal(bugs.archivedSessionLabel({ completedAt: AT, kind: 'bug-report' }), 'Completed bug report');
  assert.equal(bugs.archivedSessionLabel({ completedAt: null, kind: 'bug-report' }), 'Archived bug report');
  assert.equal(bugs.archivedSessionLabel({ completedAt: AT, kind: 'plan-and-bugs' }), 'Completed plan & bugs');
  const archived = await readFile(new URL('../src/ui/project-popup/ArchivedPanel.tsx', import.meta.url), 'utf8');
  assert.match(archived, /started=\{archivedSessionLabel\(entry\.row\)\}/);
});

test('W59 the card line says how many bugs are ready and where they are, or that the session waits for an agent', () => {
  assert.equal(bugs.bugReportCardLine({ cliNotStarted: true, readyCount: 0, filedCount: 0 }), 'Waiting for a coding agent');
  assert.equal(bugs.bugReportCardLine({ cliNotStarted: false, readyCount: 0, filedCount: 0 }), 'No bugs filed yet');
  assert.equal(bugs.bugReportCardLine({ cliNotStarted: false, readyCount: 2, filedCount: 3 }), '2 bugs ready · shown under their introducing tasks');
  assert.equal(bugs.bugReportCardLine({ cliNotStarted: false, readyCount: 1, filedCount: 1 }), '1 bug ready · shown under their introducing tasks');
  assert.equal(bugs.bugReportCardLine({ cliNotStarted: false, readyCount: 0, filedCount: 2 }), '0 bugs ready · shown under their introducing tasks');
});

test('W60 a not-started session has no Stop or Resume and is draggable', async () => {
  const { canResumeSession } = await import('../src/lib/projectTasks.ts');
  const notStarted = reportSession('n', { cliNotStarted: true, sessionId: null, executorId: '' });
  assert.equal(canResumeSession(notStarted), false, 'no saved session to resume');
  assert.equal(notStarted.status === 'developing' || notStarted.status === 'blocked', false, 'nothing live to stop');
  const queue = queueOf([], [notStarted]);
  assert.equal(canDragCard('planning', planningCards(queue)[0]), true);
  const view = await readFile(new URL('../src/ui/project-popup/TaskDetailsView.tsx', import.meta.url), 'utf8');
  assert.match(view, /const controls = task && \(active \|\| canResumeSession\(task\)\)/);
});

// ---- Store against the stub (S1–S8) ----

let project;

async function setUp() {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], tasksById: {}, taskIdsByProject: {}, planByProject: {}, ...CLEAN_ERROR_STATE });
  await useWorldStore.getState().addProject('Bugs');
  project = useWorldStore.getState().projects.at(-1);
  await useWorldStore.getState().loadPlan(project.id);
  return stub;
}

/** The daemon saving a plan item and broadcasting it. */
function serverSave(stub, planItem) {
  const saved = { ...planItem, projectId: project.id, milestoneId: null };
  stub.planItems.set(saved.id, saved);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: structuredClone(saved) }));
  return saved;
}

function serverDelete(stub, id) {
  stub.planItems.delete(id);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItemDeleted', id, projectId: project.id }));
}

const liveItems = () => useWorldStore.getState().planByProject[project.id].items;
const liveQueue = () => {
  const state = useWorldStore.getState();
  return buildPlanningQueue({ items: liveItems(), taskIds: Object.keys(state.tasksById), tasksById: state.tasksById, now: Date.now() });
};
const liveGroup = (id = 'intro') => referenceOf(liveQueue(), id)?.bugs.map((row) => row.id);

test('S1 starting a report session adds it to the store', async () => {
  await setUp();
  const taskId = await useWorldStore.getState().startPlanAndBugsSession(project.id, 'The note vanished', 'test-claude');
  const stored = useWorldStore.getState().tasksById[taskId];
  assert.equal(stored.kind, 'plan');
  assert.equal(stored.planningPurpose, 'plan-and-bugs');
  assert.equal(stored.cliNotStarted, undefined);
  assert.equal(stored.status, 'developing');
  assert.equal(stored.planningSessionNumber, 1);
  assert.equal(bugs.isPlanAndBugsSession(stored), true);
  assert.equal(bugs.isBugReportSession(stored), false);
});

test('S2 S7 a planItem event shows a new bug in the queue with no reload, and deleting the last bug removes it and its reference', async () => {
  const stub = await setUp();
  serverSave(stub, introducer());
  assert.deepEqual(shape(liveQueue()), []);
  serverSave(stub, bug('a', { severity: 'high' }));
  assert.deepEqual(shape(liveQueue()), [['reference', 'intro', ['a']]]);
  assert.equal(referenceOf(liveQueue()).bugs[0].bug.severityLabel, 'High severity');
  serverSave(stub, bug('bb', {}, { createdAt: at(5) }));
  assert.deepEqual(liveGroup(), ['a', 'bb']);

  serverDelete(stub, 'a');
  assert.deepEqual(liveGroup(), ['bb']);
  serverDelete(stub, 'bb');
  assert.deepEqual(shape(liveQueue()), []);
});

test('S3 a group reorder is applied at once; on a 409 the prior order returns and the error reaches the caller', async () => {
  const stub = await setUp();
  serverSave(stub, introducer());
  for (const [index, id] of ['a', 'bb', 'ccc'].entries()) serverSave(stub, bug(id, { groupOrder: index }));
  assert.deepEqual(liveGroup(), ['a', 'bb', 'ccc']);

  await useWorldStore.getState().reorderBugGroup(project.id, 'intro', ['ccc', 'a', 'bb']);
  assert.deepEqual(liveGroup(), ['ccc', 'a', 'bb']);
  assert.deepEqual(['a', 'bb', 'ccc'].map((id) => stub.planItems.get(id).bug.groupOrder), [1, 2, 0], 'saved by the daemon');

  // A stale set: the daemon has a bug the board has not been told about.
  stub.planItems.set('late', { ...bug('late'), projectId: project.id, milestoneId: null });
  const before = liveItems();
  await assert.rejects(useWorldStore.getState().reorderBugGroup(project.id, 'intro', ['a', 'bb', 'ccc']), /changed while you were reordering/);
  assert.deepEqual(liveGroup(), ['ccc', 'a', 'bb'], 'the prior order is back');
  assert.equal(liveItems(), before, 'exactly the items it had');
  await assert.rejects(useWorldStore.getState().reorderBugGroup(project.id, 'no-such-task', []), /not found/);
});

test('S4 a top-level reorder with a reference is saved by its introducing task; a refused one leaves the order as it was', async () => {
  const stub = await setUp();
  const { serverApi } = await import('../src/lib/serverApi.ts');
  serverSave(stub, introducer());
  serverSave(stub, bug('a', {}, { planningQueueOrder: 0 }));
  serverSave(stub, bug('solo', { introducedBy: null }, { planningQueueOrder: 1 }));
  const queue = liveQueue();
  assert.deepEqual(queue.map(queueCardId), ['reference:intro', 'solo']);

  await serverApi.reorderPlanningQueue(project.id, planningQueueOrderEntries(queue, ['solo', 'reference:intro']));
  assert.deepEqual([stub.planItems.get('solo').planningQueueOrder, stub.planItems.get('a').planningQueueOrder], [0, 1]);

  await assert.rejects(serverApi.reorderPlanningQueue(project.id, [{ kind: 'task', id: 'solo' }]), /Planning order changed/, 'a top-level reference left out');
  await assert.rejects(serverApi.reorderPlanningQueue(project.id, [{ kind: 'task', id: 'solo' }, { kind: 'reference', id: 'no-such-task' }]), /not found/);
  assert.deepEqual([stub.planItems.get('solo').planningQueueOrder, stub.planItems.get('a').planningQueueOrder], [0, 1]);
  assert.deepEqual(liveQueue().map(queueCardId), ['reference:intro', 'solo'], 'the board only moves when the daemon says so');
});

test('S5 the Info status flip is saved; a 409 leaves the flag and gives the reason', async () => {
  const stub = await setUp();
  serverSave(stub, bug('a', { infoStatus: 'needs-more-info' }));
  await useWorldStore.getState().setBugInfoStatus(project.id, 'a', 'enough');
  assert.equal(liveItems().find((planItem) => planItem.id === 'a').bug.infoStatus, 'enough');

  stub.planItems.get('a').status = 'developing';
  await assert.rejects(useWorldStore.getState().setBugInfoStatus(project.id, 'a', 'needs-more-info'), /already started/);
  assert.equal(liveItems().find((planItem) => planItem.id === 'a').bug.infoStatus, 'enough');
  await assert.rejects(useWorldStore.getState().setBugInfoStatus(project.id, 'a', 'sort-of'), /infoStatus must be one of/);
});

test('S6 W56 a session created with no agent is not started; its description can be edited; then it starts', async () => {
  await setUp();
  const store = useWorldStore.getState();
  const taskId = await store.startPlanAndBugsSession(project.id, 'First words');
  const created = useWorldStore.getState().tasksById[taskId];
  assert.equal(created.cliNotStarted, true);
  assert.equal(created.status, 'stopped');
  assert.deepEqual(liveQueue().map((entry) => [entry.kind, entry.session.kind, entry.session.cliNotStarted]), [['session', 'plan-and-bugs', true]]);

  await store.updateSessionDescription(taskId, 'Better words');
  assert.equal(useWorldStore.getState().tasksById[taskId].description, 'Better words');

  await assert.rejects(store.startDeferredSession(taskId, 'no-such-agent'), /Executor not found/);
  assert.equal(useWorldStore.getState().tasksById[taskId].cliNotStarted, true, 'a refused agent leaves it not started');

  await store.startDeferredSession(taskId, 'test-claude');
  const started = useWorldStore.getState().tasksById[taskId];
  assert.equal(started.cliNotStarted, undefined);
  assert.equal(started.status, 'developing');
  assert.equal(started.executorId, 'test-claude');
  await assert.rejects(store.updateSessionDescription(taskId, 'Too late'), /already started/);

  // W56: creation that fails rejects before the dialog clears its draft.
  await assert.rejects(store.startPlanAndBugsSession(project.id, '   '), /description is required/);
  const prompt = await readFile(new URL('../src/ui/project-popup/PlanAndBugsPrompt.tsx', import.meta.url), 'utf8');
  assert.match(prompt, /const taskId = await startPlanAndBugsSession\(project\.id, trimmed, executorId \|\| undefined\);\s*clearPlanAndBugsDraft\(project\.id\);/);
});

test('S8 a fresh store load gives the same grouping and order', async () => {
  const stub = await setUp();
  serverSave(stub, introducer());
  for (const [index, id] of ['a', 'bb', 'ccc'].entries()) serverSave(stub, bug(id, { groupOrder: 2 - index }, { planningQueueOrder: 4 }));
  serverSave(stub, bug('solo', { introducedBy: null }, { planningQueueOrder: 1 }));
  const before = shape(liveQueue());
  assert.deepEqual(before, [['task', 'solo'], ['reference', 'intro', ['ccc', 'bb', 'a']]]);

  useWorldStore.setState({ planByProject: {} });
  await useWorldStore.getState().loadPlan(project.id);
  assert.deepEqual(shape(liveQueue()), before);
  assert.equal(liveItems().find((planItem) => planItem.id === 'intro').type, undefined, 'a task carries no type on the board');
});

// ---- Component source pins (C1–C12) ----

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const panel = await source('../src/ui/project-popup/TasksPanel.tsx');
const board = await source('../src/ui/project-popup/TaskBoard.tsx');
const bugCards = await source('../src/ui/project-popup/BugCards.tsx');
const bugCardParts = await source('../src/ui/project-popup/BugCardParts.tsx');
const dialogs = await source('../src/ui/project-popup/TaskDialogs.tsx');
const detailHeader = await source('../src/ui/project-popup/DetailHeader.tsx');
const reportPrompt = await source('../src/ui/project-popup/PlanAndBugsPrompt.tsx');
const sessionView = await source('../src/ui/project-popup/TaskDetailsView.tsx');
const deferredForm = await source('../src/ui/project-popup/DeferredSessionForm.tsx');
const taskPanel = await source('../src/ui/project-popup/PlanningTaskPanel.tsx');

test('C1 the Planning header renders one Plan & bugs button beside Task, with no Plan or Report bug', () => {
  assert.match(panel, /setDialog\(\{ kind: 'plan-and-bugs' \}\)\}><Lightbulb aria-hidden="true" \/><Bug aria-hidden="true" \/><span className="hidden @\[24rem\]:inline">Plan &amp; bugs<\/span><\/Button><Button [^<]*setDialog\(\{ kind: 'add' \}\)\}><Plus aria-hidden="true" \/><span className="hidden @\[24rem\]:inline">Task<\/span><\/Button><\/>/);
  assert.match(panel, /dialog\?\.kind === 'plan-and-bugs' && <PlanAndBugsPromptDialog project=\{project\}/);
  assert.doesNotMatch(panel, /> Plan<\/Button>|Report bug|kind: 'report'|PlanningPromptDialog|BugReportPromptDialog/);
});

test('C2 the reference card has no drag handle or draggable wiring, a status badge and the "Introducing task" caption', () => {
  const card = bugCards.slice(bugCards.indexOf('export function ReferenceCard'), bugCards.indexOf('export function BugGroupView'));
  assert.match(card, /<article data-card data-reference data-nested=\{nested \|\| undefined\} draggable=\{false\}/);
  assert.doesNotMatch(card, /GripVertical|onDragStart|dnd/);
  assert.match(card, />Introducing task<\/p>/);
  assert.match(card, /\{group\.status && <Badge variant=\{REFERENCE_STATUS_VARIANT\[group\.status\]\}>\{group\.status\}<\/Badge>\}/);
  assert.match(panel, /locked: entry\.kind === 'reference'/);
});

test('C3 a bug card is the task card with the Bug badge in text, not the Planning label', () => {
  assert.match(board, /\{bug && <BugBadges bug=\{bug\} \/>\}/);
  assert.match(bugCardParts, /<Badge variant="soft-destructive"><Bug aria-hidden="true" \/> \{BUG_BADGE_LABEL\}<\/Badge>/);
  assert.match(bugCardParts, /\{bug\.severityLabel && <Badge variant="outline">\{bug\.severityLabel\}<\/Badge>\}/);
  assert.match(bugCardParts, /\{bug\.needsMoreInfo && <Badge variant="warning">Needs more info<\/Badge>\}/);
  assert.match(board, /\{bug\?\.footer && \(/);
  const openCard = board.slice(board.indexOf('export function OpenTaskCard'), board.indexOf('export interface CompletedCardHandlers'));
  assert.match(openCard, /typeLabel=\{row\.typeLabel\}\s*bug=\{row\.bug\}/);
  assert.doesNotMatch(openCard, /planning|typeLabel="Planning"/, 'never a Planning card');
});

test('C4 Running, Needs you, Completed and Archived cards render the Bug badge and the "Introduced by" link', () => {
  assert.match(board, /\{bug\?\.introducedBy && !nested && <IntroducedByLine link=\{bug\.introducedBy\} onOpenTask=\{onOpenTask\} \/>\}/);
  const completed = board.slice(board.indexOf('export function CompletedTaskCard'), board.indexOf('export function PlanningSessionCard'));
  assert.match(completed, /bug=\{row\.bug\}\s*onOpenTask=\{handlers\.onOpenTask\}/);
  assert.match(panel, /<OpenTaskCard key=\{row\.id\} row=\{row\} agent=\{label\(row\.workerId\)\}/, 'Running and Needs you use the same card');
  assert.match(panel, /onOpenTask: openTaskById,/);
  assert.match(bugCardParts, /Introduced by\{' '\}\s*\{taskId && onOpenTask \? \(\s*<button type="button"[^>]*onClick=\{\(\) => onOpenTask\(taskId\)\}>/, 'a link only while the task exists');
});

test('C5 a nested bug is wired to the Alt+Up/Down handler and the live announcer', () => {
  assert.match(panel, /dnd=\{dnd\.cardDnd\('planning', nestedPlanningCards\.find\(\(card\) => card\.id === row\.id\)!\)\} nested \/>/);
  assert.match(panel, /bugGroups\.flatMap\(\(group\) => group\.bugs\.map\(\(row\) => \(\{ \.\.\.row, group: bugGroupKey\(group\.id\) \}\)\)\)/);
  assert.match(board, /else if \(!dragHandle\) dnd\?\.onKeyDown\(event\)/);
  assert.match(panel, /aria-live="polite">\{dnd\.announcement\}/);
  assert.match(bugCards, /\{expanded && <div data-group-list=\{bugGroupKey\(group\.id\)\}/, 'the nested drop zone');
});

test('C6 the expander is its own button with aria-expanded, apart from the card', () => {
  const group = bugCards.slice(bugCards.indexOf('export function BugGroupView'), bugCards.indexOf('export function BugReportSessionCard'));
  assert.match(group, /<ReferenceCard group=\{group\} nested=\{nested\} onOpen=\{onOpen\} \/>\s*<Button type="button"[^>]*aria-expanded=\{expanded\} onClick=\{onToggle\}>/);
  assert.match(group, /\{bugGroupCountLabel\(group\.bugs\.length\)\}/);
  assert.match(panel, /const expanded = isGroupExpanded\(groupToggles, group\);/);
  assert.match(panel, /onToggle=\{\(\) => setGroupToggles\(\(toggles\) => \(\{ \.\.\.toggles, \[group\.id\]: !expanded \}\)\)\}/);
});

test('C7 the Start dialog renders the warning and fallback lines from the helpers, and Start ignores Info status', () => {
  assert.match(panel, /return \{ initialWorkflowId: choice\.workflowId, fallbackNote: choice\.fallbackNote, infoWarning: startInfoWarning\(item\) \};/);
  assert.match(panel, /startWorkflowChoice\(\{ bug: !!item && isBugItem\(item\), \.\.\.workflowDefaults \}\)/);
  assert.match(panel, /const workflowDefaults = \{ projectDefaultId: initialStartWorkflowId\(project, workflows\),/);
  assert.match(dialogs, /\{infoWarning && <p role="status"[^>]*>\{infoWarning\}<\/p>\}/);
  assert.match(dialogs, /\{fallbackNote && <p [^>]*>\{fallbackNote\}<\/p>\}/);
  assert.match(dialogs, /disabled=\{!executorId \|\| needsWorkflow \|\| noStepSelected \|\| starting\} onClick=\{\(\) => void start\(\)\}>Start<\/Button>/);
});

test('C8 the detail view wires the Info switch to the store action and the helper\'s enabled rule', async () => {
  assert.match(detailHeader, /\{isBugItem\(item\) && <BugDetails item=\{item\} actions=\{actions\} \/>\}/);
  assert.match(detailHeader, /const editable = canChangeInfoStatus\(item\);/);
  assert.match(detailHeader, /row\.label === 'Info status' && editable \? \(/);
  assert.match(detailHeader, /aria-pressed=\{item\.bug\?\.infoStatus === value\}\s*onClick=\{\(\) => void actions\.setInfoStatus\(item\.id, value\)\}/);
  assert.match(detailHeader, /\{bugDetailRows\(item\)\.map/);
  const actions = await source('../src/ui/project-popup/useTaskActions.ts');
  assert.match(actions, /setInfoStatus: \(itemId: string, infoStatus: BugInfoStatus\) => guard\(\(\) => setBugInfoStatus\(project\.id, itemId, infoStatus\)\)/);
});

test('C9 the Plan & bugs dialog uses its draft store and the available-agent list', () => {
  assert.match(reportPrompt, /useState\(\(\) => readPlanAndBugsDraft\(project\.id\)\)/);
  assert.match(reportPrompt, /savePlanAndBugsDraft\(project\.id, next\);/);
  assert.doesNotMatch(reportPrompt, /PlanningDraft|TaskDraft/);
  assert.match(reportPrompt, /const \{ executors, executorId, choose \} = useExecutorChoice\(\);/);
  assert.match(reportPrompt, /const dialog = reportDialogState\(executorId !== ''\);/);
  assert.match(reportPrompt, /sendLabel=\{dialog\.sendLabel\}/);
  assert.doesNotMatch(reportPrompt, /unavailable=/, 'the prompt is never disabled for lack of an agent');
});

test('C10 the session view: "Bug report" label, the Session bugs panel and the not-started form', () => {
  assert.match(sessionView, /\{kind !== 'planning' && <Badge variant="secondary">\{kind === 'plan-and-bugs' \? PLAN_AND_BUGS_LABEL : BUG_REPORT_LABEL\}<\/Badge>\}/);
  assert.match(sessionView, /task\?\.cliNotStarted \? <DeferredSessionForm key=\{task\.id\} task=\{task\} actions=\{actions\} \/> : <TaskSessionBody/);
  assert.match(taskPanel, /const kind = sessionKindOf\(task\);\s*const wording = sessionPanelWording\(kind\);/);
  assert.match(deferredForm, /<Textarea id="deferred-session-description" value=\{description\}/);
  assert.match(deferredForm, /<CodingAgentPicker executors=\{executors\} value=\{executorId\} onChange=\{choose\} id="deferred-session-agent" \/>/);
  assert.match(deferredForm, /<Button type="submit" disabled=\{!canStart\}><Play aria-hidden="true" \/> \{starting \? 'Starting…' : 'Start session'\}<\/Button>/);
  assert.match(deferredForm, /const canStart = canStartDeferredSession\(\{ description, executorId \}\) && !starting;/);
  assert.match(bugCards, /typeLabel=\{BUG_REPORT_LABEL\}\s*typeIcon=\{Bug\}\s*status=\{bugReportStatusLabel\(\{ live: row\.live, cliNotStarted \}\)\}/);
});

test('C11 a removed reference has no tabIndex and no click handler', () => {
  assert.match(bugCards, /const opens = group\.removed \? \{\} : \{\s*role: 'button',\s*tabIndex: 0,/);
  assert.match(bugCards, /<div \{\.\.\.opens\} className=/);
  assert.equal(bugCards.match(/tabIndex/g).length, 1, 'the only tabIndex is inside the not-removed branch');
  assert.equal(bugCards.slice(bugCards.indexOf('export function ReferenceCard'), bugCards.indexOf('export function BugGroupView')).match(/onClick/g).length, 1);
});

test('C12 the blueprint and the Planning board doc name the type field, grouping rules, tools, limits, numbering and the open real-CLI limit', async () => {
  const boardDoc = await source('../../docs/unified-planning-board.md');
  const blueprint = await source('../../.docs/blueprint.md');
  for (const doc of [boardDoc, blueprint]) {
    assert.match(doc, /type/i);
    assert.match(doc, /introducing[- ]task/i);
  }
  assert.match(boardDoc, /Report bug/);
  assert.match(boardDoc, /`<task number>\.<NNN>`/);
  assert.match(boardDoc, /`B\.<NNN>`/);
  assert.match(boardDoc, /200.*20,000.*500/s);
  assert.match(boardDoc, /create_bug/);
  assert.match(boardDoc, /report_unrelated_test_failure/);
  assert.match(boardDoc, /Open limit/);
  assert.match(boardDoc, /real (Claude|CLI)/i);
  assert.match(blueprint, /bugTracker\.ts/);
});
