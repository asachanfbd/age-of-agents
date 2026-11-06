import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let planItemService: typeof import('../src/projects/planItemService.ts');
let planItemsDb: typeof import('../src/db/collections.ts')['planItemsDb'];
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'plan-item-service-test-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  planItemService = await import('../src/projects/planItemService.ts');
  ({ planItemsDb } = await import('../src/db/collections.ts'));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('createPlanItem assigns increasing order per project, independent of other projects', async () => {
  const a1 = await planItemService.createPlanItem({ projectId: 'proj-a', title: 'A1', description: '' });
  const a2 = await planItemService.createPlanItem({ projectId: 'proj-a', title: 'A2', description: '' });
  const b1 = await planItemService.createPlanItem({ projectId: 'proj-b', title: 'B1', description: '' });

  assert.equal(a1.order, 0);
  assert.equal(a2.order, 1);
  assert.equal(b1.order, 0);
  assert.equal(a1.status, 'pending');
  assert.deepEqual(a1.taskIds, []);
});

test('listPlanItems returns only that project\'s items, sorted by order', async () => {
  const items = await planItemService.listPlanItems('proj-a');
  assert.deepEqual(items.map((i) => i.title), ['A1', 'A2']);
});

test('updatePlanItem patches given fields and leaves others alone', async () => {
  const [item] = await planItemService.listPlanItems('proj-a');
  assert.ok(item);
  const updated = await planItemService.updatePlanItem(item.id, { title: 'A1 renamed' });
  assert.equal(updated.title, 'A1 renamed');
  assert.equal(updated.description, item.description);
});

test('updatePlanItem throws PlanItemNotFoundError for an unknown id', async () => {
  await assert.rejects(() => planItemService.updatePlanItem('no-such-id', { title: 'x' }), planItemService.PlanItemNotFoundError);
});

test('deletePlanItem removes the record whatever its status (stopping its sessions is workerManager\'s job), and 404s an unknown one', async () => {
  for (const status of ['pending', 'failed', 'blocked', 'developing'] as const) {
    const item = await planItemService.createPlanItem({ projectId: 'proj-c', title: status, description: '' });
    await planItemsDb.update(item.id, { status });
    await planItemService.deletePlanItem(item.id);
    await assert.rejects(() => planItemService.getPlanItem(item.id), planItemService.PlanItemNotFoundError, status);
  }
  await assert.rejects(() => planItemService.deletePlanItem('no-such-id'), planItemService.PlanItemNotFoundError);
});

test('archivePlanItem archives and restores an item (refusing a running one is workerManager.archivePlanItem)', async () => {
  const item = await planItemService.createPlanItem({ projectId: 'proj-archive', title: 'Archive me', description: '' });
  assert.equal(item.archived, undefined, 'not archived by default');
  assert.equal((await planItemService.archivePlanItem(item.id, true)).archived, true);
  assert.equal((await planItemService.archivePlanItem(item.id, false)).archived, false);

  await assert.rejects(() => planItemService.archivePlanItem('no-such-id', true), planItemService.PlanItemNotFoundError);
});

test('planningTaskTitle prefixes the session number and the task number padded to three digits', () => {
  assert.equal(planItemService.planningTaskTitle({ session: 3, task: 2 }, 'Add login'), '3.002: Add login');
  assert.equal(planItemService.planningTaskTitle({ session: 3, task: 12 }, 'Add login'), '3.012: Add login');
  assert.equal(planItemService.planningTaskTitle({ session: 12, task: 1234 }, 'Add login'), '12.1234: Add login', 'past 999 it just grows');
});

test('createPlanningPlanItem numbers each session\'s tasks in sequence, independently per session and project', async () => {
  const first = await planItemService.createPlanningPlanItem({ projectId: 'proj-d', session: 2, title: 'Schema', description: 'Design the schema' });
  const second = await planItemService.createPlanningPlanItem({ projectId: 'proj-d', session: 2, title: 'API', description: 'Build the API' });
  const otherSession = await planItemService.createPlanningPlanItem({ projectId: 'proj-d', session: 3, title: 'UI', description: '' });
  const otherProject = await planItemService.createPlanningPlanItem({ projectId: 'proj-e', session: 2, title: 'Elsewhere', description: '' });

  assert.equal(first.title, '2.001: Schema');
  assert.equal(first.description, 'Design the schema');
  assert.deepEqual(first.planningRef, { session: 2, task: 1 });
  assert.equal(second.title, '2.002: API');
  assert.equal(otherSession.title, '3.001: UI');
  assert.equal(otherProject.title, '2.001: Elsewhere');
  assert.ok(second.order > first.order, 'tasks keep their creation order');
});

