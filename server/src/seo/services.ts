import type { GscMetricRow } from './metrics.ts';

export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresInSec: number; account?: string }

export interface PropertyChoice { id: string; label: string }

export interface Ga4Row { page: string; sessions: number; keyEvents: number }

/** A sitemap as Search Console lists it for a property. Counts are null when Google did not send them. */
export interface GscSitemap {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  isIndex: boolean;
  type: string | null;
  warnings: number | null;
  errors: number | null;
  submitted: number | null;
  indexed: number | null;
}

/** The index status Google reports for one URL (`inspectionResult.indexStatusResult`). */
export interface UrlInspection { verdict?: string; coverageState?: string; lastCrawlTime?: string }

/** What Bing Webmaster knows about a URL; null from `urlInfo` means Bing has not seen it. */
export interface BingUrlInfo { discoveredAt: string | null; lastCrawledAt: string | null; httpCode: number | null }

export interface IndexNowRequest { host: string; key: string; keyLocation: string; urls: string[] }

export interface AdsAccess { accessToken: string; developerToken: string; customerId: string }

/** Where Keyword Planner looks: a Google Ads language criterion id (English is 1000) and geo target id (United States is 2840). */
export interface AdsMarket { languageId: string; locationId: string }

/** An average monthly search count as Google Ads reports it; null when it sent none. Small accounts get bucketed numbers (10, 100, 1000 ...). */
export interface AdsKeyword { keyword: string; volume: number | null }

export interface AdsCheck { ok: boolean; volume: 'exact' | 'range' | 'unknown'; message?: string }

/**
 * The outside world the SEO Building talks to. The real implementation (`googleServices.ts`) uses `fetch`; tests inject a
 * fake. Every method throws `ServiceError` for a failure the sync should react to.
 */
export interface SeoServices {
  oauth: {
    authUrl(input: { clientId: string; redirectUri: string; scopes: string[]; state: string }): string;
    exchangeCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<OAuthTokens>;
    refresh(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<OAuthTokens>;
  };
  gsc: {
    listProperties(accessToken: string): Promise<PropertyChoice[]>;
    /** The first day Google still marks as incomplete, or null when everything in the range is final. */
    firstIncompleteDate(accessToken: string, property: string, from: string, to: string): Promise<string | null>;
    queryDay(accessToken: string, property: string, day: string): Promise<GscMetricRow[]>;
    listSitemaps(accessToken: string, property: string): Promise<GscSitemap[]>;
    /** Throws `ServiceError('quota')` when Google's daily inspection limit is used up. */
    inspectUrl(accessToken: string, property: string, inspectionUrl: string): Promise<UrlInspection>;
  };
  ga4: {
    listProperties(accessToken: string): Promise<PropertyChoice[]>;
    reportDay(accessToken: string, property: string, day: string): Promise<Ga4Row[]>;
  };
  ads: {
    check(input: AdsAccess): Promise<AdsCheck>;
    keywordIdeas(input: AdsAccess & AdsMarket & { seeds: string[] }): Promise<AdsKeyword[]>;
    keywordVolumes(input: AdsAccess & AdsMarket & { keywords: string[] }): Promise<AdsKeyword[]>;
  };
  bing: {
    check(input: { apiKey: string; siteUrl: string }): Promise<{ ok: boolean; message?: string }>;
    urlInfo(input: { apiKey: string; siteUrl: string; url: string }): Promise<BingUrlInfo | null>;
  };
  indexNow: {
    /** The HTTP status and `Retry-After` header IndexNow answered with; a network failure throws `ServiceError('network')`. */
    submit(request: IndexNowRequest): Promise<{ status: number; retryAfter: string | null }>;
  };
}

export const GOOGLE_SCOPES = {
  gsc: ['https://www.googleapis.com/auth/webmasters.readonly', 'openid', 'email'],
  ga4: ['https://www.googleapis.com/auth/analytics.readonly', 'openid', 'email'],
  ads: ['https://www.googleapis.com/auth/adwords', 'openid', 'email'],
} as const;
