import type { LinkLocation } from './parse.ts';
import type { CrawlSettings } from './rules.ts';

/** One address the crawl requested (or refused to). Redirecting and failed pages are kept; the graph shows only final pages. */
export interface PageRecord {
  url: string;
  /** HTTP status of the first answer; null when no answer came (see `error`). */
  status: number | null;
  redirectTo: string | null;
  redirectExternal: boolean;
  contentType: string | null;
  title: string | null;
  description: string | null;
  canonical: string | null;
  noindex: boolean;
  /** 'robots' = blocked by robots.txt; other values say why no answer was read. */
  error: 'robots' | 'timeout' | 'network' | 'too-large' | 'rate-limited' | 'redirect-loop' | 'too-many-redirects' | null;
  externalLinks: number;
  /** Internal links found on the page (duplicates and links to uncrawled addresses included). Absent in snapshots saved before the crawl log existed. */
  internalLinks?: number;
  /** What first led the crawler here: 'sitemap', the address of the page that linked or redirected to it, or null for the start page. Absent in older snapshots. */
  discoveredFrom?: string | null;
  fetchedAt: string;
  /** Filled by the analysis. */
  depth: number | null;
  inbound: number;
  outbound: number;
  inSitemap: boolean;
  orphan: boolean;
}

export interface RawLink { from: string; to: string; anchor: string; nofollow: boolean; location: LinkLocation }

/** A link after redirects are resolved: `to` is the final page; `via` is the redirecting address the link actually pointed at. */
export interface LinkRecord { from: string; to: string; anchor: string; nofollow: boolean; location: LinkLocation; via: string | null; broken: boolean }

export interface SnapshotMeta {
  id: string;
  startedAt: string;
  finishedAt: string;
  status: 'complete' | 'partial';
  /** Why a partial snapshot stopped. */
  stopReason: 'stopped' | 'failed' | null;
  /** The page cap ended the crawl while addresses were still waiting. */
  capped: boolean;
  incomplete: boolean;
  host: string;
  seededFrom: 'sitemaps' | 'home';
  settings: CrawlSettings;
  /** Set when most requested addresses gave no links or redirected to themselves; absent in snapshots saved before the crawl log existed. */
  warning?: SnapshotWarning | null;
  stats: { pages: number; fetched: number; failed: number; blockedByRobots: number; skippedUrlSpace: number; links: number; externalLinks: number; uncrawledLinks: number };
}

export interface SnapshotWarning { affected: number; total: number }

/** `rawLinks` is capped (see `MAX_STORED_LINKS`) and absent in snapshots saved before the crawl log existed. */
export interface Snapshot extends SnapshotMeta { pages: PageRecord[]; links: LinkRecord[]; rawLinks?: RawLink[] }

/** What a run needs to carry on after a restart. */
export interface WorkState {
  snapshotId: string;
  startedAt: string;
  seededFrom: 'sitemaps' | 'home';
  sitemapUrls: string[];
  queue: string[];
  seen: string[];
  /** Absent in work saved before the crawl log existed. */
  discoveredFrom?: Array<[string, string | null]>;
  pages: PageRecord[];
  rawLinks: RawLink[];
  skippedUrlSpace: number;
  queryVariants: Array<[string, number]>;
}

export type RunStatus = 'running' | 'complete' | 'stopped' | 'failed';

export interface RunView {
  runId: string;
  snapshotId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  queued: number;
  failed: number;
  error: string | null;
  /** True when the run can be continued with a start request. */
  resumable: boolean;
}
