import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
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

const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { summarizeWorkspaceCounts } = await import('../src/lib/workspaceCounts.ts');
const { queuedNoticeFor, ordinal, queuedBadge, queuedNotice, fullProjectNote, queuePlaces, slotCap, sortedQueue } = await import('../src/lib/waitingList.ts');

const T = '2026-10-04T10:00:00.000Z';
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const item = (id, projectId = 'p1') => ({ id, projectId, title: id, description: '', status: 'pending', order: 0, taskIds: [], executorId: null, createdAt: T, updatedAt: T });
const entry = (id, planItemId, patch = {}) => ({ id, projectId: 'p1', planItemId, position: 0, createdAt: T, ...patch });

test('ordinals follow English spelling, including the teens and 21st-23rd', () => {
  const spelled = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal);
  assert.deepEqual(spelled, ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
});

test('badge, toast and dialog note wording', () => {
  assert.equal(queuedBadge(2), 'Waiting for a free slot · #2');
  assert.equal(queuedNotice('Fix login', 3), 'Fix login is waiting for a free slot (3rd in line)');
  assert.equal(queuedNotice('<b>x</b>'.repeat(100), 1).startsWith('<b>x</b>'), true, 'titles pass through as plain text');
  assert.equal(slotCap(true), 6);
  assert.equal(slotCap(false), 1);
  assert.equal(fullProjectNote(6, 6), 'All 6 slots are in use; this task will wait in line and start on its own.');
  assert.equal(fullProjectNote(1, 1), 'All 1 slot is in use; this task will wait in line and start on its own.');
  assert.equal(fullProjectNote(5, 6), null);
  assert.equal(fullProjectNote(0, 6), null);
});

test('places are numbered from 1 in start order and renumber after a removal', () => {
  const entries = [entry('e3', 'c', { position: 2 }), entry('e1', 'a', { position: 0 }), entry('e2', 'b', { position: 1 })];
  assert.deepEqual([...queuePlaces(entries)].map(([id, place]) => [id, place.position]), [['a', 1], ['b', 2], ['c', 3]]);
  assert.deepEqual([...queuePlaces(entries.filter((e) => e.id !== 'e1'))].map(([id, place]) => [id, place.position]), [['b', 1], ['c', 2]]);
  assert.equal(queuePlaces(undefined).size, 0);
  const tied = [entry('x', 'x', { createdAt: '2026-10-04T10:00:02.000Z' }), entry('y', 'y', { createdAt: '2026-10-04T10:00:01.000Z' })];
  assert.deepEqual(sortedQueue(tied).map((e) => e.id), ['y', 'x'], 'equal positions fall back to when Start was pressed');
});

test('a queued task joins the waiting group with its place; a dependency-waiting task stays there too; removal returns it to unstarted', () => {
  const items = [item('a'), item('b'), item('c')];
  const waiting = { state: 'waiting', reasons: [{ text: 'Parent not merged', blocked: false }], options: {}, since: T };
  items[2] = { ...items[2], dependsOn: ['a'], waiting };
  const input = { items, tasksById: {}, workflowRunsByProject: { p1: [] }, projectId: 'p1', showArchived: false, now: 0 };
  const queued = buildTaskGroups({ ...input, queue: [entry('e1', 'b')] });
  assert.deepEqual(queued.waiting.map((row) => row.id).sort(), ['b', 'c']);
  assert.equal(queued.waiting.find((row) => row.id === 'b').queued.position, 1);
  assert.equal(queued.waiting.find((row) => row.id === 'c').queued, undefined);
  assert.deepEqual(queued.open.map((row) => row.id), ['a']);
  const removed = buildTaskGroups({ ...input, queue: [] });
  assert.deepEqual(removed.open.map((row) => row.id).sort(), ['a', 'b']);
});

test('footer counts include queued tasks as pending, agreeing with the board', () => {
  const boards = {
    projects: [{ id: 'p1' }],
    planByProject: { p1: { items: [item('a'), item('b')] } },
    taskIdsByProject: { p1: [] },
    workflowRunsByProject: { p1: [] },
    tasksById: {},
  };
  const plain = summarizeWorkspaceCounts(boards).tasks;
  const withQueue = summarizeWorkspaceCounts({ ...boards, planItemQueueByProject: { p1: [entry('e1', 'a')] } }).tasks;
  assert.deepEqual(withQueue, plain, 'a queued task is still one pending task');
  assert.equal(withQueue.pending, 2);
});

