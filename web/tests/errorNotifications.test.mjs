import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
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

const lib = await import('../src/lib/errorNotifications.ts');
const { countUnreadNotifications, filterNotifications, DEFAULT_NOTIFICATION_DRAWER_FILTER, quickActionFor } = await import('../src/lib/notificationCenter.ts');
const { useWorldStore, mergeWorkerEvent, highestOpenSeverity, openNotificationsForProject, reportError } = await import('../src/store/worldStore.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { reportedError, CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

const empty = () => ({ errorNotificationsById: {}, errorNotificationSeq: 0 });
const at = (ms) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));
const add = (state, message, context = {}, ms = 0) => {
  const result = lib.addErrorNotification(state, message, context, at(ms));
  return { state: { errorNotificationsById: result.errorNotificationsById, errorNotificationSeq: result.errorNotificationSeq }, created: result.created };
};

// ---- creating ----

test('a new error is an unread Warning notification for the project it was about', () => {
  const { state, created } = add(empty(), 'boom', { projectId: 'p1', action: 'loadPlan' });
  const [n] = Object.values(state.errorNotificationsById);
  assert.equal(created, true);
  assert.deepEqual(
    { kind: n.kind, severity: n.severity, projectId: n.projectId, title: n.title, description: n.description, readAt: n.readAt, resolvedAt: n.resolvedAt, count: n.count },
    { kind: 'app.error', severity: 'warning', projectId: 'p1', title: "Couldn't load plan", description: 'boom', readAt: null, resolvedAt: null, count: 1 },
  );
  assert.equal(lib.isErrorNotification(n), true);
});

test('an error without a project is a system one, titled generically when nothing better is known', () => {
  const { state } = add(empty(), 'down');
  const [n] = Object.values(state.errorNotificationsById);
  assert.equal(n.projectId, null);
  assert.equal(n.title, 'Something went wrong');
});

test('an explicit title wins over the action-derived one', () => {
  const { state } = add(empty(), 'x', { action: 'loadPlan', title: 'Planning session failed' });
  assert.equal(Object.values(state.errorNotificationsById)[0].title, 'Planning session failed');
});

test('errorTitleForAction turns a store action name into a sentence', () => {
  assert.equal(lib.errorTitleForAction('loadProjects'), "Couldn't load projects");
  assert.equal(lib.errorTitleForAction('approveWorkflowRun'), "Couldn't approve workflow run");
  assert.equal(lib.errorTitleForAction(undefined), lib.GENERIC_ERROR_TITLE);
});

test('errorMessage reads an Error, or stringifies anything else', () => {
  assert.equal(lib.errorMessage(new Error('a')), 'a');
  assert.equal(lib.errorMessage('b'), 'b');
});

// ---- merging ----

test('a repeat of an unread error updates the existing entry: count up, moved to latest, no new toast', () => {
  const first = add(empty(), 'boom', { projectId: 'p1' }, 0);
  const other = add(first.state, 'other', { projectId: 'p1' }, 10);
  const repeat = add(other.state, 'boom', { projectId: 'p1' }, 20);
  assert.equal(repeat.created, false);
  const entries = Object.values(repeat.state.errorNotificationsById);
  assert.equal(entries.length, 2);
  const merged = entries.find((n) => n.description === 'boom');
  assert.equal(merged.count, 2);
  assert.equal(merged.updatedAt, at(20).toISOString());
  assert.equal(merged.createdAt, at(0).toISOString());
  assert.equal(repeat.state.errorNotificationSeq, 2, 'no id was spent on the merge');
  assert.equal(filterNotifications(repeat.state.errorNotificationsById, DEFAULT_NOTIFICATION_DRAWER_FILTER)[0].id, merged.id, 'newest by latest occurrence first');
});

test('after the user read it, the same error makes a new unread entry (and toasts again)', () => {
  const first = add(empty(), 'boom', {}, 0);
  const [id] = Object.keys(first.state.errorNotificationsById);
  const read = { ...first.state, errorNotificationsById: lib.setErrorNotificationsRead(first.state.errorNotificationsById, [id], true, at(5)) };
  const again = add(read, 'boom', {}, 10);
  assert.equal(again.created, true);
  assert.equal(Object.keys(again.state.errorNotificationsById).length, 2);
});

