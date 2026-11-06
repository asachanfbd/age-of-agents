import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuildingTypeDefinition } from '../src/buildings/contract.ts';
import { LOCAL_TENANT_ID, LOCAL_USER_ID, ownershipOf, withOwnership } from '../src/buildings/ownership.ts';
import { normalizeProject } from '../src/buildings/normalize.ts';
import { devTypesEnabled, getBuildingType, hasBuildingType, listBuildingTypes, registerBuildingType, unregisterBuildingType } from '../src/buildings/registry.ts';
import '../src/buildings/types/index.ts';
import { notesType } from '../src/buildings/types/notes.ts';
import { softwareType } from '../src/buildings/types/software.ts';
import type { ProjectRecord } from '../src/domain/types.ts';

const fake = (patch: Partial<BuildingTypeDefinition> = {}): BuildingTypeDefinition => ({
  ...notesType, id: 'fake', name: 'Fake', slots: [{ id: 's', label: 'S', usedWhen: 'x', defaultWorkflowId: 'w' }], ...patch,
});

const legacy = (patch: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: 'p1', name: 'Old', slug: 'old', relativePath: 'projects/old', status: 'idle', position: null,
  activeTaskId: null, activeTaskIds: [], taskCount: 2, createdAt: 't', updatedAt: 't', ...patch,
});

test('U1/U2/U3 the registry knows Software then Notes, in a stable order, and an unknown id is undefined', () => {
  assert.equal(getBuildingType('software'), softwareType);
  assert.equal(getBuildingType('notes'), notesType);
  assert.deepEqual(listBuildingTypes().slice(0, 2).map((t) => t.id), ['software', 'notes']);
  assert.equal(getBuildingType('nope'), undefined);
  assert.equal(hasBuildingType('nope'), false);
  assert.equal(getBuildingType('Software'), undefined, 'type ids match exactly');
});

test('U4 registering the same id twice throws', () => {
  assert.throws(() => registerBuildingType(softwareType), /already registered/);
});

test('U5 a definition missing a contract field is rejected with the field named', () => {
  assert.throws(() => registerBuildingType(fake({ name: '' })), /name/);
  assert.throws(() => registerBuildingType(fake({ description: ' ' })), /description/);
  assert.throws(() => registerBuildingType(fake({ id: 'Bad Id' })), /id/);
  assert.throws(() => registerBuildingType(fake({ version: 0 })), /version/);
  assert.throws(() => registerBuildingType(fake({ validateCreate: undefined as never })), /validateCreate/);
  assert.throws(() => registerBuildingType(fake({ events: undefined as never })), /events/);
  assert.throws(() => registerBuildingType(fake({ workspace: '' })), /workspace/);
});

test('U6 slot ids are unique and each has a default workflow', () => {
  const slot = { id: 'a', label: 'A', usedWhen: 'x', defaultWorkflowId: 'w' };
  assert.throws(() => registerBuildingType(fake({ slots: [slot, slot] })), /duplicate slot id "a"/);
  assert.throws(() => registerBuildingType(fake({ slots: [{ ...slot, defaultWorkflowId: '' }] })), /defaultWorkflowId/);
});

test('U7 declarations are stored as given, empty is valid, and nothing executes them', () => {
  const jobs = [{ id: 'daily', description: 'd', cron: '0 3 * * *' }];
  registerBuildingType(fake({ id: 'declares', scheduledJobs: jobs, capabilities: [{ id: 'c', description: 'c', mode: 'read', inputs: [], outputs: [] }], events: [{ id: 'e', description: 'e' }] }));
  assert.deepEqual(getBuildingType('declares')?.scheduledJobs, jobs);
  assert.deepEqual(getBuildingType('declares')?.events, [{ id: 'e', description: 'e' }]);
  unregisterBuildingType('declares');
  assert.deepEqual(softwareType.scheduledJobs, []);
});

test('U8/U9/U10 Software declares a repository and its two slots; Notes declares none and a large table', () => {
  assert.equal(getBuildingType('software')?.repository, true);
  assert.deepEqual(softwareType.slots.map((s) => [s.id, s.defaultWorkflowId]), [['feature', 'software-development'], ['bug', 'bug-fix']]);
  assert.ok(softwareType.agents.length > 0);
  assert.equal(softwareType.storage, undefined, 'Software keeps the central store');
  assert.equal(getBuildingType('notes')?.repository, false);
  assert.equal(notesType.slots.length, 1);
  assert.ok(notesType.storage?.tables.some((t) => t.name === 'metrics'));
});

