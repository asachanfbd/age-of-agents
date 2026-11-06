import { createQuietProject } from './helpers/quietProject.ts';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { ProjectRecord, TaskRecord } from '../src/domain/types.ts';
import type { Connections } from '../src/connections/service.ts';
import type { Scheduler } from '../src/scheduler/scheduler.ts';
import { fixtureType, makeProbe } from './helpers/connectionFixtures.ts';
import { fakeClock, fakeStarter } from './helpers/schedulerFakes.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/**
 * Links, capability calls, approvals, events, the Activity log, deletion and the session tools over HTTP. The
 * service runs on an injected clock with a short timeout, a tiny hourly event limit and a fake job starter; the
 * scheduler is the real one with a fake run starter, so nothing real is ever started.
 */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let scheduler: Scheduler;
let connections: Connections;
let collections: typeof import('../src/db/collections.ts');
let registry: typeof import('../src/buildings/registry.ts');
let serviceModule: typeof import('../src/connections/service.ts');
let rules: typeof import('../src/connections/rules.ts');
let runStarterModule: typeof import('../src/scheduler/runStarter.ts');
let hooks: typeof import('../src/terminal/projectCliHooks.ts');
let capabilityTool: typeof import('../src/terminal/capabilityTool.ts');
let mcpServers: typeof import('../src/terminal/mcpServers.ts');
let runs: ReturnType<typeof fakeStarter>;
const clock = fakeClock('2026-10-12T09:00:00.000Z');
const probe = makeProbe();
const notices: { kind: string; projectId: string }[] = [];
const resolved: string[] = [];
let buildingCount = 0;
const EVENTS_PER_HOUR = 3;
const WINDOW_MS = 60_000;
/** While true the test's job starter behaves as a daemon whose scheduler is down. */
let subscriberDown = false;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'connections-api-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  const schedulerModule = await import('../src/scheduler/scheduler.ts');
  serviceModule = await import('../src/connections/service.ts');
  rules = await import('../src/connections/rules.ts');
  runStarterModule = await import('../src/scheduler/runStarter.ts');
  registry = await import('../src/buildings/registry.ts');
  collections = await import('../src/db/collections.ts');
  hooks = await import('../src/terminal/projectCliHooks.ts');
  capabilityTool = await import('../src/terminal/capabilityTool.ts');
  mcpServers = await import('../src/terminal/mcpServers.ts');
  await import('../src/buildings/types/index.ts');
  registry.registerBuildingType(fixtureType('cx', probe, rules.CapabilityError));

  runs = fakeStarter(schedulerModule.NoFreeSlotError);
  const fakeManager = { executePlanItem: async () => ({ id: 'unused' }), hasFreeSlot: async () => true, onWorkerEvent: () => () => undefined };
  connections = makeConnections();
  // Capability jobs go through the real starter; every other job through the fake one.
  const capabilityStarter = runStarterModule.createManagerRunStarter(fakeManager as never, connections);
  const starter = {
    start: (request: Parameters<typeof runs.starter.start>[0] & { chainDepth?: number }) => (request.job.target.kind === 'capability' ? capabilityStarter.start(request) : runs.starter.start(request)),
    state: (runId: string) => (runId.startsWith('call:') ? capabilityStarter.state(runId) : runs.starter.state(runId)),
    subscribe: (listener: Parameters<typeof runs.starter.subscribe>[0]) => { const a = runs.starter.subscribe(listener); const b = capabilityStarter.subscribe(listener); return () => { a(); b(); }; },
  };
  scheduler = schedulerModule.createScheduler({ starter, now: clock.now, setTimer: clock.setTimer, hostTimezone: 'UTC' });
  await scheduler.start();
  server = createDaemonServer({ scheduler, connections });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  scheduler.stop();
  await scheduler.idle();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The service as the daemon builds it, except for the clock, limits and the job starter that reaches the test scheduler. */
function makeConnections(overrides: Partial<Parameters<typeof serviceModule.createConnections>[0]> = {}): Connections {
  return serviceModule.createConnections({
    now: clock.now, timeoutMs: 300, idempotencyWindowMs: WINDOW_MS, eventsPerHour: EVENTS_PER_HOUR,
    async startJob({ subscription, deliveryId, eventId, depth }) {
      if (subscriberDown) throw new serviceModule.SubscriberUnavailableError('down');
      const { status, entry } = await scheduler.runForEvent(subscription.subscriberBuildingId, subscription.jobId, { deliveryId, label: eventId, depth });
      return { state: status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : 'started', runId: entry.runId, note: entry.note };
    },
    hasStarted: async (deliveryId) => (await collections.jobHistoryDb.find((entry) => entry.change?.startsWith(`event:${deliveryId} `) === true)).length > 0,
    notify: async ({ kind, projectId }) => { notices.push({ kind, projectId }); },
    resolveApprovalNotice: async (projectId) => { resolved.push(projectId); },
    ...overrides,
  });
}

async function api(pathname: string, init?: RequestInit & { token?: boolean }) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.token ? { authorization: `Bearer ${hooks.CLI_HOOK_TOKEN}` } : {}), ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const send = (method: string, pathname: string, body?: unknown, token = false) => api(pathname, { method, body: body === undefined ? undefined : JSON.stringify(body), token });

async function building(typeId = 'cx'): Promise<ProjectRecord> {
  buildingCount += 1;
  const name = `Connected ${buildingCount}`;
  // A software Building is made through the service so no setup item and run are started on it.
  if (typeId === 'software') return (await createQuietProject(name)).body;
  const res = await send('POST', '/api/projects', { name, typeId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const allCaps = ['read-echo', 'read-slow', 'read-badout', 'read-busy', 'read-throw', 'read-nested', 'write-send', 'write-open', 'write-latch', 'write-held', 'write-run'];
async function link(from: { id: string }, to: { id: string }, patch: Record<string, unknown> = {}) {
  const res = await send('POST', '/api/links', { fromBuildingId: from.id, toBuildingId: to.id, capabilities: allCaps, events: ['report-published', 'deal-won'], ...patch });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}
const call = (from: { id: string }, to: { id: string }, capabilityId: string, inputs: unknown = {}, extra: Record<string, unknown> = {}) =>
  send('POST', `/api/projects/${from.id}/capability-calls`, { targetBuildingId: to.id, capabilityId, inputs, ...extra });
const activity = async (b: { id: string }, query = ''): Promise<any[]> => (await api(`/api/projects/${b.id}/activity${query}`)).body.entries;
const pair = async () => { const a = await building(); const b = await building(); await link(a, b); return { a, b }; };
const resetProbe = () => Object.assign(probe, makeProbe());

async function addJob(b: { id: string }, patch: Record<string, unknown> = {}) {
  const res = await send('POST', `/api/projects/${b.id}/schedules/jobs`, {
    name: 'Job', trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'slot', slotId: 'review', description: 'Review.' }, ...patch,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}
async function task(b: { id: string }, patch: Partial<TaskRecord> = {}): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const record = {
    id: `task-${Math.random().toString(36).slice(2)}`, projectId: b.id, templateId: 'builder', executorId: 'test-claude-cli', description: 'Work', status: 'developing', autonomy: 'auto',
    manager: false, kind: 'execute', planItemId: null, sessionId: 's', blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 }, createdAt: now, updatedAt: now, completedAt: null, ...patch,
  } as TaskRecord;
  return collections.tasksDb.insert(record);
}
const agentCall = (taskId: string, body: Record<string, unknown>) => send('POST', `/api/agent-capabilities/calls?taskId=${taskId}`, body, true);
const agentList = async (taskId: string) => (await send('GET', `/api/agent-capabilities/capabilities?taskId=${taskId}`, undefined, true)).body.capabilities as Array<{ capabilityId: string }>;

// ---- Links ----

test('I01 creating a link answers 201 and I02 the list shows it outgoing for one end and incoming for the other', async () => {
  const a = await building(); const b = await building();
  const made = await link(a, b);
  const fromA = (await api(`/api/projects/${a.id}/links`)).body;
  const fromB = (await api(`/api/projects/${b.id}/links`)).body;
  assert.deepEqual([fromA.outgoing.map((l: any) => l.id), fromA.incoming.length], [[made.id], 0]);
  assert.deepEqual([fromB.incoming.map((l: any) => l.id), fromB.outgoing.length], [[made.id], 0]);
  assert.deepEqual([fromA.outgoing[0].broken, fromA.outgoing[0].fromName, fromA.outgoing[0].toName], [false, a.name, b.name]);
});

test('every link is listed for the 3D scene with its Buildings\' names and broken flag', async () => {
  const { a, b } = await pair();
  const all = (await api('/api/links')).body as Array<{ fromBuildingId: string; toBuildingId: string; fromName: string; broken: boolean }>;
  const mine = all.find((l) => l.fromBuildingId === a.id && l.toBuildingId === b.id);
  assert.deepEqual([mine?.fromName, mine?.broken], [a.name, false]);
});

test('I03 updating grants replaces them and removing an event grant removes its subscriptions, I04 deleting a link removes it', async () => {
  const a = await building(); const b = await building();
  const made = await link(a, b);
  const job = await addJob(a);
  const sub = await send('POST', '/api/subscriptions', { subscriberBuildingId: a.id, sourceBuildingId: b.id, eventId: 'deal-won', jobId: job.id });
  assert.equal(sub.status, 201);
  const patched = await send('PATCH', `/api/links/${made.id}`, { capabilities: [{ capabilityId: 'write-send', preApproved: true }], events: ['report-published'] });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.capabilities, [{ capabilityId: 'write-send', preApproved: true }]);
  assert.equal((await api(`/api/projects/${a.id}/subscriptions`)).body.length, 0);
  assert.equal((await send('DELETE', `/api/links/${made.id}`)).status, 204);
  assert.equal((await api(`/api/projects/${a.id}/links`)).body.outgoing.length, 0);
  assert.equal((await send('DELETE', `/api/links/${made.id}`)).status, 404);
});

test('I05 a link to or from an unknown Building is 404', async () => {
  const a = await building();
  assert.equal((await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: 'nope' })).status, 404);
  assert.equal((await send('POST', '/api/links', { fromBuildingId: 'nope', toBuildingId: a.id })).status, 404);
});