test('a different project or a different message is a separate entry', () => {
  let s = add(empty(), 'boom', { projectId: 'p1' }, 0).state;
  s = add(s, 'boom', { projectId: 'p2' }, 1).state;
  s = add(s, 'boom', {}, 2).state;
  s = add(s, 'other', { projectId: 'p1' }, 3).state;
  assert.equal(Object.keys(s.errorNotificationsById).length, 4);
});

test('timestamps never tie: an occurrence in the same millisecond still sorts as the newest', () => {
  let s = add(empty(), 'a', {}, 5).state;
  s = add(s, 'b', {}, 5).state;
  const ordered = filterNotifications(s.errorNotificationsById, DEFAULT_NOTIFICATION_DRAWER_FILTER);
  assert.deepEqual(ordered.map((n) => n.description), ['b', 'a']);
});

// ---- cap ----

test('only the latest 100 are kept; the oldest drop off', () => {
  let s = empty();
  for (let i = 0; i < 105; i += 1) s = add(s, `error ${i}`, {}, i).state;
  const entries = Object.values(s.errorNotificationsById);
  assert.equal(entries.length, lib.MAX_ERROR_NOTIFICATIONS);
  const messages = new Set(entries.map((n) => n.description));
  assert.equal(messages.has('error 0'), false);
  assert.equal(messages.has('error 4'), false);
  assert.equal(messages.has('error 5'), true);
  assert.equal(messages.has('error 104'), true);
});

// ---- routing ----

const routing = (patch = {}) => ({ ...empty(), openErrorScopes: {}, formErrors: {}, ...patch });

test('a failure goes to its form while that form is open, and creates no notification', () => {
  const patch = lib.routeError(routing({ openErrorScopes: { commands: 1 } }), 'bad', { action: 'createCommand' }, 'commands', at(0));
  assert.deepEqual(patch, { formErrors: { commands: 'bad' } });
});

test('a failure after its form closed becomes a notification', () => {
  const patch = lib.routeError(routing({ openErrorScopes: { commands: 0 } }), 'bad', { action: 'createCommand' }, 'commands', at(0));
  assert.equal(Object.values(patch.errorNotificationsById)[0].description, 'bad');
  assert.equal('created' in patch, false);
});

test('an action with no scope always notifies, even if some other form is open', () => {
  const patch = lib.routeError(routing({ openErrorScopes: { commands: 1 } }), 'bad', { action: 'loadPlan' }, undefined, at(0));
  assert.equal(Object.keys(patch.errorNotificationsById).length, 1);
});

// ---- read state and toasts ----

test('setErrorNotificationsRead marks read or unread and ignores unknown ids', () => {
  const { state } = add(empty(), 'boom', {}, 0);
  const [id] = Object.keys(state.errorNotificationsById);
  const read = lib.setErrorNotificationsRead(state.errorNotificationsById, [id, 'nope'], true, at(9));
  assert.equal(read[id].readAt, at(9).toISOString());
  assert.equal(lib.setErrorNotificationsRead(read, [id], false, at(10))[id].readAt, null);
});

test('errorNotificationsToToast lists unread entries not yet toasted, oldest first, never a merged repeat', () => {
  let s = add(empty(), 'a', {}, 0).state;
  s = add(s, 'b', {}, 1).state;
  const idA = Object.values(s.errorNotificationsById).find((n) => n.description === 'a').id;
  assert.deepEqual(lib.errorNotificationsToToast(s.errorNotificationsById, new Set()).map((n) => n.description), ['a', 'b']);
  s = add(s, 'a', {}, 2).state;
  assert.deepEqual(lib.errorNotificationsToToast(s.errorNotificationsById, new Set([idA])).map((n) => n.description), ['b']);
  const read = lib.setErrorNotificationsRead(s.errorNotificationsById, Object.keys(s.errorNotificationsById), true, at(3));
  assert.deepEqual(lib.errorNotificationsToToast(read, new Set()), []);
});

// ---- drawer helpers over mixed notifications ----

