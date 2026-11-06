import { getStore } from '../../buildings/buildingStorage.ts';
import type { ProjectRecord } from '../../domain/types.ts';
import { seoDeps } from '../deps.ts';
import { SeoConflictError } from '../errors.ts';
import { raiseNotification, resolveNotifications } from '../../notifications/notificationService.ts';
import { beginJob, endJob, progressJob } from '../jobs.ts';
import { refreshSitemaps } from '../sitemaps.ts';
import { settingsOf } from '../siteAccess.ts';
import { analyse } from './analysis.ts';
import { abortableSleep, fetchPage, isHtml } from './fetchPage.ts';
import { parseHtml } from './parse.ts';
import { ALLOW_ALL, parseRobots } from './robots.ts';
import type { RobotsRules } from './robots.ts';
import { crawlWarning, storedLinks } from './crawlLog.ts';
import { CRAWL_USER_AGENT, isUrlSpaceTrap, paceMs } from './rules.ts';
import type { CrawlSettings } from './rules.ts';
import { CrawlSite } from './site.ts';
import { deleteWork, newSnapshotId, pruneSnapshots, readCrawlSettings, readRun, readWork, writeRun, writeSnapshot, writeWork } from './store.ts';
import type { PageRecord, RawLink, RunView, Snapshot, WorkState } from './types.ts';

const PERSIST_EVERY = 25;
const ROBOTS_HOPS = 5;
const ORIGIN_HOPS = 2;
export const KEPT_SNAPSHOTS = 10;

interface Live { controller: AbortController; view: RunView; promise: Promise<void> }
const live = new Map<string, Live>();
/** Final state of runs that could not be written to disk, so they read as failed rather than interrupted. */
const unsaved = new Map<string, RunView>();

class CrawlRefused extends Error {}

/** A start while a crawl runs; the 409 body carries `code` and `details.runId` so the web can switch to that run. */
class CrawlRunningError extends SeoConflictError {
  readonly code = 'crawl-running';
}

export const hasLiveCrawl = (buildingId: string) => live.has(buildingId);

/** Resolves when the Building's running crawl (if any) has saved its snapshot. */
export async function waitForCrawl(buildingId: string): Promise<void> {
  await live.get(buildingId)?.promise;
}

async function seedUrls(project: ProjectRecord, site: CrawlSite): Promise<string[]> {
  const store = await getStore(project);
  const { rows } = await store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['url'] });
  const keys = new Set<string>();
  for (const r of rows) {
    const key = site.keyOf(String(r.url), site.origin);
    if (key && site.isInternal(key)) keys.add(key);
  }
  return [...keys].sort();
}

async function hasSitemapUrls(project: ProjectRecord): Promise<boolean> {
  const store = await getStore(project);
  const { rows } = await store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['url'] });
  return rows.length > 0;
}

/**
 * A new crawl needs the sitemap URLs to seed from; when none are stored they are fetched first rather than silently crawling the
 * home page alone. A failed read is not fatal: the crawl then starts from the home page. `refreshSitemaps` takes no abort signal,
 * so a Stop is only noticed once the read ends (bounded by the sitemap fetch timeout).
 */
async function ensureSitemaps(project: ProjectRecord, signal: AbortSignal): Promise<void> {
  if (await hasSitemapUrls(project)) return;
  await refreshSitemaps(project).catch(() => undefined);
  if (signal.aborted) throw new DOMException('stopped', 'AbortError');
}

