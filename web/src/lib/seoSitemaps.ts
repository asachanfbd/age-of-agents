/** Pure view-models for the SEO Sitemaps tab: tags, the quota meter, selection and the IndexNow wording. */
import type { IndexingDto } from './seoPages';

export interface GscSitemapInfoDto { lastSubmitted: string | null; lastDownloaded: string | null; warnings: number | null; errors: number | null; submitted: number | null; indexed: number | null; isPending: boolean; type: string | null }
export interface SitemapDto {
  url: string;
  kind: 'index' | 'urlset' | 'unknown';
  parent: string | null;
  sources: Array<'gsc' | 'robots' | 'default' | 'index'>;
  status: 'ok' | 'fetch-failed' | 'malformed' | 'not-a-sitemap' | 'other-host';
  error: string | null;
  warnings: string[];
  warningCount: number;
  urlCount: number | null;
  showingFirst: number | null;
  otherHostCount: number;
  children: string[];
  fetchedAt: string | null;
  gsc: GscSitemapInfoDto | null;
}
export interface QuotaDto { day: string; used: number; limit: number; manualReserve: number; backgroundLimit: number; remaining: number; exhausted: boolean; resetsAt: string }
export interface SitemapsDto { notes: string[]; gsc: { state: 'connected' | 'not-connected' | 'error'; error: string | null }; siteUrl: string; lastReadAt: string | null; sitemaps: SitemapDto[]; quota: QuotaDto }

export type BingDto =
  | { state: 'not-connected' } | { state: 'unchecked' } | { state: 'unavailable'; checkedAt: string } | { state: 'not-found'; checkedAt: string }
  | { state: 'known'; checkedAt: string; discoveredAt: string | null; lastCrawledAt: string | null; httpCode: number | null };
export interface UrlRowDto {
  url: string;
  sitemaps: string[];
  lastmod: string | null;
  indexing: IndexingDto;
  indexNow: { lastSubmittedAt: string; result: string; httpStatus: number | null; message: string } | null;
  bing: BingDto;
}
export interface KeyFileDto { status: 'no-key' | 'reachable' | 'mismatch' | 'not-found' | 'redirected' | 'html' | 'timeout' | 'too-large' | 'error'; httpStatus: number | null; keyFileName: string | null; checkedAt: string | null }
export interface LogEntryDto { at: string; batchId: string; url: string; endpoint: string; httpStatus: number | null; result: 'accepted' | 'rejected' | 'error'; message: string }
export interface SubmitOutcomeDto { total: number; batches: number; accepted: number; rejected: number; errors: number; skippedOtherHost: number; keyFile: KeyFileDto['status']; keyFileWarning: boolean; retryAt: string | null }

export const INDEXNOW_NOTE = 'IndexNow only tells search engines that a page changed. It never reports whether a page was indexed, so there is no indexed status for it. A submission marked accepted means the request was received, not that the page appears in search.';
export const STATUS_AGE_NOTE = 'Indexing status comes from Google URL inspection and can be hours or days old; the time next to each status says when it was checked.';

export interface Tag { label: string; tone: 'good' | 'warning' | 'bad' | 'muted' }

export function sitemapTags(s: SitemapDto): Tag[] {
  const tags: Tag[] = [];
  if (s.status === 'fetch-failed') tags.push({ label: 'Fetch failed', tone: 'bad' });
  else if (s.status === 'malformed') tags.push({ label: 'Malformed XML', tone: 'bad' });
  else if (s.status === 'not-a-sitemap') tags.push({ label: 'Not a sitemap', tone: 'bad' });
  else if (s.status === 'other-host') tags.push({ label: 'Other host', tone: 'warning' });
  else if (s.warningCount > 0) tags.push({ label: `${s.warningCount} warning${s.warningCount === 1 ? '' : 's'}`, tone: 'warning' });
  else tags.push({ label: 'OK', tone: 'good' });
  if (s.gsc && s.gsc.errors) tags.push({ label: `${s.gsc.errors} GSC error${s.gsc.errors === 1 ? '' : 's'}`, tone: 'bad' });
  if (s.gsc && s.gsc.warnings) tags.push({ label: `${s.gsc.warnings} GSC warning${s.gsc.warnings === 1 ? '' : 's'}`, tone: 'warning' });
  if (!s.gsc) tags.push({ label: 'Not in GSC', tone: 'muted' });
  if (s.showingFirst !== null) tags.push({ label: `Showing first ${s.showingFirst.toLocaleString('en-US')}`, tone: 'warning' });
  if (s.otherHostCount > 0) tags.push({ label: `${s.otherHostCount} on other hosts (not counted)`, tone: 'warning' });
  return tags;
}

