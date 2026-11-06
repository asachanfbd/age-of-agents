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

const { useWorldStore } = await import('../src/store/worldStore.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { summarizeWorkspaceCounts } = await import('../src/lib/workspaceCounts.ts');
const { buildTerminalSessionGroups, countTerminalSessionRows } = await import('../src/lib/planningSessionsPopover.ts');
const { countUnreadNotifications } = await import('../src/lib/notificationCenter.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

const T = '2026-10-04T10:00:00.000Z';
const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };

const project = (id) => ({ id, name: id, slug: id, relativePath: `projects/${id}`, status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: T, updatedAt: T });
const planItem = (id, projectId, patch = {}) => ({
  id, projectId, title: id, description: '', status: 'pending', order: 0, taskIds: [], executorId: null, createdAt: T, updatedAt: T, ...patch,
});
const run = (id, projectId, status, patch = {}) => ({
  id, projectId, planItemId: id.replace('run-', ''), workflowId: 'wf', workflowSnapshot: { id: 'wf', name: 'Dev', description: '', enabled: true, steps: [] },
  status, currentStepId: null, executorId: 'exec', prUrl: null, completionReport: null, attentionReason: null,
  loopRoundAllowance: 0, createdAt: T, updatedAt: T, completedAt: null, ...patch,
});
const planningTask = (id, projectId, patch = {}) => ({
  id, projectId, executorId: 'exec', executionMode: 'terminal', description: `Plan ${id}`, status: 'stopped', kind: 'plan',
  conversationId: id, sessionId: `s-${id}`, planItemId: null, blockedQuestion: null, failureReason: null, tokenUsage: usage,
  createdAt: T, updatedAt: T, completedAt: null, ...patch,
});

function reset() {
  useWorldStore.setState({
    projects: [], tasksById: {}, taskIdsByProject: {}, lastTaskIdByProject: {}, reviewedTaskIds: {}, transcriptsByTask: {}, planByProject: {},
    planLiveChangesByProject: {}, planLiveRevisionByProject: {}, taskLiveChangesByProject: {}, taskLiveRevisionByProject: {},
    workspaceProjectId: null, workspaceTab: 'tasks', workspaceDetailTaskId: null, workspaceSettingsSection: 'workflow',
    catalogOpen: false, notificationCenterOpen: false, workflowRunsByProject: {}, workflowRunDetails: {},
    notificationsById: {}, notificationsLoaded: false, ...CLEAN_ERROR_STATE, loaded: false,
  });
}

const counts = () => summarizeWorkspaceCounts(useWorldStore.getState());

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition never held');
}

/**
 * Three projects, none ever opened:
 * - alpha: one running card, one pending card, one open planning session;
 * - beta: one card awaiting approval, two pending cards;
 * - gamma: one completing card, one finished planning session (not counted).
 */
function seedThreeProjects(stub) {
  for (const id of ['alpha', 'beta', 'gamma']) {
    stub.projects.set(id, project(id));
    stub.planDocsByProject.set(id, []);
  }
  stub.planItems.set('a-run', planItem('a-run', 'alpha', { status: 'developing', workflowRunId: 'run-a-run' }));
  stub.planItems.set('a-todo', planItem('a-todo', 'alpha'));
  stub.planItems.set('b-wait', planItem('b-wait', 'beta', { status: 'developing', workflowRunId: 'run-b-wait' }));
  stub.planItems.set('b-todo-1', planItem('b-todo-1', 'beta'));
  stub.planItems.set('b-todo-2', planItem('b-todo-2', 'beta'));
  stub.planItems.set('g-run', planItem('g-run', 'gamma', { status: 'developing', workflowRunId: 'run-g-run' }));
  stub.workflowRuns.set('run-a-run', run('run-a-run', 'alpha', 'running'));
  stub.workflowRuns.set('run-b-wait', run('run-b-wait', 'beta', 'awaiting-approval'));
  stub.workflowRuns.set('run-g-run', run('run-g-run', 'gamma', 'completing'));
  stub.tasksById.set('plan-alpha', planningTask('plan-alpha', 'alpha'));
  stub.tasksById.set('plan-gamma', planningTask('plan-gamma', 'gamma', { planningCompletedAt: T }));
}

