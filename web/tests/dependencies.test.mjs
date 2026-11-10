import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const lib = await import('../src/lib/dependencies.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { buildOpenTaskRows } = await import('../src/lib/projectTasks.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { reportedError, CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/** Cases U31 to U37 and C1 to C12 of task 10.018. */

const item = (id, extra = {}) => ({ id, projectId: 'p', title: `10.0${id}: Task ${id}`, description: '', status: 'pending', order: 0, taskIds: [], executorId: null, workflowRunId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra });
const reason = (extra = {}) => ({ parentId: 'a', text: 'Waiting for #10.01 to finish', blocked: false, ...extra });
const waiting = (state, reasons) => ({ options: {}, state, reasons, since: '2026-01-01T00:00:00.000Z', longWaitNotified: false, updatedAt: '2026-01-01T00:00:00.000Z' });

test('U31 reasons keep the daemon\'s wording and each carries its one-click action label', () => {
  const view = lib.waitingView(waiting('waiting', [
    reason({ text: 'Parent #10.01 isn\'t set to auto-merge: merge it manually or turn auto-merge on', action: 'toggle-auto-merge' }),
    reason({ text: 'Waiting for main to receive #10.01 (pull needed)', action: 'sync' }),
    reason({ text: 'Blocked: parent #10.01 failed', blocked: true, action: 'retry-parent' }),
    reason({ text: 'Blocked: a parent task was deleted', blocked: true, action: 'remove-dependency' }),
  ]));
  assert.deepEqual(view.reasons.map((entry) => lib.ACTION_LABELS[entry.action]), ['Turn on auto-merge', 'Sync now', 'Retry parent', 'Remove dependency']);
});

test('U32 the section is editable for a ready, unstarted task and read-only otherwise', () => {
  const parent = item('1');
  assert.equal(lib.dependsOnSection(item('2', { dependsOn: ['1'] }), [parent], 'https://github.com/o/r').mode, 'editable');
  assert.equal(lib.dependsOnSection(item('2', { dependsOn: ['1'], status: 'developing', workflowRunId: 'r' }), [parent], 'https://github.com/o/r').mode, 'readonly');
  assert.equal(lib.dependsOnSection(item('2', { status: 'developing', workflowRunId: 'r' }), [parent], 'https://github.com/o/r').mode, 'hidden');
  assert.equal(lib.dependsOnSection(item('2', { archived: true }), [parent], 'https://github.com/o/r').mode, 'hidden');
  const section = lib.dependsOnSection(item('2', { dependsOn: ['1', 'gone'] }), [parent], 'https://github.com/o/r');
  assert.deepEqual(section.parents.map((entry) => [entry.label, entry.missing]), [['#10.01', false], ['Deleted task', true]]);
});

test('U33 picker: same project only, ready then started tasks (no done-merged, archived, failed), self excluded, cycles flagged', () => {
  const items = [item('1', { dependsOn: ['2'] }), item('2'), item('3', { archived: true }), item('4', { status: 'done' }), item('5', { projectId: 'other' }), item('6', { dependsOn: ['2'] }), item('7', { status: 'developing', workflowRunId: 'r' }), item('8', { taskIds: ['t'] }), item('10', { prConflict: true }), item('11', { testingSetup: true }), item('12', { status: 'done', autoMerge: { state: 'merged' } }), item('13', { status: 'failed' }), item('14', { status: 'stopped' })];
  const options = lib.pickerOptions(items[1], items);
  assert.deepEqual(options.map((option) => option.id), ['1', '6', '4', '7'], 'ready first, then started, each in plan order');
  assert.deepEqual(options.map((option) => option.state), ['Ready', 'Ready', 'Waiting to merge', 'In progress']);
  assert.deepEqual(options.map((option) => option.flag !== null), [true, true, false, false], 'tasks that already wait for this one are flagged');
  assert.equal(options[0].label, '#10.01');
  const chosen = lib.pickerOptions(item('9', { dependsOn: ['1'] }), [...items, item('9', { dependsOn: ['1'] })]);
  assert.ok(!chosen.some((option) => option.id === '1' || option.id === '9'), 'chosen parents and itself are not offered');
  assert.deepEqual(lib.pickerOptions(items[1], [items[1], items[2], items[11]]), [], 'nothing to offer');
});

test('parentState maps started tasks and canBeParent widens the child rule without changing it', () => {
  const started = { workflowRunId: 'r' };
  assert.equal(lib.parentState(item('1')), 'Ready');
  assert.equal(lib.parentState(item('1', { ...started, status: 'developing' })), 'In progress');
  assert.equal(lib.parentState(item('1', { ...started, status: 'blocked' })), 'Needs you');
  assert.equal(lib.parentState(item('1', { ...started, status: 'done' })), 'Waiting to merge');
  assert.equal(lib.parentState(item('1', { status: 'done', autoMerge: { state: 'waiting' } })), 'Waiting to merge');
  assert.equal(lib.parentState(item('1', { status: 'done', autoMerge: { state: 'no-pr' } })), 'Waiting to merge');
  assert.equal(lib.parentState(item('1', { status: 'done', pullRequest: { state: 'merged' } })), null);
  assert.equal(lib.parentState(item('1', { status: 'done', autoMerge: { state: 'merged' } })), null);
  for (const extra of [{ archived: true }, { prConflict: true }, { testingSetup: true }, { status: 'failed' }, { status: 'stopped' }]) assert.equal(lib.canBeParent(item('1', extra)), false);
  assert.equal(lib.canBeParent(item('1', { status: 'developing' })), true);
  for (const extra of [{ status: 'developing' }, { status: 'blocked' }, { status: 'done' }, { archived: true }, { prConflict: true }, { testingSetup: true }, { workflowRunId: 'r' }, { taskIds: ['t'] }]) assert.equal(lib.canEditDependencies(item('1', extra)), false);
  assert.equal(lib.canEditDependencies(item('1')), true);
});

test('the section offers started tasks only to a ready task', () => {
  const running = item('1', { status: 'developing', workflowRunId: 'r' });
  const editable = lib.dependsOnSection(item('2'), [running, item('2')], REPO);
  assert.deepEqual([editable.mode, editable.options.map((option) => option.id)], ['editable', ['1']]);
  const startedChild = item('3', { status: 'developing', workflowRunId: 'r', dependsOn: ['1'] });
  const readonly = lib.dependsOnSection(startedChild, [running, startedChild], REPO);
  assert.deepEqual([readonly.mode, readonly.options], ['readonly', []]);
});

test('U34 card state: Waiting badge, a blocked card has no Start, Cancel waiting is available only while waiting', () => {
  assert.equal(lib.waitingView(undefined), null);
  const waitingView = lib.waitingView(waiting('waiting', [reason()]));
  assert.deepEqual([waitingView.badge, waitingView.canCancel, waitingView.canStart], ['Waiting', true, false]);
  const blockedView = lib.waitingView(waiting('blocked', [reason({ blocked: true })]));
  assert.deepEqual([blockedView.badge, blockedView.canStart], ['Blocked', false]);
});

test('U35 a waiting task offers no Start; it only leaves with an accepted start', () => {
  const rows = buildOpenTaskRows({ items: [item('1', { waiting: waiting('waiting', [reason()]), dependsOn: ['0'], planningQueueOrder: -5 }), item('2')], tasksById: {}, showArchived: false, now: 0 });
  assert.deepEqual(rows.map((row) => [row.id, row.state, row.primary]), [['1', 'todo', 'none'], ['2', 'todo', 'start']]);
  assert.deepEqual(rows[0].dependsOn, ['0']);
  assert.equal(rows[0].waiting.state, 'waiting');
  const started = buildOpenTaskRows({ items: [item('1', { status: 'developing', workflowRunId: 'r' })], tasksById: {}, showArchived: false, now: 0 });
  assert.equal(started[0].waiting, undefined);
});

test('U35b a waiting task is grouped under waiting (shown in the Running column), not Planning; cancelling waiting returns it to Planning', () => {
  const groupsOf = (items) => buildTaskGroups({ items, tasksById: {}, workflowRunsByProject: {}, projectId: 'p', showArchived: false, now: 0 });
  const waitingItem = item('1', { waiting: waiting('blocked', [reason({ blocked: true })]), dependsOn: ['0'] });
  const groups = groupsOf([waitingItem, item('2')]);
  assert.deepEqual([groups.waiting.map((row) => row.id), groups.running.length, groups.open.map((row) => row.id), groups.needsYou.length], [['1'], 0, ['2'], 0]);
  const cancelled = groupsOf([{ ...waitingItem, waiting: undefined }]);
  assert.deepEqual([cancelled.waiting.length, cancelled.running.length, cancelled.open.map((row) => row.id)], [0, 0, ['1']]);
});

test('U35c dependencyForest nests a child under its parent in the same list and guards cycles', () => {
  const ids = (nodes) => nodes.map((node) => [node.row.id, ids(node.children)]);
  assert.deepEqual(ids(lib.dependencyForest([{ id: 'b', dependsOn: ['a'] }, { id: 'a' }, { id: 'c', dependsOn: ['x', 'b'] }, { id: 'd', dependsOn: ['x'] }])), [['a', [['b', [['c', []]]]]], ['d', []]]);
  assert.deepEqual(ids(lib.dependencyForest([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }, { id: 's', dependsOn: ['s'] }])), [['a', [['b', []]]], ['s', []]]);
});

test('U36 a project without a linked repository gives a disabled-with-explanation state', () => {
  assert.deepEqual(lib.dependsOnSection(item('2'), [], undefined), { mode: 'unavailable', reason: lib.NO_REPOSITORY_REASON });
  assert.equal(lib.dependsOnSection(item('2', { status: 'developing', workflowRunId: 'r' }), [], undefined).mode, 'hidden');
});

test('U37 the start confirmation lists only the parents that are not satisfied, with where each stands', () => {
  const parents = [
    { id: 'a', label: '#10.01', title: 'A', satisfied: true, reason: null },
    { id: 'b', label: '#10.02', title: 'B', satisfied: false, reason: reason({ parentId: 'b', text: 'Waiting for #10.02 to be merged' }) },
    { id: 'c', label: '#10.03', title: 'C', satisfied: false, reason: null },
  ];
  assert.deepEqual(lib.startConfirm(parents).map((entry) => [entry.id, entry.status]), [['b', 'Waiting for #10.02 to be merged'], ['c', 'Not merged yet']]);
  assert.deepEqual(lib.startConfirm([parents[0]]), []);
  assert.equal(lib.START_WHEN_MERGED_LABEL, 'Start when parents are merged');
});

test('labels use the planning number, else the title', () => {
  assert.equal(lib.dependencyLabel({ title: '10.018: Dependent tasks' }), '#10.018');
  assert.equal(lib.dependencyLabel({ title: 'Plain' }), 'Plain');
});

// ---- Store, through the stub that mirrors the daemon ----

async function world() {
  const stub = installServerStub();
  useWorldStore.setState({ ...useWorldStore.getInitialState?.(), ...CLEAN_ERROR_STATE }, false);
  await useWorldStore.getState().addProject('Deps');
  const project = useWorldStore.getState().projects.at(-1);
  stub.projects.get(project.id).repositoryUrl = 'https://github.com/o/r';
  await useWorldStore.getState().loadPlan(project.id);
  const create = (title) => useWorldStore.getState().createPlanItem(project.id, { title, description: '' });
  const items = () => useWorldStore.getState().planByProject[project.id].items;
  return { stub, projectId: project.id, create, items, byId: (id) => items().find((entry) => entry.id === id) };
}

test('C1 the store adds and removes a dependency and keeps it in the plan', async () => {
  const w = await world();
  const [a, b] = [await w.create('10.1: A'), await w.create('10.2: B')];
  assert.equal(await useWorldStore.getState().setDependencies(w.projectId, b, [a]), true);
  assert.deepEqual(w.byId(b).dependsOn, [a]);
  assert.equal(await useWorldStore.getState().setDependencies(w.projectId, b, []), true);
  assert.deepEqual(w.byId(b).dependsOn, []);
});

test('C2 starting a dependent task waits (empty run id), keeps it pending in Planning and stores the options', async () => {
  const w = await world();
  const [a, b] = [await w.create('10.1: A'), await w.create('10.2: B')];
  await useWorldStore.getState().setDependencies(w.projectId, b, [a]);
  const runId = await useWorldStore.getState().startWhenReady(w.projectId, b, { executorId: 'test-claude', createBranch: true });
  assert.equal(runId, '');
  assert.equal(w.byId(b).status, 'pending');
  assert.equal(w.byId(b).workflowRunId ?? null, null);
  assert.deepEqual(w.byId(b).waiting.options, { executorId: 'test-claude', createBranch: true });
  assert.equal(w.stub.executeRequests.length, 0, 'the plain execute route is not used for a dependent task');
});

test('C2b with every parent done the start goes ahead and returns the run id; a task without parents uses the plain route', async () => {
  const w = await world();
  const [a, b, c] = [await w.create('10.1: A'), await w.create('10.2: B'), await w.create('10.3: C')];
  w.stub.planItems.get(a).status = 'done';
  await useWorldStore.getState().setDependencies(w.projectId, b, [a]);
  assert.match(await useWorldStore.getState().startWhenReady(w.projectId, b, {}), /^test-workflow-run-/);
  await useWorldStore.getState().executePlanItem(c, {});
  assert.deepEqual(w.stub.executeRequests.map((request) => request.planItemId), [c]);
});

test('U38 startsWhenReady: a task with parents or already waiting goes through start-when-ready', () => {
  assert.equal(lib.startsWhenReady(item('2', { dependsOn: ['1'] })), true);
  assert.equal(lib.startsWhenReady(item('2', { waiting: waiting('waiting', [reason()]) })), true);
  assert.equal(lib.startsWhenReady(item('2', { dependsOn: [] })), false);
  assert.equal(lib.startsWhenReady(item('2')), false);
  assert.equal(lib.startsWhenReady(undefined), false, 'an item the store does not hold starts normally');
});

test('C2c the Start dialog\'s start picks start-when-ready from the stored item, even when the caller passes only id and title (planning panel)', async () => {
  const w = await world();
  const [a, b, c] = [await w.create('10.1: A'), await w.create('10.2: B'), await w.create('10.3: C')];
  await useWorldStore.getState().setDependencies(w.projectId, b, [a]);
  assert.equal(await useWorldStore.getState().startPlanItem(w.projectId, b, { executorId: 'test-claude' }), '');
  assert.equal(w.byId(b).waiting.state, 'waiting');
  assert.equal(w.stub.executeRequests.length, 0, 'the dependent task never hits the plain execute route');
  assert.match(await useWorldStore.getState().startPlanItem(w.projectId, c, {}), /^test-workflow-run-/);
  assert.deepEqual(w.stub.executeRequests.map((request) => request.planItemId), [c], 'a task without parents still uses the plain route');
});

test('C2d like the daemon, the plain execute route refuses a dependent task', async () => {
  const w = await world();
  const [a, b] = [await w.create('10.1: A'), await w.create('10.2: B')];
  await useWorldStore.getState().setDependencies(w.projectId, b, [a]);
  await assert.rejects(useWorldStore.getState().executePlanItem(b, {}), /This task depends on other tasks: start it with start-when-ready\./);
  assert.equal(w.byId(b).status, 'pending');
});

test('C3 Cancel waiting returns the task to plain ready with its dependencies kept', async () => {
  const w = await world();
  const [a, b] = [await w.create('10.1: A'), await w.create('10.2: B')];
  await useWorldStore.getState().setDependencies(w.projectId, b, [a]);
  await useWorldStore.getState().startWhenReady(w.projectId, b, {});
  assert.equal(await useWorldStore.getState().cancelWaiting(w.projectId, b), true);
  assert.equal(w.byId(b).waiting, undefined);
  assert.deepEqual(w.byId(b).dependsOn, [a]);
  assert.equal(await useWorldStore.getState().cancelWaiting(w.projectId, b), false);
  assert.match(reportedError() ?? '', /not waiting/);
});

test('C4 a live plan item event updates the card state, and removing the waiting state clears it', async () => {
  const w = await world();
  const [a, b] = [await w.create('10.1: A'), await w.create('10.2: B')];
  const mine = w.byId(b);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...mine, dependsOn: [a], waiting: waiting('blocked', [reason({ blocked: true, text: 'Blocked: parent #10.1 failed' })]) } }));
  assert.equal(w.byId(b).waiting.state, 'blocked');
  const rows = buildOpenTaskRows({ items: w.items(), tasksById: {}, showArchived: false, now: 0 });
  assert.equal(rows.find((row) => row.id === b).waiting.reasons[0].text, 'Blocked: parent #10.1 failed');
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...mine, dependsOn: [a] } }));
  assert.equal(w.byId(b).waiting, undefined);
});

