import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BuildingTypeDefinition, ScheduledJobDeclaration } from '../src/buildings/contract.ts';
import type { ProjectRecord } from '../src/domain/types.ts';
import type { ExecutorLimits } from '../src/executors/executorLimits.ts';
import type { JobView, Scheduler } from '../src/scheduler/scheduler.ts';
import type { JobHistoryEntry } from '../src/scheduler/types.ts';
import { fakeClock, fakeSources, fakeStarter, gate, usageReading } from './helpers/schedulerFakes.ts';

let tempRoot: string;
let schedulerModule: typeof import('../src/scheduler/scheduler.ts');
let registry: typeof import('../src/buildings/registry.ts');
let collections: typeof import('../src/db/collections.ts');
let notifications: typeof import('../src/notifications/notificationService.ts');

const TYPE_ID = 'sched-test';
const SLOTS = [
  { id: 'review', label: 'Review', usedWhen: 'x', defaultWorkflowId: 'software-development' },
  { id: 'publish', label: 'Publish', usedWhen: 'x', defaultWorkflowId: 'software-development' },
];
const typeDefinition = (patch: Partial<BuildingTypeDefinition> = {}): BuildingTypeDefinition => ({
  id: TYPE_ID, name: 'Scheduled', description: 'A type for scheduler tests.', category: 'Test', version: 1,
  look: { model: 'generic', color: '#fff' }, workspace: 'notes', repository: false,
  validateCreate: () => ({ ok: true, value: { name: 'x' } }),
  slots: SLOTS, agents: [], scheduledJobs: [], capabilities: [], events: [], ...patch,
});

function registerType(patch: Partial<BuildingTypeDefinition> = {}): void {
  registry.unregisterBuildingType(patch.id ?? TYPE_ID);
  registry.registerBuildingType(typeDefinition(patch));
}

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'scheduler-engine-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  schedulerModule = await import('../src/scheduler/scheduler.ts');
  registry = await import('../src/buildings/registry.ts');
  collections = await import('../src/db/collections.ts');
  notifications = await import('../src/notifications/notificationService.ts');
  registerType();
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// Sun 11 Oct 2026 11:20 Asia/Kolkata. The host timezone is UTC unless a test says otherwise.
const START = '2026-10-11T05:50:00.000Z';
const HOUR = 3_600_000;

async function insertBuilding(patch: Partial<ProjectRecord> = {}): Promise<ProjectRecord> {
  const id = randomUUID();
  return collections.projectsDb.insert({
    id, name: `Building ${id.slice(0, 4)}`, slug: `b-${id}`, relativePath: `projects/b-${id}`, status: 'idle', position: null,
    activeTaskId: null, activeTaskIds: [], taskCount: 0, typeId: TYPE_ID, scheduledJobsSeeded: true,
    createdAt: START, updatedAt: START, ...patch,
  });
}

interface WorldOptions {
  building?: Partial<ProjectRecord>;
  started?: boolean;
  getProject?: (id: string) => Promise<ProjectRecord | undefined>;
}

/** One Building with its own clock, sources, run starter and scheduler. `restart()` builds a new scheduler over the same data. */
async function world(t: TestContext, options: WorldOptions = {}) {
  const clock = fakeClock(START);
  const runs = fakeStarter(schedulerModule.NoFreeSlotError);
  const sources = fakeSources();
  const usage: { reading: ExecutorLimits | null; reads: number } = { reading: null, reads: 0 };
  const project = await insertBuilding(options.building);
  const build = (): Scheduler => schedulerModule.createScheduler({
    starter: runs.starter, now: clock.now, setTimer: clock.setTimer, hostTimezone: 'UTC',
    readFiles: sources.readFiles, fetchApi: sources.fetchApi,
    readUsage: async () => { usage.reads += 1; return usage.reading; },
    ...(options.getProject ? { getProject: options.getProject } : {}),
  });
  const w = {
    clock, runs, sources, usage, project,
    scheduler: build(),
    async restart() {
      w.scheduler.stop();
      w.scheduler = build();
      await w.scheduler.start();
    },
    /** Moves the clock to `time` and lets the scheduler look at it once. */
    async at(time: string | number) {
      clock.set(time);
      await w.scheduler.tick();
      await w.scheduler.idle();
    },
    job: (patch: Record<string, unknown> = {}): Promise<JobView> => w.scheduler.createJob(project.id, {
      name: 'Daily review', trigger: { kind: 'cron', cron: '0 9 * * *' }, target: { kind: 'slot', slotId: 'review', description: 'Review it.' }, ...patch,
    }),
    view: async (jobId: string): Promise<JobView> => (await w.scheduler.getSchedules(project.id)).jobs.find((job) => job.id === jobId)!,
    /** Newest first. */
    history: async (jobId: string): Promise<JobHistoryEntry[]> => (await w.scheduler.listHistory(project.id, jobId, { limit: '200' })).entries,
    outcomes: async (jobId: string): Promise<string[]> => (await w.history(jobId)).map((entry) => entry.outcome),
    async settle(runId: string, status: Parameters<typeof runs.settle>[1], note: string | null = null) {
      runs.settle(runId, status, note);
      await w.scheduler.idle();
    },
  };
  if (options.started !== false) await w.scheduler.start();
  t.after(async () => {
    w.scheduler.stop();
    await w.scheduler.idle();
    await w.scheduler.removeBuilding(project.id);
    await collections.projectsDb.delete(project.id);
  });
  return w;
}

const hourly = { trigger: { kind: 'cron', cron: '0 * * * *' } };
const folder = (patch: Record<string, unknown> = {}) => ({ trigger: { kind: 'file', path: 'inbox', detect: 'hash', intervalSeconds: 300, ...patch } });
const endpoint = (patch: Record<string, unknown> = {}) => ({ trigger: { kind: 'api', url: 'https://example.com/pricing.json', intervalSeconds: 900, ...patch } });
const jobNotifications = async (jobId: string) => (await notifications.listNotifications()).filter((n) => n.subject.type === 'scheduledJob' && n.subject.jobId === jobId);

test('IE01 a due cron job starts one run of its slot; history shows it going, then succeeded with a duration and the run id', async (t) => {
  const w = await world(t);
  const job = await w.job();
  await w.at('2026-10-11T09:00:00Z');
  assert.equal(w.runs.starts.length, 1);
  assert.deepEqual(w.runs.starts[0]!.job.target, { kind: 'slot', slotId: 'review', description: 'Review it.' });
  const [going] = await w.history(job.id);
  assert.deepEqual([going!.startedBy, going!.outcome, going!.runId, going!.finishedAt, going!.durationMs, going!.dueAt], ['schedule', 'running', 'run-1', null, null, '2026-10-11T09:00:00.000Z']);
  assert.deepEqual((await w.view(job.id)).activeRun, { entryId: going!.id, runId: 'run-1', outcome: 'running' });

  w.clock.advance(14 * 60_000);
  await w.settle('run-1', 'succeeded');
  const [done] = await w.history(job.id);
  assert.deepEqual([done!.outcome, done!.runId, done!.finishedAt, done!.durationMs], ['succeeded', 'run-1', '2026-10-11T09:14:00.000Z', 14 * 60_000]);
  assert.equal((await w.view(job.id)).activeRun, null);
  assert.equal((await w.history(job.id)).length, 1);
});

test('IE04 not due starts nothing; exactly at the slot starts one; two ticks at the same instant start one', async (t) => {
  const w = await world(t);
  await w.job();
  await w.at('2026-10-11T08:59:59.999Z');
  assert.equal(w.runs.starts.length, 0);
  w.clock.set('2026-10-11T09:00:00.000Z');
  await Promise.all([w.scheduler.tick(), w.scheduler.tick()]);
  assert.equal(w.runs.starts.length, 1);
  await w.at('2026-10-11T09:00:00.000Z');
  assert.equal(w.runs.starts.length, 1);
});

test('IE05 a slow start does not start twice, and the next run is counted from the slot, not from when the start finished', async (t) => {
  const w = await world(t);
  const job = await w.job({ overlap: 'parallel' });
  w.runs.onStart = () => { w.clock.set('2026-10-12T09:00:30Z'); };
  await w.at('2026-10-11T09:00:00Z');
  w.runs.onStart = null;
  assert.equal(w.runs.starts.length, 1);
  assert.equal((await w.view(job.id)).nextRunAt, '2026-10-12T09:00:00.000Z', 'counted from the slot: the start that finished a day late did not push it to the 13th');
  await w.at('2026-10-12T09:00:30Z');
  assert.equal(w.runs.starts.length, 2, 'the next slot, which passed during the slow start, runs once');
  assert.equal((await w.view(job.id)).nextRunAt, '2026-10-13T09:00:00.000Z');
  await w.at('2026-10-12T09:00:31Z');
  assert.equal(w.runs.starts.length, 2);
});

