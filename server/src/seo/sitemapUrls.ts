import { getStore } from '../buildings/buildingStorage.ts';
import { SecretsStore } from '../buildings/secrets.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, ServiceError } from './errors.ts';
import { readInspections } from './inspection.ts';
import type { InspectionRow } from './inspection.ts';
import { settingsOf } from './siteAccess.ts';
import { canonicalSitemapUrl } from './sitemaps.ts';
import { secretKeys } from './tokens.ts';
import { normalizePageUrl } from './urls.ts';

export const MAX_URL_PAGE = 200;
export const MAX_BING_CHECK = 50;
const MAX_TEXT = 500;

export type UrlFilter = 'all' | 'indexed' | 'not-indexed' | 'unknown' | 'waiting' | 'never-inspected';
const FILTERS: UrlFilter[] = ['all', 'indexed', 'not-indexed', 'unknown', 'waiting', 'never-inspected'];

export type BingStatus =
  | { state: 'not-connected' }
  | { state: 'unchecked' }
  | { state: 'unavailable'; checkedAt: string }
  | { state: 'not-found'; checkedAt: string }
  | { state: 'known'; checkedAt: string; discoveredAt: string | null; lastCrawledAt: string | null; httpCode: number | null };

const bingCache = new Map<string, Map<string, BingStatus>>();

const bingConnected = async (project: ProjectRecord) => (await settingsOf(project)).connections.bing.connected;

/** Asks Bing Webmaster what it knows about up to 50 addresses. A failure for one address marks only that address unavailable. IndexNow itself has no indexed status, so this is the only indexing information shown beside it. */
export async function checkBing(project: ProjectRecord, input: unknown): Promise<Record<string, BingStatus>> {
  if (!(await bingConnected(project))) throw new SeoConflictError('Connect Bing Webmaster in Settings → Connections to see its indexing information', { connect: 'bing' });
  if (!Array.isArray(input) || !input.length || input.length > MAX_BING_CHECK) throw new SeoInputError(`urls must be a list of 1 to ${MAX_BING_CHECK} addresses`);
  const urls = [...new Set(input.map((item) => {
    const url = normalizePageUrl(item);
    if (!url) throw new SeoInputError('every address must be a full http or https address');
    return url;
  }))];
  const apiKey = await new SecretsStore(project.id).get(secretKeys.bingApiKey);
  if (!apiKey) throw new SeoConflictError('The Bing key is missing; connect Bing Webmaster again', { connect: 'bing' });
  const { services, now } = seoDeps();
  const siteUrl = (await settingsOf(project)).siteUrl;
  const cache = bingCache.get(project.id) ?? new Map<string, BingStatus>();
  bingCache.set(project.id, cache);
  const out: Record<string, BingStatus> = {};
  for (const url of urls) {
    const checkedAt = now().toISOString();
    try {
      const info = await services.bing.urlInfo({ apiKey, siteUrl, url });
      out[url] = info ? { state: 'known', checkedAt, ...info } : { state: 'not-found', checkedAt };
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      out[url] = { state: 'unavailable', checkedAt };
    }
    cache.set(url, out[url]!);
  }
  return out;
}

export interface UrlRow {
  url: string;
  sitemaps: string[];
  lastmod: string | null;
  indexing: { state: 'indexed' | 'not-indexed' | 'unknown' | 'never'; reason: string | null; raw: string | null; inspectedAt: string | null; waitingForQuota: boolean; error: string | null };
  indexNow: { lastSubmittedAt: string; result: string; httpStatus: number | null; message: string } | null;
  bing: BingStatus;
}

export function indexingOf(row: InspectionRow | undefined): UrlRow['indexing'] {
  if (!row) return { state: 'never', reason: null, raw: null, inspectedAt: null, waitingForQuota: false, error: null };
  return { state: row.state || 'never', reason: row.reason || null, raw: row.raw || null, inspectedAt: row.inspectedAt || null, waitingForQuota: row.pending, error: row.error || null };
}

const matches = (filter: UrlFilter, row: UrlRow): boolean => {
  if (filter === 'all') return true;
  if (filter === 'waiting') return row.indexing.waitingForQuota;
  if (filter === 'never-inspected') return row.indexing.state === 'never';
  return row.indexing.state === filter;
};

function textParam(value: unknown, name: string): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new SeoInputError(`${name} must be text of at most ${MAX_TEXT} characters`);
  return value;
}

function wholeParam(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new SeoInputError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** The addresses the sitemaps list, with their indexing state, last IndexNow submission and cached Bing information. */
export async function listSitemapUrls(project: ProjectRecord, query: Record<string, unknown>) {
  const filter = (query.filter ?? 'all') as UrlFilter;
  if (!FILTERS.includes(filter)) throw new SeoInputError(`filter must be one of ${FILTERS.join(', ')}`);
  const search = textParam(query.search, 'search').toLowerCase();
  const sitemap = query.sitemap === undefined || query.sitemap === '' ? undefined : canonicalSitemapUrl(textParam(query.sitemap, 'sitemap'));
  if (query.sitemap && !sitemap) throw new SeoInputError('sitemap must be the address of a sitemap');
  const limit = wholeParam(query.limit, 'limit', 1, MAX_URL_PAGE, 50);
  const offset = wholeParam(query.offset, 'offset', 0, 10_000_000, 0);
  const store = await getStore(project);
  const connectedBing = await bingConnected(project);
  const [{ rows: listed }, inspections] = await Promise.all([
    store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['sitemap', 'url', 'lastmod'], where: sitemap ? { sitemap } : undefined }),
    readInspections(store),
  ]);
  const byUrl = new Map<string, { sitemaps: string[]; lastmod: string | null }>();
  for (const r of listed) {
    const url = String(r.url);
    const entry = byUrl.get(url) ?? { sitemaps: [], lastmod: null };
    entry.sitemaps.push(String(r.sitemap));
    if (r.lastmod && (!entry.lastmod || String(r.lastmod) > entry.lastmod)) entry.lastmod = String(r.lastmod);
    byUrl.set(url, entry);
  }
  const cache = bingCache.get(project.id);
  const rows = [...byUrl.entries()]
    .filter(([url]) => !search || url.toLowerCase().includes(search))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([url, e]): UrlRow => ({ url, sitemaps: e.sitemaps, lastmod: e.lastmod, indexing: indexingOf(inspections.get(url)), indexNow: null, bing: !connectedBing ? { state: 'not-connected' } : cache?.get(url) ?? { state: 'unchecked' } }))
    .filter((row) => matches(filter, row));
  const page = rows.slice(offset, offset + limit);
  await attachIndexNow(project, page);
  return { total: rows.length, offset, limit, rows: page };
}

async function attachIndexNow(project: ProjectRecord, rows: UrlRow[]): Promise<void> {
  if (!rows.length) return;
  const store = await getStore(project);
  const { rows: log } = await store.groupSums({ source: 'seo_indexnow_log', groupBy: ['url', 'at', 'result', 'httpStatus', 'message'], match: { col: 'url', exact: rows.map((r) => r.url), prefixes: [] } });
  const latest = new Map<string, (typeof log)[number]>();
  for (const r of log) { const have = latest.get(String(r.url)); if (!have || String(r.at) > String(have.at)) latest.set(String(r.url), r); }
  for (const row of rows) {
    const r = latest.get(row.url);
    if (r) row.indexNow = { lastSubmittedAt: String(r.at), result: String(r.result), httpStatus: Number(r.httpStatus) || null, message: String(r.message) };
  }
}

export function forgetBingState(buildingId: string): void {
  bingCache.delete(buildingId);
}
