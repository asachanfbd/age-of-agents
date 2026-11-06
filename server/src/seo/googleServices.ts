import { ServiceError } from './errors.ts';
import type { GscMetricRow } from './metrics.ts';
import { classifyAdsVolumes } from './metrics.ts';
import type { AdsAccess, AdsCheck, AdsKeyword, Ga4Row, GscSitemap, OAuthTokens, PropertyChoice, SeoServices } from './services.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/**
 * The Google Ads API major version used for Keyword Planner. Google keeps about four majors at a time and sunsets each after
 * roughly 12 months, so this needs bumping periodically (per the release notes in October 2026 v22 is sunsetting and
 * v23 to v25 are served). A 404 from this endpoint is reported as an unsupported version, not as refused access.
 */
export const ADS_API_VERSION = 'v24';
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const GSC_ROW_LIMIT = 25_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** Seconds from a `Retry-After` header in either of its two spellings (a number of seconds, or an HTTP date). */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

/** Sorts a failed response into what the sync should do; the body is never put in the message because it may echo a credential. */
function failure(status: number, what: string, retryAfter: string | null, notFoundMeans?: string): ServiceError {
  if (status === 404 && notFoundMeans) return new ServiceError('invalid', `${what}: ${notFoundMeans}`);
  if (status === 401) return new ServiceError('auth', `${what}: Google rejected the saved sign-in`);
  if (status === 403 || status === 404) return new ServiceError('access', `${what}: access was refused (HTTP ${status})`);
  if (status === 429) return new ServiceError('quota', `${what}: quota exceeded`, parseRetryAfter(retryAfter, new Date()));
  if (status >= 500) return new ServiceError('network', `${what}: Google had a problem (HTTP ${status})`);
  return new ServiceError('invalid', `${what}: unexpected answer (HTTP ${status})`);
}

async function call(what: string, url: string, init: RequestInit, notFoundMeans?: string): Promise<any> {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); } catch (error) {
    throw new ServiceError('network', `${what}: ${(error as Error).name === 'TimeoutError' ? 'timed out' : 'could not reach the service'}`);
  }
  if (!res.ok) throw failure(res.status, what, res.headers.get('retry-after'), notFoundMeans);
  return res.json();
}

const ADS_SEED_LIMIT = 20;
const ADS_IDEA_LIMIT = 200;
const ADS_VOLUME_LIMIT = 1000;
const numberOrNull = (value: unknown) => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

async function adsCall(method: string, { accessToken, developerToken, customerId }: AdsAccess, body: object): Promise<any> {
  const id = customerId.replace(/-/g, '');
  return call(`Google Ads ${method}`, `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${id}:${method}`, {
    method: 'POST', headers: bearer(accessToken, { 'developer-token': developerToken }), body: JSON.stringify(body),
  }, `the Google Ads API version ${ADS_API_VERSION} is no longer served or the customer id is wrong; update ADS_API_VERSION in googleServices.ts`);
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });

function accountOf(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  try { return JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8')).email; } catch { return undefined; }
}

async function tokenRequest(what: string, body: Record<string, string>): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new ServiceError('network', `${what}: could not reach Google`); }
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    // `invalid_grant` means the refresh token was revoked or expired, `unauthorized_client` that it was issued to
    // another OAuth client: only reconnecting helps.
    if (json.error === 'invalid_grant' || json.error === 'invalid_client' || json.error === 'unauthorized_client' || res.status === 401) throw new ServiceError('auth', `${what}: Google no longer accepts the saved sign-in (${String(json.error ?? res.status)})`);
    throw failure(res.status, what, res.headers.get('retry-after'));
  }
  return { accessToken: String(json.access_token), refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined, expiresInSec: Number(json.expires_in ?? 3600), account: accountOf(json.id_token) };
}