export const typeLabel = (s: SitemapDto) => (s.kind === 'index' ? 'Index' : s.kind === 'urlset' ? 'Sitemap' : 'Unknown');
export const countLabel = (value: number | null) => (value === null ? 'no data' : value.toLocaleString('en-US'));

/** Submitted vs indexed counts as Google gives them; either may be missing, which reads as "no data". */
export const submittedIndexedLabel = (s: SitemapDto) => (s.gsc ? `${countLabel(s.gsc.submitted)} submitted · ${countLabel(s.gsc.indexed)} indexed` : 'Connect GSC to see this');

export interface QuotaMeter { used: number; limit: number; percent: number; reserveText: string; statusText: string; resetText: string }

export function quotaMeter(q: QuotaDto): QuotaMeter {
  return {
    used: q.used, limit: q.limit, percent: Math.min(100, Math.round((q.used / q.limit) * 100)),
    reserveText: `Background inspection stops at ${q.backgroundLimit.toLocaleString('en-US')}; the last ${q.manualReserve} are kept for your own requests.`,
    statusText: q.exhausted ? 'Quota used up for today. Queued URLs are waiting for quota.' : `${q.remaining.toLocaleString('en-US')} left today`,
    resetText: `Resets ${new Date(q.resetsAt).toLocaleString()}`,
  };
}

export function urlStatusTag(i: IndexingDto): Tag {
  if (i.waitingForQuota) return { label: 'Waiting for quota (resumes tomorrow)', tone: 'warning' };
  if (i.state === 'indexed') return { label: 'Indexed', tone: 'good' };
  if (i.state === 'not-indexed') return { label: i.reason ? `Not indexed: ${i.reason}` : 'Not indexed', tone: 'bad' };
  if (i.state === 'unknown') return { label: i.raw ? `Unknown (Google said: ${i.raw})` : 'Unknown', tone: 'muted' };
  return { label: 'Not inspected yet', tone: 'muted' };
}

/** "Never", "3 hours ago", "5 days ago", or the date once it is older than 11 days. */
export function lastInspectedLabel(inspectedAt: string | null, now: Date): string {
  if (!inspectedAt) return 'Never inspected';
  const ms = now.getTime() - Date.parse(inspectedAt);
  if (!(ms >= 0)) return 'Just now';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'Less than an hour ago';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return days <= 11 ? `${days} day${days === 1 ? '' : 's'} ago` : inspectedAt.slice(0, 10);
}

export function bingCell(b: BingDto): string {
  if (b.state === 'not-connected') return 'Not connected';
  if (b.state === 'unchecked') return 'Not checked';
  if (b.state === 'unavailable') return 'Unavailable';
  if (b.state === 'not-found') return 'Bing has not seen this URL';
  return `Known to Bing${b.lastCrawledAt ? `, crawled ${b.lastCrawledAt.slice(0, 10)}` : ''}${b.httpCode ? ` (HTTP ${b.httpCode})` : ''}`;
}

export function selectionActions(count: number, quota: QuotaDto | null) {
  return {
    inspectLabel: count ? `Inspect ${count} selected` : 'Inspect selected',
    inspectDisabled: count === 0 || (quota?.exhausted ?? false),
    submitLabel: count ? `Submit ${count} to IndexNow` : 'Submit selected to IndexNow',
    submitDisabled: count === 0,
  };
}

/** Selection is cleared whenever the visible list changes, so a click never acts on rows the person can no longer see. */
export const toggle = (selected: ReadonlySet<string>, url: string): Set<string> => { const next = new Set(selected); if (next.has(url)) next.delete(url); else next.add(url); return next; };