test('C5 the daemon\'s 400, 404 and 409 reach the person as readable messages', async () => {
  const w = await world();
  const [a, b] = [await w.create('10.1: A'), await w.create('10.2: B')];
  await useWorldStore.getState().setDependencies(w.projectId, b, [a]);
  assert.equal(await useWorldStore.getState().setDependencies(w.projectId, a, [b]), false);
  assert.match(reportedError() ?? '', /wait for each other/);
  assert.equal(await useWorldStore.getState().setDependencies(w.projectId, a, [a]), false);
  assert.match(reportedError() ?? '', /itself/);
  assert.equal(await useWorldStore.getState().setDependencies(w.projectId, a, ['nope']), false);
  assert.match(reportedError() ?? '', /no longer exists/);
  const response = await fetch(`http://localhost:4500/api/projects/${w.projectId}/plan-items/${a}/dependencies`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dependsOn: 'x' }) });
  assert.equal(response.status, 400);
  w.stub.projects.get(w.projectId).repositoryUrl = undefined;
  assert.equal(await useWorldStore.getState().setDependencies(w.projectId, a, [b]), false);
  assert.match(reportedError() ?? '', /linked repository/);
});

test('C12 the chain shortcut links the group\'s ready tasks in order and leaves order and titles alone', async () => {
  const w = await world();
  const ids = [await w.create('10.1: A'), await w.create('10.2: B'), await w.create('10.3: C')];
  ids.forEach((id, index) => Object.assign(w.stub.planItems.get(id), { planningRef: { session: 7, task: index + 1 }, planningGroupOrder: index + 1 }));
  const before = w.items().map(({ id, title, order }) => ({ id, title, order }));
  assert.equal(await useWorldStore.getState().chainPlanningGroup(w.projectId, 7, true), true);
  assert.deepEqual(w.byId(ids[1]).dependsOn, [ids[0]]);
  assert.deepEqual(w.byId(ids[2]).dependsOn, [ids[1]]);
  assert.equal(w.byId(ids[0]).dependsOn, undefined);
  assert.ok(ids.every((id) => w.byId(id).autoMerge.enabled));
  assert.deepEqual(w.items().map(({ id, title, order }) => ({ id, title, order })), before);
});

