import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PlanItemRecord, WorkflowRunRecord } from '../src/domain/types.ts';
import { startPullRequestHarness, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/** Task 19.001: the Start task dialog's Auto-merge choice, saved by the real service after a start was accepted. */

let h: PullRequestHarness;
let svc: typeof import('../src/projects/autoMergeService.ts');
let notifications: typeof import('../src/notifications/notificationService.ts');

before(async () => {
  h = await startPullRequestHarness('auto-merge-start-');
  svc = await import('../src/projects/autoMergeService.ts');
  notifications = await import('../src/notifications/notificationService.ts');
});
after(async () => { await h.close(); });

function service() {
  return svc.createAutoMergeService({
    getProject: h.projectService.getProject,
    readPullRequest: async () => { throw new Error('no provider in this test'); },
    mergePullRequest: async () => { throw new Error('no merge in this test'); },
    startConflictRun: async () => { throw new Error('no conflict run in this test'); },
    activeConflictRun: async () => null,
    latestConflictRun: async () => null,
    executorUnavailableReason: async () => null,
    onWorkerEvent: () => () => undefined,
    publish: () => undefined,
    runPollMs: 10,
  });
}

/** A task whose start was just accepted: the run exists but, as for a real separate-branch start, has no branch yet. */
async function startingTask(projectId: string, withBranch = false): Promise<PlanItemRecord> {
  const now = new Date().toISOString();
  const itemId = randomUUID();
  const run = {
    id: randomUUID(), projectId, planItemId: itemId, workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'x', description: '', enabled: true, steps: [] },
    status: 'starting', currentStepId: null, executorId: 'test-claude-cli', prUrl: null, completionReport: null, attentionReason: null,
    loopRoundAllowance: 0, ...(withBranch ? { branch: 'task/x', baseBranch: 'main' } : {}), createdAt: now, updatedAt: now, completedAt: null,
  } as WorkflowRunRecord;
  await h.collections.workflowRunsDb.insert(run);
  return h.collections.planItemsDb.insert({
    id: itemId, projectId, title: 'Started', description: '', status: 'developing', order: 1, taskIds: [], milestoneId: null, workflowRunId: run.id, createdAt: now, updatedAt: now,
  } as PlanItemRecord);
}

test('I23 I39 a start that was just accepted turns Auto-merge on even though its branch is not known yet; the toggle path still refuses that run', async () => {
  const project = await h.createProject('Start On');
  const item = await startingTask(project.id);
  const auto = service();
  await assert.rejects(auto.setEnabled(project.id, item.id, true), /own branch/);
  const enabled = await auto.setEnabled(project.id, item.id, true, { atStart: true });
  assert.deepEqual([enabled.autoMerge?.enabled, enabled.autoMerge?.state], [true, 'waiting']);
  await auto.idle();
});

test('I25 I39 an accepted start with false turns it off like the details toggle and resolves its notifications; I38 an item with no record reads as off', async () => {
  const project = await h.createProject('Start Off');
  const item = await startingTask(project.id, true);
  const auto = service();
  assert.equal(item.autoMerge, undefined, 'I38 no record');
  assert.equal((await auto.setEnabled(project.id, item.id, false, { atStart: true })).autoMerge, undefined, 'off with no record changes nothing');
  await auto.setEnabled(project.id, item.id, true, { atStart: true });
  await auto.idle();
  await notifications.raiseNotification({ kind: 'automerge.blocked', subject: { type: 'autoMerge', projectId: project.id, planItemId: item.id }, title: 'Blocked', description: 'x' });
  const off = await auto.setEnabled(project.id, item.id, false, { atStart: true });
  assert.equal(off.autoMerge?.enabled, false);
  const open = (await notifications.listNotifications({ projectId: project.id })).filter((n) => n.subject.type === 'autoMerge' && n.resolvedAt === null);
  assert.deepEqual(open, [], 'its Auto-merge notifications are resolved');
});
