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

const {
  useWorldStore, mergeWorkerEvent, isUsageLimitLogEvent, isSkillInstallSuccessEvent, findRunningRun,
  openNotificationsForProject, highestOpenSeverity, reorderLocally,
} = await import('../src/store/worldStore.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { bugReportLinkedItems, relatedLinks } = await import('../src/lib/bugs.ts');
const { bugReportHistory } = await import('../src/lib/projectTasks.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { reportedError, CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

function reset() {
  useWorldStore.setState({
    projects: [], tasksById: {}, lastTaskIdByProject: {}, reviewedTaskIds: {}, transcriptsByTask: {}, planByProject: {},
    planLiveChangesByProject: {}, planLiveRevisionByProject: {},
    taskLiveChangesByProject: {}, taskLiveRevisionByProject: {},
    workspaceProjectId: null, workspaceTab: 'tasks', workspaceDetailTaskId: null, workspaceSettingsSection: 'workflow',
    executors: [], selectedId: null, loaded: false, ...CLEAN_ERROR_STATE,
    commandsByProject: {}, commandRunsById: {}, commandRunIdsByProject: {},
    catalogAgents: [], catalogSkills: [], catalogWorkflows: [], workflowRunsByProject: {}, workflowRunDetails: {},
    catalogInstallRuns: {}, notificationsById: {}, notificationsLoaded: false,
  });
}

test('addProject sends the given name and adds the server-returned project locally', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().addProject('My New App');

  const [project] = useWorldStore.getState().projects;
  assert.equal(project.name, 'My New App');
  assert.equal(project.status, 'idle');
  assert.equal(project.taskCount, 0);
  assert.equal(useWorldStore.getState().selectedId, project.id);
  assert.equal(reportedError(), null);
  assert.deepEqual(useWorldStore.getState().planByProject[project.id], { items: [] }, 'a new project starts with an empty plan so its label bar can track live items');
});

test('addProject reports the error and adds nothing when the server call fails', async () => {
  reset();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'daemon unreachable' }), { status: 500 });

  await useWorldStore.getState().addProject('Doomed');

  assert.equal(useWorldStore.getState().projects.length, 0);
  assert.match(reportedError() ?? '', /daemon unreachable/);
});

test('loadProjects populates the store from the server, assigning plots to projects with no stored position', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('p1', {
    id: 'p1', name: 'Existing', slug: 'p1', relativePath: 'projects/p1', status: 'idle',
    position: null, activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '',
  });

  await useWorldStore.getState().loadProjects();

  const [project] = useWorldStore.getState().projects;
  assert.equal(project.id, 'p1');
  assert.ok(Array.isArray(project.position));
  assert.equal(useWorldStore.getState().loaded, true);
});

test('loadProjects also fetches every project\'s plan so building labels can show task progress', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('p1', {
    id: 'p1', name: 'Existing', slug: 'p1', relativePath: 'projects/p1', status: 'idle',
    position: [0, 0], activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '',
  });
  stub.planDocsByProject.set('p1', []);
  stub.planItems.set('i1', {
    id: 'i1', projectId: 'p1', title: 'Ship it', description: '', status: 'done', order: 0,
    taskIds: [], executorId: null, createdAt: '', updatedAt: '',
  });

  await useWorldStore.getState().loadProjects();
  await new Promise((resolve) => setImmediate(resolve));

  const items = useWorldStore.getState().planByProject.p1?.items ?? [];
  assert.deepEqual(items.map((item) => [item.id, item.status]), [['i1', 'done']]);
});

test('startTask records the task and flips the project to developing', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().addProject('Task Project');
  const [project] = useWorldStore.getState().projects;

  await useWorldStore.getState().startTask(project.id, 'Build the login page');

  const updated = useWorldStore.getState().projects.find((p) => p.id === project.id);
  assert.equal(updated.status, 'developing');
  assert.equal(updated.taskCount, 1);
  assert.ok(updated.activeTaskId);
  const task = useWorldStore.getState().tasksById[updated.activeTaskId];
  assert.equal(task.description, 'Build the login page');
  assert.equal(task.status, 'developing');
});

/** Delivers the given WorkerEvents for every response to a URL containing `urlPart`, before that response resolves — the live WS feed isn't ordered against an action's own fetch(). */
function deliverEventsBeforeResponse(urlPart, eventsFor) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const res = await originalFetch(...args);
    if (typeof args[0] === 'string' && args[0].includes(urlPart)) {
      const body = await res.clone().json();
      for (const event of eventsFor(body)) useWorldStore.setState((state) => mergeWorkerEvent(state, event));
    }
    return res;
  };
}

test('startTask keeps a newer settled state the WS feed delivered before its own response (no stale "developing" flip)', async () => {
  installServerStub();
  reset();
  const project = await createTestProject('Fast Fail');
  deliverEventsBeforeResponse('/tasks', (task) => [
    { type: 'task', task: { ...task, status: 'failed', updatedAt: new Date(Date.parse(task.updatedAt) + 1000).toISOString() } },
    { type: 'project', project: { ...project, status: 'idle', activeTaskId: null, taskCount: 1 } },
  ]);

  await useWorldStore.getState().startTask(project.id, 'Crashes instantly');

  const updated = useWorldStore.getState().projects.find((p) => p.id === project.id);
  assert.equal(updated.status, 'idle', 'the stale HTTP response must not flip the project back to developing');
  assert.equal(updated.taskCount, 1, 'the WS project event already counted it');
  const [task] = Object.values(useWorldStore.getState().tasksById);
  assert.equal(task.status, 'failed');
});

test('syncProjectBranch (the sync icon\'s click action) starts a real CommandRun, merges it in, and returns it for the caller to open the log popup on', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().addProject('Sync Project');
  const [project] = useWorldStore.getState().projects;

  const run = await useWorldStore.getState().syncProjectBranch(project.id);

  assert.equal(run.projectId, project.id);
  assert.equal(run.status, 'running');
  assert.match(run.commandText, /git fetch/);
  assert.deepEqual(useWorldStore.getState().commandRunsById[run.id], run);
  assert.equal(reportedError(), null);
});

test('syncProjectBranch reports the error and returns undefined (no run to open) when the server refuses', async () => {
  const stub = installServerStub();
  reset();
  await useWorldStore.getState().addProject('Busy Sync Project');
  const [project] = useWorldStore.getState().projects;
  stub.projects.get(project.id).activeTaskId = 'some-active-task';

  const run = await useWorldStore.getState().syncProjectBranch(project.id);

  assert.equal(run, undefined);
  assert.equal(Object.keys(useWorldStore.getState().commandRunsById).length, 0);
  assert.match(reportedError() ?? '', /active task/);
});

test('mergeWorkerEvent updates a known project in place without duplicating it', () => {
  const state = {
    projects: [{ id: 'p1', name: 'A', position: [1, 2], status: 'developing', activeTaskId: 't1', taskCount: 1 }],
    tasksById: {},
    lastTaskIdByProject: {},
  };
  const serverProject = {
    id: 'p1', name: 'A', slug: 'a', relativePath: 'projects/a', status: 'blocked',
    position: null, activeTaskId: 't1', taskCount: 1, createdAt: '', updatedAt: '',
  };

  const patch = mergeWorkerEvent(state, { type: 'project', project: serverProject });

  assert.equal(patch.projects.length, 1);
  assert.equal(patch.projects[0].status, 'blocked');
  assert.deepEqual(patch.projects[0].position, [1, 2], 'keeps the locally-known position when the event carries none');
});

test('mergeWorkerEvent appends an unknown project rather than dropping it', () => {
  const state = { projects: [], tasksById: {}, lastTaskIdByProject: {}, planByProject: {} };
  const serverProject = {
    id: 'p2', name: 'B', slug: 'b', relativePath: 'projects/b', status: 'idle',
    position: [3, 4], activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '',
  };

  const patch = mergeWorkerEvent(state, { type: 'project', project: serverProject });

  assert.equal(patch.projects.length, 1);
  assert.deepEqual(patch.projects[0].position, [3, 4]);
  assert.deepEqual(patch.planByProject.p2, { items: [] }, 'seeds an empty plan so live planItem events land on it');
});

test('mergeWorkerEvent keeps an already-loaded plan when a project event arrives for a project not yet listed', () => {
  const plan = { items: [{ id: 'i1', status: 'pending' }] };
  const state = { projects: [], tasksById: {}, lastTaskIdByProject: {}, planByProject: { p2: plan } };
  const serverProject = {
    id: 'p2', name: 'B', slug: 'b', relativePath: 'projects/b', status: 'idle',
    position: [3, 4], activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '',
  };

  const patch = mergeWorkerEvent(state, { type: 'project', project: serverProject });

  assert.equal(patch.planByProject.p2, plan);
});

test('mergeWorkerEvent "project" preserves a previously-known sync reading when the event carries none', () => {
  const sync = { projectId: 'p1', branch: 'main', status: 'behind', aheadBy: 0, behindBy: 2, checkedAt: 't' };
  const state = {
    projects: [{ id: 'p1', name: 'A', position: [1, 2], status: 'developing', activeTaskId: 't1', taskCount: 1, sync }],
    tasksById: {},
    lastTaskIdByProject: {},
  };
  // A plain workerManager-originated 'project' event, as sent for every ordinary status change —
  // never carries `sync` (only REST responses and 'projectSync' events do).
  const serverProject = {
    id: 'p1', name: 'A', slug: 'a', relativePath: 'projects/a', status: 'idle',
    position: null, activeTaskId: null, taskCount: 1, createdAt: '', updatedAt: '',
  };

  const patch = mergeWorkerEvent(state, { type: 'project', project: serverProject });

  assert.deepEqual(patch.projects[0].sync, sync, 'an ordinary status change must not blank out the last-known sync reading');
});

test('mergeWorkerEvent "project" adopts an explicit sync value (including null) when the event does carry one', () => {
  const previousSync = { projectId: 'p1', branch: 'main', status: 'behind', aheadBy: 0, behindBy: 2, checkedAt: 't' };
  const state = {
    projects: [{ id: 'p1', name: 'A', position: [1, 2], status: 'idle', activeTaskId: null, taskCount: 1, sync: previousSync }],
    tasksById: {},
    lastTaskIdByProject: {},
  };
  const serverProject = {
    id: 'p1', name: 'A', slug: 'a', relativePath: 'projects/a', status: 'idle',
    position: null, activeTaskId: null, taskCount: 1, createdAt: '', updatedAt: '', sync: null,
  };

  const patch = mergeWorkerEvent(state, { type: 'project', project: serverProject });

  assert.equal(patch.projects[0].sync, null);
});

test('mergeWorkerEvent "projectSync" updates the matching project\'s sync reading and leaves others untouched', () => {
  const state = {
    projects: [
      { id: 'p1', name: 'A', position: [1, 2], status: 'idle', activeTaskId: null, taskCount: 0, sync: null },
      { id: 'p2', name: 'B', position: [3, 4], status: 'idle', activeTaskId: null, taskCount: 0, sync: null },
    ],
    tasksById: {},
    lastTaskIdByProject: {},
  };
  const sync = { projectId: 'p1', branch: 'main', status: 'diverged', aheadBy: 1, behindBy: 2, checkedAt: 't' };

  const patch = mergeWorkerEvent(state, { type: 'projectSync', sync });

  assert.deepEqual(patch.projects.find((p) => p.id === 'p1').sync, sync);
  assert.equal(patch.projects.find((p) => p.id === 'p2').sync, null);
});

test('mergeWorkerEvent "projectSync" for an unknown project id changes nothing', () => {
  const state = {
    projects: [{ id: 'p1', name: 'A', position: [1, 2], status: 'idle', activeTaskId: null, taskCount: 0, sync: null }],
    tasksById: {},
    lastTaskIdByProject: {},
  };
  const sync = { projectId: 'no-such-project', branch: 'main', status: 'synced', aheadBy: 0, behindBy: 0, checkedAt: 't' };

  const patch = mergeWorkerEvent(state, { type: 'projectSync', sync });

  assert.equal(patch.projects[0].sync, null);
});

test('mergeWorkerEvent records a task update keyed by its id, and tracks it as the project\'s last task', () => {
  const state = { projects: [], tasksById: {}, taskIdsByProject: {}, lastTaskIdByProject: {} };
  const serverTask = {
    id: 't1', projectId: 'p1', templateId: 'builder', executorId: 'test-claude', description: 'do it', status: 'blocked',
    autonomy: 'auto', sessionId: 's1', blockedQuestion: 'Which one?', failureReason: null,
    createdAt: '', updatedAt: '', completedAt: null,
  };

  const patch = mergeWorkerEvent(state, { type: 'task', task: serverTask });

  assert.equal(patch.tasksById.t1.blockedQuestion, 'Which one?');
  assert.equal(patch.lastTaskIdByProject.p1, 't1');
});

