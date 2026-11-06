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

const types = await import('../src/lib/buildingTypes.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const make = (id, name, description, category, extra = {}) => ({ id, name, description, category, version: 1, repository: false, look: { model: 'generic', color: '#123456' }, workspace: id, devOnly: false, hasStorage: false, slots: [], agents: [], tables: [], rollups: [], ...extra });
const catalog = [
  make('software', 'Software', 'Build and fix software in a Git repository', 'Engineering', { repository: true }),
  make('seo', 'SEO', 'Keywords, sitemaps and rankings', 'Marketing'),
  make('sales', 'Sales and Marketing', 'Deals, customers and reach-outs', 'Marketing'),
  make('notes', 'Notes', 'Developer skeleton', 'Developer', { devOnly: true }),
];

test('U62 the picker search is case-insensitive over name and description', () => {
  assert.deepEqual(types.filterTypes(catalog, 'GIT').map((t) => t.id), ['software']);
  assert.deepEqual(types.filterTypes(catalog, 'seo').map((t) => t.id), ['seo']);
  assert.deepEqual(types.filterTypes(catalog, '  deals ').map((t) => t.id), ['sales']);
  assert.equal(types.filterTypes(catalog, '').length, 4);
});

test('U63 with many types, search and category combine as AND, an empty result says so, and a count is shown', () => {
  const many = Array.from({ length: 25 }, (_, i) => make(`type-${i}`, `Type ${i}`, i % 2 ? 'odd one' : 'even one', i % 5 === 0 ? 'Five' : 'Other'));
  assert.equal(types.filterTypes(many, 'odd', 'Five').length, 0 + many.filter((t, i) => i % 2 && i % 5 === 0).length);
  assert.equal(types.filterTypes(many, 'even', 'Other').length, many.filter((_, i) => i % 2 === 0 && i % 5 !== 0).length);
  assert.deepEqual(types.typeCategories(many), ['All', 'Five', 'Other']);
  assert.equal(types.typeResultsLabel(0, 25), 'No Building types match. Clear the search or pick another category.');
  assert.equal(types.typeResultsLabel(25, 25), '25 Building types');
  assert.equal(types.typeResultsLabel(1, 1), '1 Building type');
  assert.equal(types.typeResultsLabel(3, 25), '3 of 25 Building types');
});

test('U64 Software is the default, and Notes is excluded unless the dev flag is on', () => {
  assert.equal(types.defaultTypeId(catalog), 'software');
  assert.equal(types.defaultTypeId(catalog.slice(1)), 'seo');
  assert.equal(types.defaultTypeId([]), null);
  assert.deepEqual(types.selectableTypes(catalog, false).map((t) => t.id), ['software', 'seo', 'sales']);
  assert.equal(types.selectableTypes(catalog, true).length, 4);
});

test('U65 a server 400 maps to the field it names, or to the dialog when it names none', () => {
  const named = Object.assign(new Error('name is required'), { details: { error: 'name is required', field: 'name' } });
  assert.deepEqual(types.createErrorFor(named), { field: 'name', message: 'name is required' });
  const unknown = Object.assign(new Error('x'), { details: { error: 'Unknown Building type "x"', field: 'typeId' } });
  assert.equal(types.createErrorFor(unknown).field, 'typeId');
  assert.deepEqual(types.createErrorFor(new Error('Network down')), { field: null, message: 'Network down' });
  assert.deepEqual(types.createErrorFor('weird'), { field: null, message: 'Could not create the Building' });
});

test('U66/U67 the card badge and read-only follow the type and migration state', () => {
  assert.equal(types.buildingBadge({}), null);
  assert.equal(types.buildingBadge({ typeId: 'notes', readOnly: false }), null);
  assert.equal(types.buildingBadge({ typeUnavailable: true, readOnly: true }), 'Type unavailable');
  assert.equal(types.buildingBadge({ readOnly: true, readOnlyReason: 'Migration to version 2 failed and was rolled back from backup: x' }), 'Migration failed');
  assert.equal(types.buildingBadge({ readOnly: true, readOnlyReason: 'newer than the version 1' }), 'Read-only');
  assert.equal(types.isBuildingReadOnly({}), false);
  assert.equal(types.isBuildingReadOnly({ typeUnavailable: true }), true);
  assert.equal(types.isBuildingReadOnly({ readOnly: true }), true);
  assert.equal(types.readOnlyNotice({}), null);
  assert.equal(types.readOnlyNotice({ readOnly: true }), 'This Building is read-only.');
  assert.equal(types.readOnlyNotice({ readOnly: true, readOnlyReason: 'because' }), 'because');
});

test('U68/C18 the 3D look is distinct per type, Software is the original building, and an unknown type is generic', () => {
  assert.deepEqual(types.lookFor({}, catalog), { model: 'software', color: '#7295ad' });
  assert.deepEqual(types.lookFor({ typeId: 'software' }, catalog), types.SOFTWARE_LOOK);
  assert.deepEqual(types.lookFor({ typeId: 'notes' }, [make('notes', 'Notes', 'd', 'c', { look: { model: 'generic', color: '#e0a030' } })]), { model: 'generic', color: '#e0a030' });
  assert.deepEqual(types.lookFor({ typeId: 'mystery' }, catalog), { model: 'generic', color: types.GENERIC_LOOK_COLOR });
  assert.deepEqual(types.lookFor({ typeId: 'seo', typeUnavailable: true }, catalog), { model: 'generic', color: types.GENERIC_LOOK_COLOR });
  const scene = src('scene/ProjectYard.tsx');
  assert.match(scene, /lookFor\(/, 'the scene takes the look from lookFor instead of a hard-coded colour');
});

test('C6 the click opens the workspace for the Building\'s type, and a missing type opens the read-only shell', () => {
  assert.equal(types.workspaceFor({}), 'software');
  assert.equal(types.workspaceFor({ typeId: 'software' }), 'software');
  assert.equal(types.workspaceFor({ typeId: 'notes' }), 'notes');
  assert.equal(types.workspaceFor({ typeId: 'notes', typeUnavailable: true }), 'unavailable');
  assert.equal(types.workspaceFor({ typeId: 'unknown-to-the-web' }), 'unavailable');
  assert.match(src('ui/ProjectWorkspaceModal.tsx'), /workspaceFor\(/);
});

test('the Complete row of a workflow only talks about commit, push and a PR for a Building with a repository', () => {
  assert.equal(types.completeStageLabel(true), 'Complete: commit, push, raise PR');
  assert.ok(!/commit|push|PR/.test(types.completeStageLabel(false)));
  assert.match(src('ui/project-popup/TaskDialogs.tsx'), /completeStageLabel\(hasRepository\)/);
});

test('the Notes workspace has the platform Tasks board as a tab, so runs can be started and followed', () => {
  const modal = src('ui/ProjectWorkspaceModal.tsx');
  const notesShell = modal.slice(modal.indexOf('function NotesShell'), modal.indexOf('function UnavailableShell'));
  assert.match(notesShell, /<TasksPanel project=\{project\}/);
  assert.match(notesShell, /<NotesWorkspace project=\{project\}/);
  assert.match(notesShell, /<SettingsPanel/);
});

test('U60/C17 the workspaces of a Building without a repository never use Git words', () => {
  // User-visible text only: JSX text between tags and string attributes, not identifiers such as "branch" in a prop name.
  const visibleText = (file) => [...src(file).matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g), ...src(file).matchAll(/(?:title|placeholder|aria-label|label)="([^"]+)"/g)].map((m) => m[1]).join('\n').toLowerCase();
  for (const file of ['ui/NotesWorkspace.tsx', 'ui/project-popup/StorageSettings.tsx']) {
    const text = visibleText(file);
    assert.ok(text.length > 20, `${file} has visible text to check`);
    for (const git of ['branch', 'commit', 'push', 'pull request', ' git ', 'worktree']) assert.ok(!text.includes(git), `${file} says "${git}"`);
  }
});

test('C1 the store loads the types and creates a Building of the chosen type', async () => {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], buildingTypes: [], ...CLEAN_ERROR_STATE });
  await useWorldStore.getState().loadBuildingTypes();
  assert.deepEqual(useWorldStore.getState().buildingTypes.map((t) => t.id), ['software', 'notes']);
  assert.equal(await useWorldStore.getState().addProject('Plain'), true);
  assert.equal(useWorldStore.getState().projects.at(-1).typeId, 'software');
  assert.equal(stub.projects.size, 1);
});