test('a planItemQueue event replaces that project\'s list and leaves other projects and slices alone', () => {
  const before = { planItemQueueByProject: { p1: [entry('old', 'a')], p2: [entry('other', 'z', { projectId: 'p2' })] }, tasksById: {} };
  const after = mergeWorkerEvent({ ...useWorldStore.getState(), ...before }, { type: 'planItemQueue', projectId: 'p1', entries: [entry('e1', 'b'), entry('e2', 'c')] });
  assert.deepEqual(after.planItemQueueByProject.p1.map((e) => e.id), ['e1', 'e2']);
  assert.equal(after.planItemQueueByProject.p2, before.planItemQueueByProject.p2);
  assert.equal('tasksById' in after, false, 'no other slice is touched');
  const emptied = mergeWorkerEvent({ ...useWorldStore.getState(), ...after }, { type: 'planItemQueue', projectId: 'p1', entries: [] });
  assert.deepEqual(emptied.planItemQueueByProject.p1, []);
});

test('executePlanItem answered "queued" records the entry and resolves an empty run id; a later event does not duplicate it', async () => {
  const original = serverApi.executePlanItem;
  useWorldStore.setState({ planItemQueueByProject: {} });
  serverApi.executePlanItem = async () => ({ started: false, entry: entry('e1', 'a') });
  try {
    assert.equal(await useWorldStore.getState().executePlanItem('a', {}), '');
    assert.deepEqual(useWorldStore.getState().planItemQueueByProject.p1.map((e) => e.id), ['e1']);
    useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItemQueue', projectId: 'p1', entries: [entry('e1', 'a')] }));
    assert.equal(useWorldStore.getState().planItemQueueByProject.p1.length, 1);
  } finally {
    serverApi.executePlanItem = original;
  }
});

test('loading the list fills the store, a failed load keeps what is held, and removing drops the entry', async () => {
  const { listPlanItemQueue, removeFromWaitingList } = serverApi;
  useWorldStore.setState({ planItemQueueByProject: { p1: [entry('keep', 'k')] } });
  serverApi.listPlanItemQueue = async () => { throw new Error('offline'); };
  try {
    await useWorldStore.getState().loadPlanItemQueue('p1');
    assert.deepEqual(useWorldStore.getState().planItemQueueByProject.p1.map((e) => e.id), ['keep']);
    serverApi.listPlanItemQueue = async () => [entry('e1', 'a'), entry('e2', 'b')];
    await useWorldStore.getState().loadPlanItemQueue('p1');
    assert.deepEqual(useWorldStore.getState().planItemQueueByProject.p1.map((e) => e.id), ['e1', 'e2']);
    const removed = [];
    serverApi.removeFromWaitingList = async (id) => { removed.push(id); };
    assert.equal(await useWorldStore.getState().removeFromWaitingList('p1', 'e1'), true);
    assert.deepEqual(removed, ['e1']);
    assert.deepEqual(useWorldStore.getState().planItemQueueByProject.p1.map((e) => e.id), ['e2']);
  } finally {
    Object.assign(serverApi, { listPlanItemQueue, removeFromWaitingList });
  }
});

