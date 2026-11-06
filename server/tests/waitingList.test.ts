import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { settledExecute } from './helpers/startRun.ts';
import { autoAdvanceTerminalSteps } from './helpers/terminalStepFakes.ts';

/**
 * Task 31.003: a start at the Project's task limit waits in line and starts by itself when a slot frees.
 * Driven through the real worker manager with a scripted fake terminal host on repository-less Projects
 * (limit 1), so no `claude`/`codex` process and no git are involved.
 */

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let collections: typeof import('../src/db/collections.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');

type Manager = ReturnType<typeof workerManagerModule.createWorkerManager>;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'waiting-list-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  collections = await import('../src/db/collections.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function newManager(): Manager {
  const ref: { current?: Manager } = {};
  const { host } = autoAdvanceTerminalSteps(ref, {});
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: host, listExecutors: async () => [] });
  ref.current = manager;
  return manager;
}

async function projectWithItems(name: string, count: number) {
  const project = await projectService.createProject({ name, position: null });
  const items = [];
  for (let i = 0; i < count; i += 1) items.push(await planItemService.createPlanItem({ projectId: project.id, title: `Item ${i}`, description: 'x' }));
  return { project, items };
}

async function limitNotifications(projectId: string) {
  return (await notificationService.listNotifications({ projectId })).filter((n) => n.kind === 'task.limit_reached');
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition not reached');
}

/**
 * Completes the item's current step, then waits for the queue advance that the freed slot triggers.
 * The item's Task may not exist yet (a queued entry starts in the background), and its run's start-up must
 * be settled before the step can complete; the final advance joins the queue lock so callers read settled state.
 */
async function finish(manager: Manager, projectId: string, itemId: string): Promise<void> {
  const findTask = async () => (await manager.listTasksForProject(projectId)).find((t) => t.planItemId === itemId);
  await waitUntil(async () => (await findTask()) !== undefined);
  const task = (await findTask())!;
  if (task.workflowRunId) await manager.whenStartupSettled(task.workflowRunId);
  await manager.completeStep(task.id, { summary: 'done' });
  await manager.advanceQueueIfIdle(projectId);
}

test('a start at the limit queues with its options and raises one notification; the free slot is then taken by the line', async () => {
  const manager = newManager();
  const { project, items } = await projectWithItems('Waiting Basic', 3);
  await settledExecute(manager)(items[0]!.id);

  const second = await manager.enqueuePlanItemExecution(items[1]!.id, { executorId: 'alpha', skippedStepIds: [] });
  assert.equal(second.started, false);
  assert.equal(second.started === false && second.entry.executorId, 'alpha');
  const third = await manager.enqueuePlanItemExecution(items[2]!.id);
  assert.equal(third.started === false && third.entry.position, 1, 'first come, first served');
  assert.deepEqual((await manager.listPlanItemQueue(project.id)).map((e) => e.planItemId), [items[1]!.id, items[2]!.id]);
  assert.equal((await limitNotifications(project.id)).filter((n) => !n.resolvedAt).length, 1, 'one notification while entries wait');

  const again = await manager.enqueuePlanItemExecution(items[1]!.id);
  assert.equal(again.started === false && again.entry.id, second.started === false && second.entry.id, 'the same item is not queued twice');

  await finish(manager, project.id, items[0]!.id);
  await waitUntil(async () => (await planItemService.getPlanItem(items[1]!.id)).status === 'developing');
  await manager.advanceQueueIfIdle(project.id);
  assert.deepEqual((await manager.listPlanItemQueue(project.id)).map((e) => e.planItemId), [items[2]!.id], 'the second entry started; the third still waits');

  await finish(manager, project.id, items[1]!.id);
  await waitUntil(async () => (await planItemService.getPlanItem(items[2]!.id)).status === 'developing');
  // The status flips mid-start; joining the queue lock waits for the advance to finish resolving the notification.
  await manager.advanceQueueIfIdle(project.id);
  assert.deepEqual(await manager.listPlanItemQueue(project.id), []);
  assert.equal((await limitNotifications(project.id)).filter((n) => !n.resolvedAt).length, 0, 'resolved once the list is empty');
});