test('another client sees a newly created planning session and follow-up without reloading', () => {
  const state = { projects: [], tasksById: {}, taskIdsByProject: { p1: [] }, lastTaskIdByProject: {} };
  const planning = {
    id: 'plan-1', projectId: 'p1', templateId: 'builder', executorId: 'test-claude', kind: 'plan',
    planningSessionNumber: 1, description: 'Plan work', status: 'developing', autonomy: 'auto', sessionId: 's1',
    blockedQuestion: null, failureReason: null, createdAt: '', updatedAt: '', completedAt: null,
  };
  const first = { ...state, ...mergeWorkerEvent(state, { type: 'task', task: planning }) };
  const repeated = { ...first, ...mergeWorkerEvent(first, { type: 'task', task: planning }) };
  const followUp = { ...planning, id: 'plan-2', status: 'stopped' };
  const next = { ...repeated, ...mergeWorkerEvent(repeated, { type: 'task', task: followUp }) };
  assert.deepEqual(next.taskIdsByProject.p1, ['plan-2', 'plan-1']);
  assert.equal(next.tasksById['plan-2'].kind, 'plan');
});

test('a failed task stays visible via lastTaskIdByProject even after the project WS event reverts it to idle', () => {
  reset();
  const failedTask = {
    id: 't1', projectId: 'p1', templateId: 'builder', executorId: 'test-claude', description: 'do it', status: 'failed',
    autonomy: 'auto', sessionId: 's1', blockedQuestion: null, failureReason: 'OAuth session expired',
    createdAt: '', updatedAt: '', completedAt: null,
  };
  const idleProject = {
    id: 'p1', name: 'A', slug: 'a', relativePath: 'projects/a', status: 'idle',
    position: [0, 0], activeTaskId: null, taskCount: 1, createdAt: '', updatedAt: '',
  };

  // Order matches the daemon's own emit order in settleFailed (project, then task) — see
  // server/src/worker/workerManager.ts — but the merge must work regardless of arrival order.
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'project', project: idleProject }));
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'task', task: failedTask }));

  const state = useWorldStore.getState();
  const project = state.projects.find((p) => p.id === 'p1');
  assert.equal(project.status, 'idle');
  const lastTask = state.tasksById[state.lastTaskIdByProject.p1];
  assert.equal(lastTask.status, 'failed');
  assert.equal(lastTask.failureReason, 'OAuth session expired');
});

test('mergeWorkerEvent appends a "log" turn to that task\'s transcript, creating it on first arrival', () => {
  const turn1 = { role: 'prompt', content: 'Build the thing', at: 't1' };
  const turn2 = { role: 'result', content: 'Done', at: 't2' };

  const state0 = { projects: [], tasksById: {}, lastTaskIdByProject: {}, transcriptsByTask: {} };
  const patch1 = mergeWorkerEvent(state0, { type: 'log', taskId: 'task-1', turn: turn1 });
  assert.deepEqual(patch1.transcriptsByTask, { 'task-1': [turn1] });

  const state1 = { ...state0, transcriptsByTask: patch1.transcriptsByTask };
  const patch2 = mergeWorkerEvent(state1, { type: 'log', taskId: 'task-1', turn: turn2 });
  assert.deepEqual(patch2.transcriptsByTask, { 'task-1': [turn1, turn2] });
});

function makeTaskSubject(overrides = {}) {
  return { type: 'task', projectId: 'p1', conversationId: 'conv-1', taskId: 'task-1', ...overrides };
}

function makeNotification(overrides = {}) {
  return {
    id: 'notif-1', kind: 'task.failed', severity: 'warning', subject: makeTaskSubject(), projectId: 'p1',
    title: 'Task failed: do the thing', description: 'Needs input',
    readAt: null, resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('mergeWorkerEvent "notification" adds a new Notification and updates a known one in place', () => {
  const state = { notificationsById: {} };
  const notification = makeNotification();

  const patch1 = mergeWorkerEvent(state, { type: 'notification', notification });
  assert.deepEqual(patch1.notificationsById, { 'notif-1': notification });

  const resolved = { ...notification, resolvedAt: '2026-01-02T00:00:00.000Z' };
  const patch2 = mergeWorkerEvent({ notificationsById: patch1.notificationsById }, { type: 'notification', notification: resolved });
  assert.equal(patch2.notificationsById['notif-1'].resolvedAt, '2026-01-02T00:00:00.000Z');
});

test('openNotificationsForProject scopes by project id and unread-AND-unresolved only', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', projectId: 'p1', readAt: null, resolvedAt: null }),
    b: makeNotification({ id: 'b', projectId: 'p1', readAt: null, resolvedAt: '2026-01-01T00:00:00.000Z' }),
    c: makeNotification({ id: 'c', projectId: 'p2', readAt: null, resolvedAt: null }),
    d: makeNotification({ id: 'd', projectId: null, readAt: null, resolvedAt: null, subject: { type: 'skill', repo: 'x/y' } }),
    e: makeNotification({ id: 'e', projectId: 'p1', readAt: '2026-01-01T00:00:00.000Z', resolvedAt: null }),
  };
  assert.deepEqual(openNotificationsForProject(notificationsById, 'p1').map((n) => n.id), ['a']);
  assert.deepEqual(openNotificationsForProject(notificationsById, null).map((n) => n.id), ['d']);
});

test('highestOpenSeverity returns the most urgent unread-and-unresolved severity for a project, or null when it has none', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', projectId: 'p1', severity: 'info', readAt: null, resolvedAt: null }),
    b: makeNotification({ id: 'b', projectId: 'p1', severity: 'critical', readAt: null, resolvedAt: null }),
    c: makeNotification({ id: 'c', projectId: 'p1', severity: 'warning', readAt: null, resolvedAt: '2026-01-01T00:00:00.000Z' }),
  };
  assert.equal(highestOpenSeverity(notificationsById, 'p1'), 'critical');
  assert.equal(highestOpenSeverity(notificationsById, 'p3'), null);
});

test('loadNotifications populates notificationsById from the server', async () => {
  const stub = installServerStub();
  reset();
  stub.raiseNotification({ kind: 'task.failed', subject: makeTaskSubject(), title: 'Task failed: x', description: 'y' });

  await useWorldStore.getState().loadNotifications();

  const [notification] = Object.values(useWorldStore.getState().notificationsById);
  assert.equal(notification.title, 'Task failed: x');
  assert.equal(useWorldStore.getState().notificationsLoaded, true);
});

