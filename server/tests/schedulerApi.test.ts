import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { BuildingTypeDefinition } from '../src/buildings/contract.ts';
import type { ProjectRecord } from '../src/domain/types.ts';
import type { JobView, Scheduler, SchedulesView } from '../src/scheduler/scheduler.ts';
import type { JobHistoryEntry } from '../src/scheduler/types.ts';
import { fakeClock, fakeSources, fakeStarter } from './helpers/schedulerFakes.ts';

/** The Schedules routes over HTTP. The scheduler is the real one on an injected clock with a fake run starter, so no run is ever started. */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let scheduler: Scheduler;
let registry: typeof import('../src/buildings/registry.ts');
let collections: typeof import('../src/db/collections.ts');
let buildingStorage: typeof import('../src/buildings/buildingStorage.ts');
let runs: ReturnType<typeof fakeStarter>;
const clock = fakeClock('2026-10-11T05:50:00.000Z');
const sources = fakeSources();

const declaredType = (patch: Partial<BuildingTypeDefinition> = {}): BuildingTypeDefinition => ({
  id: 'sched-api', name: 'Scheduled API', description: 'A type with declared jobs.', category: 'Test', version: 1,
  look: { model: 'generic', color: '#fff' }, workspace: 'notes', repository: false,
  validateCreate: (input) => ({ ok: true, value: { name: String((input as { name?: unknown }).name ?? 'x') } }),
  slots: [{ id: 'review', label: 'Review', usedWhen: 'x', defaultWorkflowId: 'software-development' }],
  agents: [], capabilities: [], events: [],
  scheduledJobs: [{ id: 'weekly', description: 'Review every week', cron: '0 9 * * 1', enabled: true, needsApproval: true }, { id: 'daily', description: 'Check daily', cron: '@daily' }],
  ...patch,
});

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'scheduler-api-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  const schedulerModule = await import('../src/scheduler/scheduler.ts');
  registry = await import('../src/buildings/registry.ts');
  collections = await import('../src/db/collections.ts');
  buildingStorage = await import('../src/buildings/buildingStorage.ts');
  registry.registerBuildingType(declaredType());
  runs = fakeStarter(schedulerModule.NoFreeSlotError);
  scheduler = schedulerModule.createScheduler({
    starter: runs.starter, now: clock.now, setTimer: clock.setTimer, hostTimezone: 'UTC', readFiles: sources.readFiles, fetchApi: sources.fetchApi,
  });
  await scheduler.start();
  server = createDaemonServer({ scheduler });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  scheduler.stop();
  await scheduler.idle();
  await buildingStorage.closeAllStores();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const send = (method: string, pathname: string, body?: unknown) => api(pathname, { method, body: body === undefined ? undefined : JSON.stringify(body) });

