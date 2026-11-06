import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { BuildingTypeDefinition, CapabilityDeclaration, FieldSpec } from '../src/buildings/contract.ts';
import type { BuildingLinkRecord } from '../src/connections/types.ts';
import { fixtureType, makeProbe } from './helpers/connectionFixtures.ts';

/** The pure rules of cross-Building connections: field validation, declarations, approval, depth, rate limit, tool exposure, Activity filters. */

let tempRoot: string;
let fields: typeof import('../src/connections/fields.ts');
let rules: typeof import('../src/connections/rules.ts');
let registry: typeof import('../src/buildings/registry.ts');
let routes: typeof import('../src/api/buildingRoutes.ts');
let fixture: BuildingTypeDefinition;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'connections-pure-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  fields = await import('../src/connections/fields.ts');
  rules = await import('../src/connections/rules.ts');
  registry = await import('../src/buildings/registry.ts');
  routes = await import('../src/api/buildingRoutes.ts');
  fixture = fixtureType('pure-fixture', makeProbe(), rules.CapabilityError);
});

after(async () => { await rm(tempRoot, { recursive: true, force: true }); });

const echoInputs = (): FieldSpec[] => fixture.capabilities.find((c) => c.id === 'read-echo')!.inputs;
const check = (value: unknown) => fields.validateFields(echoInputs(), value);
const refused = (value: unknown) => { const r = check(value); assert.equal(r.ok, false); return r as { ok: false; field: string; error: string }; };
const cap = (patch: Partial<CapabilityDeclaration>): CapabilityDeclaration => ({ id: 'c', description: 'c', mode: 'read', inputs: [], outputs: [], ...patch });
const link = (patch: Partial<BuildingLinkRecord> = {}): BuildingLinkRecord => ({
  id: 'l', fromBuildingId: 'a', toBuildingId: 'b', capabilities: [], events: [], createdAt: '', updatedAt: '', ...patch,
});

test('U01 a full declaration is accepted and the browser copy of the type has no code', () => {
  assert.doesNotThrow(() => registry.assertValidDefinition(fixture));
  const view = routes.publicType(fixture);
  assert.ok(view.capabilities.every((c) => !('handle' in c)));
  const send = view.capabilities.find((c) => c.id === 'write-send')!;
  assert.deepEqual([send.mode, send.requiresApproval, send.inputs[0]?.max], ['write', undefined, 50]);
});

test('U02 a declaration with no read or write mode is refused at registration', () => {
  const broken = { ...fixture, capabilities: [{ id: 'x', description: 'x', inputs: [], outputs: [] } as unknown as CapabilityDeclaration] };
  assert.throws(() => registry.assertValidDefinition(broken), /capability "x" needs a mode/);
});

test('U03 a duplicate capability id is refused', () => {
  assert.throws(() => registry.assertValidDefinition({ ...fixture, capabilities: [cap({}), cap({})] }), /duplicate capability id "c"/);
});

test('U04 a duplicate event id is refused', () => {
  assert.throws(() => registry.assertValidDefinition({ ...fixture, events: [{ id: 'e', description: 'e' }, { id: 'e', description: 'e' }] }), /duplicate event id "e"/);
});

test('U05 a missing required input is refused naming the field', () => {
  assert.deepEqual(refused({}).field, 'text');
});

test('U06 a number for text, and text for a number, are refused naming the field', () => {
  assert.equal(refused({ text: 5 }).field, 'text');
  assert.equal(refused({ text: 'a', count: '5' }).field, 'count');
});

test('U07 an unknown extra field is refused naming it', () => {
  const r = refused({ text: 'a', extra: 1 });
  assert.equal(r.field, 'extra');
  assert.match(r.error, /extra is not a field/);
});

test('U08 text exactly at its cap is accepted', () => {
  assert.equal(check({ text: 'a'.repeat(10) }).ok, true);
});

test('U09 text one over its cap is refused, never truncated', () => {
  const r = refused({ text: 'a'.repeat(11) });
  assert.equal(r.field, 'text');
  assert.match(r.error, /at most 10 characters/);
});

test('U10 an emoji pair straddling the cap counts as one character', () => {
  assert.equal(check({ text: `${'a'.repeat(9)}😀` }).ok, true);
  assert.equal(refused({ text: `${'a'.repeat(10)}😀` }).field, 'text');
});