/** robots.txt: a missing file (4xx) allows everything; a server error or no answer refuses the crawl, as crawlers must not guess. */
async function loadRobots(site: CrawlSite, timeoutMs: number, signal: AbortSignal): Promise<RobotsRules> {
  const { sleep, now } = seoDeps();
  let url = `${site.origin}/robots.txt`;
  for (let hop = 0; hop <= ROBOTS_HOPS; hop++) {
    const res = await fetchPage(url, CRAWL_USER_AGENT, { timeoutMs, maxBytes: 512 * 1024, signal, sleep, now, anyType: true });
    if (res.status !== null && res.status >= 300 && res.status < 400 && res.location) {
      const key = site.keyOf(res.location, url);
      if (!key || !site.isInternal(key)) return ALLOW_ALL;
      site.adoptOrigin(res.location, url);
      url = site.fetchUrl(key);
      continue;
    }
    if (res.status !== null && res.status >= 200 && res.status < 300 && res.html !== null) return parseRobots(url, res.html);
    if (res.status !== null && res.status >= 400 && res.status < 500) return ALLOW_ALL;
    throw new CrawlRefused('The crawl was not started because robots.txt could not be read (the site did not answer properly). Try again later.');
  }
  return ALLOW_ALL;
}

class Crawl {
  readonly pages: PageRecord[];
  readonly rawLinks: RawLink[];
  readonly seen: Set<string>;
  readonly queue: string[];
  readonly queryVariants: Map<string, number>;
  readonly discoveredFrom: Map<string, string | null>;
  skippedUrlSpace: number;
  used = 0;
  failed = 0;
  fetched = 0;
  #lastStart = 0;
  #sinceSave = 0;

  readonly buildingId: string;
  readonly entry: Live;
  readonly site: CrawlSite;
  readonly settings: CrawlSettings;
  readonly work: WorkState;

  constructor(buildingId: string, entry: Live, site: CrawlSite, settings: CrawlSettings, work: WorkState) {
    this.buildingId = buildingId;
    this.entry = entry;
    this.site = site;
    this.settings = settings;
    this.work = work;
    this.pages = work.pages;
    this.rawLinks = work.rawLinks;
    this.seen = new Set(work.seen);
    this.queue = work.queue;
    this.queryVariants = new Map(work.queryVariants);
    this.discoveredFrom = new Map(work.discoveredFrom ?? []);
    this.skippedUrlSpace = work.skippedUrlSpace;
    for (const p of this.pages) this.#count(p);
  }