test('IE06 the next-run time is stored and advances after a run; Run now leaves it unchanged', async (t) => {
  const w = await world(t);
  const job = await w.job({ overlap: 'parallel' });
  assert.equal(job.nextRunAt, '2026-10-11T09:00:00.000Z');
  assert.equal((await collections.scheduledJobsDb.get(job.id))!.nextRunAt, '2026-10-11T09:00:00.000Z');
  const result = await w.scheduler.runNow(w.project.id, job.id);
  assert.deepEqual([result.status, result.entry.startedBy, result.entry.outcome, result.job.nextRunAt], ['started', 'run-now', 'running', '2026-10-11T09:00:00.000Z']);
  await w.at('2026-10-11T09:00:00Z');
  assert.equal((await w.view(job.id)).nextRunAt, '2026-10-12T09:00:00.000Z');
  assert.equal(w.runs.starts.length, 2);
});

test('IE07 overlap skip: a slot that comes due while a run is going writes a Skipped entry and starts nothing', async (t) => {
  const w = await world(t);
  const job = await w.job(hourly);
  await w.at('2026-10-11T06:00:00Z');
  await w.at('2026-10-11T07:00:00Z');
  assert.equal(w.runs.starts.length, 1);
  const [skipped, going] = await w.history(job.id);
  assert.deepEqual([skipped!.outcome, skipped!.note, skipped!.runId, skipped!.finishedAt, going!.outcome], ['skipped', 'The previous run is still going', null, '2026-10-11T07:00:00.000Z', 'running']);
});

test('IE08 overlap queue: a slot due while a run is going waits as Queued and starts when the run ends; another due meanwhile is Skipped', async (t) => {
  const w = await world(t);
  const job = await w.job({ ...hourly, overlap: 'queue' });
  await w.at('2026-10-11T06:00:00Z');
  await w.at('2026-10-11T07:00:00Z');
  assert.deepEqual(await w.outcomes(job.id), ['queued', 'running']);
  assert.equal((await w.view(job.id)).queued, true);
  await w.at('2026-10-11T08:00:00Z');
  assert.deepEqual(await w.outcomes(job.id), ['skipped', 'queued', 'running']);
  assert.equal((await w.history(job.id))[0]!.note, 'A run is already waiting to start');
  assert.equal(w.runs.starts.length, 1);

  w.clock.set('2026-10-11T08:10:00Z');
  await w.settle('run-1', 'succeeded');
  assert.equal(w.runs.starts.length, 2);
  const [, queued, first] = await w.history(job.id);
  assert.deepEqual([queued!.outcome, queued!.runId, queued!.startedBy, queued!.runStartedAt, queued!.note, first!.outcome], ['running', 'run-2', 'schedule', '2026-10-11T08:10:00.000Z', null, 'succeeded']);
  assert.equal((await w.view(job.id)).queued, false);
});

test('IE09 overlap parallel: two runs side by side where the Building has room; with room for one the second is Queued until the slot frees', async (t) => {
  const roomy = await world(t);
  const sideBySide = await roomy.job({ ...hourly, overlap: 'parallel' });
  roomy.runs.capacity.set(roomy.project.id, 3);
  await roomy.at('2026-10-11T06:00:00Z');
  await roomy.at('2026-10-11T07:00:00Z');
  assert.deepEqual(await roomy.outcomes(sideBySide.id), ['running', 'running']);

  const single = await world(t);
  const job = await single.job({ ...hourly, overlap: 'parallel' });
  single.runs.capacity.set(single.project.id, 1);
  await single.at('2026-10-11T06:00:00Z');
  await single.at('2026-10-11T07:00:00Z');
  assert.deepEqual(await single.outcomes(job.id), ['queued', 'running']);
  assert.equal((await single.history(job.id))[0]!.note, 'Waiting for a free slot in this Building');
  await single.settle('run-1', 'succeeded');
  assert.deepEqual(await single.outcomes(job.id), ['running', 'succeeded']);
  assert.equal(single.runs.starts.length, 2);
});

test('IE10 many jobs due at once with room for one start in due-time, creation, id order; the rest wait as Queued and each runs once', async (t) => {
  const w = await world(t);
  w.runs.capacity.set(w.project.id, 1);
  const names = ['first', 'second', 'third', 'fourth'];
  const jobs: JobView[] = [];
  for (const name of names) { jobs.push(await w.job({ name })); w.clock.advance(1000); }
  // Created last, but due a minute earlier: it goes before the others.
  jobs.unshift(await w.job({ name: 'earlier', trigger: { kind: 'cron', cron: '59 8 * * *' } }));
  await w.at('2026-10-11T09:00:00Z');
  assert.deepEqual(w.runs.starts.map((s) => s.job.name), ['earlier']);
  for (const job of jobs.slice(1)) assert.deepEqual(await w.outcomes(job.id), ['queued'], job.name);

  for (let i = 1; i <= names.length; i += 1) await w.settle(`run-${i}`, 'succeeded');
  assert.deepEqual(w.runs.starts.map((s) => s.job.name), ['earlier', ...names]);
  await w.settle(`run-${names.length + 1}`, 'succeeded');
  for (const job of jobs) assert.deepEqual(await w.outcomes(job.id), ['succeeded'], `${job.name} ran exactly once`);
  assert.equal(w.runs.starts.length, 5);
});

test('IE11 a manually started task holding the slot makes a due job Queued, not failed', async (t) => {
  const w = await world(t);
  const job = await w.job();
  w.runs.busy.add(w.project.id);
  await w.at('2026-10-11T09:00:00Z');
  assert.deepEqual(await w.outcomes(job.id), ['queued']);
  assert.equal((await w.view(job.id)).consecutiveFailures, 0);
  w.runs.free(w.project.id);
  await w.scheduler.idle();
  assert.deepEqual(await w.outcomes(job.id), ['running']);
  assert.equal((await w.history(job.id))[0]!.dueAt, '2026-10-11T09:00:00.000Z');
});

test('IE12 the daily limit skips with the reason, and the next local day starts again', async (t) => {
  const w = await world(t, { building: { timezone: 'Asia/Kolkata' } });
  const job = await w.job({ ...hourly, maxRunsPerDay: 1, overlap: 'parallel' });
  // 17:30Z is 23:00 in Kolkata; 18:30Z is the next local day's 00:00.
  await w.at('2026-10-11T16:30:00Z');
  await w.at('2026-10-11T17:30:00Z');
  const [skipped] = await w.history(job.id);
  assert.deepEqual([skipped!.outcome, skipped!.note], ['skipped', 'Daily limit of 1 run reached']);
  assert.equal((await w.view(job.id)).runsToday, 1);
  await w.at('2026-10-11T18:30:00Z');
  assert.deepEqual(await w.outcomes(job.id), ['running', 'skipped', 'running']);
  assert.equal(w.runs.starts.length, 2);
});

test('IE13 the usage gate defers a start with the reason and the reset time; at the reset it starts once and the entry gains the run id', async (t) => {
  const w = await world(t);
  const job = await w.job({ maxFiveHourPercent: 80 });
  w.usage.reading = usageReading([90, '2026-10-11T12:00:00Z']);
  await w.at('2026-10-11T09:00:00Z');
  const [deferred] = await w.history(job.id);
  assert.deepEqual([deferred!.outcome, deferred!.deferredUntil, deferred!.runId, deferred!.runStartedAt], ['deferred', '2026-10-11T12:00:00.000Z', null, null]);
  assert.equal(deferred!.note, '5-hour usage is at 90% (limit 80%); starts after the reset');
  assert.equal(w.runs.starts.length, 0);
  assert.equal(w.clock.nextTimerAt(), Date.parse('2026-10-11T09:01:00Z'), 'the scheduler never sleeps more than a minute');

  await w.at('2026-10-11T11:59:59Z');
  assert.equal(w.runs.starts.length, 0);
  await w.at('2026-10-11T12:00:00Z');
  const entries = await w.history(job.id);
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0]!.id, entries[0]!.outcome, entries[0]!.runId, entries[0]!.deferredUntil, entries[0]!.startedBy], [deferred!.id, 'running', 'run-1', null, 'schedule']);
  await w.at('2026-10-11T12:30:00Z');
  assert.equal(w.runs.starts.length, 1);
});

test('IE13 a usage reading still over the limit at the reset keeps the start deferred to the new reset; with no reset time it is skipped', async (t) => {
  const w = await world(t);
  const job = await w.job({ maxWeeklyPercent: 50 });
  w.usage.reading = usageReading(null, [70, '2026-10-11T12:00:00Z']);
  await w.at('2026-10-11T09:00:00Z');
  w.usage.reading = usageReading(null, [75, '2026-10-11T15:00:00Z']);
  await w.at('2026-10-11T12:00:00Z');
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.deferredUntil]), [['deferred', '2026-10-11T15:00:00.000Z']]);
  w.usage.reading = usageReading(null, [75, null]);
  await w.at('2026-10-11T15:00:00Z');
  const [skipped] = await w.history(job.id);
  assert.deepEqual([skipped!.outcome, skipped!.note, skipped!.deferredUntil], ['skipped', 'Weekly usage is at 75% (limit 50%), and the reset time is not known', null]);
  assert.equal(w.runs.starts.length, 0);
});

