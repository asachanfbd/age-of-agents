import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
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
const lib = await import('../src/lib/agentSessions.ts');
const { installServerStub } = await import('./serverStub.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const session = (over = {}) => ({ id: 's1', projectId: 'p1', executorId: 'e1', name: 'Terminal 1', state: 'running', createdAt: '2026-10-19T00:00:01.000Z', updatedAt: '2026-10-19T00:00:01.000Z', ...over });

function setup() {
  const stub = installServerStub();
  stub.projects.set('p1', { id: 'p1', typeId: 'software', name: 'p1', readOnly: false, status: 'idle' });
  stub.projects.set('p2', { id: 'p2', typeId: 'software', name: 'p2', readOnly: false, status: 'idle' });
  useWorldStore.setState({ agentSessionsByProject: {} });
  const executorId = [...stub.executors.keys()][0];
  return { stub, executorId };
}
const store = () => useWorldStore.getState();

// ---- Pure view logic ----

test('U16: running sessions come before ended ones, newest first within each group', () => {
  const ordered = lib.orderAgentSessions([
    session({ id: 'old-ended', state: 'ended', createdAt: '2026-10-19T00:00:01Z' }),
    session({ id: 'old-run', createdAt: '2026-10-19T00:00:02Z' }),
    session({ id: 'new-ended', state: 'ended', createdAt: '2026-10-19T00:00:05Z' }),
    session({ id: 'new-run', createdAt: '2026-10-19T00:00:06Z' }),
  ]);
  assert.deepEqual(ordered.map((s) => s.id), ['new-run', 'old-run', 'new-ended', 'old-ended']);
});

test('U17/C2: "Start new" is the first menu row with no sessions and with many', () => {
  assert.deepEqual(lib.agentMenuItems([]), [{ kind: 'start' }]);
  const many = Array.from({ length: 12 }, (_, i) => session({ id: `s${i}` }));
  const items = lib.agentMenuItems(many);
  assert.equal(items[0].kind, 'start');
  assert.equal(items.length, 13);
  assert.ok(items.slice(1).every((item) => item.kind === 'session'));
});

test('C3/C4: the menu shows the default or chosen name and a Running/Ended label', () => {
  assert.equal(lib.agentSessionStateLabel(session()), 'Running');
  assert.equal(lib.agentSessionStateLabel(session({ state: 'ended' })), 'Ended');
  const menu = src('ui/project-popup/HeaderAgentSessions.tsx');
  assert.match(menu, /\{session\.name\}/);
  assert.match(menu, /RunningDot label=\{agentSessionStateLabel\(session\)\}/);
});

test('U21/U22: opening shows the terminal; Back shows the tabs and keeps the session', () => {
  const opened = lib.openAgentView('s1');
  assert.equal(opened.openSessionId, 's1');
  assert.deepEqual(lib.closeAgentView(), lib.NO_AGENT_VIEW);
  assert.equal(lib.afterAgentSessionDeleted(opened, 's2'), opened);
  assert.deepEqual(lib.afterAgentSessionDeleted(opened, 's1'), lib.NO_AGENT_VIEW);
});

test('U22/C11: Back only closes the view; it never ends or deletes the session', () => {
  const view = src('ui/project-popup/AgentTerminalView.tsx');
  assert.match(view, /onClick=\{onBack\}/);
  assert.doesNotMatch(view, /endAgentSession|deleteAgentSession/);
  const modal = src('ui/ProjectWorkspaceModal.tsx');
  assert.match(modal, /onBack=\{\(\) => setAgentView\(closeAgentView\(\)\)\}/);
  assert.match(modal, /agentView\.openSessionId \? \(\s*<AgentTerminalView[\s\S]*?\) : \(\s*<WorkspaceBody/);
  assert.ok(modal.indexOf('<WorkspaceTabBar') < modal.indexOf('<AgentTerminalView'), 'the terminal sits below the tab bar');
});

test('C1/C2: the Agent dropdown follows the Commands controls, and "Start new" is its first, low-key item', () => {
  const modal = src('ui/ProjectWorkspaceModal.tsx');
  assert.ok(modal.indexOf('<HeaderCommands') < modal.indexOf('<HeaderAgentSessions'));
  const menu = src('ui/project-popup/HeaderAgentSessions.tsx');
  assert.ok(menu.indexOf('Start new') < menu.indexOf('rows.map'));
  assert.match(menu, /text-xs text-muted-foreground[^>]*onSelect=\{\(\) => openDialog\(\{ kind: 'start' \}\)\}/);
});

test('C6: the session list scrolls only past the visible-row limit', () => {
  assert.equal(lib.AGENT_MENU_VISIBLE_ROWS, 8);
  assert.match(src('ui/project-popup/HeaderAgentSessions.tsx'), /rows\.length > AGENT_MENU_VISIBLE_ROWS \? 'max-h-72 overflow-y-auto'/);
});

test('C7: each row can rename, end a running session and delete, and delete asks first', () => {
  const menu = src('ui/project-popup/HeaderAgentSessions.tsx');
  for (const label of ['Rename', 'End', 'Delete']) assert.match(menu, new RegExp(`aria-label=\\{\`${label} \\$\\{session.name\\}\`\\}`));
  assert.match(menu, /session\.state === 'running' && \(\s*<Button[^>]*End/);
  assert.match(menu, /openDialog\(\{ kind: 'delete', session \}\)/);
  assert.match(menu, /<ConfirmDialog[\s\S]*?onConfirm=\{\(\) => \{ void remove\(dialog\.session\); \}\}/, 'the store is only called from the confirm button');
  assert.doesNotMatch(menu.slice(0, menu.indexOf('async function remove')), /deleteAgentSession\(/);
});

test('C5: choosing a session resumes an ended one, then opens the terminal view', () => {
  const menu = src('ui/project-popup/HeaderAgentSessions.tsx');
  assert.match(menu, /if \(session\.state === 'running'\) \{ onOpen\(session\.id\); return; \}\s*const result = await resumeAgentSession\(session\);\s*if \(result\.ok\) onOpen/);
});

test('C8/C9/C10/U19/U20: the start dialog uses the shared picker, needs an agent, and keeps a refusal in the dialog', () => {
  const dialog = src('ui/project-popup/AgentSessionDialogs.tsx');
  assert.match(dialog, /import \{ CodingAgentPicker \} from '..\/CodingAgentPicker'/);
  assert.match(dialog, /disabled=\{!executorId \|\| starting\}/);
  assert.match(dialog, /variant="outline" onClick=\{onCancel\}/);
  assert.match(dialog, /setError\(result\.error\);\s*setStarting\(false\)/);
  assert.match(dialog, /<FormErrorAlert message=\{error\} \/>/);
  // The picker is the shared one: it lists usage-limit status per agent and only knows CLI agents (ExecutorProfile.kind is 'claude-cli' | 'codex-cli').
  const picker = src('ui/CodingAgentPicker.tsx');
  assert.match(picker, /ExecutorLimitStatus/);
});

// ---- Store through the stub ----

test('C12: start, list, rename, end, resume and delete go through the daemon and update the list', async () => {
  const { stub, executorId } = setup();
  await store().loadAgentSessions('p1');
  assert.deepEqual(store().agentSessionsByProject.p1, []);

  const started = await store().startAgentSession('p1', executorId);
  assert.ok(started.ok);
  assert.equal(started.session.name, 'Terminal 1');
  assert.deepEqual(store().agentSessionsByProject.p1.map((s) => s.name), ['Terminal 1']);

  const renamed = await store().renameAgentSession(started.session, '  Fix login ');
  assert.ok(renamed.ok);
  assert.equal(store().agentSessionsByProject.p1[0].name, 'Fix login');

  assert.equal((await store().endAgentSession(started.session)).session.state, 'ended');
  assert.equal(store().agentSessionsByProject.p1[0].state, 'ended');
  assert.equal((await store().resumeAgentSession(started.session)).session.state, 'running');

  assert.equal(await store().deleteAgentSession(started.session), true);
  assert.deepEqual(store().agentSessionsByProject.p1, []);
  assert.equal((await store().startAgentSession('p1', executorId)).session.name, 'Terminal 2', 'a deleted number is not reused');
  assert.equal((await store().startAgentSession('p2', executorId)).session.name, 'Terminal 1');
  assert.ok(stub.agentSessions.requests.length > 0);
});

test('C9/C10: a refused start or rename comes back to the caller with the daemon\'s reason', async () => {
  const { stub, executorId } = setup();
  stub.agentSessions.failStart = 'Claude is at its usage limit';
  assert.deepEqual(await store().startAgentSession('p1', executorId), { ok: false, error: 'Claude is at its usage limit' });
  stub.agentSessions.failStart = null;
  const { session: made } = await store().startAgentSession('p1', executorId);
  assert.deepEqual(await store().renameAgentSession(made, '   '), { ok: false, error: 'name must not be empty' });
  assert.equal(store().agentSessionsByProject.p1[0].name, 'Terminal 1');
});

test('C12/C13: a live rename event, in the daemon\'s own shape, updates the list; a delete event removes it', () => {
  const base = { agentSessionsByProject: { p1: [session()] } };
  const renamed = mergeWorkerEvent({ ...cleanState(), ...base }, { type: 'agentSession', session: session({ name: 'Fix login', updatedAt: '2026-10-19T00:05:00.000Z' }) });
  assert.equal(renamed.agentSessionsByProject.p1[0].name, 'Fix login');
  const added = mergeWorkerEvent({ ...cleanState(), ...base }, { type: 'agentSession', session: session({ id: 's2', name: 'Terminal 2' }) });
  assert.deepEqual(added.agentSessionsByProject.p1.map((s) => s.id), ['s1', 's2']);
  const removed = mergeWorkerEvent({ ...cleanState(), ...base }, { type: 'agentSessionDeleted', id: 's1', projectId: 'p1' });
  assert.deepEqual(removed.agentSessionsByProject.p1, []);
  assert.deepEqual(mergeWorkerEvent({ ...cleanState(), agentSessionsByProject: {} }, { type: 'agentSession', session: session() }), {}, 'a never-loaded project ignores events');
});

test('C14: streamed terminal output is not a session event, so the list is not touched', () => {
  const state = { ...cleanState(), agentSessionsByProject: { p1: [session()] } };
  const patch = mergeWorkerEvent(state, { type: 'commandRunLog', runId: 'r', projectId: 'p1', chunk: 'x' });
  assert.equal(patch.agentSessionsByProject, undefined);
});

function cleanState() {
  const s = useWorldStore.getState();
  return {
    projects: s.projects, tasksById: s.tasksById, taskIdsByProject: s.taskIdsByProject, lastTaskIdByProject: s.lastTaskIdByProject, transcriptsByTask: s.transcriptsByTask,
    planByProject: s.planByProject, commandRunsById: s.commandRunsById, commandRunIdsByProject: s.commandRunIdsByProject, catalogInstallRuns: s.catalogInstallRuns,
    notificationsById: s.notificationsById, workflowRunsByProject: s.workflowRunsByProject, workflowRunDetails: s.workflowRunDetails, testRunsById: s.testRunsById,
    testRunDetailsById: s.testRunDetailsById, testRunLogsById: s.testRunLogsById, errorNotificationsById: s.errorNotificationsById, errorNotificationSeq: s.errorNotificationSeq,
  };
}
