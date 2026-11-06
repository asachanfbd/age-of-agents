import type { ProjectRecord } from '../../domain/types.ts';
import { settingsOf } from '../siteAccess.ts';
import { CrawlSite } from './site.ts';
import { currentRun, startCrawl, stopCrawl } from './runner.ts';
import { DEFAULT_CRAWL_SETTINGS, mergeSettings, SETTING_RANGES } from './rules.ts';
import { latestSnapshot, listSnapshots, readCrawlSettings, writeCrawlSettings } from './store.ts';
import { metaOf, pageView } from './views.ts';

/** The tab's first request: the stored crawls, the latest run, and the rules the crawl follows (stated on screen). */
export async function internalLinksOverview(project: ProjectRecord) {
  const [snapshots, run, settings, site] = await Promise.all([
    listSnapshots(project.id), currentRun(project.id), readCrawlSettings(project.id), settingsOf(project).then((s) => new CrawlSite(s.siteUrl)),
  ]);
  return { host: site.host, snapshots: snapshots.map(metaOf), run, settings, defaults: DEFAULT_CRAWL_SETTINGS, ranges: SETTING_RANGES };
}

export async function updateCrawlSettings(project: ProjectRecord, patch: unknown) {
  const next = mergeSettings(await readCrawlSettings(project.id), patch);
  await writeCrawlSettings(project.id, next);
  return next;
}

export { currentRun, startCrawl, stopCrawl };

/** Link counts from the newest crawl for the Pages table (`partial` when that crawl did not finish); null before the first crawl. */
export async function internalCountsFor(buildingId: string): Promise<{ counts: Map<string, { inbound: number; outbound: number; orphan: boolean }>; partial: boolean } | null> {
  const snapshot = await latestSnapshot(buildingId);
  if (!snapshot) return null;
  return { partial: snapshot.status === 'partial', counts: new Map(snapshot.pages.filter((p) => !p.redirectTo).map((p) => [p.url, { inbound: p.inbound, outbound: p.outbound, orphan: p.orphan }])) };
}

/** What the crawler saw on one page, for the Pages drill-down. */
export async function crawlBlockFor(buildingId: string, url: string) {
  const snapshot = await latestSnapshot(buildingId);
  if (!snapshot) return { available: false as const, title: null, description: null };
  const page = snapshot.pages.find((p) => p.url === url && !p.redirectTo);
  if (!page) return { available: true as const, found: false as const, crawledAt: snapshot.finishedAt, partial: snapshot.status === 'partial', title: null, description: null };
  return { available: true as const, found: true as const, crawledAt: snapshot.finishedAt, partial: snapshot.status === 'partial', ...pageView(page) };
}