test('two frees at once start each entry exactly once', async () => {
  const manager = newManager();
  const { project, items } = await projectWithItems('Waiting Race', 3);
  await settledExecute(manager)(items[0]!.id);
  await manager.enqueuePlanItemExecution(items[1]!.id);
  await manager.enqueuePlanItemExecution(items[2]!.id);
  await finish(manager, project.id, items[0]!.id);

  await Promise.all([manager.advanceQueueIfIdle(project.id), manager.advanceQueueIfIdle(project.id)]);
  const started = (await manager.listTasksForProject(project.id)).filter((t) => t.planItemId === items[1]!.id);
  assert.equal(started.length, 1);
  assert.deepEqual((await manager.listPlanItemQueue(project.id)).map((e) => e.planItemId), [items[2]!.id], 'with the slot taken again, the third still waits');
});

test('a start that still hits the limit goes back to the front of the line', async () => {
  const manager = newManager();
  const { project, items } = await projectWithItems('Waiting Retry', 3);
  await settledExecute(manager)(items[0]!.id);
  await manager.enqueuePlanItemExecution(items[1]!.id);
  await manager.enqueuePlanItemExecution(items[2]!.id);

  await manager.advanceQueueIfIdle(project.id);
  assert.deepEqual((await manager.listPlanItemQueue(project.id)).map((e) => e.planItemId), [items[1]!.id, items[2]!.id], 'the running task still holds the slot');
  assert.equal((await limitNotifications(project.id)).filter((n) => !n.resolvedAt).length, 1);
});

test('stopping a task frees its slot (it no longer counts as live), so the line starts the next entry', async () => {
  const manager = newManager();
  const { project, items } = await projectWithItems('Waiting Stopped', 2);
  const run = await manager.executePlanItem(items[0]!.id);
  await manager.whenStartupSettled(run.id);
  await manager.enqueuePlanItemExecution(items[1]!.id);
  await manager.stopWorkflowRun(run.id);
  await waitUntil(async () => (await planItemService.getPlanItem(items[1]!.id)).status === 'developing');
  assert.deepEqual(await manager.listPlanItemQueue(project.id), []);
});

test('removing an entry takes it off the list and resolves the notification when the list empties', async () => {
  const manager = newManager();
  const { project, items } = await projectWithItems('Waiting Remove', 2);
  await settledExecute(manager)(items[0]!.id);
  const queued = await manager.enqueuePlanItemExecution(items[1]!.id);
  assert.equal(queued.started, false);
  const events: string[] = [];
  manager.onWorkerEvent((event) => { if (event.type === 'planItemQueue') events.push(`${event.entries.length}`); });
  await manager.removeQueuedPlanItemExecution((queued as { entry: { id: string } }).entry.id);
  assert.deepEqual(events, ['0']);
  assert.equal((await limitNotifications(project.id)).filter((n) => !n.resolvedAt).length, 0);
  await assert.rejects(manager.removeQueuedPlanItemExecution('missing'), (e: Error) => e.name === 'PlanItemQueueEntryNotFoundError');
});

test('reordering puts a later entry first', async () => {
  const manager = newManager();
  const { project, items } = await projectWithItems('Waiting Order', 3);
  await settledExecute(manager)(items[0]!.id);
  await manager.enqueuePlanItemExecution(items[1]!.id);
  await manager.enqueuePlanItemExecution(items[2]!.id, { queueIndex: 0 });
  assert.deepEqual((await manager.listPlanItemQueue(project.id)).map((e) => e.planItemId), [items[2]!.id, items[1]!.id]);
});

/** A line left in the store by an earlier daemon process. */
async function persistEntries(projectId: string, itemIds: string[]) {
  for (const [position, planItemId] of itemIds.entries()) {
    await collections.planItemQueueDb.insert({ id: `entry-${planItemId}`, projectId, planItemId, position, createdAt: new Date(position).toISOString() });
  }
}