// ---- Source checks: the screens are wired ----

test('C6 the details header mounts the Depends on section with add, remove and the picker', async () => {
  const header = await read('../src/ui/project-popup/DetailHeader.tsx');
  assert.match(header, /<DependsOnSection item=\{item\} \/>/);
  const control = await read('../src/ui/project-popup/DependenciesControl.tsx');
  assert.match(control, /aria-label="Depends on"/);
  assert.match(control, /aria-label="Add a parent task"/);
  assert.match(control, /<CommandInput/);
  assert.match(control, /max-h-\[min\(18rem,40vh\)\]/);
  assert.doesNotMatch(control, /<select/);
  assert.match(control, /Remove dependency \$\{parent\.label\}/);
  assert.match(control, /editable = section\.mode === 'editable'/);
});

test('C7 the board card shows the waiting banner from the row', async () => {
  const board = await read('../src/ui/project-popup/TaskBoard.tsx');
  assert.match(board, /\{waiting && \(!queued \|\| earlyPhaseLine\?\.queued\) && <WaitingBanner waiting=\{waitingView\(waiting\)!\} \/>\}/);
  assert.match(board, /waiting=\{row\.waiting\}/);
  const control = await read('../src/ui/project-popup/DependenciesControl.tsx');
  assert.match(control, /data-waiting-banner/);
});

