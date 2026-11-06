import { getStore } from '../buildings/buildingStorage.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import type { ReplaceStep } from '../buildings/contract.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, SeoUpstreamError, ServiceError } from './errors.ts';
import { inflateIfGzip, limitedFetch, LimitedFetchError } from './limitedFetch.ts';
import { ALL_SITEMAPS, runCoalesced } from './runCoalescer.ts';
import type { GscSitemap } from './services.ts';
import { gscPropertyOf, settingsOf, siteOrigin, withGsc } from './siteAccess.ts';
import { parseRobotsSitemaps, parseSitemap, SitemapParseError } from './sitemapParse.ts';
import { isSiteHost, normalizePageUrl } from './urls.ts';

export type SitemapSource = 'gsc' | 'robots' | 'default' | 'index';
export type SitemapStatus = 'ok' | 'fetch-failed' | 'malformed' | 'not-a-sitemap' | 'other-host';

export interface GscSitemapInfo {
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  warnings: number | null;
  errors: number | null;
  submitted: number | null;
  indexed: number | null;
  isPending: boolean;
  type: string | null;
}

/** Everything known about one sitemap, stored whole as JSON in `seo_sitemaps`. A value is null when the source did not give one. */
export interface SitemapRecord {
  url: string;
  kind: 'index' | 'urlset' | 'unknown';
  parent: string | null;
  sources: SitemapSource[];
  status: SitemapStatus;
  error: string | null;
  /** The first few warnings in words; `warningCount` counts all of them. */
  warnings: string[];
  warningCount: number;
  urlCount: number | null;
  /** Set when the file listed more URLs than are kept: only the first N are shown and counted. */
  showingFirst: number | null;
  otherHostCount: number;
  children: string[];
  fetchedAt: string | null;
  previousFetchedAt: string | null;
  gsc: GscSitemapInfo | null;
}

const MAX_WARNING_TEXTS = 20;
const MAX_DEPTH = 3;
const ROBOTS_MAX_BYTES = 512 * 1024;
const DEFAULT_SITEMAP_PATH = '/sitemap.xml';

/** The address a sitemap is stored under: as written, without a fragment. */
export function canonicalSitemapUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export async function readSitemapRecords(store: BulkStore): Promise<SitemapRecord[]> {
  const { rows } = await store.groupSums({ source: 'seo_sitemaps', groupBy: ['url', 'data'], orderBy: 'url', dir: 'asc' });
  return rows.map((r) => JSON.parse(String(r.data)) as SitemapRecord);
}

const toGscInfo = (s: GscSitemap): GscSitemapInfo => ({
  lastSubmitted: s.lastSubmitted, lastDownloaded: s.lastDownloaded, warnings: s.warnings, errors: s.errors, submitted: s.submitted, indexed: s.indexed, isPending: s.isPending, type: s.type,
});

interface Context {
  project: ProjectRecord;
  store: BulkStore;
  siteUrl: string;
  property: string | null;
  now: string;
  /** Records written or seen in this run, by address. */
  seen: Map<string, SitemapRecord>;
  existing: Map<string, SitemapRecord>;
  /** What Search Console says per sitemap in a full read; undefined when it was not asked or failed, which keeps what was stored. */
  gscInfo?: Map<string, GscSitemapInfo>;
  filesRead: number;
  filesCapped: boolean;
  robotsUnreachable?: boolean;
}

type Loaded = { ok: true; parsed: ReturnType<typeof parseSitemap> } | { ok: false; status: 'fetch-failed' | 'malformed' | 'not-a-sitemap'; error: string };

async function loadSitemap(url: string): Promise<Loaded> {
  const { limits } = seoDeps();
  const host = new URL(url).hostname;
  let body: Buffer;
  try {
    const res = await limitedFetch(url, { maxBytes: limits.sitemapBytes, timeoutMs: limits.fetchTimeoutMs, allowRedirect: (next) => new URL(next).hostname === host });
    if (res.status !== 200) return { ok: false, status: 'fetch-failed', error: `The site answered HTTP ${res.status}` };
    body = await inflateIfGzip(res.body, limits.sitemapBytes);
  } catch (error) {
    if (error instanceof LimitedFetchError) return { ok: false, status: 'fetch-failed', error: `Could not read the sitemap: ${error.message}` };
    throw error;
  }
  try {
    return { ok: true, parsed: parseSitemap(body.toString('utf8'), limits.sitemapUrls) };
  } catch (error) {
    if (!(error instanceof SitemapParseError)) throw error;
    return { ok: false, status: error.message.startsWith('This is not a sitemap') ? 'not-a-sitemap' : 'malformed', error: error.message };
  }
}