test('IE14 another slot coming due while a start is deferred still leaves one start at the reset', async (t) => {
  const w = await world(t);
  const job = await w.job({ ...hourly, maxFiveHourPercent: 80 });
  w.usage.reading = usageReading([90, '2026-10-11T08:30:00Z']);
  await w.at('2026-10-11T06:00:00Z');
  await w.at('2026-10-11T07:00:00Z');
  await w.at('2026-10-11T08:00:00Z');
  assert.deepEqual(await w.outcomes(job.id), ['skipped', 'skipped', 'deferred']);
  assert.equal((await w.history(job.id))[0]!.note, 'A start is already waiting for the usage limit to reset');
  await w.at('2026-10-11T08:30:00Z');
  assert.equal(w.runs.starts.length, 1);
  assert.deepEqual(await w.outcomes(job.id), ['skipped', 'skipped', 'running']);
});

test('IE15 with no usage reading the job starts, and a job with no usage limit never asks for one', async (t) => {
  const w = await world(t);
  const gated = await w.job({ maxFiveHourPercent: 80, maxWeeklyPercent: 80 });
  const plain = await w.job({ name: 'Plain' });
  await w.at('2026-10-11T09:00:00Z');
  assert.deepEqual([await w.outcomes(gated.id), await w.outcomes(plain.id)], [['running'], ['running']]);
  assert.equal(w.usage.reads, 1);
});

test('IE21 editing a job while its run is going leaves that run as it started; the next run uses the edit', async (t) => {
  const w = await world(t);
  const job = await w.job({ ...hourly, needsApproval: true, overlap: 'parallel' });
  await w.at('2026-10-11T06:00:00Z');
  const before = (await w.history(job.id))[0]!;
  const edited = await w.scheduler.updateJob(w.project.id, job.id, { needsApproval: false, target: { kind: 'prompt', prompt: 'A new prompt' } });
  assert.deepEqual([edited.needsApproval, edited.target, edited.activeRun?.runId], [false, { kind: 'prompt', agentId: null, prompt: 'A new prompt' }, 'run-1']);
  assert.deepEqual((await w.history(job.id))[0], before, 'the run going and its entry are untouched');
  assert.deepEqual([w.runs.starts[0]!.job.needsApproval, w.runs.starts[0]!.job.target.kind], [true, 'slot']);
  assert.deepEqual(await w.runs.starter.state('run-1'), { status: 'running', note: null });
  await w.at('2026-10-11T07:00:00Z');
  assert.deepEqual([w.runs.starts[1]!.job.needsApproval, w.runs.starts[1]!.job.target], [false, { kind: 'prompt', agentId: null, prompt: 'A new prompt' }]);
});

test('IE22 a failed run writes a failed entry and raises one notification; the count is 1', async (t) => {
  const w = await world(t);
  const job = await w.job();
  await w.at('2026-10-11T09:00:00Z');
  w.clock.advance(60_000);
  await w.settle('run-1', 'failed', 'Review step ended without completing: usage limit reached');
  const [entry] = await w.history(job.id);
  assert.deepEqual([entry!.outcome, entry!.note, entry!.durationMs], ['failed', 'Review step ended without completing: usage limit reached', 60_000]);
  const raised = await jobNotifications(job.id);
  assert.deepEqual(raised.map((n) => [n.kind, n.severity, n.projectId, n.resolvedAt, n.title]), [['schedule.run_failed', 'warning', w.project.id, null, 'Scheduled run failed: Daily review']]);
  assert.deepEqual([(await w.view(job.id)).consecutiveFailures, (await w.view(job.id)).enabled], [1, true]);
  // A later event for a run that already finished changes nothing.
  await w.settle('run-1', 'succeeded');
  assert.equal((await w.history(job.id))[0]!.outcome, 'failed');
  assert.equal((await w.view(job.id)).consecutiveFailures, 1);
});

test('IE23 three failures in a row turn the job off, mark it and notify; switching it on resets the count and recomputes the next run', async (t) => {
  const w = await world(t);
  const job = await w.job(hourly);
  for (const [index, hour] of ['06', '07', '08'].entries()) {
    await w.at(`2026-10-11T${hour}:00:00Z`);
    await w.settle(`run-${index + 1}`, 'failed', 'boom');
  }
  const off = await w.view(job.id);
  assert.deepEqual([off.enabled, off.autoDisabled, off.consecutiveFailures, off.nextRunAt], [false, true, 3, null]);
  const raised = await jobNotifications(job.id);
  assert.deepEqual(raised.map((n) => [n.kind, n.severity]).sort(), [['schedule.job_disabled', 'critical'], ['schedule.run_failed', 'warning']]);
  assert.match(raised.find((n) => n.kind === 'schedule.job_disabled')!.description, /Turned off after 3 failed runs in a row/);
  await w.at('2026-10-11T09:00:00Z');
  await w.at('2026-10-11T10:00:00Z');
  assert.equal(w.runs.starts.length, 3, 'no more starts');

  w.clock.set('2026-10-11T10:20:00Z');
  const on = await w.scheduler.updateJob(w.project.id, job.id, { enabled: true });
  assert.deepEqual([on.enabled, on.autoDisabled, on.consecutiveFailures, on.nextRunAt], [true, false, 0, '2026-10-11T11:00:00.000Z']);
  assert.ok((await jobNotifications(job.id)).every((n) => n.resolvedAt !== null), 'switching it back on resolves its notifications');
  await w.at('2026-10-11T11:00:00Z');
  assert.equal(w.runs.starts.length, 4);
});

test('IE24 a success between failures resets the count; a threshold of 1 turns the job off on the first failure', async (t) => {
  const w = await world(t);
  const job = await w.job(hourly);
  const results = ['failed', 'failed', 'succeeded', 'failed', 'failed'] as const;
  for (const [index, status] of results.entries()) {
    await w.at(`2026-10-11T${String(6 + index).padStart(2, '0')}:00:00Z`);
    await w.settle(`run-${index + 1}`, status);
  }
  assert.deepEqual([(await w.view(job.id)).enabled, (await w.view(job.id)).consecutiveFailures], [true, 2]);
  await w.settle('run-3', 'succeeded');
  assert.ok((await jobNotifications(job.id)).some((n) => n.kind === 'schedule.run_failed'));

  const strict = await w.job({ name: 'Strict', failureThreshold: 1, trigger: { kind: 'cron', cron: '30 11 * * *' } });
  await w.at('2026-10-11T11:30:00Z');
  await w.settle(w.runs.starts.at(-1)!.runId, 'failed');
  assert.deepEqual([(await w.view(strict.id)).enabled, (await w.view(strict.id)).autoDisabled], [false, true]);
});

test('IE24 a run a person stopped is not a failure', async (t) => {
  const w = await world(t);
  const job = await w.job({ ...hourly, failureThreshold: 1 });
  await w.at('2026-10-11T06:00:00Z');
  await w.settle('run-1', 'stopped', 'Stopped by a person');
  assert.deepEqual([(await w.history(job.id))[0]!.outcome, (await w.view(job.id)).enabled, (await w.view(job.id)).consecutiveFailures], ['stopped', true, 0]);
  assert.deepEqual(await jobNotifications(job.id), []);
});

test('IE25 a start that fails during set-up is a failed run with the reason', async (t) => {
  const w = await world(t);
  const job = await w.job();
  w.runs.failNext = new Error('The workflow for "Review" is missing or disabled in the Catalog');
  await w.at('2026-10-11T09:00:00Z');
  const [entry] = await w.history(job.id);
  assert.deepEqual([entry!.outcome, entry!.note, entry!.runId, entry!.finishedAt, entry!.durationMs], ['failed', 'The workflow for "Review" is missing or disabled in the Catalog', null, '2026-10-11T09:00:00.000Z', null]);
  assert.equal((await w.view(job.id)).consecutiveFailures, 1);
  assert.equal((await jobNotifications(job.id)).length, 1);
  assert.equal((await w.view(job.id)).runsToday, 0, 'a start that never began a run does not count toward the day');
});