test('I06 and U20 granting something the target does not declare is 400 naming the field, and U21 an undeclared event the same', async () => {
  const a = await building(); const b = await building();
  const cap = await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: b.id, capabilities: ['read-echo', 'invented'] });
  assert.deepEqual([cap.status, cap.body.field], [400, 'capabilities[1].capabilityId']);
  const event = await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: b.id, events: ['nope'] });
  assert.deepEqual([event.status, event.body.field], [400, 'events[0]']);
});

test('I07 and U19 a second link from the same Building to the same target is 409, but the reverse direction is a separate link (U22)', async () => {
  const a = await building(); const b = await building();
  await link(a, b);
  assert.equal((await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: b.id })).status, 409);
  assert.equal((await call(b, a, 'read-echo', { text: 'x' })).status, 403);
  assert.equal((await send('POST', '/api/links', { fromBuildingId: b.id, toBuildingId: a.id, capabilities: ['read-echo'] })).status, 201);
  assert.equal((await call(b, a, 'read-echo', { text: 'x' })).status, 200);
});

test('I08 and U18 a Building cannot be linked to itself', async () => {
  const a = await building();
  const res = await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: a.id });
  assert.deepEqual([res.status, res.body.field], [400, 'toBuildingId']);
});

test('I09 a body that is not an object, or grants that are not a list, are 400', async () => {
  const a = await building(); const b = await building();
  assert.equal((await send('POST', '/api/links', [1])).status, 400);
  const res = await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: b.id, capabilities: 'read-echo' });
  assert.deepEqual([res.status, res.body.field], [400, 'capabilities']);
  assert.equal((await send('PATCH', '/api/links/missing', {})).status, 404);
});

test('U17 grants are deduplicated on create', async () => {
  const a = await building(); const b = await building();
  const res = await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: b.id, capabilities: ['read-echo', 'read-echo'] });
  assert.equal(res.body.capabilities.length, 1);
});

test('U25 only a capability that needs approval can be pre-approved', async () => {
  const a = await building(); const b = await building();
  const bad = await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: b.id, capabilities: [{ capabilityId: 'read-echo', preApproved: true }] });
  assert.deepEqual([bad.status, bad.body.field], [400, 'capabilities[0].preApproved']);
  const good = await send('POST', '/api/links', { fromBuildingId: a.id, toBuildingId: b.id, capabilities: [{ capabilityId: 'write-send', preApproved: true }] });
  assert.equal(good.status, 201);
});