const count = (value: unknown): number | null => (value === undefined || value === null || Number.isNaN(Number(value)) ? null : Number(value));
const gscSitemap = (s: any): GscSitemap => {
  const web = (s.contents ?? []).find((c: any) => c.type === 'web') ?? (s.contents ?? [])[0];
  return {
    path: String(s.path), lastSubmitted: s.lastSubmitted ?? null, lastDownloaded: s.lastDownloaded ?? null, isPending: s.isPending === true, isIndex: s.isSitemapsIndex === true,
    type: s.type ?? null, warnings: count(s.warnings), errors: count(s.errors), submitted: count(web?.submitted), indexed: count(web?.indexed),
  };
};

const gscRow = (r: any): GscMetricRow => ({ page: r.keys[1], query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });

export const googleServices: SeoServices = {
  oauth: {
    authUrl: ({ clientId, redirectUri, scopes, state }) => `${AUTH_URL}?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), state, access_type: 'offline', prompt: 'consent' })}`,
    exchangeCode: ({ clientId, clientSecret, code, redirectUri }) => tokenRequest('Google sign-in', { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
    refresh: ({ clientId, clientSecret, refreshToken }) => tokenRequest('Google token refresh', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  },
  gsc: {
    async listProperties(token): Promise<PropertyChoice[]> {
      const json = await call('Search Console sites', 'https://www.googleapis.com/webmasters/v3/sites', { headers: bearer(token) });
      return (json.siteEntry ?? []).map((s: any) => ({ id: s.siteUrl, label: s.siteUrl }));
    },
    async firstIncompleteDate(token, property, from, to) {
      const json = await call('Search Console freshness', `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
        method: 'POST', headers: bearer(token), body: JSON.stringify({ startDate: from, endDate: to, dimensions: ['date'], dataState: 'all' }),
      });
      return json.metadata?.first_incomplete_date ?? null;
    },
    async listSitemaps(token, property) {
      const json = await call('Search Console sitemaps', `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/sitemaps`, { headers: bearer(token) });
      return (json.sitemap ?? []).map(gscSitemap);
    },
    async inspectUrl(token, property, inspectionUrl) {
      const json = await call('Search Console URL inspection', 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
        method: 'POST', headers: bearer(token), body: JSON.stringify({ inspectionUrl, siteUrl: property, languageCode: 'en-US' }),
      });
      return json.inspectionResult?.indexStatusResult ?? {};
    },
    async queryDay(token, property, day) {
      const rows: GscMetricRow[] = [];
      for (let startRow = 0; ; startRow += GSC_ROW_LIMIT) {
        const json = await call('Search Console query', `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
          method: 'POST', headers: bearer(token), body: JSON.stringify({ startDate: day, endDate: day, dimensions: ['query', 'page'], rowLimit: GSC_ROW_LIMIT, startRow, dataState: 'all' }),
        });
        const page = (json.rows ?? []).map(gscRow);
        rows.push(...page);
        if (page.length < GSC_ROW_LIMIT) return rows;
      }
    },
  },
  ga4: {
    async listProperties(token): Promise<PropertyChoice[]> {
      const json = await call('Analytics properties', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { headers: bearer(token) });
      return (json.accountSummaries ?? []).flatMap((a: any) => (a.propertySummaries ?? []).map((p: any) => ({ id: String(p.property).replace('properties/', ''), label: `${p.displayName} (${a.displayName})` })));
    },
    async reportDay(token, property, day): Promise<Ga4Row[]> {
      const rows: Ga4Row[] = [];
      for (let offset = 0; ; offset += 100_000) {
        const json = await call('Analytics report', `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`, {
          method: 'POST', headers: bearer(token), body: JSON.stringify({ dateRanges: [{ startDate: day, endDate: day }], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'sessions' }, { name: 'keyEvents' }], limit: 100_000, offset }),
        });
        const page = (json.rows ?? []).map((r: any) => ({ page: r.dimensionValues[0].value, sessions: Number(r.metricValues[0].value), keyEvents: Number(r.metricValues[1].value) }));
        rows.push(...page);
        if (page.length < 100_000) return rows;
      }
    },
  },
  ads: {
    async check({ accessToken, developerToken, customerId }): Promise<AdsCheck> {
      const headers = bearer(accessToken, { 'developer-token': developerToken });
      const id = customerId.replace(/-/g, '');
      const json = await call('Google Ads keyword ideas', `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${id}:generateKeywordIdeas`, {
        method: 'POST', headers, body: JSON.stringify({ keywordSeed: { keywords: ['seo'] }, pageSize: 10 }),
      }, `the Google Ads API version ${ADS_API_VERSION} is no longer served or the customer id is wrong; update ADS_API_VERSION in googleServices.ts`);
      const volumes = (json.results ?? []).map((r: any) => Number(r.keywordIdeaMetrics?.avgMonthlySearches));
      return { ok: true, volume: classifyAdsVolumes(volumes) };
    },
    async keywordIdeas({ accessToken, developerToken, customerId, seeds, languageId, locationId }): Promise<AdsKeyword[]> {
      const json = await adsCall('generateKeywordIdeas', { accessToken, developerToken, customerId }, {
        keywordSeed: { keywords: seeds.slice(0, ADS_SEED_LIMIT) }, language: `languageConstants/${languageId}`, geoTargetConstants: [`geoTargetConstants/${locationId}`], pageSize: ADS_IDEA_LIMIT,
      });
      return (json.results ?? []).map((r: any) => ({ keyword: String(r.text ?? ''), volume: numberOrNull(r.keywordIdeaMetrics?.avgMonthlySearches) }));
    },
    async keywordVolumes({ accessToken, developerToken, customerId, keywords, languageId, locationId }): Promise<AdsKeyword[]> {
      const json = await adsCall('generateKeywordHistoricalMetrics', { accessToken, developerToken, customerId }, {
        keywords: keywords.slice(0, ADS_VOLUME_LIMIT), language: `languageConstants/${languageId}`, geoTargetConstants: [`geoTargetConstants/${locationId}`],
      });
      return (json.results ?? []).map((r: any) => ({ keyword: String(r.text ?? ''), volume: numberOrNull(r.keywordMetrics?.avgMonthlySearches) }));
    },
  },
  bing: {
    async check({ apiKey, siteUrl }) {
      const json = await call('Bing Webmaster sites', `https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${encodeURIComponent(apiKey)}`, { headers: { accept: 'application/json' } });
      const sites: string[] = (json.d ?? []).map((s: any) => String(s.Url ?? '').replace(/\/$/, ''));
      return sites.includes(siteUrl.replace(/\/$/, '')) ? { ok: true } : { ok: false, message: 'The key works, but this site is not in the Bing Webmaster account.' };
    },
    async urlInfo({ apiKey, siteUrl, url }) {
      const json = await call('Bing URL info', `https://ssl.bing.com/webmaster/api.svc/json/GetUrlInfo?${new URLSearchParams({ apikey: apiKey, siteUrl, url })}`, { headers: { accept: 'application/json' } });
      const info = json.d;
      if (!info || (!info.LastCrawledDate && !info.DiscoveryDate)) return null;
      const date = (value: unknown) => { const m = /\/Date\((\d+)/.exec(String(value ?? '')); return m ? new Date(Number(m[1])).toISOString() : null; };
      return { discoveredAt: date(info.DiscoveryDate), lastCrawledAt: date(info.LastCrawledDate), httpCode: typeof info.HttpCode === 'number' ? info.HttpCode : null };
    },
  },
  indexNow: {
    async submit({ host, key, keyLocation, urls }) {
      let res: Response;
      try {
        res = await fetch(INDEXNOW_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host, key, keyLocation, urlList: urls }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        throw new ServiceError('network', `IndexNow: ${(error as Error).name === 'TimeoutError' ? 'timed out' : 'could not reach the service'}`);
      }
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, retryAfter: res.headers.get('retry-after') };
    },
  },
};