test('IE26 turning a job off while its run is going lets the run finish and completes its entry; nothing new starts', async (t) => {
  const w = await world(t);
  const job = await w.job({ ...hourly, overlap: 'queue' });
  await w.at('2026-10-11T06:00:00Z');
  await w.at('2026-10-11T07:00:00Z');
  const off = await w.scheduler.updateJob(w.project.id, job.id, { enabled: false });
  assert.deepEqual([off.enabled, off.nextRunAt, off.activeRun?.runId, off.autoDisabled], [false, null, 'run-1', false]);
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.note]), [['skipped', 'The job was switched off'], ['running', null]]);
  assert.deepEqual(await w.runs.starter.state('run-1'), { status: 'running', note: null }, 'the run was not stopped');
  await w.at('2026-10-11T08:00:00Z');
  await w.settle('run-1', 'succeeded');
  assert.deepEqual(await w.outcomes(job.id), ['skipped', 'succeeded']);
  await w.at('2026-10-11T09:00:00Z');
  assert.equal(w.runs.starts.length, 1);
});

test('IE27 deleting a job while its start is under way: the run carries on, and its finishing neither throws nor brings the job back', async (t) => {
  const w = await world(t);
  const job = await w.job();
  const held = gate();
  let reached!: () => void;
  const inStarter = new Promise<void>((resolve) => { reached = resolve; });
  w.runs.onStart = async () => { reached(); await held.opened; };
  w.clock.set('2026-10-11T09:00:00Z');
  const ticking = w.scheduler.tick();
  await inStarter;
  const deleting = w.scheduler.deleteJob(w.project.id, job.id);
  held.open();
  await Promise.all([ticking, deleting]);
  assert.deepEqual(await w.runs.starter.state('run-1'), { status: 'running', note: null });
  assert.deepEqual((await w.scheduler.getSchedules(w.project.id)).jobs, []);
  assert.deepEqual(await collections.jobHistoryDb.find((e) => e.jobId === job.id), []);
  await w.settle('run-1', 'failed', 'late');
  assert.deepEqual((await w.scheduler.getSchedules(w.project.id)).jobs, []);
  assert.equal(await collections.scheduledJobsDb.get(job.id), undefined);
  assert.deepEqual(await jobNotifications(job.id), []);
  await assert.rejects(w.scheduler.listHistory(w.project.id, job.id, {}), { status: 404 });
});

test('IE28 deleting the Building removes its jobs and history; a tick racing the delete starts nothing', async (t) => {
  const held = gate();
  let holding = false;
  let reached!: () => void;
  const inLookup = new Promise<void>((resolve) => { reached = resolve; });
  const w = await world(t, {
    // The tick's Building check: it reads the record, then is held while the Building is deleted.
    getProject: async (id) => {
      const project = await collections.projectsDb.get(id);
      if (holding) { reached(); await held.opened; }
      return project;
    },
  });
  const job = await w.job();
  const poll = await w.job({ name: 'Watch', ...folder() });
  await w.at('2026-10-11T08:00:00Z');
  assert.equal((await w.history(poll.id)).length, 0);

  w.clock.set('2026-10-11T09:00:00Z');
  holding = true;
  const ticking = w.scheduler.tick();
  await inLookup;
  holding = false;
  await collections.projectsDb.delete(w.project.id);
  const removing = w.scheduler.removeBuilding(w.project.id);
  held.open();
  await Promise.all([ticking, removing]);
  await w.scheduler.idle();
  assert.equal(w.runs.starts.length, 0, 'the stale Building record did not start a run');
  assert.deepEqual(await collections.scheduledJobsDb.find((j) => j.projectId === w.project.id), []);
  assert.deepEqual(await collections.jobHistoryDb.find((e) => e.projectId === w.project.id), []);
  assert.equal(await collections.pollBaselinesDb.get(poll.id), undefined);
  await assert.rejects(w.scheduler.getSchedules(w.project.id), /no longer exists|not found/i);
  await assert.rejects(w.scheduler.listHistory(w.project.id, job.id, {}));
  assert.equal(w.clock.nextTimerAt(), w.clock.now() + 60_000, 'no timer is left for the removed jobs, only the idle look at the clock');
});

test('IE28 a Building deleted without the scheduler being told loses its jobs at the next tick', async (t) => {
  const w = await world(t);
  const job = await w.job();
  await collections.projectsDb.delete(w.project.id);
  await w.at('2026-10-11T09:00:00Z');
  assert.equal(w.runs.starts.length, 0);
  assert.equal(await collections.scheduledJobsDb.get(job.id), undefined);
});

test('IE29 a job whose Building type is unavailable does not start and records why, once per slot; it resumes when the type is back', async (t) => {
  const w = await world(t);
  const job = await w.job(hourly);
  t.after(() => registerType());
  registry.unregisterBuildingType(TYPE_ID);
  await w.at('2026-10-11T06:00:00Z');
  await w.at('2026-10-11T06:30:00Z');
  assert.equal(w.runs.starts.length, 0);
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.note]), [['skipped', `The "${TYPE_ID}" Building type is no longer available.`]]);
  await assert.rejects(w.scheduler.runNow(w.project.id, job.id), { status: 409 });
  registerType();
  await w.at('2026-10-11T07:00:00Z');
  assert.deepEqual(await w.outcomes(job.id), ['running', 'skipped']);
});

test('IE30 a job whose slot the type no longer has is refused and recorded with the reason', async (t) => {
  const w = await world(t);
  const job = await w.job({ target: { kind: 'slot', slotId: 'publish', description: 'Publish it.' } });
  t.after(() => registerType());
  registerType({ slots: [SLOTS[0]!] });
  await w.at('2026-10-11T09:00:00Z');
  assert.equal(w.runs.starts.length, 0);
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.note]), [['failed', 'This Building\'s type no longer has the workflow slot "publish"']]);
  assert.equal((await w.view(job.id)).consecutiveFailures, 1);
});

test('IE31 changing the Building\'s timezone recomputes every cron job\'s next run; poll jobs keep their next check', async (t) => {
  const w = await world(t);
  const cron = await w.job();
  const off = await w.job({ name: 'Off', enabled: false });
  const poll = await w.job({ name: 'Watch', ...folder() });
  await w.at('2026-10-11T05:51:00Z');
  const pollNext = (await w.view(poll.id)).nextRunAt;
  assert.equal(pollNext, '2026-10-11T05:56:00.000Z');
  const changed = await w.scheduler.setTimezone(w.project.id, 'Asia/Kolkata');
  assert.deepEqual([changed.timezone, changed.hostTimezone], ['Asia/Kolkata', 'UTC']);
  assert.equal((await w.view(cron.id)).nextRunAt, '2026-10-12T03:30:00.000Z');
  assert.equal((await w.view(off.id)).nextRunAt, null);
  assert.equal((await w.view(poll.id)).nextRunAt, pollNext);
  assert.equal((await w.scheduler.setTimezone(w.project.id, null)).timezone, null);
  assert.equal((await w.view(cron.id)).nextRunAt, '2026-10-11T09:00:00.000Z');
});

test('IE32 editing the cron expression recomputes the next run from now; renaming a poll job does not move its next check', async (t) => {
  const w = await world(t);
  const cron = await w.job();
  const poll = await w.job({ name: 'Watch', ...folder() });
  await w.at('2026-10-11T05:51:00Z');
  w.clock.set('2026-10-11T05:53:00Z');
  assert.equal((await w.scheduler.updateJob(w.project.id, cron.id, { trigger: { kind: 'cron', cron: '30 6 * * *' } })).nextRunAt, '2026-10-11T06:30:00.000Z');
  assert.equal((await w.scheduler.updateJob(w.project.id, cron.id, { name: 'Renamed' })).nextRunAt, '2026-10-11T06:30:00.000Z');
  assert.equal((await w.scheduler.updateJob(w.project.id, poll.id, { name: 'Watch the inbox' })).nextRunAt, '2026-10-11T05:56:00.000Z');
  assert.ok(await collections.pollBaselinesDb.get(poll.id), 'a rename keeps the baseline');
  assert.equal((await w.scheduler.updateJob(w.project.id, poll.id, folder({ path: 'outbox' }))).nextRunAt, '2026-10-11T05:53:00.000Z', 'a new path is checked at once');
  assert.equal(await collections.pollBaselinesDb.get(poll.id), undefined, 'and starts from a fresh baseline');
});

test('IE33 a folder poll: the first check is the baseline and starts nothing; a later change starts a run marked Poll with the change', async (t) => {
  const w = await world(t);
  w.sources.tree = { 'a.md': [1, 'alpha'] };
  const job = await w.job(folder());
  assert.equal(job.nextRunAt, START, 'a watch job takes its baseline at once');
  await w.at(START);
  assert.deepEqual([w.runs.starts.length, (await w.history(job.id)).length], [0, 0]);
  assert.deepEqual(w.sources.fileReads, [{ path: path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, w.project.slug, 'inbox'), detect: 'hash' }], 'a relative path is inside the Building\'s folder');
  assert.equal((await w.view(job.id)).nextRunAt, '2026-10-11T05:55:00.000Z');

  w.sources.tree = { 'a.md': [1, 'alpha!'], 'b.md': [1, 'beta'] };
  await w.at('2026-10-11T05:54:59Z');
  assert.equal(w.sources.fileReads.length, 1, 'not before the interval');
  await w.at('2026-10-11T05:55:00Z');
  const [entry] = await w.history(job.id);
  assert.deepEqual([entry!.startedBy, entry!.outcome, entry!.change, entry!.runId], ['poll', 'running', '1 modified: a.md; 1 added: b.md', 'run-1']);
  const stored = await collections.pollBaselinesDb.get(job.id);
  assert.deepEqual(stored!.baseline, { kind: 'files', files: { 'a.md': 'h:alpha!', 'b.md': 'h:beta' } }, 'signatures are stored, never file content');
});