test('createPlanningPlanItem continues after the highest number, even when an earlier task was deleted', async () => {
  const one = await planItemService.createPlanningPlanItem({ projectId: 'proj-f', session: 1, title: 'One', description: '' });
  await planItemService.createPlanningPlanItem({ projectId: 'proj-f', session: 1, title: 'Two', description: '' });
  await planItemService.deletePlanItem(one.id);

  const three = await planItemService.createPlanningPlanItem({ projectId: 'proj-f', session: 1, title: 'Three', description: '' });
  assert.equal(three.title, '1.003: Three');
});

test('planningTaskTitle replaces a sequence number the title already carries', () => {
  assert.equal(planItemService.planningTaskTitle({ session: 1, task: 2 }, '4.009: Add login'), '1.002: Add login');
  assert.equal(planItemService.planningTaskTitle({ session: 1, task: 2 }, 'P.4 T9: Add login'), '1.002: Add login', 'the earlier "P.n Tm" format is replaced too');
});

test('editPlanningPlanItem keeps a numbered title\'s prefix, edits a plain one as given, and refuses foreign items', async () => {
  const numbered = await planItemService.createPlanningPlanItem({ projectId: 'proj-h', session: 1, title: 'Old', description: 'old' });
  const plain = await planItemService.createPlanItem({ projectId: 'proj-h', title: 'Plain', description: '' });

  assert.equal((await planItemService.editPlanningPlanItem('proj-h', numbered.id, { title: 'New' })).title, '1.001: New');
  const described = await planItemService.editPlanningPlanItem('proj-h', numbered.id, { description: 'fresh' });
  assert.deepEqual([described.title, described.description], ['1.001: New', 'fresh']);
  assert.equal((await planItemService.editPlanningPlanItem('proj-h', plain.id, { title: 'Renamed' })).title, 'Renamed');

  await assert.rejects(planItemService.editPlanningPlanItem('other', plain.id, { title: 'x' }), planItemService.PlanItemNotFoundError);
  await assert.rejects(planItemService.editPlanningPlanItem('proj-h', 'missing', { title: 'x' }), planItemService.PlanItemNotFoundError);
});

test('editPlanningPlanItem refuses a completed item, leaving it untouched, while other statuses stay editable', async () => {
  const done = await planItemService.createPlanningPlanItem({ projectId: 'proj-h2', session: 1, title: 'Shipped', description: 'old' });
  await planItemsDb.update(done.id, { status: 'done' });
  await assert.rejects(planItemService.editPlanningPlanItem('proj-h2', done.id, { title: 'Reworked', description: 'new' }), planItemService.PlanItemCompletedError);
  await assert.rejects(planItemService.editPlanningPlanItem('proj-h2', done.id, { description: 'new' }), /create a new task/);
  const unchanged = await planItemService.getPlanItem(done.id);
  assert.deepEqual([unchanged.title, unchanged.description, unchanged.status], ['1.001: Shipped', 'old', 'done']);

  for (const status of ['pending', 'failed', 'stopped'] as const) {
    await planItemsDb.update(done.id, { status });
    assert.equal((await planItemService.editPlanningPlanItem('proj-h2', done.id, { description: status })).description, status);
  }

  await planItemsDb.update(done.id, { status: 'done' });
  await planItemService.deletePlanningPlanItem('proj-h2', done.id);
  await assert.rejects(planItemService.getPlanItem(done.id), planItemService.PlanItemNotFoundError, 'a completed item can still be deleted');
});

test('deletePlanningPlanItem removes an idle item of its own Project only', async () => {
  const item = await planItemService.createPlanItem({ projectId: 'proj-i', title: 'Doomed', description: '' });
  const other = await planItemService.createPlanItem({ projectId: 'proj-i', title: 'Kept', description: '' });

  await assert.rejects(planItemService.deletePlanningPlanItem('other', item.id), planItemService.PlanItemNotFoundError);
  await planItemService.deletePlanningPlanItem('proj-i', item.id);
  assert.deepEqual((await planItemService.listPlanItems('proj-i')).map((i) => i.id), [other.id]);
});

test('createPlanItem leaves planningRef off an ordinary task', async () => {
  const item = await planItemService.createPlanItem({ projectId: 'proj-g', title: 'Manual', description: '' });
  assert.equal('planningRef' in item, false);
});