const blankRecord = (url: string, parent: string | null, sources: SitemapSource[]): SitemapRecord => ({
  url, kind: 'unknown', parent, sources, status: 'ok', error: null, warnings: [], warningCount: 0, urlCount: null, showingFirst: null, otherHostCount: 0,
  children: [], fetchedAt: null, previousFetchedAt: null, gsc: null,
});

const addSource = (list: SitemapSource[], source: SitemapSource) => (list.includes(source) ? list : [...list, source]);

function warn(record: SitemapRecord, message: string): void {
  record.warningCount++;
  if (record.warnings.length < MAX_WARNING_TEXTS) record.warnings.push(message);
}

async function persist(ctx: Context, record: SitemapRecord, urls: Array<[string, string]> | null): Promise<void> {
  const steps: Parameters<BulkStore['replaceRows']>[0] = [{ table: 'seo_sitemaps', where: { url: record.url }, rows: [[record.url, JSON.stringify(record)]] }];
  if (urls) {
    const { rows: known } = await ctx.store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['url', 'firstSeen'], where: { sitemap: record.url } });
    const firstSeen = new Map(known.map((r) => [String(r.url), String(r.firstSeen)]));
    steps.push({ table: 'seo_sitemap_urls', where: { sitemap: record.url }, rows: urls.map(([url, lastmod]) => [record.url, url, lastmod, firstSeen.get(url) ?? ctx.now]) });
  }
  await ctx.store.replaceRows(steps);
  ctx.seen.set(record.url, record);
}

/** Reads one sitemap file (and, for an index, its children) and stores what it found. */
async function readOne(ctx: Context, url: string, parent: string | null, sources: SitemapSource[], depth: number): Promise<void> {
  if (ctx.seen.has(url)) {
    const again = ctx.seen.get(url)!;
    again.sources = [...new Set([...again.sources, ...sources])];
    await persist(ctx, again, null);
    return;
  }
  const previous = ctx.existing.get(url);
  const record: SitemapRecord = { ...blankRecord(url, parent, sources), gsc: (ctx.gscInfo ? ctx.gscInfo.get(url) : previous?.gsc) ?? null, previousFetchedAt: previous?.fetchedAt ?? null };
  ctx.seen.set(url, record);

  const probe = normalizePageUrl(url);
  if (!probe || !isSiteHost(probe, ctx.siteUrl, ctx.property)) {
    record.status = 'other-host';
    record.error = 'This sitemap is on a different host than the site, so it was not read.';
    await persist(ctx, record, null);
    return;
  }
  if (ctx.filesRead >= seoDeps().limits.sitemapFiles) {
    ctx.filesCapped = true;
    ctx.seen.delete(url);
    return;
  }
  ctx.filesRead++;
  const loaded = await loadSitemap(url);
  record.fetchedAt = ctx.now;
  if (!loaded.ok) {
    Object.assign(record, { status: loaded.status, error: loaded.error });
    await persist(ctx, record, null);
    return;
  }
  const { parsed } = loaded;
  record.kind = parsed.kind;
  if (parsed.kind === 'index') await readChildren(ctx, record, parsed.entries.map((e) => e.loc), depth);
  else await readUrls(ctx, record, parsed);
}

async function readChildren(ctx: Context, record: SitemapRecord, locs: string[], depth: number): Promise<void> {
  const children: string[] = [];
  for (const loc of locs) {
    const child = canonicalSitemapUrl(loc);
    const probe = child ? normalizePageUrl(child) : null;
    if (!child || !probe) warn(record, `Ignored an invalid sitemap address: ${loc.slice(0, 120)}`);
    else if (!isSiteHost(probe, ctx.siteUrl, ctx.property)) { record.otherHostCount++; warn(record, `Ignored a sitemap on another host: ${child.slice(0, 120)}`); } else if (!children.includes(child)) children.push(child);
  }
  record.children = children;
  record.urlCount = null;
  await persist(ctx, record, null);
  if (depth + 1 > MAX_DEPTH) { warn(record, `Sitemaps nested more than ${MAX_DEPTH} levels deep are not read.`); await persist(ctx, record, null); return; }
  for (const child of children) await readOne(ctx, child, record.url, ['index'], depth + 1);
  if (ctx.filesCapped) { warn(record, `Only the first ${seoDeps().limits.sitemapFiles} sitemap files are read.`); await persist(ctx, record, null); }
}