test('U13 an invalid storage declaration is rejected at registration', () => {
  const storage = notesType.storage!;
  assert.throws(() => registerBuildingType(fake({ storage: { ...storage, retention: { table: 'nope', timeColumn: 'day', months: 12, mode: 'discard' } } })), /retention/);
  assert.throws(() => registerBuildingType(fake({ storage: { ...storage, retention: { table: 'metrics', timeColumn: 'query', months: 12, mode: 'discard' } } })), /sortable/);
  assert.throws(() => registerBuildingType(fake({ storage: { ...storage, tables: [{ ...storage.tables[0]!, name: 'a; DROP' }] } })), /identifier/);
  assert.throws(() => registerBuildingType(fake({ storage: { ...storage, migrations: [{ toVersion: 5, sql: [] }] } })), /migrations/);
  assert.throws(() => registerBuildingType(fake({ version: 3, storage })), /version/);
});

test('U11 Software needs a name; U12 Notes validates its name and ignores unknown fields', () => {
  assert.deepEqual(softwareType.validateCreate({ name: ' Shop ' }), { ok: true, value: { name: 'Shop' } });
  assert.deepEqual(softwareType.validateCreate({ name: 'Shop', repositoryUrl: 'https://github.com/a/b' }), { ok: true, value: { name: 'Shop', repositoryUrl: 'https://github.com/a/b' } });
  const badUrl = softwareType.validateCreate({ name: 'Shop', repositoryUrl: 'not a url' });
  assert.deepEqual([badUrl.ok, !badUrl.ok && badUrl.field], [false, 'repositoryUrl']);
  assert.deepEqual(softwareType.validateCreate({}), { ok: false, field: 'name', error: 'name is required' });
  assert.deepEqual(notesType.validateCreate({ name: 'n', extra: 1, repositoryUrl: 'https://github.com/a/b' }), { ok: true, value: { name: 'n' } });
  for (const bad of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, null, { name: 4 }]) {
    const result = notesType.validateCreate(bad);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.field, 'name');
  }
});

test('U14 the dev-only Notes type is marked devOnly, and the dev flag is read from the environment each time', () => {
  assert.equal(notesType.devOnly, true);
  assert.equal(softwareType.devOnly, undefined);
  delete process.env.AGENT_VISUAL_OS_DEV_TYPES;
  assert.equal(devTypesEnabled(), false);
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  try {
    assert.equal(devTypesEnabled(), true);
  } finally {
    delete process.env.AGENT_VISUAL_OS_DEV_TYPES;
  }
});

test('U15/U16/U17/U18 owner and tenant default to the local user, explicit values survive, and a read does not rewrite', () => {
  assert.deepEqual(withOwnership({ id: 'a' }), { id: 'a', ownerId: LOCAL_USER_ID, tenantId: LOCAL_TENANT_ID });
  assert.equal(withOwnership({ ownerId: 'u2', tenantId: 't2' }).ownerId, 'u2');
  assert.equal(withOwnership({ ownerId: 'u2' }).tenantId, LOCAL_TENANT_ID);
  const stored = legacy();
  assert.deepEqual(ownershipOf(stored), { ownerId: LOCAL_USER_ID, tenantId: LOCAL_TENANT_ID });
  assert.equal('ownerId' in stored, false);
});

test('U19/U21/U22 a Project stored before Building Types reads as Software v1, losslessly and idempotently', () => {
  const stored = legacy({ repositoryUrl: 'https://github.com/a/b', activeTaskIds: ['t1'] });
  const view = normalizeProject(stored);
  assert.equal(view.typeId, 'software');
  assert.equal(view.typeVersion, 1);
  assert.equal(view.typeUnavailable, false);
  assert.equal(view.readOnly, false);
  assert.deepEqual({ ...view, typeId: undefined, typeVersion: undefined, ownerId: undefined, tenantId: undefined, typeUnavailable: undefined, readOnly: undefined, readOnlyReason: undefined },
    { ...stored, typeId: undefined, typeVersion: undefined, ownerId: undefined, tenantId: undefined, typeUnavailable: undefined, readOnly: undefined, readOnlyReason: undefined });
  assert.deepEqual(normalizeProject(view), view);
});

test('U20 a Project whose type is no longer registered keeps every field and is read-only with a notice', () => {
  const stored = legacy({ typeId: 'gone', typeVersion: 4, name: 'Keep me' });
  const view = normalizeProject(stored);
  assert.equal(view.typeUnavailable, true);
  assert.equal(view.readOnly, true);
  assert.match(view.readOnlyReason!, /"gone".*no longer available/);
  assert.equal(view.name, 'Keep me');
  assert.equal(view.typeVersion, 4);
});

test('U58 a stored read-only reason (failed migration, newer data) makes a registered type read-only', () => {
  const view = normalizeProject(legacy({ typeId: 'notes', readOnlyReason: 'Migration failed' }));
  assert.equal(view.typeUnavailable, false);
  assert.equal(view.readOnly, true);
  assert.equal(view.readOnlyReason, 'Migration failed');
});
