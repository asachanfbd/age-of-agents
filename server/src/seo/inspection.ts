import { trackJob } from './jobs.ts';
import { getStore } from '../buildings/buildingStorage.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, ServiceError } from './errors.ts';
import { BACKGROUND_LIMIT, DAILY_INSPECTION_QUOTA, grantable, inspectionOrder, mapIndexStatus, MANUAL_RESERVE, nextQuotaReset, quotaDay } from './inspectionQuota.ts';
import type { Inspectable, InspectionKind, IndexingState } from './inspectionQuota.ts';
import { gscPropertyOf, settingsOf, withGsc } from './siteAccess.ts';
import { readSettings, updateSettings } from './settings.ts';
import { inspectionUrlFor, isOnProperty, normalizePageUrl } from './urls.ts';

/** The most URLs one manual request may name. */
export const MAX_INSPECT_PER_REQUEST = 200;
/** Manual inspections run this many at a time. */
const MANUAL_CONCURRENCY = 5;

export interface InspectionRow {
  url: string;
  state: IndexingState | '';
  reason: string;
  raw: string;
  inspectedAt: string;
  pending: boolean;
  error: string;
}

interface Usage { day: string; used: number }
const usage = new Map<string, Usage>();
const loading = new Map<string, Promise<void>>();
const passes = new Map<string, { promise: Promise<PassResult>; abort: AbortController }>();

const columns = ['url', 'state', 'reason', 'raw', 'inspectedAt', 'pending', 'error'];

const toRow = (r: Record<string, string | number>): InspectionRow => ({
  url: String(r.url), state: String(r.state) as InspectionRow['state'], reason: String(r.reason), raw: String(r.raw), inspectedAt: String(r.inspectedAt), pending: r.pending === 1, error: String(r.error),
});

export async function readInspections(store: BulkStore, urls?: string[]): Promise<Map<string, InspectionRow>> {
  if (urls && !urls.length) return new Map();
  const { rows } = await store.groupSums({ source: 'seo_inspections', groupBy: columns, match: urls ? { col: 'url', exact: urls, prefixes: [] } : undefined });
  return new Map(rows.map((r) => [String(r.url), toRow(r)]));
}

const rowValues = (r: InspectionRow): Array<string | number> => [r.url, r.state, r.reason, r.raw, r.inspectedAt, r.pending ? 1 : 0, r.error];

/**
 * Stores the rows and logs each change of indexing state (the first answer included) for the report's indexing lists, in one
 * transaction. A log row is replaced by (url, at), so two passes that see the same change log it once.
 */
async function saveInspections(store: BulkStore, rows: InspectionRow[]): Promise<void> {
  if (!rows.length) return;
  const before = await readInspections(store, rows.map((r) => r.url));
  const changes = rows.filter((r) => r.state && r.state !== (before.get(r.url)?.state ?? ''));
  await store.replaceRows([
    ...rows.map((r) => ({ table: 'seo_inspections', where: { url: r.url }, rows: [rowValues(r)] })),
    ...changes.map((r) => ({ table: 'seo_index_changes', where: { url: r.url, at: r.inspectedAt }, rows: [[r.url, before.get(r.url)?.state ?? '', r.state, r.inspectedAt]] })),
  ]);
}

/** Loads the day's used count from disk the first time it is needed and whenever the Pacific day changes. */
async function ensureUsage(project: ProjectRecord): Promise<Usage> {
  const day = quotaDay(seoDeps().now());
  const current = usage.get(project.id);
  if (current?.day === day) return current;
  const pending = loading.get(project.id) ?? (async () => {
    const store = await getStore(project);
    const { rows } = await store.groupSums({ source: 'seo_inspection_quota', groupBy: ['day'], measures: ['used'], where: { day } });
    usage.set(project.id, { day, used: Number(rows[0]?.used ?? 0) });
  })().finally(() => loading.delete(project.id));
  loading.set(project.id, pending);
  await pending;
  const loaded = usage.get(project.id)!;
  return loaded.day === day ? loaded : ensureUsage(project);
}

async function persistUsage(project: ProjectRecord, state: Usage): Promise<void> {
  await (await getStore(project)).replaceRows([{ table: 'seo_inspection_quota', where: { day: state.day }, rows: [[state.day, state.used]] }]);
}

/**
 * Takes up to `wanted` inspections from today's quota and returns how many were granted. The count is raised in memory in the
 * same step it is checked (no await between), so parallel requests can never be granted more than the limit, and it is written
 * to disk before any call to Google: after a crash the day can be over-counted, never under-counted.
 */