test('I10 links survive a reload of the stored data, and I11 U32 I20 after the target type loses a capability the link lists as broken, with calls answering 409 and nothing crashing', async () => {
  const a = await building();
  const type = registry.getBuildingType('cx')!;
  registry.registerBuildingType({ ...type, id: 'cx-shrinking', capabilities: [...type.capabilities] });
  const c = await building('cx-shrinking');
  await link(a, c);
  assert.equal((await api(`/api/projects/${a.id}/links`)).body.outgoing[0].broken, false);
  registry.unregisterBuildingType('cx-shrinking');
  registry.registerBuildingType({ ...type, id: 'cx-shrinking', capabilities: type.capabilities.filter((cap) => cap.id !== 'read-echo') });
  const view = (await api(`/api/projects/${a.id}/links`)).body.outgoing[0];
  assert.equal(view.broken, true);
  assert.match(view.brokenReasons[0], /no longer offers "read-echo"/);
  const res = await call(a, c, 'read-echo', { text: 'x' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /link is broken/);
  const stored = await collections.buildingLinksDb.all();
  assert.ok(stored.some((l) => l.toBuildingId === c.id));
});

// ---- Capability calls ----

test('I12 a read call returns its outputs and the call shows in the log with its summary', async () => {
  const { a, b } = await pair();
  const res = await call(a, b, 'read-echo', { text: 'hello' });
  assert.deepEqual([res.status, res.body.state, res.body.outputs], [200, 'done', { echo: 'hello' }]);
  const [entry] = await activity(a);
  assert.deepEqual([entry.name, entry.result, entry.inputsSummary, entry.callerKind, entry.role], ['read-echo', 'ok', '{"text":"hello"}', 'person', 'caller']);
});

test('I13 and U27 an unknown target Building is 404, I14 and U28 an unknown capability is 404 with its own message', async () => {
  const { a, b } = await pair();
  const building404 = await call(a, { id: 'nope' }, 'read-echo');
  const capability404 = await call(a, b, 'nope');
  assert.deepEqual([building404.status, capability404.status], [404, 404]);
  assert.match(building404.body.error, /Building not found/);
  assert.match(capability404.body.error, /has no capability "nope"/);
});

test('I15 and U29 a call with no link is 403 with a readable reason, I16 and U30 a link without that grant is too', async () => {
  const a = await building(); const b = await building();
  const unlinked = await call(a, b, 'read-echo', { text: 'x' });
  assert.equal(unlinked.status, 403);
  assert.match(unlinked.body.error, /is not linked to/);
  await link(a, b, { capabilities: ['read-slow'] });
  const ungranted = await call(a, b, 'read-echo', { text: 'x' });
  assert.equal(ungranted.status, 403);
  assert.match(ungranted.body.error, /does not grant "read-echo"/);
});

test('U31 a granted call is allowed and U33 an unknown capability outranks a missing link only when nothing grants it', async () => {
  const a = await building(); const b = await building();
  assert.equal((await call(a, b, 'invented')).status, 404);
  await link(a, b);
  assert.equal((await call(a, b, 'read-echo', { text: 'x' })).status, 200);
});

test('I17 malformed inputs are 400 naming the field, and I18 an over-cap input is rejected with nothing run', async () => {
  const { a, b } = await pair();
  resetProbe();
  const missing = await call(a, b, 'read-echo', {});
  assert.deepEqual([missing.status, missing.body.field], [400, 'text']);
  const long = await call(a, b, 'read-echo', { text: 'x'.repeat(11) });
  assert.deepEqual([long.status, long.body.field], [400, 'text']);
  assert.equal(probe.reads, 0);
});

test('I19 a busy target is 409, and a handler that throws is 500, both with { error }', async () => {
  const { a, b } = await pair();
  const busy = await call(a, b, 'read-busy');
  assert.deepEqual([busy.status, busy.body.error], [409, 'The Building is busy']);
  const thrown = await call(a, b, 'read-throw');
  assert.equal(thrown.status, 500);
  assert.match(thrown.body.error, /boom/);
});

test('I31 every error status answers with { error }', async () => {
  const { a, b } = await pair();
  for (const res of [await call(a, b, 'nope'), await call(a, { id: 'x' }, 'read-echo'), await call(a, b, 'read-echo', {}), await call(a, b, 'read-busy')]) {
    assert.equal(typeof res.body.error, 'string');
  }
});

test('I21 a write call waits for approval with 202, and I22 approving runs it once', async () => {
  const { a, b } = await pair();
  resetProbe();
  const held = await call(a, b, 'write-send', { to: 'ann' });
  assert.deepEqual([held.status, held.body.state, probe.sends.length], [202, 'awaiting-approval', 0]);
  assert.equal((await activity(b))[0].result, 'awaiting-approval');
  assert.ok(notices.some((n) => n.kind === 'connection.awaiting_approval' && n.projectId === b.id));
  const approved = await send('POST', `/api/capability-calls/${held.body.callId}/decision`, { decision: 'approve' });
  assert.deepEqual([approved.status, approved.body.outputs, probe.sends.length], [200, { sent: 1 }, 1]);
  assert.equal((await activity(b))[0].result, 'ok');
  assert.equal((await send('POST', `/api/capability-calls/${held.body.callId}/decision`, { decision: 'approve' })).status, 409);
});

test('U92 two approvals at once run the write once and the second is 409, and a decision during an approval is refused too', async () => {
  const { a, b } = await pair();
  resetProbe();
  const held = await call(a, b, 'write-held');
  const decide = (decision: string) => send('POST', `/api/capability-calls/${held.body.callId}/decision`, { decision });
  const first = decide('approve');
  await probe.latchEntered.opened;
  const second = await decide('approve');
  const stop = await decide('stop');
  probe.latch.open();
  const done = await first;
  assert.deepEqual([done.status, second.status, stop.status, probe.latchRuns], [200, 409, 409, 1]);
  assert.equal((await activity(b))[0].result, 'ok');
});

test('U93 a retry with the key of a held call answers with the approval\'s current state, not the old awaiting body', async () => {
  const { a, b } = await pair();
  resetProbe();
  const held = await call(a, b, 'write-send', { to: 'x' }, { idempotencyKey: 'held' });
  assert.equal((await call(a, b, 'write-send', { to: 'x' }, { idempotencyKey: 'held' })).status, 202);
  await send('POST', `/api/capability-calls/${held.body.callId}/decision`, { decision: 'approve' });
  const afterApprove = await call(a, b, 'write-send', { to: 'x' }, { idempotencyKey: 'held' });
  assert.deepEqual([afterApprove.status, afterApprove.body.state, afterApprove.body.callId, probe.sends.length], [200, 'done', held.body.callId, 1]);
  const second = await call(a, b, 'write-send', { to: 'y' }, { idempotencyKey: 'stopped' });
  await send('POST', `/api/capability-calls/${second.body.callId}/decision`, { decision: 'stop' });
  const afterStop = await call(a, b, 'write-send', { to: 'y' }, { idempotencyKey: 'stopped' });
  assert.deepEqual([afterStop.status, afterStop.body.field], [409, 'idempotencyKey']);
});

test('U94 approving a call whose link was removed meanwhile records it as refused, not approved', async () => {
  const a = await building(); const b = await building();
  const l = await link(a, b);
  resetProbe();
  const held = await call(a, b, 'write-send', { to: 'x' });
  await send('DELETE', `/api/links/${l.id}`);
  const res = await send('POST', `/api/capability-calls/${held.body.callId}/decision`, { decision: 'approve' });
  assert.equal(res.status, 403);
  assert.equal((await collections.capabilityApprovalsDb.get(held.body.callId))?.state, 'refused');
  assert.deepEqual([(await activity(b))[0].result, probe.sends.length], ['refused', 0]);
});

test('U95 a call that timed out and finishes later adds a late-finish entry to the log', async () => {
  const { a, b } = await pair();
  resetProbe();
  assert.equal((await call(a, b, 'write-latch')).status, 504);
  probe.latch.open();
  for (let i = 0; i < 50 && !(await activity(b)).some((e) => /after the call had timed out/.test(e.message ?? '')); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const entries = await activity(b);
  assert.deepEqual(entries.filter((e) => e.name === 'write-latch').map((e) => [e.result, e.status]).sort(), [['error', 504], ['ok', 200]]);
});

test('U96 deleting a Building removes the chain-depth rows of the runs it started', async () => {
  const { a, b } = await pair();
  assert.equal((await call(a, b, 'write-run')).status, 200);
  assert.equal((await collections.chainDepthsDb.find((row) => row.buildingId === b.id)).length, 1);
  await send('DELETE', `/api/projects/${b.id}`);
  assert.equal((await collections.chainDepthsDb.find((row) => row.buildingId === b.id)).length, 0);
});

test('a notification for a call waiting for approval is resolved once nothing is waiting on the Building any more', async () => {
  const { a, b } = await pair();
  const one = await call(a, b, 'write-send', { to: 'a' });
  const two = await call(a, b, 'write-send', { to: 'b' });
  resolved.length = 0;
  await send('POST', `/api/capability-calls/${one.body.callId}/decision`, { decision: 'stop' });
  assert.deepEqual(resolved, []);
  await send('POST', `/api/capability-calls/${two.body.callId}/decision`, { decision: 'stop' });
  assert.deepEqual(resolved, [b.id]);
});

test('I23 asking for changes and I24 stopping leave the call unrun', async () => {
  const { a, b } = await pair();
  resetProbe();
  const one = await call(a, b, 'write-send', { to: 'a' });
  const two = await call(a, b, 'write-send', { to: 'b' });
  assert.equal((await send('POST', `/api/capability-calls/${one.body.callId}/decision`, { decision: 'request-changes' })).body.state, 'changes-requested');
  assert.equal((await send('POST', `/api/capability-calls/${two.body.callId}/decision`, { decision: 'stop' })).body.state, 'stopped');
  assert.equal(probe.sends.length, 0);
  assert.deepEqual((await activity(a)).slice(0, 2).map((e) => e.result).sort(), ['changes-requested', 'stopped']);
  assert.equal((await send('POST', `/api/capability-calls/${one.body.callId}/decision`, { decision: 'maybe' })).status, 400);
  assert.equal((await send('POST', '/api/capability-calls/missing/decision', { decision: 'stop' })).status, 404);
});

test('I26 and U44 a repeated idempotency key returns the first result and runs once, U47 other scopes are independent', async () => {
  const { a, b } = await pair();
  resetProbe();
  const first = await call(a, b, 'write-open', {}, { idempotencyKey: 'k1' });
  const again = await call(a, b, 'write-open', {}, { idempotencyKey: 'k1' });
  assert.deepEqual([again.body.callId, again.status], [first.body.callId, 200]);
  const other = await call(a, b, 'write-open', {}, { idempotencyKey: 'k2' });
  assert.notEqual(other.body.callId, first.body.callId);
  const c = await building(); await link(c, b);
  const otherCaller = await call(c, b, 'write-open', {}, { idempotencyKey: 'k1' });
  assert.notEqual(otherCaller.body.callId, first.body.callId);
});

test('U45 the same key repeats once the window has passed, exactly at its boundary', async () => {
  const { a, b } = await pair();
  const first = await call(a, b, 'write-open', {}, { idempotencyKey: 'edge' });
  clock.advance(WINDOW_MS - 1);
  assert.equal((await call(a, b, 'write-open', {}, { idempotencyKey: 'edge' })).body.callId, first.body.callId);
  clock.advance(1);
  assert.notEqual((await call(a, b, 'write-open', {}, { idempotencyKey: 'edge' })).body.callId, first.body.callId);
});

test('U46 the same key with different inputs is 409', async () => {
  const { a, b } = await pair();
  await call(a, b, 'read-echo', { text: 'one' }, { idempotencyKey: 'diff' });
  const res = await call(a, b, 'read-echo', { text: 'two' }, { idempotencyKey: 'diff' });
  assert.deepEqual([res.status, res.body.field], [409, 'idempotencyKey']);
});

test('U48 a failed call is not cached under its key', async () => {
  const { a, b } = await pair();
  assert.equal((await call(a, b, 'read-busy', {}, { idempotencyKey: 'fail' })).status, 409);
  assert.equal((await call(a, b, 'read-busy', {}, { idempotencyKey: 'fail' })).status, 409);
  assert.equal((await activity(a)).filter((e) => e.name === 'read-busy').length, 2);
});

test('U49 with no key nothing is deduplicated, and an over-long key is 400', async () => {
  const { a, b } = await pair();
  resetProbe();
  await call(a, b, 'read-echo', { text: 'x' });
  await call(a, b, 'read-echo', { text: 'x' });
  assert.equal(probe.reads, 2);
  const long = await call(a, b, 'read-echo', { text: 'x' }, { idempotencyKey: 'k'.repeat(129) });
  assert.deepEqual([long.status, long.body.field], [400, 'idempotencyKey']);
});

test('I27 and U40 a call deeper than the limit is refused 409, U39 depths up to it are allowed, U41 a nested call carries the depth and U42 I48 a loop between two Buildings stops at the limit', async () => {
  const a = await building(); const b = await building();
  await link(a, b); await link(b, a);
  const depths: number[] = [];
  let lastError: unknown = null;
  resetProbe();
  probe.nested = async (context) => {
    depths.push(context.depth);
    try {
      await connections.call({ caller: { kind: 'agent', buildingId: context.buildingId }, targetBuildingId: context.callerBuildingId, capabilityId: 'read-nested', depth: context.depth + 1 });
    } catch (error) { lastError = error; }
  };
  assert.equal((await call(a, b, 'read-nested')).status, 200);
  assert.deepEqual(depths, [1, 2, 3]);
  assert.equal((lastError as { status: number }).status, 409);
  assert.match((lastError as Error).message, /3 deep/);
  await assert.rejects(connections.call({ caller: { kind: 'person', buildingId: a.id }, targetBuildingId: b.id, capabilityId: 'read-echo', inputs: { text: 'x' }, depth: 4 }), (e: { status: number }) => e.status === 409);
  const configured = makeConnections({ maxDepth: 5 });
  assert.equal((await configured.call({ caller: { kind: 'person', buildingId: a.id }, targetBuildingId: b.id, capabilityId: 'read-echo', inputs: { text: 'x' }, depth: 4 })).status, 200);
});

test('I28 and U55 a read that outlasts the timeout is 504 and U56 one under it succeeds', async () => {
  const { a, b } = await pair();
  resetProbe();
  const slow = await call(a, b, 'read-slow');
  assert.equal(slow.status, 504);
  assert.match(slow.body.error, /did not answer within/);
  probe.slow.open();
  assert.equal((await call(a, b, 'read-slow')).status, 200);
});

test('I29 and U57 a run-starting call answers at once with a run reference, and the run starts the chain at this call\'s depth', async () => {
  const { a, b } = await pair();
  const res = await call(a, b, 'write-run');
  assert.deepEqual([res.status, res.body.runRef], [200, 'fixture-run-1']);
  assert.equal((await collections.chainDepthsDb.get('fixture-run-1'))?.depth, 1);
  assert.equal((await activity(b))[0].runRef, 'fixture-run-1');
});

test('I30 and U26 a call between Buildings of different tenants is refused as an unknown Building', async () => {
  const { a, b } = await pair();
  const separate = makeConnections({ tenantOf: (project) => (project.id === b.id ? 'other-tenant' : 'local') });
  await assert.rejects(separate.call({ caller: { kind: 'person', buildingId: a.id }, targetBuildingId: b.id, capabilityId: 'read-echo', inputs: { text: 'x' } }), (e: { status: number }) => e.status === 404);
  await assert.rejects(separate.createLink({ fromBuildingId: b.id, toBuildingId: a.id }), (e: { status: number }) => e.status === 404);
});

test('I32 refused calls also appear in the log', async () => {
  const a = await building(); const b = await building();
  await call(a, b, 'read-echo', { text: 'x' });
  await link(a, b);
  await call(a, b, 'read-echo', {});
  await call(a, b, 'read-busy');
  const results = (await activity(a)).map((e) => [e.result, e.status]);
  assert.deepEqual(results.sort(), [['error', 409], ['refused', 400], ['refused', 403]].sort());
});

test('U16 and I19 a handler whose output does not match what it declared is an error result, audited', async () => {
  const { a, b } = await pair();
  const res = await call(a, b, 'read-badout');
  assert.equal(res.status, 502);
  assert.equal((await activity(a))[0].result, 'error');
});

// ---- Run callers and session tools ----

test('I33 a tool call from a live session works and is attributed to its own Building, I34 once the session stops it is refused', async () => {
  const { a, b } = await pair();
  const live = await task(a);
  const ok = await agentCall(live.id, { targetBuildingId: b.id, capabilityId: 'read-echo', inputs: { text: 'hi' } });
  assert.deepEqual([ok.status, ok.body.outputs], [200, { echo: 'hi' }]);
  assert.deepEqual([(await activity(a))[0].callerBuildingId, (await activity(a))[0].callerKind, (await activity(a))[0].callerRefId], [a.id, 'agent', live.id]);
  await collections.tasksDb.update(live.id, { status: 'stopped' });
  const refused = await agentCall(live.id, { targetBuildingId: b.id, capabilityId: 'read-echo', inputs: { text: 'hi' } });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /no longer running/);
  const missing = await agentCall('no-such-task', { targetBuildingId: b.id, capabilityId: 'read-echo' });
  assert.equal(missing.status, 404);
});

test('U70 U71 a finished workflow run stops its step session from calling', async () => {
  const { a, b } = await pair();
  await collections.workflowRunsDb.insert({ id: 'run-live', projectId: a.id, status: 'running', workflowSnapshot: { steps: [{ id: 's', canEditCode: true }] } } as never);
  const step = await task(a, { workflowRunId: 'run-live', workflowStepId: 's' });
  assert.equal((await agentCall(step.id, { targetBuildingId: b.id, capabilityId: 'read-echo', inputs: { text: 'x' } })).status, 200);
  assert.equal((await activity(a))[0].callerKind, 'step');
  await collections.workflowRunsDb.update('run-live', { status: 'completed' });
  assert.equal((await agentCall(step.id, { targetBuildingId: b.id, capabilityId: 'read-echo', inputs: { text: 'x' } })).status, 403);
});

test('I35 and U72 a session cannot borrow another Building\'s link by naming it as the caller', async () => {
  const { b } = await pair();
  const linked = await building(); await link(linked, b);
  const stranger = await building();
  const session = await task(stranger);
  const res = await agentCall(session.id, { targetBuildingId: b.id, capabilityId: 'read-echo', inputs: { text: 'x' }, callerBuildingId: linked.id, buildingId: linked.id });
  assert.equal(res.status, 403);
  assert.equal((await activity(stranger))[0].callerBuildingId, stranger.id);
});

test('I36 and U63 an execute Task of a Building with an outgoing link is offered every granted tool and gets the capability MCP server', async () => {
  const { a, b } = await pair();
  const session = await task(a);
  assert.deepEqual((await agentList(session.id)).map((c) => c.capabilityId).sort(), [...allCaps].sort());
  const server = capabilityTool.capabilityMcpServer(session.id);
  assert.equal(server.env.AGENT_VISUAL_OS_TASK_ID, session.id);
  assert.ok(mcpServers.claudeMcpArgs([server]).some((arg) => arg.includes('mcp__agent_visual_os_connections__call_capability')));
  assert.equal(await (await import('../src/connections/index.ts')).connections.hasOutgoingLinks(a.id), true);
  assert.equal(await (await import('../src/connections/index.ts')).connections.hasOutgoingLinks(b.id), false);
});

test('I36 run level: a session started in a Building with an outgoing link is launched with the capability tools, and one without a link is not', async () => {
  const workerModule = await import('../src/worker/workerManager.ts');
  const projectService = await import('../src/projects/projectService.ts');
  const linked = await projectService.createProject({ name: 'Launch linked', position: null });
  const other = await building();
  const alone = await projectService.createProject({ name: 'Launch alone', position: null });
  await collections.buildingLinksDb.insert({ id: 'launch-link', fromBuildingId: linked.id, toBuildingId: other.id, capabilities: [], events: [], createdAt: '', updatedAt: '' });
  const terminal = fakeTerminalHost();
  const manager = workerModule.createWorkerManager({ terminalSessions: terminal.host });
  const names = (index: number) => (terminal.starts[index]?.mcpServers ?? []).map((server) => server.name);
  await manager.startTask({ projectId: linked.id, description: 'Plan it', kind: 'plan', executorId: 'test-claude-cli' });
  await manager.startTask({ projectId: alone.id, description: 'Plan it', kind: 'plan', executorId: 'test-claude-cli' });
  assert.ok(names(0).includes(capabilityTool.CAPABILITY_MCP_SERVER_NAME));
  assert.equal(names(1).includes(capabilityTool.CAPABILITY_MCP_SERVER_NAME), false);
  assert.ok(names(1).includes('agent_visual_os'));
  const execute = await projectService.createProject({ name: 'Launch execute', position: null });
  await collections.buildingLinksDb.insert({ id: 'launch-link-2', fromBuildingId: execute.id, toBuildingId: other.id, capabilities: [], events: [], createdAt: '', updatedAt: '' });
  await manager.startTask({ projectId: execute.id, description: 'Build it', executorId: 'test-claude-cli' });
  assert.ok(names(2).includes(capabilityTool.CAPABILITY_MCP_SERVER_NAME));
  for (const start of terminal.starts) start.onExit(0);
});

test('I37 and U64 a Building with no outgoing link is offered nothing, and U68 the target of a link gets nothing from it', async () => {
  const { b } = await pair();
  const session = await task(b);
  assert.deepEqual(await agentList(session.id), []);
});

test('I38 and U65 a read-only workflow step is offered read capabilities only, and its write call is refused 403', async () => {
  const { a, b } = await pair();
  await collections.workflowRunsDb.insert({ id: 'run-readonly', projectId: a.id, status: 'running', workflowSnapshot: { steps: [{ id: 'ro', canEditCode: false }] } } as never);
  const step = await task(a, { workflowRunId: 'run-readonly', workflowStepId: 'ro' });
  const offered = await agentList(step.id);
  assert.ok(offered.length > 0 && offered.every((c) => c.capabilityId.startsWith('read-')));
  const write = await agentCall(step.id, { targetBuildingId: b.id, capabilityId: 'write-open' });
  assert.equal(write.status, 403);
  assert.match(write.body.error, /only read/);
});

test('I39 and U67 a planning session is offered read capabilities only', async () => {
  const { a } = await pair();
  const planning = await task(a, { kind: 'plan' });
  const offered = await agentList(planning.id);
  assert.ok(offered.length > 0 && offered.every((c) => c.capabilityId.startsWith('read-')));
});

test('U66 a writable step is offered reads and writes', async () => {
  const { a } = await pair();
  await collections.workflowRunsDb.insert({ id: 'run-writable', projectId: a.id, status: 'running', workflowSnapshot: { steps: [{ id: 'rw', canEditCode: true }] } } as never);
  const step = await task(a, { workflowRunId: 'run-writable', workflowStepId: 'rw' });
  assert.ok((await agentList(step.id)).some((c) => c.capabilityId === 'write-send'));
});

test('a session route without the CLI token is 401 and without a taskId is 400', async () => {
  assert.equal((await api('/api/agent-capabilities/capabilities?taskId=x')).status, 401);
  assert.equal((await send('GET', '/api/agent-capabilities/capabilities', undefined, true)).status, 400);
});

// ---- Events ----

async function subscriber(source: { id: string }, events = ['report-published', 'deal-won']) {
  const sub = await building();
  await link(sub, source, { events });
  const job = await addJob(sub);
  return { sub, job };
}
const subscribe = (sub: { id: string }, source: { id: string }, eventId: string, jobId: string) =>
  send('POST', '/api/subscriptions', { subscriberBuildingId: sub.id, sourceBuildingId: source.id, eventId, jobId });
const publish = (source: { id: string }, eventId = 'report-published', payload: unknown = { title: 'Q3' }) => send('POST', `/api/projects/${source.id}/events`, { eventId, payload });

test('I40 publishing an event starts the subscribed job, I41 a Building that did not subscribe is not started, I47 and it shows in the log', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source);
  const other = await building(); await link(other, source); const otherJob = await addJob(other);
  assert.equal((await subscribe(sub, source, 'report-published', job.id)).status, 201);
  const before = runs.starts.length;
  const res = await publish(source);
  assert.deepEqual([res.status, res.body.queued], [202, 1]);
  await scheduler.idle();
  assert.deepEqual(runs.starts.slice(before).map((s) => [s.projectId, s.job.id]), [[sub.id, job.id]]);
  assert.equal(runs.starts.some((s) => s.job.id === otherJob.id), false);
  const entry = (await api(`/api/projects/${sub.id}/schedules/jobs/${job.id}/history`)).body.entries[0];
  assert.deepEqual([entry.startedBy, entry.outcome], ['event', 'running']);
  const log = await activity(sub);
  assert.ok(log.some((e) => e.kind === 'event' && e.targetBuildingId === sub.id && e.runRef === entry.runId && e.result === 'ok'));
  assert.ok((await activity(source)).some((e) => e.kind === 'event' && e.callerBuildingId === source.id && e.callerKind === 'event'));
});

