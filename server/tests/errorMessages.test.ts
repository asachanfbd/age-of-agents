import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Guards that no user-facing error message carries an id (see domain/displayName.ts): the UI shows
 * `error.message` verbatim, and a UUID means nothing to a person. Every lookup below is made with a
 * random UUID that must not come back in the message; guard errors must name the record instead.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'error-messages-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function messageOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the call to fail');
}

function assertNoId(message: string, id: string): void {
  assert.ok(!message.includes(id), `message leaks the id: ${message}`);
  assert.doesNotMatch(message, UUID, `message contains a UUID: ${message}`);
}

test('looking up an unknown record by id never echoes that id back', async () => {
  const planItems = await import('../src/projects/planItemService.ts');
  const projects = await import('../src/projects/projectService.ts');
  const commands = await import('../src/commands/commandService.ts');
  const notifications = await import('../src/notifications/notificationService.ts');
  const executors = await import('../src/executors/executorService.ts');
  const catalog = await import('../src/catalog/catalogService.ts');
  const { createWorkerManager } = await import('../src/worker/workerManager.ts');
  const manager = createWorkerManager();
  const id = randomUUID();

  const lookups: Array<[string, () => Promise<unknown>]> = [
    ['plan item', () => planItems.getPlanItem(id)],
    ['project', () => projects.getProject(id)],
    ['command', () => commands.getCommand(id)],
    ['notification', () => notifications.getNotification(id)],
    ['executor', () => executors.removeExecutor(id)],
    ['agent', () => catalog.deleteAgent(id)],
    ['skill', () => catalog.deleteSkill(id)],
    ['task', () => manager.getTask(id)],
    ['workflow run', () => manager.approveWorkflowRun(id)],
    ['archive', () => manager.archivePlanItem(id, true)],
  ];
  for (const [what, lookup] of lookups) {
    const message = await messageOf(lookup);
    assertNoId(message, id);
    assert.ok(message.length > 0, what);
  }
});

test('guard errors name the record by its title or name, never its id', async () => {
  const planItems = await import('../src/projects/planItemService.ts');
  const worker = await import('../src/worker/workerManager.ts');
  const id = randomUUID();
  const item = { id, title: 'Fix the login page' };

  const messages = [
    new planItems.PlanItemHasActiveTaskError(item, 'archiving').message,
    new planItems.PlanItemCompletedError(item).message,
    new planItems.PlanItemNotCompletableError(item).message,
    new worker.TaskNotFollowableError(item.title).message,
    new worker.WorkflowRunNotActionableError(item.title, 'be approved', 'running').message,
  ];
  for (const message of messages) {
    assertNoId(message, id);
    assert.match(message, /"Fix the login page"/);
  }
  assert.match(new planItems.PlanItemHasActiveTaskError(item, 'archiving').message, /^Task "Fix the login page" is still running — stop or wait for it before archiving it$/);
});

test('with no name at hand, messages fall back to generic wording', async () => {
  const worker = await import('../src/worker/workerManager.ts');
  const { named, namedAtStart } = await import('../src/domain/displayName.ts');
  assert.equal(named('task', undefined), 'this task');
  assert.equal(named('task', '  '), 'this task');
  assert.equal(namedAtStart('project', 'Shop'), 'Project "Shop"');
  assert.match(new worker.TaskNotBlockedError(undefined).message, /^This task is not blocked/);
  assert.match(new worker.WorkflowRunNotActionableError(undefined, 'be stopped', 'completed').message, /^The workflow of this task cannot be stopped/);
});
