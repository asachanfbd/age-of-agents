import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
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

const { useWorldStore } = await import('../src/store/worldStore.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { yardModelFor } = await import('../src/lib/useYardModel.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

/**
 * The 3D village's store wiring: red machines for failed runs nobody has opened (loaded at startup,
 * kept live, cleared by opening the log anywhere) and the task tooltip's live step summary.
 */

const T = '2026-10-18T10:00:00.000Z';
const project = (id) => ({ id, name: id, slug: id, relativePath: `projects/${id}`, status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: T, updatedAt: T });
const commandRun = (id, projectId, patch = {}) => ({ id, projectId, commandId: 'c', commandName: 'npm run build', commandText: 'npm run build', origin: 'saved', location: { kind: 'main' }, status: 'failed', exitCode: 1, output: 'boom', startedAt: T, completedAt: T, ...patch });
const testRun = (id, projectId, patch = {}) => ({ id, projectId, batchId: null, suite: { id: 'web', label: 'Web', kind: 'unit' }, action: { id: 'tests', label: 'Run tests' }, trigger: 'manual', taskId: null, executionRoot: 'main', cwd: null, branch: 'main', commit: null, status: 'failed', exitCode: 1, queuedAt: T, startedAt: T, completedAt: T, durationMs: 1, outputTruncated: false, summary: null, diagnostics: [], artifactDir: null, output: '', result: null, ...patch });

function reset() {
  useWorldStore.setState({
    projects: [], tasksById: {}, taskIdsByProject: {}, planByProject: {}, workflowRunsByProject: {}, commandRunsById: {}, testRunsById: {},
    workspaceProjectId: null, workspaceTab: 'tasks', workspaceSettingsSection: 'workflow', footerCommandLogRunId: null, notificationCenterOpen: false,
    ...CLEAN_ERROR_STATE, loaded: false,
  });
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition never held');
}

/** The store's state as `useYardModel` hands it to `yardModelFor`. */
const yardSlices = () => {
  const s = useWorldStore.getState();
  return { ...s, commandRuns: Object.values(s.commandRunsById), testRuns: Object.values(s.testRunsById) };
};
const machinesOf = (projectId) => yardModelFor(projectId, yardSlices()).commands;

function captureLiveUpdates() {
  const original = serverApi.connectLiveUpdates;
  const captured = {};
  serverApi.connectLiveUpdates = (onEvent, onReconnect) => { captured.onEvent = onEvent; captured.onReconnect = onReconnect; return () => {}; };
  useWorldStore.getState().connectLiveUpdates();
  serverApi.connectLiveUpdates = original;
  return captured;
}

test('IW01 startup loads each Project\'s unopened failed command and test runs; a Project with none adds nothing', async () => {
  const stub = installServerStub();
  reset();
  for (const id of ['alpha', 'beta']) { stub.projects.set(id, project(id)); stub.planDocsByProject.set(id, []); }
  stub.commandRuns.set('c-red', commandRun('c-red', 'alpha', { failureUnopened: true }));
  stub.commandRuns.set('c-opened', commandRun('c-opened', 'alpha'));
  stub.testRuns.set('t-red', testRun('t-red', 'alpha', { status: 'error', failureUnopened: true }));
  await useWorldStore.getState().loadProjects();
  await waitFor(() => machinesOf('alpha').length === 2 && useWorldStore.getState().planByProject.alpha);
  assert.deepEqual(machinesOf('alpha').map((m) => [m.key, m.failed]).sort(), [['command:c-red', true], ['test:t-red', true]]);
  assert.deepEqual(machinesOf('beta'), []);
  assert.equal(useWorldStore.getState().commandRunsById['c-opened'], undefined, 'opened failures are not loaded');
});

test('IW02 a live failed, unopened run adds a red machine; a later event with the flag cleared removes it', async () => {
  installServerStub();
  reset();
  useWorldStore.setState({ projects: [{ id: 'alpha', name: 'alpha', position: [0, 0], status: 'idle', activeTaskId: null, taskCount: 0, sync: null }], planByProject: { alpha: { items: [] } } });
  const live = captureLiveUpdates();
  live.onEvent({ type: 'commandRun', run: commandRun('c1', 'alpha', { status: 'running', completedAt: null }) });
  assert.deepEqual(machinesOf('alpha').map((m) => m.failed), [false]);
  live.onEvent({ type: 'commandRun', run: commandRun('c1', 'alpha', { failureUnopened: true }) });
  assert.deepEqual(machinesOf('alpha').map((m) => m.failed), [true]);
  live.onEvent({ type: 'commandRun', run: commandRun('c1', 'alpha') });
  assert.deepEqual(machinesOf('alpha'), []);
  live.onEvent({ type: 'testRun', run: testRun('t1', 'alpha', { status: 'error', failureUnopened: true }) });
  assert.deepEqual(machinesOf('alpha').map((m) => m.key), ['test:t1']);
  live.onEvent({ type: 'testRun', run: testRun('t1', 'alpha', { status: 'error' }) });
  assert.deepEqual(machinesOf('alpha'), []);
});

test('IW03 opening an unopened failed run\'s log marks it opened once; an opened run makes no call', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('alpha', project('alpha'));
  stub.commandRuns.set('c1', commandRun('c1', 'alpha', { failureUnopened: true }));
  stub.commandRuns.set('c2', commandRun('c2', 'alpha'));
  useWorldStore.setState({ commandRunsById: { c1: commandRun('c1', 'alpha', { failureUnopened: true }), c2: commandRun('c2', 'alpha') } });
  await Promise.all([useWorldStore.getState().markCommandRunOpened('c1'), useWorldStore.getState().markCommandRunOpened('c1')]);
  await useWorldStore.getState().markCommandRunOpened('c1');
  await useWorldStore.getState().markCommandRunOpened('c2');
  assert.deepEqual(stub.openedRequests, ['c1']);
  assert.equal(useWorldStore.getState().commandRunsById.c1.failureUnopened, undefined);
});