test('markNotificationsRead marks exactly the given ids read locally, and auto-resolves an unresolved task.completed', async () => {
  const stub = installServerStub();
  reset();
  const a = stub.raiseNotification({ kind: 'task.failed', subject: makeTaskSubject({ conversationId: 'a' }), title: 't', description: 'd' });
  const b = stub.raiseNotification({ kind: 'task.completed', subject: makeTaskSubject({ conversationId: 'b' }), title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().markNotificationsRead([a.id, b.id]);

  assert.ok(useWorldStore.getState().notificationsById[a.id].readAt);
  assert.equal(useWorldStore.getState().notificationsById[a.id].resolvedAt, null);
  assert.ok(useWorldStore.getState().notificationsById[b.id].readAt);
  assert.ok(useWorldStore.getState().notificationsById[b.id].resolvedAt, 'reading a task.completed resolves it');
});

test('markNotificationsRead is a no-op for an empty array', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().markNotificationsRead([]);
  assert.equal(reportedError(), null);
});

test('markSubjectRead only calls the server when the store holds a matching unread notification', async () => {
  const stub = installServerStub();
  reset();
  const subject = makeTaskSubject({ conversationId: 'conv-subj' });
  const n = stub.raiseNotification({ kind: 'task.needs_input', subject, title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().markSubjectRead({ type: 'task', projectId: 'p1', conversationId: 'conv-nonexistent', taskId: 'x' });
  assert.equal(useWorldStore.getState().notificationsById[n.id].readAt, null, 'no match — untouched');

  await useWorldStore.getState().markSubjectRead(subject);
  assert.ok(useWorldStore.getState().notificationsById[n.id].readAt);
});

test('markNotificationUnread sets readAt back to null', async () => {
  const stub = installServerStub();
  reset();
  const n = stub.raiseNotification({ kind: 'task.failed', subject: makeTaskSubject(), title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();
  await useWorldStore.getState().markNotificationsRead([n.id]);
  assert.ok(useWorldStore.getState().notificationsById[n.id].readAt);

  await useWorldStore.getState().markNotificationUnread(n.id);

  assert.equal(useWorldStore.getState().notificationsById[n.id].readAt, null);
});

test('markAllNotificationsRead marks read only what matches the given filter', async () => {
  const stub = installServerStub();
  reset();
  const critical = stub.raiseNotification({ kind: 'task.failed', subject: makeTaskSubject({ conversationId: 'crit' }), title: 't', description: 'd' });
  const info = stub.raiseNotification({ kind: 'task.completed', subject: makeTaskSubject({ conversationId: 'info' }), title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().markAllNotificationsRead({ severity: 'critical' });

  assert.ok(useWorldStore.getState().notificationsById[critical.id].readAt);
  assert.equal(useWorldStore.getState().notificationsById[info.id].readAt, null);
});

test('markProjectCommandFailuresRead marks only that project\'s unread command.failed notifications, and is a no-op when none are unread', async () => {
  const stub = installServerStub();
  reset();
  const ownFailure = stub.raiseNotification({ kind: 'command.failed', subject: { type: 'command', projectId: 'p1', commandId: 'c1', runId: 'r1' }, title: 't', description: 'd' });
  const otherProjectFailure = stub.raiseNotification({ kind: 'command.failed', subject: { type: 'command', projectId: 'p2', commandId: 'c2', runId: 'r2' }, title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().markProjectCommandFailuresRead('p1');

  assert.ok(useWorldStore.getState().notificationsById[ownFailure.id].readAt);
  assert.equal(useWorldStore.getState().notificationsById[otherProjectFailure.id].readAt, null);

  await useWorldStore.getState().markProjectCommandFailuresRead('p1'); // already read — no-op, must not throw
});

test('openNotificationTarget for a task subject opens the workspace on the Tasks tab with the detail set, and marks it read', async () => {
  const stub = installServerStub();
  reset();
  const n = stub.raiseNotification({ kind: 'task.needs_input', subject: makeTaskSubject({ projectId: 'p1', taskId: 'task-9' }), title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().openNotificationTarget(n);

  assert.equal(useWorldStore.getState().workspaceProjectId, 'p1');
  assert.equal(useWorldStore.getState().workspaceTab, 'tasks');
  assert.equal(useWorldStore.getState().workspaceDetailTaskId, 'task-9');
  assert.ok(useWorldStore.getState().notificationsById[n.id].readAt);
});

test('openNotificationTarget for a command subject opens the workspace on Settings → Commands', async () => {
  const stub = installServerStub();
  reset();
  const n = stub.raiseNotification({ kind: 'command.failed', subject: { type: 'command', projectId: 'p1', commandId: 'c1', runId: 'r1' }, title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().openNotificationTarget(n);

  assert.equal(useWorldStore.getState().workspaceProjectId, 'p1');
  assert.equal(useWorldStore.getState().workspaceTab, 'settings');
  assert.equal(useWorldStore.getState().workspaceSettingsSection, 'commands');
});

test('openNotificationTarget for a project subject opens the workspace, unchanged openWorkspace behavior for existing callers', async () => {
  const stub = installServerStub();
  reset();
  const n = stub.raiseNotification({ kind: 'git.out_of_sync', subject: { type: 'project', projectId: 'p1' }, title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().openNotificationTarget(n);
  assert.equal(useWorldStore.getState().workspaceProjectId, 'p1');

  useWorldStore.getState().openWorkspace(null);
  assert.equal(useWorldStore.getState().workspaceProjectId, null);
});

test('openNotificationTarget for a skill subject opens the Catalog', async () => {
  const stub = installServerStub();
  reset();
  const n = stub.raiseNotification({ kind: 'skill.install_failed', subject: { type: 'skill', repo: 'owner/repo' }, title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().openNotificationTarget(n);

  assert.equal(useWorldStore.getState().catalogOpen, true);
});

test('quickActionFor returns the right action per kind, only while unresolved', async () => {
  const { quickActionFor } = await import('../src/lib/notificationCenter.ts');
  assert.equal(quickActionFor(makeNotification({ kind: 'task.needs_input', resolvedAt: null })).kind, 'reply');
  assert.equal(quickActionFor(makeNotification({ kind: 'task.failed', resolvedAt: null })).kind, 'retry');
  assert.equal(quickActionFor(makeNotification({ kind: 'command.failed', resolvedAt: null })).kind, 'run-again');
  assert.equal(quickActionFor(makeNotification({ kind: 'git.out_of_sync', resolvedAt: null })).kind, 'sync');
  assert.equal(quickActionFor(makeNotification({ kind: 'task.completed', resolvedAt: null })), null);
  assert.equal(quickActionFor(makeNotification({ kind: 'skill.install_failed', resolvedAt: null })), null);
  for (const kind of ['task.needs_input', 'task.failed', 'command.failed', 'git.out_of_sync']) {
    assert.equal(quickActionFor(makeNotification({ kind, resolvedAt: '2026-01-01T00:00:00.000Z' })), null, `${kind} once resolved`);
  }
});

test('runNotificationQuickAction retries a terminal task via resume', async () => {
  const stub = installServerStub();
  reset();
  const project = { id: 'test-project-1', name: 'P', slug: 'p', relativePath: 'projects/p', status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: 'now', updatedAt: 'now' };
  stub.projects.set(project.id, project);
  stub.tasksById.set('terminal-task', {
    id: 'terminal-task', projectId: project.id, templateId: 'builder', executorId: 'test-claude', executionMode: 'terminal',
    description: 'do it', status: 'failed', autonomy: 'auto', kind: 'execute', planItemId: null, sessionId: 's1',
    blockedQuestion: null, failureReason: 'boom', createdAt: 'now', updatedAt: 'now', completedAt: null,
  });
  await useWorldStore.getState().loadProjects();
  await useWorldStore.getState().loadProjectTasks(project.id);
  const n = stub.raiseNotification({ kind: 'task.failed', subject: { type: 'task', projectId: project.id, conversationId: 'terminal-task', taskId: 'terminal-task' }, title: 'Task failed: do it', description: 'boom' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().runNotificationQuickAction(n);

  assert.ok(useWorldStore.getState().notificationsById[n.id].readAt, 'marked read on success');
});

test('runNotificationQuickAction follows up a structured (non-terminal) task instead of resuming it', async () => {
  const stub = installServerStub();
  reset();
  const project = { id: 'test-project-2', name: 'P', slug: 'p2', relativePath: 'projects/p2', status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: 'now', updatedAt: 'now' };
  stub.projects.set(project.id, project);
  stub.tasksById.set('structured-task', {
    id: 'structured-task', projectId: project.id, templateId: 'builder', executorId: 'test-claude',
    description: 'do it', status: 'failed', autonomy: 'auto', kind: 'execute', planItemId: null, sessionId: 's1',
    blockedQuestion: null, failureReason: 'boom', createdAt: 'now', updatedAt: 'now', completedAt: null,
  });
  await useWorldStore.getState().loadProjects();
  await useWorldStore.getState().loadProjectTasks(project.id);
  const n = stub.raiseNotification({ kind: 'task.failed', subject: { type: 'task', projectId: project.id, conversationId: 'structured-task', taskId: 'structured-task' }, title: 'Task failed: do it', description: 'the previous attempt failed somehow' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().runNotificationQuickAction(n);

  assert.equal(stub.tasksById.size, 2, 'followup created a new linked task rather than resuming');
  assert.ok(useWorldStore.getState().notificationsById[n.id].readAt);
});

test('runNotificationQuickAction reports the error and does not mark read on failure', async () => {
  const stub = installServerStub();
  reset();
  const n = stub.raiseNotification({ kind: 'command.failed', subject: { type: 'command', projectId: 'no-such-project', commandId: 'does-not-exist', runId: 'r1' }, title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();

  await useWorldStore.getState().runNotificationQuickAction(n);

  assert.ok(reportedError());
  assert.equal(useWorldStore.getState().notificationsById[n.id].readAt, null);
});

test('isUsageLimitLogEvent is true only for a "log" event carrying a raw usage-limit reading', () => {
  const usageTurn = { role: 'raw-event', content: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }), at: 't1' };
  const toolTurn = { role: 'raw-event', content: JSON.stringify({ type: 'assistant', message: { content: [] } }), at: 't1' };
  const promptTurn = { role: 'prompt', content: JSON.stringify({ type: 'rate_limit_event' }), at: 't1' };

  assert.equal(isUsageLimitLogEvent({ type: 'log', taskId: 'task-1', turn: usageTurn }), true);
  assert.equal(isUsageLimitLogEvent({ type: 'log', taskId: 'task-1', turn: toolTurn }), false);
  // A 'rate_limit_event' payload on a chat-bubble role (not raw-event) shouldn't happen in practice,
  // but stays false regardless since it can't be the raw CLI event this is meant to detect.
  assert.equal(isUsageLimitLogEvent({ type: 'log', taskId: 'task-1', turn: promptTurn }), false);
  assert.equal(isUsageLimitLogEvent({ type: 'task', task: { id: 't1' } }), false);
});

test('loadTranscript fetches and stores a task\'s turns', async () => {
  const { transcripts } = installServerStub();
  reset();
  transcripts.set('task-x', { id: 'task-x', taskId: 'task-x', turns: [{ role: 'prompt', content: 'Hi', at: 't1' }] });

  await useWorldStore.getState().loadTranscript('task-x');

  assert.deepEqual(useWorldStore.getState().transcriptsByTask['task-x'], [{ role: 'prompt', content: 'Hi', at: 't1' }]);
});

test('loadTranscript never regresses turns a live "log" event already appended locally', async () => {
  const { transcripts } = installServerStub();
  reset();
  transcripts.set('task-y', { id: 'task-y', taskId: 'task-y', turns: [{ role: 'prompt', content: 'Hi', at: 't1' }] });
  // Simulate a 'log' WS event that raced ahead of the GET response below.
  useWorldStore.setState({
    transcriptsByTask: {
      'task-y': [
        { role: 'prompt', content: 'Hi', at: 't1' },
        { role: 'result', content: 'Done', at: 't2' },
      ],
    },
  });

  await useWorldStore.getState().loadTranscript('task-y');

  assert.equal(useWorldStore.getState().transcriptsByTask['task-y'].length, 2);
});

test('loadTranscript reports the error for an unknown task rather than throwing', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().loadTranscript('no-such-task');
  assert.match(reportedError() ?? '', /not found/);
});

test('loadExecutors populates the executors list from the server', async () => {
  installServerStub();
  reset();

  await useWorldStore.getState().loadExecutors();

  const ids = useWorldStore.getState().executors.map((e) => e.id);
  assert.ok(ids.includes('test-claude'));
  assert.ok(ids.includes('test-codex'));
});

// ---- Settings panel: add/edit/remove coding agents (SettingsPanel's AgentsSettings section) ----

test('addExecutor adds the server-returned agent locally, with zero usage', async () => {
  installServerStub();
  reset();

  const ok = await useWorldStore.getState().addExecutor({ label: 'Claude (work)', kind: 'claude-cli', bin: 'claude-work' });

  assert.equal(ok, true);
  const added = useWorldStore.getState().executors.find((e) => e.label === 'Claude (work)');
  assert.equal(added.id, 'claude-work');
  assert.equal(added.bin, 'claude-work');
  assert.deepEqual(added.usage, { totalTokens: 0, taskCount: 0 });
  assert.equal(reportedError(), null);
});

test('addExecutor reports the error and adds nothing when the server call fails', async () => {
  reset();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'label is required' }), { status: 400 });

  const ok = await useWorldStore.getState().addExecutor({ label: '', kind: 'claude-cli', bin: 'claude' });

  assert.equal(ok, false);
  assert.equal(useWorldStore.getState().executors.length, 0);
  assert.match(reportedError() ?? '', /label is required/);
});

test('updateExecutor patches an existing agent\'s fields locally without touching its usage', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().loadExecutors();

  const ok = await useWorldStore.getState().updateExecutor('test-claude', { label: 'Renamed Claude' });

  assert.equal(ok, true);
  const updated = useWorldStore.getState().executors.find((e) => e.id === 'test-claude');
  assert.equal(updated.label, 'Renamed Claude');
  assert.deepEqual(updated.usage, { totalTokens: 0, taskCount: 0 });
});

test('updateExecutor reports the error for an unknown id', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().loadExecutors();

  const ok = await useWorldStore.getState().updateExecutor('does-not-exist', { label: 'x' });

  assert.equal(ok, false);
  assert.match(reportedError() ?? '', /not found/);
});

test('deleteExecutor removes the agent from the local list on success', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().loadExecutors();

  const ok = await useWorldStore.getState().deleteExecutor('test-codex');

  assert.equal(ok, true);
  assert.ok(!useWorldStore.getState().executors.some((e) => e.id === 'test-codex'));
});

test('deleteExecutor reports the error and leaves the local list untouched on failure', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().loadExecutors();

  const ok = await useWorldStore.getState().deleteExecutor('does-not-exist');

  assert.equal(ok, false);
  assert.match(reportedError() ?? '', /not found/);
  assert.equal(useWorldStore.getState().executors.length, 2);
});

// ---- Project plan: docs + Tasks breakdown (Full-fledged Project Popover) ----

async function createTestProject(name = 'Planned') {
  await useWorldStore.getState().addProject(name);
  return useWorldStore.getState().projects.at(-1);
}

test('openWorkspace sets workspaceProjectId and loads that project\'s plan', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();

  useWorldStore.getState().openWorkspace(project.id);
  assert.equal(useWorldStore.getState().workspaceProjectId, project.id);
  // loadPlan is fire-and-forget from openWorkspace — wait for it to land.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const plan = useWorldStore.getState().planByProject[project.id];
  assert.deepEqual(plan.items, []);

  useWorldStore.getState().openWorkspace(null);
  assert.equal(useWorldStore.getState().workspaceProjectId, null);
});

test('openWorkspace resets workspaceTab/workspaceDetailTaskId/workspaceSettingsSection to their defaults every time it is called — switching projects, or closing, must never carry over a stale tab/detail', async () => {
  installServerStub();
  reset();
  const projectA = await createTestProject();
  const projectB = await createTestProject();

  useWorldStore.getState().openWorkspace(projectA.id);
  useWorldStore.setState({ workspaceTab: 'settings', workspaceDetailTaskId: 'some-task', workspaceSettingsSection: 'commands' });

  useWorldStore.getState().openWorkspace(projectB.id);
  assert.equal(useWorldStore.getState().workspaceProjectId, projectB.id);
  assert.equal(useWorldStore.getState().workspaceTab, 'tasks');
  assert.equal(useWorldStore.getState().workspaceDetailTaskId, null);
  assert.equal(useWorldStore.getState().workspaceSettingsSection, 'general');

  useWorldStore.setState({ workspaceTab: 'code', workspaceDetailTaskId: 'another-task' });
  useWorldStore.getState().openWorkspace(null);
  assert.equal(useWorldStore.getState().workspaceTab, 'tasks');
  assert.equal(useWorldStore.getState().workspaceDetailTaskId, null);
  assert.equal(useWorldStore.getState().workspaceSettingsSection, 'general');
});

test('opening a project acknowledges its latest completed task', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().startTask(project.id, 'Finished work');
  const taskId = useWorldStore.getState().lastTaskIdByProject[project.id];
  useWorldStore.setState((state) => mergeWorkerEvent(state, {
    type: 'task',
    task: { ...state.tasksById[taskId], status: 'done' },
  }));

  assert.equal(useWorldStore.getState().reviewedTaskIds[taskId], undefined);
  useWorldStore.getState().openWorkspace(project.id);
  assert.equal(useWorldStore.getState().reviewedTaskIds[taskId], true);
});

test('reviewTask explicitly dismisses a settled task notice', () => {
  reset();
  useWorldStore.getState().reviewTask('failed-task');
  assert.equal(useWorldStore.getState().reviewedTaskIds['failed-task'], true);
});

test('mergeWorkerEvent "planItem" updates an item in place and remembers events before the plan loads', () => {
  const planItem = {
    id: 'item-1', projectId: 'p1', title: 'A', description: '', status: 'done', order: 0, taskIds: ['t1'],
    createdAt: '', updatedAt: '',
  };

  const notLoaded = { projects: [], tasksById: {}, lastTaskIdByProject: {}, transcriptsByTask: {}, planByProject: {} };
  assert.equal(mergeWorkerEvent(notLoaded, { type: 'planItem', planItem }).planLiveChangesByProject.p1['item-1'].event.planItem.title, 'A');

  const loaded = { ...notLoaded, planByProject: { p1: { items: [] } } };
  const patch = mergeWorkerEvent(loaded, { type: 'planItem', planItem });
  assert.equal(patch.planByProject.p1.items.length, 1);
  assert.equal(patch.planByProject.p1.items[0].status, 'done');

  const updated = { ...loaded, planByProject: patch.planByProject };
  const renamed = { ...planItem, title: 'A renamed' };
  const patch2 = mergeWorkerEvent(updated, { type: 'planItem', planItem: renamed });
  assert.equal(patch2.planByProject.p1.items.length, 1, 'an existing item is updated in place, not duplicated');
  assert.equal(patch2.planByProject.p1.items[0].title, 'A renamed');
});

const reportedBug = {
  id: 'b1', projectId: 'p1', title: 'Crash', description: '', status: 'unstarted', order: 0, taskIds: [],
  type: 'bug', bug: { number: '10.010.003', reportSessionNumber: 7 }, createdAt: '', updatedAt: '',
};
const reportedTask = {
  id: 't1', projectId: 'p1', title: 'Guard the crash', description: '', status: 'unstarted', order: 1, taskIds: [],
  reportSessionNumber: 7, relatedBug: { planItemId: 'b1', number: '10.010.003', title: 'Crash' }, createdAt: '', updatedAt: '',
};

function applyPlanItems(state, planItems) {
  return planItems.reduce((current, planItem) => ({ ...current, ...mergeWorkerEvent(current, { type: 'planItem', planItem }) }), state);
}

test('a task a bug report session files keeps its session number and related bug in the store, so the session panel lists it', () => {
  const state = applyPlanItems({ projects: [], tasksById: {}, lastTaskIdByProject: {}, transcriptsByTask: {}, planByProject: { p1: { items: [] } } }, [reportedBug, reportedTask]);
  const items = state.planByProject.p1.items;
  const task = items.find((item) => item.id === 't1');
  const bug = items.find((item) => item.id === 'b1');

  assert.equal(task.reportSessionNumber, 7);
  assert.deepEqual(task.relatedBug, { planItemId: 'b1', number: '10.010.003', title: 'Crash' });
  assert.deepEqual(bugReportLinkedItems(items, 7).map((item) => item.id), ['b1', 't1']);
  assert.equal(bugReportHistory(items, 7, 2).taskCount, 1);
  assert.deepEqual(relatedLinks(bug, items), [{ prefix: 'Related task', text: 'Guard the crash', itemId: 't1' }]);
  assert.deepEqual(relatedLinks(task, items).map((link) => [link.prefix, link.itemId]), [['Related to', 'b1']]);
});

test('loadPlan keeps a report-session task\'s session number and related bug across a reload', async () => {
  installServerStub();
  reset();
  const original = serverApi.getPlan;
  serverApi.getPlan = async () => ({ items: [reportedBug, reportedTask] });
  try { await useWorldStore.getState().loadPlan('p1'); } finally { serverApi.getPlan = original; }
  const task = useWorldStore.getState().planByProject.p1.items.find((item) => item.id === 't1');
  assert.equal(task.reportSessionNumber, 7);
  assert.equal(task.relatedBug.planItemId, 'b1');
});

test('an unreadable related bug or a missing session number leaves the key off the stored item', () => {
  const plain = { ...reportedTask, id: 't2', reportSessionNumber: undefined, relatedBug: undefined };
  const junk = [{ ...reportedTask, id: 't3', relatedBug: 'junk' }, { ...reportedTask, id: 't4', relatedBug: {} }, { ...reportedTask, id: 't5', relatedBug: { number: '1', title: 'x' } }];
  const items = applyPlanItems({ planByProject: { p1: { items: [] } } }, [plain, ...junk]).planByProject.p1.items;
  for (const item of items) assert.equal('relatedBug' in item, false, `${item.id} has no related bug`);
  assert.equal('reportSessionNumber' in items.find((item) => item.id === 't2'), false);
});

test('a later planItem event without relatedBug unlinks the task in the store', () => {
  const linked = applyPlanItems({ planByProject: { p1: { items: [] } } }, [reportedBug, reportedTask]);
  const { relatedBug: _unlinked, ...withoutLink } = reportedTask;
  const items = applyPlanItems(linked, [withoutLink]).planByProject.p1.items;
  const task = items.find((item) => item.id === 't1');
  assert.equal('relatedBug' in task, false);
  assert.deepEqual(relatedLinks(items.find((item) => item.id === 'b1'), items), []);
});

test('createPlanItem with only a description gets a placeholder title, then the generated one from the WS feed', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  const id = await useWorldStore.getState().createPlanItem(project.id, { description: 'Remember the email\nUse localStorage.' });
  const [created] = useWorldStore.getState().planByProject[project.id].items;
  assert.equal(created.id, id);
  assert.equal(created.title, 'Remember the email');

  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...created, title: 'Remember login email' } }));
  const items = useWorldStore.getState().planByProject[project.id].items;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Remember login email');
});

test('createPlanItem keeps a generated title that arrived over WS before its own response', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await realFetch(...args);
    const item = await response.clone().json();
    useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...item, title: 'Generated first' } }));
    return response;
  };
  try {
    await useWorldStore.getState().createPlanItem(project.id, { description: 'Placeholder line' });
  } finally {
    globalThis.fetch = realFetch;
  }
  const items = useWorldStore.getState().planByProject[project.id].items;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Generated first');
});