const daemonNotification = (patch = {}) => ({
  id: 'd1', kind: 'task.failed', severity: 'critical', subject: { type: 'project', projectId: 'p1' }, projectId: 'p1',
  title: 't', description: 'd', readAt: null, resolvedAt: null, createdAt: at(0).toISOString(), updatedAt: at(0).toISOString(), ...patch,
});

test('the unread badge counts error notifications too', () => {
  const { state } = add(empty(), 'boom', {}, 1);
  assert.equal(countUnreadNotifications({ d1: daemonNotification(), d2: daemonNotification({ id: 'd2', readAt: 'x' }) }, state.errorNotificationsById), 2);
  assert.equal(countUnreadNotifications({ d1: daemonNotification() }), 1);
});

test('the drawer filters work across daemon and error notifications', () => {
  const { state } = add(empty(), 'boom', { projectId: 'p1' }, 5);
  const mixed = { d1: daemonNotification(), ...state.errorNotificationsById };
  const all = filterNotifications(mixed, DEFAULT_NOTIFICATION_DRAWER_FILTER);
  assert.deepEqual(all.map((n) => n.id), [Object.keys(state.errorNotificationsById)[0], 'd1']);
  assert.deepEqual(filterNotifications(mixed, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, severity: 'warning' }).map((n) => n.kind), ['app.error']);
  assert.deepEqual(filterNotifications(mixed, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, state: 'active' }).length, 2);
  assert.deepEqual(filterNotifications(mixed, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, state: 'resolved' }), []);
  const system = add(empty(), 'down', {}, 6).state.errorNotificationsById;
  assert.equal(filterNotifications(system, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, project: 'none' }).length, 1);
  assert.equal(filterNotifications(system, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, project: 'p1' }).length, 0);
});

test('an error notification offers no quick action', () => {
  assert.equal(quickActionFor({ kind: 'app.error', resolvedAt: null }), null);
});

// ---- store ----

function resetStore() {
  useWorldStore.setState({
    projects: [], tasksById: {}, transcriptsByTask: {}, planByProject: {}, notificationsById: {}, workspaceProjectId: null,
    ...CLEAN_ERROR_STATE,
  });
}

const failingFetch = (status = 500, error = 'daemon unreachable') => async () => new Response(JSON.stringify({ error }), { status });

test('a failed background load becomes an error notification for its project, not a form error', async () => {
  resetStore();
  globalThis.fetch = failingFetch();
  await useWorldStore.getState().loadPlan('p9');
  const [n] = Object.values(useWorldStore.getState().errorNotificationsById);
  assert.equal(n.projectId, 'p9');
  assert.equal(n.description, 'daemon unreachable');
  assert.deepEqual(useWorldStore.getState().formErrors, {});
});

test('a burst of identical failures merges into one entry with a count', async () => {
  resetStore();
  globalThis.fetch = failingFetch();
  await Promise.all([1, 2, 3].map(() => useWorldStore.getState().loadPlan('p9')));
  const entries = Object.values(useWorldStore.getState().errorNotificationsById);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 3);
});

test('a form action failing while its form is open stays in the form only', async () => {
  resetStore();
  globalThis.fetch = failingFetch(400, 'label is required');
  const close = useWorldStore.getState().openErrorScope('agents');
  assert.equal(await useWorldStore.getState().addExecutor({}), false);
  assert.equal(useWorldStore.getState().formErrors.agents, 'label is required');
  assert.equal(reportedError(), null, 'no notification');
  close();
});

test('a form error never shows in another form, and clears when a form opens or the action is retried', async () => {
  resetStore();
  globalThis.fetch = failingFetch(400, 'label is required');
  const close = useWorldStore.getState().openErrorScope('agents');
  const closeCatalog = useWorldStore.getState().openErrorScope('catalog');
  await useWorldStore.getState().addExecutor({});
  assert.equal(useWorldStore.getState().formErrors.catalog, undefined, 'another scope sees nothing');
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'e1', label: 'x' }), { status: 201 });
  await useWorldStore.getState().addExecutor({});
  assert.equal(useWorldStore.getState().formErrors.agents, undefined, 'a retry clears the old failure');
  globalThis.fetch = failingFetch(400, 'again');
  await useWorldStore.getState().addExecutor({});
  close();
  assert.equal(useWorldStore.getState().formErrors.agents, 'again');
  useWorldStore.getState().openErrorScope('agents');
  assert.equal(useWorldStore.getState().formErrors.agents, undefined, 'reopening starts clean');
  closeCatalog();
});