const EXPECTED_ON_LOAD = { tasks: { active: 2, blocked: 1, pending: 3 } };
const loadedEverywhere = () => {
  const state = useWorldStore.getState();
  return ['alpha', 'beta', 'gamma'].every((id) => state.planByProject[id] && state.taskIdsByProject[id] && state.workflowRunsByProject[id]);
};

/** Captures the live-update callbacks `connectLiveUpdates` registers, without a real WebSocket. */
function captureLiveUpdates() {
  const original = serverApi.connectLiveUpdates;
  const captured = {};
  serverApi.connectLiveUpdates = (onEvent, onReconnect) => { captured.onEvent = onEvent; captured.onReconnect = onReconnect; return () => {}; };
  useWorldStore.getState().connectLiveUpdates();
  serverApi.connectLiveUpdates = original;
  return captured;
}

test('loadProjects fetches every project\'s plan, tasks and runs, so the totals are right on load without opening any', async () => {
  const stub = installServerStub();
  reset();
  seedThreeProjects(stub);

  await useWorldStore.getState().loadProjects();
  await waitFor(loadedEverywhere);

  assert.equal(useWorldStore.getState().workspaceProjectId, null, 'no workspace was opened');
  assert.deepEqual(counts(), EXPECTED_ON_LOAD);
});

test('one project failing to load its tasks and runs leaves the others\' counts right and records the error', async () => {
  const stub = installServerStub();
  reset();
  seedThreeProjects(stub);
  const stubFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\/api\/projects\/beta\/(tasks|workflow-runs)$/.test(String(url))) return new Response(JSON.stringify({ error: 'beta is unreachable' }), { status: 500 });
    return stubFetch(url, init);
  };
  try {
    await useWorldStore.getState().loadProjects();
    await waitFor(() => {
      const state = useWorldStore.getState();
      return ['alpha', 'gamma'].every((id) => state.taskIdsByProject[id] && state.workflowRunsByProject[id]) && state.planByProject.beta;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    globalThis.fetch = stubFetch;
  }

  // beta can't be classified without its runs, so it contributes nothing; alpha and gamma are exact.
  assert.deepEqual(counts(), { tasks: { active: 2, blocked: 0, pending: 1 } });
  assert.equal(useWorldStore.getState().taskIdsByProject.beta, undefined);
});

test('live events update the totals with no refetch, including for projects that are not open', async () => {
  const stub = installServerStub();
  reset();
  seedThreeProjects(stub);
  await useWorldStore.getState().loadProjects();
  await waitFor(loadedEverywhere);
  const live = captureLiveUpdates();
  const stubFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (...args) => { fetches += 1; return stubFetch(...args); };

  try {
    // alpha's running card now waits for approval: active −1, blocked +1.
    live.onEvent({ type: 'workflowRun', run: run('run-a-run', 'alpha', 'awaiting-approval') });
    assert.deepEqual(counts().tasks, { active: 1, blocked: 2, pending: 3 });

    // beta's approval finishes the run: blocked −1.
    live.onEvent({ type: 'workflowRun', run: run('run-b-wait', 'beta', 'completed', { completedAt: T }) });
    assert.deepEqual(counts().tasks, { active: 1, blocked: 1, pending: 3 });

    // A new pending card on gamma, then one of beta's removed.
    live.onEvent({ type: 'planItem', planItem: planItem('g-new', 'gamma') });
    assert.equal(counts().tasks.pending, 4);
    live.onEvent({ type: 'planItemDeleted', projectId: 'beta', id: 'b-todo-1' });
    assert.equal(counts().tasks.pending, 3);
  } finally {
    globalThis.fetch = stubFetch;
  }
  assert.equal(fetches, 0, 'counts follow the events alone');
  assert.equal(useWorldStore.getState().workspaceProjectId, null);
});

test('reconnecting reloads tasks and runs for every project, recovering changes missed while disconnected', async () => {
  const stub = installServerStub();
  reset();
  seedThreeProjects(stub);
  await useWorldStore.getState().loadProjects();
  await waitFor(loadedEverywhere);
  const live = captureLiveUpdates();

  // Missed while disconnected, on a project that isn't open: beta's run fails.
  stub.workflowRuns.set('run-b-wait', run('run-b-wait', 'beta', 'running', { updatedAt: '2026-10-04T11:00:00.000Z' }));
  live.onReconnect();
  await waitFor(() => counts().tasks.active === 3);

  assert.deepEqual(counts(), { tasks: { active: 3, blocked: 0, pending: 3 } });
});