test('mergeWorkerEvent "planItemDeleted" removes the item locally and remembers pre-load deletions', () => {
  const notLoaded = { projects: [], tasksById: {}, lastTaskIdByProject: {}, transcriptsByTask: {}, planByProject: {} };
  assert.equal(mergeWorkerEvent(notLoaded, { type: 'planItemDeleted', id: 'item-1', projectId: 'p1' }).planLiveChangesByProject.p1['item-1'].event.type, 'planItemDeleted');

  const loaded = {
    ...notLoaded,
    planByProject: { p1: { items: [{ id: 'item-1', projectId: 'p1', title: 'A', description: '', status: 'pending', order: 0, taskIds: [] }] } },
  };
  const patch = mergeWorkerEvent(loaded, { type: 'planItemDeleted', id: 'item-1', projectId: 'p1' });
  assert.deepEqual(patch.planByProject.p1.items, []);
});

test('a failed planning completion is reported without removing its card', () => {
  const state = { planByProject: { p1: { items: [] } }, errorNotificationsById: {}, errorNotificationSeq: 0 };
  const patch = mergeWorkerEvent(state, { type: 'planningCompletionError', projectId: 'p1', session: 4, message: 'persist failed' });
  assert.match(Object.values(patch.errorNotificationsById)[0].description, /planning session 4: persist failed/);
  assert.equal(patch.planByProject, undefined);
});

test('an accepted start response does not erase an earlier live planning-completion error', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'Ready', description: '' });
  const [ready] = useWorldStore.getState().planByProject[project.id].items;
  deliverEventsBeforeResponse('/execute', () => [
    { type: 'planningCompletionError', projectId: project.id, session: 4, message: 'persist failed' },
  ]);
  await useWorldStore.getState().executePlanItem(ready.id, { createBranch: false });
  assert.match(reportedError(), /planning session 4: persist failed/);
});

test('a delayed plan GET cannot undo live create, edit, or delete events', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  const editedId = await useWorldStore.getState().createPlanItem(project.id, { title: 'Before edit', description: '' });
  const deletedId = await useWorldStore.getState().createPlanItem(project.id, { title: 'Before delete', description: '' });
  const [edited, deleted] = [editedId, deletedId].map((id) => useWorldStore.getState().planByProject[project.id].items.find((item) => item.id === id));
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith(`/projects/${project.id}/plan`)) return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  };
  try {
    const loading = useWorldStore.getState().loadPlan(project.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(typeof release, 'function');
    useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...edited, title: 'Live edit' } }));
    useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItemDeleted', id: deleted.id, projectId: project.id }));
    useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...edited, id: 'live-created', title: 'Live creation', order: 2 } }));
    release();
    await loading;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const items = useWorldStore.getState().planByProject[project.id].items;
  assert.deepEqual(items.map((item) => item.title), ['Live edit', 'Live creation']);
});

test('loadProjectTasks lists every Task run for a project, most-recent-first', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().startTask(project.id, 'First task');
  const firstTaskId = useWorldStore.getState().projects.find((p) => p.id === project.id).activeTaskId;
  // Settle it locally (as a real WS 'task' event would) so a second Task can start on the same project.
  useWorldStore.setState((state) => mergeWorkerEvent(state, {
    type: 'task',
    task: { ...state.tasksById[firstTaskId], id: firstTaskId, projectId: project.id, status: 'done' },
  }));
  useWorldStore.setState((state) => ({ projects: state.projects.map((p) => (p.id === project.id ? { ...p, status: 'idle', activeTaskId: null } : p)) }));
  await useWorldStore.getState().startTask(project.id, 'Second task');
  const secondTaskId = useWorldStore.getState().projects.find((p) => p.id === project.id).activeTaskId;

  await useWorldStore.getState().loadProjectTasks(project.id);

  const ids = useWorldStore.getState().taskIdsByProject[project.id];
  assert.deepEqual(ids, [secondTaskId, firstTaskId]);
});

test('loadProjectTasks never regresses a Task the store already has fresher than the fetched snapshot', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().startTask(project.id, 'Do the thing');
  const taskId = useWorldStore.getState().projects.find((p) => p.id === project.id).activeTaskId;
  const stale = stub.tasksById.get(taskId);
  assert.equal(stale.status, 'developing', 'the stub — what a slow GET would still return — stays at the pre-completion snapshot');
  // A live WS 'task' event settles it in the store first, with a newer updatedAt than the stub has.
  const settledAt = new Date(Date.parse(stale.updatedAt) + 60_000).toISOString();
  useWorldStore.setState((state) => mergeWorkerEvent(state, {
    type: 'task',
    task: { ...stale, status: 'done', completedAt: settledAt, updatedAt: settledAt },
  }));

  await useWorldStore.getState().loadProjectTasks(project.id);

  // The GET response (still 'developing') must not clobber the newer 'done' the store already has —
  // regressing it here would let `lib/taskSounds.ts` see 'developing' -> 'done' a second time later.
  assert.equal(useWorldStore.getState().tasksById[taskId].status, 'done');
});

test('a delayed task GET keeps a live follow-up as the latest planning conversation turn', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().startTask(project.id, 'Plan this');
  const firstId = useWorldStore.getState().projects.find((p) => p.id === project.id).activeTaskId;
  const first = useWorldStore.getState().tasksById[firstId];
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith(`/projects/${project.id}/tasks`)) return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  };
  try {
    const loading = useWorldStore.getState().loadProjectTasks(project.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(typeof release, 'function');
    useWorldStore.setState((state) => mergeWorkerEvent(state, {
      type: 'task', task: { ...first, id: 'live-followup', conversationId: first.id, kind: 'plan',
        createdAt: new Date(Date.parse(first.createdAt) + 60_000).toISOString(), updatedAt: new Date(Date.parse(first.updatedAt) + 60_000).toISOString() },
    }));
    release();
    await loading;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(useWorldStore.getState().taskIdsByProject[project.id].slice(0, 2), ['live-followup', first.id]);
  assert.equal(useWorldStore.getState().lastTaskIdByProject[project.id], 'live-followup');
});

test('a delayed task GET does not resurrect a live-deleted planning session', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().startTask(project.id, 'Plan this');
  const taskId = useWorldStore.getState().lastTaskIdByProject[project.id];
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith(`/projects/${project.id}/tasks`)) return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  };
  try {
    const loading = useWorldStore.getState().loadProjectTasks(project.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(typeof release, 'function');
    useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'taskDeleted', id: taskId, projectId: project.id }));
    release();
    await loading;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(useWorldStore.getState().tasksById[taskId], undefined);
  assert.deepEqual(useWorldStore.getState().taskIdsByProject[project.id], []);
});

test('a fresh task GET prunes a planning session deleted while the client was disconnected', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().startTask(project.id, 'Old planning session');
  const taskId = useWorldStore.getState().lastTaskIdByProject[project.id];
  stub.tasksById.delete(taskId);
  await useWorldStore.getState().loadProjectTasks(project.id);
  assert.equal(useWorldStore.getState().tasksById[taskId], undefined);
  assert.deepEqual(useWorldStore.getState().taskIdsByProject[project.id], []);
  assert.equal(useWorldStore.getState().lastTaskIdByProject[project.id], undefined);
});

test('reconnect refreshes the open board after missed planning create, edit, and delete events', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  const deletedId = await useWorldStore.getState().createPlanItem(project.id, { title: 'Delete remotely', description: '' });
  const editedId = await useWorldStore.getState().createPlanItem(project.id, { title: 'Edit remotely', description: '' });
  await useWorldStore.getState().startTask(project.id, 'Old planning session');
  const deletedTaskId = useWorldStore.getState().lastTaskIdByProject[project.id];
  const oldTask = useWorldStore.getState().tasksById[deletedTaskId];
  stub.tasksById.set('edited-remote-session', { ...oldTask, id: 'edited-remote-session', kind: 'plan', description: 'Before edit', createdAt: new Date(Date.parse(oldTask.createdAt) + 30_000).toISOString() });
  await useWorldStore.getState().loadProjectTasks(project.id);
  useWorldStore.setState({ workspaceProjectId: project.id });

  stub.planItems.delete(deletedId);
  const edited = stub.planItems.get(editedId);
  stub.planItems.set(editedId, { ...edited, title: 'Edited elsewhere', updatedAt: new Date(Date.parse(edited.updatedAt) + 60_000).toISOString() });
  stub.planItems.set('new-remote-item', { ...edited, id: 'new-remote-item', title: 'Created elsewhere', createdAt: new Date(Date.parse(edited.createdAt) + 60_000).toISOString() });
  stub.tasksById.delete(deletedTaskId);
  stub.tasksById.set('edited-remote-session', { ...stub.tasksById.get('edited-remote-session'), description: 'Edited planning session', updatedAt: oldTask.updatedAt });
  stub.tasksById.set('new-remote-session', { ...oldTask, id: 'new-remote-session', kind: 'plan', description: 'New planning session', createdAt: new Date(Date.parse(oldTask.createdAt) + 60_000).toISOString() });

  const originalConnect = serverApi.connectLiveUpdates;
  let onReconnect;
  serverApi.connectLiveUpdates = (_onEvent, reconnect) => { onReconnect = reconnect; return () => {}; };
  try {
    useWorldStore.getState().connectLiveUpdates();
    assert.equal(typeof onReconnect, 'function');
    onReconnect();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = useWorldStore.getState();
      const items = state.planByProject[project.id]?.items ?? [];
      if (items.some((item) => item.id === 'new-remote-item') && state.tasksById['new-remote-session']) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    serverApi.connectLiveUpdates = originalConnect;
  }
  const state = useWorldStore.getState();
  assert.deepEqual(state.planByProject[project.id].items.map((item) => item.id).sort(), [editedId, 'new-remote-item'].sort());
  assert.equal(state.planByProject[project.id].items.find((item) => item.id === editedId).title, 'Edited elsewhere');
  assert.equal(state.tasksById[deletedTaskId], undefined);
  assert.equal(state.tasksById['edited-remote-session'].description, 'Edited planning session');
  assert.deepEqual(state.taskIdsByProject[project.id], ['new-remote-session', 'edited-remote-session']);
});