test('a form action failing after its form closed becomes a notification', async () => {
  resetStore();
  globalThis.fetch = failingFetch(400, 'label is required');
  const close = useWorldStore.getState().openErrorScope('agents');
  close();
  await useWorldStore.getState().addExecutor({});
  assert.equal(reportedError(), 'label is required');
  assert.equal(useWorldStore.getState().formErrors.agents, undefined);
});

test('two forms on one scope keep it open until both close', () => {
  resetStore();
  const closeA = useWorldStore.getState().openErrorScope('commands');
  const closeB = useWorldStore.getState().openErrorScope('commands');
  closeA();
  assert.equal(useWorldStore.getState().openErrorScopes.commands, 1);
  closeB();
  assert.equal(useWorldStore.getState().openErrorScopes.commands, 0);
});

test('reportError routes a message that is not an Error object too', () => {
  resetStore();
  reportError(useWorldStore.setState, useWorldStore.getState, 'plain text', { action: 'loadPlan' });
  assert.equal(reportedError(), 'plain text');
});

test('error notifications never touch building severity or daemon notifications', () => {
  resetStore();
  useWorldStore.setState({ notificationsById: { d1: daemonNotification({ severity: 'info' }) } });
  reportError(useWorldStore.setState, useWorldStore.getState, new Error('boom'), { action: 'loadPlan', projectId: 'p1' });
  const { notificationsById } = useWorldStore.getState();
  assert.deepEqual(Object.keys(notificationsById), ['d1']);
  assert.equal(highestOpenSeverity(notificationsById, 'p1'), 'info');
  assert.equal(openNotificationsForProject(notificationsById, 'p1').length, 1);
});

// ---- reading, mark-all, opening: browser only ----

async function withDaemonCallsTracked(run) {
  const calls = [];
  const originals = {};
  for (const name of ['markNotificationsRead', 'markNotificationUnread', 'markAllNotificationsRead']) {
    originals[name] = serverApi[name];
    serverApi[name] = async (...args) => { calls.push(name); return originals[name](...args); };
  }
  try { await run(); } finally { Object.assign(serverApi, originals); }
  return calls;
}

function seedError(message, projectId) {
  reportError(useWorldStore.setState, useWorldStore.getState, new Error(message), { action: 'loadPlan', projectId });
  return Object.values(useWorldStore.getState().errorNotificationsById).find((n) => n.description === message);
}

test('read, unread and mark-all on error notifications never call the daemon', async () => {
  installServerStub();
  resetStore();
  const a = seedError('a');
  const b = seedError('b', 'p1');
  const calls = await withDaemonCallsTracked(async () => {
    await useWorldStore.getState().markNotificationsRead([a.id]);
    assert.notEqual(useWorldStore.getState().errorNotificationsById[a.id].readAt, null);
    await useWorldStore.getState().markNotificationUnread(a.id);
    assert.equal(useWorldStore.getState().errorNotificationsById[a.id].readAt, null);
    await useWorldStore.getState().markAllNotificationsRead({ read: false, projectId: 'p1' });
    assert.notEqual(useWorldStore.getState().errorNotificationsById[b.id].readAt, null);
    assert.equal(useWorldStore.getState().errorNotificationsById[a.id].readAt, null, 'the filter was respected');
    await useWorldStore.getState().markAllNotificationsRead({ read: false });
    assert.notEqual(useWorldStore.getState().errorNotificationsById[a.id].readAt, null);
  });
  assert.deepEqual(calls, []);
});

