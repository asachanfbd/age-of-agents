import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
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

const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { buildCompletedRows, buildOpenTaskRows } = await import('../src/lib/projectTasks.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

/**
 * What a planning session's create/edit/delete does to the open Tasks list: the store fed with the
 * daemon's live 'planItem'/'planItemDeleted' events (or a fresh loadPlan, as on reload), rendered
 * through the same row builders the Tasks tab uses.
 */

const LONG_DESCRIPTION = [
  '# Redesign notifications',
  '',
  '| Kind | Subject | Resolves when |',
  '| --- | --- | --- |',
  ...Array.from({ length: 400 }, (_, i) => `| kind-${i} | subject \`${i}\` | the task \`${i}\` settles |`),
  '',
  '```ts',
  ...Array.from({ length: 400 }, (_, i) => `export const handler${i} = (event: { id: string }) => event.id.split('|').join('\\n');`),
  '```',
].join('\n');

let storeProject;

async function setUp() {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], tasksById: {}, taskIdsByProject: {}, planByProject: {}, ...CLEAN_ERROR_STATE });
  await useWorldStore.getState().addProject('Planned');
  storeProject = useWorldStore.getState().projects.at(-1);
  await useWorldStore.getState().loadPlan(storeProject.id);
  return stub;
}

/** A planning session's create_task: the daemon saves it and broadcasts a 'planItem' event. */
function serverCreate(stub, n) {
  const now = new Date().toISOString();
  const item = {
    id: `planned-${n}`, projectId: storeProject.id, title: `1.00${n}: Step ${n}`, description: `d${n}`, status: 'pending',
    order: n - 1, taskIds: [], milestoneId: null, planningRef: { session: 1, task: n }, createdAt: now, updatedAt: now,
  };
  stub.planItems.set(item.id, item);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...item } }));
  return item;
}

/** A planning session's update_task. */
function serverEdit(stub, id, patch) {
  const item = Object.assign(stub.planItems.get(id), patch, { updatedAt: new Date().toISOString() });
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...item } }));
}

/** A planning session's delete_task. */
function serverDelete(stub, id) {
  stub.planItems.delete(id);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItemDeleted', id, projectId: storeProject.id }));
}

const items = () => useWorldStore.getState().planByProject[storeProject.id].items;
const openRows = () => buildOpenTaskRows({ items: items(), tasksById: {}, showArchived: false, now: Date.now() });
const openTitles = () => openRows().map((row) => row.title);

test('the reported scenario: create six, edit 1.001 with a long markdown description, delete the rest — 1.001 stays open, live and after reload', async () => {
  const stub = await setUp();
  for (const n of [1, 2, 3, 4, 5, 6]) serverCreate(stub, n);
  assert.equal(openRows().length, 6);

  serverEdit(stub, 'planned-1', { title: '1.001: Redesign notifications', description: LONG_DESCRIPTION });
  for (const n of [2, 3, 4, 5, 6]) serverDelete(stub, `planned-${n}`);

  assert.deepEqual(openTitles(), ['1.001: Redesign notifications'], 'live: the edited task shows under its new title');
  const [row] = openRows();
  assert.equal(row.id, 'planned-1');
  assert.equal(row.state, 'todo');
  assert.equal(row.description, LONG_DESCRIPTION);
  assert.ok(LONG_DESCRIPTION.length > 40_000, 'tens of KB of markdown with tables and code');

  await useWorldStore.getState().loadPlan(storeProject.id);
  assert.deepEqual(openTitles(), ['1.001: Redesign notifications'], 'after a reload the list is exactly what the server has');
  assert.equal(openRows()[0].description, LONG_DESCRIPTION);
});

test('a live edit keeps the task\'s place and status, and only changes its title and description', async () => {
  const stub = await setUp();
  for (const n of [1, 2, 3]) serverCreate(stub, n);
  const before = openRows().find((row) => row.id === 'planned-2');

  serverEdit(stub, 'planned-2', { title: '1.002: Renamed', description: 'Rewritten' });
  const after = openRows().find((row) => row.id === 'planned-2');
  assert.deepEqual(openRows().map((row) => row.id), ['planned-1', 'planned-2', 'planned-3'], 'same position');
  assert.deepEqual([after.title, after.description], ['1.002: Renamed', 'Rewritten']);
  assert.deepEqual([after.state, after.createdAt], [before.state, before.createdAt]);
});

test('an edit made while the Tasks list was closed (no live event) shows after a reload', async () => {
  const stub = await setUp();
  serverCreate(stub, 1);
  Object.assign(stub.planItems.get('planned-1'), { title: '1.001: Changed offline', description: LONG_DESCRIPTION });

  await useWorldStore.getState().loadPlan(storeProject.id);
  assert.deepEqual(openTitles(), ['1.001: Changed offline']);
});

test('deletes remove only the deleted tasks, live and after reload', async () => {
  const stub = await setUp();
  for (const n of [1, 2, 3]) serverCreate(stub, n);
  serverDelete(stub, 'planned-2');
  assert.deepEqual(openRows().map((row) => row.id), ['planned-1', 'planned-3']);
  await useWorldStore.getState().loadPlan(storeProject.id);
  assert.deepEqual(openRows().map((row) => row.id), ['planned-1', 'planned-3']);
});

test('a completed task is never an open task: it lists under Completed with its current title, so a done task is never lost from both', async () => {
  const stub = await setUp();
  serverCreate(stub, 1);
  serverEdit(stub, 'planned-1', { status: 'done', title: '1.001: Shipped' });

  assert.deepEqual(openTitles(), [], 'not an open task');
  const completed = buildCompletedRows({ items: items(), taskIds: [], tasksById: {}, now: Date.now() });
  assert.deepEqual(completed.map((row) => row.title), ['1.001: Shipped']);
});

test('an edit through the app\'s own task editor shows immediately in the same place', async () => {
  const stub = await setUp();
  for (const n of [1, 2]) serverCreate(stub, n);
  await useWorldStore.getState().updatePlanItem(storeProject.id, 'planned-1', { title: '1.001: Edited in app', description: LONG_DESCRIPTION });
  assert.deepEqual(openTitles(), ['1.001: Edited in app', '1.002: Step 2']);
  assert.equal(openRows()[0].description, LONG_DESCRIPTION);
});