export async function claimInspections(project: ProjectRecord, wanted: number, kind: InspectionKind): Promise<number> {
  const state = await ensureUsage(project);
  const granted = grantable(state.used, wanted, kind);
  state.used += granted;
  if (granted) await persistUsage(project, state);
  return granted;
}

/** Gives back inspections that were claimed but never sent (a sign-in failure stopped the request first). */
async function refundInspections(project: ProjectRecord, count: number): Promise<void> {
  if (count <= 0) return;
  const state = await ensureUsage(project);
  state.used = Math.max(0, state.used - count);
  await persistUsage(project, state);
}

async function markExhausted(project: ProjectRecord): Promise<void> {
  const state = await ensureUsage(project);
  state.used = DAILY_INSPECTION_QUOTA;
  await persistUsage(project, state);
}

export async function quotaStatus(project: ProjectRecord) {
  const state = await ensureUsage(project);
  const now = seoDeps().now();
  return {
    day: state.day, used: state.used, limit: DAILY_INSPECTION_QUOTA, manualReserve: MANUAL_RESERVE, backgroundLimit: BACKGROUND_LIMIT,
    remaining: Math.max(0, DAILY_INSPECTION_QUOTA - state.used), exhausted: state.used >= DAILY_INSPECTION_QUOTA, resetsAt: nextQuotaReset(now).toISOString(),
  };
}

export interface InspectionResult {
  url: string;
  status: 'inspected' | 'waiting' | 'error';
  state: IndexingState | null;
  reason: string;
  inspectedAt: string | null;
  error: string | null;
}

const resultOf = (row: InspectionRow, status: InspectionResult['status']): InspectionResult => ({
  url: row.url, status, state: row.state || null, reason: row.reason, inspectedAt: row.inspectedAt || null, error: row.error || null,
});

/** Inspects one address with Google and returns the row to store. Throws what the caller must stop on: quota (as ServiceError) and a broken sign-in. */
async function inspectOne(project: ProjectRecord, url: string, previous: InspectionRow | undefined): Promise<InspectionRow> {
  const { services, now } = seoDeps();
  const base: InspectionRow = previous ?? { url, state: '', reason: '', raw: '', inspectedAt: '', pending: false, error: '' };
  try {
    const status = await withGsc(project, (token, property) => services.gsc.inspectUrl(token, property, inspectionUrlFor(url, property)));
    const mapped = mapIndexStatus(status);
    return { url, state: mapped.state, reason: mapped.reason, raw: mapped.raw, inspectedAt: now().toISOString(), pending: false, error: '' };
  } catch (error) {
    if (error instanceof ServiceError && (error.kind === 'quota' || error.kind === 'auth')) throw error;
    // A refusal for this one address (or a network failure) is recorded against it; the earlier answer stays visible.
    return { ...base, pending: false, error: error instanceof ServiceError ? error.message : 'The inspection failed' };
  }
}

async function failSignIn(project: ProjectRecord, error: ServiceError): Promise<never> {
  await updateSettings(project.id, (s) => { s.connections.gsc.reason = error.message; });
  throw new SeoConflictError('Search Console needs to be reconnected before URLs can be inspected', { reconnect: 'gsc' });
}

/** Checks the addresses a request names: real pages of the connected property, no duplicates, within the request cap. */
export function validateInspectionUrls(input: unknown, property: string): string[] {
  if (!Array.isArray(input) || !input.length) throw new SeoInputError('urls must be a list with at least one address');
  if (input.length > MAX_INSPECT_PER_REQUEST) throw new SeoInputError(`urls may name at most ${MAX_INSPECT_PER_REQUEST} addresses per request`);
  const urls = new Set<string>();
  for (const item of input) {
    const url = normalizePageUrl(item);
    if (!url) throw new SeoInputError('every address must be a full http or https address');
    if (!isOnProperty(url, property)) throw new SeoInputError(`${url.slice(0, 200)} is not part of the connected Search Console property`);
    urls.add(url);
  }
  return [...urls];
}

/**
 * Inspects addresses on request. Whatever fits in today's quota (manual requests may use all of it) is inspected; the rest are
 * marked as waiting and the background pass picks them up first once the quota resets.
 */
