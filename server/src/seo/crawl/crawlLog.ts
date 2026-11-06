import { SeoInputError, SeoNotFoundError } from '../errors.ts';
import { isHtml } from './fetchPage.ts';
import { MAX_STORED_LINKS, WARNING_SHARE } from './rules.ts';
import type { PageRecord, RawLink, Snapshot, SnapshotWarning } from './types.ts';
import { csvCell, MAX_LIST, metaOf } from './views.ts';

export const LOG_FILTERS = ['all', 'redirects', 'http-errors', 'errors', 'self-redirects', 'zero-links'] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];

/** Rows sent to the screen; the CSV export carries every match. */
export const MAX_LOG_ROWS = 1000;

/** Where a row's `from` points when the address was seeded from the sitemap, is the start page, or predates the stored field. */
export const FROM_SITEMAP = 'sitemap';
export const FROM_START = 'start';
export const FROM_UNKNOWN = 'unknown';

export interface LogRow {
  n: number; url: string; from: string; status: number | null; contentType: string | null; redirectTo: string | null; selfRedirect: boolean;
  error: PageRecord['error']; internalLinks: number; externalLinks: number;
  /** A healthy HTML page with no links of either kind; the same test as the Zero links filter and the warning. */
  zeroLinks: boolean;
}

/** Internal links found on the page; snapshots saved before the count was stored fall back to unique outgoing pages. */
export const internalCount = (p: PageRecord) => p.internalLinks ?? p.outbound;
export const isSelfRedirect = (p: PageRecord) => p.redirectTo !== null && p.redirectTo === p.url;
const isOk = (p: PageRecord) => p.status !== null && p.status >= 200 && p.status < 300 && !p.error;
const isHttpError = (p: PageRecord) => p.status !== null && p.status >= 400;
const hasZeroLinks = (p: PageRecord) => isOk(p) && isHtml(p.contentType) && internalCount(p) === 0 && p.externalLinks === 0;

const MATCHES: Record<LogFilter, (p: PageRecord) => boolean> = {
  all: () => true,
  redirects: (p) => p.redirectTo !== null,
  'http-errors': isHttpError,
  errors: (p) => p.error !== null,
  'self-redirects': isSelfRedirect,
  'zero-links': hasZeroLinks,
};

const fromOf = (p: PageRecord) => (p.discoveredFrom === undefined ? FROM_UNKNOWN : p.discoveredFrom === null ? FROM_START : p.discoveredFrom);

const rowOf = (p: PageRecord, n: number): LogRow => ({
  n, url: p.url, from: fromOf(p), status: p.status, contentType: p.contentType, redirectTo: p.redirectTo, selfRedirect: isSelfRedirect(p),
  error: p.error, internalLinks: internalCount(p), externalLinks: p.externalLinks, zeroLinks: hasZeroLinks(p),
});

/** The raw links a snapshot keeps: the first `MAX_STORED_LINKS` in crawl order. */
export const storedLinks = (raw: RawLink[]): RawLink[] => raw.slice(0, MAX_STORED_LINKS);

/** A crawl that finished but cannot be trusted: more than half of the requested addresses gave no links or redirected to themselves. */
export function crawlWarning(pages: PageRecord[]): SnapshotWarning | null {
  const affected = pages.filter((p) => isSelfRedirect(p) || hasZeroLinks(p)).length;
  return pages.length > 0 && affected > pages.length * WARNING_SHARE ? { affected, total: pages.length } : null;
}

function checkFilter(value: unknown): LogFilter {
  if (value === undefined || value === '') return 'all';
  if (typeof value !== 'string' || !(LOG_FILTERS as readonly string[]).includes(value)) throw new SeoInputError(`filter must be one of ${LOG_FILTERS.join(', ')}`);
  return value as LogFilter;
}

function checkSearch(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new SeoInputError('q must be text');
  return value.trim().toLowerCase();
}