test('IE33 an absolute watch path is used as it is', async (t) => {
  const w = await world(t);
  await w.job(folder({ path: '/var/data/drop', detect: 'mtime' }));
  await w.at(START);
  assert.deepEqual(w.sources.fileReads, [{ path: '/var/data/drop', detect: 'mtime' }]);
});

test('IE34 a check that finds no change writes no history entry and moves the next check on', async (t) => {
  const w = await world(t);
  w.sources.tree = { 'a.md': [1, 'alpha'] };
  const job = await w.job(folder());
  await w.at(START);
  await w.at('2026-10-11T05:55:00Z');
  await w.at('2026-10-11T06:00:00Z');
  assert.deepEqual([(await w.history(job.id)).length, w.sources.fileReads.length, w.runs.starts.length], [0, 3, 0]);
  assert.equal((await w.view(job.id)).nextRunAt, '2026-10-11T06:05:00.000Z');
});

test('IE35 an API poll: a change in the selected field starts a run, and the entry says what changed', async (t) => {
  const w = await world(t);
  w.sources.response = { status: 200, body: JSON.stringify({ plans: [{ price: 49 }], fetched: 'a' }) };
  const job = await w.job(endpoint({ jsonField: 'plans[0].price' }));
  await w.at(START);
  w.sources.response = { status: 200, body: JSON.stringify({ plans: [{ price: 49 }], fetched: 'b' }) };
  await w.at('2026-10-11T06:05:00Z');
  assert.equal(w.runs.starts.length, 0, 'another field changing is not a change');
  w.sources.response = { status: 200, body: JSON.stringify({ plans: [{ price: 59 }], fetched: 'c' }) };
  await w.at('2026-10-11T06:20:00Z');
  const [entry] = await w.history(job.id);
  assert.deepEqual([entry!.startedBy, entry!.outcome, entry!.change], ['poll', 'running', 'plans[0].price 49 to 59']);
  assert.deepEqual(w.sources.apiCalls, Array(3).fill('https://example.com/pricing.json'));
});

test('IE35 a whole-response poll stores a hash, never the body', async (t) => {
  const w = await world(t);
  w.sources.response = { status: 200, body: 'price list with token=abc123' };
  const job = await w.job(endpoint());
  await w.at(START);
  assert.doesNotMatch(JSON.stringify(await collections.pollBaselinesDb.get(job.id)), /abc123|price list/);
  w.sources.response = { status: 200, body: 'a new price list' };
  await w.at('2026-10-11T06:05:00Z');
  assert.equal((await w.history(job.id))[0]!.change, 'The response changed');
});

test('IE36/UP18 a failing check records the error, starts nothing, retries at the next interval, shows on the job until a good check, and never counts toward turn-off', async (t) => {
  const w = await world(t);
  w.sources.response = { status: 200, body: 'v1' };
  const job = await w.job({ ...endpoint(), failureThreshold: 1 });
  await w.at(START);
  w.sources.response = { status: 503, body: 'down' };
  await w.at('2026-10-11T06:05:00Z');
  const [failed] = await w.history(job.id);
  assert.deepEqual([failed!.startedBy, failed!.outcome, failed!.note, failed!.runId, failed!.finishedAt], ['poll', 'check-failed', 'The address answered 503', null, '2026-10-11T06:05:00.000Z']);
  let view = await w.view(job.id);
  assert.deepEqual([view.pollError, view.nextRunAt, view.enabled, view.consecutiveFailures, w.runs.starts.length], ['The address answered 503', '2026-10-11T06:20:00.000Z', true, 0, 0]);
  assert.deepEqual(await jobNotifications(job.id), []);

  await w.at('2026-10-11T06:20:00Z');
  assert.equal((await w.history(job.id)).length, 1, 'the same error again is not recorded twice');
  w.sources.apiError = new Error('getaddrinfo ENOTFOUND example.com');
  await w.at('2026-10-11T06:35:00Z');
  assert.deepEqual((await w.history(job.id)).map((e) => e.note), ['Could not reach the address: getaddrinfo ENOTFOUND example.com', 'The address answered 503']);

  w.sources.apiError = null;
  w.sources.response = { status: 200, body: 'v1' };
  await w.at('2026-10-11T06:50:00Z');
  view = await w.view(job.id);
  assert.deepEqual([view.pollError, w.runs.starts.length, (await w.history(job.id)).length], [null, 0, 2], 'the old baseline was kept, so the same content is no change');
  w.sources.response = { status: 200, body: 'v2' };
  await w.at('2026-10-11T07:05:00Z');
  assert.equal(w.runs.starts.length, 1);
});

test('IE36/UP11 an unreadable or missing folder is a failed check that keeps the old baseline', async (t) => {
  const w = await world(t);
  w.sources.tree = { 'a.md': [1, 'alpha'] };
  const job = await w.job(folder());
  await w.at(START);
  w.sources.fileError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  await w.at('2026-10-11T05:55:00Z');
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.note]), [['check-failed', 'Could not read inbox: ENOENT: no such file or directory']]);
  assert.equal((await w.view(job.id)).pollError, 'Could not read inbox: ENOENT: no such file or directory');
  w.sources.fileError = null;
  await w.at('2026-10-11T06:00:00Z');
  assert.deepEqual([w.runs.starts.length, (await w.view(job.id)).pollError], [0, null], 'after recovery the same content is no change');
  w.sources.tree = { 'a.md': [1, 'changed'] };
  await w.at('2026-10-11T06:05:00Z');
  assert.equal(w.runs.starts.length, 1, 'and new content is a change');
});

test('IE37 a change found while the overlap rule skips: a Skipped entry records the change and the baseline moves on', async (t) => {
  const w = await world(t);
  w.sources.tree = { 'a.md': [1, 'one'] };
  const job = await w.job(folder());
  await w.at(START);
  w.sources.tree = { 'a.md': [1, 'two'] };
  await w.at('2026-10-11T05:55:00Z');
  w.sources.tree = { 'a.md': [1, 'three'] };
  await w.at('2026-10-11T06:00:00Z');
  const [skipped] = await w.history(job.id);
  assert.deepEqual([skipped!.outcome, skipped!.startedBy, skipped!.note, skipped!.change], ['skipped', 'poll', 'The previous run is still going', '1 modified: a.md']);
  await w.settle('run-1', 'succeeded');
  await w.at('2026-10-11T06:05:00Z');
  assert.deepEqual([w.runs.starts.length, (await w.history(job.id)).length], [1, 2], 'the skipped change does not fire again');
});

test('IE38 a change found with the daily limit reached is Skipped, and the baseline moves on', async (t) => {
  const w = await world(t);
  w.sources.tree = { 'a.md': [1, 'one'] };
  const job = await w.job({ ...folder(), maxRunsPerDay: 1, overlap: 'parallel' });
  await w.at(START);
  w.sources.tree = { 'a.md': [1, 'two'] };
  await w.at('2026-10-11T05:55:00Z');
  w.sources.tree = { 'a.md': [1, 'three'] };
  await w.at('2026-10-11T06:00:00Z');
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.note, e.change]), [['skipped', 'Daily limit of 1 run reached', '1 modified: a.md'], ['running', null, '1 modified: a.md']]);
  await w.at('2026-10-11T06:05:00Z');
  assert.equal((await w.history(job.id)).length, 2);
});

test('IE39 a slow check is read once, and the next check is timed from when it finished', async (t) => {
  const w = await world(t);
  const job = await w.job(endpoint());
  const held = gate();
  let reached!: () => void;
  const inFetch = new Promise<void>((resolve) => { reached = resolve; });
  w.sources.onFetch = async () => { reached(); await held.opened; w.clock.advance(2 * 900_000); };
  const first = w.scheduler.tick();
  await inFetch;
  const second = w.scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.sources.apiCalls.length, 1, 'a second tick while the check is held does not read the source again');
  assert.notEqual(w.clock.nextTimerAt(), w.clock.now(), 'the scheduler does not spin on a job whose check is in flight');
  held.open();
  await Promise.all([first, second]);
  w.sources.onFetch = null;
  assert.equal(w.sources.apiCalls.length, 1);
  // Two intervals passed inside the check. Timed from its end, the next check is one interval later, not overdue.
  assert.equal((await w.view(job.id)).nextRunAt, new Date(Date.parse(START) + 3 * 900_000).toISOString());
  await w.at(Date.parse(START) + 2 * 900_000 + 1);
  assert.equal(w.sources.apiCalls.length, 1, 'just past the interval counted from the start, nothing is read');
  await w.at(Date.parse(START) + 3 * 900_000);
  assert.equal(w.sources.apiCalls.length, 2);
});

