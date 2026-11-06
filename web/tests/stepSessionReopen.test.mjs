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

const { stepSessionAction, reopenStepSession, stopStepSession } = await import('../src/lib/stepSessionReopen.ts');
const sessionBody = await readFile(new URL('../src/ui/project-popup/TaskDetailsView.tsx', import.meta.url), 'utf8');
const terminal = await readFile(new URL('../src/ui/TaskTerminal.tsx', import.meta.url), 'utf8');
const connection = await readFile(new URL('../src/lib/terminalReconnect.ts', import.meta.url), 'utf8');
const runView = await readFile(new URL('../src/ui/project-popup/WorkflowRunView.tsx', import.meta.url), 'utf8');

const stepTask = (patch = {}) => ({ status: 'done', workflowRunId: 'run-1', sessionId: 'session-1', executionMode: 'terminal', ...patch });

test('Resume session shows for a settled workflow step whose session has ended and has a session id', () => {
  for (const status of ['done', 'failed', 'stopped']) assert.equal(stepSessionAction(stepTask({ status }), 'ended'), 'resume', status);
});

test('once the reopened session is live, Resume swaps to Stop session; nothing shows before the terminal reports', () => {
  assert.equal(stepSessionAction(stepTask(), 'live'), 'stop');
  assert.equal(stepSessionAction(stepTask(), 'unknown'), null);
});

test('neither control shows for a still-running step, without a session id, outside a workflow, or for a non-terminal task', () => {
  for (const state of ['ended', 'live']) {
    assert.equal(stepSessionAction(stepTask({ status: 'developing' }), state), null, 'its own step session is not an inspect session');
    assert.equal(stepSessionAction(stepTask({ status: 'blocked' }), state), null);
    assert.equal(stepSessionAction(stepTask({ sessionId: null }), state), null);
    assert.equal(stepSessionAction(stepTask({ sessionId: undefined }), state), null);
    assert.equal(stepSessionAction(stepTask({ workflowRunId: null }), state), null);
    assert.equal(stepSessionAction(stepTask({ executionMode: 'structured' }), state), null);
  }
});

test('clicking Resume session calls the reopen endpoint for that step task', async () => {
  const calls = [];
  const outcome = await reopenStepSession('task-7', async (id) => { calls.push(id); return { location: 'worktree', mode: 'permissions' }; });
  assert.deepEqual(calls, ['task-7']);
  assert.deepEqual(outcome, { ok: true, note: null });
});

test('a session reopened in the project folder says why, in words', async () => {
  const outcome = await reopenStepSession('task-7', async () => ({ location: 'project', mode: 'read-only' }));
  assert.equal(outcome.ok, true);
  assert.match(outcome.note, /project folder/);
});

test('a recreated working copy is identified and the exact reopen mode is sent', async () => {
  const sent = [];
  const outcome = await reopenStepSession('task-7', async (taskId, mode) => {
    sent.push({ taskId, mode });
    return { location: 'recreated-worktree', mode };
  }, 'permissions');
  assert.deepEqual(sent, [{ taskId: 'task-7', mode: 'permissions' }]);
  assert.match(outcome.note, /recreated from the task branch/);
});

test('a missing branch reason stays visible after the read-only fallback opens', async () => {
  const reason = 'Branch "task/5-010" is gone locally and on the remote. This session can open read-only in the project folder.';
  const outcome = await reopenStepSession('task-7', async () => ({ location: 'project', mode: 'read-only', reason }), 'read-only');
  assert.deepEqual(outcome, { ok: true, note: reason });
});

test('a refused reopen surfaces the server\'s message', async () => {
  const message = 'Task "Fix login" can\'t be reopened: neither its worktree nor project "Shop"\'s folder exists any more';
  const outcome = await reopenStepSession('task-7', async () => { throw new Error(message); });
  assert.deepEqual(outcome, { ok: false, error: message });
});

test('clicking Stop session calls the close endpoint for that step task, and surfaces a refusal', async () => {
  const calls = [];
  assert.deepEqual(await stopStepSession('task-7', async (id) => { calls.push(id); }), { ok: true, note: null });
  assert.deepEqual(calls, ['task-7']);
  const refused = await stopStepSession('task-7', async () => { throw new Error('Task "Fix login" has no reopened session to stop'); });
  assert.deepEqual(refused, { ok: false, error: 'Task "Fix login" has no reopened session to stop' });
});

test('Resume/Stop sit in the floating top-right cluster beside the run view\'s toggle, sized like it, with no bottom-right copy', () => {
  assert.match(sessionBody, /<FloatingControls below=\{below\}>[\s\S]*?size="sm"\s*className="h-7 shadow-sm"[\s\S]*?\{controls\}\s*<\/FloatingControls>/);
  assert.match(sessionBody, /await serverApi\.stepReopenOptions\(task\.id\)/);
  assert.match(sessionBody, /reopenStepSession\(task\.id, serverApi\.reopenStepSession, mode\)/);
  assert.match(sessionBody, /resume \? 'Resume session' : 'Stop session'/);
  assert.match(sessionBody, /<StepSessionControls task=\{task\} state=\{sessionState\} controls=\{controls\} onReopened=\{\(\) => setSessionState\('unknown'\)\} \/>/);
  assert.doesNotMatch(sessionBody, /terminalKey/, 'a reopened session reconnects through the live-session snapshots, not a remount');
  assert.match(sessionBody, /role=\{shownMessage\.failed \? 'alert' : 'status'\}/, 'a refusal is announced inline');
  assert.doesNotMatch(sessionBody, /bottom-3/, 'the old bottom-right placement is gone');
});

test('completed editable step choice is accessible and missing branches remove the writable choice', () => {
  assert.match(sessionBody, /if \(options\.choiceRequired\) \{ setChoice\(options\); finishBusy\(\); return; \}/);
  assert.match(sessionBody, /<DialogTitle>Resume session<\/DialogTitle>/);
  assert.match(sessionBody, /task branch may already be merged/);
  assert.match(sessionBody, /setChoice\(null\).*?>Cancel<\/Button>/);
  assert.match(sessionBody, />Read-only<\/Button>/);
  assert.match(sessionBody, /choice\?\.permissionsAvailable && <Button.*>With permissions<\/Button>/);
  assert.match(sessionBody, /disabled=\{busy\}/);
});

test('dirty reopened work is shown on run details until commit or discard succeeds', () => {
  assert.match(runView, /run\.pendingInspectChanges && <PendingInspectChanges/);
  assert.match(runView, /serverApi\.resolveStepInspectChanges\(run\.id, decision\)/);
  assert.match(runView, /'commit-push'/);
  assert.match(runView, /'discard'/);
  assert.match(runView, /role="alert"/);
  assert.match(runView, /Retry cleanup/);
});

test('the terminal reports live/ended from the daemon\'s frames, and an unavailable session as ended', () => {
  assert.match(connection, /message\.type === 'live' \|\| message\.type === 'ended'\) deps\.onSessionState\(message\.type\)/);
  assert.match(connection, /message\.type === 'error'\) \{\s*deps\.onSessionState\('ended'\);/);
  assert.match(terminal, /onSessionState: \(state\) => onSessionStateRef\.current\?\.\(state\)/);
});