let buildingCount = 0;
async function building(typeId = 'notes'): Promise<ProjectRecord> {
  buildingCount += 1;
  const res = await send('POST', '/api/projects', { name: `Schedules ${buildingCount}`, typeId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const cronJob = (patch: Record<string, unknown> = {}) => ({
  name: 'Weekly review', trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'slot', slotId: 'review', description: 'Review the notes.' }, ...patch,
});
const base = (project: { id: string }) => `/api/projects/${project.id}/schedules`;
async function createJob(project: { id: string }, patch: Record<string, unknown> = {}): Promise<JobView> {
  const res = await send('POST', `${base(project)}/jobs`, cronJob(patch));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const list = async (project: { id: string }): Promise<SchedulesView> => (await api(base(project))).body;
const historyOf = async (project: { id: string }, jobId: string, query = ''): Promise<{ entries: JobHistoryEntry[]; nextCursor: string | null }> => (await api(`${base(project)}/jobs/${jobId}/history${query}`)).body;
async function settle(runId: string, status: Parameters<typeof runs.settle>[1], note: string | null = null) {
  runs.settle(runId, status, note);
  await scheduler.idle();
}

test('IA01 a Building with no jobs lists none, with its timezone (null) and the host\'s', async () => {
  const project = await building();
  const res = await api(base(project));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { projectId: project.id, timezone: null, hostTimezone: 'UTC', jobs: [], missingDefaults: 0 });
});

test('IA02 creating a valid cron job answers 201 with its id, next-run time and defaults, and it appears in the list', async () => {
  const project = await building();
  const res = await send('POST', `${base(project)}/jobs`, cronJob());
  assert.equal(res.status, 201);
  const { id, createdAt, updatedAt, ...rest } = res.body;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([createdAt, updatedAt], ['2026-10-11T05:50:00.000Z', '2026-10-11T05:50:00.000Z']);
  assert.deepEqual(rest, {
    projectId: project.id, declaredJobId: null, name: 'Weekly review', enabled: true,
    trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'slot', slotId: 'review', description: 'Review the notes.' },
    overlap: 'skip', missedPolicy: 'skip', maxRunsPerDay: null, maxFiveHourPercent: null, maxWeeklyPercent: null, needsApproval: false, failureThreshold: 3,
    consecutiveFailures: 0, autoDisabled: false, nextRunAt: '2026-10-12T09:00:00.000Z', pollError: null,
    runsToday: 0, activeRun: null, queued: false, lastEntry: null,
  });
  assert.deepEqual((await list(project)).jobs, [res.body]);
});

test('IA03 creating a folder job and an API job answers 201 each, with a next check time', async () => {
  const project = await building();
  const folder = await send('POST', `${base(project)}/jobs`, cronJob({ trigger: { kind: 'file', path: 'inbox', detect: 'mtime', intervalSeconds: 300 }, missedPolicy: 'once' }));
  const endpoint = await send('POST', `${base(project)}/jobs`, cronJob({ trigger: { kind: 'api', url: 'https://example.com/x?token=abc', jsonField: '', intervalSeconds: 60 } }));
  assert.deepEqual([folder.status, endpoint.status], [201, 201]);
  assert.deepEqual([folder.body.nextRunAt, folder.body.missedPolicy, folder.body.trigger], ['2026-10-11T05:50:00.000Z', null, { kind: 'file', path: 'inbox', detect: 'mtime', intervalSeconds: 300 }]);
  assert.deepEqual(endpoint.body.trigger, { kind: 'api', url: 'https://example.com/x?token=abc', jsonField: null, intervalSeconds: 60 }, 'the address is returned to its owner as typed');
  await send('PATCH', `${base(project)}/jobs/${folder.body.id}`, { enabled: false });
  await send('PATCH', `${base(project)}/jobs/${endpoint.body.id}`, { enabled: false });
});

test('IA04 an invalid cron expression answers 400 with an error that mentions cron and the field; nothing is stored', async () => {
  const project = await building();
  const res = await send('POST', `${base(project)}/jobs`, cronJob({ trigger: { kind: 'cron', cron: '99 * * * *' } }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cron/i);
  assert.equal(res.body.field, 'trigger.cron');
  assert.deepEqual((await list(project)).jobs, []);
});

test('IA05 a 59-second interval answers 400 naming the 1-minute minimum', async () => {
  const project = await building();
  const res = await send('POST', `${base(project)}/jobs`, cronJob({ trigger: { kind: 'file', path: 'inbox', detect: 'hash', intervalSeconds: 59 } }));
  assert.deepEqual([res.status, res.body], [400, { error: 'The interval must be at least 1 minute', field: 'trigger.intervalSeconds' }]);
});

test('IA06 an unknown slot answers 400 naming the slot', async () => {
  const project = await building();
  const res = await send('POST', `${base(project)}/jobs`, cronJob({ target: { kind: 'slot', slotId: 'ghost', description: 'x' } }));
  assert.deepEqual([res.status, res.body], [400, { error: 'This Building\'s type has no workflow slot "ghost"', field: 'target.slotId' }]);
});

test('IA07 an unknown Building answers 404 with an error on every route', async () => {
  const missing = '/api/projects/no-such-building/schedules';
  const calls: [string, string, unknown?][] = [
    ['GET', missing], ['POST', `${missing}/jobs`, cronJob()], ['PATCH', `${missing}/jobs/j`, { name: 'x' }], ['DELETE', `${missing}/jobs/j`],
    ['POST', `${missing}/jobs/j/run`], ['GET', `${missing}/jobs/j/history`], ['PATCH', missing, { timezone: 'UTC' }], ['POST', `${missing}/restore-defaults`],
    ['GET', `${missing}/cron-preview?cron=@daily`],
  ];
  for (const [method, pathname, body] of calls) {
    const res = await send(method, pathname, body);
    assert.equal(res.status, 404, `${method} ${pathname}`);
    assert.equal(typeof res.body.error, 'string', `${method} ${pathname}`);
  }
});

test('IA08 an unknown job id, or another Building\'s job id under this Building, answers 404', async () => {
  const project = await building();
  const other = await building();
  const foreign = await createJob(other);
  for (const jobId of ['no-such-job', foreign.id]) {
    for (const [method, suffix, body] of [['PATCH', '', { name: 'x' }], ['DELETE', ''], ['POST', '/run'], ['GET', '/history']] as [string, string, unknown?][]) {
      const res = await send(method, `${base(project)}/jobs/${jobId}${suffix}`, body);
      assert.deepEqual([res.status, res.body], [404, { error: 'This job no longer exists' }], `${method} ${suffix} ${jobId}`);
    }
  }
  assert.equal((await list(other)).jobs[0]!.name, 'Weekly review', 'the other Building\'s job is untouched');
});

test('IA09 one over-limit value per field answers 400 naming that field', async () => {
  const project = await building();
  const cases: [Record<string, unknown>, string][] = [
    [{ name: 'x'.repeat(121) }, 'name'],
    [{ target: { kind: 'prompt', prompt: 'x'.repeat(10_001) } }, 'target.prompt'],
    [{ maxRunsPerDay: 1001 }, 'maxRunsPerDay'],
    [{ failureThreshold: 101 }, 'failureThreshold'],
    [{ maxFiveHourPercent: 101 }, 'maxFiveHourPercent'],
    [{ maxWeeklyPercent: 101 }, 'maxWeeklyPercent'],
    [{ trigger: { kind: 'api', url: 'https://example.com', intervalSeconds: 30 * 24 * 3600 + 1 } }, 'trigger.intervalSeconds'],
  ];
  for (const [patch, field] of cases) {
    const res = await send('POST', `${base(project)}/jobs`, cronJob(patch));
    assert.deepEqual([res.status, res.body.field], [400, field]);
    assert.ok(res.body.error.length > 0);
  }
  assert.deepEqual((await list(project)).jobs, []);
});

test('IA10 malformed JSON or a body that is not an object answers 400', async () => {
  const project = await building();
  const malformed = await api(`${base(project)}/jobs`, { method: 'POST', body: '{"name": ' });
  assert.equal(malformed.status, 400);
  assert.equal(typeof malformed.body.error, 'string');
  for (const body of ['[]', '[{"name":"x"}]']) {
    const res = await api(`${base(project)}/jobs`, { method: 'POST', body });
    assert.deepEqual([res.status, res.body.field], [400, 'body']);
  }
  const job = await createJob(project);
  assert.equal((await api(`${base(project)}/jobs/${job.id}`, { method: 'PATCH', body: '[]' })).status, 400);
});

test('IA11 an edit answers 200 with the new values and next-run time; the id, creation time and history are unchanged', async () => {
  const project = await building();
  const job = await createJob(project, { overlap: 'parallel' });
  const ran = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  await settle(ran.body.entry.runId, 'succeeded');
  const before = await historyOf(project, job.id);
  clock.advance(60_000);
  const res = await send('PATCH', `${base(project)}/jobs/${job.id}`, { name: ' Daily review ', trigger: { kind: 'cron', cron: '0 9 * * *' }, maxRunsPerDay: 2, needsApproval: true });
  assert.equal(res.status, 200);
  assert.deepEqual(
    [res.body.id, res.body.createdAt, res.body.name, res.body.trigger, res.body.nextRunAt, res.body.maxRunsPerDay, res.body.needsApproval, res.body.overlap],
    [job.id, job.createdAt, 'Daily review', { kind: 'cron', cron: '0 9 * * *' }, '2026-10-11T09:00:00.000Z', 2, true, 'parallel'],
  );
  assert.notEqual(res.body.updatedAt, job.updatedAt);
  assert.deepEqual(await historyOf(project, job.id), before);
});

test('IA12 switching off and on; switching on a job that was turned off automatically resets its count and clears the flag', async () => {
  const project = await building();
  const job = await createJob(project, { failureThreshold: 1 });
  const off = await send('PATCH', `${base(project)}/jobs/${job.id}`, { enabled: false });
  assert.deepEqual([off.status, off.body.enabled, off.body.nextRunAt, off.body.autoDisabled], [200, false, null, false]);
  const on = await send('PATCH', `${base(project)}/jobs/${job.id}`, { enabled: true });
  assert.deepEqual([on.body.enabled, on.body.nextRunAt], [true, '2026-10-12T09:00:00.000Z']);

  const ran = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  await settle(ran.body.entry.runId, 'failed', 'boom');
  const turnedOff = (await list(project)).jobs[0]!;
  assert.deepEqual([turnedOff.enabled, turnedOff.autoDisabled, turnedOff.consecutiveFailures], [false, true, 1]);
  const back = await send('PATCH', `${base(project)}/jobs/${job.id}`, { enabled: true });
  assert.deepEqual([back.body.enabled, back.body.autoDisabled, back.body.consecutiveFailures, back.body.nextRunAt], [true, false, 0, '2026-10-12T09:00:00.000Z']);
});

test('IA13 an invalid edit answers 400 and a re-read shows the job unchanged', async () => {
  const project = await building();
  const job = await createJob(project);
  for (const [patch, field] of [[{ trigger: { kind: 'file' } }, 'trigger.path'], [{ overlap: 'Skip' }, 'overlap'], [{ name: '' }, 'name'], [{ trigger: { kind: 'cron', cron: 'nope' } }, 'trigger.cron']] as const) {
    const res = await send('PATCH', `${base(project)}/jobs/${job.id}`, patch);
    assert.deepEqual([res.status, res.body.field], [400, field]);
  }
  assert.deepEqual((await list(project)).jobs, [job]);
});

test('IA14 an edit while a run is going answers 200 and leaves the run\'s own record unchanged', async () => {
  const project = await building();
  const job = await createJob(project);
  const ran = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  const res = await send('PATCH', `${base(project)}/jobs/${job.id}`, { target: { kind: 'prompt', prompt: 'Something else' }, needsApproval: true });
  assert.deepEqual([res.status, res.body.activeRun], [200, { entryId: ran.body.entry.id, runId: ran.body.entry.runId, outcome: 'running' }]);
  assert.deepEqual((await historyOf(project, job.id)).entries, [ran.body.entry]);
  assert.deepEqual(await runs.starter.state(ran.body.entry.runId), { status: 'running', note: null });
  await settle(ran.body.entry.runId, 'succeeded');
});

test('IA15 delete answers 204; the job is gone from the list, its history answers 404, and a second delete answers 404', async () => {
  const project = await building();
  const job = await createJob(project);
  await send('POST', `${base(project)}/jobs/${job.id}/run`);
  const res = await send('DELETE', `${base(project)}/jobs/${job.id}`);
  assert.deepEqual([res.status, res.body], [204, undefined]);
  assert.deepEqual((await list(project)).jobs, []);
  assert.equal((await api(`${base(project)}/jobs/${job.id}/history`)).status, 404);
  assert.equal((await send('DELETE', `${base(project)}/jobs/${job.id}`)).status, 404);
  assert.deepEqual(await collections.jobHistoryDb.find((entry) => entry.jobId === job.id), []);
});

test('IA16 Run now on an idle job answers 201 with the history entry and run id; the next-run time is unchanged', async () => {
  const project = await building();
  const job = await createJob(project);
  const res = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.equal(res.status, 201);
  assert.deepEqual([res.body.entry.startedBy, res.body.entry.outcome, typeof res.body.entry.runId, res.body.job.nextRunAt], ['run-now', 'running', 'string', job.nextRunAt]);
  assert.deepEqual(res.body.job.activeRun, { entryId: res.body.entry.id, runId: res.body.entry.runId, outcome: 'running' });
  assert.equal(runs.starts.at(-1)!.job.id, job.id);
  await settle(res.body.entry.runId, 'succeeded');
});

test('IA17 Run now with a run going and overlap skip answers 409 naming the rule, and starts nothing', async () => {
  const project = await building();
  const job = await createJob(project);
  const first = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  const startsBefore = runs.starts.length;
  const res = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.deepEqual([res.status, res.body], [409, { error: 'The previous run is still going (overlap rule: skip)' }]);
  assert.equal(runs.starts.length, startsBefore);
  assert.equal((await historyOf(project, job.id)).entries.length, 1, 'a refused Run now writes no entry');
  await settle(first.body.entry.runId, 'succeeded');
});

test('IA17 Run now whose start fails at set-up answers 409 with the reason, and the failed entry is in the history', async () => {
  const project = await building();
  const job = await createJob(project);
  runs.failNext = new Error('The workflow for "Review" is missing or disabled in the Catalog');
  const res = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.deepEqual([res.status, res.body], [409, { error: 'The workflow for "Review" is missing or disabled in the Catalog' }]);
  const { entries } = await historyOf(project, job.id);
  assert.deepEqual(entries.map((e) => [e.startedBy, e.outcome, e.note, e.runId]), [['run-now', 'failed', 'The workflow for "Review" is missing or disabled in the Catalog', null]]);
  const view = (await list(project)).jobs[0]!;
  assert.deepEqual([view.consecutiveFailures, view.activeRun, view.lastEntry!.outcome], [1, null, 'failed']);
  assert.equal((await send('POST', `${base(project)}/jobs/${job.id}/run`)).status, 201, 'once the cause is gone the job runs');
  await settle(runs.starts.at(-1)!.runId, 'succeeded');
});

test('IA13 a job whose slot the type no longer has can still be renamed and switched off', async () => {
  registry.registerBuildingType(declaredType({ id: 'sched-shrinks', scheduledJobs: [], slots: [{ id: 'review', label: 'Review', usedWhen: 'x', defaultWorkflowId: 'software-development' }, { id: 'publish', label: 'Publish', usedWhen: 'x', defaultWorkflowId: 'software-development' }] }));
  const project = await building('sched-shrinks');
  const job = await createJob(project, { target: { kind: 'slot', slotId: 'publish', description: 'Publish it.' } });
  registry.unregisterBuildingType('sched-shrinks');
  registry.registerBuildingType(declaredType({ id: 'sched-shrinks', scheduledJobs: [] }));
  const off = await send('PATCH', `${base(project)}/jobs/${job.id}`, { enabled: false, name: 'Parked' });
  assert.deepEqual([off.status, off.body.enabled, off.body.name, off.body.target.slotId], [200, false, 'Parked', 'publish']);
  const retarget = await send('PATCH', `${base(project)}/jobs/${job.id}`, { target: { kind: 'slot', slotId: 'publish', description: 'Again.' } });
  assert.deepEqual([retarget.status, retarget.body.field], [400, 'target.slotId']);
  const ran = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.deepEqual([ran.status, ran.body], [409, { error: 'This Building\'s type no longer has the workflow slot "publish"' }]);
});

test('IA18 Run now with overlap queue answers 202 and a Queued entry; again while one is queued answers 409', async () => {
  const project = await building();
  const job = await createJob(project, { overlap: 'queue' });
  const first = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  const queued = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.deepEqual([queued.status, queued.body.entry.outcome, queued.body.entry.runId, queued.body.job.queued], [202, 'queued', null, true]);
  const again = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.deepEqual([again.status, again.body], [409, { error: 'A run is already waiting to start (overlap rule: queue)' }]);
  await settle(first.body.entry.runId, 'succeeded');
  const entries = (await historyOf(project, job.id)).entries;
  assert.deepEqual(entries.map((e) => [e.outcome, e.startedBy]), [['running', 'run-now'], ['succeeded', 'run-now']]);
  await settle(entries[0]!.runId!, 'succeeded');
});

test('IA19 Run now with overlap parallel answers 201 where the Building has room, and 202 Queued at its cap', async () => {
  const project = await building();
  const job = await createJob(project, { overlap: 'parallel' });
  runs.capacity.set(project.id, 2);
  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await send('POST', `${base(project)}/jobs/${job.id}/run`)).status);
  assert.deepEqual(statuses, [201, 201, 202]);
  const entries = (await historyOf(project, job.id)).entries;
  assert.deepEqual(entries.map((e) => [e.outcome, e.note]), [['queued', 'Waiting for a free slot in this Building'], ['running', null], ['running', null]]);
  for (const entry of entries.filter((e) => e.runId)) await settle(entry.runId!, 'succeeded');
  await settle((await historyOf(project, job.id)).entries[0]!.runId!, 'succeeded');
});