test('IE40/UP18 a source that never answers is ended by the check timeout on the injected clock and recorded as Check failed', async (t) => {
  const w = await world(t);
  const job = await w.job(endpoint());
  let reached!: () => void;
  const inFetch = new Promise<void>((resolve) => { reached = resolve; });
  w.sources.onFetch = () => { reached(); return new Promise(() => undefined); };
  const ticking = w.scheduler.tick();
  await inFetch;
  w.clock.advance(29_999);
  w.clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await w.history(job.id)).length, 0);
  w.clock.advance(1);
  w.clock.fire();
  await ticking;
  await w.scheduler.idle();
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.note]), [['check-failed', 'The check did not answer within 30 seconds']]);
  assert.equal((await w.view(job.id)).nextRunAt, new Date(Date.parse(START) + 30_000 + 900_000).toISOString());
  assert.equal(w.runs.starts.length, 0);
});

test('IE40 a folder read that outlives the check timeout is told to stop, and is never joined by a second read', async (t) => {
  const w = await world(t);
  w.sources.tree = { 'a.md': [1, 'one'] };
  const job = await w.job(folder());
  await w.at(START);
  assert.equal(w.sources.fileReads.length, 1);

  // The second read hangs, ignoring its abort signal, as a walk over a huge folder would without one.
  const held = gate();
  let aborted: AbortSignal | null = null;
  let reached!: () => void;
  const inRead = new Promise<void>((resolve) => { reached = resolve; });
  w.sources.onRead = async (signal) => { aborted = signal; reached(); await held.opened; };
  w.clock.set('2026-10-11T05:55:00Z');
  const ticking = w.scheduler.tick();
  await inRead;
  w.clock.advance(30_000);
  w.clock.fire();
  await ticking;
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.note]), [['check-failed', 'The check did not answer within 30 seconds']]);
  assert.equal(aborted!.aborted, true, 'the read was told to stop');
  assert.equal((await w.view(job.id)).nextRunAt, '2026-10-11T06:00:30.000Z');

  w.sources.onRead = null;
  await w.at('2026-10-11T06:00:30Z');
  await w.at('2026-10-11T06:05:30Z');
  assert.equal(w.sources.fileReads.length, 2, 'the job is due twice over, but its first read is still going: no second read is started');
  assert.notEqual(w.clock.nextTimerAt(), w.clock.now(), 'and the scheduler does not spin waiting for it');

  held.open();
  await w.scheduler.idle();
  await new Promise((resolve) => setImmediate(resolve));
  await w.scheduler.idle();
  assert.equal(w.clock.nextTimerAt(), w.clock.now(), 'once the read has ended the overdue check is next');
  w.sources.tree = { 'a.md': [1, 'two'] };
  await w.at('2026-10-11T06:05:31Z');
  assert.equal(w.sources.fileReads.length, 3);
  assert.deepEqual([(await w.view(job.id)).pollError, w.runs.starts.length], [null, 1], 'the late read was dropped: the baseline is still the first one, so the change is seen');
});

test('IE41 a restart over the same data leaves jobs, switches, counts, flags, timezone, history and next-run times unchanged', async (t) => {
  const w = await world(t, { building: { timezone: 'Asia/Kolkata' } });
  const ran = await w.job({ ...hourly, failureThreshold: 2 });
  const off = await w.job({ name: 'Off', enabled: false });
  const watch = await w.job({ name: 'Watch', ...folder() });
  // Hourly slots in Kolkata fall on the half hour in UTC.
  await w.at('2026-10-11T06:30:00Z');
  await w.settle('run-1', 'failed', 'boom');
  await w.at('2026-10-11T07:30:00Z');
  await w.settle('run-2', 'failed', 'boom');
  assert.equal((await w.view(ran.id)).autoDisabled, true);
  w.clock.set('2026-10-11T07:31:00Z');
  const before = { schedules: await w.scheduler.getSchedules(w.project.id), history: [await w.history(ran.id), await w.history(off.id), await w.history(watch.id)] };
  const startsBefore = w.runs.starts.length;
  await w.restart();
  assert.deepEqual({ schedules: await w.scheduler.getSchedules(w.project.id), history: [await w.history(ran.id), await w.history(off.id), await w.history(watch.id)] }, before);
  assert.equal(w.runs.starts.length, startsBefore);
});

test('IE42 a restart after missed cron slots with policy skip writes one Skipped entry and takes the next future slot; a further restart adds nothing', async (t) => {
  const w = await world(t);
  const job = await w.job(hourly);
  w.scheduler.stop();
  w.clock.set('2026-10-11T11:20:00Z');
  await w.restart();
  assert.deepEqual((await w.history(job.id)).map((e) => [e.startedBy, e.outcome, e.note, e.dueAt]), [['schedule', 'skipped', 'Missed while the app was not running', '2026-10-11T11:00:00.000Z']]);
  assert.deepEqual([(await w.view(job.id)).nextRunAt, w.runs.starts.length], ['2026-10-11T12:00:00.000Z', 0]);
  await w.restart();
  w.clock.set('2026-10-11T11:40:00Z');
  await w.restart();
  assert.equal((await w.history(job.id)).length, 1);
});

test('IE43 policy once: one Catch-up run for five missed slots, under the overlap rule and the daily limit', async (t) => {
  const w = await world(t);
  const job = await w.job({ ...hourly, missedPolicy: 'once' });
  const capped = await w.job({ name: 'Capped', ...hourly, missedPolicy: 'once', maxRunsPerDay: 1, overlap: 'parallel' });
  const busy = await w.job({ name: 'Busy', ...hourly, missedPolicy: 'once' });
  await w.at('2026-10-11T06:00:00Z');
  await w.settle(w.runs.starts.find((s) => s.job.id === job.id)!.runId, 'succeeded');
  await w.settle(w.runs.starts.find((s) => s.job.id === capped.id)!.runId, 'succeeded');
  w.scheduler.stop();
  w.clock.set('2026-10-11T11:20:00Z');
  await w.restart();
  const [catchUp] = await w.history(job.id);
  assert.deepEqual([catchUp!.startedBy, catchUp!.outcome, catchUp!.dueAt], ['catch-up', 'running', '2026-10-11T11:00:00.000Z']);
  assert.equal((await w.history(job.id)).length, 2, 'one run for the five missed slots');
  assert.equal((await w.view(job.id)).nextRunAt, '2026-10-11T12:00:00.000Z');
  assert.deepEqual((await w.history(capped.id)).map((e) => [e.startedBy, e.outcome, e.note])[0], ['catch-up', 'skipped', 'Daily limit of 1 run reached']);
  assert.deepEqual((await w.history(busy.id)).map((e) => [e.startedBy, e.outcome, e.note])[0], ['catch-up', 'skipped', 'The previous run is still going']);
  assert.equal((await w.view(job.id)).runsToday, 2, 'a catch-up run counts toward the day');
});

test('IE44 a restart with nothing missed does nothing', async (t) => {
  const w = await world(t);
  const job = await w.job();
  w.clock.set('2026-10-11T08:59:59Z');
  await w.restart();
  assert.deepEqual([(await w.history(job.id)).length, w.runs.starts.length, (await w.view(job.id)).nextRunAt], [0, 0, '2026-10-11T09:00:00.000Z']);
});

test('IE45 a restart while a run was going shows how the run ended, and the job is not left "going"', async (t) => {
  const w = await world(t);
  const job = await w.job(hourly);
  const gone = await w.job({ name: 'Gone', ...hourly });
  await w.at('2026-10-11T06:00:00Z');
  w.scheduler.stop();
  // The existing restart recovery settles the interrupted run while no scheduler is listening.
  const runOf = (jobId: string) => w.runs.starts.find((s) => s.job.id === jobId)!.runId;
  w.runs.states.set(runOf(job.id), { status: 'stopped', note: 'Review step ended without completing (daemon restarted).' });
  w.runs.states.delete(runOf(gone.id));
  w.clock.set('2026-10-11T06:30:00Z');
  await w.restart();
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.note, e.finishedAt]), [['stopped', 'Review step ended without completing (daemon restarted).', '2026-10-11T06:30:00.000Z']]);
  assert.deepEqual((await w.history(gone.id)).map((e) => [e.outcome, e.note, e.runId]), [['stopped', 'The run was deleted', null]]);
  assert.deepEqual([(await w.view(job.id)).activeRun, (await w.view(job.id)).consecutiveFailures], [null, 0]);
  await w.at('2026-10-11T07:00:00Z');
  assert.deepEqual(await w.outcomes(job.id), ['running', 'stopped'], 'the skip rule does not block the job forever');
});