test('I42 subscribing to an event the link does not grant is 403, and an unlinked or unknown subscription is refused', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source, ['deal-won']);
  const res = await subscribe(sub, source, 'report-published', job.id);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /does not grant the event/);
  const stranger = await building(); const strangerJob = await addJob(stranger);
  assert.equal((await subscribe(stranger, source, 'deal-won', strangerJob.id)).status, 403);
  assert.equal((await subscribe(sub, source, 'invented', job.id)).status, 404);
  assert.equal((await subscribe(sub, source, 'deal-won', 'missing-job')).status, 404);
  assert.equal((await subscribe(sub, source, 'deal-won', strangerJob.id)).status, 404);
});

test('U58 publishing an undeclared event is 404 and U59 a payload over its cap is 400', async () => {
  const source = await building();
  assert.equal((await publish(source, 'invented')).status, 404);
  const long = await publish(source, 'report-published', { title: 'x'.repeat(21) });
  assert.deepEqual([long.status, long.body.field], [400, 'title']);
  assert.equal((await publish(source, 'report-published', {})).status, 400);
});

test('duplicate subscriptions are 409 and a subscription can be listed, turned off and deleted', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source);
  const made = await subscribe(sub, source, 'deal-won', job.id);
  assert.equal((await subscribe(sub, source, 'deal-won', job.id)).status, 409);
  assert.equal((await api(`/api/projects/${source.id}/subscriptions`)).body.length, 1);
  assert.equal((await send('PATCH', `/api/subscriptions/${made.body.id}`, { enabled: false })).body.enabled, false);
  assert.equal((await send('PATCH', `/api/subscriptions/${made.body.id}`, { enabled: 'no' })).status, 400);
  const quiet = await publish(source, 'deal-won', {});
  assert.equal(quiet.body.queued, 0);
  assert.equal((await send('DELETE', `/api/subscriptions/${made.body.id}`)).status, 204);
  assert.equal((await send('DELETE', `/api/subscriptions/${made.body.id}`)).status, 404);
});