test('IA20 Run now on a job that is switched off starts a run and leaves it off', async () => {
  const project = await building();
  const job = await createJob(project, { enabled: false });
  const res = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.deepEqual([res.status, res.body.entry.outcome, res.body.job.enabled, res.body.job.nextRunAt], [201, 'running', false, null]);
  await settle(res.body.entry.runId, 'succeeded');
  assert.equal((await list(project)).jobs[0]!.enabled, false);
});

test('IA21 Run now over the daily limit starts anyway and adds to today\'s count', async () => {
  const project = await building();
  const job = await createJob(project, { maxRunsPerDay: 1, maxFiveHourPercent: 1, overlap: 'parallel' });
  const first = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  const second = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.deepEqual([first.status, second.status, second.body.job.runsToday], [201, 201, 2]);
  await settle(first.body.entry.runId, 'succeeded');
  await settle(second.body.entry.runId, 'succeeded');
});

test('IA22 a read-only Building: list and history answer 200; every change answers 409 with the read-only reason', async () => {
  registry.registerBuildingType(declaredType({ id: 'sched-gone', scheduledJobs: [] }));
  const project = await building('sched-gone');
  const job = await createJob(project);
  registry.unregisterBuildingType('sched-gone');
  const reason = { error: 'The "sched-gone" Building type is no longer available.' };
  assert.equal((await api(base(project))).status, 200);
  assert.equal((await api(`${base(project)}/jobs/${job.id}/history`)).status, 200);
  assert.equal((await api(`${base(project)}/cron-preview?cron=@daily`)).status, 200);
  const changes: [string, string, unknown?][] = [
    ['POST', `${base(project)}/jobs`, cronJob()], ['PATCH', `${base(project)}/jobs/${job.id}`, { name: 'x' }], ['DELETE', `${base(project)}/jobs/${job.id}`],
    ['POST', `${base(project)}/jobs/${job.id}/run`], ['PATCH', base(project), { timezone: 'UTC' }], ['POST', `${base(project)}/restore-defaults`],
  ];
  for (const [method, pathname, body] of changes) {
    const res = await send(method, pathname, body);
    assert.deepEqual([res.status, res.body], [409, reason], `${method} ${pathname}`);
  }
  assert.equal((await list(project)).jobs[0]!.name, 'Weekly review');
});