test('IE45 a run deleted while the scheduler is running ends its entry and unblocks the job', async (t) => {
  const w = await world(t);
  const job = await w.job(hourly);
  await w.at('2026-10-11T06:00:00Z');
  w.runs.remove('run-1');
  await w.scheduler.idle();
  assert.deepEqual((await w.history(job.id)).map((e) => [e.outcome, e.runId]), [['stopped', null]]);
  await w.at('2026-10-11T07:00:00Z');
  assert.equal(w.runs.starts.length, 2);
});

test('IE46 queued and deferred starts survive a restart and start once when allowed', async (t) => {
  const w = await world(t);
  w.runs.capacity.set(w.project.id, 1);
  const holder = await w.job({ name: 'Holder', trigger: { kind: 'cron', cron: '0 6 * * *' } });
  const queued = await w.job({ name: 'Queued', trigger: { kind: 'cron', cron: '1 6 * * *' } });
  const deferred = await w.job({ name: 'Deferred', trigger: { kind: 'cron', cron: '2 6 * * *' }, maxFiveHourPercent: 50 });
  await w.at('2026-10-11T06:00:00Z');
  await w.at('2026-10-11T06:01:00Z');
  w.usage.reading = usageReading([60, '2026-10-11T08:00:00Z']);
  await w.at('2026-10-11T06:02:00Z');
  assert.deepEqual([await w.outcomes(holder.id), await w.outcomes(queued.id), await w.outcomes(deferred.id)], [['running'], ['queued'], ['deferred']]);

  w.clock.set('2026-10-11T07:00:00Z');
  await w.restart();
  assert.deepEqual([await w.outcomes(queued.id), await w.outcomes(deferred.id), w.runs.starts.length], [['queued'], ['deferred'], 1]);
  await w.settle('run-1', 'succeeded');
  assert.deepEqual(await w.outcomes(queued.id), ['running']);
  await w.settle('run-2', 'succeeded');
  await w.restart();
  w.usage.reading = usageReading([10, '2026-10-11T13:00:00Z']);
  await w.at('2026-10-11T08:00:00Z');
  assert.deepEqual(await w.outcomes(deferred.id), ['running']);
  await w.at('2026-10-11T08:05:00Z');
  assert.equal(w.runs.starts.length, 3, 'each started exactly once');
});

test('IE47 a poll baseline survives a restart: a change made while off fires at the first check, and no change fires nothing', async (t) => {
  const w = await world(t);
  w.sources.tree = { 'a.md': [1, 'one'] };
  const job = await w.job(folder());
  await w.at(START);
  w.scheduler.stop();
  w.clock.set('2026-10-11T09:00:00Z');
  await w.restart();
  await w.scheduler.idle();
  assert.deepEqual([w.runs.starts.length, (await w.history(job.id)).length, w.sources.fileReads.length], [0, 0, 2], 'no change while off: nothing, and no catch-up entry');

  w.scheduler.stop();
  w.sources.tree = { 'a.md': [1, 'two'] };
  w.clock.set('2026-10-11T12:00:00Z');
  await w.restart();
  await w.scheduler.idle();
  assert.deepEqual((await w.history(job.id)).map((e) => [e.startedBy, e.outcome, e.change]), [['poll', 'running', '1 modified: a.md']]);
});

test('IE48 a job that is off, or was turned off automatically, stays off after a restart with no missed-run handling; a job created after a slot missed nothing', async (t) => {
  const w = await world(t);
  const off = await w.job({ name: 'Off', ...hourly, enabled: false, missedPolicy: 'once' });
  const auto = await w.job({ name: 'Auto', ...hourly, failureThreshold: 1, missedPolicy: 'once' });
  await w.at('2026-10-11T06:00:00Z');
  await w.settle('run-1', 'failed');
  w.clock.set('2026-10-11T09:30:00Z');
  const late = await w.job({ name: 'Late', missedPolicy: 'once' });
  assert.equal(late.nextRunAt, '2026-10-12T09:00:00.000Z');
  w.scheduler.stop();
  w.clock.set('2026-10-11T10:00:00Z');
  await w.restart();
  assert.deepEqual([(await w.history(off.id)).length, (await w.history(auto.id)).length, (await w.history(late.id)).length, w.runs.starts.length], [0, 1, 0, 1]);
  assert.deepEqual([(await w.view(off.id)).enabled, (await w.view(auto.id)).enabled, (await w.view(auto.id)).autoDisabled], [false, false, true]);
});

test('IE49 the clock stepping back starts no second run for a slot already run; a forward jump starts each job at most once', async (t) => {
  const w = await world(t);
  const job = await w.job({ ...hourly, overlap: 'parallel' });
  const other = await w.job({ name: 'Other', trigger: { kind: 'cron', cron: '*/5 * * * *' }, overlap: 'parallel' });
  await w.at('2026-10-11T06:00:00Z');
  assert.equal(w.runs.starts.length, 2);
  await w.at('2026-10-11T05:59:00Z');
  await w.at('2026-10-11T06:00:00Z');
  assert.equal(w.runs.starts.length, 2, 'the 06:00 slot ran once');
  await w.at('2026-10-14T06:30:00Z');
  assert.equal(w.runs.starts.length, 4, 'three days of slots give one start per job');
  assert.deepEqual([(await w.view(job.id)).nextRunAt, (await w.view(other.id)).nextRunAt], ['2026-10-14T07:00:00.000Z', '2026-10-14T06:35:00.000Z']);
});

const DECLARED: ScheduledJobDeclaration[] = [
  { id: 'weekly-review', description: 'Review the notes every week', cron: '0 9 * * 1', enabled: true, name: 'Weekly review' },
  { id: 'daily-check', description: 'Check for changes every day', cron: '@daily', slotId: 'publish', needsApproval: true },
];

test('IE50 a new Building gets its type\'s declared jobs in their declared state; a deleted default does not come back on restart', async (t) => {
  t.after(() => registerType());
  registerType({ scheduledJobs: DECLARED });
  const w = await world(t, { building: { scheduledJobsSeeded: false }, started: false });
  await w.scheduler.seedDefaults(w.project.id);
  const seeded = (await w.scheduler.getSchedules(w.project.id)).jobs;
  assert.deepEqual(seeded.map((j) => [j.declaredJobId, j.name, j.enabled, j.nextRunAt, j.target, j.needsApproval]), [
    ['weekly-review', 'Weekly review', true, '2026-10-12T09:00:00.000Z', { kind: 'slot', slotId: 'review', description: 'Review the notes every week' }, false],
    ['daily-check', 'Check for changes every day', false, null, { kind: 'slot', slotId: 'publish', description: 'Check for changes every day' }, true],
  ]);
  assert.equal((await collections.projectsDb.get(w.project.id))!.scheduledJobsSeeded, true);
  await w.scheduler.seedDefaults(w.project.id);
  assert.equal((await w.scheduler.getSchedules(w.project.id)).jobs.length, 2, 'seeded once');

  await w.scheduler.deleteJob(w.project.id, seeded[0]!.id);
  await w.restart();
  const view = await w.scheduler.getSchedules(w.project.id);
  assert.deepEqual([view.jobs.map((j) => j.declaredJobId), view.missingDefaults], [['daily-check'], 1]);
});

test('IE50 a Building from before the scheduler gets its type\'s declared jobs when the daemon starts', async (t) => {
  t.after(() => registerType());
  registerType({ scheduledJobs: DECLARED });
  const w = await world(t, { building: { scheduledJobsSeeded: undefined }, started: false });
  await w.scheduler.start();
  assert.deepEqual((await w.scheduler.getSchedules(w.project.id)).jobs.map((j) => j.declaredJobId), ['weekly-review', 'daily-check']);
});

test('IE51 restore defaults adds only the missing ones, leaves an edited default alone, and a second call changes nothing', async (t) => {
  t.after(() => registerType());
  registerType({ scheduledJobs: DECLARED });
  const w = await world(t, { building: { scheduledJobsSeeded: false } });
  const [weekly, daily] = (await w.scheduler.getSchedules(w.project.id)).jobs;
  const own = await w.job({ name: 'My own' });
  await w.scheduler.updateJob(w.project.id, daily!.id, { name: 'Edited', enabled: true });
  await w.scheduler.deleteJob(w.project.id, weekly!.id);
  const restored = await w.scheduler.restoreDefaults(w.project.id);
  assert.equal(restored.missingDefaults, 0);
  assert.deepEqual(restored.jobs.map((j) => [j.declaredJobId, j.name, j.enabled]).sort(), [['daily-check', 'Edited', true], ['weekly-review', 'Weekly review', true], [null, 'My own', true]].sort());
  assert.ok(restored.jobs.some((j) => j.id === own.id));
  assert.notEqual(restored.jobs.find((j) => j.declaredJobId === 'weekly-review')!.id, weekly!.id);
  assert.deepEqual((await w.scheduler.restoreDefaults(w.project.id)).jobs.map((j) => j.id), restored.jobs.map((j) => j.id));
});