test('completePlanItem marks an item done whatever its stored status (refusing a really running one is workerManager.completePlanItem)', async () => {
  for (const status of ['pending', 'failed', 'stopped', 'developing'] as const) {
    const item = await planItemService.createPlanItem({ projectId: 'proj-complete', title: status, description: '' });
    await planItemService.updatePlanItem(item.id, { status });
    assert.equal((await planItemService.completePlanItem(item.id)).status, 'done', `from ${status}`);
  }
});

test('completePlanItem refuses an item that is already done', async () => {
  const item = await planItemService.createPlanItem({ projectId: 'proj-complete', title: 'Done', description: '' });
  await planItemService.updatePlanItem(item.id, { status: 'done' });
  await assert.rejects(() => planItemService.completePlanItem(item.id), planItemService.PlanItemCompletedError);
});

test('completePlanItem throws PlanItemNotFoundError for an unknown item', async () => {
  await assert.rejects(() => planItemService.completePlanItem('no-such-id'), planItemService.PlanItemNotFoundError);
});

test('a new plan item carries no priority field', async () => {
  const item = await planItemService.createPlanItem({ projectId: 'proj-priority', title: 'Plain', description: '' });
  assert.equal('priority' in item, false);
});

test('a stored item still carrying a legacy priority reads, updates and reorders without it', async () => {
  const now = new Date().toISOString();
  const legacy = { id: 'legacy-priority', projectId: 'proj-legacy', title: 'Legacy', description: '', status: 'pending', order: 0, priority: 'high', taskIds: [], milestoneId: null, createdAt: now, updatedAt: now };
  await planItemsDb.insert(legacy as unknown as Parameters<typeof planItemsDb.insert>[0]);
  const other = await planItemService.createPlanItem({ projectId: 'proj-legacy', title: 'Other', description: '' });

  assert.equal('priority' in (await planItemService.getPlanItem(legacy.id)), false, 'get');
  assert.equal('priority' in (await planItemService.updatePlanItem(legacy.id, { title: 'Renamed' })), false, 'update');
  const listed = await planItemService.reorderPlanItems('proj-legacy', [other.id, legacy.id]);
  assert.deepEqual(listed.map((item) => item.title), ['Other', 'Renamed']);
  assert.ok(listed.every((item) => !('priority' in item)), 'list');
});

test('reorderPlanItems puts the listed items in sequence within their own slots, leaving the rest in place', async () => {
  const created = [];
  for (const title of ['A', 'B', 'C', 'D']) created.push(await planItemService.createPlanItem({ projectId: 'proj-reorder', title, description: '' }));
  const [a, b, c, d] = created;
  assert.deepEqual([a!.order, b!.order, c!.order, d!.order], [0, 1, 2, 3]);

  const reordered = await planItemService.reorderPlanItems('proj-reorder', [d!.id, b!.id]);
  assert.deepEqual(reordered.map((item) => item.title), ['A', 'D', 'C', 'B'], 'D and B swap slots 1 and 3; A and C stay put');
  assert.deepEqual((await planItemService.listPlanItems('proj-reorder')).map((item) => item.title), ['A', 'D', 'C', 'B'], 'persisted');
});

test('reorderPlanItems leaves an item already in its slot, and every unlisted item, unwritten', async () => {
  const first = await planItemService.createPlanItem({ projectId: 'proj-lane', title: 'First', description: '' });
  const second = await planItemService.createPlanItem({ projectId: 'proj-lane', title: 'Second', description: '' });
  const untouched = await planItemService.createPlanItem({ projectId: 'proj-lane', title: 'Untouched', description: '' });
  const listed = await planItemService.reorderPlanItems('proj-lane', [first.id, second.id]);
  assert.deepEqual(listed.map((item) => item.title), ['First', 'Second', 'Untouched']);
  assert.equal((await planItemService.getPlanItem(first.id)).updatedAt, first.updatedAt, 'already in place');
  assert.equal((await planItemService.getPlanItem(untouched.id)).updatedAt, untouched.updatedAt, 'not listed');
});

test('reorderPlanItems refuses an id that is not one of this project\'s items', async () => {
  const other = await planItemService.createPlanItem({ projectId: 'proj-reorder-other', title: 'Elsewhere', description: '' });
  await assert.rejects(() => planItemService.reorderPlanItems('proj-reorder', [other.id]), planItemService.PlanItemNotFoundError);
  await assert.rejects(() => planItemService.reorderPlanItems('proj-reorder', ['no-such-id']), planItemService.PlanItemNotFoundError);
});