export const BATCH_SIZE = 10_000;
export const MAX_BING_CHECK = 50;

/** The URLs a "submit whole sitemap" sends: its own count, or for an index the sum over everything below it (shared URLs may make the real number a little lower). */
export function submissionCount(root: SitemapDto, all: readonly SitemapDto[]): number {
  const byUrl = new Map(all.map((s) => [s.url, s]));
  const seen = new Set<string>();
  const walk = (s: SitemapDto): number => {
    if (seen.has(s.url)) return 0;
    seen.add(s.url);
    return (s.urlCount ?? 0) + s.children.reduce((n, c) => n + (byUrl.has(c) ? walk(byUrl.get(c)!) : 0), 0);
  };
  return walk(root);
}

/** "Check Bing" works on the selected rows, 50 at a time, and only when Bing is connected. */
export function bingAction(selectedCount: number, rows: ReadonlyArray<Pick<UrlRowDto, 'bing'>>) {
  const connected = rows.some((r) => r.bing.state !== 'not-connected');
  return { visible: connected, disabled: selectedCount === 0 || selectedCount > MAX_BING_CHECK, label: selectedCount > MAX_BING_CHECK ? `Check Bing (select at most ${MAX_BING_CHECK})` : selectedCount ? `Check ${selectedCount} in Bing` : 'Check Bing' };
}

export function confirmText(input: { mode: 'selected' | 'sitemap' | 'new-or-changed'; count: number }): string {
  const batches = Math.ceil(input.count / BATCH_SIZE);
  const split = batches > 1 ? ` It will be sent in ${batches} requests of up to ${BATCH_SIZE.toLocaleString('en-US')} URLs.` : '';
  const what = input.mode === 'sitemap' ? `all ${input.count.toLocaleString('en-US')} URLs of this sitemap` : input.mode === 'new-or-changed' ? `${input.count.toLocaleString('en-US')} new or changed URLs` : `${input.count} selected URL${input.count === 1 ? '' : 's'}`;
  return `Send ${what} to IndexNow? This only notifies search engines; it does not confirm indexing.${split}`;
}

const KEY_TAGS: Record<KeyFileDto['status'], Tag> = {
  'no-key': { label: 'No key saved', tone: 'warning' },
  reachable: { label: 'Key file reachable', tone: 'good' },
  mismatch: { label: 'Key file found but its content does not match the key', tone: 'bad' },
  'not-found': { label: 'Key file not reachable (404)', tone: 'bad' },
  redirected: { label: 'Key file redirects to another host', tone: 'bad' },
  html: { label: 'Key address returns a web page, not the key', tone: 'bad' },
  timeout: { label: 'Key file check timed out', tone: 'warning' },
  'too-large': { label: 'Key file is too large', tone: 'bad' },
  error: { label: 'Key file could not be checked', tone: 'warning' },
};
export const keyFileTag = (status: KeyFileDto['status'] | 'checking'): Tag => (status === 'checking' ? { label: 'Checking…', tone: 'muted' } : KEY_TAGS[status]);

export function keyFileGuidance(k: KeyFileDto | null): string {
  if (!k || k.status === 'no-key') return 'Save an IndexNow key in Settings → Connections, then publish a text file named after the key at your site root containing only the key.';
  if (k.status === 'reachable') return 'IndexNow can verify ownership of this site.';
  return `Publish a text file at your site root named ${k.keyFileName ?? '<key>.txt'} (the full name is the key in Settings → Connections) containing only the key. Submissions still go out, but IndexNow may reject them until it can read the file.`;
}

export function logEntryLabel(e: LogEntryDto): string {
  if (e.result === 'accepted') return 'Accepted (not an indexing confirmation)';
  return e.result === 'rejected' ? `Rejected: ${e.message.replace(/^Rejected:?\s*/, '')}` : `Error: ${e.message}`;
}

export const SITEMAP_SOURCE_LABELS: Record<SitemapDto['sources'][number], string> = { gsc: 'Search Console', robots: 'robots.txt', default: 'Default location', index: 'Sitemap index' };
