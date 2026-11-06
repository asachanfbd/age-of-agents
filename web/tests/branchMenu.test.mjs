import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const { isProjectFolderBusy } = await import('../src/lib/branchMenu.ts');
const { mergeWorkerEvent } = await import('../src/store/worldStore.ts');

/**
 * Pure-logic coverage for the branch menu's folder-busy predicate — the client-side mirror of the
 * daemon's `isProjectFolderBusy` (server/src/worker/projectFolderGuard.ts). Sync and switching to an
 * existing branch are driven by this instead of the Project's overall `status`, so a planning session
 * never disables them while a Task or WorkflowRun really working in the Project's own folder does.
 */

function task(overrides) {
  return { kind: 'execute', status: 'developing', worktreePath: undefined, ...overrides };
}

function run(overrides) {
  return { worktreePath: undefined, status: 'running', ...overrides };
}

test('W1: only planning-kind tasks, in any status, never make the folder busy', () => {
  assert.equal(isProjectFolderBusy([task({ kind: 'plan', status: 'developing' })], []), false);
  assert.equal(isProjectFolderBusy([task({ kind: 'plan', status: 'blocked' })], []), false);
  assert.equal(isProjectFolderBusy([task({ kind: 'plan', status: 'done' })], []), false);
});

test('W2: only tasks with worktreePath set never make the folder busy', () => {
  assert.equal(isProjectFolderBusy([task({ worktreePath: '/tmp/wt' })], []), false);
});

test('W3: only workflow runs with worktreePath set never make the folder busy', () => {
  assert.equal(isProjectFolderBusy([], [run({ worktreePath: '/tmp/wt-run', status: 'awaiting-approval' })]), false);
});

test('W4: a non-plan task with no worktreePath, developing or blocked, makes the folder busy', () => {
  assert.equal(isProjectFolderBusy([task({ status: 'developing' })], []), true);
  assert.equal(isProjectFolderBusy([task({ status: 'blocked' })], []), true);
});

test('W5: a workflow run with no worktreePath and an unsettled status makes the folder busy', () => {
  for (const status of ['running', 'awaiting-approval', 'needs-attention', 'completing']) {
    assert.equal(isProjectFolderBusy([], [run({ status })]), true, status);
  }
});

test('W6: a workflow run with no worktreePath but a settled status never makes the folder busy', () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    assert.equal(isProjectFolderBusy([], [run({ status })]), false, status);
  }
});

test('W7: settled tasks with no worktreePath never make the folder busy', () => {
  for (const status of ['done', 'failed', 'stopped']) {
    assert.equal(isProjectFolderBusy([task({ status })], []), false, status);
  }
});

test('W8: mixed planning + folder task is busy; mixed planning + worktree-only task is not', () => {
  assert.equal(isProjectFolderBusy([task({ kind: 'plan' }), task({ status: 'developing' })], []), true);
  assert.equal(isProjectFolderBusy([task({ kind: 'plan' }), task({ status: 'developing', worktreePath: '/tmp/wt' })], []), false);
});

test('W9: a live task-event update flips the predicate from busy to free once the folder Task settles', () => {
  const state = { projects: [], tasksById: {}, taskIdsByProject: { p1: ['t1'] }, lastTaskIdByProject: {} };
  const folderTask = { id: 't1', projectId: 'p1', templateId: 'builder', executorId: 'test-claude', description: 'x', status: 'developing', autonomy: 'auto', kind: 'execute', sessionId: 's1', blockedQuestion: null, failureReason: null, createdAt: '', updatedAt: '', completedAt: null };
  const before_ = { ...state, ...mergeWorkerEvent(state, { type: 'task', task: folderTask }) };
  assert.equal(isProjectFolderBusy([before_.tasksById.t1], []), true);

  const settled = { ...folderTask, status: 'done', completedAt: 'now' };
  const after_ = { ...before_, ...mergeWorkerEvent(before_, { type: 'task', task: settled }) };
  assert.equal(isProjectFolderBusy([after_.tasksById.t1], []), false);
});

test('W10: a live workflowRun-event update flips the predicate from busy to free once it completes', () => {
  const baseRun = {
    id: 'r1', projectId: 'p1', planItemId: 'item', workflowId: 'wf', workflowSnapshot: {}, status: 'awaiting-approval',
    currentStepId: null, executorId: 'test-claude', prUrl: null, completionReport: null,
    attentionReason: null, loopRoundAllowance: 0, createdAt: '', updatedAt: '', completedAt: null,
  };
  const state = { workflowRunsByProject: {}, workflowRunDetails: {} };
  const before_ = { ...state, ...mergeWorkerEvent(state, { type: 'workflowRun', run: baseRun }) };
  assert.equal(isProjectFolderBusy([], before_.workflowRunsByProject.p1), true);

  const completedRun = { ...baseRun, status: 'completed', completedAt: 'now' };
  const after_ = { ...before_, ...mergeWorkerEvent(before_, { type: 'workflowRun', run: completedRun }) };
  assert.equal(isProjectFolderBusy([], after_.workflowRunsByProject.p1), false);
});

test('W11: a live task-event update flips the predicate from free to busy when a brand-new folder Task appears', () => {
  const state = { projects: [], tasksById: {}, taskIdsByProject: { p1: [] }, lastTaskIdByProject: {} };
  assert.equal(isProjectFolderBusy([], []), false);

  const newFolderTask = { id: 't2', projectId: 'p1', templateId: 'builder', executorId: 'test-claude', description: 'x', status: 'developing', autonomy: 'auto', kind: 'execute', sessionId: 's2', blockedQuestion: null, failureReason: null, createdAt: '', updatedAt: '', completedAt: null };
  const after_ = { ...state, ...mergeWorkerEvent(state, { type: 'task', task: newFolderTask }) };
  assert.equal(isProjectFolderBusy([after_.tasksById.t2], []), true);
});

test('C1: BranchMenu.tsx derives `busy` from the shared folder-busy predicate, not project.status', async () => {
  const component = await readFile(new URL('../src/ui/project-popup/BranchMenu.tsx', import.meta.url), 'utf8');
  assert.match(component, /const busy = isProjectFolderBusy\(tasks, runs\);/, 'busy must be derived from the shared folder-busy predicate');
  assert.doesNotMatch(component, /project\.status !== 'idle'/, 'must no longer gate on the project\'s overall status');
});

test('C2: the explanatory text and tooltip render only while busy, with branch-switch wording rather than a generic "task is active" message', async () => {
  const component = await readFile(new URL('../src/ui/project-popup/BranchMenu.tsx', import.meta.url), 'utf8');
  assert.match(component, /\{busy &&/, 'the explanatory paragraph must still be gated on busy');
  assert.match(component, /switch branches/, 'must name branch-switching, not a generic task-is-active message');
  assert.doesNotMatch(component, /A task is active/i, 'must not use the old, misleading-during-planning wording');
});

test('C3/W12: the create-branch CommandItem is only ever disabled by `pending`, never by `busy` — create stays available whatever the folder-busy value is', async () => {
  const component = await readFile(new URL('../src/ui/project-popup/BranchMenu.tsx', import.meta.url), 'utf8');
  const createItem = component.slice(component.indexOf('__create__'), component.indexOf('__create__') + 200);
  assert.match(createItem, /disabled=\{pending\}/, 'the create CommandItem must be disabled only by `pending`');
  assert.doesNotMatch(createItem, /busy/, 'the create CommandItem must never reference `busy`');
});