test('executePlanItem reads 202 as queued and 201 as started', async () => {
  const realFetch = globalThis.fetch;
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  try {
    globalThis.fetch = answer(202, { started: false, entry: entry('e1', 'a') });
    assert.equal((await serverApi.executePlanItem('a', {})).started, false);
    globalThis.fetch = answer(201, { id: 'run-1', projectId: 'p1' });
    assert.deepEqual(await serverApi.executePlanItem('a', {}), { started: true, run: { id: 'run-1', projectId: 'p1' } });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the Start dialog queues quietly: no limit alert for a queued start, a note only when the Project is full, and a toast', () => {
  const actions = source('../src/ui/project-popup/useTaskActions.ts');
  assert.match(actions, /const notice = queuedNoticeFor\(row\.title, useWorldStore\.getState\(\)\.planItemQueueByProject\[project\.id\], row\.id\);\s*if \(notice\) toast\(notice\);/);
  const dialog = source('../src/ui/project-popup/TaskDialogs.tsx');
  assert.match(dialog, /const fullNote = fullProjectNote\(slotsInUse, slotCap\(hasRepository\)\);/);
  assert.match(dialog, /\{fullNote && !confirming && <p [^>]*data-full-note>\{fullNote\}<\/p>\}/);
  assert.match(dialog, /onClick=\{\(\) => void start\(\)\}>Start<\/Button>/, 'the button still says Start');
});

test('the card offers Remove from waiting list only for a queued task, without a confirmation', () => {
  const board = source('../src/ui/project-popup/TaskBoard.tsx');
  assert.match(board, /\{queued && onRemoveFromWaitingList && \([\s\S]*onClick=\{onRemoveFromWaitingList\}>Remove from waiting list<\/Button>/);
  assert.match(board, /const removable = row\.queued && !row\.earlyPhase;/, 'an early UI Planning start leaves the line only through its switch or Cancel waiting');
  assert.match(board, /onRemoveFromWaitingList=\{removable \? \(\) => handlers\.onRemoveFromWaitingList\(row\.queued!\.entryId\) : undefined\}/);
  assert.match(source('../src/ui/project-popup/TasksPanel.tsx'), /onRemoveFromWaitingList: \(entryId\) => void actions\.removeFromWaitingList\(entryId\)/);
});

test('C09 an accepted start that ran at once shows no toast; a queued one shows its place', () => {
  const entries = [entry('e1', 'a', { position: 0 }), entry('e2', 'b', { position: 1 })];
  assert.equal(queuedNoticeFor('Task C', entries, 'c'), null);
  assert.equal(queuedNoticeFor('Task C', undefined, 'c'), null);
  assert.equal(queuedNoticeFor('Task B', entries, 'b'), 'Task B is waiting for a free slot (2nd in line)');
});

test('C10 a refusal keeps the Start dialog open with the reason; only an accepted start lets the caller close it', () => {
  const dialog = source('../src/ui/project-popup/TaskDialogs.tsx');
  assert.match(dialog, /try \{\s*await onStart\([\s\S]*?\} catch \(failure\) \{\s*const refused = taskConflictOf\(failure\);\s*if \(refused\) setConflict\(refused\);\s*else setError\(\(failure as Error\)\.message\);\s*setStarting\(false\);\s*\}/);
  assert.match(source('../src/ui/project-popup/TasksPanel.tsx'), /await actions\.start\(dialog\.row, options\);\s*setDialog\(null\);/);
});

test('C16 removing a task from the waiting list returns its card to unstarted and renumbers the rest', async () => {
  const { removeFromWaitingList } = serverApi;
  serverApi.removeFromWaitingList = async () => undefined;
  const items = [item('a'), item('b'), item('c')];
  const input = { items, tasksById: {}, workflowRunsByProject: { p1: [] }, projectId: 'p1', showArchived: false, now: 0 };
  useWorldStore.setState({ planItemQueueByProject: { p1: [entry('e1', 'a', { position: 0 }), entry('e2', 'b', { position: 1 })] } });
  try {
    assert.equal(await useWorldStore.getState().removeFromWaitingList('p1', 'e1'), true);
    const groups = buildTaskGroups({ ...input, queue: useWorldStore.getState().planItemQueueByProject.p1 });
    assert.deepEqual(groups.open.map((row) => row.id).sort(), ['a', 'c']);
    assert.equal(groups.waiting.find((row) => row.id === 'b').queued.position, 1);
  } finally {
    serverApi.removeFromWaitingList = removeFromWaitingList;
  }
});

test('a run still starting counts as a slot in use: it sits in the Running group the dialog counts', () => {
  const run = { id: 'run-a', projectId: 'p1', planItemId: 'a', status: 'starting', startup: { steps: [] }, workflowSnapshot: { id: 'w', name: 'w', description: '', enabled: true, steps: [] }, createdAt: T, updatedAt: T, completedAt: null };
  const groups = buildTaskGroups({ items: [{ ...item('a'), status: 'developing', workflowRunId: 'run-a' }], tasksById: {}, workflowRunsByProject: { p1: [run] }, projectId: 'p1', showArchived: false, now: 0 });
  assert.deepEqual(groups.running.map((row) => row.id), ['a']);
});