  #count(page: PageRecord) {
    if (page.error === 'robots') return;
    this.used += 1;
    if (page.error) this.failed += 1; else this.fetched += 1;
  }

  /** `from` is 'sitemap', the linking or redirecting page, or null for the start page; only the first discoverer is kept. */
  enqueue(url: string, from: string | null) {
    if (this.seen.has(url) || this.queue.length >= this.settings.pageCap) return;
    this.seen.add(url);
    this.discoveredFrom.set(url, from);
    this.queue.push(url);
  }

  async #pace(robots: RobotsRules, signal: AbortSignal) {
    const { sleep, now } = seoDeps();
    const delay = Math.max(paceMs(this.settings.requestsPerSecond), robots.crawlDelayMs);
    const wait = this.#lastStart ? delay - (now().getTime() - this.#lastStart) : 0;
    if (wait > 0) await abortableSleep(sleep, wait, signal);
    this.#lastStart = now().getTime();
  }

  async run(robots: RobotsRules): Promise<void> {
    const { sleep, now } = seoDeps();
    const signal = this.entry.controller.signal;
    while (this.queue.length && this.used < this.settings.pageCap) {
      if (signal.aborted) throw new DOMException('stopped', 'AbortError');
      // Left on the queue until its page is recorded, so a Stop during the fetch cannot lose it.
      const url = this.queue[0]!;
      if (!robots.allows(this.site.fetchUrl(url))) {
        this.pages.push(blankPage(url, now(), { discoveredFrom: this.discoveredFrom.get(url), error: 'robots' }));
        this.queue.shift();
        continue;
      }
      const fetched = await this.#fetch(url, robots, signal);
      if (!fetched) {
        this.pages.push(blankPage(url, now(), { discoveredFrom: this.discoveredFrom.get(url), error: 'robots' }));
        this.queue.shift();
        continue;
      }
      const { res, fetchUrl } = fetched;
      const page = blankPage(url, now(), { discoveredFrom: this.discoveredFrom.get(url), status: res.status, error: res.error, contentType: res.contentType?.split(';')[0]?.trim().toLowerCase() ?? null });
      this.#record(page, res, fetchUrl);
      this.pages.push(page);
      this.queue.shift();
      this.#count(page);
      this.#publish();
      if (++this.#sinceSave >= PERSIST_EVERY) { this.#sinceSave = 0; await this.save(); }
    }
  }

  /**
   * Fetches a page, re-requesting the literal `Location` while a redirect only reveals the site's real scheme, `www.` variant or
   * trailing-slash form of the same page (see `CrawlSite.sameKeyRedirect`). Returns null when robots.txt blocks a re-request.
   */
  async #fetch(url: string, robots: RobotsRules, signal: AbortSignal) {
    const { sleep, now } = seoDeps();
    const options = { timeoutMs: this.settings.timeoutSeconds * 1000, maxBytes: Math.floor(this.settings.pageSizeMb * 1024 * 1024), signal, sleep, now };
    let fetchUrl = this.site.fetchUrl(url);
    for (let attempt = 0; ; attempt++) {
      await this.#pace(robots, signal);
      const res = await fetchPage(fetchUrl, CRAWL_USER_AGENT, options);
      const redirected = res.status !== null && res.status >= 300 && res.status < 400 && res.location;
      const next = redirected && attempt < ORIGIN_HOPS ? this.site.sameKeyRedirect(res.location!, fetchUrl, url) : null;
      if (!next) return { res, fetchUrl };
      if (!robots.allows(next)) return null;
      fetchUrl = next;
    }
  }

  #record(page: PageRecord, res: Awaited<ReturnType<typeof fetchPage>>, fetchUrl: string) {
    if (res.status !== null && res.status >= 300 && res.status < 400 && res.location) {
      const target = this.site.keyOf(res.location, fetchUrl);
      if (target) {
        page.redirectTo = target;
        page.redirectExternal = !this.site.isInternal(target);
        if (!page.redirectExternal) this.#discover(target, page.url);
      }
      return;
    }
    if (res.html === null || !isHtml(res.contentType)) return;
    const parsed = parseHtml(res.html, fetchUrl, this.site, res.xRobots);
    Object.assign(page, { title: parsed.title, description: parsed.description, canonical: parsed.canonical, noindex: parsed.noindex, externalLinks: parsed.externalCount, internalLinks: parsed.links.length });
    for (const link of parsed.links) {
      this.rawLinks.push({ from: page.url, to: link.target, anchor: link.anchor, nofollow: link.nofollow, location: link.location });
      this.#discover(link.target, page.url);
    }
  }

  #discover(url: string, from: string) {
    if (this.seen.has(url)) return;
    if (isUrlSpaceTrap(url, this.queryVariants)) { this.skippedUrlSpace += 1; this.seen.add(url); return; }
    this.enqueue(url, from);
  }

  #publish() {
    Object.assign(this.entry.view, { fetched: this.fetched, failed: this.failed, queued: this.queue.length });
    progressJob(this.entry.view.runId, { fetched: this.fetched, queued: this.queue.length, failed: this.failed });
  }

  state(): WorkState {
    return { ...this.work, queue: this.queue, seen: [...this.seen], discoveredFrom: [...this.discoveredFrom], pages: this.pages, rawLinks: this.rawLinks, skippedUrlSpace: this.skippedUrlSpace, queryVariants: [...this.queryVariants] };
  }

  async save() {
    this.#publish();
    await writeWork(this.buildingId, this.state());
    await writeRun(this.buildingId, this.entry.view);
  }

  snapshot(status: 'complete' | 'partial', stopReason: Snapshot['stopReason'], finishedAt: Date): Snapshot {
    const analysis = analyse(this.pages, this.rawLinks, this.work.sitemapUrls, this.site.homeKey);
    const nodes = analysis.pages;
    return {
      id: this.work.snapshotId, startedAt: this.work.startedAt, finishedAt: finishedAt.toISOString(), status, stopReason,
      capped: status === 'complete' && this.queue.length > 0, incomplete: analysis.incomplete, host: this.site.host, seededFrom: this.work.seededFrom, settings: this.settings,
      stats: {
        pages: nodes.length, fetched: this.fetched, failed: this.failed, blockedByRobots: nodes.filter((p) => p.error === 'robots').length,
        skippedUrlSpace: this.skippedUrlSpace, links: analysis.links.length, externalLinks: nodes.reduce((t, p) => t + p.externalLinks, 0), uncrawledLinks: analysis.uncrawledLinks,
      },
      warning: crawlWarning(nodes),
      pages: nodes, links: analysis.links, rawLinks: storedLinks(this.rawLinks),
    };
  }
}

