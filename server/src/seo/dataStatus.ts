import { getStorageStatus, getStore, isJobRunning, startStorageJob } from '../buildings/buildingStorage.ts';
import type { StorageJob } from '../buildings/buildingStorage.ts';
import { projectsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { addDays, daysBetween, monthKey, parseDateRange, validateRetentionMonths, weekKey } from './dates.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError } from './errors.ts';
import type { Dataset } from './ledger.ts';
import { readLedger } from './ledger.ts';
import { avgPositionOf, ctrOf } from './metrics.ts';
import { readSettings, updateSettings } from './settings.ts';
import { latestSync, syncBusy } from './sync.ts';

export const MAX_SERIES_DAYS = 800;
const CHUNK_DAYS = 180;

/** The rule as the person reads it in Settings -> Data. */
export function describeSeoRetention(months: number): string {
  return `Search Console and Analytics rows dated more than ${months} month${months === 1 ? '' : 's'} ago are discarded, automatically once you have acknowledged the notice and on demand. `
    + `Roll-up totals are reduced to match. Comparisons that reach back further than ${months} months, such as year-over-year beyond the window, are not available.`;
}

/** Discarding is allowed once the person has acknowledged a window at least as large as the current one. */
export const discardAllowed = (s: { retentionMonths: number; retentionAckedMonths: number | null }) => s.retentionAckedMonths !== null && s.retentionMonths >= s.retentionAckedMonths;

const TABLE_LABELS: Record<string, string> = { gsc_rows: 'Search Console rows', ga4_rows: 'Analytics rows', fetch_ledger: 'Fetch records' };

export async function retentionPreview(project: ProjectRecord) {
  const settings = (await readSettings(project.id))!;
  const store = await getStore(project);
  const preview = await store.retentionPreview(seoDeps().now().toISOString(), settings.retentionMonths);
  const tables = preview.tables.map((t) => ({ ...t, label: TABLE_LABELS[t.table] ?? t.table }));
  return {
    months: settings.retentionMonths, cutoff: preview.cutoff, tables, total: tables.filter((t) => t.table !== 'fetch_ledger').reduce((n, t) => n + t.count, 0),
    acknowledged: discardAllowed(settings), note: describeSeoRetention(settings.retentionMonths),
  };
}

/** Records that the person has seen what will be discarded at the current window. */
export async function acknowledgeRetention(buildingId: string): Promise<void> {
  await updateSettings(buildingId, (s) => { s.retentionAckedMonths = s.retentionMonths; });
  await resolveNotifications({ type: 'project', projectId: buildingId }, ['storage.problem']).catch(() => undefined);
}

export async function setRetentionMonths(buildingId: string, value: unknown): Promise<void> {
  const months = validateRetentionMonths(value);
  await updateSettings(buildingId, (s) => { s.retentionMonths = months; });
}

/** Starts an on-demand discard. It needs the notice acknowledged and no sync running. */
export async function discardNow(project: ProjectRecord): Promise<StorageJob> {
  const settings = (await readSettings(project.id))!;
  if (!discardAllowed(settings)) throw new SeoConflictError('Review and acknowledge what will be discarded first', { requiresAcknowledgement: true });
  if (syncBusy(project.id)) throw new SeoConflictError('A sync is running; try again when it finishes');
  const now = seoDeps().now().toISOString();
  const job = await startStorageJob(project, 'retention', 'retention', { now, months: settings.retentionMonths, compact: true });
  await updateSettings(project.id, (s) => { s.lastDiscardAt = now; });
  return job;
}

/** The gate the platform's own retention timer and generic route use. Raises the notice once when there is something to discard but nobody has acknowledged it. */
export async function retentionPlan(buildingId: string) {
  const settings = await readSettings(buildingId);
  if (!settings) return { allowed: false };
  if (syncBusy(buildingId)) return { allowed: false, months: settings.retentionMonths };
  if (discardAllowed(settings)) return { allowed: true, months: settings.retentionMonths };
  const project = await projectsDb.get(buildingId);
  if (project) {
    const preview = await retentionPreview(project);
    if (preview.total > 0) {
      await raiseNotification({
        kind: 'storage.problem', subject: { type: 'project', projectId: buildingId }, title: `${project.name}: old SEO data is ready to be discarded`,
        description: `${preview.total} rows older than ${preview.cutoff} (more than ${settings.retentionMonths} months) will be discarded once you acknowledge the notice in Settings -> Data.`,
      }).catch(() => undefined);
    }
  }
  return { allowed: false, months: settings.retentionMonths };
}

async function datasetStats(project: ProjectRecord, rollup: string) {
  const store = await getStore(project);
  const [row] = (await store.aggregate(rollup, {})).rows as Array<{ rows: number | null }>;
  return row?.rows ?? 0;
}

async function oldestDay(project: ProjectRecord, table: string): Promise<string | null> {
  const store = await getStore(project);
  const page = await store.list(table, { sort: 'day', dir: 'asc', limit: 1 });
  return (page.rows[0]?.day as string | undefined) ?? null;
}

/** Settings -> Data: size, rows per dataset, oldest data held, sync state, the retention rule and the size threshold. */
export async function dataStatus(project: ProjectRecord) {
  const settings = (await readSettings(project.id))!;
  const storage = await getStorageStatus(project);
  const job = latestSync(project.id);
  const [gscRows, ga4Rows, gscOldest, ga4Oldest] = await Promise.all([
    datasetStats(project, 'gsc_monthly'), datasetStats(project, 'ga4_monthly'), oldestDay(project, 'gsc_rows'), oldestDay(project, 'ga4_rows'),
  ]);
  return {
    bytes: storage.bytes, warningBytes: storage.warningBytes, level: storage.level, ingestionStoppedReason: storage.ingestionStoppedReason,
    datasets: [
      { id: 'gsc', label: 'Search Console', rows: gscRows, oldestDay: gscOldest, lastSyncAt: settings.connections.gsc.lastSyncAt ?? null },
      { id: 'ga4', label: 'Analytics', rows: ga4Rows, oldestDay: ga4Oldest, lastSyncAt: settings.connections.ga4.lastSyncAt ?? null },
    ],
    sync: job ? { kind: job.kind, status: job.status, done: job.done, total: job.total, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, error: job.error ?? null, waitingUntil: job.waitingUntil } : null,
    retention: {
      months: settings.retentionMonths, ackedMonths: settings.retentionAckedMonths, needsNotice: !discardAllowed(settings), description: describeSeoRetention(settings.retentionMonths),
      discarding: isJobRunning(project.id, 'retention'), lastDiscardAt: settings.lastDiscardAt ?? null,
    },
    previousProperties: settings.previousProperties,
  };
}

export type Grain = 'day' | 'week' | 'month';

/** One point of a series. Metrics are null where there is no data: a gap is never shown as zero. */
export interface SeriesPoint { key: string; state: 'missing' | 'incomplete' | 'final'; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null; sessions: number | null; keyEvents: number | null }

const emptyPoint = (key: string, state: SeriesPoint['state'] = 'missing'): SeriesPoint => ({ key, state, clicks: null, impressions: null, ctr: null, position: null, sessions: null, keyEvents: null });

/** Daily, weekly or monthly totals for the connected property, from the roll-ups. Not connected gives an empty series, never zeros. */
export async function series(project: ProjectRecord, dataset: Dataset, from: unknown, to: unknown, grain: Grain) {
  const range = parseDateRange(from, to, MAX_SERIES_DAYS);
  if (!['day', 'week', 'month'].includes(grain)) throw new SeoInputError('grain must be day, week or month');
  const settings = (await readSettings(project.id))!;
  const connection = settings.connections[dataset];
  if (!connection.connected || !connection.property) return { connected: false, property: null, points: [] as SeriesPoint[] };
  const store = await getStore(project);
  const property = connection.property;
  const name = `${dataset}_${grain === 'day' ? 'daily' : grain === 'week' ? 'weekly' : 'monthly'}`;
  const rows: Array<Record<string, number | string>> = [];
  const windows = grain === 'day' ? chunks(range.from, range.to)
    : [grain === 'week' ? { from: weekKey(range.from), to: weekKey(range.to) } : { from: monthKey(range.from), to: monthKey(range.to) }];
  for (const w of windows) {
    const result = await store.aggregate(name, { groupBy: ['property', grain], where: { property }, range: { col: grain, from: w.from, to: w.to }, orderBy: grain, dir: 'asc', limit: 200 });
    rows.push(...result.rows);
  }
  if (grain !== 'day') return { connected: true, property, points: rows.map((r) => toPoint(String(r[grain]), 'final', r, dataset)) };
  const byDay = new Map(rows.map((r) => [String(r.day), r]));
  const ledger = await readLedger(store, dataset, property, range.from);
  return {
    connected: true, property,
    points: daysBetween(range.from, range.to).map((day) => {
      const final = ledger.get(day);
      if (final === undefined) return emptyPoint(day);
      return toPoint(day, final ? 'final' : 'incomplete', byDay.get(day) ?? { clicks: 0, impressions: 0, positionImpressions: 0, sessions: 0, keyEvents: 0 }, dataset);
    }),
  };
}

function chunks(from: string, to: string) {
  const out: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; start = addDays(start, CHUNK_DAYS)) out.push({ from: start, to: addDays(start, CHUNK_DAYS - 1) < to ? addDays(start, CHUNK_DAYS - 1) : to });
  return out;
}

function toPoint(key: string, state: SeriesPoint['state'], r: Record<string, unknown>, dataset: Dataset): SeriesPoint {
  if (dataset === 'ga4') return { ...emptyPoint(key, state), sessions: Number(r.sessions ?? 0), keyEvents: Number(r.keyEvents ?? 0) };
  const sums = { clicks: Number(r.clicks ?? 0), impressions: Number(r.impressions ?? 0), positionImpressions: Number(r.positionImpressions ?? 0) };
  return { ...emptyPoint(key, state), clicks: sums.clicks, impressions: sums.impressions, ctr: ctrOf(sums), position: avgPositionOf(sums) };
}
