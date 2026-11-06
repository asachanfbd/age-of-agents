import { createHash, randomUUID } from 'node:crypto';
import { getStore } from '../buildings/buildingStorage.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import { SecretsStore } from '../buildings/secrets.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, SeoRateLimitError, ServiceError } from './errors.ts';
import { INDEXNOW_BATCH_SIZE, classifyKeyFile, mapIndexNowResponse, maskedKeyFileName, redactKey, selectNewOrChanged, splitBatches } from './indexNowRules.ts';
import type { KeyFileStatus, SubmissionResult } from './indexNowRules.ts';
import { INDEXNOW_ENDPOINT } from './googleServices.ts';
import { limitedFetch, LimitedFetchError } from './limitedFetch.ts';
import { runCoalesced } from './runCoalescer.ts';
import { settingsOf, siteOrigin } from './siteAccess.ts';
import { canonicalSitemapUrl, readSitemapRecords } from './sitemaps.ts';
import { secretKeys } from './tokens.ts';
import { normalizePageUrl } from './urls.ts';

const KEY_FILE_MAX_BYTES = 64 * 1024;
const KEY_CHECK_COOLDOWN_MS = 30_000;
const ENDPOINT_HOST = new URL(INDEXNOW_ENDPOINT).host;

export interface KeyFileCheck {
  status: KeyFileStatus | 'no-key';
  httpStatus: number | null;
  /** The file name to create at the site root, with the middle of the key hidden. The full key is only in Settings. */
  keyFileName: string | null;
  checkedAt: string | null;
}

const keyChecks = new Map<string, KeyFileCheck>();
const lastSubmission = new Map<string, number>();

const keyOf = (buildingId: string) => new SecretsStore(buildingId).get(secretKeys.indexNowKey);

/** Reads the key file from the site and says whether it matches. Repeated checks within the cooldown return the earlier answer. */
export async function checkKeyFile(project: ProjectRecord, force = false): Promise<KeyFileCheck> {
  const key = await keyOf(project.id);
  if (!key) return { status: 'no-key', httpStatus: null, keyFileName: null, checkedAt: null };
  const { now, limits } = seoDeps();
  const cached = keyChecks.get(project.id);
  if (!force && cached?.checkedAt && now().getTime() - Date.parse(cached.checkedAt) < KEY_CHECK_COOLDOWN_MS) return cached;
  const origin = siteOrigin(await settingsOf(project));
  const result: KeyFileCheck = { status: 'error', httpStatus: null, keyFileName: maskedKeyFileName(key), checkedAt: now().toISOString() };
  try {
    const res = await limitedFetch(`${origin}/${key}.txt`, { maxBytes: KEY_FILE_MAX_BYTES, timeoutMs: limits.fetchTimeoutMs, allowRedirect: (next) => new URL(next).hostname === new URL(origin).hostname });
    result.httpStatus = res.status;
    result.status = classifyKeyFile({ status: res.status, body: res.body.toString('utf8'), contentType: res.contentType, key });
  } catch (error) {
    if (!(error instanceof LimitedFetchError)) throw error;
    result.status = error.kind === 'timeout' ? 'timeout' : error.kind === 'too-large' ? 'too-large' : error.kind === 'redirect' ? 'redirected' : 'error';
  }
  keyChecks.set(project.id, result);
  return result;
}

/** Only identical selections share a run: two different selections must both be sent, not merged into the first. */
function selectedScope(urls: unknown): string {
  const list = Array.isArray(urls) ? urls.map((u) => normalizePageUrl(u) ?? String(u)) : [];
  return `indexnow:selected:${createHash('sha1').update([...new Set(list)].sort().join('\n')).digest('hex')}`;
}

export type SubmitRequest = { mode: 'selected'; urls: unknown } | { mode: 'sitemap'; sitemap: unknown } | { mode: 'new-or-changed'; sitemap?: unknown };

export interface SubmitOutcome {
  batchId: string;
  total: number;
  batches: number;
  accepted: number;
  rejected: number;
  errors: number;
  skippedOtherHost: number;
  keyFile: KeyFileStatus | 'no-key';
  keyFileWarning: boolean;
  retryAt: string | null;
}

const urlsOf = async (store: BulkStore, sitemap?: string) =>
  (await store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['url', 'lastmod', 'firstSeen'], where: sitemap ? { sitemap } : undefined })).rows
    .map((r) => ({ url: String(r.url), lastmod: String(r.lastmod) || null, firstSeen: String(r.firstSeen) }));

async function lastAccepted(store: BulkStore): Promise<Map<string, string>> {
  const { rows } = await store.groupSums({ source: 'seo_indexnow_log', groupBy: ['url', 'at'], where: { result: 'accepted' } });
  const latest = new Map<string, string>();
  for (const r of rows) if (!latest.has(String(r.url)) || String(r.at) > latest.get(String(r.url))!) latest.set(String(r.url), String(r.at));
  return latest;
}