test('IW04 opening a test run\'s detail (from the footer or the village) marks it opened', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('alpha', project('alpha'));
  stub.testRuns.set('t1', testRun('t1', 'alpha', { failureUnopened: true }));
  useWorldStore.setState({ projects: [{ id: 'alpha', name: 'alpha', position: [0, 0], status: 'idle', activeTaskId: null, taskCount: 0, sync: null }], testRunsById: { t1: testRun('t1', 'alpha', { failureUnopened: true }) } });
  await useWorldStore.getState().openTestRunFromFooter('alpha', 't1');
  await waitFor(() => !useWorldStore.getState().testRunsById.t1.failureUnopened);
  assert.deepEqual(stub.openedRequests, ['t1']);
  assert.equal(useWorldStore.getState().workspaceTab, 'testing');
});

test('IW05 a mark-opened refusal is reported, the machine stays red, nothing crashes', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('alpha', project('alpha'));
  stub.commandRuns.set('c1', commandRun('c1', 'alpha', { failureUnopened: true }));
  stub.failOpened('daemon is down');
  useWorldStore.setState({ projects: [{ id: 'alpha', name: 'alpha', position: [0, 0], status: 'idle', activeTaskId: null, taskCount: 0, sync: null }], planByProject: { alpha: { items: [] } }, commandRunsById: { c1: commandRun('c1', 'alpha', { failureUnopened: true }) } });
  await assert.doesNotReject(() => useWorldStore.getState().markCommandRunOpened('c1'));
  assert.deepEqual(machinesOf('alpha').map((m) => m.failed), [true]);
  const errors = Object.values(useWorldStore.getState().errorNotificationsById);
  assert.equal(errors.length, 1);
  assert.match(errors[0].description, /daemon is down/);
});