async function readUrls(ctx: Context, record: SitemapRecord, parsed: ReturnType<typeof parseSitemap>): Promise<void> {
  const kept = new Map<string, string>();
  for (const entry of parsed.entries) {
    const url = normalizePageUrl(entry.loc);
    if (!url) { warn(record, `Ignored an invalid address: ${entry.loc.slice(0, 120) || '(empty)'}`); continue; }
    if (!isSiteHost(url, ctx.siteUrl, ctx.property)) { record.otherHostCount++; warn(record, `Not counted, on another host: ${entry.loc.slice(0, 120)}`); continue; }
    if (!kept.has(url)) kept.set(url, entry.lastmod ?? '');
  }
  record.urlCount = kept.size;
  record.showingFirst = parsed.truncated ? parsed.entries.length : null;
  if (parsed.truncated) warn(record, `The file lists more than ${parsed.entries.length.toLocaleString('en-US')} URLs; only the first ${parsed.entries.length.toLocaleString('en-US')} are read.`);
  await persist(ctx, record, [...kept.entries()]);
}

interface Discovered { url: string; sources: SitemapSource[] }

async function discover(ctx: Context, gscListed: GscSitemap[]): Promise<Discovered[]> {
  const found = new Map<string, SitemapSource[]>();
  const add = (raw: string, source: SitemapSource) => {
    const url = canonicalSitemapUrl(raw);
    if (url) found.set(url, addSource(found.get(url) ?? [], source));
  };
  for (const s of gscListed) add(s.path, 'gsc');
  const origin = new URL(ctx.siteUrl).origin;
  const notes: string[] = [];
  const robots = await fetchText(`${origin}/robots.txt`, ROBOTS_MAX_BYTES);
  if (robots.state === 'text') {
    const parsed = parseRobotsSitemaps(robots.text);
    for (const url of parsed.urls) add(url, 'robots');
    for (const ignored of parsed.ignored) notes.push(`robots.txt lists "${ignored.slice(0, 120)}", which is not a full address, so it was ignored.`);
  } else if (robots.state === 'unreachable') {
    // Unknown is not "none": sitemaps found through robots.txt before are kept and read again from the address stored for them.
    ctx.robotsUnreachable = true;
    notes.push('robots.txt could not be read, so sitemaps listed only there were kept as they were.');
    for (const record of ctx.existing.values()) if (record.sources.includes('robots')) add(record.url, 'robots');
  }
  robotsNotes.set(ctx.project.id, notes);
  add(`${origin}${DEFAULT_SITEMAP_PATH}`, 'default');
  return [...found.entries()].map(([url, sources]) => ({ url, sources }));
}

type TextResult = { state: 'text'; text: string } | { state: 'missing' } | { state: 'unreachable' };

/** A small file on the site: its text, missing (404 or 410, so really "none"), or unreachable (an error, timeout or oversize answer, so "unknown"). */
async function fetchText(url: string, maxBytes: number): Promise<TextResult> {
  const host = new URL(url).hostname;
  try {
    const res = await limitedFetch(url, { maxBytes, timeoutMs: seoDeps().limits.fetchTimeoutMs, allowRedirect: (next) => new URL(next).hostname === host });
    if (res.status === 200) return { state: 'text', text: res.body.toString('utf8') };
    return res.status === 404 || res.status === 410 ? { state: 'missing' } : { state: 'unreachable' };
  } catch (error) {
    if (error instanceof LimitedFetchError) return { state: 'unreachable' };
    throw error;
  }
}

export interface SitemapsRun { read: number; found: number; gsc: 'connected' | 'not-connected' | 'error'; gscError: string | null; capped: boolean }

const gscErrors = new Map<string, string>();
/** What the last full read noticed about robots.txt (ignored lines, unreachable), shown above the list. */
const robotsNotes = new Map<string, string[]>();

/**
 * Finds every sitemap (submitted in Search Console, listed in robots.txt, at the default address) and reads each one and the
 * children of every index. A default-address sitemap that does not exist is not listed; one that Search Console or robots.txt
 * names but cannot be read is listed with its error. Sitemaps that are no longer found are removed.
 */
export function refreshSitemaps(project: ProjectRecord): Promise<SitemapsRun> {
  return runCoalesced(project.id, ALL_SITEMAPS, 'read-all', () => refreshAll(project));
}