test('C8 the group header offers Chain tasks with the auto-merge checkbox and the order-unchanged copy', async () => {
  const dialogs = await read('../src/ui/project-popup/TaskDialogs.tsx');
  assert.match(dialogs, /export function ChainTasksDialog/);
  assert.match(dialogs, /Only ready tasks are chained; the order, numbers, titles and branches stay as they are\./);
  assert.match(dialogs, /Turn on auto-merge for all of them/);
  const board = await read('../src/ui/project-popup/TaskBoard.tsx');
  assert.match(board, /row\.ready\.length > 1 && <Button[^\n]*>Chain tasks\{planAndBugs && ' \(tasks only\)'\}<\/Button>/);
  const panel = await read('../src/ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /chainPlanningGroup\(project\.id, dialog\.session, autoMerge\)/);
});

test('C9 the start dialog confirms "Start when parents are merged" as its second step', async () => {
  const dialogs = await read('../src/ui/project-popup/TaskDialogs.tsx');
  assert.match(dialogs, />\{parentsView\.primaryLabel\}<\/Button>/, 'START_WHEN_MERGED_LABEL, or "Start UI planning now" (lib/earlyUiPlanning.ts)');
  assert.match(dialogs, /onClick=\{\(\) => setConfirming\(true\)\}>Next<\/Button>/);
  const actions = await read('../src/ui/project-popup/useTaskActions.ts');
  assert.match(actions, /await startPlanItem\(project\.id, row\.id, options\)/);
  const panel = await read('../src/ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /serverApi\.dependencyStatus\(project\.id, startingItemId\)/);
  assert.match(panel, /parents=\{startParents\}/);
  assert.match(dialogs, /if \(parents === null\) return null;/);
});

test('C10 a project without a repository shows the section disabled with the explanation', async () => {
  const control = await read('../src/ui/project-popup/DependenciesControl.tsx');
  assert.match(control, /section\.mode === 'unavailable'[\s\S]*Depends on: unavailable\. \{section\.reason\}/);
});

test('C11 a blocked task has no Start: the drop onto Running is ignored and the panel offers Remove / Retry parent / Cancel waiting', async () => {
  const panel = await read('../src/ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /if \(drop\.kind === 'start' && \(drop\.card as OpenTaskRow\)\.waiting\) return;/);
  const control = await read('../src/ui/project-popup/DependenciesControl.tsx');
  assert.match(control, />Cancel waiting</);
  const labels = lib.ACTION_LABELS;
  assert.equal(labels['remove-dependency'], 'Remove dependency');
  assert.equal(labels['retry-parent'], 'Retry parent');
});

test('the card chip names up to two parents and counts the rest; none without parents', () => {
  assert.equal(lib.dependencyChip(undefined), null);
  assert.equal(lib.dependencyChip([]), null);
  assert.equal(lib.dependencyChip(['#10.1']), 'Depends on #10.1');
  assert.equal(lib.dependencyChip(['#10.1', '#10.2', '#10.3', '#10.4']), 'Depends on #10.1, #10.2 +2');
});

test('a ready task with parents carries their labels on its row, a deleted parent included', () => {
  const rows = buildOpenTaskRows({ items: [item('1'), item('2', { dependsOn: ['1', 'gone'] })], tasksById: {}, showArchived: false, now: 0 });
  assert.deepEqual(rows.find((row) => row.id === '2').dependsOnLabels, ['#10.01', 'a deleted task']);
  assert.equal(rows.find((row) => row.id === '1').dependsOnLabels, undefined);
});

test('the card shows the chip and a Depends on… picker for an editable task', async () => {
  const board = await read('../src/ui/project-popup/TaskBoard.tsx');
  assert.match(board, /data-depends-chip/);
  assert.match(board, /dependsOnPicker=\{row\.canEdit && !row\.archived \?/);
  assert.match(board, /<DependsOnPicker projectId=\{handlers\.projectId\} itemId=\{row\.id\} \/>/);
});

const REPO = 'https://github.com/o/r';

test('linkCandidates lists ready and started, unarchived, acyclic tasks of the project, minus the current parents', () => {
  const child = item('3', { dependsOn: ['1'] });
  const items = [
    item('1'), item('2'), child,
    item('4', { status: 'done' }), item('5', { archived: true }), item('6', { projectId: 'other' }),
    item('7', { dependsOn: ['3'] }), item('8', { testingSetup: true }),
    item('9', { status: 'developing', workflowRunId: 'r' }), item('10', { status: 'blocked', workflowRunId: 'r' }), item('11', { status: 'done', pullRequest: { state: 'merged' } }),
  ];
  assert.deepEqual(lib.linkCandidates(child, items).map((option) => option.id), ['2', '4', '9', '10']);
});

test('planLinkDrop makes the dropped-on task depend on the dragged one, keeping its other parents', () => {
  const items = [item('1'), item('2', { dependsOn: ['1'] }), item('3')];
  assert.deepEqual(lib.planLinkDrop('3', '2', items, REPO), { itemId: '2', dependsOn: ['1', '3'] });
});

test('planLinkDrop links a running, needs-attention or unmerged-done card onto a ready card', () => {
  const items = [item('1', { status: 'developing', workflowRunId: 'r' }), item('2', { status: 'blocked', workflowRunId: 'r' }), item('3', { status: 'done' }), item('4', { dependsOn: ['9'] })];
  for (const parent of ['1', '2', '3']) assert.deepEqual(lib.planLinkDrop(parent, '4', items, REPO), { itemId: '4', dependsOn: ['9', parent] });
});

test('planLinkDrop refuses self, repeat, cycle, started child, merged or archived parent and repository-less links', () => {
  const items = [item('1'), item('2', { dependsOn: ['1'] }), item('3', { status: 'done', autoMerge: { state: 'merged' } }), item('4', { status: 'developing', workflowRunId: 'r' }), item('5', { archived: true })];
  assert.equal(lib.planLinkDrop('1', '1', items, REPO), null);
  assert.equal(lib.planLinkDrop('1', '2', items, REPO), null);
  assert.equal(lib.planLinkDrop('2', '1', items, REPO), null);
  assert.equal(lib.planLinkDrop('3', '1', items, REPO), null);
  assert.equal(lib.planLinkDrop('5', '1', items, REPO), null);
  assert.equal(lib.planLinkDrop('1', '4', items, REPO), null);
  assert.equal(lib.planLinkDrop('2', '9', items, REPO), null);
  assert.equal(lib.planLinkDrop('2', '1', [item('1'), item('2')], null), null);
});

test('the pickers group ready and started tasks with state badges and no stale copy', async () => {
  const [group, picker, control] = await Promise.all(['ParentOptionGroups', 'DependsOnPicker', 'DependenciesControl'].map((name) => read(`../src/ui/project-popup/${name}.tsx`)));
  assert.match(group, /heading="Ready"/);
  assert.match(group, /heading="Started"/);
  assert.match(group, /Your item waits until their PR is merged\./);
  assert.match(picker, /No tasks or bugs to depend on\./);
  assert.match(picker, /placeholder="Search tasks and bugs…"/);
  assert.match(control, /ParentOptionGroups/);
  assert.match(control, /\$\{option\.flag\}|option\.flag/);
  assert.doesNotMatch(picker + control, /No ready tasks found|No pending task|Search pending/);
});

test('the card opens the inline picker, not the details view', async () => {
  const [panel, board] = await Promise.all([read('../src/ui/project-popup/TasksPanel.tsx'), read('../src/ui/project-popup/TaskBoard.tsx')]);
  assert.doesNotMatch(panel + board, /onOpenDependencies|Add a parent task/);
  assert.match(board, /DependsOnPicker/);
});

test('link-dropping a card is handled on the card, apart from the column reorder', async () => {
  const dnd = await read('../src/ui/project-popup/useBoardDnd.ts');
  assert.match(dnd, /event\.stopPropagation\(\)/);
  assert.match(dnd, /link\?\.canLink\(dragged\.id, card\.id\)/);
  assert.match(await read('../src/ui/project-popup/TasksPanel.tsx'), /planLinkDrop\(parentId, childId, items, project\.repositoryUrl\)/);
});

test('the board shows Waiting/Blocked as the card status and nests dependents under their parent', async () => {
  const board = await read('../src/ui/project-popup/TaskBoard.tsx');
  assert.match(board, /status=\{openCardStatus\(row\)\}/, 'Waiting or Blocked from the row (lib/earlyUiPlanning.ts)');
  const panel = await read('../src/ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /dependencyForest\(columns\[column\]/);
  assert.match(panel, /data-dependents-of=/);
});