test('reorderPlanItems reorders a board column locally and on the daemon, sending only the ids', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  for (const title of ['A', 'B', 'C']) await useWorldStore.getState().createPlanItem(project.id, { title, description: '' });
  const [a, , c] = useWorldStore.getState().planByProject[project.id].items;
  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/plan-items/order')) bodies.push(JSON.parse(init.body));
    return originalFetch(url, init);
  };

  const pending = useWorldStore.getState().reorderPlanItems(project.id, [c.id, a.id]);
  const optimistic = useWorldStore.getState().planByProject[project.id].items;
  assert.deepEqual(optimistic.map((item) => item.title), ['C', 'B', 'A'], 'applied before the daemon answers');
  await pending;
  globalThis.fetch = originalFetch;

  assert.deepEqual(useWorldStore.getState().planByProject[project.id].items.map((item) => item.title), ['C', 'B', 'A']);
  assert.deepEqual(bodies, [{ ids: [c.id, a.id] }], 'PUT /plan-items/order carries just the ids — no priority');
  assert.equal(stub.planItems.get(c.id).order, 0, 'saved on the daemon');
  assert.equal(reportedError(), null);
});

test('reorderPlanItems reloads the daemon\'s order and reports the error when the reorder fails', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  for (const title of ['A', 'B']) await useWorldStore.getState().createPlanItem(project.id, { title, description: '' });
  const [a, b] = useWorldStore.getState().planByProject[project.id].items;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).endsWith('/plan-items/order') ? new Response(JSON.stringify({ error: 'nope' }), { status: 500 }) : originalFetch(url, init);
  await useWorldStore.getState().reorderPlanItems(project.id, [b.id, a.id]);
  globalThis.fetch = originalFetch;

  assert.deepEqual(useWorldStore.getState().planByProject[project.id].items.map((item) => item.title), ['A', 'B'], 'back to what the daemon has');
  assert.match(reportedError() ?? '', /nope/);
  assert.ok(stub.planItems.get(a.id));
});

test('reorderLocally only moves the listed items, within the slots they held, and ignores unknown ids', () => {
  const items = ['a', 'b', 'c', 'd'].map((id, order) => ({ id, order }));
  assert.deepEqual(reorderLocally(items, ['d', 'b', 'zzz']).map((item) => item.id), ['a', 'd', 'c', 'b']);
});

test('plan items carry no priority, loaded or created', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'A', description: '' });
  const [item] = useWorldStore.getState().planByProject[project.id].items;
  assert.equal('priority' in item, false);
});

test('executePlanItem sends the start options and folds the returned Starting run in', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject();
  stub.projects.get(project.id).repositoryUrl = 'https://example.test/repo.git';
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'First', description: '' });
  const [first] = useWorldStore.getState().planByProject[project.id].items;

  const runId = await useWorldStore.getState().executePlanItem(first.id, { executorId: 'test-claude', workflowId: 'software-development', createBranch: true });

  assert.deepEqual(stub.executeRequests, [{ planItemId: first.id, executorId: 'test-claude', workflowId: 'software-development', createBranch: true }]);
  const state = useWorldStore.getState();
  const run = state.workflowRunsByProject[project.id].find((entry) => entry.id === runId);
  assert.equal(run.planItemId, first.id);
  assert.equal(run.status, 'starting');
  assert.deepEqual(run.startup.steps.map((step) => step.id), ['name', 'worktree', 'hooks', 'launch']);
  assert.equal(reportedError(), null);
});

test('a Starting run moves on to running by live events, and a reload shows the same state (C09/C10)', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'First', description: '' });
  const [first] = useWorldStore.getState().planByProject[project.id].items;
  const runId = await useWorldStore.getState().executePlanItem(first.id, { createBranch: false });
  const runOf = () => useWorldStore.getState().workflowRunsByProject[project.id].find((entry) => entry.id === runId);
  assert.equal(runOf().status, 'starting');
  assert.deepEqual(runOf().startup.steps.map((step) => step.id), ['launch'], 'a start without a branch has only the launch step');

  const stepping = { ...runOf(), updatedAt: '2999-01-01T00:00:00.000Z', startup: { ...runOf().startup, steps: [{ ...runOf().startup.steps[0], state: 'running' }] } };
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'workflowRun', run: stepping }));
  assert.equal(runOf().startup.steps[0].state, 'running');
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'workflowRun', run: { ...stepping, status: 'running', startup: { ...stepping.startup, steps: [{ ...stepping.startup.steps[0], state: 'done' }] } } }));
  assert.equal(runOf().status, 'running');

  useWorldStore.setState({ workflowRunsByProject: {} }); // a reload: the store starts empty and the server holds the run as it was
  await useWorldStore.getState().loadWorkflowRunsForProject(project.id);
  assert.equal(runOf().status, 'starting', 'a reload hydrates what the server holds');
});

test('executePlanItem passes the steps left out through to the daemon unchanged', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'First', description: '' });
  const [first] = useWorldStore.getState().planByProject[project.id].items;

  await useWorldStore.getState().executePlanItem(first.id, { executorId: 'test-claude', createBranch: false, skippedStepIds: ['ui', 'plan'] });

  assert.deepEqual(stub.executeRequests, [{ planItemId: first.id, executorId: 'test-claude', createBranch: false, skippedStepIds: ['ui', 'plan'] }]);
});

test('executePlanItem keeps a newer state the WS feed delivered before its own response', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'First', description: '' });
  const [first] = useWorldStore.getState().planByProject[project.id].items;
  deliverEventsBeforeResponse('/execute', (task) => [
    { type: 'task', task: { ...task, status: 'failed', updatedAt: new Date(Date.parse(task.updatedAt) + 1000).toISOString() } },
  ]);

  const taskId = await useWorldStore.getState().executePlanItem(first.id, { createBranch: false });

  assert.equal(useWorldStore.getState().tasksById[taskId].status, 'failed', 'the stale response must not overwrite the newer settle');
});

test('executePlanItem rejects with the daemon\'s reason (e.g. a busy project folder) instead of reporting an error', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'First', description: '' });
  await useWorldStore.getState().createPlanItem(project.id, { title: 'Second', description: '' });
  const [first, second] = useWorldStore.getState().planByProject[project.id].items;
  await useWorldStore.getState().executePlanItem(first.id, { createBranch: false });

  await assert.rejects(useWorldStore.getState().executePlanItem(second.id, { createBranch: false }), /folder is busy/);
  await assert.rejects(useWorldStore.getState().executePlanItem(second.id, { createBranch: true }), /no linked repository/);
  assert.equal(reportedError(), null);
});

test('updatePlanItem archives an item (kept on it as `archived`) and resolves true; a refusal resolves false with an error reported', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'First', description: '' });
  await useWorldStore.getState().createPlanItem(project.id, { title: 'Second', description: '' });
  const [first, second] = useWorldStore.getState().planByProject[project.id].items;

  assert.equal(await useWorldStore.getState().updatePlanItem(project.id, first.id, { archived: true }), true);
  assert.equal(useWorldStore.getState().planByProject[project.id].items.find((i) => i.id === first.id).archived, true);

  stub.planItems.get(second.id).status = 'developing';
  assert.equal(await useWorldStore.getState().updatePlanItem(project.id, second.id, { archived: true }), false);
  assert.match(reportedError() ?? '', /cannot archive while developing/);
});

test('deletePlanItem resolves true once deleted, false with an error reported when refused', async () => {
  installServerStub();
  reset();
  const project = await createTestProject();
  await useWorldStore.getState().loadPlan(project.id);
  await useWorldStore.getState().createPlanItem(project.id, { title: 'First', description: '' });
  const [first] = useWorldStore.getState().planByProject[project.id].items;

  assert.equal(await useWorldStore.getState().deletePlanItem(project.id, first.id), true);
  assert.deepEqual(useWorldStore.getState().planByProject[project.id].items, []);
  assert.equal(await useWorldStore.getState().deletePlanItem(project.id, first.id), false);
  assert.match(reportedError() ?? '', /not found/);
});

// ---- Project Commands: user-defined shell commands, run from the project's root ----

test('mergeWorkerEvent "commandRun" upserts the run, and only touches history if it\'s already loaded', () => {
  const run = { id: 'run-1', projectId: 'p1', commandId: 'c1', commandName: 'Build', commandText: 'npm run build', status: 'running', exitCode: null, output: '', startedAt: 't1', completedAt: null };

  const notLoaded = { commandRunsById: {}, commandRunIdsByProject: {} };
  const patch = mergeWorkerEvent(notLoaded, { type: 'commandRun', run });
  assert.deepEqual(patch.commandRunsById, { 'run-1': run });
  assert.deepEqual(patch.commandRunIdsByProject, {}, 'no history list loaded yet — nothing to prepend into');

  const loaded = { commandRunsById: {}, commandRunIdsByProject: { p1: ['run-0'] } };
  const patch2 = mergeWorkerEvent(loaded, { type: 'commandRun', run });
  assert.deepEqual(patch2.commandRunIdsByProject, { p1: ['run-1', 'run-0'] });

  // A later update to the SAME run (e.g. it settling) must not duplicate it in the history list.
  const settled = { ...run, status: 'success' };
  const state3 = { commandRunsById: patch2.commandRunsById, commandRunIdsByProject: patch2.commandRunIdsByProject };
  const patch3 = mergeWorkerEvent(state3, { type: 'commandRun', run: settled });
  assert.deepEqual(patch3.commandRunIdsByProject, { p1: ['run-1', 'run-0'] });
  assert.equal(patch3.commandRunsById['run-1'].status, 'success');
});

test('mergeWorkerEvent "commandRunLog" appends a chunk to a known run\'s output, and is a no-op for an unknown run', () => {
  const run = { id: 'run-1', projectId: 'p1', commandId: 'c1', commandName: 'Build', commandText: 'npm run build', status: 'running', exitCode: null, output: 'first line\n', startedAt: 't1', completedAt: null };

  const state = { commandRunsById: { 'run-1': run }, commandRunIdsByProject: {} };
  const patch = mergeWorkerEvent(state, { type: 'commandRunLog', runId: 'run-1', chunk: 'second line\n' });
  assert.equal(patch.commandRunsById['run-1'].output, 'first line\nsecond line\n');

  assert.deepEqual(mergeWorkerEvent(state, { type: 'commandRunLog', runId: 'no-such-run', chunk: 'x' }), {});
});

test('createCommand/updateCommand/deleteCommand round-trip through the store, keyed per project', async () => {
  installServerStub();
  reset();
  const project = await createTestProject('Commands Project');

  const created = await useWorldStore.getState().createCommand(project.id, { name: 'Build', command: 'npm run build' });
  assert.equal(created, true);
  const [command] = useWorldStore.getState().commandsByProject[project.id];
  assert.equal(command.name, 'Build');
  assert.equal(command.highlighted, false);

  const updated = await useWorldStore.getState().updateCommand(project.id, command.id, { highlighted: true });
  assert.equal(updated, true);
  assert.equal(useWorldStore.getState().commandsByProject[project.id][0].highlighted, true);

  const deleted = await useWorldStore.getState().deleteCommand(project.id, command.id);
  assert.equal(deleted, true);
  assert.deepEqual(useWorldStore.getState().commandsByProject[project.id], []);
});

test('updateCommand reports the error and returns false once the 3-highlighted cap is hit', async () => {
  installServerStub();
  reset();
  const project = await createTestProject('Highlight Project');
  const ids = [];
  for (const name of ['A', 'B', 'C', 'D']) {
    await useWorldStore.getState().createCommand(project.id, { name, command: `echo ${name}` });
  }
  for (const command of useWorldStore.getState().commandsByProject[project.id]) ids.push(command.id);

  for (const id of ids.slice(0, 3)) assert.equal(await useWorldStore.getState().updateCommand(project.id, id, { highlighted: true }), true);
  const overCap = await useWorldStore.getState().updateCommand(project.id, ids[3], { highlighted: true });
  assert.equal(overCap, false);
  assert.match(reportedError() ?? '', /highlight/i);
});

