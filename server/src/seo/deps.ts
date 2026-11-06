import { googleServices } from './googleServices.ts';
import { CLUSTER_BATCH_SIZE, CLUSTER_RUN_CAP } from './keywordRules.ts';
import { defaultKeywordAgent } from './keywordAgent.ts';
import type { KeywordAgent } from './keywordAgent.ts';
import { INDEXNOW_LOG_CAP, INDEXNOW_MIN_INTERVAL_MS } from './indexNowRules.ts';
import type { SeoServices } from './services.ts';
import { MAX_BACKLINK_FILE_BYTES } from './backlinkCsv.ts';
import { MAX_SITEMAP_BYTES, MAX_SITEMAP_URLS } from './sitemapParse.ts';

/** Bounds on what the SEO code reads from the person's own site and what it keeps; tests lower them to reach the edges. */
export interface SeoLimits {
  sitemapBytes: number;
  sitemapUrls: number;
  /** Sitemaps read in one run (an index with more children shows a notice). */
  sitemapFiles: number;
  fetchTimeoutMs: number;
  indexNowMinIntervalMs: number;
  indexNowLogRows: number;
  /** Keywords one clustering run sends to the agent. */
  clusterCap: number;
  clusterBatch: number;
  /** How long one agent request may take before the run fails. */
  agentTimeoutMs: number;
  /** The largest backlink import file. */
  backlinkFileBytes: number;
  /** Backlink rows checked before the import yields to other requests. */
  backlinkChunkRows: number;
}

/** What the SEO code reaches the outside world through; tests replace pieces to get fake services and a controlled clock. */
export interface SeoDeps {
  services: SeoServices;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Pause between fetched days so a long backfill stays gentle on the quota and the daemon. */
  dayPauseMs: number;
  /** How long an OAuth consent link stays valid. */
  oauthStateTtlMs: number;
  /** Pause between background URL inspections, so the pass stays well under Google's per-minute limit. */
  inspectPauseMs: number;
  limits: SeoLimits;
  /** The language model behind keyword clustering and research. */
  agent: KeywordAgent;
  /** Whether a new Building fetches its sitemaps and crawls on creation; tests that do not exercise it switch it off. */
  firstRun: boolean;
}

export const defaultLimits = (): SeoLimits => ({
  sitemapBytes: MAX_SITEMAP_BYTES, sitemapUrls: MAX_SITEMAP_URLS, sitemapFiles: 200, fetchTimeoutMs: 20_000,
  indexNowMinIntervalMs: INDEXNOW_MIN_INTERVAL_MS, indexNowLogRows: INDEXNOW_LOG_CAP,
  clusterCap: CLUSTER_RUN_CAP, clusterBatch: CLUSTER_BATCH_SIZE, agentTimeoutMs: 5 * 60_000, backlinkFileBytes: MAX_BACKLINK_FILE_BYTES, backlinkChunkRows: 5000,
});

const defaults = (): SeoDeps => ({
  services: googleServices,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  dayPauseMs: 250,
  oauthStateTtlMs: 10 * 60_000,
  inspectPauseMs: 700,
  limits: defaultLimits(),
  agent: defaultKeywordAgent,
  firstRun: true,
});

let current = defaults();

export const seoDeps = (): SeoDeps => current;

/** Test seam: replaces some dependencies. */
export function configureSeo(patch: Partial<SeoDeps>): void {
  current = { ...current, ...patch };
}

export function resetSeo(): void {
  current = defaults();
}
