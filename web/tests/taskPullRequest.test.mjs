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

const { completedAutoMergeHold, prRowAutoMergeTag } = await import('../src/lib/autoMerge.ts');
const { taskPrView, detailStatus, waitsForPrMerge, PR_STATUS_UNKNOWN_HINT, WAITING_FOR_PR_LABEL } = await import('../src/lib/taskPullRequest.ts');
const { buildTaskGroups, needsYouSeverity } = await import('../src/lib/workflowTaskGroups.ts');
const { buildCompletedRows, buildArchivedRows, taskProgress } = await import('../src/lib/projectTasks.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/** Task 10.022: a finished task whose own pull request is open waits in "PR not merged yet", Auto-merge on or off. */

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const reading = (state, prNumber = 7) => ({ state, prNumber, readAt: '2026-10-15T11:00:00.000Z' });
const autoMerge = (state, extra = {}) => ({ enabled: true, state, reasons: [], prNumber: 7, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: '2026-10-15T11:00:00.000Z', ...extra });
const item = (id, extra = {}) => ({
  id, projectId: 'p1', title: `Task ${id}`, description: '', status: 'done', order: 1, taskIds: [], executorId: null, workflowRunId: `run-${id}`,
  createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z', ...extra,
});
const run = (id, extra = {}) => ({ id: `run-${id}`, status: 'completed', branch: `feature/${id}`, baseBranch: 'main', workflowSnapshot: { steps: [] }, currentStepId: null, completedAt: '2026-10-15T10:00:00.000Z', ...extra });
const groupsOf = (items, runs = items.map((entry) => run(entry.id))) => buildTaskGroups({ items, tasksById: {}, workflowRunsByProject: { p1: runs }, projectId: 'p1', showArchived: false, now: NOW });
const completedOf = (items, runs = items.map((entry) => run(entry.id))) => buildCompletedRows({ items, taskIds: [], tasksById: {}, workflowRuns: runs, now: NOW });
const ids = (rows) => rows.map((row) => row.id);

test('an open PR with Auto-merge off holds the task in PR not merged yet, not in Completed', () => {
  const items = [item('a', { pullRequest: reading('open') })];
  assert.deepEqual(ids(groupsOf(items).prNotMerged), ['a']);
  assert.deepEqual(ids(completedOf(items)), []);
  assert.equal(completedAutoMergeHold(items[0], null), 'awaiting-merge');
  assert.equal(groupsOf(items).prNotMerged[0].pr.tag.text, 'PR #7 open');
});

test('a held task whose item status lags behind its completed run still gets the PR tag', () => {
  const lagging = item('a', { status: 'developing', pullRequest: reading('open', 5) });
  const groups = groupsOf([lagging]);
  assert.deepEqual(ids(groups.prNotMerged), ['a']);
  assert.equal(groups.prNotMerged[0].pr.tag.text, 'PR #5 open');
});

test('merged, closed and none go to Completed; merged and closed carry their badge, none carries nothing', () => {
  const items = [item('m', { pullRequest: reading('merged') }), item('c', { pullRequest: reading('closed') }), item('n', { pullRequest: reading('none', null) })];
  assert.deepEqual(groupsOf(items).prNotMerged, []);
  const rows = Object.fromEntries(completedOf(items).map((row) => [row.id, row]));
  assert.deepEqual(rows.m.pr.badge, { label: 'Merged', tone: 'ok' });
  assert.deepEqual(rows.c.pr.badge, { label: 'PR closed', tone: 'warn' });
  assert.equal(rows.n.pr, undefined);
});

test('a closed PR that is reopened returns the task to the row, and a merge moves it to Completed', () => {
  const closed = item('a', { pullRequest: reading('closed') });
  assert.deepEqual(ids(groupsOf([closed]).prNotMerged), []);
  const reopened = { ...closed, pullRequest: reading('open', 9) };
  assert.deepEqual(ids(groupsOf([reopened]).prNotMerged), ['a']);
  assert.equal(groupsOf([reopened]).prNotMerged[0].pr.tag.text, 'PR #9 open');
  const merged = { ...closed, pullRequest: reading('merged', 9) };
  assert.deepEqual(ids(completedOf([merged])), ['a']);
});

test('no reading yet: Completed with the "PR status unknown" hint, only for a task with its own branch', () => {
  const rows = completedOf([item('a'), item('b'), item('c', { status: 'done', prConflict: { number: 3 } })], [run('a'), run('b', { branch: undefined, baseBranch: undefined }), run('c')]);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.a.pr.hint, PR_STATUS_UNKNOWN_HINT);
  assert.equal(byId.b.pr, undefined, 'a run on the project\'s own branch has no PR to be unknown about');
  assert.equal(byId.c.pr, undefined, 'a conflict run');
  assert.deepEqual(ids(groupsOf([item('a')]).prNotMerged), [], 'an unknown reading never holds');
});