async function resolveUrls(project: ProjectRecord, store: BulkStore, request: SubmitRequest): Promise<{ urls: string[]; scope: string; skipped: number }> {
  const host = new URL((await settingsOf(project)).siteUrl).hostname;
  const onHost = (url: string) => new URL(url).hostname === host;
  if (request.mode === 'selected') {
    if (!Array.isArray(request.urls) || !request.urls.length) throw new SeoInputError('urls must be a list with at least one address');
    if (request.urls.length > INDEXNOW_BATCH_SIZE) throw new SeoInputError(`urls may name at most ${INDEXNOW_BATCH_SIZE} addresses; submit a whole sitemap for more`);
    const urls = new Set<string>();
    for (const item of request.urls) {
      const url = normalizePageUrl(item);
      if (!url) throw new SeoInputError('every address must be a full http or https address');
      if (!onHost(url)) throw new SeoInputError(`${url.slice(0, 200)} is not on the key's host (${host}); IndexNow only accepts addresses on the host the key belongs to`);
      urls.add(url);
    }
    return { urls: [...urls], scope: 'indexnow:selected', skipped: 0 };
  }
  const sitemap = request.sitemap === undefined && request.mode === 'new-or-changed' ? undefined : (canonicalSitemapUrl(String(request.sitemap ?? '')) ?? undefined);
  if (request.mode === 'sitemap' && !sitemap) throw new SeoInputError('sitemap must be the address of a sitemap');
  const records = await readSitemapRecords(store);
  if (sitemap && !records.some((r) => r.url === sitemap)) throw new SeoInputError('That sitemap is not in the list');
  let candidates: string[];
  if (request.mode === 'sitemap') {
    const tree = descendants(records, sitemap!);
    candidates = (await Promise.all(tree.map((url) => urlsOf(store, url)))).flat().map((u) => u.url);
  }
  else {
    const accepted = await lastAccepted(store);
    const chosen = new Set<string>();
    for (const record of records.filter((r) => r.kind === 'urlset' && (!sitemap || r.url === sitemap))) {
      for (const url of selectNewOrChanged(await urlsOf(store, record.url), record.previousFetchedAt, accepted)) chosen.add(url);
    }
    candidates = [...chosen];
  }
  const urls = [...new Set(candidates)].filter(onHost);
  return { urls, scope: sitemap ?? 'indexnow:new-or-changed', skipped: new Set(candidates).size - urls.length };
}

/** A sitemap and, when it is an index, every sitemap below it: the URLs of an index are stored under its children. */
export function descendants(records: Array<{ url: string; children: string[] }>, root: string): string[] {
  const byUrl = new Map(records.map((r) => [r.url, r]));
  const out: string[] = [];
  const queue = [root];
  while (queue.length) {
    const url = queue.shift()!;
    if (out.includes(url)) continue;
    out.push(url);
    queue.push(...(byUrl.get(url)?.children ?? []));
  }
  return out;
}

/** Switches a normalised (https) address to the site's own protocol, which is what the key file location and the pages use. */
const submissionUrl = (url: string, origin: string) => (origin.startsWith('http://') ? url.replace(/^https:/, 'http:') : url);

export const NOTHING_NEW = 'There are no new or changed addresses to submit';

/** When the next submission is allowed, or null when one is allowed now. */
export async function indexNowRetryAt(project: ProjectRecord): Promise<string | null> {
  const { now, limits } = seoDeps();
  let last = lastSubmission.get(project.id);
  if (last === undefined) {
    const page = await (await getStore(project)).list('seo_indexnow_log', { sort: 'at', dir: 'desc', limit: 1 });
    last = page.rows[0] ? Date.parse(String(page.rows[0].at)) : 0;
  }
  const retryAt = last + limits.indexNowMinIntervalMs;
  return now().getTime() < retryAt ? new Date(retryAt).toISOString() : null;
}

async function enforceRate(project: ProjectRecord): Promise<void> {
  const { now } = seoDeps();
  const retryAt = await indexNowRetryAt(project);
  if (retryAt) throw new SeoRateLimitError('IndexNow submissions are limited to one per minute; try again shortly', retryAt);
  lastSubmission.set(project.id, now().getTime());
}

/**
 * Sends addresses to IndexNow, only when the person asks. Each address gets a log row per request with what IndexNow
 * answered. Nothing is retried automatically. An unreachable key file is reported but does not stop the submission.
 */