test('C2 an unknown type or a missing name fails the create, keeps the dialog\'s field, and adds no Building', async () => {
  installServerStub();
  useWorldStore.setState({ projects: [], newBuildingField: null, ...CLEAN_ERROR_STATE });
  assert.equal(await useWorldStore.getState().addProject('Nope', undefined, 'nonexistent'), false);
  assert.equal(useWorldStore.getState().newBuildingField, 'typeId');
  assert.equal(await useWorldStore.getState().addProject('Notes', undefined, 'notes'), false, 'a dev-only type is refused without the dev flag');
  assert.equal(await useWorldStore.getState().addProject('  ', undefined, 'software'), false);
  assert.equal(useWorldStore.getState().newBuildingField, 'name');
  assert.equal(useWorldStore.getState().projects.length, 0);
  assert.equal(await useWorldStore.getState().addProject('Fine', undefined, 'software'), true);
  assert.equal(useWorldStore.getState().newBuildingField, null);
});

test('C3/C4/C5 the New Building dialog source: a searchable list with categories and descriptions, Software first, the Software form unchanged', () => {
  const top = src('ui/TopBar.tsx');
  assert.match(top, /filterTypes\(/);
  assert.match(top, /typeCategories\(/);
  assert.match(top, /defaultTypeId\(/);
  assert.match(top, /selectableTypes\(/, 'Notes is gated by the dev flag');
  assert.match(top, /GitHub repository URL \(optional\)/, 'the Software repository field is unchanged');
  assert.match(top, /Project name|Building name/);
});

test('the Building cards show a type badge only for the unavailable and read-only states', () => {
  assert.match(src('ui/ProjectCardsView.tsx'), /buildingBadge\(/);
});