test('loadCommands fetches a project\'s commands into the store', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject('Load Commands Project');
  stub.commands.set('cmd-1', { id: 'cmd-1', projectId: project.id, name: 'Test', command: 'npm test', highlighted: false, createdAt: 't1', updatedAt: 't1' });

  await useWorldStore.getState().loadCommands(project.id);

  assert.deepEqual(useWorldStore.getState().commandsByProject[project.id].map((c) => c.id), ['cmd-1']);
});

test('runCommand starts a run, merges it into commandRunsById, and returns it for the caller to open the log popup on', async () => {
  installServerStub();
  reset();
  const project = await createTestProject('Run Command Project');
  await useWorldStore.getState().createCommand(project.id, { name: 'Echo', command: 'echo hi' });
  const [command] = useWorldStore.getState().commandsByProject[project.id];

  const run = await useWorldStore.getState().runCommand(command.id);

  assert.ok(run);
  assert.equal(run.status, 'running');
  assert.equal(useWorldStore.getState().commandRunsById[run.id].id, run.id);
});

test('createCommand can highlight a command at creation, still capped at 3', async () => {
  installServerStub();
  reset();
  const project = await createTestProject('Highlight At Creation Project');

  const first = await useWorldStore.getState().createCommand(project.id, { name: 'A', command: 'echo A', highlighted: true });
  assert.equal(first, true);
  assert.equal(useWorldStore.getState().commandsByProject[project.id][0].highlighted, true);

  await useWorldStore.getState().createCommand(project.id, { name: 'B', command: 'echo B', highlighted: true });
  await useWorldStore.getState().createCommand(project.id, { name: 'C', command: 'echo C', highlighted: true });
  const overCap = await useWorldStore.getState().createCommand(project.id, { name: 'D', command: 'echo D', highlighted: true });
  assert.equal(overCap, false);
  assert.match(reportedError() ?? '', /highlight/i);
});

test('runAdHocCommand ("Run a custom command") starts a run with no ProjectCommand behind it, and merges it in like runCommand does', async () => {
  installServerStub();
  reset();
  const project = await createTestProject('Ad Hoc Project');

  const run = await useWorldStore.getState().runAdHocCommand(project.id, 'echo one-off');

  assert.ok(run);
  assert.equal(run.status, 'running');
  assert.equal(run.origin, 'adhoc');
  assert.equal(run.commandText, 'echo one-off');
  assert.equal(useWorldStore.getState().commandRunsById[run.id].id, run.id);
  // Never registered as a defined command.
  assert.deepEqual(useWorldStore.getState().commandsByProject[project.id] ?? [], []);
});

test('runAdHocCommand reports the error and returns undefined when the server refuses', async () => {
  installServerStub();
  reset();
  const project = await createTestProject('Ad Hoc Failure Project');

  const run = await useWorldStore.getState().runAdHocCommand(project.id, '');

  assert.equal(run, undefined);
  assert.match(reportedError() ?? '', /command is required/);
});

test('stopCommandRun updates the run\'s status in the store', async () => {
  installServerStub();
  reset();
  const project = await createTestProject('Stop Command Project');
  await useWorldStore.getState().createCommand(project.id, { name: 'Sleep', command: 'sleep 30' });
  const [command] = useWorldStore.getState().commandsByProject[project.id];
  const run = await useWorldStore.getState().runCommand(command.id);

  await useWorldStore.getState().stopCommandRun(run.id);

  assert.equal(useWorldStore.getState().commandRunsById[run.id].status, 'stopped');
});

test('loadCommandRuns fetches a project\'s run history, most-recent-first', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject('History Project');
  stub.commandRuns.set('run-old', { id: 'run-old', projectId: project.id, commandId: 'c1', commandName: 'Echo', commandText: 'echo old', status: 'success', exitCode: 0, output: 'old', startedAt: 't1', completedAt: 't1' });
  stub.commandRuns.set('run-new', { id: 'run-new', projectId: project.id, commandId: 'c1', commandName: 'Echo', commandText: 'echo new', status: 'success', exitCode: 0, output: 'new', startedAt: 't2', completedAt: 't2' });

  await useWorldStore.getState().loadCommandRuns(project.id);

  assert.deepEqual(useWorldStore.getState().commandRunIdsByProject[project.id], ['run-new', 'run-old']);
  assert.equal(useWorldStore.getState().commandRunsById['run-old'].output, 'old');
});

test('findRunningRun finds the in-flight run for a commandId, and undefined once it settles or if it never ran', () => {
  const running = { id: 'run-1', projectId: 'p1', commandId: 'c1', commandName: 'Dev server', commandText: 'npm run dev', status: 'running', exitCode: null, output: '', startedAt: 't1', completedAt: null };
  const settled = { ...running, id: 'run-2', status: 'success' };
  const commandRunsById = { 'run-1': running, 'run-2': settled };

  assert.equal(findRunningRun(commandRunsById, 'c1'), running);
  assert.equal(findRunningRun({ 'run-2': settled }, 'c1'), undefined, 'a settled run is not "running"');
  assert.equal(findRunningRun(commandRunsById, 'no-such-command'), undefined);
});

test('findRunningRun is per command: of two commands only the one with a running run has one, and it clears on any settled status', () => {
  const running = { id: 'run-1', projectId: 'p1', commandId: 'c1', commandName: 'Dev server', commandText: 'npm run dev', status: 'running', exitCode: null, output: '', startedAt: 't1', completedAt: null };
  const otherDone = { ...running, id: 'run-9', commandId: 'c2', commandName: 'Build', status: 'success' };

  assert.equal(findRunningRun({ 'run-1': running, 'run-9': otherDone }, 'c1'), running);
  assert.equal(findRunningRun({ 'run-1': running, 'run-9': otherDone }, 'c2'), undefined);
  for (const status of ['success', 'failed', 'stopped']) {
    assert.equal(findRunningRun({ 'run-1': { ...running, status } }, 'c1'), undefined, `a ${status} run is not "running"`);
  }
});

test('loadActiveCommandRuns merges in only the currently-running runs, without touching commandRunIdsByProject (History\'s own full-list cache)', async () => {
  const stub = installServerStub();
  reset();
  const project = await createTestProject('Active Runs Project');
  stub.commandRuns.set('run-done', { id: 'run-done', projectId: project.id, commandId: 'c1', commandName: 'Echo', commandText: 'echo done', status: 'success', exitCode: 0, output: 'done', startedAt: 't1', completedAt: 't1' });
  stub.commandRuns.set('run-going', { id: 'run-going', projectId: project.id, commandId: 'c2', commandName: 'Dev server', commandText: 'npm run dev', status: 'running', exitCode: null, output: '', startedAt: 't2', completedAt: null });

  await useWorldStore.getState().loadActiveCommandRuns(project.id);

  assert.deepEqual(Object.keys(useWorldStore.getState().commandRunsById), ['run-going']);
  assert.equal(useWorldStore.getState().commandRunIdsByProject[project.id], undefined, 'only loadCommandRuns owns the full History list cache');
});

// ---- Catalog: Templates (agents) and Skills, backed by the daemon's real .claude/ directory ----

test('fetchCatalog loads both agents and skills into the store', async () => {
  const stub = installServerStub();
  reset();
  stub.catalogAgents.set('builder', {
    id: 'builder', name: 'Builder', avatar: '🛠', manager: false, defaultAutonomy: 'auto', agentFile: 'agents/builder.md', enabled: true,
  });
  stub.catalogSkills.set('roadmap-runner', {
    id: 'roadmap-runner', name: 'Roadmap Runner', description: 'Runs the roadmap', triggers: [], avatar: '🗺', enabled: true,
    skillDir: 'skills/roadmap-runner', supportFiles: [],
  });

  await useWorldStore.getState().fetchCatalog();

  assert.deepEqual(useWorldStore.getState().catalogAgents.map((a) => a.id), ['builder']);
  assert.deepEqual(useWorldStore.getState().catalogSkills.map((s) => s.id), ['roadmap-runner']);
  assert.equal(reportedError(), null);
});

test('fetchCatalog reports the error and leaves the lists untouched when the server call fails', async () => {
  reset();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'daemon unreachable' }), { status: 500 });

  await useWorldStore.getState().fetchCatalog();

  assert.deepEqual(useWorldStore.getState().catalogAgents, []);
  assert.deepEqual(useWorldStore.getState().catalogSkills, []);
  assert.match(reportedError() ?? '', /daemon unreachable/);
});

test('createCatalogAgent/updateCatalogAgent/deleteCatalogAgent round-trip through the store', async () => {
  installServerStub();
  reset();

  const created = await useWorldStore.getState().createCatalogAgent({ id: 'reviewer', name: 'Reviewer', description: 'Reviews code' });
  assert.equal(created, true);
  const [agent] = useWorldStore.getState().catalogAgents;
  assert.equal(agent.id, 'reviewer');
  assert.equal(agent.enabled, true);

  const updated = await useWorldStore.getState().updateCatalogAgent('reviewer', { name: 'Senior Reviewer' });
  assert.equal(updated, true);
  assert.equal(useWorldStore.getState().catalogAgents[0].name, 'Senior Reviewer');

  const deleted = await useWorldStore.getState().deleteCatalogAgent('reviewer');
  assert.equal(deleted, true);
  assert.deepEqual(useWorldStore.getState().catalogAgents, []);
});

test('createCatalogAgent reports the error and returns false when the id already exists', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().createCatalogAgent({ id: 'dup', name: 'Dup', description: 'First' });

  const result = await useWorldStore.getState().createCatalogAgent({ id: 'dup', name: 'Dup', description: 'Second' });

  assert.equal(result, false);
  assert.equal(useWorldStore.getState().catalogAgents.length, 1);
  assert.match(reportedError() ?? '', /already exists/);
});

test('toggleCatalogAgentEnabled flips a Template\'s enabled flag through the store', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().createCatalogAgent({ id: 'toggle-me', name: 'Toggle Me', description: 'x' });

  const disabled = await useWorldStore.getState().toggleCatalogAgentEnabled('toggle-me', false);
  assert.equal(disabled, true);
  assert.equal(useWorldStore.getState().catalogAgents[0].enabled, false);

  const enabled = await useWorldStore.getState().toggleCatalogAgentEnabled('toggle-me', true);
  assert.equal(enabled, true);
  assert.equal(useWorldStore.getState().catalogAgents[0].enabled, true);
});

test('toggleCatalogAgentEnabled reports the error for an unknown agent', async () => {
  installServerStub();
  reset();
  const result = await useWorldStore.getState().toggleCatalogAgentEnabled('no-such-agent', true);
  assert.equal(result, false);
  assert.match(reportedError() ?? '', /not found/);
});

test('uploadCatalogAgentFile base64-encodes the file and adds the server-returned agent to the store', async () => {
  installServerStub();
  reset();
  const file = new Blob(['---\nname: uploaded\ndescription: An uploaded agent\n---\n\nBody.\n'], { type: 'text/markdown' });

  const result = await useWorldStore.getState().uploadCatalogAgentFile({ id: 'uploaded', file });

  assert.equal(result, true);
  const [agent] = useWorldStore.getState().catalogAgents;
  assert.equal(agent.id, 'uploaded');
  assert.equal(agent.agentFile, 'agents/uploaded.md');
});

test('uploadCatalogAgentFile reports the error and adds nothing when contentBase64 is missing', async () => {
  reset();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'contentBase64 is required' }), { status: 400 });

  const result = await useWorldStore.getState().uploadCatalogAgentFile({ id: 'broken', file: new Blob(['']) });

  assert.equal(result, false);
  assert.deepEqual(useWorldStore.getState().catalogAgents, []);
});

test('createCatalogSkill/updateCatalogSkill/deleteCatalogSkill round-trip through the store', async () => {
  installServerStub();
  reset();

  const created = await useWorldStore.getState().createCatalogSkill({ id: 'my-skill', name: 'My Skill', description: 'Does things' });
  assert.equal(created, true);
  const [skill] = useWorldStore.getState().catalogSkills;
  assert.equal(skill.id, 'my-skill');
  assert.deepEqual(skill.supportFiles, []);

  const updated = await useWorldStore.getState().updateCatalogSkill('my-skill', { description: 'Does more things' });
  assert.equal(updated, true);
  assert.equal(useWorldStore.getState().catalogSkills[0].description, 'Does more things');

  const deleted = await useWorldStore.getState().deleteCatalogSkill('my-skill');
  assert.equal(deleted, true);
  assert.deepEqual(useWorldStore.getState().catalogSkills, []);
});

test('createCatalogSkill reports the error and returns false when required fields are missing', async () => {
  installServerStub();
  reset();

  const result = await useWorldStore.getState().createCatalogSkill({ id: '', name: '', description: '' });

  assert.equal(result, false);
  assert.deepEqual(useWorldStore.getState().catalogSkills, []);
  assert.match(reportedError() ?? '', /id is required/);
});