test('U11 numbers below the minimum, above the maximum, unsafe, infinite or NaN are refused', () => {
  assert.equal(refused({ text: 'a', count: -1 }).field, 'count');
  assert.equal(refused({ text: 'a', count: 101 }).field, 'count');
  assert.equal(refused({ text: 'a', count: Number.MAX_SAFE_INTEGER + 2 }).field, 'count');
  assert.equal(refused({ text: 'a', ratio: Number.NaN }).field, 'ratio');
  assert.equal(refused({ text: 'a', ratio: Number.POSITIVE_INFINITY }).field, 'ratio');
  assert.equal(refused({ text: 'a', ratio: '1e999' }).field, 'ratio');
});

test('U12 enum spellings other than the declared one are refused', () => {
  assert.equal(check({ text: 'a', kind: 'read' }).ok, true);
  assert.equal(refused({ text: 'a', kind: 'READ' }).field, 'kind');
  assert.equal(refused({ text: 'a', kind: ' read' }).field, 'kind');
});

test('U13 a list over its size is refused, and an error inside it names the item path', () => {
  assert.equal(refused({ text: 'a', items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] }).field, 'items');
  assert.equal(refused({ text: 'a', items: [{ name: 'a' }, { name: 'b' }, {}] }).field, 'items[2].name');
});

test('U14 null and an omitted optional field are treated the same', () => {
  const omitted = check({ text: 'a' });
  const nulled = check({ text: 'a', count: null, items: null });
  assert.deepEqual(omitted, nulled);
  assert.deepEqual(omitted.ok && omitted.value, { text: 'a' });
});

test('U15 a whitespace-only required text is refused', () => {
  assert.equal(refused({ text: '   ' }).field, 'text');
});

test('U16 a handler output that does not match its declared outputs is refused', () => {
  const outputs = fixture.capabilities.find((c) => c.id === 'read-badout')!.outputs;
  const result = fields.validateFields(outputs, { echo: 5 });
  assert.equal(result.ok, false);
});

test('U34 a read capability is never held for approval, even one that asks for it', () => {
  assert.equal(rules.approvalRequired(cap({ mode: 'read', requiresApproval: true }), false, 'agent'), false);
});

test('U35 a write capability is held for approval by default', () => {
  assert.equal(rules.approvalRequired(cap({ mode: 'write' }), false, 'person'), true);
});

test('U36 a pre-approved grant lets a scheduled job through without approval', () => {
  assert.equal(rules.approvalRequired(cap({ mode: 'write' }), true, 'job'), false);
});

test('U37 a pre-approved grant does not waive approval for an agent, a step or a person', () => {
  for (const kind of ['agent', 'step', 'person'] as const) assert.equal(rules.approvalRequired(cap({ mode: 'write' }), true, kind), true);
});

test('U38 a write capability that declares approval is not required is not held', () => {
  assert.equal(rules.approvalRequired(cap({ mode: 'write', requiresApproval: false }), false, 'person'), false);
});

test('U39 depths 1 to 3 are allowed and U40 depth 4 is refused by the default limit', () => {
  assert.deepEqual([1, 2, 3, 4].map((d) => rules.withinDepth(d, rules.DEFAULTS.maxDepth)), [true, true, true, false]);
});

test('U43 a configured limit replaces the default', () => {
  assert.equal(rules.withinDepth(4, 5), true);
  assert.equal(rules.withinDepth(2, 1), false);
});

test('U52 deliveries older than an hour are not counted, to the millisecond', () => {
  const now = 10 * rules.HOUR_MS;
  assert.deepEqual(rules.recentWithinHour([now - rules.HOUR_MS, now - rules.HOUR_MS + 1, now], now), [now - rules.HOUR_MS + 1, now]);
});

const offers = (session: Parameters<typeof rules.toolOffers>[0], links: BuildingLinkRecord[]) => rules.toolOffers(session, links, (id) => (id === 'b' ? fixture : undefined));
const granted = link({ capabilities: ['read-echo', 'write-send'].map((capabilityId) => ({ capabilityId, preApproved: false })) });

test('U63 an execute Task of a Building with an outgoing link gets every granted tool', () => {
  assert.deepEqual(offers('execute', [granted]).map((o) => o.capabilityId), ['read-echo', 'write-send']);
});

test('U64 a Building with no outgoing link gets none', () => {
  assert.deepEqual(offers('execute', []), []);
});

test('U65 a read-only workflow step gets read capabilities only', () => {
  assert.deepEqual(offers('readonly-step', [granted]).map((o) => o.capabilityId), ['read-echo']);
});

test('U66 a writable step gets read and write capabilities', () => {
  assert.deepEqual(offers('writable-step', [granted]).map((o) => o.mode), ['read', 'write']);
});

test('U67 a planning session gets read capabilities only', () => {
  assert.deepEqual(offers('planning', [granted]).map((o) => o.mode), ['read']);
});

