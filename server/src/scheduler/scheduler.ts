import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeProject } from '../buildings/normalize.ts';
import { getBuildingType } from '../buildings/registry.ts';
import { listAgents } from '../catalog/catalogService.ts';
import { listCommands } from '../commands/commandService.ts';
import { jobHistoryDb, pollBaselinesDb, projectsDb, scheduledJobsDb } from '../db/collections.ts';
import type { NotificationSubject, ProjectRecord } from '../domain/types.ts';
import type { ExecutorLimits } from '../executors/executorLimits.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { ProjectNotFoundError, projectAbsolutePath } from '../projects/projectService.ts';
import { hostTimezone as readHostTimezone, isValidTimezone, latestMissedRun, nextRun, parseCron, resolveTimezone, upcomingRuns } from './cron.ts';
import { declaredJobSettings } from './declarations.ts';
import {
  compareDueStarts, dailyLimitReason, decideMissed, decideOverlap, decideUsage, durationMs, entriesToPrune,
  failureCountAfter, reachedFailureThreshold, runsOnDay,
} from './guardrails.ts';
import { validateJob, validateJobPatch } from './jobValidation.ts';
import type { ValidationContext } from './jobValidation.ts';
import { apiReading, comparePoll, filesBaseline } from './pollDetection.ts';
import type { PollReading } from './pollDetection.ts';
import { fetchApiResponse, readWatchedFiles } from './pollSources.ts';
import type { ApiSource, FileSource } from './pollSources.ts';
import { GOING_OUTCOMES, PENDING_OUTCOMES } from './types.ts';
import type { EntryOutcome, JobHistoryEntry, JobSettings, ScheduledJobRecord, StartedBy } from './types.ts';

/**
 * The always-on scheduler: runs every Building's cron jobs and poll triggers, applies their guardrails, and keeps each
 * job's history. It starts runs through a `RunStarter` and never talks to the worker manager itself, so tests drive it
 * with an injected clock, timer, sources and starter. See docs/scheduler.md for the contract.
 */

export type RunStatus = 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'stopped';

export interface RunState {
  status: RunStatus;
  note: string | null;
}

/** The Building has no free concurrency slot: the start waits as queued instead of failing. */
export class NoFreeSlotError extends Error {
  constructor() {
    super('This Building has no free slot');
    this.name = 'NoFreeSlotError';
  }
}

export interface RunStarter {
  /** Starts a run of the job's target. Throws `NoFreeSlotError` at the Building's concurrency cap; any other error is a failed start. */
  start(request: { project: ProjectRecord; job: ScheduledJobRecord; chainDepth?: number }): Promise<{ runId: string }>;
  /** A run's present state, or null when it no longer exists. */
  state(runId: string): Promise<RunState | null>;
  subscribe(listener: RunListener): () => void;
}

export interface RunListener {
  runChanged(runId: string, state: RunState | null): void;
  /** Something in the Building finished, so a queued start may fit now. */
  slotFreed(projectId: string): void;
}

/** The start cannot happen right now for a reason that is not a failure (a conflicting run, a rate limit): the entry is recorded as skipped. */
export class SkipStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipStartError';
  }
}

/** A refused request: 400 for a bad value (with the field), 404 for a missing job, 409 for a state conflict. */
export class ScheduleError extends Error {
  readonly status: number;
  readonly field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.name = 'ScheduleError';
    this.status = status;
    this.field = field;
  }
}

export interface JobView extends ScheduledJobRecord {
  runsToday: number;
  /** The newest run still going, if any. */
  activeRun: { entryId: string; runId: string | null; outcome: EntryOutcome } | null;
  /** A start is waiting for the previous run or a free slot. */
  queued: boolean;
  lastEntry: JobHistoryEntry | null;
}

export interface SchedulesView {
  projectId: string;
  /** The Building's own timezone; null means the host's. */
  timezone: string | null;
  hostTimezone: string;
  jobs: JobView[];
  /** How many of the type's declared jobs this Building no longer has. */
  missingDefaults: number;
}

export type ScheduleEvent =
  | { type: 'schedules'; projectId: string; schedules: SchedulesView }
  | { type: 'scheduleEntry'; projectId: string; jobId: string; entry: JobHistoryEntry };

export interface SchedulerDeps {
  starter: RunStarter;
  now?: () => number;
  /** Calls `fn` once after `delayMs`; returns a cancel function. */
  setTimer?: (fn: () => void, delayMs: number) => () => void;
  hostTimezone?: string;
  readFiles?: FileSource;
  fetchApi?: ApiSource;
  /** The usage reading the usage gate checks; only read for a job that has a usage limit. */
  readUsage?: () => Promise<ExecutorLimits | null>;
  getProject?: (id: string) => Promise<ProjectRecord | undefined>;
  checkTimeoutMs?: number;
}

export const CHECK_TIMEOUT_MS = 30_000;
/** The longest the scheduler sleeps between looks at the clock, so a clock jump or a wake from sleep is noticed. */
const MAX_SLEEP_MS = 60_000;
export const HISTORY_PAGE_SIZE = 50;
export const HISTORY_PAGE_MAX = 200;