async function context(project: ProjectRecord): Promise<Context> {
  const settings = await settingsOf(project);
  const store = await getStore(project);
  const existing = new Map((await readSitemapRecords(store)).map((r) => [r.url, r]));
  return { project, store, siteUrl: siteOrigin(settings), property: gscPropertyOf(settings), now: seoDeps().now().toISOString(), seen: new Map(), existing, filesRead: 0, filesCapped: false };
}

async function refreshAll(project: ProjectRecord): Promise<SitemapsRun> {
  const ctx = await context(project);
  let gscListed: GscSitemap[] = [];
  let gsc: SitemapsRun['gsc'] = ctx.property ? 'connected' : 'not-connected';
  let gscError: string | null = null;
  if (ctx.property) {
    try {
      gscListed = await withGsc(project, (token, property) => seoDeps().services.gsc.listSitemaps(token, property));
      gscErrors.delete(project.id);
      ctx.gscInfo = new Map(gscListed.map((s) => [canonicalSitemapUrl(s.path) ?? s.path, toGscInfo(s)]));
    } catch (error) {
      if (!(error instanceof ServiceError) && !(error instanceof SeoUpstreamError)) throw error;
      gsc = 'error';
      gscError = error.message;
      gscErrors.set(project.id, gscError);
    }
  } else ctx.gscInfo = new Map();
  const roots = await discover(ctx, gscListed);
  for (const root of roots) {
    await readOne(ctx, root.url, null, root.sources, 0);
    // The default address is only listed when something is really there, so a site without sitemap.xml shows no phantom error row.
    const record = ctx.seen.get(root.url);
    if (record && root.sources.length === 1 && root.sources[0] === 'default' && (record.status === 'fetch-failed' || record.status === 'not-a-sitemap')) {
      ctx.seen.delete(root.url);
      await removeSitemaps(ctx.store, [root.url]);
    }
  }
  const removed = [...ctx.existing.keys()].filter((url) => !ctx.seen.has(url) && !(gsc === 'error' && ctx.existing.get(url)!.sources.includes('gsc')) && !(ctx.robotsUnreachable && ctx.existing.get(url)!.sources.includes('robots')));
  if (removed.length) await removeSitemaps(ctx.store, removed);
  return { read: ctx.filesRead, found: ctx.seen.size, gsc, gscError, capped: ctx.filesCapped };
}

const removeSitemaps = (store: BulkStore, urls: string[]) => store.replaceRows(urls.flatMap((url): ReplaceStep[] => [
  { table: 'seo_sitemaps', where: { url }, rows: [] }, { table: 'seo_sitemap_urls', where: { sitemap: url }, rows: [] },
]));

/** Reads one sitemap again, with its children when it is an index. */
export function rereadSitemap(project: ProjectRecord, sitemap: unknown): Promise<SitemapsRun> {
  const url = typeof sitemap === 'string' ? canonicalSitemapUrl(sitemap) : null;
  if (!url) throw new SeoInputError('sitemap must be the address of a sitemap');
  return runCoalesced(project.id, url, 'read', async () => {
    const ctx = await context(project);
    const known = ctx.existing.get(url);
    if (!known) throw new SeoConflictError('That sitemap is not in the list; read all sitemaps first');
    ctx.seen.clear();
    await readOne(ctx, url, known.parent, known.sources, known.parent ? 1 : 0);
    return { read: ctx.filesRead, found: ctx.seen.size, gsc: ctx.property ? 'connected' : 'not-connected', gscError: null, capped: ctx.filesCapped };
  });
}

export async function sitemapsView(project: ProjectRecord) {
  const settings = await settingsOf(project);
  const store = await getStore(project);
  const records = await readSitemapRecords(store);
  const property = gscPropertyOf(settings);
  const sorted = [...records].sort((a, b) => Number(a.parent !== null) - Number(b.parent !== null) || (a.url < b.url ? -1 : 1));
  return {
    gsc: { state: property ? (gscErrors.has(project.id) ? 'error' : 'connected') : 'not-connected', error: gscErrors.get(project.id) ?? null },
    siteUrl: settings.siteUrl,
    notes: robotsNotes.get(project.id) ?? [],
    lastReadAt: records.reduce<string | null>((latest, r) => (r.fetchedAt && (!latest || r.fetchedAt > latest) ? r.fetchedAt : latest), null),
    sitemaps: sorted,
  };
}

export function forgetSitemapState(buildingId: string): void {
  gscErrors.delete(buildingId);
  robotsNotes.delete(buildingId);
}
