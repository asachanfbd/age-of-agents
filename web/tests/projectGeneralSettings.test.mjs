import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
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

const { canSaveName, canConfirmDelete, readOnlyReason, deleteFailureOf, READ_ONLY_NOTICE, NAME_HINT, PROJECT_NAME_MAX } = await import('../src/lib/projectGeneralSettings.ts');
const { ApiError, serverApi } = await import('../src/lib/serverApi.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');

const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const panel = src('ui/project-popup/GeneralSettings.tsx');

const serverProject = (id, name) => ({ id, name, slug: id, relativePath: `projects/${id}`, status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: '', updatedAt: '' });
const projectData = (id, name) => ({ id, name, slug: id, position: [1, 2], status: 'idle', activeTaskId: null, taskCount: 0 });

function seed() {
  useWorldStore.setState({
    projects: [projectData('a', 'Alpha'), projectData('b', 'Beta')],
    tasksById: { ta: { id: 'ta', projectId: 'a' }, tb: { id: 'tb', projectId: 'b' } },
    taskIdsByProject: { a: ['ta'], b: ['tb'] },
    lastTaskIdByProject: { a: 'ta', b: 'tb' },
    planByProject: { a: { items: [] }, b: { items: [] } },
    planItemQueueByProject: { a: [], b: [] },
    workflowRunsByProject: { a: [], b: [] },
    commandRunIdsByProject: { a: [], b: [] },
    notificationsById: { na: { id: 'na', projectId: 'a' }, nb: { id: 'nb', projectId: 'b' }, ns: { id: 'ns', projectId: null } },
    selectedId: 'a',
    workspaceProjectId: 'a',
  });
}

test('U13 canSaveName is false for empty, whitespace, unchanged and saving, true for a changed name', () => {
  assert.equal(canSaveName('', 'A', false), false);
  assert.equal(canSaveName('   ', 'A', false), false);
  assert.equal(canSaveName(' A ', 'A', false), false);
  assert.equal(canSaveName('B', 'A', true), false);
  assert.equal(canSaveName('B', 'A', false), true);
});

test('U14-U16 canConfirmDelete needs the exact full name', () => {
  assert.equal(canConfirmDelete('My app', 'My app'), true);
  assert.equal(canConfirmDelete('  My app ', 'My app'), true);
  for (const wrong of ['', 'My', 'my app', 'My app!']) assert.equal(canConfirmDelete(wrong, 'My app'), false, wrong);
  assert.equal(canConfirmDelete('x'.repeat(80), 'x'.repeat(80)), true);
  assert.equal(canConfirmDelete('項目', '項目'), true);
});

test('U17 readOnlyReason explains an unavailable type and newer data, and is null otherwise', () => {
  assert.equal(readOnlyReason({ typeUnavailable: true }), READ_ONLY_NOTICE);
  assert.equal(readOnlyReason({ readOnly: true, readOnlyReason: 'newer data' }), READ_ONLY_NOTICE);
  assert.equal(readOnlyReason({}), null);
});

test('U18 a 409 locks the delete dialog; any other error keeps it retryable', () => {
  assert.deepEqual(deleteFailureOf(new ApiError('A task is running', 409)), { mode: 'locked', message: 'A task is running' });
  assert.deepEqual(deleteFailureOf(new ApiError('Boom', 500)), { mode: 'retry', message: 'Boom' });
  assert.deepEqual(deleteFailureOf('weird'), { mode: 'retry', message: 'Could not delete the project.' });
});

test('C9 serverApi.renameProject sends PATCH with the name and surfaces an error body', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init]);
    return calls.length === 1
      ? new Response(JSON.stringify(serverProject('a', 'New')), { status: 200 })
      : new Response(JSON.stringify({ error: 'Name must be 1 to 80 characters.', field: 'name' }), { status: 400 });
  };
  try {
    assert.equal((await serverApi.renameProject('a', 'New')).name, 'New');
    assert.match(calls[0][0], /\/api\/projects\/a$/);
    assert.equal(calls[0][1].method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[0][1].body), { name: 'New' });
    await assert.rejects(serverApi.renameProject('a', ''), (error) => error.status === 400 && /1 to 80/.test(error.message) && error.details.field === 'name');
  } finally { globalThis.fetch = original; }
});

test('C1-C3 renameProject saves the name in the store; a failure rejects with the message and changes nothing', async () => {
  seed();
  const original = serverApi.renameProject;
  serverApi.renameProject = async (id, name) => {
    if (name === 'bad') throw new ApiError('Name must be 1 to 80 characters.', 400, { field: 'name' });
    return serverProject(id, name);
  };
  try {
    await useWorldStore.getState().renameProject('a', 'Alpha 2');
    assert.equal(useWorldStore.getState().projects.find((p) => p.id === 'a').name, 'Alpha 2');
    assert.deepEqual(useWorldStore.getState().projects.find((p) => p.id === 'a').position, [1, 2]);
    await assert.rejects(useWorldStore.getState().renameProject('a', 'bad'), /1 to 80/);
    assert.equal(useWorldStore.getState().projects.find((p) => p.id === 'a').name, 'Alpha 2');
  } finally { serverApi.renameProject = original; }
});