test('toggleCatalogSkillEnabled flips a Skill\'s enabled flag through the store', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().createCatalogSkill({ id: 'toggle-skill', name: 'Toggle Skill', description: 'x' });

  const disabled = await useWorldStore.getState().toggleCatalogSkillEnabled('toggle-skill', false);
  assert.equal(disabled, true);
  assert.equal(useWorldStore.getState().catalogSkills[0].enabled, false);
});

test('uploadCatalogSkillZip base64-encodes the file and adds the server-returned skill to the store', async () => {
  installServerStub();
  reset();
  const zip = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]);

  const result = await useWorldStore.getState().uploadCatalogSkillZip({ id: 'zipped-skill', file: zip });

  assert.equal(result, true);
  const [skill] = useWorldStore.getState().catalogSkills;
  assert.equal(skill.id, 'zipped-skill');
  assert.equal(skill.skillDir, 'skills/zipped-skill');
});

test('addCatalogSkillFile/removeCatalogSkillFile round-trip a support file through the store', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().createCatalogSkill({ id: 'file-skill', name: 'File Skill', description: 'x' });
  const helper = new Blob(['helper content'], { type: 'text/plain' });

  const added = await useWorldStore.getState().addCatalogSkillFile('file-skill', 'helper.md', helper);
  assert.equal(added, true);
  assert.deepEqual(useWorldStore.getState().catalogSkills[0].supportFiles, ['helper.md']);

  const removed = await useWorldStore.getState().removeCatalogSkillFile('file-skill', 'helper.md');
  assert.equal(removed, true);
  assert.deepEqual(useWorldStore.getState().catalogSkills[0].supportFiles, []);
});

test('addCatalogSkillFile reports the error for an unknown skill', async () => {
  installServerStub();
  reset();
  const result = await useWorldStore.getState().addCatalogSkillFile('no-such-skill', 'x.md', new Blob(['x']));
  assert.equal(result, false);
  assert.match(reportedError() ?? '', /not found/);
});

test('startCatalogSkillInstall starts a run, merges it into catalogInstallRuns, and returns it', async () => {
  installServerStub();
  reset();

  const run = await useWorldStore.getState().startCatalogSkillInstall('owner/repo');

  assert.ok(run);
  assert.equal(run.repo, 'owner/repo');
  assert.equal(run.status, 'running');
  assert.equal(useWorldStore.getState().catalogInstallRuns[run.id].id, run.id);
  assert.equal(reportedError(), null);
});

test('startCatalogSkillInstall reports the error and returns undefined for an invalid repo slug', async () => {
  installServerStub();
  reset();

  const run = await useWorldStore.getState().startCatalogSkillInstall('not-a-valid-slug');

  assert.equal(run, undefined);
  assert.match(reportedError() ?? '', /valid.*owner\/repo/);
});

test('mergeWorkerEvent "skillInstall" upserts the run by id', () => {
  const run = { id: 'install-1', repo: 'owner/repo', status: 'running', output: '', startedAt: 't1', completedAt: null };
  const state = { catalogInstallRuns: {} };

  const patch = mergeWorkerEvent(state, { type: 'skillInstall', run });
  assert.deepEqual(patch.catalogInstallRuns, { 'install-1': run });

  const settled = { ...run, status: 'success', completedAt: 't2' };
  const patch2 = mergeWorkerEvent({ catalogInstallRuns: patch.catalogInstallRuns }, { type: 'skillInstall', run: settled });
  assert.equal(patch2.catalogInstallRuns['install-1'].status, 'success');
});

test('mergeWorkerEvent "skillInstallLog" appends a chunk to a known run\'s output, and is a no-op for an unknown run', () => {
  const run = { id: 'install-1', repo: 'owner/repo', status: 'running', output: 'first line\n', startedAt: 't1', completedAt: null };
  const state = { catalogInstallRuns: { 'install-1': run } };

  const patch = mergeWorkerEvent(state, { type: 'skillInstallLog', runId: 'install-1', chunk: 'second line\n' });
  assert.equal(patch.catalogInstallRuns['install-1'].output, 'first line\nsecond line\n');

  assert.deepEqual(mergeWorkerEvent(state, { type: 'skillInstallLog', runId: 'no-such-run', chunk: 'x' }), {});
});

test('isSkillInstallSuccessEvent is true only for a settled, successful "skillInstall" event', () => {
  const running = { id: 'install-1', repo: 'owner/repo', status: 'running', output: '', startedAt: 't1', completedAt: null };
  const success = { ...running, status: 'success', completedAt: 't2' };
  const failed = { ...running, status: 'failed', completedAt: 't2' };

  assert.equal(isSkillInstallSuccessEvent({ type: 'skillInstall', run: success }), true);
  assert.equal(isSkillInstallSuccessEvent({ type: 'skillInstall', run: running }), false);
  assert.equal(isSkillInstallSuccessEvent({ type: 'skillInstall', run: failed }), false);
  assert.equal(isSkillInstallSuccessEvent({ type: 'skillInstallLog', runId: 'install-1', chunk: 'x' }), false);
});

test('viewMode defaults to the 3D world and setViewMode switches it', () => {
  reset();
  useWorldStore.setState({ viewMode: 'world' });
  assert.equal(useWorldStore.getState().viewMode, 'world');
  useWorldStore.getState().setViewMode('cards');
  assert.equal(useWorldStore.getState().viewMode, 'cards');
  useWorldStore.getState().setViewMode('world');
  assert.equal(useWorldStore.getState().viewMode, 'world');
});

// ---- Catalog: Workflows (task 3.012) ----

test('fetchCatalog also loads every Catalog Workflow into the store', async () => {
  const stub = installServerStub();
  reset();
  stub.workflows.set('default', {
    id: 'default', name: 'Default', description: 'The default workflow', enabled: true,
    steps: [{ id: 'dev', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build it' }],
  });

  await useWorldStore.getState().fetchCatalog();

  assert.deepEqual(useWorldStore.getState().catalogWorkflows.map((w) => w.id), ['default']);
  assert.equal(reportedError(), null);
});

test('createCatalogWorkflow/updateCatalogWorkflow/deleteCatalogWorkflow round-trip through the store', async () => {
  installServerStub();
  reset();
  const input = {
    id: 'standard',
    name: 'Standard',
    description: 'A standard workflow',
    steps: [{ id: 'dev', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Write the code' }],
  };

  const created = await useWorldStore.getState().createCatalogWorkflow(input);
  assert.equal(created, true);
  const [workflow] = useWorldStore.getState().catalogWorkflows;
  assert.equal(workflow.id, 'standard');
  assert.equal(workflow.enabled, true);

  const updated = await useWorldStore.getState().updateCatalogWorkflow('standard', { name: 'Standard v2' });
  assert.equal(updated, true);
  assert.equal(useWorldStore.getState().catalogWorkflows[0].name, 'Standard v2');

  const deleted = await useWorldStore.getState().deleteCatalogWorkflow('standard');
  assert.equal(deleted, true);
  assert.deepEqual(useWorldStore.getState().catalogWorkflows, []);
});

test('createCatalogWorkflow reports the error and returns false when steps is empty', async () => {
  installServerStub();
  reset();

  const result = await useWorldStore.getState().createCatalogWorkflow({
    id: 'empty',
    name: 'Empty',
    description: 'x',
    steps: [],
  });

  assert.equal(result, false);
  assert.deepEqual(useWorldStore.getState().catalogWorkflows, []);
  assert.match(reportedError() ?? '', /at least one step/);
});

test('deleteCatalogWorkflow reports the error and returns false for an unknown id', async () => {
  installServerStub();
  reset();

  const result = await useWorldStore.getState().deleteCatalogWorkflow('no-such-workflow');

  assert.equal(result, false);
  assert.match(reportedError() ?? '', /not found/);
});

// ---- Project workflow selection (task 3.012) ----

test('setProjectWorkflow sets a project\'s Workflow and applies the server response locally', async () => {
  const stub = installServerStub();
  reset();
  await useWorldStore.getState().addProject('Has A Workflow');
  const [project] = useWorldStore.getState().projects;
  stub.workflows.set('custom', {
    id: 'custom', name: 'Custom', description: 'x', enabled: true,
    steps: [{ id: 'dev', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'x' }],
  });

  const result = await useWorldStore.getState().setProjectWorkflow(project.id, 'custom');

  assert.equal(result, true);
  assert.equal(useWorldStore.getState().projects.find((p) => p.id === project.id).workflowId, 'custom');
});

test('setProjectWorkflow(null) resets a project back to the Catalog default', async () => {
  const stub = installServerStub();
  reset();
  await useWorldStore.getState().addProject('Reset Me');
  const [project] = useWorldStore.getState().projects;
  stub.projects.get(project.id).workflowId = 'whatever';

  const result = await useWorldStore.getState().setProjectWorkflow(project.id, null);

  assert.equal(result, true);
  assert.equal(useWorldStore.getState().projects.find((p) => p.id === project.id).workflowId, null);
});

test('setProjectWorkflow reports the error and returns false for an unknown workflow id', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().addProject('Bad Workflow');
  const [project] = useWorldStore.getState().projects;

  const result = await useWorldStore.getState().setProjectWorkflow(project.id, 'no-such-workflow');

  assert.equal(result, false);
  assert.match(reportedError() ?? '', /not found/);
});

// ---- Git provider setting (task 10.001) ----

test('setProjectGitProvider sends the provider and applies the server response; a legacy project has none stored', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().addProject('Provider Project');
  const [project] = useWorldStore.getState().projects;
  assert.equal(project.gitProvider, undefined);

  const result = await useWorldStore.getState().setProjectGitProvider(project.id, 'github');

  assert.equal(result, true);
  assert.equal(useWorldStore.getState().projects.find((p) => p.id === project.id).gitProvider, 'github');
});

test('setProjectGitProvider reports the error and returns false for an unknown project', async () => {
  installServerStub();
  reset();

  const result = await useWorldStore.getState().setProjectGitProvider('no-such-project', 'github');

  assert.equal(result, false);
  assert.match(reportedError() ?? '', /not found/);
});

// ---- Auto-pull setting (task 10.014) ----

test('setProjectAutoPull applies the setting at once and keeps the server response; an unset project reads as on', async () => {
  installServerStub();
  reset();
  await useWorldStore.getState().addProject('Auto Pull Project');
  const [project] = useWorldStore.getState().projects;
  assert.equal(project.autoPullEnabled, undefined);

  assert.equal(await useWorldStore.getState().setProjectAutoPull(project.id, false), true);
  assert.equal(useWorldStore.getState().projects.find((p) => p.id === project.id).autoPullEnabled, false);
  assert.equal(await useWorldStore.getState().setProjectAutoPull(project.id, true), true);
  assert.equal(useWorldStore.getState().projects.find((p) => p.id === project.id).autoPullEnabled, true);
});

test('setProjectAutoPull rolls the toggle back and reports the error when the daemon refuses', async () => {
  installServerStub();
  reset();

  const result = await useWorldStore.getState().setProjectAutoPull('no-such-project', false);

  assert.equal(result, false);
  assert.match(reportedError() ?? '', /not found/);
});

test('a projectSync event carries the deferred reason and the automatic-pull info, and a later reading replaces them', () => {
  let state = { projects: [{ id: 'p1', name: 'A', position: [1, 2], status: 'idle', activeTaskId: null, taskCount: 0, sync: null }], tasksById: {}, lastTaskIdByProject: {} };
  const reading = { projectId: 'p1', branch: 'main', aheadBy: 0, behindBy: 1, checkedAt: 't' };
  state = { ...state, ...mergeWorkerEvent(state, { type: 'projectSync', sync: { ...reading, status: 'behind', deferredReason: 'not pulled: you have uncommitted changes' } }) };
  assert.equal(state.projects[0].sync.deferredReason, 'not pulled: you have uncommitted changes');
  state = { ...state, ...mergeWorkerEvent(state, { type: 'projectSync', sync: { ...reading, behindBy: 0, status: 'synced', lastAutoPull: { commits: 1, at: 't2' } } }) };
  assert.equal(state.projects[0].sync.deferredReason, undefined);
  assert.equal(state.projects[0].sync.lastAutoPull.commits, 1);
});

// ---- Workflow runs (task 3.012) ----

function makeStubRun(overrides = {}) {
  return {
    id: 'run-1',
    projectId: 'p1',
    planItemId: 'item-1',
    workflowId: 'standard',
    workflowSnapshot: {
      id: 'standard', name: 'Standard', description: 'x', enabled: true,
      steps: [],
    },
    status: 'running',
    currentStepId: null,
    executorId: 'test-claude',
    prUrl: null,
    completionReport: null,
    attentionReason: null,
    loopRoundAllowance: 0,
    createdAt: 't1',
    updatedAt: 't1',
    completedAt: null,
    ...overrides,
  };
}

test('loadWorkflowRunsForProject fetches a project\'s WorkflowRuns into the store', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('p1', {
    id: 'p1', name: 'P1', slug: 'p1', relativePath: 'projects/p1', status: 'idle',
    position: [0, 0], activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '',
  });
  stub.workflowRuns.set('run-1', makeStubRun());

  await useWorldStore.getState().loadWorkflowRunsForProject('p1');

  assert.deepEqual(useWorldStore.getState().workflowRunsByProject.p1.map((r) => r.id), ['run-1']);
  assert.equal(reportedError(), null);
});

test('loadWorkflowRunsForProject never regresses a run the store already has fresher than the fetched snapshot', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('p1', {
    id: 'p1', name: 'P1', slug: 'p1', relativePath: 'projects/p1', status: 'idle',
    position: [0, 0], activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '',
  });
  stub.workflowRuns.set('run-1', makeStubRun({ status: 'completing', updatedAt: 't1' }));
  // A live WS 'workflowRun' event already advanced it to 'completed' in the store, with a newer
  // updatedAt than the stub (what a slow GET would still return) has.
  useWorldStore.setState((state) => mergeWorkerEvent(state, {
    type: 'workflowRun',
    run: makeStubRun({ status: 'completed', updatedAt: 't2', completedAt: 't2' }),
  }));

  await useWorldStore.getState().loadWorkflowRunsForProject('p1');

  // The GET response (still 'completing') must not clobber the newer 'completed' the store already
  // has — regressing it here would let `lib/taskSounds.ts` see the completion a second time later.
  assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].status, 'completed');
});