test('IA23 history is newest first, 50 by default, limit clamped to 200, paged by cursor with no repeats or gaps while entries arrive', async () => {
  const project = await building();
  const job = await createJob(project, { overlap: 'parallel' });
  const runOnce = async () => {
    const res = await send('POST', `${base(project)}/jobs/${job.id}/run`);
    await settle(res.body.entry.runId, 'succeeded');
  };
  for (let i = 0; i < 120; i += 1) await runOnce();
  const first = await historyOf(project, job.id);
  assert.deepEqual([first.entries.length, first.entries[0]!.seq, first.entries.at(-1)!.seq, first.nextCursor], [50, 120, 71, '71']);
  for (let i = 0; i < 3; i += 1) await runOnce();
  const second = await historyOf(project, job.id, `?cursor=${first.nextCursor}&limit=30`);
  assert.deepEqual([second.entries.length, second.entries[0]!.seq, second.entries.at(-1)!.seq, second.nextCursor], [30, 70, 41, '41']);
  const rest = await historyOf(project, job.id, `?cursor=${second.nextCursor}&limit=999`);
  assert.deepEqual([rest.entries.length, rest.entries.at(-1)!.seq, rest.nextCursor], [40, 1, null]);
  assert.equal((await historyOf(project, job.id, '?limit=999')).entries.length, 123, 'the limit is clamped; every entry fits under 200');
  assert.equal((await historyOf(project, job.id, '?limit=2')).entries.length, 2);
  for (const query of ['?cursor=abc', '?cursor=-1', '?cursor=0', '?cursor=1.5', '?limit=0', '?limit=x', '?cursor=1&cursor=2']) {
    const res = await api(`${base(project)}/jobs/${job.id}/history${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(typeof res.body.error, 'string');
  }
});

test('IA24 a history entry carries every field, with null sent rather than left out', async () => {
  const project = await building();
  const job = await createJob(project);
  const started = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  const { id, runId, ...going } = started.body.entry;
  assert.deepEqual([typeof id, typeof runId], ['string', 'string']);
  assert.deepEqual(going, {
    jobId: job.id, projectId: project.id, seq: 1, startedBy: 'run-now', outcome: 'running', dueAt: clock.now() && new Date(clock.now()).toISOString(),
    startedAt: new Date(clock.now()).toISOString(), finishedAt: null, durationMs: null, note: null, change: null, runStartedAt: new Date(clock.now()).toISOString(), deferredUntil: null,
  });
  clock.advance(5000);
  await settle(runId, 'succeeded');
  const [done] = (await historyOf(project, job.id)).entries;
  assert.deepEqual([done!.outcome, done!.finishedAt, done!.durationMs, done!.runId], ['succeeded', new Date(clock.now()).toISOString(), 5000, runId]);
});

test('IA25 setting the timezone: a valid name answers 200 and next-run times change; null is the host\'s; a bad value answers 400', async () => {
  const project = await building();
  const job = await createJob(project);
  const set = await send('PATCH', base(project), { timezone: 'Asia/Kolkata' });
  assert.deepEqual([set.status, set.body.timezone, set.body.jobs[0].nextRunAt], [200, 'Asia/Kolkata', '2026-10-12T03:30:00.000Z']);
  assert.equal((await api(`/api/projects/${project.id}`)).body.timezone, 'Asia/Kolkata', 'stored on the Building');
  for (const timezone of ['Mars/Olympus', '', 5, undefined, 'utc']) {
    const res = await send('PATCH', base(project), { timezone });
    assert.deepEqual([res.status, res.body.field], [400, 'timezone'], String(timezone));
  }
  assert.equal((await list(project)).timezone, 'Asia/Kolkata');
  const reset = await send('PATCH', base(project), { timezone: null });
  assert.deepEqual([reset.status, reset.body.timezone, reset.body.jobs[0].nextRunAt], [200, null, job.nextRunAt]);
});

test('IA26/IA28 a new Building gets its type\'s declared jobs with their declared ids; restore defaults adds the missing ones back', async () => {
  const project = await building('sched-api');
  const seeded = await list(project);
  assert.deepEqual(seeded.jobs.map((j) => [j.declaredJobId, j.enabled, j.needsApproval]), [['weekly', true, true], ['daily', false, false]]);
  const own = await createJob(project);
  assert.equal(own.declaredJobId, null, 'a person\'s own job has no declared id');
  await send('DELETE', `${base(project)}/jobs/${seeded.jobs[0]!.id}`);
  assert.equal((await list(project)).missingDefaults, 1);
  const restored = await send('POST', `${base(project)}/restore-defaults`);
  assert.equal(restored.status, 200);
  assert.deepEqual([restored.body.missingDefaults, restored.body.jobs.map((j: JobView) => j.declaredJobId).sort()], [0, ['daily', 'weekly', null].sort()]);

  const plain = await building();
  const nothing = await send('POST', `${base(plain)}/restore-defaults`);
  assert.deepEqual([nothing.status, nothing.body.jobs], [200, []], 'a type with no declared jobs: 200 and no change');
});

test('IA27 a cron preview gives the next three times in the Building\'s timezone; an invalid expression answers 400', async () => {
  const project = await building();
  await send('PATCH', base(project), { timezone: 'Asia/Kolkata' });
  const res = await api(`${base(project)}/cron-preview?cron=${encodeURIComponent(' 0  9 * * MON ')}`);
  assert.deepEqual([res.status, res.body], [200, { cron: '0 9 * * MON', timezone: 'Asia/Kolkata', runs: ['2026-10-12T03:30:00.000Z', '2026-10-19T03:30:00.000Z', '2026-10-26T03:30:00.000Z'] }]);
  for (const query of ['?cron=61%20*%20*%20*%20*', '', '?cron=']) {
    const bad = await api(`${base(project)}/cron-preview${query}`);
    assert.deepEqual([bad.status, bad.body.field], [400, 'cron']);
    assert.match(bad.body.error, /cron/i);
  }
  assert.deepEqual((await api(`${base(project)}/cron-preview?cron=${encodeURIComponent('0 0 30 2 *')}`)).body.runs, [], 'an expression that never matches has no upcoming runs');
});

test('IA29 a job change and a new history entry each reach /ws with the Building id', async () => {
  const project = await building();
  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
  const events: { type: string; projectId?: string; jobId?: string; schedules?: SchedulesView; entry?: JobHistoryEntry }[] = [];
  socket.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'schedules' || event.type === 'scheduleEntry') events.push(event); });
  await new Promise((resolve) => socket.once('open', resolve));
  const waitFor = async (count: number) => {
    const started = Date.now();
    while (events.length < count) {
      if (Date.now() - started > 5000) throw new Error(`expected ${count} schedule events, got ${events.length}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const job = await createJob(project);
  await waitFor(1);
  assert.deepEqual([events[0]!.type, events[0]!.projectId, events[0]!.schedules!.jobs.map((j) => j.id)], ['schedules', project.id, [job.id]]);
  const ran = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  await waitFor(3);
  assert.deepEqual([events[1]!.type, events[1]!.projectId, events[1]!.jobId, events[1]!.entry!.id], ['scheduleEntry', project.id, job.id, ran.body.entry.id]);
  assert.deepEqual([events[2]!.type, events[2]!.schedules!.jobs[0]!.activeRun!.runId], ['schedules', ran.body.entry.runId]);
  socket.close();
  await settle(ran.body.entry.runId, 'succeeded');
});

test('IA30 deleting the Building through its own route removes its jobs: the list answers 404 and nothing is left in the store', async () => {
  const project = await building();
  const job = await createJob(project);
  const poll = await createJob(project, { enabled: false, trigger: { kind: 'file', path: 'inbox', detect: 'hash', intervalSeconds: 60 } });
  const ran = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  await settle(ran.body.entry.runId, 'succeeded');
  assert.equal((await send('DELETE', `/api/projects/${project.id}`)).status, 204);
  assert.equal((await api(base(project))).status, 404);
  assert.deepEqual(await collections.scheduledJobsDb.find((j) => j.projectId === project.id), []);
  assert.deepEqual(await collections.jobHistoryDb.find((entry) => entry.projectId === project.id), []);
  assert.equal(await collections.pollBaselinesDb.get(poll.id), undefined);
});

test('IA31 an id, counters, a next-run time or another Building\'s id in the body are ignored', async () => {
  const project = await building();
  const other = await building();
  const res = await send('POST', `${base(project)}/jobs`, cronJob({ id: 'mine', consecutiveFailures: 9, nextRunAt: '2020-01-01T00:00:00.000Z', projectId: other.id, autoDisabled: true, declaredJobId: 'weekly', pollError: 'x' }));
  assert.equal(res.status, 201);
  assert.notEqual(res.body.id, 'mine');
  assert.deepEqual([res.body.consecutiveFailures, res.body.nextRunAt, res.body.projectId, res.body.autoDisabled, res.body.declaredJobId, res.body.pollError], [0, '2026-10-12T09:00:00.000Z', project.id, false, null, null]);
  const edited = await send('PATCH', `${base(project)}/jobs/${res.body.id}`, { id: 'mine', projectId: other.id, consecutiveFailures: 9, name: 'Edited' });
  assert.deepEqual([edited.body.id, edited.body.projectId, edited.body.consecutiveFailures, edited.body.name], [res.body.id, project.id, 0, 'Edited']);
  assert.deepEqual((await list(other)).jobs, []);
});

test('IA32 two Buildings never list each other\'s jobs, and their timezones are separate', async () => {
  const [one, two] = [await building(), await building()];
  const jobOne = await createJob(one, { name: 'One' });
  const jobTwo = await createJob(two, { name: 'Two' });
  await send('PATCH', base(one), { timezone: 'Asia/Kolkata' });
  const [listOne, listTwo] = [await list(one), await list(two)];
  assert.deepEqual([listOne.jobs.map((j) => j.id), listOne.timezone], [[jobOne.id], 'Asia/Kolkata']);
  assert.deepEqual([listTwo.jobs.map((j) => j.id), listTwo.timezone, listTwo.jobs[0]!.nextRunAt], [[jobTwo.id], null, '2026-10-12T09:00:00.000Z']);
});

test('IA33 GET /api/building-types returns each type\'s declared jobs in the extended shape', async () => {
  const types = (await api('/api/building-types')).body as { id: string; scheduledJobs: unknown[] }[];
  assert.deepEqual(types.find((type) => type.id === 'sched-api')!.scheduledJobs, [
    { id: 'weekly', description: 'Review every week', cron: '0 9 * * 1', enabled: true, needsApproval: true },
    { id: 'daily', description: 'Check daily', cron: '@daily' },
  ]);
  assert.deepEqual(types.find((type) => type.id === 'software')!.scheduledJobs, []);
});

test('IA34 the failed-run and turned-off notifications are in GET /api/notifications with their kind, fixed severity and the Building\'s id', async () => {
  const project = await building();
  const job = await createJob(project, { failureThreshold: 1, name: 'Fragile' });
  const ran = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  await settle(ran.body.entry.runId, 'failed', 'The step ended without completing');
  const raised = ((await api(`/api/notifications?projectId=${project.id}`)).body as { kind: string; severity: string; projectId: string; subject: unknown; title: string; description: string }[])
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const subject = { type: 'scheduledJob', projectId: project.id, jobId: job.id };
  assert.deepEqual(raised.map((n) => [n.kind, n.severity, n.projectId, n.subject, n.title]), [
    ['schedule.job_disabled', 'critical', project.id, subject, 'Job turned off: Fragile'],
    ['schedule.run_failed', 'warning', project.id, subject, 'Scheduled run failed: Fragile'],
  ]);
  assert.equal(raised[1]!.description, 'The step ended without completing');
  const posted = await send('POST', '/api/notifications', { kind: 'schedule.run_failed', subject, title: 'x', description: 'y' });
  assert.equal(posted.status < 300, true, 'the new subject type is accepted from outside the daemon too');
});

async function savedCommand(projectId: string, name = 'Build') {
  return collections.projectCommandsDb.insert({ id: randomUUID(), projectId, name, command: 'make', highlighted: false, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' });
}

test('IA30 a command job is created for a saved command of the Building; an unknown or other Building\'s command, or approval, is a 400 naming the field', async () => {
  const project = await building();
  const other = await building();
  const command = await savedCommand(project.id);
  const foreign = await savedCommand(other.id);
  const created = await send('POST', `${base(project)}/jobs`, cronJob({ target: { kind: 'command', commandId: command.id } }));
  assert.deepEqual([created.status, created.body.target], [201, { kind: 'command', commandId: command.id }]);
  for (const commandId of ['ghost', foreign.id]) {
    const res = await send('POST', `${base(project)}/jobs`, cronJob({ target: { kind: 'command', commandId } }));
    assert.deepEqual([res.status, res.body.field], [400, 'target.commandId']);
  }
  const approval = await send('POST', `${base(project)}/jobs`, cronJob({ target: { kind: 'command', commandId: command.id }, needsApproval: true }));
  assert.deepEqual([approval.status, approval.body.field], [400, 'needsApproval']);
});

test('IA31 editing a command job: a new target is checked again, an edit without a target is not even after the command was deleted', async () => {
  const project = await building();
  const command = await savedCommand(project.id);
  const job = await createJob(project, { target: { kind: 'command', commandId: command.id } });
  await collections.projectCommandsDb.delete(command.id);
  const renamed = await send('PATCH', `${base(project)}/jobs/${job.id}`, { name: 'Renamed' });
  assert.deepEqual([renamed.status, renamed.body.target], [200, { kind: 'command', commandId: command.id }]);
  assert.equal((await list(project)).jobs.length, 1);
  const retarget = await send('PATCH', `${base(project)}/jobs/${job.id}`, { target: { kind: 'command', commandId: command.id } });
  assert.deepEqual([retarget.status, retarget.body.field], [400, 'target.commandId']);
  const other = await savedCommand(project.id, 'Test');
  const moved = await send('PATCH', `${base(project)}/jobs/${job.id}`, { target: { kind: 'command', commandId: other.id } });
  assert.deepEqual([moved.status, moved.body.target.commandId], [200, other.id]);
  const toSlot = await send('PATCH', `${base(project)}/jobs/${job.id}`, { target: { kind: 'slot', slotId: 'review', description: 'x' } });
  assert.deepEqual([toSlot.status, toSlot.body.target.kind], [200, 'slot']);
});

test('IA32 Run now on a command job whose command is gone answers 409 with a readable reason', async () => {
  const project = await building();
  const command = await savedCommand(project.id);
  const job = await createJob(project, { target: { kind: 'command', commandId: command.id } });
  runs.failNext = new Error('This command no longer exists');
  const res = await send('POST', `${base(project)}/jobs/${job.id}/run`);
  assert.deepEqual([res.status, res.body], [409, { error: 'This command no longer exists' }]);
});