test('U60 an event reaches only subscribers whose link still grants it', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source);
  await subscribe(sub, source, 'deal-won', job.id);
  const links = (await api(`/api/projects/${sub.id}/links`)).body.outgoing;
  await collections.buildingLinksDb.update(links[0].id, { events: [] });
  assert.equal((await publish(source, 'deal-won', {})).body.queued, 0);
});

test('I43 U50 U51 U53 past the hourly limit the subscription turns itself off with one notification, I44 re-enabling works, U52 old deliveries stop counting', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source);
  const made = await subscribe(sub, source, 'deal-won', job.id);
  const before = notices.filter((n) => n.kind === 'connection.subscription_disabled').length;
  for (let i = 0; i < EVENTS_PER_HOUR; i += 1) assert.equal((await publish(source, 'deal-won', {})).body.queued, 1);
  assert.equal((await publish(source, 'deal-won', {})).body.queued, 0);
  assert.equal((await publish(source, 'deal-won', {})).body.queued, 0);
  const stored = (await api(`/api/projects/${sub.id}/subscriptions`)).body[0];
  assert.deepEqual([stored.enabled, stored.autoDisabled], [false, true]);
  assert.equal(notices.filter((n) => n.kind === 'connection.subscription_disabled').length - before, 1);
  assert.ok((await activity(sub)).some((e) => e.result === 'rate-limited'));
  assert.equal((await send('PATCH', `/api/subscriptions/${made.body.id}`, { enabled: true })).body.autoDisabled, false);
  assert.equal((await publish(source, 'deal-won', {})).body.queued, 1);
  clock.advance(rules.HOUR_MS + 1);
  for (let i = 0; i < EVENTS_PER_HOUR - 1; i += 1) assert.equal((await publish(source, 'deal-won', {})).body.queued, 1);
});

test('U54 the hourly limit is counted per subscription', async () => {
  const source = await building();
  const one = await subscriber(source); const two = await subscriber(source);
  await subscribe(one.sub, source, 'deal-won', one.job.id);
  await subscribe(two.sub, source, 'deal-won', two.job.id);
  for (let i = 0; i < EVENTS_PER_HOUR; i += 1) assert.equal((await publish(source, 'deal-won', {})).body.queued, 2);
});

test('I70 events past the limit published at once give one notification and exactly the limit of deliveries', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source);
  await subscribe(sub, source, 'deal-won', job.id);
  const before = notices.filter((n) => n.kind === 'connection.subscription_disabled').length;
  const results = await Promise.all(Array.from({ length: EVENTS_PER_HOUR + 3 }, () => publish(source, 'deal-won', {})));
  assert.equal(results.reduce((sum, r) => sum + r.body.queued, 0), EVENTS_PER_HOUR);
  assert.equal(notices.filter((n) => n.kind === 'connection.subscription_disabled').length - before, 1);
});

test('I45 and U61 an event published while the subscriber is down is delivered once after a restart, U62 and a retry does not deliver it again', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source);
  await subscribe(sub, source, 'deal-won', job.id);
  subscriberDown = true;
  const published = await publish(source, 'deal-won', {});
  subscriberDown = false;
  assert.equal(published.body.queued, 1);
  const pending = await collections.pendingEventsDb.find((row) => row.subscriberBuildingId === sub.id);
  assert.deepEqual(pending.map((row) => row.status), ['pending']);
  const before = runs.starts.length;
  const restarted = makeConnections();
  await restarted.deliverPending();
  await restarted.deliverPending();
  await scheduler.idle();
  assert.equal(runs.starts.length - before, 1);
  assert.equal((await collections.pendingEventsDb.get(pending[0]!.id))?.status, 'delivered');
});

test('I46 a delivery whose job already started before the crash is marked delivered without starting a second run', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source);
  const made = await subscribe(sub, source, 'deal-won', job.id);
  const row = await collections.pendingEventsDb.insert({
    id: 'crashed-delivery', eventPublicationId: 'p', eventId: 'deal-won', sourceBuildingId: source.id, subscriptionId: made.body.id,
    subscriberBuildingId: sub.id, jobId: job.id, depth: 1, chainId: 'c', status: 'pending', createdAt: new Date().toISOString(),
  });
  await collections.jobHistoryDb.insert({ id: 'h', jobId: job.id, projectId: sub.id, seq: 99, startedBy: 'event', outcome: 'running', dueAt: '', startedAt: '', finishedAt: null, durationMs: null, note: null, change: `event:${row.id} deal-won`, runId: 'r', runStartedAt: null, deferredUntil: null } as never);
  const before = runs.starts.length;
  await connections.deliverPending();
  assert.equal(runs.starts.length, before);
  assert.equal((await collections.pendingEventsDb.get(row.id))?.status, 'delivered');
});

test('I48 an event whose chain is already at the depth limit is refused, not delivered', async () => {
  const source = await building();
  const { sub, job } = await subscriber(source);
  await subscribe(sub, source, 'deal-won', job.id);
  const before = runs.starts.length;
  await connections.publishEvent({ sourceBuildingId: source.id, eventId: 'deal-won', depth: 3 });
  assert.equal(runs.starts.length, before);
  assert.ok((await activity(sub)).some((e) => e.kind === 'event' && e.result === 'refused' && /deep/.test(e.message)));
});

// ---- Scheduler ----

const runNow = async (b: { id: string }, jobId: string) => { const res = await send('POST', `/api/projects/${b.id}/schedules/jobs/${jobId}/run`); await scheduler.idle(); return res; };
const history = async (b: { id: string }, jobId: string) => (await api(`/api/projects/${b.id}/schedules/jobs/${jobId}/history`)).body.entries[0];
const capabilityJob = (b: { id: string }, target: { id: string }, capabilityId: string, inputs: unknown = {}) =>
  addJob(b, { target: { kind: 'capability', targetBuildingId: target.id, capabilityId, inputs } });

test('I49 a scheduled job calls a capability in another Building and its history shows it succeeded', async () => {
  const { a, b } = await pair();
  resetProbe();
  const job = await capabilityJob(a, b, 'read-echo', { text: 'sched' });
  const res = await runNow(a, job.id);
  assert.equal(res.status, 201);
  assert.equal(probe.reads, 1);
  assert.deepEqual([(await history(a, job.id)).outcome, (await activity(a))[0].callerKind, (await activity(a))[0].callerRefId], ['succeeded', 'job', job.id]);
});

test('I50 a scheduled call without a link fails with a recorded reason, and a job with a malformed target is 400', async () => {
  const a = await building(); const b = await building();
  const job = await capabilityJob(a, b, 'read-echo', { text: 'x' });
  await send('POST', `/api/projects/${a.id}/schedules/jobs/${job.id}/run`);
  await scheduler.idle();
  const entry = await history(a, job.id);
  assert.equal(entry.outcome, 'failed');
  assert.match(entry.note, /is not linked to/);
  const bad = await send('POST', `/api/projects/${a.id}/schedules/jobs`, { name: 'Bad', trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'capability', capabilityId: 'x' } });
  assert.deepEqual([bad.status, bad.body.field], [400, 'target.targetBuildingId']);
});

test('I51 and I25 a scheduled write with pre-approval runs without asking, and U36 it is the job caller that earns it', async () => {
  const a = await building(); const b = await building();
  await link(a, b, { capabilities: [{ capabilityId: 'write-send', preApproved: true }] });
  resetProbe();
  const job = await capabilityJob(a, b, 'write-send', { to: 'cust' });
  await runNow(a, job.id);
  assert.deepEqual([probe.sends.length, (await history(a, job.id)).outcome], [1, 'succeeded']);
  const manual = await call(a, b, 'write-send', { to: 'cust' });
  assert.equal(manual.status, 202);
});

test('I52 a scheduled write without pre-approval waits for approval, and approving it finishes the job\'s run', async () => {
  const { a, b } = await pair();
  resetProbe();
  const job = await capabilityJob(a, b, 'write-send', { to: 'cust' });
  await runNow(a, job.id);
  assert.deepEqual([probe.sends.length, (await history(a, job.id)).outcome], [0, 'awaiting-approval']);
  const held = (await activity(a))[0];
  await send('POST', `/api/capability-calls/${held.id}/decision`, { decision: 'approve' });
  await scheduler.idle();
  assert.deepEqual([probe.sends.length, (await history(a, job.id)).outcome], [1, 'succeeded']);
});

// ---- Activity API ----

test('I53 the log of a Building lists calls it made and calls made on it, with names and roles', async () => {
  const { a, b } = await pair();
  await call(a, b, 'read-echo', { text: 'x' });
  const asCaller = (await activity(a))[0]; const asTarget = (await activity(b))[0];
  assert.deepEqual([asCaller.role, asTarget.role, asTarget.callerName, asTarget.targetName], ['caller', 'target', a.name, b.name]);
});

test('I54 and U78 filters work together (also by capability) and I58 the newest entry comes first', async () => {
  const { a, b } = await pair();
  await call(a, b, 'read-echo', { text: 'one' });
  clock.advance(1000);
  await call(a, b, 'read-echo', {});
  clock.advance(1000);
  await call(a, b, 'read-busy');
  const all = await activity(b);
  assert.deepEqual(all.map((e) => e.name), ['read-busy', 'read-echo', 'read-echo']);
  assert.deepEqual((await activity(b, `?capability=read-echo&result=ok&caller=${a.id}`)).map((e) => e.inputsSummary), ['{"text":"one"}']);
  const at = new Date(clock.now() - 1500).toISOString();
  assert.equal((await activity(b, `?from=${at}`)).length, 2);
  assert.equal((await activity(b, `?to=${at}`)).length, 1);
  assert.equal((await activity(b, '?limit=1')).length, 1);
});