function blankPage(url: string, at: Date, patch: Partial<PageRecord>): PageRecord {
  return {
    url, status: null, redirectTo: null, redirectExternal: false, contentType: null, title: null, description: null, canonical: null, noindex: false, error: null,
    externalLinks: 0, fetchedAt: at.toISOString(), depth: null, inbound: 0, outbound: 0, inSitemap: false, orphan: false, ...patch,
  };
}

const copy = (view: RunView): RunView => ({ ...view });

const failureSubject = (buildingId: string) => ({ type: 'project', projectId: buildingId }) as const;

/** A crawl failure is reported once per Building until a later crawl completes; a failing notification never affects the crawl. */
function notifyFailure(project: ProjectRecord, message: string): Promise<void> {
  return raiseNotification({ kind: 'seo.crawl_failed', subject: failureSubject(project.id), title: `${project.name}: Internal links crawl failed`, description: message })
    .then(() => undefined, () => undefined);
}

async function execute(project: ProjectRecord, entry: Live, resume: WorkState | null, sitemapsChecked: boolean): Promise<void> {
  const { now } = seoDeps();
  const buildingId = project.id;
  const settings = await readCrawlSettings(buildingId);
  const site = new CrawlSite((await settingsOf(project)).siteUrl);
  const finish = async (patch: Partial<RunView>) => { Object.assign(entry.view, patch, { finishedAt: now().toISOString() }); await writeRun(buildingId, entry.view); };
  let crawl: Crawl | null = null;
  try {
    if (!resume && !sitemapsChecked) await ensureSitemaps(project, entry.controller.signal);
    const robots = await loadRobots(site, settings.timeoutSeconds * 1000, entry.controller.signal);
    let work = resume;
    if (!work) {
      const sitemapUrls = await seedUrls(project, site);
      work = { snapshotId: entry.view.snapshotId, startedAt: entry.view.startedAt, seededFrom: sitemapUrls.length ? 'sitemaps' : 'home', sitemapUrls, queue: [], seen: [], pages: [], rawLinks: [], skippedUrlSpace: 0, queryVariants: [] };
    }
    crawl = new Crawl(buildingId, entry, site, settings, work);
    if (!resume) {
      const sitemap = new Set(work.sitemapUrls);
      crawl.enqueue(site.homeKey, sitemap.has(site.homeKey) ? 'sitemap' : null);
      for (const url of work.sitemapUrls) crawl.enqueue(url, 'sitemap');
    }
    await crawl.save();
    await crawl.run(robots);
    await writeSnapshot(buildingId, crawl.snapshot('complete', null, now()));
    await deleteWork(buildingId);
    await pruneSnapshots(buildingId, KEPT_SNAPSHOTS);
    await finish({ status: 'complete', resumable: false, queued: crawl.queue.length });
    endJob(entry.view.runId, 'complete');
    await resolveNotifications(failureSubject(buildingId), ['seo.crawl_failed']).catch(() => undefined);
  } catch (error) {
    const stopped = (error as Error).name === 'AbortError';
    const message = error instanceof CrawlRefused ? error.message : 'The crawl stopped because of an unexpected error.';
    try {
      if (crawl) {
        await crawl.save();
        if (crawl.pages.length) await writeSnapshot(buildingId, crawl.snapshot('partial', stopped ? 'stopped' : 'failed', now()));
      }
      await finish(stopped ? { status: 'stopped', resumable: true } : { status: 'failed', error: message, resumable: !!crawl });
      endJob(entry.view.runId, stopped ? 'stopped' : 'failed', stopped ? undefined : message);
      if (!stopped) await notifyFailure(project, message);
    } catch {
      // Nothing more can be saved (for example a full disk); the run is reported from memory so it never reads as still running.
      Object.assign(entry.view, { status: 'failed', error: 'The crawl failed and its state could not be saved.', resumable: false, finishedAt: now().toISOString() });
      unsaved.set(buildingId, copy(entry.view));
      endJob(entry.view.runId, 'failed', entry.view.error ?? undefined);
      if (!stopped) await notifyFailure(project, entry.view.error ?? message);
    }
  } finally {
    live.delete(buildingId);
  }
}