test('C4 deleteProject removes the project, its tasks, notifications and per-project maps, and closes its popups', async () => {
  seed();
  const original = serverApi.deleteProject;
  serverApi.deleteProject = async () => undefined;
  try {
    await useWorldStore.getState().deleteProject('a');
    const state = useWorldStore.getState();
    assert.deepEqual(state.projects.map((p) => p.id), ['b']);
    assert.deepEqual(Object.keys(state.tasksById), ['tb']);
    assert.deepEqual(Object.keys(state.notificationsById).sort(), ['nb', 'ns']);
    for (const map of [state.taskIdsByProject, state.lastTaskIdByProject, state.planByProject, state.workflowRunsByProject]) assert.deepEqual(Object.keys(map), ['b']);
    assert.equal(state.workspaceProjectId, null);
    assert.equal(state.selectedId, null);
  } finally { serverApi.deleteProject = original; }
});

test('C4 deleting another project leaves an open popup alone', async () => {
  seed();
  const original = serverApi.deleteProject;
  serverApi.deleteProject = async () => undefined;
  try {
    await useWorldStore.getState().deleteProject('b');
    assert.equal(useWorldStore.getState().workspaceProjectId, 'a');
  } finally { serverApi.deleteProject = original; }
});

test('C5 a delete 409 rejects with the server reason and leaves state and popup as they were', async () => {
  seed();
  const original = serverApi.deleteProject;
  serverApi.deleteProject = async () => { throw new ApiError('Project "Alpha" already has an active task', 409); };
  try {
    await assert.rejects(useWorldStore.getState().deleteProject('a'), /active task/);
    assert.equal(useWorldStore.getState().projects.length, 2);
    assert.equal(useWorldStore.getState().workspaceProjectId, 'a');
  } finally { serverApi.deleteProject = original; }
});

test('C6/C7 a projectDeleted event drops the Building live, and a repeat after the action already removed it is a no-op', () => {
  seed();
  const patch = mergeWorkerEvent(useWorldStore.getState(), { type: 'projectDeleted', projectId: 'a' });
  assert.deepEqual(patch.projects.map((p) => p.id), ['b']);
  assert.equal(patch.workspaceProjectId, null);
  assert.deepEqual(mergeWorkerEvent({ ...useWorldStore.getState(), projects: [projectData('b', 'Beta')] }, { type: 'projectDeleted', projectId: 'a' }), {});
});

test('C8/U20 a project event with a new name changes only the name; position stays', () => {
  seed();
  const patch = mergeWorkerEvent(useWorldStore.getState(), { type: 'project', project: serverProject('a', 'Renamed') });
  const renamed = patch.projects.find((p) => p.id === 'a');
  assert.equal(renamed.name, 'Renamed');
  assert.deepEqual(renamed.position, [1, 2]);
});

test('C17 a project event for one project keeps the other project\'s object, and a log chunk leaves projects alone', () => {
  seed();
  const state = useWorldStore.getState();
  const patch = mergeWorkerEvent(state, { type: 'project', project: serverProject('a', 'Renamed') });
  assert.equal(patch.projects.find((p) => p.id === 'b'), state.projects.find((p) => p.id === 'b'));
  assert.equal(mergeWorkerEvent(state, { type: 'commandRunLog', runId: 'none', chunk: 'x' }).projects, undefined);
});

test('C10/C11 the name form: 80-character limit, hint, Enter-to-save form, saving label, alert and toast', () => {
  assert.equal(PROJECT_NAME_MAX, 80);
  assert.equal(NAME_HINT, 'The folder name stays the same.');
  assert.match(panel, /maxLength=\{PROJECT_NAME_MAX\}/);
  assert.match(panel, /aria-describedby="project-name-hint"/);
  assert.match(panel, /<form onSubmit=\{save\}/);
  assert.match(panel, /saving \? 'Saving…' : 'Save'/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /setError\(null\)/);
  assert.match(panel, /toast\.success\('Project renamed'\)/);
});

test('C12/C13/C15 the danger zone and the typed-name dialog', () => {
  assert.match(panel, /Danger zone/);
  assert.match(panel, /variant="destructive"/);
  assert.match(panel, /role="alertdialog"/);
  assert.match(panel, /Delete project\?/);
  assert.match(panel, /projects\/\{project\.slug\}/);
  assert.match(panel, /to confirm/);
  assert.match(panel, /\{locked \? 'Close' : 'Cancel'\}/);
  assert.match(panel, /\{!locked && \(/);
  assert.match(panel, /deleting \? 'Deleting…' : 'Delete project'/);
  assert.match(panel, /toast\.success\('Project deleted'\)/);
});

test('C14 a read-only Building disables the input, Save and Delete with a visible reason', () => {
  assert.match(panel, /disabled=\{reason !== null\}/);
  assert.match(panel, /\{reason && <p className="mt-2 text-sm text-muted-foreground">\{reason\}<\/p>\}/);
  assert.match(src('ui/project-popup/SettingsPanel.tsx'), /current === 'general' && <GeneralSettings project=\{project\} \/>/);
});

test('C16 Content Studio keeps its own settings name field, which reaches the shared rename path server-side', () => {
  assert.match(src('ui/project-popup/SettingsPanel.tsx'), /general: \{ label: 'General'/);
});