test('a task whose reading says open stays held after a failed re-reading: the stored reading is what counts', () => {
  const held = item('a', { pullRequest: reading('open') });
  // A failed lookup changes nothing on the server, so the same stored item arrives again: same row.
  assert.deepEqual(ids(groupsOf([held]).prNotMerged), ids(groupsOf([{ ...held }]).prNotMerged));
});

test('tasks that own no PR are never held, even with an open reading', () => {
  const open = reading('open');
  const cases = [
    item('hand', { workflowRunId: null, pullRequest: open }),
    item('conflict', { prConflict: { number: 3 }, pullRequest: open }),
    item('setup', { testingSetup: { mode: 'setup' }, pullRequest: open }),
  ];
  for (const entry of cases) assert.deepEqual(ids(groupsOf([entry]).prNotMerged), [], entry.id);
  assert.equal(taskPrView(cases[0], null), null);
});

test('Auto-merge on keeps the daemon\'s states and ignores a disagreeing reading', () => {
  for (const state of ['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent']) {
    const held = item('a', { autoMerge: autoMerge(state), pullRequest: reading('closed') });
    assert.deepEqual(ids(groupsOf([held]).prNotMerged), ['a'], state);
    assert.equal(groupsOf([held]).prNotMerged[0].pr, undefined);
  }
  for (const state of ['failed', 'cannot-merge', 'no-pr']) {
    const groups = groupsOf([item('a', { autoMerge: autoMerge(state), pullRequest: reading('open') })]);
    assert.deepEqual([ids(groups.needsYou), ids(groups.prNotMerged)], [['a'], []], state);
  }
  const merged = item('a', { autoMerge: autoMerge('merged'), pullRequest: reading('open') });
  assert.deepEqual(ids(groupsOf([merged]).prNotMerged), []);
  assert.deepEqual(ids(completedOf([merged])), ['a']);
});

test('the PR-held rows follow the Auto-merge rows, newest completion first, ties by task number', () => {
  const items = [
    item('p2', { planningRef: { session: 10, task: 2 }, pullRequest: reading('open') }),
    item('p10', { planningRef: { session: 10, task: 10 }, pullRequest: reading('open') }),
    item('new', { planningRef: { session: 3, task: 1 }, pullRequest: reading('open') }),
    item('am', { autoMerge: autoMerge('waiting') }),
    item('hand', { pullRequest: reading('open') }),
  ];
  const runs = [run('p2'), run('p10'), run('new', { completedAt: '2026-10-15T11:30:00.000Z' }), run('am'), run('hand', { completedAt: '2026-10-15T09:00:00.000Z' })];
  assert.deepEqual(ids(groupsOf(items, runs).prNotMerged), ['am', 'new', 'p2', 'p10', 'hand']);
});

test('ordering survives missing or invalid completion times and 1000 held tasks', () => {
  const odd = [item('x', { updatedAt: 'not a date', pullRequest: reading('open') }), item('y', { pullRequest: reading('open') })];
  assert.deepEqual(ids(groupsOf(odd, [run('x', { completedAt: null }), run('y')]).prNotMerged), ['y', 'x']);
  const many = Array.from({ length: 1000 }, (_, index) => item(`t${index}`, { order: index, pullRequest: reading('open') }));
  assert.equal(groupsOf(many).prNotMerged.length, 1000);
});

test('the Needs-you severity and counts are not changed by a PR-only hold', () => {
  const groups = groupsOf([item('a', { pullRequest: reading('open') })]);
  assert.deepEqual(groups.needsYou, []);
  assert.equal(needsYouSeverity({ attention: null, autoMerge: undefined }, run('a')), 'input');
});

test('progress counts a PR-held task as in progress, not done', () => {
  const progress = taskProgress([item('a', { pullRequest: reading('open') }), item('b', { pullRequest: reading('merged') }), item('c')]);
  assert.deepEqual(progress, { done: 2, inProgress: 1, pending: 0, total: 3 });
});