test('I59 a bad filter value is 400 naming the parameter, and I57 an unknown Building is 404', async () => {
  const a = await building();
  for (const [query, field] of [['?result=great', 'result'], ['?from=2026-13-40', 'from'], ['?from=2026-10-13&to=2026-10-12', 'from'], ['?limit=0', 'limit']] as const) {
    const res = await api(`/api/projects/${a.id}/activity${query}`);
    assert.deepEqual([res.status, res.body.field], [400, field], query);
  }
  assert.equal((await api('/api/projects/nope/activity')).status, 404);
});

test('I56 a run-starting call\'s entry carries its run reference', async () => {
  const { a, b } = await pair();
  await call(a, b, 'write-run');
  assert.equal((await activity(a))[0].runRef, 'fixture-run-1');
});

// ---- Software capabilities ----

test('I60 and U83 U84 U85 Get open tasks lists the Tasks that are not done, in board order, and an empty list when there are none', async () => {
  const software = await building('software');
  const caller = await building();
  await send('POST', '/api/links', { fromBuildingId: caller.id, toBuildingId: software.id, capabilities: ['get-open-tasks', 'start-planning-session'] });
  assert.deepEqual((await call(caller, software, 'get-open-tasks')).body.outputs, { tasks: [] });
  const item = (id: string, order: number, status: string) => ({ id, projectId: software.id, title: id, description: '', status, order, taskIds: [], milestoneId: null, createdAt: '', updatedAt: '' }) as never;
  await collections.planItemsDb.insert(item('t-b', 2, 'pending'));
  await collections.planItemsDb.insert(item('t-a', 1, 'developing'));
  await collections.planItemsDb.insert(item('t-done', 0, 'done'));
  const res = await call(caller, software, 'get-open-tasks');
  assert.deepEqual(res.body.outputs.tasks.map((t: { id: string }) => t.id), ['t-a', 't-b']);
});

test('I61 Start planning session is held for approval like any write, and U86 U87 U88 its inputs are validated first', async () => {
  const software = await building('software');
  const caller = await building();
  await send('POST', '/api/links', { fromBuildingId: caller.id, toBuildingId: software.id, capabilities: ['start-planning-session'] });
  const held = await call(caller, software, 'start-planning-session', { prompt: 'Plan the login page' });
  assert.deepEqual([held.status, held.body.state], [202, 'awaiting-approval']);
  assert.equal((await call(caller, software, 'start-planning-session', {})).body.field, 'prompt');
  const long = await call(caller, software, 'start-planning-session', { prompt: 'p'.repeat(10_001) });
  assert.deepEqual([long.status, long.body.field], [400, 'prompt']);
  await send('POST', `/api/capability-calls/${held.body.callId}/decision`, { decision: 'stop' });
});

test('I61 approving Start planning session starts a planning session the way the chat does, I62 a busy Building and I63 a repository that is not ready are 409', async () => {
  const software = await building('software');
  const caller = await building();
  await send('POST', '/api/links', { fromBuildingId: caller.id, toBuildingId: software.id, capabilities: ['start-planning-session'] });
  const worker = await import('../src/worker/workerManager.ts');
  const git = await import('../src/projects/git.ts');
  const real = worker.workerManager.startTask;
  const started: unknown[] = [];
  try {
    worker.workerManager.startTask = (async (input: unknown) => { started.push(input); return { id: 'planning-session-1' }; }) as never;
    const held = await call(caller, software, 'start-planning-session', { prompt: '  Plan the login page  ' });
    const done = await send('POST', `/api/capability-calls/${held.body.callId}/decision`, { decision: 'approve' });
    assert.deepEqual([done.status, done.body.runRef, done.body.outputs], [200, 'planning-session-1', { sessionId: 'planning-session-1' }]);
    assert.deepEqual(started, [{ projectId: software.id, description: 'Plan the login page', kind: 'plan' }]);
    assert.equal((await collections.chainDepthsDb.get('planning-session-1'))?.depth, 1);

    for (const failure of [new worker.SessionStillRunningError({ taskId: 'task-1', title: 'Busy' }), new git.GitError('The repository is not cloned yet')]) {
      worker.workerManager.startTask = (async () => { throw failure; }) as never;
      const next = await call(caller, software, 'start-planning-session', { prompt: 'again' });
      const refused = await send('POST', `/api/capability-calls/${next.body.callId}/decision`, { decision: 'approve' });
      assert.deepEqual([refused.status, refused.body.error], [409, failure.message]);
      assert.equal((await activity(software))[0].result, 'error');
    }
  } finally {
    worker.workerManager.startTask = real;
  }
});

// ---- Deletion, races, privacy, migration ----

test('I64 I65 I66 U90 U91 deleting a Building removes its links and subscriptions, stops calls waiting on it and drops its pending events, while the log stays', async () => {
  const a = await building(); const b = await building();
  await link(a, b); await link(b, a);
  const job = await addJob(a);
  const made = await subscribe(a, b, 'deal-won', job.id);
  const held = await call(a, b, 'write-send', { to: 'x' });
  await collections.pendingEventsDb.insert({ id: 'to-drop', eventPublicationId: 'p', eventId: 'deal-won', sourceBuildingId: b.id, subscriptionId: made.body.id, subscriberBuildingId: a.id, jobId: job.id, depth: 1, chainId: 'c', status: 'pending', createdAt: '' });
  await call(a, b, 'read-echo', { text: 'kept' });
  assert.equal((await send('DELETE', `/api/projects/${b.id}`)).status, 204);
  assert.deepEqual((await api(`/api/projects/${a.id}/links`)).body, { outgoing: [], incoming: [] });
  assert.equal((await api(`/api/projects/${a.id}/subscriptions`)).body.length, 0);
  assert.equal(await collections.pendingEventsDb.get('to-drop'), undefined);
  assert.equal((await collections.capabilityApprovalsDb.get(held.body.callId))?.state, 'stopped');
  const log = await activity(a);
  assert.ok(log.length >= 2);
  assert.ok(log.every((e) => e.targetName === 'Building deleted'));
  assert.equal(log.find((e) => e.id === held.body.callId)?.result, 'stopped');
});

test('I55 and U76 after the caller is deleted the target\'s log shows "Building deleted" for it', async () => {
  const { a, b } = await pair();
  await call(a, b, 'read-echo', { text: 'x' });
  await send('DELETE', `/api/projects/${a.id}`);
  const [entry] = await activity(b);
  assert.deepEqual([entry.callerName, entry.targetName, entry.role], ['Building deleted', b.name, 'target']);
});