/**
 * Starts a crawl, or continues the interrupted one with `resume`. A start while one is running is a conflict (409) that names
 * the run in progress. `sitemapsChecked` (internal, never taken from a request) says the caller has just read the sitemaps. The check and the registration happen before the first `await`, so two simultaneous starts cannot both pass.
 */
export async function startCrawl(project: ProjectRecord, options: { resume?: boolean; sitemapsChecked?: boolean } = {}): Promise<RunView> {
  const running = live.get(project.id);
  if (running) throw new CrawlRunningError('A crawl is already running', { runId: running.view.runId });
  const { now } = seoDeps();
  const at = now();
  const entry: Live = {
    controller: new AbortController(), promise: Promise.resolve(),
    view: { runId: `r-${at.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, snapshotId: newSnapshotId(at), status: 'running', startedAt: at.toISOString(), finishedAt: null, fetched: 0, queued: 0, failed: 0, error: null, resumable: false },
  };
  live.set(project.id, entry);
  unsaved.delete(project.id);
  beginJob({ id: entry.view.runId, buildingId: project.id, kind: 'crawl', startedAt: entry.view.startedAt, progress: { fetched: 0, queued: 0, failed: 0 } });
  try {
    let resume: WorkState | null = null;
    if (options.resume) {
      resume = await readWork(project.id);
      if (!resume) throw new SeoConflictError('There is no interrupted crawl to resume');
      entry.view.snapshotId = resume.snapshotId;
      entry.view.startedAt = resume.startedAt;
    } else {
      await deleteWork(project.id);
    }
    await writeRun(project.id, entry.view);
    entry.promise = execute(project, entry, resume, options.sitemapsChecked ?? false).catch(() => undefined);
  } catch (error) {
    live.delete(project.id);
    endJob(entry.view.runId, 'failed');
    throw error;
  }
  return copy(entry.view);
}

/** The newest run. A run recorded as running with no live process (the daemon restarted) becomes stopped and resumable. */
export async function currentRun(buildingId: string): Promise<RunView | null> {
  const running = live.get(buildingId);
  if (running) return copy(running.view);
  const lost = unsaved.get(buildingId);
  if (lost) return copy(lost);
  const run = await readRun(buildingId);
  if (run?.status === 'running') {
    const interrupted: RunView = { ...run, status: 'stopped', resumable: (await readWork(buildingId)) !== null, finishedAt: seoDeps().now().toISOString() };
    await writeRun(buildingId, interrupted);
    return interrupted;
  }
  return run;
}

/** Stops the running crawl and waits until its partial snapshot is saved; with nothing running it just reports the latest run. */
export async function stopCrawl(buildingId: string): Promise<RunView | null> {
  const running = live.get(buildingId);
  if (running) { running.controller.abort(); await running.promise; }
  return currentRun(buildingId);
}

/** Forgets a Building's crawl; called when the Building is deleted. */
export async function forgetCrawl(buildingId: string): Promise<void> {
  await stopCrawl(buildingId);
}