test('IW06 a late list response never brings back a failure that was opened meanwhile', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('alpha', project('alpha'));
  stub.commandRuns.set('c1', commandRun('c1', 'alpha', { failureUnopened: true }));
  stub.testRuns.set('t1', testRun('t1', 'alpha', { failureUnopened: true }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // The list reads its rows only after the gate opens, so to force the race it answers with the rows as they were before.
  const before = { c1: { ...stub.commandRuns.get('c1') }, t1: { ...stub.testRuns.get('t1') } };
  stub.unopenedListGate.wait = async () => {
    await held;
    stub.commandRuns.set('c1', before.c1);
    stub.testRuns.set('t1', before.t1);
  };
  useWorldStore.setState({ commandRunsById: { c1: commandRun('c1', 'alpha', { failureUnopened: true }) }, testRunsById: { t1: testRun('t1', 'alpha', { failureUnopened: true }) } });
  const loading = useWorldStore.getState().loadUnopenedFailures('alpha');
  await useWorldStore.getState().markCommandRunOpened('c1');
  await useWorldStore.getState().markTestRunOpened('t1');
  release();
  await loading;
  assert.equal(useWorldStore.getState().commandRunsById.c1.failureUnopened, undefined);
  assert.equal(useWorldStore.getState().testRunsById.t1.failureUnopened, undefined);
});

test('IW07 the stub mirrors the daemon: the unopened filter, its 400, and both opened routes (404 for unknown runs)', async () => {
  const stub = installServerStub();
  stub.projects.set('alpha', project('alpha'));
  stub.commandRuns.set('c1', commandRun('c1', 'alpha', { failureUnopened: true }));
  stub.commandRuns.set('c2', commandRun('c2', 'alpha'));
  assert.deepEqual((await serverApi.listUnopenedCommandFailures('alpha')).map((r) => r.id), ['c1']);
  assert.equal((await fetch('http://stub/api/projects/alpha/command-runs?failureUnopened=yes')).status, 400);
  assert.equal((await fetch('http://stub/api/projects/alpha/test-runs?failureUnopened=1')).status, 400);
  await assert.rejects(() => serverApi.markCommandRunOpened('nope'));
  await assert.rejects(() => serverApi.markTestRunOpened('nope'));
  const source = await readFile(new URL('./serverStub.mjs', import.meta.url), 'utf8');
  assert.match(source, /\/opened\$/);
});

test('IW08 a workflowRun event with a new currentLabel updates that task\'s tooltip summary', async () => {
  installServerStub();
  reset();
  const steps = ['Planning', 'Development'].map((name, i) => ({ id: `s${i}`, name, agentId: 'a', instructions: '', canEditCode: true, requiresApproval: false }));
  const run = (currentLabel) => ({ id: 'r1', projectId: 'alpha', planItemId: 'i1', workflowId: 'wf', workflowSnapshot: { id: 'wf', name: 'wf', description: '', enabled: true, steps }, status: 'running', currentStepId: 's1', branch: 'b', baseBranch: 'main', executorId: 'e', prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0, currentStepProgress: { done: 0, total: 2, estimate: null, currentLabel }, createdAt: T, updatedAt: T, completedAt: null });
  useWorldStore.setState({
    projects: [{ id: 'alpha', name: 'alpha', position: [0, 0], status: 'idle', activeTaskId: null, taskCount: 0, sync: null }],
    planByProject: { alpha: { items: [{ id: 'i1', projectId: 'alpha', title: '1.001: Thing', description: '', status: 'developing', order: 0, taskIds: [], executorId: null, workflowRunId: 'r1', createdAt: T, updatedAt: T }] } },
    workflowRunsByProject: { alpha: [run('writing code')] },
  });
  const tooltip = () => yardModelFor('alpha', yardSlices()).work[0].tooltip.step;
  assert.equal(tooltip(), 'Development · writing code');
  captureLiveUpdates().onEvent({ type: 'workflowRun', run: run('running tests') });
  assert.equal(tooltip(), 'Development · running tests');
});

test('U114 U116 a command machine click opens Settings › Commands with that run\'s log; a run gone by then opens just the section', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('alpha', project('alpha'));
  stub.planDocsByProject.set('alpha', []);
  stub.commandRuns.set('c1', commandRun('c1', 'alpha', { failureUnopened: true }));
  useWorldStore.setState({ projects: [{ id: 'alpha', name: 'alpha', position: [0, 0], status: 'idle', activeTaskId: null, taskCount: 0, sync: null }] });
  await useWorldStore.getState().openCommandRunFromVillage('alpha', 'c1');
  let state = useWorldStore.getState();
  assert.deepEqual([state.workspaceProjectId, state.workspaceTab, state.workspaceSettingsSection, state.footerCommandLogRunId], ['alpha', 'settings', 'commands', 'c1']);
  useWorldStore.setState({ footerCommandLogRunId: null });
  await useWorldStore.getState().openCommandRunFromVillage('alpha', 'gone');
  state = useWorldStore.getState();
  assert.deepEqual([state.workspaceTab, state.workspaceSettingsSection, state.footerCommandLogRunId], ['settings', 'commands', null]);
  assert.deepEqual(Object.values(state.errorNotificationsById), [], 'a gone run is not an error');
  await useWorldStore.getState().openCommandRunFromVillage('deleted-project', 'c1');
  assert.equal(useWorldStore.getState().workspaceProjectId, 'alpha', 'a deleted Project opens nothing');
});

// ---- The pending stack: its click and its count, through the real store ----

const { openYardTarget, workspaceTotals } = await import('../src/lib/villageYard.ts');
const { pendingOnlyView } = await import('../src/lib/taskBoard.ts');
const { buildPlanningQueue } = await import('../src/lib/projectTasks.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');

const planItem = (id, patch = {}) => ({ id, projectId: 'p1', title: `1.00${id.slice(-1)}: ${id}`, description: '', status: 'pending', order: 0, taskIds: [], executorId: null, createdAt: T, updatedAt: T, ...patch });
const clickPending = (projectId = 'p1') => {
  const state = useWorldStore.getState();
  openYardTarget(projectId, { kind: 'pending' }, state, { ...state, openCommandRunFromVillage: () => undefined, openTestRunFromFooter: () => undefined });
};
function withPlan(items) {
  installServerStub();
  reset();
  useWorldStore.setState({ projects: [project('p1'), project('p2')], planByProject: { p1: { items } }, taskIdsByProject: { p1: [] }, workspaceTasksFilter: null });
}