test('daemon start advances every persisted line: the first entry starts when a slot is free', async () => {
  const { project, items } = await projectWithItems('Waiting Restart', 2);
  await persistEntries(project.id, [items[0]!.id, items[1]!.id]);
  const restarted = newManager();
  await restarted.advanceAllQueues();
  await waitUntil(async () => (await planItemService.getPlanItem(items[0]!.id)).status === 'developing');
  assert.deepEqual((await restarted.listPlanItemQueue(project.id)).map((e) => e.planItemId), [items[1]!.id], 'the one slot is taken, so the second keeps waiting');
});

test('an entry whose plan item was deleted is dropped and the next one starts', async () => {
  const manager = newManager();
  const { project, items } = await projectWithItems('Waiting Dropped', 2);
  await persistEntries(project.id, [items[0]!.id, items[1]!.id]);
  await collections.planItemsDb.delete(items[0]!.id);
  await manager.advanceQueueIfIdle(project.id);
  assert.equal((await planItemService.getPlanItem(items[1]!.id)).status, 'developing');
  assert.deepEqual(await manager.listPlanItemQueue(project.id), []);
});

test('a removal that arrives while the entry is being started waits for the start and wins when the start is put back', async () => {
  const manager = newManager();
  const { project, items } = await projectWithItems('Waiting Removal Race', 2);
  await settledExecute(manager)(items[0]!.id);
  const queued = await manager.enqueuePlanItemExecution(items[1]!.id);
  const entryId = (queued as { entry: { id: string } }).entry.id;

  // The running task still holds the only slot, so this advance deletes the entry, fails the start and puts it back.
  const advancing = manager.advanceQueueIfIdle(project.id);
  const removal = manager.removeQueuedPlanItemExecution(entryId);
  await Promise.all([advancing, removal]);
  assert.deepEqual(await manager.listPlanItemQueue(project.id), [], 'the removal was not undone by the put-back');
  await assert.rejects(manager.removeQueuedPlanItemExecution(entryId), (e: Error) => e.name === 'PlanItemQueueEntryNotFoundError');
});

/** An in-place run paused between steps: no live Task, but it owns the Project's folder. */
async function holdFolder(projectId: string) {
  const now = new Date().toISOString();
  await collections.workflowRunsDb.insert({
    id: `held-${projectId}`, projectId, planItemId: 'some-other-item', workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'x', description: 'x', enabled: true, steps: [] },
    status: 'awaiting-approval', currentStepId: null, executorId: 'test-claude-cli',
    prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0,
    createdAt: now, updatedAt: now, completedAt: null,
  } as never);
}

test('a repository Project whose folder is busy still refuses an in-place start; a Project without one queues and leaves no stale notice', async () => {
  const manager = newManager();
  const withRepo = await projectWithItems('Waiting Folder Repo', 1);
  await collections.projectsDb.update(withRepo.project.id, { repositoryUrl: 'https://github.com/example/repo' });
  await holdFolder(withRepo.project.id);
  await assert.rejects(manager.enqueuePlanItemExecution(withRepo.items[0]!.id, { createBranch: false }), (e: Error) => e.name === 'ProjectFolderBusyError');
  assert.deepEqual(await manager.listPlanItemQueue(withRepo.project.id), []);

  const noRepo = await projectWithItems('Waiting Folder None', 1);
  await holdFolder(noRepo.project.id);
  const queued = await manager.enqueuePlanItemExecution(noRepo.items[0]!.id);
  assert.equal(queued.started, false);
  assert.equal((await limitNotifications(noRepo.project.id)).filter((n) => !n.resolvedAt).length, 0, 'no limit notice is raised for a folder hold');
  await manager.removeQueuedPlanItemExecution((queued as { entry: { id: string } }).entry.id);
  assert.equal((await limitNotifications(noRepo.project.id)).filter((n) => !n.resolvedAt).length, 0);
});