test('I67 two calls with the same key at once run the capability once', async () => {
  const { a, b } = await pair();
  resetProbe();
  const first = call(a, b, 'write-latch', {}, { idempotencyKey: 'race' });
  await probe.latchEntered.opened;
  const second = call(a, b, 'write-latch', {}, { idempotencyKey: 'race' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  probe.latch.open();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(probe.latchRuns, 1);
  assert.deepEqual([one.status, two.status, one.body.callId === two.body.callId], [200, 200, true]);
});

test('I68 a link deleted during a call lets that call finish and refuses the next', async () => {
  const a = await building(); const b = await building();
  const made = await link(a, b);
  resetProbe();
  const inFlight = call(a, b, 'write-latch');
  await probe.latchEntered.opened;
  await send('DELETE', `/api/links/${made.id}`);
  probe.latch.open();
  assert.equal((await inFlight).status, 200);
  assert.equal((await call(a, b, 'write-latch')).status, 403);
});

test('I69 a target deleted during a call lets that call finish, and the log keeps it as "Building deleted"', async () => {
  const { a, b } = await pair();
  resetProbe();
  const inFlight = call(a, b, 'write-latch');
  await probe.latchEntered.opened;
  await send('DELETE', `/api/projects/${b.id}`);
  probe.latch.open();
  assert.equal((await inFlight).status, 200);
  const [entry] = await activity(a);
  assert.deepEqual([entry.result, entry.targetName], ['ok', 'Building deleted']);
});

test('I74 and U75 nothing a call, the log or a link returns carries the target\'s storage folder', async () => {
  const { a, b } = await pair();
  const result = await call(a, b, 'read-echo', { text: 'x' });
  const held = await call(a, b, 'write-send', { to: 'y' });
  const everything = JSON.stringify([result.body, held.body, await activity(a), await activity(b), (await api(`/api/projects/${a.id}/links`)).body, (await api(`/api/projects/${b.id}/links`)).body]);
  const stored = await collections.projectsDb.get(b.id);
  for (const secret of [stored!.relativePath, stored!.slug, tempRoot, path.join(tempRoot, 'projects')]) assert.equal(everything.includes(secret), false, secret);
});

test('I72 links, subscriptions and the log live in their own files and leave the Building records untouched', async () => {
  const a = await building(); const b = await building();
  const before = JSON.stringify([await collections.projectsDb.get(a.id), await collections.projectsDb.get(b.id)]);
  await link(a, b);
  await call(a, b, 'read-echo', { text: 'x' });
  assert.equal(JSON.stringify([await collections.projectsDb.get(a.id), await collections.projectsDb.get(b.id)]), before);
});

test('a read-only Building refuses changes to its connections while reads keep working', async () => {
  const a = await building(); const b = await building();
  registry.unregisterBuildingType('cx');
  try {
    assert.equal((await api(`/api/projects/${a.id}/links`)).status, 200);
    const manual = await call(a, b, 'read-echo', { text: 'x' });
    assert.equal(manual.status, 409);
  } finally {
    registry.registerBuildingType(fixtureType('cx', probe, rules.CapabilityError));
  }
});

// ---- Task details, completed tasks and default-on grants ----

const TASK_CAPS = ['get-open-tasks', 'get-task-details', 'list-completed-tasks'];
const SECRET_PATH = '/secret/worktrees/run-xyz';

async function taskPair(capabilities: unknown[] = TASK_CAPS) {
  const software = await building('software');
  const caller = await building();
  const made = await send('POST', '/api/links', { fromBuildingId: caller.id, toBuildingId: software.id, capabilities });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { software, caller, linkId: made.body.id as string };
}
let itemCount = 0;
async function planItem(b: { id: string }, patch: Record<string, unknown> = {}) {
  itemCount += 1;
  const stamp = `2026-10-0${(itemCount % 9) + 1}T09:00:00.000Z`;
  const record = { id: `item-${itemCount}-${Math.random().toString(36).slice(2, 6)}`, projectId: b.id, title: `Task ${itemCount}`, description: 'Do the thing', status: 'pending', order: itemCount, taskIds: [], milestoneId: null, createdAt: stamp, updatedAt: stamp, ...patch };
  return (await collections.planItemsDb.insert(record as never)) as unknown as { id: string };
}
async function runFor(b: { id: string }, item: { id: string }, patch: Record<string, unknown> = {}, rounds: Array<Record<string, unknown>> = []) {
  const id = `run-${item.id}`;
  const steps = [{ id: 'plan', name: 'Planning' }, { id: 'dev', name: 'Development' }, { id: 'docs', name: 'Docs' }];
  await collections.workflowRunsDb.insert({
    id, projectId: b.id, planItemId: item.id, workflowId: 'w', workflowSnapshot: { id: 'w', name: 'W', description: '', enabled: true, steps }, status: 'running', currentStepId: 'dev',
    executorId: 'x', prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0, worktreePath: SECRET_PATH,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', completedAt: null, ...patch,
  } as never);
  await collections.planItemsDb.update(item.id, { workflowRunId: id } as never);
  for (const [index, round] of rounds.entries()) {
    await collections.stepRunsDb.insert({ id: `${id}-s${index}`, runId: id, round: 1, taskId: null, outputs: [], verdict: null, skippedReason: null, approval: null, summary: null, createdAt: '2026-10-01T01:00:00.000Z', completedAt: null, ...round } as never);
  }
  return id;
}
const details = (from: { id: string }, to: { id: string }, inputs: Record<string, unknown>) => call(from, to, 'get-task-details', inputs);
const doneRun = (at: string, extra: Record<string, unknown> = {}) => ({ status: 'completed', completedAt: at, ...extra });

test('I100 get task details returns identity, description, status, steps, delivery and outcome, by id and by board number', async () => {
  const { software, caller } = await taskPair();
  const item = await planItem(software, { title: 'Add login', description: 'Full text', status: 'done', planningRef: { session: 10, task: 17 }, autoMerge: { enabled: false, state: 'waiting' } });
  await runFor(software, item, doneRun('2026-10-05T10:00:00.000Z', { branch: 'feature/add-login', prUrl: 'https://example.test/pr/1', completionReport: 'All shipped' }), [
    { stepId: 'plan', status: 'done', summary: 'Planned it', createdAt: '2026-10-01T01:00:00.000Z', completedAt: '2026-10-01T02:00:00.000Z' },
    { stepId: 'dev', round: 1, status: 'failed', summary: 'old try' },
    { stepId: 'dev', round: 2, status: 'done', summary: 'Built it', completedAt: '2026-10-01T03:00:00.000Z' },
    { stepId: 'docs', status: 'skipped', skippedReason: 'No docs needed' },
  ]);
  const byId = (await details(caller, software, { id: item.id })).body.outputs;
  const byNumber = (await details(caller, software, { number: '10.017' })).body.outputs;
  assert.deepEqual(byNumber, byId);
  assert.deepEqual([byId.number, byId.title, byId.description, byId.status, byId.phase, byId.completedAt, byId.outcome, byId.truncated], ['10.017', 'Add login', 'Full text', 'completed', 'completed', '2026-10-05T10:00:00.000Z', 'All shipped', false]);
  assert.deepEqual(byId.steps.map((s: any) => [s.name, s.state, s.rounds, s.summary]), [['Planning', 'done', 1, 'Planned it'], ['Development', 'done', 2, 'Built it'], ['Docs', 'skipped', 1, 'No docs needed']]);
  assert.deepEqual(byId.delivery, { branch: 'feature/add-login', prUrl: 'https://example.test/pr/1', prState: 'open', autoMerge: 'off' });
  assert.equal(byId.activity, undefined);
});

test('I101 a running task shows its current step and checklist progress; steps not reached are pending without a summary', async () => {
  const { software, caller } = await taskPair();
  const item = await planItem(software, { status: 'developing' });
  await runFor(software, item, { currentStepProgress: { done: 2, total: 5, estimate: null } }, [{ stepId: 'plan', status: 'done', summary: 's' }, { stepId: 'dev', status: 'running' }]);
  const out = (await details(caller, software, { id: item.id })).body.outputs;
  assert.deepEqual([out.status, out.phase, out.activity], ['running', 'in-progress', { step: 'Development', progress: '2 of 5 done' }]);
  assert.deepEqual(out.steps.map((s: any) => [s.state, s.summary]), [['done', 's'], ['running', undefined], ['pending', undefined]]);
  assert.equal(out.completedAt, undefined);
});

test('I102 a task with no run is ready with no steps and no delivery; an archived done task is archived but completed', async () => {
  const { software, caller } = await taskPair();
  const fresh = await planItem(software);
  const out = (await details(caller, software, { id: fresh.id })).body.outputs;
  assert.deepEqual([out.status, out.phase, out.steps, out.runs, out.delivery], ['ready', 'not-started', [], 0, { autoMerge: 'none' }]);
  const old = await planItem(software, { status: 'done', archived: true });
  const archived = (await details(caller, software, { id: old.id })).body.outputs;
  assert.deepEqual([archived.status, archived.phase], ['archived', 'completed']);
});

test('I103 input errors: both or neither of id and number, empty, over-long and wrong types are 400', async () => {
  const { software, caller } = await taskPair();
  for (const inputs of [{}, { id: 'a', number: '1.001' }, { id: '   ' }, { id: 'x'.repeat(201) }, { id: 5 }, { number: ['1.001'] }]) {
    assert.equal((await details(caller, software, inputs as never)).status, 400, JSON.stringify(inputs));
  }
});

test('I104 another Building\'s task and an unknown id are the same 404, by id and by number', async () => {
  const { software, caller } = await taskPair();
  const other = await building('software');
  const foreign = await planItem(other, { planningRef: { session: 3, task: 1 } });
  const unknown = await details(caller, software, { id: 'no-such-task' });
  const crossId = await details(caller, software, { id: foreign.id });
  const crossNumber = await details(caller, software, { number: '3.001' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(crossId, unknown);
  assert.deepEqual(crossNumber, unknown);
});

test('I105 a capability the link does not grant is 403, and an unlinked caller is 403', async () => {
  const { software, caller } = await taskPair(['get-open-tasks']);
  assert.equal((await details(caller, software, { id: 'x' })).status, 403);
  assert.equal((await call(caller, software, 'list-completed-tasks')).status, 403);
  const stranger = await building();
  assert.equal((await details(stranger, software, { id: 'x' })).status, 403);
});

test('I106 the Activity log keeps the inputs of a details call but never the description or summaries', async () => {
  const { software, caller } = await taskPair();
  const item = await planItem(software, { description: 'SECRET-DESCRIPTION-TEXT' });
  await runFor(software, item, {}, [{ stepId: 'plan', status: 'done', summary: 'SECRET-SUMMARY-TEXT' }]);
  await details(caller, software, { id: item.id });
  const entries = await activity(caller);
  assert.equal(entries[0].name, 'get-task-details');
  assert.ok(entries[0].inputsSummary.includes(item.id));
  assert.equal(JSON.stringify(entries).includes('SECRET-'), false);
});

test('I107 the response never carries the worktree path, and a long description is cut and flagged', async () => {
  const { software, caller } = await taskPair();
  const item = await planItem(software, { description: 'é😀'.repeat(15_000) });
  await runFor(software, item, { completionReport: 'r'.repeat(6000), status: 'completed', completedAt: '2026-10-02T00:00:00.000Z' }, [{ stepId: 'plan', status: 'done', summary: 's'.repeat(3000) }]);
  const res = await details(caller, software, { id: item.id });
  const out = res.body.outputs;
  assert.equal(JSON.stringify(res.body).includes(SECRET_PATH), false);
  assert.deepEqual([[...out.description].length, out.descriptionTruncated, out.truncated, out.outcome.length, out.outcomeTruncated, out.steps[0].summary.length, out.steps[0].summaryTruncated], [20_000, true, true, 5000, true, 2000, true]);
});

test('I108 a task with 250 steps reports 100 of them, says how many exist and flags the cut', async () => {
  const { software, caller } = await taskPair();
  const item = await planItem(software);
  const id = await runFor(software, item);
  const run = await collections.workflowRunsDb.get(id);
  const steps = Array.from({ length: 250 }, (_, i) => ({ id: `s${i}`, name: `Step ${i}` }));
  await collections.workflowRunsDb.update(id, { workflowSnapshot: { ...run!.workflowSnapshot, steps } } as never);
  const out = (await details(caller, software, { id: item.id })).body.outputs;
  assert.deepEqual([out.steps.length, out.stepsTotal, out.truncated], [100, 250, true]);
});

test('I109 list completed tasks: archived-done included; failed, stopped, archived-not-done and merge-held excluded; newest first with id ties', async () => {
  const { software, caller } = await taskPair();
  const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T08:00:00.000Z`;
  const a = await planItem(software, { title: 'Alpha', status: 'done', updatedAt: at(1) });
  const b = await planItem(software, { title: 'Beta', status: 'done', archived: true, updatedAt: at(3) });
  const c = await planItem(software, { title: 'Gamma', status: 'pending', updatedAt: at(2) });
  await runFor(software, c, doneRun(at(2), { prUrl: 'https://example.test/pr/9', completionReport: 'Line one\nline   two' }));
  await planItem(software, { title: 'Failed', status: 'failed' });
  await planItem(software, { title: 'Stopped', status: 'stopped' });
  await planItem(software, { title: 'Dropped', status: 'pending', archived: true });
  const held = await planItem(software, { title: 'Held', status: 'done', updatedAt: at(9), autoMerge: { enabled: true, state: 'waiting' } });
  await runFor(software, held, doneRun(at(9)));
  const out = (await call(caller, software, 'list-completed-tasks')).body.outputs;
  assert.deepEqual(out.tasks.map((t: any) => t.title), ['Beta', 'Gamma', 'Alpha']);
  assert.equal(out.total, 3);
  assert.equal(out.nextCursor, undefined);
  assert.deepEqual([out.tasks[1].hasPr, out.tasks[1].prMerged, out.tasks[1].outcome, out.tasks[0].id === b.id, out.tasks[2].id === a.id], [true, false, 'Line one line two', true, true]);
});

test('I110 paging is stable: three pages, no repeats or skips, ties by id, and a cursor does not fit other filters', async () => {
  const { software, caller } = await taskPair();
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) ids.push((await planItem(software, { title: `Same ${i}`, status: 'done', updatedAt: '2026-10-04T00:00:00.000Z' })).id);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await call(caller, software, 'list-completed-tasks', { limit: 2, ...(cursor ? { cursor } : {}) });
    seen.push(...res.body.outputs.tasks.map((t: any) => t.id));
    assert.equal(res.body.outputs.total, 5);
    cursor = res.body.outputs.nextCursor;
    pages += 1;
  } while (cursor);
  assert.deepEqual([pages, seen], [3, [...ids].sort()]);
  const first = (await call(caller, software, 'list-completed-tasks', { limit: 1 })).body.outputs.nextCursor;
  assert.equal((await call(caller, software, 'list-completed-tasks', { cursor: first, search: 'x' })).status, 400);
});

test('I111 since, search and total follow the filters; an empty result is an empty list', async () => {
  const { software, caller } = await taskPair();
  await planItem(software, { title: 'Fix Login', status: 'done', updatedAt: '2026-10-02T00:00:00.000Z' });
  await planItem(software, { title: 'Docs', status: 'done', updatedAt: '2026-10-06T00:00:00.000Z' });
  const list = async (inputs: Record<string, unknown>) => (await call(caller, software, 'list-completed-tasks', inputs)).body.outputs;
  assert.deepEqual((await list({ since: '2026-10-06T00:00:00Z' })).tasks.map((t: any) => t.title), ['Docs']);
  assert.equal((await list({ since: '2026-10-07' })).total, 0);
  assert.deepEqual((await list({ search: 'LOGIN' })).tasks.map((t: any) => t.title), ['Fix Login']);
  assert.deepEqual(await list({ search: 'nothing-matches' }), { tasks: [], total: 0 });
});

test('I112 limit 0, 101 and 1.5, a bad cursor and a bad since are 400', async () => {
  const { software, caller } = await taskPair();
  for (const inputs of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'garbage' }, { since: 'yesterday' }, { search: 's'.repeat(201) }]) {
    assert.equal((await call(caller, software, 'list-completed-tasks', inputs)).status, 400, JSON.stringify(inputs));
  }
  assert.equal((await call(caller, software, 'list-completed-tasks', { limit: 100 })).status, 200);
});

test('I113 the new capabilities start no run and need no approval, and a CLI session is offered them', async () => {
  const { software, caller } = await taskPair();
  const session = await task(caller);
  assert.ok((await agentList(session.id)).some((c) => c.capabilityId === 'get-task-details'));
  const res = await agentCall(session.id, { targetBuildingId: software.id, capabilityId: 'list-completed-tasks', inputs: {} });
  assert.deepEqual([res.status, res.body.state], [200, 'done']);
});

test('I114 get open tasks is unchanged', async () => {
  const { software, caller } = await taskPair();
  const item = await planItem(software, { title: 'Open one' });
  const res = await call(caller, software, 'get-open-tasks');
  assert.deepEqual(res.body.outputs.tasks, [{ id: item.id, title: 'Open one', status: 'pending', type: 'task' }]);
});

test('I115 a link made with every capability keeps them all, and an omitted list grants none', async () => {
  const software = await building('software');
  const caller = await building();
  const all = (await api('/api/building-types')).body.find((t: any) => t.id === 'software').capabilities.map((c: any) => ({ capabilityId: c.id, preApproved: false }));
  assert.ok(all.some((g: any) => g.capabilityId === 'get-task-details') && all.some((g: any) => g.capabilityId === 'list-completed-tasks'));
  const made = await send('POST', '/api/links', { fromBuildingId: caller.id, toBuildingId: software.id, capabilities: all });
  assert.deepEqual(made.body.capabilities, all);
  const other = await building('software');
  const none = await send('POST', '/api/links', { fromBuildingId: caller.id, toBuildingId: other.id });
  assert.deepEqual(none.body.capabilities, []);
});

test('I116 unchecking one capability changes only that one, re-checking restores it, and the file keeps the change', async () => {
  const { software, caller, linkId } = await taskPair();
  const grant = (id: string) => ({ capabilityId: id, preApproved: false });
  assert.equal((await send('PATCH', `/api/links/${linkId}`, { capabilities: [grant('get-open-tasks'), grant('list-completed-tasks')] })).status, 200);
  assert.equal((await details(caller, software, { id: 'x' })).status, 403);
  assert.equal((await call(caller, software, 'list-completed-tasks')).status, 200);
  assert.deepEqual((await collections.buildingLinksDb.get(linkId))!.capabilities.map((g) => g.capabilityId), ['get-open-tasks', 'list-completed-tasks']);
  await send('PATCH', `/api/links/${linkId}`, { capabilities: TASK_CAPS.map(grant) });
  assert.equal((await details(caller, software, { id: 'x' })).status, 404);
  assert.equal((await send('PATCH', `/api/links/${linkId}`, { capabilities: [grant('not-a-capability')] })).status, 400);
});

test('I117 Start planning session granted by default still waits for approval and is not pre-approved', async () => {
  const software = await building('software');
  const caller = await building();
  const grants = ['get-open-tasks', 'get-task-details', 'list-completed-tasks', 'start-planning-session'].map((capabilityId) => ({ capabilityId, preApproved: false }));
  const made = await send('POST', '/api/links', { fromBuildingId: caller.id, toBuildingId: software.id, capabilities: grants });
  assert.equal(made.body.capabilities.every((g: any) => g.preApproved === false), true);
  const held = await call(caller, software, 'start-planning-session', { prompt: 'Plan it' });
  assert.deepEqual([held.status, held.body.state], [202, 'awaiting-approval']);
});

test('I118 startup migration switches on the two new capabilities for old links only, keeps other choices and does not redo an uncheck', async () => {
  const software = await building('software');
  const callers = [await building(), await building(), await building()];
  const mk = (from: { id: string }, capabilities: unknown[], events: string[] = []) => collections.buildingLinksDb.insert({ id: `old-${from.id}`, fromBuildingId: from.id, toBuildingId: software.id, capabilities, events, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as never);
  await mk(callers[0]!, [{ capabilityId: 'get-open-tasks', preApproved: false }, { capabilityId: 'start-planning-session', preApproved: true }]);
  await mk(callers[1]!, []);
  const fresh = await send('POST', '/api/links', { fromBuildingId: callers[2]!.id, toBuildingId: software.id, capabilities: [{ capabilityId: 'get-open-tasks', preApproved: false }] });
  await connections.migrateLinkGrantsOnStartup();
  const ids = async (from: { id: string }) => (await collections.buildingLinksDb.find((l) => l.fromBuildingId === from.id))[0]!.capabilities.map((g) => `${g.capabilityId}:${g.preApproved}`);
  assert.deepEqual(await ids(callers[0]!), ['get-open-tasks:false', 'start-planning-session:true', 'get-task-details:false', 'list-completed-tasks:false']);
  assert.deepEqual(await ids(callers[1]!), ['get-task-details:false', 'list-completed-tasks:false']);
  assert.deepEqual(await ids(callers[2]!), ['get-open-tasks:false'], 'a link made after the release is not migrated');
  await send('PATCH', `/api/links/${fresh.body.id}`, { capabilities: [] });
  await send('PATCH', `/api/links/old-${callers[1]!.id}`, { capabilities: [] });
  await connections.migrateLinkGrantsOnStartup();
  assert.deepEqual(await ids(callers[1]!), [], 'unchecked after the migration stays off');
});

test('I119 migration leaves a link whose target is gone or whose type lacks the capability, and events stay as they were', async () => {
  const caller = await building();
  const plain = await building();
  await collections.buildingLinksDb.insert({ id: 'old-plain', fromBuildingId: caller.id, toBuildingId: plain.id, capabilities: [{ capabilityId: 'read-echo', preApproved: false }], events: ['deal-won'], createdAt: '', updatedAt: '' } as never);
  await collections.buildingLinksDb.insert({ id: 'old-gone', fromBuildingId: caller.id, toBuildingId: 'deleted-building', capabilities: [], events: [], createdAt: '', updatedAt: '' } as never);
  await connections.migrateLinkGrantsOnStartup();
  const kept = (await collections.buildingLinksDb.get('old-plain'))!;
  assert.deepEqual([kept.capabilities, kept.events], [[{ capabilityId: 'read-echo', preApproved: false }], ['deal-won']]);
  assert.deepEqual((await collections.buildingLinksDb.get('old-gone'))!.capabilities, []);
});