test('adding a project raises the project total and keeps the task totals consistent', async () => {
  const stub = installServerStub();
  reset();
  seedThreeProjects(stub);
  await useWorldStore.getState().loadProjects();
  await waitFor(loadedEverywhere);

  await useWorldStore.getState().addProject('delta');

  assert.equal(useWorldStore.getState().projects.length, 4);
  assert.deepEqual(counts(), EXPECTED_ON_LOAD, 'a new, still-loading project adds nothing');
});

const WORKSPACE_STATE = { workspaceProjectId: 'alpha', workspaceTab: 'testing', workspaceDetailTaskId: 'task-9', workspaceSettingsSection: 'commands' };
const workspaceState = () => {
  const { workspaceProjectId, workspaceTab, workspaceDetailTaskId, workspaceSettingsSection } = useWorldStore.getState();
  return { workspaceProjectId, workspaceTab, workspaceDetailTaskId, workspaceSettingsSection };
};

test('the bell opens the Notifications drawer over an open Project Workspace and closing it returns to it unchanged', () => {
  reset();
  useWorldStore.setState(WORKSPACE_STATE);

  useWorldStore.getState().toggleNotificationCenter();
  assert.equal(useWorldStore.getState().notificationCenterOpen, true);
  assert.deepEqual(workspaceState(), WORKSPACE_STATE);

  useWorldStore.getState().closeNotificationCenter();
  assert.equal(useWorldStore.getState().notificationCenterOpen, false);
  assert.deepEqual(workspaceState(), WORKSPACE_STATE);
});

test('the bell opens the drawer over the Catalog and leaves it open', () => {
  reset();
  useWorldStore.setState({ catalogOpen: true });

  useWorldStore.getState().toggleNotificationCenter();
  assert.equal(useWorldStore.getState().catalogOpen, true);
  useWorldStore.getState().closeNotificationCenter();
  assert.equal(useWorldStore.getState().catalogOpen, true);
});

test('the bell toggles the drawer the same way with no popup open', () => {
  reset();
  useWorldStore.getState().toggleNotificationCenter();
  assert.equal(useWorldStore.getState().notificationCenterOpen, true);
  useWorldStore.getState().toggleNotificationCenter();
  assert.equal(useWorldStore.getState().notificationCenterOpen, false, 'a second click closes it rather than reopening it');
});

test('the bell badge counts unread notifications and follows live notification events', async () => {
  const stub = installServerStub();
  reset();
  stub.raiseNotification({ kind: 'project.attention', subject: { type: 'project', projectId: 'alpha' }, title: 'One', description: '' });
  await useWorldStore.getState().loadNotifications();
  const live = captureLiveUpdates();
  assert.equal(countUnreadNotifications(useWorldStore.getState().notificationsById), 1);

  const second = stub.raiseNotification({ kind: 'project.attention', subject: { type: 'project', projectId: 'beta' }, title: 'Two', description: '' });
  live.onEvent({ type: 'notification', notification: second });
  assert.equal(countUnreadNotifications(useWorldStore.getState().notificationsById), 2);
});

// ---- Opening a planning session from the footer's popover ----

const openedState = () => {
  const { workspaceProjectId, workspaceTab, workspaceDetailTaskId, catalogOpen, notificationCenterOpen } = useWorldStore.getState();
  return { workspaceProjectId, workspaceTab, workspaceDetailTaskId, catalogOpen, notificationCenterOpen };
};
const OPENED_ALPHA = { workspaceProjectId: 'alpha', workspaceTab: 'tasks', workspaceDetailTaskId: 'plan-alpha', catalogOpen: false, notificationCenterOpen: false };

/** The stub seeded and every project loaded, then the popup state set as the test needs. */
async function loadedWith(state = {}) {
  const stub = installServerStub();
  reset();
  seedThreeProjects(stub);
  await useWorldStore.getState().loadProjects();
  await waitFor(loadedEverywhere);
  useWorldStore.setState(state);
  return stub;
}