const iso = (instant: number): string => new Date(instant).toISOString();
const subjectOf = (job: Pick<ScheduledJobRecord, 'id' | 'projectId'>): NotificationSubject => ({ type: 'scheduledJob', projectId: job.projectId, jobId: job.id });
const isGoing = (entry: JobHistoryEntry): boolean => GOING_OUTCOMES.includes(entry.outcome);
const isPending = (entry: JobHistoryEntry): boolean => PENDING_OUTCOMES.includes(entry.outcome);

function defaultTimer(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export function createScheduler(deps: SchedulerDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  const host = deps.hostTimezone ?? readHostTimezone();
  const readFiles = deps.readFiles ?? readWatchedFiles;
  const fetchApi = deps.fetchApi ?? fetchApiResponse;
  const readUsage = deps.readUsage ?? (async () => null);
  const getProject = deps.getProject ?? ((id: string) => projectsDb.get(id));
  const checkTimeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const { starter } = deps;

  const listeners = new Set<(event: ScheduleEvent) => void>();
  /** Every change to scheduler state runs on this one chain, so a tick, an edit and a run event never interleave. */
  let chain: Promise<unknown> = Promise.resolve();
  /** Buildings whose view changed during the current operation; one `schedules` event each when it ends. */
  const dirty = new Set<string>();
  /** Poll jobs with a check in flight, and the checks themselves. */
  const checking = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  /** Deleted while an operation was in flight: marked at once so a start that is mid-way does not go ahead. */
  const goneJobs = new Set<string>();
  const goneProjects = new Set<string>();
  let running = false;
  let cancelTimer: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(async () => {
      try { return await fn(); } finally { await flush(); }
    });
    chain = result.catch(() => undefined);
    return result;
  }

  function emit(event: ScheduleEvent): void {
    for (const listener of listeners) listener(event);
  }

  async function flush(): Promise<void> {
    for (const projectId of [...dirty]) {
      dirty.delete(projectId);
      const project = goneProjects.has(projectId) ? undefined : await getProject(projectId);
      if (project && listeners.size) emit({ type: 'schedules', projectId, schedules: await buildView(project) });
    }
    await arm();
  }

  /** Sleeps until the next job, check or deferred start is due. */
  async function arm(): Promise<void> {
    cancelTimer?.();
    cancelTimer = null;
    if (!running) return;
    // A job whose check is in flight stays due until the check ends; waking for it would only spin.
    const jobTimes = (await scheduledJobsDb.find((job) => job.enabled && job.nextRunAt !== null && !checking.has(job.id))).map((job) => Date.parse(job.nextRunAt!));
    const deferredTimes = (await jobHistoryDb.find((entry) => entry.outcome === 'deferred' && entry.deferredUntil !== null)).map((entry) => Date.parse(entry.deferredUntil!));
    const wake = Math.min(...jobTimes, ...deferredTimes, now() + MAX_SLEEP_MS);
    cancelTimer = setTimer(() => { void tick().catch((error) => console.error('Scheduler tick failed:', error)); }, Math.min(MAX_SLEEP_MS, Math.max(0, wake - now())));
  }

  // ---- Reads ----

  async function requireProject(projectId: string): Promise<ProjectRecord> {
    const project = goneProjects.has(projectId) ? undefined : await getProject(projectId);
    if (!project) throw new ProjectNotFoundError();
    return project;
  }

  async function requireJob(projectId: string, jobId: string): Promise<ScheduledJobRecord> {
    const job = await scheduledJobsDb.get(jobId);
    if (!job || job.projectId !== projectId) throw new ScheduleError(404, 'This job no longer exists');
    return job;
  }

  const timezoneOf = (project: ProjectRecord): string => resolveTimezone(project.timezone, host);
  const typeOf = (project: ProjectRecord) => getBuildingType(project.typeId ?? 'software');

  async function contextFor(project: ProjectRecord): Promise<ValidationContext> {
    return {
      slotIds: typeOf(project)?.slots.map((slot) => slot.id) ?? [], agentIds: (await listAgents()).map((agent) => agent.id),
      actionIds: typeOf(project)?.scheduledActions?.map((action) => action.id) ?? [],
      commandIds: (await listCommands(project.id)).map((command) => command.id),
    };
  }

  function jobEntries(jobId: string): Promise<JobHistoryEntry[]> {
    return jobHistoryDb.find((entry) => entry.jobId === jobId);
  }

  const byCreation = (a: ScheduledJobRecord, b: ScheduledJobRecord): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

  async function buildView(project: ProjectRecord): Promise<SchedulesView> {
    const jobs = (await scheduledJobsDb.find((job) => job.projectId === project.id)).sort(byCreation);
    const history = await jobHistoryDb.find((entry) => entry.projectId === project.id);
    const declared = typeOf(project)?.scheduledJobs ?? [];
    return {
      projectId: project.id,
      timezone: project.timezone ?? null,
      hostTimezone: host,
      missingDefaults: declared.filter((declaration) => !jobs.some((job) => job.declaredJobId === declaration.id)).length,
      jobs: jobs.map((job) => {
        const entries = history.filter((entry) => entry.jobId === job.id).sort((a, b) => b.seq - a.seq);
        const active = entries.find(isGoing);
        return {
          ...job,
          runsToday: runsOnDay(entries, now(), timezoneOf(project)),
          activeRun: active ? { entryId: active.id, runId: active.runId, outcome: active.outcome } : null,
          queued: entries.some((entry) => entry.outcome === 'queued'),
          lastEntry: entries[0] ?? null,
        };
      }),
    };
  }

  /** When an enabled job next acts, counted from `from`: its next cron slot, or a poll check right away. */
  function firstRunAt(settings: Pick<JobSettings, 'trigger'>, project: ProjectRecord, from: number): string | null {
    if (settings.trigger.kind !== 'cron') return iso(from);
    const parsed = parseCron(settings.trigger.cron);
    const next = parsed.ok ? nextRun(parsed.schedule, from, timezoneOf(project)) : null;
    return next === null ? null : iso(next);
  }

  // ---- History ----

  /** Adds a history entry, or updates `existing` (a queued or deferred start being retried). */
  async function writeEntry(
    job: ScheduledJobRecord,
    existing: JobHistoryEntry | null,
    fields: Pick<JobHistoryEntry, 'startedBy' | 'outcome' | 'dueAt'> & Partial<JobHistoryEntry>,
  ): Promise<JobHistoryEntry | null> {
    if (goneJobs.has(job.id)) return null;
    dirty.add(job.projectId);
    if (existing) {
      const updated = await jobHistoryDb.update(existing.id, fields);
      if (updated) emit({ type: 'scheduleEntry', projectId: job.projectId, jobId: job.id, entry: updated });
      return updated ?? null;
    }
    const entries = await jobEntries(job.id);
    const entry: JobHistoryEntry = {
      id: randomUUID(), jobId: job.id, projectId: job.projectId,
      seq: Math.max(0, ...entries.map((e) => e.seq)) + 1,
      startedAt: iso(now()), finishedAt: null, durationMs: null,
      note: null, change: null, runId: null, runStartedAt: null, deferredUntil: null,
      ...fields,
    };
    await jobHistoryDb.insert(entry);
    for (const id of entriesToPrune([...entries, entry])) await jobHistoryDb.delete(id);
    emit({ type: 'scheduleEntry', projectId: job.projectId, jobId: job.id, entry });
    return entry;
  }

  async function patchJob(job: ScheduledJobRecord, patch: Partial<ScheduledJobRecord>): Promise<ScheduledJobRecord | undefined> {
    dirty.add(job.projectId);
    return scheduledJobsDb.update(job.id, { ...patch, updatedAt: iso(now()) });
  }

  /** Ends the starts of a job that have not begun, when the job is switched off. A Run now the person asked for still starts. */
  async function cancelPendingStarts(job: ScheduledJobRecord, reason: string): Promise<void> {
    const at = iso(now());
    for (const entry of (await jobEntries(job.id)).filter((e) => isPending(e) && e.startedBy !== 'run-now')) {
      await writeEntry(job, entry, { startedBy: entry.startedBy, dueAt: entry.dueAt, outcome: 'skipped', note: reason, finishedAt: at, deferredUntil: null });
    }
  }

  // ---- Starting a run ----

  interface StartOptions {
    change?: string | null;
    /** The queued or deferred entry this attempt continues. */
    existing?: JobHistoryEntry | null;
    /** Run now ignores the daily limit and the usage gate. */
    ignoreBudgets?: boolean;
    /** How deep the chain of calls and events that led to this start is; 0 when a person or the clock started it. */
    chainDepth?: number;
  }

  /**
   * Applies the guardrails to one start and records what happened: skipped, queued, deferred, failed at set-up, or a
   * run going. The overlap rule is checked first, then the daily limit, then the usage gate.
   */
  async function attemptStart(job: ScheduledJobRecord, project: ProjectRecord, startedBy: StartedBy, dueAt: string, options: StartOptions = {}): Promise<JobHistoryEntry | null> {
    const existing = options.existing ?? null;
    const base = { startedBy, dueAt, change: options.change ?? existing?.change ?? null };
    const at = iso(now());
    const skip = (note: string) => writeEntry(job, existing, { ...base, outcome: 'skipped', note, finishedAt: at, deferredUntil: null });
    const hold = async (outcome: 'queued' | 'deferred', note: string, deferredUntil: string | null = null) =>
      (existing?.outcome === outcome && existing.note === note && existing.deferredUntil === deferredUntil ? existing : writeEntry(job, existing, { ...base, outcome, note, deferredUntil }));

    const view = normalizeProject(project);
    if (view.readOnly) return skip(view.readOnlyReason!);

    const others = (await jobEntries(job.id)).filter((entry) => entry.id !== existing?.id);
    const overlap = decideOverlap(job.overlap, { going: others.filter(isGoing).length, queued: others.filter((entry) => entry.outcome === 'queued').length });
    if (overlap.action === 'skip') return skip(overlap.reason);
    if (overlap.action === 'queue') return hold('queued', 'Waiting for the previous run to finish');

    if (!options.ignoreBudgets) {
      const daily = dailyLimitReason(job.maxRunsPerDay, runsOnDay(others, now(), timezoneOf(project)));
      if (daily) return skip(daily);
      // A command run uses no agent, so there is no agent usage to wait for.
      if (job.target.kind !== 'command' && (job.maxFiveHourPercent !== null || job.maxWeeklyPercent !== null)) {
        const usage = decideUsage(job, await readUsage(), now());
        if (usage.action === 'skip') return skip(usage.reason);
        if (usage.action === 'defer') {
          if (others.some((entry) => entry.outcome === 'deferred')) return skip('A start is already waiting for the usage limit to reset');
          return hold('deferred', `${usage.reason}; starts after the reset`, iso(usage.until));
        }
      }
    }

    const failStart = async (reason: string) => {
      const failed = await writeEntry(job, existing, { ...base, outcome: 'failed', note: reason, finishedAt: iso(now()), deferredUntil: null });
      await afterRunSettled(job.id, 'failed', reason);
      return failed;
    };
    const { target } = job;
    if (target.kind === 'slot' && !typeOf(project)?.slots.some((slot) => slot.id === target.slotId)) {
      return failStart(`This Building's type no longer has the workflow slot "${target.slotId}"`);
    }
    if (target.kind === 'action' && !typeOf(project)?.scheduledActions?.some((action) => action.id === target.actionId)) {
      return failStart(`This Building's type no longer has the action "${target.actionId}"`);
    }
    if (goneJobs.has(job.id) || goneProjects.has(project.id)) return null;
    let runId: string;
    try {
      ({ runId } = await starter.start({ project, job, chainDepth: options.chainDepth }));
    } catch (error) {
      if (error instanceof NoFreeSlotError) return hold('queued', 'Waiting for a free slot in this Building');
      if (error instanceof SkipStartError) return skip(error.message);
      return failStart((error as Error).message);
    }
    return writeEntry(job, existing, { ...base, outcome: 'running', note: null, runId, runStartedAt: iso(now()), deferredUntil: null });
  }

  /** Counts the outcome toward the job's failure streak, notifies, and turns the job off at its threshold. */
  async function afterRunSettled(jobId: string, outcome: EntryOutcome, note: string | null): Promise<void> {
    const job = await scheduledJobsDb.get(jobId);
    if (!job || goneJobs.has(jobId)) return;
    const subject = subjectOf(job);
    const failures = failureCountAfter(job.consecutiveFailures, outcome);
    if (outcome === 'succeeded') await resolveNotifications(subject, ['schedule.run_failed']);
    if (outcome === 'failed') {
      await raiseNotification({ kind: 'schedule.run_failed', subject, title: `Scheduled run failed: ${job.name}`, description: note ?? 'The run failed.' });
    }
    if (outcome === 'failed' && job.enabled && reachedFailureThreshold(failures, job.failureThreshold)) {
      const disabled = await patchJob(job, { consecutiveFailures: failures, enabled: false, autoDisabled: true, nextRunAt: null });
      if (disabled) await cancelPendingStarts(disabled, 'The job was turned off after repeated failures');
      await raiseNotification({
        kind: 'schedule.job_disabled', subject,
        title: `Job turned off: ${job.name}`,
        description: `Turned off after ${failures} failed run${failures === 1 ? '' : 's'} in a row. Switch it back on in Schedules once the cause is fixed.`,
      });
      return;
    }
    if (failures !== job.consecutiveFailures) await patchJob(job, { consecutiveFailures: failures });
  }

  async function applyRunState(runId: string, state: RunState | null): Promise<void> {
    const entry = (await jobHistoryDb.find((e) => e.runId === runId))[0];
    if (!entry || entry.finishedAt !== null) return;
    const job = await scheduledJobsDb.get(entry.jobId);
    if (!job) return;
    const base = { startedBy: entry.startedBy, dueAt: entry.dueAt };
    if (state === null) {
      const finishedAt = iso(now());
      await writeEntry(job, entry, { ...base, outcome: 'stopped', note: 'The run was deleted', runId: null, finishedAt, durationMs: durationMs(entry.runStartedAt, finishedAt) });
      return;
    }
    if (state.status === 'running' || state.status === 'awaiting-approval') {
      if (entry.outcome !== state.status || entry.note !== state.note) await writeEntry(job, entry, { ...base, outcome: state.status, note: state.note });
      return;
    }
    const finishedAt = iso(now());
    await writeEntry(job, entry, { ...base, outcome: state.status, note: state.note, finishedAt, durationMs: durationMs(entry.runStartedAt, finishedAt) });
    await afterRunSettled(job.id, state.status, state.note);
  }

  /** Retries every queued start and every deferred start whose time has come, oldest due first. */
  async function drainPending(): Promise<void> {
    const t = now();
    const jobs = new Map((await scheduledJobsDb.all()).map((job) => [job.id, job]));
    const waiting = (await jobHistoryDb.find((entry) => entry.outcome === 'queued' || (entry.outcome === 'deferred' && Date.parse(entry.deferredUntil ?? '') <= t)))
      .flatMap((entry) => (jobs.has(entry.jobId) ? [{ entry, dueAt: entry.dueAt, job: jobs.get(entry.jobId)! }] : []))
      .sort(compareDueStarts);
    for (const { entry, job } of waiting) {
      const project = await getProject(job.projectId);
      if (!project) continue;
      await attemptStart(job, project, entry.startedBy, entry.dueAt, { existing: entry, ignoreBudgets: entry.startedBy === 'run-now' });
    }
  }

  // ---- Cron ----

  async function fireCronJob(job: ScheduledJobRecord, project: ProjectRecord, t: number): Promise<void> {
    const slot = job.nextRunAt!;
    // The next slot is fixed before the run starts, so a slow start neither delays it nor runs this slot twice.
    const advanced = await patchJob(job, { nextRunAt: firstRunAt(job, project, t) });
    if (advanced) await attemptStart(advanced, project, 'schedule', slot);
  }

  /** Applied once per job when the daemon starts: a cron slot that passed while it was off is skipped or caught up with one run. */
  async function applyMissedPolicy(job: ScheduledJobRecord, project: ProjectRecord, t: number): Promise<void> {
    const parsed = parseCron(job.trigger.kind === 'cron' ? job.trigger.cron : '');
    if (!parsed.ok || job.nextRunAt === null) return;
    const firstMissed = Date.parse(job.nextRunAt);
    const missed = firstMissed <= t ? latestMissedRun(parsed.schedule, firstMissed - 1, t, timezoneOf(project)) ?? firstMissed : null;
    const decision = decideMissed(job.missedPolicy, missed);
    if (decision.action === 'none') return;
    const advanced = await patchJob(job, { nextRunAt: firstRunAt(job, project, t) });
    if (!advanced) return;
    if (decision.action === 'catch-up') { await attemptStart(advanced, project, 'catch-up', iso(missed!)); return; }
    await writeEntry(advanced, null, { startedBy: 'schedule', dueAt: iso(missed!), outcome: 'skipped', note: 'Missed while the app was not running', finishedAt: iso(t) });
  }

  // ---- Poll triggers ----

  async function readSource(job: ScheduledJobRecord, project: ProjectRecord, signal: AbortSignal): Promise<PollReading> {
    const { trigger } = job;
    if (trigger.kind === 'file') {
      try {
        // A relative path is inside the Building's folder; an absolute one is used as it is.
        return { ok: true, baseline: filesBaseline(await readFiles(path.resolve(projectAbsolutePath(project), trigger.path), trigger.detect, signal), trigger.detect) };
      } catch (error) {
        return { ok: false, error: `Could not read ${trigger.path}: ${(error as Error).message}` };
      }
    }
    if (trigger.kind === 'api') {
      try {
        return apiReading(await fetchApi(trigger.url, signal), trigger.jsonField);
      } catch (error) {
        return { ok: false, error: `Could not reach the address: ${(error as Error).message}` };
      }
    }
    return { ok: false, error: 'This job has no poll trigger' };
  }

  /**
   * One read of the job's source. `reading` answers when the source does or when the timeout passes, whichever is
   * first; `settled` resolves only when the read itself has ended. On a timeout the read is told to stop through its
   * abort signal.
   */
  function readWithTimeout(job: ScheduledJobRecord, project: ProjectRecord): { reading: Promise<PollReading>; settled: Promise<void> } {
    const abort = new AbortController();
    const read = readSource(job, project, abort.signal);
    const reading = new Promise<PollReading>((resolve) => {
      const cancel = setTimer(() => {
        abort.abort();
        resolve({ ok: false, error: `The check did not answer within ${Math.round(checkTimeoutMs / 1000)} seconds` });
      }, checkTimeoutMs);
      void read.then((result) => { cancel(); resolve(result); });
    });
    return { reading, settled: read.then(() => undefined) };
  }

  /**
   * Reads the source outside the chain (it can be slow), then applies the reading on it. One read per job at a time:
   * the job stays marked as checking until its read has really ended, so a read that outlives the timeout is never
   * joined by a second one.
   */
  function launchCheck(job: ScheduledJobRecord, project: ProjectRecord): void {
    checking.add(job.id);
    const triggerKey = JSON.stringify(job.trigger);
    const { reading, settled } = readWithTimeout(job, project);
    void settled.then(() => {
      checking.delete(job.id);
      // The job may have come due while its read was still going.
      void run(async () => undefined).catch(logError);
    });
    const work: Promise<void> = reading
      .then((result) => run(() => applyReading(job.id, triggerKey, result)))
      .catch((error) => console.error(`Scheduler check for job ${job.id} failed:`, error))
      .finally(() => { inFlight.delete(work); });
    inFlight.add(work);
  }

  async function applyReading(jobId: string, triggerKey: string, reading: PollReading): Promise<void> {
    const job = await scheduledJobsDb.get(jobId);
    // Edited, switched off or deleted while the check ran: the reading no longer answers this job.
    if (!job || !job.enabled || job.trigger.kind === 'cron' || JSON.stringify(job.trigger) !== triggerKey) return;
    const project = await getProject(job.projectId);
    if (!project) return;
    const t = now();
    // The next check is timed from when this one finished, so a slow source is never read back to back.
    const nextRunAt = iso(t + job.trigger.intervalSeconds * 1000);
    if (!reading.ok) {
      // A source that stays down is recorded once, not once per interval.
      if (job.pollError !== reading.error) await writeEntry(job, null, { startedBy: 'poll', dueAt: iso(t), outcome: 'check-failed', note: reading.error, finishedAt: iso(t) });
      await patchJob(job, { pollError: reading.error, nextRunAt });
      return;
    }
    const stored = await pollBaselinesDb.get(job.id);
    const record = { id: job.id, triggerKey, baseline: reading.baseline };
    if (stored) await pollBaselinesDb.update(job.id, record); else await pollBaselinesDb.insert(record);
    const checked = await patchJob(job, { pollError: null, nextRunAt });
    // The first reading is the baseline. The baseline moves on even when a guardrail then skips the start.
    if (!checked || stored?.triggerKey !== triggerKey) return;
    const label = job.trigger.kind === 'api' ? job.trigger.jsonField ?? 'The response' : undefined;
    const comparison = comparePoll(stored.baseline, reading.baseline, label);
    if (comparison.changed) await attemptStart(checked, project, 'poll', iso(t), { change: comparison.summary });
  }

  // ---- The tick ----

  async function processDue(): Promise<void> {
    if (!running) return;
    await drainPending();
    const t = now();
    const due = (await scheduledJobsDb.find((job) => job.enabled && job.nextRunAt !== null && Date.parse(job.nextRunAt) <= t))
      .map((job) => ({ job, dueAt: job.nextRunAt! }))
      .sort(compareDueStarts);
    for (const { job } of due) {
      if (goneJobs.has(job.id) || goneProjects.has(job.projectId)) continue;
      const project = await getProject(job.projectId);
      if (goneProjects.has(job.projectId)) continue;
      // The Building was deleted without the scheduler being told: its jobs go with it.
      if (!project) { await removeJobData(job); continue; }
      if (job.trigger.kind === 'cron') await fireCronJob(job, project, t);
      else if (!checking.has(job.id)) launchCheck(job, project);
    }
  }

  /** Looks at the clock once: starts what is due and waits for the checks that began. */
  async function tick(): Promise<void> {
    await run(processDue);
    await Promise.all([...inFlight]);
  }

  /** Resolves once nothing is in flight: queued operations and poll checks. */
  async function idle(): Promise<void> {
    for (;;) {
      await chain;
      if (!inFlight.size) return;
      await Promise.all([...inFlight]);
    }
  }

  // ---- Lifecycle ----

  async function seedBuilding(project: ProjectRecord): Promise<void> {
    const type = typeOf(project);
    if (project.scheduledJobsSeeded || !type) return;
    await addDeclaredJobs(project, type.scheduledJobs.map((declaration) => declaration.id));
    await projectsDb.update(project.id, { scheduledJobsSeeded: true });
  }

  async function addDeclaredJobs(project: ProjectRecord, declarationIds: string[]): Promise<void> {
    const type = typeOf(project);
    const declarations = type?.scheduledJobs.filter((d) => declarationIds.includes(d.id)) ?? [];
    for (const [order, declaration] of declarations.entries()) {
      const settings = declaredJobSettings(declaration, type!.slots);
      // Jobs are listed by creation time, so each one is stamped a millisecond after the last to keep the declared order.
      if (settings.ok) await insertJob(project, settings.value, declaration.id, order);
    }
  }

  async function insertJob(project: ProjectRecord, settings: JobSettings, declaredJobId: string | null, createdOffsetMs = 0): Promise<ScheduledJobRecord> {
    const at = iso(now() + createdOffsetMs);
    const job: ScheduledJobRecord = {
      ...settings,
      id: randomUUID(), projectId: project.id, declaredJobId,
      consecutiveFailures: 0, autoDisabled: false,
      nextRunAt: settings.enabled ? firstRunAt(settings, project, now()) : null,
      pollError: null, createdAt: at, updatedAt: at,
    };
    dirty.add(project.id);
    return scheduledJobsDb.insert(job);
  }

  /**
   * Called once when the daemon starts, after interrupted runs were settled. Gives each Building its type's default
   * jobs, brings history entries of runs that ended while the daemon was off up to date, applies the missed-run
   * policy, and starts the clock.
   */
  function start(): Promise<void> {
    running = true;
    unsubscribe ??= starter.subscribe({
      runChanged: (runId, state) => { void run(async () => { await applyRunState(runId, state); await drainPending(); }).catch(logError); },
      slotFreed: () => { void run(drainPending).catch(logError); },
    });
    return run(async () => {
      for (const project of await projectsDb.all()) await seedBuilding(project);
      for (const entry of await jobHistoryDb.find(isGoing)) {
        if (entry.runId) await applyRunState(entry.runId, await starter.state(entry.runId));
      }
      const t = now();
      for (const job of (await scheduledJobsDb.find((j) => j.enabled && j.trigger.kind === 'cron')).sort(byCreation)) {
        const project = await getProject(job.projectId);
        if (project) await applyMissedPolicy(job, project, t);
      }
      await processDue();
    });
  }

  function stop(): void {
    running = false;
    cancelTimer?.();
    cancelTimer = null;
    unsubscribe?.();
    unsubscribe = null;
  }

  const logError = (error: unknown): void => console.error('Scheduler failed to handle a run event:', error);

  // ---- The API's operations ----

  function getSchedules(projectId: string): Promise<SchedulesView> {
    return run(async () => {
      const project = await requireProject(projectId);
      await seedBuilding(project);
      return buildView(project);
    });
  }

  /** Copies the type's default jobs to a Building that has just been created. */
  function seedDefaults(projectId: string): Promise<void> {
    return run(async () => seedBuilding(await requireProject(projectId)));
  }

  function setTimezone(projectId: string, timezone: unknown): Promise<SchedulesView> {
    return run(async () => {
      const project = await requireProject(projectId);
      if (timezone !== null && !isValidTimezone(timezone)) throw new ScheduleError(400, 'timezone must be an IANA timezone name such as Asia/Kolkata, or null for this computer\'s', 'timezone');
      const updated = (await projectsDb.update(project.id, { timezone: timezone as string | null, updatedAt: iso(now()) }))!;
      for (const job of await scheduledJobsDb.find((j) => j.projectId === project.id && j.enabled && j.trigger.kind === 'cron')) {
        await patchJob(job, { nextRunAt: firstRunAt(job, updated, now()) });
      }
      dirty.add(project.id);
      return buildView(updated);
    });
  }

  function createJob(projectId: string, body: unknown): Promise<JobView> {
    return run(async () => {
      const project = await requireProject(projectId);
      const settings = validateJob(body, await contextFor(project));
      if (!settings.ok) throw new ScheduleError(400, settings.error, settings.field);
      return viewOf(project, await insertJob(project, settings.value, null));
    });
  }

  async function viewOf(project: ProjectRecord, job: ScheduledJobRecord): Promise<JobView> {
    return (await buildView(project)).jobs.find((view) => view.id === job.id)!;
  }

  function updateJob(projectId: string, jobId: string, body: unknown): Promise<JobView> {
    return run(async () => {
      const project = await requireProject(projectId);
      const job = await requireJob(projectId, jobId);
      const settings = validateJobPatch(job, body, await contextFor(project));
      if (!settings.ok) throw new ScheduleError(400, settings.error, settings.field);
      const next = settings.value;
      const triggerChanged = JSON.stringify(job.trigger) !== JSON.stringify(next.trigger);
      const turnedOn = !job.enabled && next.enabled;
      const patch: Partial<ScheduledJobRecord> = { ...next };
      if (!next.enabled) patch.nextRunAt = null;
      // Switching on or changing the trigger starts the schedule again from now; a poll job also takes a fresh baseline.
      else if (turnedOn || triggerChanged) {
        patch.nextRunAt = firstRunAt(next, project, now());
        patch.pollError = null;
        await pollBaselinesDb.delete(job.id);
      }
      if (turnedOn) {
        Object.assign(patch, { consecutiveFailures: 0, autoDisabled: false });
        await resolveNotifications(subjectOf(job));
      }
      const updated = (await patchJob(job, patch))!;
      if (job.enabled && !next.enabled) await cancelPendingStarts(updated, 'The job was switched off');
      return viewOf(project, updated);
    });
  }

  /** Removes the job and its history. A run that is going carries on; it is no longer tracked. */
  function deleteJob(projectId: string, jobId: string): Promise<void> {
    return run(async () => {
      await requireProject(projectId);
      const job = await requireJob(projectId, jobId);
      goneJobs.add(job.id);
      await removeJobData(job);
      dirty.add(projectId);
    });
  }

  async function removeJobData(job: ScheduledJobRecord): Promise<void> {
    await scheduledJobsDb.delete(job.id);
    await pollBaselinesDb.delete(job.id);
    await resolveNotifications(subjectOf(job));
    for (const entry of await jobEntries(job.id)) await jobHistoryDb.delete(entry.id);
  }

  /** Drops everything the scheduler holds for a deleted Building. Marked at once, so a start already under way is abandoned. */
  function removeBuilding(projectId: string): Promise<void> {
    goneProjects.add(projectId);
    return run(async () => {
      for (const job of await scheduledJobsDb.find((j) => j.projectId === projectId)) {
        goneJobs.add(job.id);
        await removeJobData(job);
      }
    });
  }

  /**
   * Starts the job now without moving its schedule. The overlap rule can refuse it (409); the daily limit and the
   * usage gate are ignored, and the run still counts toward today's runs. Works on a job that is switched off. A start
   * that fails at set-up (its slot, workflow or agent is gone) is also a 409 carrying the reason; its failed entry
   * stays in the history and counts as a failed run.
   */
  function runNow(projectId: string, jobId: string): Promise<{ status: 'started' | 'queued'; entry: JobHistoryEntry; job: JobView }> {
    return run(async () => {
      const project = await requireProject(projectId);
      const job = await requireJob(projectId, jobId);
      const view = normalizeProject(project);
      if (view.readOnly) throw new ScheduleError(409, view.readOnlyReason!);
      const entries = await jobEntries(job.id);
      const overlap = decideOverlap(job.overlap, { going: entries.filter(isGoing).length, queued: entries.filter((entry) => entry.outcome === 'queued').length });
      if (overlap.action === 'skip') throw new ScheduleError(409, `${overlap.reason} (overlap rule: ${job.overlap})`);
      const entry = await attemptStart(job, project, 'run-now', iso(now()), { ignoreBudgets: true });
      if (!entry) throw new ScheduleError(404, 'This job no longer exists');
      if (entry.outcome === 'failed') throw new ScheduleError(409, entry.note ?? 'The run could not be started');
      return { status: entry.outcome === 'queued' ? 'queued' : 'started', entry, job: await viewOf(project, (await scheduledJobsDb.get(job.id)) ?? job) };
    });
  }

  /**
   * Starts a job because an event it subscribed to happened. The delivery id is kept on the entry, so a retry after a
   * crash can tell the job already started. Answers like Run now, except the usage and daily limits still apply.
   */
  function runForEvent(projectId: string, jobId: string, event: { deliveryId: string; label: string; depth: number }): Promise<{ status: 'started' | 'queued' | 'skipped' | 'failed'; entry: JobHistoryEntry }> {
    return run(async () => {
      const project = await requireProject(projectId);
      const job = await requireJob(projectId, jobId);
      const view = normalizeProject(project);
      if (view.readOnly) throw new ScheduleError(409, view.readOnlyReason!);
      const entry = await attemptStart(job, project, 'event', iso(now()), { change: `event:${event.deliveryId} ${event.label}`, chainDepth: event.depth });
      if (!entry) throw new ScheduleError(404, 'This job no longer exists');
      return { status: entry.outcome === 'queued' || entry.outcome === 'skipped' || entry.outcome === 'failed' ? entry.outcome : 'started', entry };
    });
  }

  async function listHistory(projectId: string, jobId: string, query: { cursor?: unknown; limit?: unknown }): Promise<{ entries: JobHistoryEntry[]; nextCursor: string | null }> {
    await requireProject(projectId);
    await requireJob(projectId, jobId);
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || !/^[1-9]\d{0,15}$/.test(query.cursor))) throw new ScheduleError(400, 'cursor is not valid', 'cursor');
    if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d{0,5}$/.test(query.limit))) throw new ScheduleError(400, 'limit must be a whole number above 0', 'limit');
    const limit = Math.min(HISTORY_PAGE_MAX, query.limit === undefined ? HISTORY_PAGE_SIZE : Number(query.limit));
    const before = query.cursor === undefined ? Infinity : Number(query.cursor);
    const older = (await jobEntries(jobId)).filter((entry) => entry.seq < before).sort((a, b) => b.seq - a.seq);
    const entries = older.slice(0, limit);
    return { entries, nextCursor: older.length > limit ? String(entries.at(-1)!.seq) : null };
  }

  /** Adds back the type's default jobs this Building no longer has, in their declared state. Jobs it still has are left alone. */
  function restoreDefaults(projectId: string): Promise<SchedulesView> {
    return run(async () => {
      const project = await requireProject(projectId);
      const present = new Set((await scheduledJobsDb.find((job) => job.projectId === projectId)).map((job) => job.declaredJobId));
      await addDeclaredJobs(project, (typeOf(project)?.scheduledJobs ?? []).map((d) => d.id).filter((id) => !present.has(id)));
      return buildView(project);
    });
  }

  async function previewCron(projectId: string, expression: unknown): Promise<{ cron: string; timezone: string; runs: string[] }> {
    const project = await requireProject(projectId);
    const parsed = parseCron(expression);
    if (!parsed.ok) throw new ScheduleError(400, parsed.error, 'cron');
    const timezone = timezoneOf(project);
    return { cron: parsed.schedule.expression, timezone, runs: upcomingRuns(parsed.schedule, now(), timezone, 3).map(iso) };
  }

  function onEvent(listener: (event: ScheduleEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start, stop, tick, idle, onEvent, isRunning: () => running,
    getSchedules, setTimezone, seedDefaults, restoreDefaults, previewCron,
    createJob, updateJob, deleteJob, runNow, runForEvent, listHistory, removeBuilding,
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