test('K01/K03 the stack opens the Workspace on Tasks with Pending only on, even with nothing pending', () => {
  withPlan([planItem('i1')]);
  useWorldStore.setState({ workspaceTab: 'testing' });
  clickPending();
  const s = useWorldStore.getState();
  assert.deepEqual([s.workspaceProjectId, s.workspaceTab, s.workspaceTasksFilter], ['p1', 'tasks', 'pending']);
  withPlan([]);
  clickPending();
  assert.equal(useWorldStore.getState().workspaceTasksFilter, 'pending');
});

test('K02 a Project gone by the click opens nothing', () => {
  withPlan([planItem('i1')]);
  assert.doesNotThrow(() => clickPending('gone'));
  assert.deepEqual([useWorldStore.getState().workspaceProjectId, useWorldStore.getState().workspaceTasksFilter], [null, null]);
});

test('K04 the filter clears on a tab switch, on closing, on switching Project and when Tasks is opened any other way', () => {
  const open = () => { withPlan([planItem('i1')]); clickPending(); assert.equal(useWorldStore.getState().workspaceTasksFilter, 'pending'); };
  open();
  useWorldStore.getState().setWorkspaceTab('testing');
  assert.equal(useWorldStore.getState().workspaceTasksFilter, null, 'tab switch');
  open();
  useWorldStore.getState().setWorkspaceTab('tasks');
  assert.equal(useWorldStore.getState().workspaceTasksFilter, null, 'Tasks opened from its own tab');
  open();
  useWorldStore.getState().openWorkspace(null);
  assert.equal(useWorldStore.getState().workspaceTasksFilter, null, 'closed');
  open();
  useWorldStore.getState().openWorkspace('p2');
  assert.equal(useWorldStore.getState().workspaceTasksFilter, null, 'another Project');
  open();
  useWorldStore.getState().openWorkspaceCardDetail('p1', null);
  assert.equal(useWorldStore.getState().workspaceTasksFilter, null, 'Tasks opened another way');
});

test('K05 opening a card\'s detail and going Back keeps the filter (the detail is board-local state, not the store\'s)', () => {
  withPlan([planItem('i1')]);
  clickPending();
  useWorldStore.getState().setWorkspaceDetailTaskId('t1');
  useWorldStore.getState().setWorkspaceDetailTaskId(null);
  assert.equal(useWorldStore.getState().workspaceTasksFilter, 'pending');
});

test('K06 the chip ×, "Show all tasks" and the strips clear the filter through setWorkspaceTasksFilter(null)', () => {
  withPlan([planItem('i1')]);
  clickPending();
  useWorldStore.getState().setWorkspaceTasksFilter(null);
  assert.equal(useWorldStore.getState().workspaceTasksFilter, null);
});

test('I03 adding a plan item raises that Project\'s pending count and the totals\' pending', () => {
  withPlan([planItem('i1')]);
  const before = yardModelFor('p1', yardSlices()).pending.length;
  useWorldStore.setState({ planByProject: { p1: { items: [planItem('i1'), planItem('i2', { order: 1 })] } } });
  const models = useWorldStore.getState().projects.map((p) => yardModelFor(p.id, yardSlices()));
  assert.deepEqual([before, models[0].pending.length, workspaceTotals(models).pending], [1, 2, 2]);
});

test('I04 store data → the stack\'s badge count equals the Pending only view\'s card count', () => {
  withPlan([planItem('i1'), planItem('i2', { order: 1 }), planItem('i3', { order: 2, waiting: { options: {}, state: 'waiting', reasons: [], since: T, longWaitNotified: false, updatedAt: T } })]);
  clickPending();
  const s = useWorldStore.getState();
  const items = s.planByProject.p1.items;
  const groups = buildTaskGroups({ items, tasksById: s.tasksById, workflowRunsByProject: s.workflowRunsByProject, projectId: 'p1', showArchived: false, now: 0 });
  const queue = buildPlanningQueue({ items, taskIds: s.taskIdsByProject.p1 ?? [], tasksById: s.tasksById, now: 0, openRows: groups.open });
  const view = pendingOnlyView(queue, { running: 0, needsYou: 0, done: 0 });
  assert.equal(view.cards.length, yardModelFor('p1', yardSlices()).pending.length);
  assert.equal(view.cards.length, 2);
});