export async function inspectNow(project: ProjectRecord, input: unknown) {
  const property = gscPropertyOf(await settingsOf(project));
  if (!property) throw new SeoConflictError('Connect Search Console and choose a property first', { connect: 'gsc' });
  const urls = validateInspectionUrls(input, property);
  const store = await getStore(project);
  const known = await readInspections(store, urls);
  const granted = await claimInspections(project, urls.length, 'manual');
  const queue = urls.slice(0, granted);
  const results = new Map<string, InspectionResult>();
  const stop: { error: ServiceError | null } = { error: null };
  let next = 0;
  const worker = async () => {
    while (!stop.error && next < queue.length) {
      const url = queue[next++]!;
      try {
        const row = await inspectOne(project, url, known.get(url));
        await saveInspections(store, [row]);
        results.set(url, resultOf(row, row.error ? 'error' : 'inspected'));
      } catch (error) {
        stop.error ??= error as ServiceError;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MANUAL_CONCURRENCY, queue.length) }, worker));
  if (stop.error?.kind === 'auth') {
    await refundInspections(project, queue.length - next);
    await failSignIn(project, stop.error);
  }
  if (stop.error?.kind === 'quota') await markExhausted(project);
  const waiting = urls.filter((url) => !results.has(url)).map((url): InspectionRow => ({ ...(known.get(url) ?? { url, state: '', reason: '', raw: '', inspectedAt: '', error: '' }), url, pending: true }));
  await saveInspections(store, waiting);
  for (const row of waiting) results.set(row.url, resultOf(row, 'waiting'));
  return { results: urls.map((u) => results.get(u)!), quota: await quotaStatus(project) };
}

export interface PassResult { inspected: number; stoppedBecause: 'finished' | 'quota' | 'aborted' | 'sign-in' }

async function candidates(store: BulkStore): Promise<Inspectable[]> {
  const [{ rows: listed }, inspections] = await Promise.all([store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['url', 'lastmod', 'firstSeen'] }), readInspections(store)]);
  const byUrl = new Map<string, Inspectable>();
  for (const r of listed) {
    const url = String(r.url);
    const lastmod = String(r.lastmod) || null;
    const existing = byUrl.get(url);
    if (existing) { if (lastmod && (!existing.lastmod || lastmod > existing.lastmod)) existing.lastmod = lastmod; continue; }
    const seen = inspections.get(url);
    byUrl.set(url, { url, pending: seen?.pending ?? false, inspectedAt: seen?.inspectedAt || null, lastmod, firstSeen: String(r.firstSeen) });
  }
  for (const seen of inspections.values()) {
    if (seen.pending && !byUrl.has(seen.url)) byUrl.set(seen.url, { url: seen.url, pending: true, inspectedAt: seen.inspectedAt || null, lastmod: null, firstSeen: '' });
  }
  return [...byUrl.values()];
}

/**
 * The background pass: new and changed addresses first (and any the person asked for that were waiting), stopping at the
 * background limit so manual requests always have room. Waits `inspectPauseMs` between calls. Only one pass runs per Building.
 */
export function runInspectionPass(project: ProjectRecord): Promise<PassResult> {
  const running = passes.get(project.id);
  if (running) return running.promise;
  const abort = new AbortController();
  const promise = trackJob(project.id, 'inspection', () => pass(project, abort.signal)).finally(() => passes.delete(project.id));
  passes.set(project.id, { promise, abort });
  return promise;
}

async function pass(project: ProjectRecord, signal: AbortSignal): Promise<PassResult> {
  const { sleep, now, inspectPauseMs } = seoDeps();
  // A Building without settings (deleted, or its data removed) has nothing to inspect.
  const settings = await readSettings(project.id);
  if (!settings || !gscPropertyOf(settings)) return { inspected: 0, stoppedBecause: 'finished' };
  const store = await getStore(project);
  const known = await readInspections(store);
  let inspected = 0;
  for (const candidate of inspectionOrder(await candidates(store), now())) {
    if (signal.aborted) return { inspected, stoppedBecause: 'aborted' };
    if ((await claimInspections(project, 1, 'background')) === 0) return { inspected, stoppedBecause: 'quota' };
    try {
      await saveInspections(store, [await inspectOne(project, candidate.url, known.get(candidate.url))]);
      inspected++;
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      if (error.kind === 'quota') { await markExhausted(project); return { inspected, stoppedBecause: 'quota' }; }
      await updateSettings(project.id, (s) => { s.connections.gsc.reason = error.message; });
      return { inspected, stoppedBecause: 'sign-in' };
    }
    await sleep(inspectPauseMs);
  }
  return { inspected, stoppedBecause: 'finished' };
}

/** Stops a running background pass and forgets the Building's in-memory quota state (the Building is being deleted). */
export async function stopInspection(buildingId: string): Promise<void> {
  const running = passes.get(buildingId);
  running?.abort.abort();
  await running?.promise.catch(() => undefined);
  usage.delete(buildingId);
  loading.delete(buildingId);
}