test('loadWorkflowRunDetail fetches a run\'s full step/round detail into the store', async () => {
  const stub = installServerStub();
  reset();
  const step = { id: 'dev', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'x' };
  stub.workflowRuns.set('run-1', makeStubRun({
    currentStepId: 'dev',
    workflowSnapshot: {
      id: 'standard', name: 'Standard', description: 'x', enabled: true,
      steps: [step],
    },
  }));
  stub.stepRuns.set('stepRun-1', {
    id: 'stepRun-1', runId: 'run-1', stepId: 'dev', round: 1, taskId: 'task-1', status: 'running',
    summary: null, outputs: [], verdict: null, skippedReason: null, approval: null, createdAt: 't1', completedAt: null,
  });

  await useWorldStore.getState().loadWorkflowRunDetail('run-1');

  const detail = useWorldStore.getState().workflowRunDetails['run-1'];
  assert.equal(detail.run.id, 'run-1');
  assert.deepEqual(detail.steps.map((s) => [s.step.id, s.rounds.map((r) => r.id)]), [['dev', ['stepRun-1']]]);
});

test('approve/request-changes/loop/retry/stop apply the server\'s updated run into workflowRunsByProject and a loaded detail', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('p1', {
    id: 'p1', name: 'P1', slug: 'p1', relativePath: 'projects/p1', status: 'idle',
    position: [0, 0], activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '',
  });
  stub.workflowRuns.set('run-1', makeStubRun({ status: 'awaiting-approval' }));
  await useWorldStore.getState().loadWorkflowRunsForProject('p1');
  await useWorldStore.getState().loadWorkflowRunDetail('run-1');

  const approved = await useWorldStore.getState().approveWorkflowRun('run-1', 'looks good');
  assert.equal(approved, true);
  assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].status, 'running');
  assert.equal(useWorldStore.getState().workflowRunDetails['run-1'].run.status, 'running');

  stub.workflowRuns.get('run-1').status = 'awaiting-approval';
  const changesRequested = await useWorldStore.getState().requestChangesWorkflowRun('run-1', 'please fix X');
  assert.equal(changesRequested, true);
  assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].status, 'running');

  const looped = await useWorldStore.getState().decideWorkflowRunLoop('run-1', 'another-round');
  assert.equal(looped, true);
  assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].loopRoundAllowance, 1);

  const retried = await useWorldStore.getState().retryWorkflowStep('run-1');
  assert.equal(retried, true);
  assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].status, 'running');

  const stopped = await useWorldStore.getState().stopWorkflowRun('run-1');
  assert.equal(stopped, true);
  assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].status, 'stopped');
  assert.equal(useWorldStore.getState().workflowRunDetails['run-1'].run.status, 'stopped');
});

test('stop then resume: the run goes stopped, then running again; each refused with a 409 message when it doesn\'t apply', async () => {
  const stub = installServerStub();
  reset();
  stub.projects.set('p1', {
    id: 'p1', name: 'P1', slug: 'p1', relativePath: 'projects/p1', status: 'idle',
    position: [0, 0], activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '',
  });
  stub.workflowRuns.set('run-1', makeStubRun({ status: 'running' }));
  await useWorldStore.getState().loadWorkflowRunsForProject('p1');

  assert.equal(await useWorldStore.getState().resumeWorkflowRun('run-1'), false, 'a running run can\'t resume');
  assert.match(reportedError() ?? '', /cannot be resumed while running/);

  assert.equal(await useWorldStore.getState().stopWorkflowRun('run-1'), true);
  assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].status, 'stopped');
  assert.equal(Object.keys(useWorldStore.getState().errorNotificationsById).length, 1, 'a success reports nothing new');

  assert.equal(await useWorldStore.getState().stopWorkflowRun('run-1'), false, 'already stopped');
  assert.match(reportedError() ?? '', /cannot be stopped while stopped/);

  assert.equal(await useWorldStore.getState().resumeWorkflowRun('run-1'), true);
  assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].status, 'running');
});

test('approveWorkflowRun reports the error and returns false for an unknown run', async () => {
  installServerStub();
  reset();

  const result = await useWorldStore.getState().approveWorkflowRun('no-such-run');

  assert.equal(result, false);
  assert.match(reportedError() ?? '', /not found/);
});

test('requestChangesWorkflowRun requires a non-empty comment', async () => {
  const stub = installServerStub();
  reset();
  stub.workflowRuns.set('run-1', makeStubRun());

  const result = await useWorldStore.getState().requestChangesWorkflowRun('run-1', '');

  assert.equal(result, false);
  assert.match(reportedError() ?? '', /comment is required/);
});

test('mergeWorkerEvent "workflowRun" updates a known run in place and prepends an unknown one', () => {
  const run1 = { id: 'run-1', projectId: 'p1', status: 'running', createdAt: 't1' };
  const state = { workflowRunsByProject: { p1: [run1] }, workflowRunDetails: {} };

  const updatedRun1 = { ...run1, status: 'completed' };
  const patch = mergeWorkerEvent(state, { type: 'workflowRun', run: updatedRun1 });
  assert.deepEqual(patch.workflowRunsByProject.p1.map((r) => [r.id, r.status]), [['run-1', 'completed']]);

  const run2 = { id: 'run-2', projectId: 'p1', status: 'running', createdAt: 't2' };
  const patch2 = mergeWorkerEvent(
    { workflowRunsByProject: patch.workflowRunsByProject, workflowRunDetails: {} },
    { type: 'workflowRun', run: run2 },
  );
  assert.deepEqual(patch2.workflowRunsByProject.p1.map((r) => r.id), ['run-2', 'run-1']);
});

test('mergeWorkerEvent "workflowRun" also patches a loaded detail\'s .run field, leaving an unloaded one alone', () => {
  const run = { id: 'run-1', projectId: 'p1', status: 'running', createdAt: 't1' };
  const detail = { run, steps: [] };
  const state = { workflowRunsByProject: { p1: [run] }, workflowRunDetails: { 'run-1': detail } };

  const updated = { ...run, status: 'completed' };
  const patch = mergeWorkerEvent(state, { type: 'workflowRun', run: updated });
  assert.equal(patch.workflowRunDetails['run-1'].run.status, 'completed');

  // A run whose detail was never loaded leaves workflowRunDetails untouched entirely (not even present in the patch).
  const other = { id: 'run-2', projectId: 'p1', status: 'running', createdAt: 't2' };
  const patch2 = mergeWorkerEvent(
    { workflowRunsByProject: { p1: [other] }, workflowRunDetails: {} },
    { type: 'workflowRun', run: { ...other, status: 'completed' } },
  );
  assert.equal(patch2.workflowRunDetails, undefined);
});

test('mergeWorkerEvent removes a workflow run rejected during startup', () => {
  const run = { id: 'rejected-run', projectId: 'p1' };
  const state = {
    workflowRunsByProject: { p1: [run] },
    workflowRunDetails: { 'rejected-run': { run, steps: [] } },
  };
  const patch = mergeWorkerEvent(state, { type: 'workflowRunDeleted', runId: run.id, projectId: run.projectId });
  assert.deepEqual(patch.workflowRunsByProject.p1, []);
  assert.deepEqual(patch.workflowRunDetails, {});
});

test('mergeWorkerEvent "stepRun" appends a new round, replaces an existing round by id, and is a no-op when the run\'s detail isn\'t loaded', () => {
  const step = { id: 'dev', name: 'Development' };
  const round1 = { id: 'stepRun-1', runId: 'run-1', stepId: 'dev', round: 1, status: 'running' };
  const detail = { run: { id: 'run-1' }, steps: [{ step, rounds: [round1] }] };
  const state = { workflowRunDetails: { 'run-1': detail } };

  const updatedRound1 = { ...round1, status: 'done' };
  const patch = mergeWorkerEvent(state, { type: 'stepRun', stepRun: updatedRound1 });
  assert.deepEqual(patch.workflowRunDetails['run-1'].steps[0].rounds.map((r) => [r.id, r.status]), [['stepRun-1', 'done']]);

  const round2 = { id: 'stepRun-2', runId: 'run-1', stepId: 'dev', round: 2, status: 'running' };
  const patch2 = mergeWorkerEvent({ workflowRunDetails: patch.workflowRunDetails }, { type: 'stepRun', stepRun: round2 });
  assert.deepEqual(patch2.workflowRunDetails['run-1'].steps[0].rounds.map((r) => r.id), ['stepRun-1', 'stepRun-2']);

  assert.deepEqual(mergeWorkerEvent({ workflowRunDetails: {} }, { type: 'stepRun', stepRun: round1 }), {});
});

test('mergeWorkerEvent "stepRun" with only a changed `progress` field merges via the same replace-by-id path (task 5.017) — no new reducer case needed', () => {
  const step = { id: 'dev', name: 'Development' };
  const round1 = { id: 'stepRun-1', runId: 'run-1', stepId: 'dev', round: 1, status: 'running', progress: null };
  const detail = { run: { id: 'run-1' }, steps: [{ step, rounds: [round1] }] };
  const state = { workflowRunDetails: { 'run-1': detail } };

  const progress = { checklist: [{ text: 'Build it', state: 'in-progress', note: null }], currentActivity: 'Building', estimate: null, estimatedAt: null };
  const patch = mergeWorkerEvent(state, { type: 'stepRun', stepRun: { ...round1, progress } });
  assert.deepEqual(patch.workflowRunDetails['run-1'].steps[0].rounds[0].progress, progress);

  const replaced = { ...progress, currentActivity: 'Running tests' };
  const patch2 = mergeWorkerEvent({ workflowRunDetails: patch.workflowRunDetails }, { type: 'stepRun', stepRun: { ...round1, progress: replaced } });
  assert.deepEqual(patch2.workflowRunDetails['run-1'].steps[0].rounds[0].progress, replaced, 'replaces, never merges with the earlier progress');
});

test('mergeWorkerEvent "stepRun": a new round (progress absent) appended after an earlier round had progress leaves that earlier round untouched and the new one empty', () => {
  const step = { id: 'dev', name: 'Development' };
  const round1 = { id: 'stepRun-1', runId: 'run-1', stepId: 'dev', round: 1, status: 'done', progress: { checklist: [], currentActivity: 'Done working', estimate: null, estimatedAt: null } };
  const detail = { run: { id: 'run-1' }, steps: [{ step, rounds: [round1] }] };
  const state = { workflowRunDetails: { 'run-1': detail } };

  const round2 = { id: 'stepRun-2', runId: 'run-1', stepId: 'dev', round: 2, status: 'running' };
  const patch = mergeWorkerEvent(state, { type: 'stepRun', stepRun: round2 });
  const rounds = patch.workflowRunDetails['run-1'].steps[0].rounds;
  assert.deepEqual(rounds[0].progress, round1.progress, 'round 1 keeps its own progress');
  assert.equal(rounds[1].progress, undefined, 'round 2 starts with none');
});

test('mergeWorkerEvent "workflowRun" carries a live `currentStepProgress` update (task 5.017) into both the project list and a loaded detail, the same as any other run field', () => {
  const run = { id: 'run-1', projectId: 'p1', status: 'running', createdAt: 't1', currentStepProgress: null };
  const detail = { run, steps: [] };
  const state = { workflowRunsByProject: { p1: [run] }, workflowRunDetails: { 'run-1': detail } };

  const updated = { ...run, currentStepProgress: { done: 3, total: 7, estimate: '~10m left' } };
  const patch = mergeWorkerEvent(state, { type: 'workflowRun', run: updated });
  assert.deepEqual(patch.workflowRunsByProject.p1[0].currentStepProgress, { done: 3, total: 7, estimate: '~10m left' });
  assert.deepEqual(patch.workflowRunDetails['run-1'].run.currentStepProgress, { done: 3, total: 7, estimate: '~10m left' });
});
