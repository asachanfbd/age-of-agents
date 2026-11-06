import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ProjectRecord, TaskRecord, WorkflowRunRecord } from '../src/domain/types.ts';

/**
 * Unit coverage for `isProjectFolderBusy`/`assertProjectFolderFree` (server/src/worker/projectFolderGuard.ts)
 * — the one rule behind every guard that must only block on work really happening in a Project's own
 * folder: starting a new in-place Task, switching its checked-out branch, and syncing it with origin.
 * Exercised directly against the exported predicate, with Task/WorkflowRun records written straight
 * to the database (see .docs/testing.md's "API tests never start a real Task") and a fake
 * `SessionRegistry` standing in for the real terminal-session host.
 */

let root: string;
let guard: typeof import('../src/worker/projectFolderGuard.ts');
let service: typeof import('../src/projects/projectService.ts');
let collections: typeof import('../src/db/collections.ts');

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'project-folder-guard-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  guard = await import('../src/worker/projectFolderGuard.ts');
  service = await import('../src/projects/projectService.ts');
  collections = await import('../src/db/collections.ts');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeSessions(liveIds: Iterable<string> = []): { has(id: string): boolean } {
  const live = new Set(liveIds);
  return { has: (id) => live.has(id) };
}

const ZERO_TOKEN_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };

function makeTask(overrides: Partial<TaskRecord> & { id: string; projectId: string }): TaskRecord {
  const now = new Date().toISOString();
  return {
    templateId: 'builder', executorId: 'test-claude-cli', description: 'Task', autonomy: 'auto', manager: false,
    kind: 'execute', status: 'developing', planItemId: null, sessionId: null, blockedQuestion: null, failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE, createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkflowRunRecord> & { id: string; projectId: string }): WorkflowRunRecord {
  const now = new Date().toISOString();
  return {
    planItemId: 'some-item', workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'x', description: 'x', enabled: true, steps: [] },
    status: 'running', currentStepId: null, executorId: 'test-claude-cli',
    prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0,
    createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

async function freshProject(name: string): Promise<ProjectRecord> {
  return service.createProject({ name, position: null });
}

test('U1/U2: only a planning session active, running or waiting for an answer, never blocks the folder', async () => {
  for (const status of ['developing', 'blocked'] as const) {
    const project = await freshProject(`Plan Only ${status}`);
    const task = await collections.tasksDb.insert(makeTask({ id: `plan-${status}`, projectId: project.id, kind: 'plan', status }));
    const patched = await service.patchProject(project.id, { activeTaskIds: [task.id] });
    assert.equal(await guard.isProjectFolderBusy(patched, fakeSessions([task.id])), false);
  }
});

test('U3: a settled planning session, no longer in the active set, never blocks', async () => {
  const project = await freshProject('Plan Settled');
  await collections.tasksDb.insert(makeTask({ id: 'plan-done', projectId: project.id, kind: 'plan', status: 'done' }));
  const patched = await service.patchProject(project.id, { activeTaskIds: [] });
  assert.equal(await guard.isProjectFolderBusy(patched, fakeSessions(['plan-done'])), false);
});

test('U4: a worktree-isolated coding Task never blocks', async () => {
  const project = await freshProject('Worktree Task');
  const task = await collections.tasksDb.insert(makeTask({ id: 'worktree-task', projectId: project.id, kind: 'execute', status: 'developing', worktreePath: '/tmp/wt' }));
  const patched = await service.patchProject(project.id, { activeTaskIds: [task.id] });
  assert.equal(await guard.isProjectFolderBusy(patched, fakeSessions([task.id])), false);
});

test('U5: an unsettled WorkflowRun in its own worktree never blocks', async () => {
  const project = await freshProject('Worktree Run');
  await collections.workflowRunsDb.insert(makeRun({ id: 'worktree-run', projectId: project.id, status: 'awaiting-approval', worktreePath: '/tmp/wt-run' }));
  assert.equal(await guard.isProjectFolderBusy(project, fakeSessions()), false);
});

test('U6/U7: a coding Task with no worktree, developing or blocked, blocks the folder', async () => {
  for (const status of ['developing', 'blocked'] as const) {
    const project = await freshProject(`Folder Task ${status}`);
    const task = await collections.tasksDb.insert(makeTask({ id: `folder-${status}`, projectId: project.id, kind: 'execute', status }));
    const patched = await service.patchProject(project.id, { activeTaskIds: [task.id] });
    assert.equal(await guard.isProjectFolderBusy(patched, fakeSessions([task.id])), true);
  }
});

test('U8/U9/U10: an unsettled in-place WorkflowRun (awaiting-approval, needs-attention, completing) blocks the folder', async () => {
  for (const status of ['awaiting-approval', 'needs-attention', 'completing'] as const) {
    const project = await freshProject(`In-place Run ${status}`);
    await collections.workflowRunsDb.insert(makeRun({ id: `run-${status}`, projectId: project.id, status }));
    assert.equal(await guard.isProjectFolderBusy(project, fakeSessions()), true);
  }
});

test('U11: a settled in-place WorkflowRun (completed/failed/stopped) never blocks', async () => {
  for (const status of ['completed', 'failed', 'stopped'] as const) {
    const project = await freshProject(`Settled Run ${status}`);
    await collections.workflowRunsDb.insert(makeRun({ id: `settled-${status}`, projectId: project.id, status }));
    assert.equal(await guard.isProjectFolderBusy(project, fakeSessions()), false);
  }
});

test('U12/U13: mixed planning + folder Task blocks; mixed planning + worktree-only Task never blocks', async () => {
  const busyProject = await freshProject('Mixed Busy');
  const plan = await collections.tasksDb.insert(makeTask({ id: 'mixed-plan-a', projectId: busyProject.id, kind: 'plan', status: 'developing' }));
  const folderTask = await collections.tasksDb.insert(makeTask({ id: 'mixed-folder', projectId: busyProject.id, kind: 'execute', status: 'developing' }));
  const patchedBusy = await service.patchProject(busyProject.id, { activeTaskIds: [plan.id, folderTask.id] });
  assert.equal(await guard.isProjectFolderBusy(patchedBusy, fakeSessions([plan.id, folderTask.id])), true);

  const freeProject = await freshProject('Mixed Free');
  const plan2 = await collections.tasksDb.insert(makeTask({ id: 'mixed-plan-b', projectId: freeProject.id, kind: 'plan', status: 'developing' }));
  const worktreeTask = await collections.tasksDb.insert(makeTask({ id: 'mixed-worktree', projectId: freeProject.id, kind: 'execute', status: 'developing', worktreePath: '/tmp/wt-mixed' }));
  const patchedFree = await service.patchProject(freeProject.id, { activeTaskIds: [plan2.id, worktreeTask.id] });
  assert.equal(await guard.isProjectFolderBusy(patchedFree, fakeSessions([plan2.id, worktreeTask.id])), false);
});

test('U14: start order relative to a planning session never changes a folder Task\'s block', async () => {
  const before_ = await freshProject('Folder Then Plan');
  const folderFirst = await collections.tasksDb.insert(makeTask({ id: 'order-folder-first', projectId: before_.id, kind: 'execute', status: 'developing' }));
  const planAfter = await collections.tasksDb.insert(makeTask({ id: 'order-plan-after', projectId: before_.id, kind: 'plan', status: 'developing' }));
  const patchedBefore = await service.patchProject(before_.id, { activeTaskIds: [folderFirst.id, planAfter.id] });
  assert.equal(await guard.isProjectFolderBusy(patchedBefore, fakeSessions([folderFirst.id, planAfter.id])), true);

  const after_ = await freshProject('Plan Then Folder');
  const planFirst = await collections.tasksDb.insert(makeTask({ id: 'order-plan-first', projectId: after_.id, kind: 'plan', status: 'developing' }));
  const folderAfter = await collections.tasksDb.insert(makeTask({ id: 'order-folder-after', projectId: after_.id, kind: 'execute', status: 'developing' }));
  const patchedAfter = await service.patchProject(after_.id, { activeTaskIds: [planFirst.id, folderAfter.id] });
  assert.equal(await guard.isProjectFolderBusy(patchedAfter, fakeSessions([planFirst.id, folderAfter.id])), true);
});

test('U15: a stale activeTaskIds entry — not a real Task, or a status-says-active Task with no registered session and no "starting" grace — never blocks on its own', async () => {
  const deletedIdProject = await freshProject('Stale Deleted Id');
  const deletedPatched = await service.patchProject(deletedIdProject.id, { activeTaskIds: ['never-existed'] });
  assert.equal(await guard.isProjectFolderBusy(deletedPatched, fakeSessions()), false);

  const unregisteredProject = await freshProject('Stale Unregistered Session');
  const stale = await collections.tasksDb.insert(makeTask({ id: 'stale-session', projectId: unregisteredProject.id, kind: 'execute', status: 'developing' }));
  const stalePatched = await service.patchProject(unregisteredProject.id, { activeTaskIds: [stale.id] });
  // No id in the fake session registry, and no runtimeStatus: 'starting' grace — a lost exit or late hook left this stale.
  assert.equal(await guard.isProjectFolderBusy(stalePatched, fakeSessions()), false);
});

test('a Task that just started ("starting") counts as live even before its session is registered, and assertProjectFolderFree throws/resolves to match', async () => {
  const project = await freshProject('Starting Grace');
  const starting = await collections.tasksDb.insert(makeTask({ id: 'starting-task', projectId: project.id, kind: 'execute', status: 'developing', runtimeStatus: 'starting' }));
  const patched = await service.patchProject(project.id, { activeTaskIds: [starting.id] });
  assert.equal(await guard.isProjectFolderBusy(patched, fakeSessions()), true);
  await assert.rejects(() => guard.assertProjectFolderFree(patched, fakeSessions()), guard.ProjectFolderBusyError);

  const freeProject = await freshProject('Free For Assert');
  await assert.doesNotReject(() => guard.assertProjectFolderFree(freeProject, fakeSessions()));
});

test('assertProjectFolderFree\'s message names branch switch/sync, not Task-starting, when called with the "git" action', async () => {
  const project = await freshProject('Git Action Wording');
  await collections.tasksDb.insert(makeTask({ id: 'git-wording-task', projectId: project.id, kind: 'execute', status: 'developing' }));
  const patched = await service.patchProject(project.id, { activeTaskIds: ['git-wording-task'] });
  await assert.rejects(
    () => guard.assertProjectFolderFree(patched, fakeSessions(['git-wording-task']), 'git'),
    (error: unknown) => error instanceof guard.ProjectFolderBusyError && /switch|sync/.test((error as Error).message),
  );
});