test('IE52 250 runs leave 200 entries, and an entry still going is kept', async (t) => {
  const w = await world(t);
  const job = await w.job({ overlap: 'parallel' });
  const { entry: first } = await w.scheduler.runNow(w.project.id, job.id);
  for (let i = 2; i <= 250; i += 1) {
    const { entry } = await w.scheduler.runNow(w.project.id, job.id);
    w.clock.advance(1000);
    await w.settle(entry.runId!, 'succeeded');
  }
  const entries = await w.history(job.id);
  assert.equal(entries.length, 200);
  assert.deepEqual([entries.at(-1)!.id, entries.at(-1)!.outcome], [first.id, 'running'], 'the oldest entry is the run still going');
  assert.deepEqual([entries[0]!.seq, entries.at(-2)!.seq], [250, 52]);
  assert.equal((await collections.jobHistoryDb.find((e) => e.jobId === job.id)).length, 200);
});

test('IE53 stopping the scheduler clears its timers and listeners; nothing starts afterwards', async (t) => {
  const w = await world(t);
  await w.job();
  assert.equal(w.clock.pending(), 1);
  assert.equal(w.clock.nextTimerAt(), w.clock.now() + 60_000);
  assert.equal(w.runs.subscribers(), 1);
  w.scheduler.stop();
  assert.deepEqual([w.clock.pending(), w.runs.subscribers()], [0, 0]);
  await w.at('2026-10-11T09:00:00Z');
  assert.deepEqual([w.runs.starts.length, w.clock.pending()], [0, 0]);
});

test('the timer wakes the scheduler at the next due time and runs what is due', async (t) => {
  const w = await world(t);
  const job = await w.job({ trigger: { kind: 'cron', cron: '51 5 * * *' } });
  assert.equal(w.clock.nextTimerAt(), Date.parse('2026-10-11T05:51:00Z'));
  w.clock.set('2026-10-11T05:51:00Z');
  assert.equal(w.clock.fire(), 1);
  await w.scheduler.idle();
  assert.deepEqual(await w.outcomes(job.id), ['running']);
  assert.equal(w.clock.pending(), 1, 'and arms itself again');
});

test('job changes and history entries are announced with the Building id', async (t) => {
  const w = await world(t);
  const events: { type: string; projectId: string }[] = [];
  const unsubscribe = w.scheduler.onEvent((event) => events.push(event));
  const job = await w.job();
  await w.scheduler.idle();
  assert.deepEqual(events.map((e) => [e.type, e.projectId]), [['schedules', w.project.id]]);
  await w.at('2026-10-11T09:00:00Z');
  assert.deepEqual(events.slice(1).map((e) => e.type), ['scheduleEntry', 'schedules']);
  unsubscribe();
  await w.scheduler.deleteJob(w.project.id, job.id);
  assert.equal(events.length, 3);
});

async function insertCommand(projectId: string, name = 'Build'): Promise<{ id: string }> {
  return collections.projectCommandsDb.insert({ id: randomUUID(), projectId, name, command: 'make', highlighted: false, createdAt: START, updatedAt: START });
}

test('IC00 a command job fires on cron and records the command: run id; it ends with the command run\'s outcome', async (t) => {
  const w = await world(t);
  const command = await insertCommand(w.project.id);
  const job = await w.job({ target: { kind: 'command', commandId: command.id } });
  assert.deepEqual(job.target, { kind: 'command', commandId: command.id });
  await w.at('2026-10-11T09:00:00Z');
  assert.deepEqual(w.runs.starts.map((start) => start.job.target), [{ kind: 'command', commandId: command.id }]);
  await w.settle('run-1', 'failed', 'Exited with code 2');
  const [entry] = await w.history(job.id);
  assert.deepEqual([entry!.outcome, entry!.note, entry!.runId], ['failed', 'Exited with code 2', 'run-1']);
  assert.equal((await w.view(job.id)).activeRun, null);
});

test('IC01 a command job is not held back by the Building\'s concurrency cap, and does not count against it', async (t) => {
  const w = await world(t);
  const command = await insertCommand(w.project.id);
  w.runs.capacity.set(w.project.id, 1);
  w.runs.busy.add(w.project.id);
  const slotJob = await w.job({ name: 'Slot' });
  const commandJob = await w.job({ name: 'Command', target: { kind: 'command', commandId: command.id } });
  await w.at('2026-10-11T09:00:00Z');
  assert.deepEqual(await w.outcomes(commandJob.id), ['running']);
  assert.deepEqual(await w.outcomes(slotJob.id), ['queued']);
  assert.equal(w.runs.starts.length, 1, 'only the command job started; the slot job still waits for the cap');
});

test('IC02 a command job is never deferred by the usage gate and does not read the usage', async (t) => {
  const w = await world(t);
  const command = await insertCommand(w.project.id);
  w.usage.reading = usageReading([95, '2026-10-11T12:00:00Z']);
  const job = await w.job({ target: { kind: 'command', commandId: command.id }, maxFiveHourPercent: 50, maxWeeklyPercent: 50 });
  await w.at('2026-10-11T09:00:00Z');
  assert.deepEqual(await w.outcomes(job.id), ['running']);
  assert.equal(w.usage.reads, 0);
});

test('IC03 a command that is already running is recorded as skipped and is not a failure', async (t) => {
  const w = await world(t);
  const command = await insertCommand(w.project.id);
  const job = await w.job({ target: { kind: 'command', commandId: command.id }, failureThreshold: 1 });
  w.runs.failNext = new schedulerModule.SkipStartError('"Build" is already running');
  await w.at('2026-10-11T09:00:00Z');
  const [entry] = await w.history(job.id);
  assert.deepEqual([entry!.outcome, entry!.note, entry!.runId], ['skipped', '"Build" is already running', null]);
  assert.deepEqual([(await w.view(job.id)).consecutiveFailures, (await w.view(job.id)).enabled], [0, true]);
  assert.deepEqual(await jobNotifications(job.id), []);
});

test('IC04 failed command runs reach the failure threshold: the job turns off and notifies', async (t) => {
  const w = await world(t);
  const command = await insertCommand(w.project.id);
  const job = await w.job({ ...hourly, target: { kind: 'command', commandId: command.id }, failureThreshold: 2 });
  await w.at('2026-10-11T06:00:00Z');
  await w.settle('run-1', 'failed', 'Exited with code 1');
  await w.at('2026-10-11T07:00:00Z');
  await w.settle('run-2', 'failed', 'Exited with code 1');
  const view = await w.view(job.id);
  assert.deepEqual([view.enabled, view.autoDisabled, view.consecutiveFailures], [false, true, 2]);
  assert.deepEqual((await jobNotifications(job.id)).map((n) => n.kind).sort(), ['schedule.job_disabled', 'schedule.run_failed']);
});

test('IC05 a start that fails at set-up (a deleted command) is a failed entry with the reason', async (t) => {
  const w = await world(t);
  const command = await insertCommand(w.project.id);
  const job = await w.job({ target: { kind: 'command', commandId: command.id } });
  await collections.projectCommandsDb.delete(command.id);
  w.runs.failNext = new Error('This command no longer exists');
  await w.at('2026-10-11T09:00:00Z');
  const [entry] = await w.history(job.id);
  assert.deepEqual([entry!.outcome, entry!.note], ['failed', 'This command no longer exists']);
  assert.equal((await w.view(job.id)).consecutiveFailures, 1);
});

test('IC06 a command job fires from a poll trigger, and a deleted command does not break listing or renaming the job', async (t) => {
  const w = await world(t);
  const command = await insertCommand(w.project.id);
  const job = await w.job({ ...folder(), target: { kind: 'command', commandId: command.id } });
  w.sources.tree = { 'inbox/a.txt': [1, 'a'] };
  await w.at('2026-10-11T06:00:00Z');
  w.sources.tree = { 'inbox/a.txt': [2, 'b'] };
  await w.at('2026-10-11T06:10:00Z');
  assert.deepEqual(w.runs.starts.map((start) => start.job.id), [job.id]);

  await collections.projectCommandsDb.delete(command.id);
  assert.equal((await w.scheduler.getSchedules(w.project.id)).jobs.length, 1);
  const renamed = await w.scheduler.updateJob(w.project.id, job.id, { name: 'Renamed' });
  assert.deepEqual([renamed.name, renamed.target], ['Renamed', { kind: 'command', commandId: command.id }]);
});

test('IC07 a command job is refused for a command of another Building', async (t) => {
  const w = await world(t);
  const other = await insertBuilding();
  const foreign = await insertCommand(other.id);
  await assert.rejects(w.job({ target: { kind: 'command', commandId: foreign.id } }), { status: 400, field: 'target.commandId' });
  await collections.projectsDb.delete(other.id);
});