test('a mixed read sends only the daemon ids to the daemon', async () => {
  const stub = installServerStub();
  resetStore();
  const err = seedError('a');
  const daemon = stub.raiseNotification({ kind: 'task.failed', subject: { type: 'project', projectId: 'p1' }, title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();
  const calls = await withDaemonCallsTracked(() => useWorldStore.getState().markNotificationsRead([err.id, daemon.id]));
  assert.deepEqual(calls, ['markNotificationsRead']);
  assert.notEqual(useWorldStore.getState().errorNotificationsById[err.id].readAt, null);
  assert.notEqual(useWorldStore.getState().notificationsById[daemon.id].readAt, null);
});

test('mark-all marks both kinds when both match', async () => {
  const stub = installServerStub();
  resetStore();
  const err = seedError('a', 'p1');
  const daemon = stub.raiseNotification({ kind: 'task.failed', subject: { type: 'project', projectId: 'p1' }, title: 't', description: 'd' });
  await useWorldStore.getState().loadNotifications();
  await useWorldStore.getState().markAllNotificationsRead({ read: false });
  assert.notEqual(useWorldStore.getState().errorNotificationsById[err.id].readAt, null);
  assert.notEqual(useWorldStore.getState().notificationsById[daemon.id].readAt, null);
});

test('clicking an error with a project opens that project and marks it read', async () => {
  installServerStub();
  resetStore();
  const n = seedError('boom', 'p1');
  const calls = await withDaemonCallsTracked(() => useWorldStore.getState().openNotificationTarget(n));
  assert.equal(useWorldStore.getState().workspaceProjectId, 'p1');
  assert.notEqual(useWorldStore.getState().errorNotificationsById[n.id].readAt, null);
  assert.deepEqual(calls, []);
});

test('clicking a system error only marks it read', async () => {
  installServerStub();
  resetStore();
  const n = seedError('boom');
  await useWorldStore.getState().openNotificationTarget(n);
  assert.equal(useWorldStore.getState().workspaceProjectId, null);
  assert.notEqual(useWorldStore.getState().errorNotificationsById[n.id].readAt, null);
});

test('quick-action on an error entry does nothing', async () => {
  resetStore();
  const n = seedError('boom');
  await useWorldStore.getState().runNotificationQuickAction(n);
  assert.equal(useWorldStore.getState().errorNotificationsById[n.id].readAt, null);
});

// ---- transcript ----

test('a task with no transcript yet loads as an empty session with no error', async () => {
  const stub = installServerStub();
  resetStore();
  useWorldStore.setState({ tasksById: { t1: { id: 't1', projectId: 'p1' } } });
  stub.transcripts.delete('t1');
  await useWorldStore.getState().loadTranscript('t1');
  assert.deepEqual(useWorldStore.getState().transcriptsByTask.t1, []);
  assert.equal(reportedError(), null);
});

test('an empty-transcript 404 does not wipe turns that already arrived live', async () => {
  const stub = installServerStub();
  resetStore();
  useWorldStore.setState({ tasksById: { t1: { id: 't1', projectId: 'p1' } }, transcriptsByTask: { t1: [{ role: 'assistant' }] } });
  stub.transcripts.delete('t1');
  await useWorldStore.getState().loadTranscript('t1');
  assert.equal(useWorldStore.getState().transcriptsByTask.t1.length, 1);
});

test('a transcript for an unknown task is a genuine failure and notifies', async () => {
  installServerStub();
  resetStore();
  await useWorldStore.getState().loadTranscript('ghost');
  assert.match(reportedError() ?? '', /not found/);
});

test('a network failure loading a transcript still notifies, even for a known task', async () => {
  resetStore();
  useWorldStore.setState({ tasksById: { t1: { id: 't1', projectId: 'p1' } } });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await useWorldStore.getState().loadTranscript('t1');
  assert.equal(reportedError(), 'Failed to fetch');
  assert.equal(useWorldStore.getState().transcriptsByTask.t1, undefined);
});

// ---- planning completion event ----

test('a planning session completion error event becomes an error notification for its project', () => {
  const patch = mergeWorkerEvent({ ...empty(), planByProject: {} }, { type: 'planningCompletionError', projectId: 'p1', session: 4, message: 'persist failed' });
  const [n] = Object.values(patch.errorNotificationsById);
  assert.equal(n.projectId, 'p1');
  assert.equal(n.title, 'Planning session failed');
  assert.match(n.description, /planning session 4: persist failed/);
  assert.equal(n.severity, 'warning');
});

test('a repeated planning completion error while unread merges instead of adding', () => {
  const first = mergeWorkerEvent({ ...empty() }, { type: 'planningCompletionError', projectId: 'p1', session: 4, message: 'x' });
  const second = mergeWorkerEvent({ ...empty(), ...first }, { type: 'planningCompletionError', projectId: 'p1', session: 4, message: 'x' });
  assert.equal(Object.values(second.errorNotificationsById).length, 1);
  assert.equal(Object.values(second.errorNotificationsById)[0].count, 2);
});

// ---- component wiring (source checks; web tests have no DOM) ----

const src = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the drawer lists error notifications and no longer echoes a global error', async () => {
  const drawer = await src('ui/NotificationCenter.tsx');
  assert.doesNotMatch(drawer, /lastError|role="alert"/);
  assert.match(drawer, /\{ \.\.\.notificationsById, \.\.\.errorNotificationsById \}/);
  assert.match(drawer, /notification\.count > 1/);
  assert.match(drawer, /case 'error':/);
});

