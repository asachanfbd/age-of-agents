import { getStore } from '../buildings/buildingStorage.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { SeoInputError } from './errors.ts';
import { internalCountsFor } from './crawl/service.ts';
import { hasHistory } from './pages.ts';
import { gscPropertyOf, settingsOf } from './siteAccess.ts';
import { snapshotOf } from './taskRules.ts';
import type { LinkInput, LinkSnapshot } from './taskRules.ts';
import { isSiteHost, rawVariants } from './urls.ts';

/** The one row a table has for a key, or null. */
async function oneRow(store: BulkStore, source: string, groupBy: string[], where: Record<string, string>): Promise<Record<string, string | number> | null> {
  const { rows } = await store.groupSums({ source, groupBy, where, limit: 1 });
  return rows[0] ?? null;
}

async function pageKnown(project: ProjectRecord, store: BulkStore, url: string): Promise<boolean> {
  if (await oneRow(store, 'seo_sitemap_urls', ['url'], { url })) return true;
  if ((await internalCountsFor(project.id))?.counts.has(url)) return true;
  return hasHistory(store, gscPropertyOf(await settingsOf(project)), rawVariants(url));
}

async function keywordKnown(project: ProjectRecord, store: BulkStore, key: string): Promise<{ label: string } | null> {
  const stored = await oneRow(store, 'seo_keywords', ['key', 'display'], { key });
  if (stored) return { label: String(stored.display) };
  const property = gscPropertyOf(await settingsOf(project));
  if (!property) return null;
  const { rows } = await store.groupSums({ source: 'rollup:gsc_query_month', groupBy: ['query'], where: { property }, match: { col: 'query', exact: [key], prefixes: [] }, limit: 1 });
  return rows.length ? { label: key } : null;
}

/** What the target looks like now, or null when it is not in the Building's data. */
async function lookup(project: ProjectRecord, store: BulkStore, link: LinkInput): Promise<LinkSnapshot | null> {
  switch (link.type) {
    case 'page': return (await pageKnown(project, store, link.ref)) ? snapshotOf('page', link.ref) : null;
    case 'keyword': {
      const found = await keywordKnown(project, store, link.ref);
      return found ? snapshotOf('keyword', link.ref, { label: found.label }) : null;
    }
    case 'cluster': {
      const row = await oneRow(store, 'seo_clusters', ['uid', 'name'], { uid: link.ref });
      return row ? snapshotOf('cluster', link.ref, { label: String(row.name) }) : null;
    }
    case 'backlink': {
      const row = await oneRow(store, 'seo_backlinks', ['uid', 'sourceUrl', 'targetUrl'], { uid: link.ref });
      return row ? snapshotOf('backlink', link.ref, { label: String(row.sourceUrl), detail: `to ${String(row.targetUrl)}` }) : null;
    }
    case 'sitemap': return (await oneRow(store, 'seo_sitemaps', ['url'], { url: link.ref })) ? snapshotOf('sitemap', link.ref) : null;
  }
}

/** At creation the target must exist (an unknown one is a 400); a page only has to be on the site, since an un-indexed address may be in no data yet. */
export async function resolveNewLink(project: ProjectRecord, link: LinkInput): Promise<LinkSnapshot> {
  const store = await getStore(project);
  if (link.type === 'page') {
    if (!isSiteHost(link.ref, (await settingsOf(project)).siteUrl)) throw new SeoInputError('link.ref is not a page of this site');
    return snapshotOf('page', link.ref);
  }
  const found = await lookup(project, store, link);
  if (!found) throw new SeoInputError(`That ${link.type} is not in this Building's data`);
  return found;
}

/** Whether each snapshot's target is still in the data, for the detail and the related-tasks blocks. */
export async function linksInData(project: ProjectRecord, snapshots: readonly LinkSnapshot[]): Promise<boolean[]> {
  const store = await getStore(project);
  return Promise.all(snapshots.map(async (s) => (await lookup(project, store, s)) !== null));
}