test('I1 opening a session lands on its project\'s Tasks tab with the session\'s details, reloading its board', async () => {
  await loadedWith();
  const stubFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init) => { fetched.push(String(url)); return stubFetch(url, init); };
  try {
    useWorldStore.getState().openPlanningSession('alpha', 'plan-alpha');
  } finally {
    globalThis.fetch = stubFetch;
  }
  assert.deepEqual(openedState(), OPENED_ALPHA);
  assert.ok(fetched.some((url) => /\/api\/projects\/alpha\/tasks$/.test(url)), 'tasks reloaded');
  assert.ok(fetched.some((url) => /\/api\/projects\/alpha\/plan/.test(url)), 'plan reloaded');
});

test('I2 it replaces another project\'s open popup', async () => {
  await loadedWith({ workspaceProjectId: 'beta', workspaceTab: 'settings' });
  useWorldStore.getState().openPlanningSession('alpha', 'plan-alpha');
  assert.deepEqual(openedState(), OPENED_ALPHA);
});

test('I3 with the same project open on another tab or detail, it switches to this session', async () => {
  await loadedWith({ workspaceProjectId: 'alpha', workspaceTab: 'testing', workspaceDetailTaskId: 'task-9' });
  useWorldStore.getState().openPlanningSession('alpha', 'plan-alpha');
  assert.deepEqual(openedState(), OPENED_ALPHA);
});

test('I4 it closes the Catalog', async () => {
  await loadedWith({ catalogOpen: true });
  useWorldStore.getState().openPlanningSession('alpha', 'plan-alpha');
  assert.deepEqual(openedState(), OPENED_ALPHA);
});

test('I5 it closes the Notifications drawer so the session is visible', async () => {
  await loadedWith({ notificationCenterOpen: true, workspaceProjectId: 'beta' });
  useWorldStore.getState().openPlanningSession('alpha', 'plan-alpha');
  assert.deepEqual(openedState(), OPENED_ALPHA);
});

test('I6 a session deleted just before the click opens the Tasks board without details, and no error', async () => {
  await loadedWith({ notificationCenterOpen: true });
  assert.doesNotThrow(() => useWorldStore.getState().openPlanningSession('alpha', 'plan-gone'));
  assert.deepEqual(openedState(), { ...OPENED_ALPHA, workspaceDetailTaskId: null });
});

test('I7 a session completed or archived just before the click still shows its details', async () => {
  await loadedWith();
  const live = captureLiveUpdates();
  live.onEvent({ type: 'task', task: planningTask('plan-alpha', 'alpha', { planningCompletedAt: T, archived: true }) });
  useWorldStore.getState().openPlanningSession('alpha', 'plan-alpha');
  assert.deepEqual(openedState(), OPENED_ALPHA);
});

test('I8 the popover\'s rows follow live terminalSessions snapshots with no refetch, always matching the footer number', async () => {
  await loadedWith();
  const live = captureLiveUpdates();
  const stubFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (...args) => { fetches += 1; return stubFetch(...args); };
  const session = (id, kind, projectId) => ({ id, kind, projectId, title: id });
  const groups = () => buildTerminalSessionGroups(useWorldStore.getState().projects, useWorldStore.getState().liveTerminalSessions);
  const rows = () => groups().map((g) => [g.projectId, g.sessions.map((s) => s.id)]);
  const footerCount = () => useWorldStore.getState().liveTerminalSessions.length;
  try {
    live.onEvent({ type: 'terminalSessions', sessions: [session('agent-1', 'agent', 'alpha'), session('plan-beta', 'planning', 'beta')] });
    assert.deepEqual(rows(), [['alpha', ['agent-1']], ['beta', ['plan-beta']]]);
    assert.equal(countTerminalSessionRows(groups()), footerCount());
    live.onEvent({ type: 'terminalSessions', sessions: [session('plan-beta', 'planning', 'beta')] });
    assert.deepEqual(rows(), [['beta', ['plan-beta']]], 'a snapshot without a session removes its row');
    live.onEvent({ type: 'terminalSessions', sessions: [] });
    assert.deepEqual(rows(), []);
    assert.equal(footerCount(), 0);
  } finally {
    globalThis.fetch = stubFetch;
  }
  assert.equal(fetches, 0);
  assert.deepEqual(counts().tasks, EXPECTED_ON_LOAD.tasks, 'the task counts are untouched');
});
