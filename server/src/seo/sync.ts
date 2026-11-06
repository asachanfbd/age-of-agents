import { randomUUID } from 'node:crypto';
import { getStore, guardedWrite, isJobRunning } from '../buildings/buildingStorage.ts';
import { projectsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { Backoff } from './backoff.ts';
import { addDays, fetchStart, GSC_HISTORY_MONTHS, monthKey, pacificToday, weekKey } from './dates.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, ServiceError } from './errors.ts';
import type { Dataset } from './ledger.ts';
import { pendingDays, readLedger } from './ledger.ts';
import { assertValidGscRow } from './metrics.ts';
import type { GscMetricRow } from './metrics.ts';
import type { Ga4Row } from './services.ts';
import { readSettings, updateSettings } from './settings.ts';
import type { SeoSettings } from './settings.ts';
import { accessTokenFor } from './tokens.ts';

/** A quota error is retried this many times (with growing waits) before the sync gives up until its next run. */
const MAX_QUOTA_RETRIES = 5;
/** After giving up on quota, leave the connection alone at least this long. */
const QUOTA_COOLDOWN_MS = 15 * 60_000;
/** Search Console marks roughly the last two days incomplete; GA4 data settles after about two days. */
const GA4_FINAL_AFTER_DAYS = 2;

export interface SyncJob {
  id: string;
  buildingId: string;
  kind: 'backfill' | 'sync';
  status: 'running' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  dataset: Dataset | null;
  /** Set while the job waits out a quota error. */
  waitingUntil: string | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

interface Running { job: SyncJob; abort: AbortController; finished: Promise<void> }

const running = new Map<string, Running>();
const starting = new Set<string>();
const latest = new Map<string, SyncJob>();

export const runningSync = (buildingId: string): SyncJob | undefined => running.get(buildingId)?.job;
export const latestSync = (buildingId: string): SyncJob | undefined => latest.get(buildingId);
export const syncBusy = (buildingId: string): boolean => running.has(buildingId) || starting.has(buildingId);

const subject = (buildingId: string) => ({ type: 'project', projectId: buildingId }) as const;

interface DatasetPlan {
  dataset: Dataset;
  property: string;
  service: 'gsc' | 'ga4';
}

function plansOf(settings: SeoSettings): DatasetPlan[] {
  return (['gsc', 'ga4'] as const).flatMap((service) => {
    const c = settings.connections[service];
    return c.connected && c.property ? [{ dataset: service, property: c.property, service }] : [];
  });
}

/** Starts a sync in the background and returns at once; a second start while one runs is a conflict. */
export async function startSync(project: ProjectRecord): Promise<SyncJob> {
  const id = project.id;
  if (syncBusy(id)) throw new SeoConflictError('A sync is already running for this Building');
  if (isJobRunning(id, 'retention')) throw new SeoConflictError('Old data is being discarded; try again when that finishes');
  starting.add(id);
  try {
    const settings = await readSettings(id);
    if (!settings || !plansOf(settings).length) throw new SeoConflictError('Connect Search Console or Analytics and choose a property before syncing');
    const job: SyncJob = { id: randomUUID(), buildingId: id, kind: 'sync', status: 'running', done: 0, total: 0, dataset: null, waitingUntil: null, startedAt: seoDeps().now().toISOString() };
    const abort = new AbortController();
    const entry: Running = { job, abort, finished: Promise.resolve() };
    entry.finished = execute(project, job, abort.signal)
      .catch((error: Error) => { job.status = 'failed'; job.error = error.message; })
      .finally(() => {
        job.finishedAt = seoDeps().now().toISOString();
        if (job.status === 'running') job.status = abort.signal.aborted ? 'cancelled' : 'done';
        running.delete(id);
        latest.set(id, job);
      });
    running.set(id, entry);
    latest.set(id, job);
    return job;
  } finally {
    starting.delete(id);
  }
}

/** Stops a running sync and waits for it to settle; days already committed stay. */
export async function stopSync(buildingId: string): Promise<void> {
  const entry = running.get(buildingId);
  if (!entry) return;
  entry.abort.abort();
  await entry.finished;
}

export async function waitForSync(buildingId: string): Promise<void> {
  await running.get(buildingId)?.finished;
}

async function execute(project: ProjectRecord, job: SyncJob, signal: AbortSignal): Promise<void> {
  const settings = (await readSettings(project.id))!;
  const plans = plansOf(settings);
  const store = await getStore(project);
  const now = seoDeps().now();
  const today = pacificToday(now);
  const ranges = await Promise.all(plans.map(async (plan) => {
    const from = fetchStart(today, now, settings.retentionMonths, plan.dataset === 'gsc' ? GSC_HISTORY_MONTHS : undefined);
    const ledger = await readLedger(store, plan.dataset, plan.property, from);
    return { plan, from, ledger, days: pendingDays(from, addDays(today, -1), ledger) };
  }));
  job.kind = ranges.every((r) => r.ledger.size === 0) ? 'backfill' : 'sync';
  job.total = ranges.reduce((n, r) => n + r.days.length, 0);
  const failures: string[] = [];
  for (const range of ranges) {
    if (signal.aborted) return;
    const failure = await syncDataset(project, job, signal, range.plan, range.days, today);
    if (failure) failures.push(failure);
  }
  // A dataset that could not finish makes the job failed (its connection card says why), never "done".
  if (failures.length) throw new Error(failures.join(' '));
}

/** Fetches and stores the pending days of one dataset. Returns why it stopped early, or null when it finished (or was aborted or is cooling down). */
async function syncDataset(project: ProjectRecord, job: SyncJob, signal: AbortSignal, plan: DatasetPlan, days: string[], today: string): Promise<string | null> {
  const { now, sleep, dayPauseMs } = seoDeps();
  const settings = (await readSettings(project.id))!;
  const connection = settings.connections[plan.service];
  if (connection.backoffUntil && Date.parse(connection.backoffUntil) > now().getTime()) {
    job.total -= days.length;
    return null;
  }
  job.dataset = plan.dataset;
  const backoff = new Backoff();
  const retryQuota = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (;;) {
      try { const result = await fn(); backoff.reset(); return result; } catch (error) {
        if (!(error instanceof ServiceError) || error.kind !== 'quota' || backoff.failures >= MAX_QUOTA_RETRIES) throw error;
        const wait = backoff.next(error.retryAfterMs);
        job.waitingUntil = new Date(now().getTime() + wait).toISOString();
        await sleep(wait);
        job.waitingUntil = null;
        if (signal.aborted) throw error;
      }
    }
  };
  try {
    let firstIncomplete: string | null = null;
    if (plan.dataset === 'gsc' && days.length) {
      const token = await accessTokenFor(project.id, 'gsc', { services: seoDeps().services, now });
      firstIncomplete = await retryQuota(() => seoDeps().services.gsc.firstIncompleteDate(token, plan.property, addDays(today, -14), addDays(today, -1)));
    }
    for (const day of days) {
      if (signal.aborted) return null;
      const token = await accessTokenFor(project.id, plan.service, { services: seoDeps().services, now });
      const final = plan.dataset === 'gsc' ? firstIncomplete === null || day < firstIncomplete : day <= addDays(today, -GA4_FINAL_AFTER_DAYS);
      const steps = plan.dataset === 'gsc'
        ? gscSteps(plan.property, day, final, now(), await retryQuota(() => seoDeps().services.gsc.queryDay(token, plan.property, day)))
        : ga4Steps(plan.property, day, final, now(), await retryQuota(() => seoDeps().services.ga4.reportDay(token, plan.property, day)));
      await guardedWrite(project, (s) => s.replaceRows(steps));
      job.done += 1;
      if (dayPauseMs) await sleep(dayPauseMs);
    }
    await markSuccess(project, plan.service, now());
    return null;
  } catch (error) {
    if (signal.aborted && error instanceof ServiceError) return null;
    const reason = await markFailure(project, plan, error, now());
    if (!(error instanceof ServiceError || error instanceof SeoInputError)) throw error;
    return reason;
  }
}

function dayKeys(day: string) { return [day, weekKey(day), monthKey(day)]; }

function gscSteps(property: string, day: string, final: boolean, fetchedAt: Date, fetched: GscMetricRow[]) {
  const merged = new Map<string, GscMetricRow>();
  for (const row of fetched) {
    assertValidGscRow(row);
    const key = `${row.page}\u0000${row.query}`;
    const prior = merged.get(key);
    if (!prior) { merged.set(key, { ...row }); continue; }
    const impressions = prior.impressions + row.impressions;
    prior.position = impressions ? (prior.position * prior.impressions + row.position * row.impressions) / impressions : prior.position;
    prior.clicks += row.clicks;
    prior.impressions = impressions;
  }
  const rows = [...merged.values()].map((r) => [property, ...dayKeys(day), r.page, r.query, r.clicks, r.impressions, r.position * r.impressions]);
  return [
    { table: 'gsc_rows', where: { property, day }, rows },
    ledgerStep('gsc', property, day, final, fetchedAt, rows.length),
  ];
}

function ga4Steps(property: string, day: string, final: boolean, fetchedAt: Date, fetched: Ga4Row[]) {
  const merged = new Map<string, Ga4Row>();
  for (const row of fetched) {
    for (const n of [row.sessions, row.keyEvents]) if (!Number.isSafeInteger(n) || n < 0) throw new SeoInputError('sessions and key events must be whole numbers from 0 to 2^53-1');
    const prior = merged.get(row.page);
    if (prior) { prior.sessions += row.sessions; prior.keyEvents += row.keyEvents; } else merged.set(row.page, { ...row });
  }
  const rows = [...merged.values()].map((r) => [property, ...dayKeys(day), r.page, r.sessions, r.keyEvents]);
  return [
    { table: 'ga4_rows', where: { property, day }, rows },
    ledgerStep('ga4', property, day, final, fetchedAt, rows.length),
  ];
}

const ledgerStep = (dataset: Dataset, property: string, day: string, final: boolean, fetchedAt: Date, rowCount: number) => ({
  table: 'fetch_ledger', where: { dataset, property, day }, rows: [[dataset, property, day, final ? 1 : 0, fetchedAt.toISOString(), rowCount]],
});

async function markSuccess(project: ProjectRecord, service: 'gsc' | 'ga4', at: Date): Promise<void> {
  await updateSettings(project.id, (s) => {
    const c = s.connections[service];
    c.lastSyncAt = at.toISOString();
    c.reason = null;
    c.backoffUntil = null;
  }).catch(() => undefined);
  const settings = await readSettings(project.id);
  if (settings && !(['gsc', 'ga4'] as const).some((s) => settings.connections[s].reason)) await resolveNotifications(subject(project.id), ['storage.problem']);
}

function reasonOf(error: unknown, plan: DatasetPlan, now: Date): { reason: string; backoffUntil?: string } {
  const name = plan.service === 'gsc' ? 'Search Console' : 'Analytics';
  if (error instanceof ServiceError) {
    if (error.kind === 'auth') return { reason: `${name} no longer accepts the saved sign-in. Connect it again.` };
    if (error.kind === 'access') return { reason: `${name} refused access to ${plan.property}. It may have been removed from the Google account.` };
    if (error.kind === 'quota') {
      const until = new Date(now.getTime() + QUOTA_COOLDOWN_MS).toISOString();
      return { reason: `${name} quota exceeded. Syncing resumes after ${until}.`, backoffUntil: until };
    }
    return { reason: `${name} could not be reached (${error.message}). It will be retried at the next sync.` };
  }
  if (error instanceof SeoInputError) return { reason: `${name} returned data that failed validation (${error.message}). The day was not saved.` };
  return { reason: `Saving ${name} data failed: ${(error as Error).message}` };
}

async function markFailure(project: ProjectRecord, plan: DatasetPlan, error: unknown, now: Date): Promise<string> {
  const { reason, backoffUntil } = reasonOf(error, plan, now);
  await updateSettings(project.id, (s) => { s.connections[plan.service].reason = reason; s.connections[plan.service].backoffUntil = backoffUntil ?? null; }).catch(() => undefined);
  await raiseNotification({ kind: 'storage.problem', subject: subject(project.id), title: `${project.name}: SEO sync needs attention`, description: reason }).catch(() => undefined);
  return reason;
}

/** On-open and daily entry point: starts a sync when something is connected and idle. Never throws for the usual "nothing to do" cases. */
export async function syncIfDue(buildingId: string): Promise<SyncJob | null> {
  const project = await projectsDb.get(buildingId);
  if (!project || syncBusy(buildingId)) return null;
  try { return await startSync(project); } catch (error) {
    if (error instanceof SeoConflictError) return null;
    throw error;
  }
}