export function submitToIndexNow(project: ProjectRecord, request: SubmitRequest): Promise<SubmitOutcome> {
  const scope = request.mode === 'sitemap' ? (canonicalSitemapUrl(String(request.sitemap ?? '')) ?? 'indexnow:sitemap') : request.mode === 'selected' ? selectedScope(request.urls) : `indexnow:new:${String(request.sitemap ?? '')}`;
  return runCoalesced(project.id, scope, 'submit-indexnow', () => submit(project, request));
}

async function submit(project: ProjectRecord, request: SubmitRequest): Promise<SubmitOutcome> {
  const key = await keyOf(project.id);
  if (!key) throw new SeoConflictError('Set up the IndexNow key in Settings → Connections first', { setup: 'indexnow' });
  const store = await getStore(project);
  const { urls, skipped } = await resolveUrls(project, store, request);
  if (!urls.length) throw new SeoInputError(request.mode === 'new-or-changed' ? NOTHING_NEW : 'There are no addresses to submit');
  await enforceRate(project);
  const settings = await settingsOf(project);
  const origin = siteOrigin(settings);
  const check = await checkKeyFile(project);
  const { services, now } = seoDeps();
  const batchId = randomUUID();
  const outcome: SubmitOutcome = {
    batchId, total: urls.length, batches: 0, accepted: 0, rejected: 0, errors: 0, skippedOtherHost: skipped, keyFile: check.status,
    keyFileWarning: check.status !== 'reachable', retryAt: null,
  };
  const batches = splitBatches(urls);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    let result: SubmissionResult;
    let message: string;
    let httpStatus = 0;
    if (outcome.retryAt) { result = 'error'; message = 'Not sent: IndexNow asked to slow down earlier in this submission.'; } else {
      outcome.batches++;
      try {
        const answer = await services.indexNow.submit({ host: new URL(origin).host, key, keyLocation: `${origin}/${key}.txt`, urls: batch.map((u) => submissionUrl(u, origin)) });
        const mapped = mapIndexNowResponse(answer.status, answer.retryAfter, now());
        ({ result, message } = mapped);
        httpStatus = answer.status;
        if (answer.status === 429) outcome.retryAt = new Date(now().getTime() + (mapped.retryAfterMs ?? 60_000)).toISOString();
      } catch (error) {
        result = 'error';
        message = redactKey(error instanceof ServiceError ? error.message : 'The submission could not be sent', key);
      }
    }
    outcome[result === 'accepted' ? 'accepted' : result === 'rejected' ? 'rejected' : 'errors'] += batch.length;
    const at = now().toISOString();
    await store.insert('seo_indexnow_log', batch.map((url) => [at, batchId, url, ENDPOINT_HOST, httpStatus, result, message]));
  }
  await pruneLog(store, seoDeps().limits.indexNowLogRows);
  return outcome;
}

/** Keeps at most `cap` log rows by dropping the oldest whole submissions. */
async function pruneLog(store: BulkStore, cap: number): Promise<void> {
  let { count } = await store.count('seo_indexnow_log');
  while (count > cap) {
    const oldest = (await store.list('seo_indexnow_log', { sort: 'at', dir: 'asc', limit: 1 })).rows[0];
    if (!oldest) return;
    const { removed } = await store.replaceRows([{ table: 'seo_indexnow_log', where: { batch: String(oldest.batch) }, rows: [] }]);
    if (!removed) return;
    count -= removed;
  }
}

export interface LogEntry { at: string; batchId: string; url: string; endpoint: string; httpStatus: number | null; result: SubmissionResult; message: string }

/** The submission log, newest first. `httpStatus` is null when no answer came back (a network error). */
export async function submissionLog(project: ProjectRecord, options: { limit: number; offset: number; url?: string }) {
  const store = await getStore(project);
  // The log is capped, so it is read whole and ordered here: time, then batch and URL, so a page boundary inside one submission is stable.
  const { rows } = await store.groupSums({ source: 'seo_indexnow_log', groupBy: ['at', 'batch', 'url', 'endpoint', 'httpStatus', 'result', 'message'], where: options.url ? { url: options.url } : undefined });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => cmp(String(b.at), String(a.at)) || cmp(String(a.batch), String(b.batch)) || cmp(String(a.url), String(b.url)));
  const page = rows.slice(options.offset, options.offset + options.limit);
  return {
    entries: page.map((r): LogEntry => ({ at: String(r.at), batchId: String(r.batch), url: String(r.url), endpoint: String(r.endpoint), httpStatus: Number(r.httpStatus) || null, result: String(r.result) as SubmissionResult, message: String(r.message) })),
    hasMore: rows.length > options.offset + options.limit,
  };
}

export function forgetIndexNowState(buildingId: string): void {
  keyChecks.delete(buildingId);
  lastSubmission.delete(buildingId);
}