test('U68 a link that only comes in gives the target no tools', () => {
  // `toolOffers` is handed the links that start at the session's Building; a link that ends there is never in that list.
  assert.deepEqual(offers('execute', []), []);
});

test('U69 a grant the target no longer offers is not exposed', () => {
  assert.deepEqual(offers('execute', [link({ capabilities: [{ capabilityId: 'gone', preApproved: false }, { capabilityId: 'read-echo', preApproved: false }] })]).map((o) => o.capabilityId), ['read-echo']);
});

test('U23 a link naming a capability the type no longer has is broken, and U24 a whole link is not', () => {
  assert.deepEqual(rules.brokenReasons(link({ capabilities: [{ capabilityId: 'gone', preApproved: false }], events: ['vanished'] }), fixture), [
    'The target no longer offers "gone"', 'The target no longer publishes "vanished"',
  ]);
  assert.deepEqual(rules.brokenReasons(granted, fixture), []);
  assert.equal(rules.brokenReasons(granted, undefined).length, 1);
});

test('U73 an Activity summary holds the inputs as one short line', () => {
  assert.deepEqual(rules.summarizeInputs({ a: 1 }), { text: '{"a":1}', shortened: false });
});

test('U74 long inputs are summarised and marked shortened', () => {
  const result = rules.summarizeInputs({ text: 'x'.repeat(500) });
  assert.equal(result.shortened, true);
  assert.equal([...result.text].length, rules.DEFAULTS.summaryLength);
});

test('U77 the Activity filter reads caller, capability and result', () => {
  assert.deepEqual(rules.parseActivityFilter({ caller: 'b1', capability: 'c', result: 'ok' }), { caller: 'b1', capability: 'c', result: 'ok', from: undefined, to: undefined, limit: rules.DEFAULTS.activityPageSize });
});

test('U79 a result that is not one of the known results is refused naming the parameter', () => {
  assert.throws(() => rules.parseActivityFilter({ result: 'great' }), (e: Error & { field?: string }) => e.field === 'result');
});

test('U80 the time range includes its boundaries as instants', () => {
  const filter = rules.parseActivityFilter({ from: '2026-10-12T00:00:00Z', to: '2026-10-12T00:00:00Z' });
  assert.equal(filter.from, filter.to);
});

test('U81 a from later than to is refused', () => {
  assert.throws(() => rules.parseActivityFilter({ from: '2026-10-13', to: '2026-10-12' }), (e: Error & { field?: string }) => e.field === 'from');
});

test('U82 date spellings: Z, an offset and a date alone parse; epoch digits, impossible dates and loose text do not', () => {
  const parse = rules.parseWhen;
  assert.equal(parse('2026-10-12T09:30:00Z'), Date.parse('2026-10-12T09:30:00Z'));
  assert.equal(parse('2026-10-12T15:00:00+05:30'), Date.parse('2026-10-12T09:30:00Z'));
  assert.equal(parse('2026-10-12'), Date.parse('2026-10-12'));
  assert.equal(parse('0001-01-01'), Date.parse('0001-01-01'));
  assert.equal(parse('9999-12-31T23:59:59Z'), Date.parse('9999-12-31T23:59:59Z'));
  for (const bad of ['1760000000', '2026-13-40', '2026-02-30', 'yesterday', '']) assert.equal(parse(bad), null, bad);
});

test('U89 Software declares Get open tasks as an ungated read and Start planning session as a gated run-starting write', async () => {
  await import('../src/buildings/types/index.ts');
  const software = registry.getBuildingType('software')!;
  const open = software.capabilities.find((c) => c.id === 'get-open-tasks')!;
  const start = software.capabilities.find((c) => c.id === 'start-planning-session')!;
  assert.equal(rules.needsApproval(open), false);
  assert.deepEqual([open.mode, start.mode, start.startsRun, rules.needsApproval(start)], ['read', 'write', true, true]);
});

test('U87 and U88 Start planning session refuses a prompt over its cap and a missing prompt', async () => {
  const start = registry.getBuildingType('software')!.capabilities.find((c) => c.id === 'start-planning-session')!;
  assert.equal(fields.validateFields(start.inputs, { prompt: 'p'.repeat(10_001) }).ok, false);
  assert.equal((fields.validateFields(start.inputs, {}) as { field: string }).field, 'prompt');
  assert.equal(fields.validateFields(start.inputs, { prompt: 'p'.repeat(10_000) }).ok, true);
  assert.equal(fields.validateFields(start.inputs, { prompt: 'Plan the login page' }).ok, true);
});