test('the PR tag, hint and badge are words from one helper; the details header says waiting for PR merge', () => {
  assert.equal(taskPrView(item('a', { pullRequest: reading('open', 2 ** 31) }), null).tag.text, `PR #${2 ** 31} open`);
  assert.equal(taskPrView(item('a', { pullRequest: reading('open', null) }), null).tag.text, 'PR open');
  assert.equal(taskPrView(item('a', { autoMerge: autoMerge('waiting'), pullRequest: reading('open') }), null), null);
  const status = { label: 'Completed', variant: 'success' };
  assert.deepEqual(detailStatus(status, item('a', { pullRequest: reading('open') }), true), { label: WAITING_FOR_PR_LABEL, variant: 'warning' });
  assert.equal(detailStatus(status, item('a', { pullRequest: reading('open') }), false), status);
  assert.equal(detailStatus(status, item('a', { pullRequest: reading('merged') }), true), status);
  assert.equal(detailStatus(status, undefined, true), status);
  assert.equal(waitsForPrMerge(item('a', { autoMerge: autoMerge('waiting'), pullRequest: reading('open') })), false);
});

test('the PR tab tags the pull request a task without Auto-merge waits on, and still tags Auto-merge ones', () => {
  const items = [item('a', { title: 'Add login', pullRequest: reading('open', 12) }), item('b', { title: 'Other', autoMerge: autoMerge('merging', { prNumber: 13 }) })];
  assert.deepEqual(prRowAutoMergeTag(items, 12), { text: 'Waiting to be merged for task "Add login"', tone: 'info', itemId: 'a' });
  assert.match(prRowAutoMergeTag(items, 13).text, /Being auto-merged by task "Other"/);
  assert.equal(prRowAutoMergeTag(items, 99), null);
});

test('Archive all lists only Completed rows, and a held task can still be archived by hand and leaves the board', () => {
  const held = item('a', { pullRequest: reading('open') });
  assert.deepEqual(ids(completedOf([held, item('b', { pullRequest: reading('merged') })])), ['b']);
  const archived = { ...held, archived: true };
  assert.deepEqual(ids(groupsOf([archived]).prNotMerged), []);
  assert.deepEqual(ids(buildArchivedRows({ items: [archived], tasksById: {}, now: NOW })), ['a']);
});

test('a store task event moves the card between rows, live; turning Auto-merge on from the tag keeps the card in the row', async () => {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], tasksById: {}, planByProject: {}, workflowRunsByProject: {} });
  await useWorldStore.getState().addProject('Pr');
  const project = useWorldStore.getState().projects.at(-1);
  stub.projects.get(project.id).repositoryUrl = 'https://github.com/o/r';
  await useWorldStore.getState().loadPlan(project.id);
  const itemId = await useWorldStore.getState().createPlanItem(project.id, { title: 'Task one', description: '' });
  const stored = () => useWorldStore.getState().planByProject[project.id].items.find((entry) => entry.id === itemId);
  const apply = (change) => useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...stored(), ...change } }));
  apply({ status: 'done', workflowRunId: 'run-x', pullRequest: reading('open', 4) });
  const rows = () => groupsOf([stored()], [run('x', { id: 'run-x' })]);
  assert.deepEqual(ids(rows().prNotMerged), [itemId]);
  assert.equal(await useWorldStore.getState().setAutoMerge(project.id, itemId, true), true);
  assert.deepEqual(ids(rows().prNotMerged), [itemId], 'the card stays; its chip now comes from Auto-merge');
  assert.equal(rows().prNotMerged[0].pr, undefined);
  apply({ autoMerge: autoMerge('merged'), pullRequest: reading('merged', 4) });
  assert.deepEqual(ids(rows().prNotMerged), []);
  assert.deepEqual(ids(completedOf([stored()], [run('x', { id: 'run-x' })])), [itemId]);
});

test('source pins: the board shows the tag and offer on held cards, the new empty text, and Archive all uses Completed rows only', async () => {
  const [board, panel, header, status, projectTasks] = await Promise.all([
    read('../src/ui/project-popup/TaskBoard.tsx'), read('../src/ui/project-popup/TasksPanel.tsx'), read('../src/ui/project-popup/DetailHeader.tsx'),
    read('../src/ui/project-popup/TaskPrStatus.tsx'), read('../src/lib/projectTasks.ts'),
  ]);
  assert.match(panel, /Finished tasks wait here until their pull request is merged\./);
  assert.doesNotMatch(panel, /Tasks with Auto-merge on wait here/);
  assert.match(panel, /completedRows\.filter\(\(row\) => row\.canArchive\)/);
  assert.match(board, /<PrOpenTag pr=\{pr\}/);
  assert.match(board, /<PrBadge pr=\{pr\} \/>/);
  assert.match(board, /<PrHint pr=\{pr\} \/>/);
  assert.match(status, /openPullRequest\(projectId, tag\.prNumber\)/);
  assert.match(status, /autoMergeToggle\(/);
  assert.match(status, /setAutoMerge\(projectId, itemId, true\)/);
  assert.match(header, /detailStatus\(reportedStatus,/);
  assert.match(projectTasks, /completedAutoMergeHold\(item, runOf\(item\)\)/);
});