test('the footer counts error notifications and has no error box', async () => {
  const footer = await src('ui/StatusFooter.tsx');
  assert.match(footer, /countUnreadNotifications\(notificationsById, errorNotificationsById\)/);
  assert.doesNotMatch(footer, /lastError|LastErrorAlert/);
});

test('toasts cover error notifications, once each, auto-hiding like other warnings', async () => {
  const toasts = await src('ui/NotificationToasts.tsx');
  assert.match(toasts, /errorNotificationsToToast\(errorNotificationsById, toastedRef\.current\)/);
  assert.match(toasts, /toast\.warning\(notification\.title/);
  assert.match(toasts, /TOAST_AUTO_DISMISS_MS/);
});

test('no component reads a global last error any more', async () => {
  for (const path of ['ui/TopBar.tsx', 'ui/AgentsSettings.tsx', 'ui/CatalogModal.tsx', 'ui/project-popup/commands/CommandsPanel.tsx', 'ui/project-popup/commands/CommandDialogs.tsx', 'ui/project-popup/TestingPanel.tsx', 'ui/project-popup/quick-look/QuickLookCommands.tsx', 'ui/project-popup/WorkflowRunView.tsx', 'ui/project-popup/useTaskActions.ts']) {
    assert.doesNotMatch(await src(path), /s\.lastError|getState\(\)\.lastError/, path);
  }
});

test('each form shows only its own scope', async () => {
  const expectations = [
    ['ui/TopBar.tsx', "useErrorScope('newProject')"],
    ['ui/AgentsSettings.tsx', "useErrorScope('agents')"],
    ['ui/CatalogModal.tsx', "useErrorScope('catalog')"],
    ['ui/project-popup/commands/CommandsPanel.tsx', "useErrorScope('commands')"],
    ['ui/project-popup/commands/CommandDialogs.tsx', "useErrorScope('commands')"],
    ['ui/project-popup/SetupProposalDecision.tsx', "useErrorScope('testingDecision')"],
    ['ui/project-popup/TestingPanel.tsx', "useErrorScope('testing')"],
    ['ui/project-popup/quick-look/QuickLookCommands.tsx', "useErrorScope('quickLook')"],
    ['ui/project-popup/WorkflowRunView.tsx', "useErrorScope('workflowRun')"],
    ['ui/project-popup/useTaskActions.ts', "useErrorScope('taskActions')"],
  ];
  for (const [path, hook] of expectations) assert.ok((await src(path)).includes(hook), `${path} registers ${hook}`);
  assert.match(await src('ui/project-popup/quick-look/QuickLookCommands.tsx'), /formErrors\.quickLook/);
  assert.match(await src('ui/project-popup/TestingPanel.tsx'), /formErrors\.testing\b/);
});

test('inline form errors use the shared alert with explicit destructive text', async () => {
  const alert = await src('ui/FormErrorAlert.tsx');
  assert.match(alert, /AlertDescription className="text-destructive"/);
  assert.match(alert, /if \(!message\) return null;/);
});