/** Rows of the chosen snapshot in request order, narrowed by one filter and a case-insensitive address search. */
function matchingRows(snapshot: Snapshot, query: { filter?: unknown; q?: unknown }): LogRow[] {
  const filter = MATCHES[checkFilter(query.filter)];
  const search = checkSearch(query.q);
  const rows: LogRow[] = [];
  snapshot.pages.forEach((p, i) => { if (filter(p) && (!search || p.url.toLowerCase().includes(search))) rows.push(rowOf(p, i + 1)); });
  return rows;
}

export function crawlLogOf(snapshot: Snapshot, query: { filter?: unknown; q?: unknown }) {
  const rows = matchingRows(snapshot, query);
  const pages = snapshot.pages;
  const failed = (p: PageRecord) => p.error !== null || isHttpError(p);
  return {
    snapshot: metaOf(snapshot),
    summary: {
      requested: pages.length,
      ok: pages.filter((p) => isOk(p)).length,
      redirected: pages.filter((p) => p.redirectTo !== null && !failed(p)).length,
      failed: pages.filter(failed).length,
      other: pages.filter((p) => !isOk(p) && !failed(p) && p.redirectTo === null).length,
      internalLinks: pages.reduce((t, p) => t + internalCount(p), 0),
      externalLinks: pages.reduce((t, p) => t + p.externalLinks, 0),
    },
    counts: Object.fromEntries(LOG_FILTERS.map((f) => [f, pages.filter(MATCHES[f]).length])) as Record<LogFilter, number>,
    matched: rows.length,
    rows: rows.slice(0, MAX_LOG_ROWS),
  };
}

const CSV_HEADER = ['#', 'address', 'discovered from', 'status', 'content type', 'redirect to', 'redirects to itself', 'error', 'internal links', 'external links'];

export function crawlLogCsv(snapshot: Snapshot, query: { filter?: unknown; q?: unknown }): string {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const r of matchingRows(snapshot, query)) {
    lines.push([r.n, r.url, r.from, r.status ?? '', r.contentType ?? '', r.redirectTo ?? '', r.selfRedirect ? 'yes' : 'no', r.error ?? '', r.internalLinks, r.externalLinks].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export const crawlLogFileName = (snapshot: Pick<Snapshot, 'startedAt'>) => `crawl-log-${snapshot.startedAt.slice(0, 10)}.csv`;

const linkView = (l: RawLink, crawled: Set<string>) => ({ url: l.to, anchor: l.anchor, location: l.location, nofollow: l.nofollow, crawled: crawled.has(l.to) });

/**
 * One request's links: those found on the page (`stored` is false when the list was not saved: an older snapshot, or beyond the
 * storage cap) and the crawled pages that link to its exact address (`linkedFrom.complete` is false when the stored link lists
 * hit the cap or are absent, so that list may be missing sources).
 */
export function crawlLogPage(snapshot: Snapshot, rawUrl: unknown) {
  const index = typeof rawUrl === 'string' ? snapshot.pages.findIndex((p) => p.url === rawUrl) : -1;
  if (index < 0) throw new SeoNotFoundError('That page is not in this crawl');
  const page = snapshot.pages[index]!;
  const raw = snapshot.rawLinks ?? [];
  const found = raw.filter((l) => l.from === page.url);
  const crawled = new Set(snapshot.pages.map((p) => p.url));
  const sources = [...new Set(raw.filter((l) => l.to === page.url && l.from !== page.url && crawled.has(l.from)).map((l) => l.from))];
  return {
    row: rowOf(page, index + 1),
    stored: page.internalLinks !== undefined && found.length >= page.internalLinks,
    linksFound: { total: found.length, links: found.slice(0, MAX_LIST).map((l) => linkView(l, crawled)) },
    linkedFrom: { total: sources.length, pages: sources.slice(0, MAX_LIST), complete: snapshot.rawLinks !== undefined && raw.length < MAX_STORED_LINKS },
  };
}
