import type { AdsKeyword, BingUrlInfo, GscSitemap, IndexNowRequest, OAuthTokens, SeoServices, UrlInspection } from '../../src/seo/services.ts';
import { ServiceError } from '../../src/seo/errors.ts';
import type { ClusterAgentInput, KeywordAgent, ReportAgentInput, ResearchAgentInput } from '../../src/seo/keywordAgent.ts';
import type { GscMetricRow } from '../../src/seo/metrics.ts';

export const SECRETS = { access: 'ACCESS-TOKEN-VALUE-', refresh: 'REFRESH-TOKEN-VALUE-1', clientId: 'client-id-VALUE-1.apps.example', clientSecret: 'CLIENT-SECRET-VALUE-1', bing: 'BING-API-KEY-VALUE-1', ads: 'ADS-DEVELOPER-TOKEN-1', indexNow: 'indexnow-key-VALUE-1' };

/** A scriptable stand-in for Google and Bing: deterministic data per day, queued failures, call counters and latches. */
export function createFakeSeo() {
  const state = {
    exchangeCalls: 0,
    refreshCalls: 0,
    /** The OAuth client each code exchange and refresh was made with. */
    exchangeArgs: [] as Array<{ clientId: string; clientSecret: string; redirectUri: string }>,
    refreshArgs: [] as Array<{ clientId: string; clientSecret: string }>,
    expiresInSec: 3600,
    refreshToken: SECRETS.refresh as string | undefined,
    gscProperties: [{ id: 'https://example.com/', label: 'https://example.com/' }, { id: 'sc-domain:example.com', label: 'sc-domain:example.com' }],
    ga4Properties: [{ id: '123456', label: 'Example (Account)' }],
    firstIncomplete: null as string | null,
    queryDays: [] as string[],
    reportDays: [] as string[],
    rowsPerDay: 3,
    gscRows: undefined as undefined | ((day: string) => GscMetricRow[]),
    adsVolume: 'range' as 'exact' | 'range' | 'unknown',
    adsOk: true,
    /** What Keyword Planner answers to an ideas request; volume null means Google sent none. */
    adsIdeas: [] as AdsKeyword[],
    /** Volume per keyword text for a historical-metrics request; a keyword not listed comes back without a volume. */
    adsVolumes: new Map<string, number | null>(),
    adsIdeaCalls: [] as string[][],
    adsVolumeCalls: [] as string[][],
    bingOk: true,
    /** Awaited at the start of every GSC day query; lets a test hold a sync mid-way. */
    gate: undefined as undefined | ((day: string) => Promise<void>),
    failures: new Map<string, Error[]>(),
    gscSitemaps: [] as GscSitemap[],
    /** What URL inspection answers per inspected address; the default is an indexed page. */
    inspections: new Map<string, UrlInspection>(),
    defaultInspection: { verdict: 'PASS', coverageState: 'Submitted and indexed' } as UrlInspection,
    inspectCalls: [] as string[],
    /** Awaited at the start of every URL inspection; lets a test hold calls to force an overlap. */
    inspectGate: undefined as undefined | ((url: string) => Promise<void>),
    bingInfo: new Map<string, BingUrlInfo | null>(),
    bingInfoCalls: [] as string[],
    indexNowCalls: [] as IndexNowRequest[],
    indexNowAnswer: ((): { status: number; retryAfter: string | null } => ({ status: 200, retryAfter: null })) as () => { status: number; retryAfter: string | null },
    indexNowGate: undefined as undefined | (() => Promise<void>),
  };
  const fail = (method: string, error: Error, times = 1) => { state.failures.set(method, [...(state.failures.get(method) ?? []), ...Array(times).fill(error)]); };
  const check = (method: string) => { const next = state.failures.get(method)?.shift(); if (next) throw next; };

  const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
  /** The built-in rows for a day; an override in `state.gscRows` can build on them. */
  const defaultGscDay = (day: string): GscMetricRow[] => Array.from({ length: state.rowsPerDay }, (_, i) => ({
    page: `https://example.com/page-${i}`, query: `query ${i}`, clicks: (dayNumber(day) % 5) + i, impressions: 10 * ((dayNumber(day) % 5) + i + 1), ctr: 0.1, position: 2 + i,
  }));
  const gscDay = (day: string): GscMetricRow[] => state.gscRows?.(day) ?? defaultGscDay(day);
  let tokenCounter = 0;
  const tokens = (account = 'me@example.com'): OAuthTokens => ({ accessToken: `${SECRETS.access}${++tokenCounter}`, refreshToken: state.refreshToken, expiresInSec: state.expiresInSec, account });

  const services: SeoServices = {
    oauth: {
      authUrl: ({ clientId, redirectUri, scopes, state: s }) => `https://accounts.example/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes.join(' '))}&state=${s}`,
      exchangeCode: async ({ clientId, clientSecret, redirectUri }) => { state.exchangeCalls++; state.exchangeArgs.push({ clientId, clientSecret, redirectUri }); check('exchangeCode'); return tokens(); },
      refresh: async ({ clientId, clientSecret }) => { state.refreshCalls++; state.refreshArgs.push({ clientId, clientSecret }); await new Promise((r) => setTimeout(r, 5)); check('refresh'); return { ...tokens(), refreshToken: undefined }; },
    },
    gsc: {
      listProperties: async () => { check('gscList'); return state.gscProperties; },
      firstIncompleteDate: async () => { check('firstIncomplete'); return state.firstIncomplete; },
      queryDay: async (_t, _p, day) => { await state.gate?.(day); check('queryDay'); state.queryDays.push(day); return gscDay(day); },
      listSitemaps: async () => { check('listSitemaps'); return state.gscSitemaps; },
      inspectUrl: async (_t, _p, url) => {
        await state.inspectGate?.(url);
        check('inspectUrl');
        state.inspectCalls.push(url);
        return state.inspections.get(url) ?? state.defaultInspection;
      },
    },
    ga4: {
      listProperties: async () => { check('ga4List'); return state.ga4Properties; },
      reportDay: async (_t, _p, day) => { check('reportDay'); state.reportDays.push(day); return [{ page: '/page-0', sessions: 5, keyEvents: 1 }, { page: '/page-1', sessions: 3, keyEvents: 0 }]; },
    },
    ads: {
      check: async () => { check('ads'); return { ok: state.adsOk, volume: state.adsVolume, message: state.adsOk ? undefined : 'The developer token is not approved yet.' }; },
      keywordIdeas: async ({ seeds }) => { check('adsIdeas'); state.adsIdeaCalls.push(seeds); return state.adsIdeas; },
      keywordVolumes: async ({ keywords }) => { check('adsVolume'); state.adsVolumeCalls.push(keywords); return keywords.map((keyword) => ({ keyword, volume: state.adsVolumes.get(keyword) ?? null })); },
    },
    bing: {
      check: async () => { check('bing'); return state.bingOk ? { ok: true } : { ok: false, message: 'The key works, but this site is not in the Bing Webmaster account.' }; },
      urlInfo: async ({ url }) => { check('bingInfo'); state.bingInfoCalls.push(url); return state.bingInfo.get(url) ?? null; },
    },
    indexNow: {
      submit: async (request) => { await state.indexNowGate?.(); check('indexNow'); state.indexNowCalls.push(request); return state.indexNowAnswer(); },
    },
  };
  return { services, state, fail, gscDay, defaultGscDay };
}

export const quota = (retryAfterMs?: number) => new ServiceError('quota', 'quota exceeded', retryAfterMs);
export const network = () => new ServiceError('network', 'could not reach the service');
export const authFailure = () => new ServiceError('auth', 'Google no longer accepts the saved sign-in');
export const accessRefused = () => new ServiceError('access', 'access was refused (HTTP 403)');

/**
 * A scripted stand-in for the language model: `clusterOutputs[i]` answers the i-th clustering batch (or `clusterFn` computes
 * it from the input), `researchOutput` answers research. `gate` is awaited at the start of each batch, so a test can hold a
 * run there to start a second one or to edit keywords while it works. Failures are queued per method.
 */
export function createFakeAgent() {
  const state = {
    clusterOutputs: [] as unknown[],
    clusterFn: undefined as undefined | ((input: ClusterAgentInput, batch: number) => unknown),
    clusterCalls: [] as ClusterAgentInput[],
    researchOutput: { keywords: [] } as unknown,
    researchCalls: [] as ResearchAgentInput[],
    reportOutput: { paragraph: 'Clicks grew.', actions: ['Refresh the top page.'] } as unknown,
    reportCalls: [] as ReportAgentInput[],
    gate: undefined as undefined | ((batch: number) => Promise<void>),
    failures: new Map<'cluster' | 'research' | 'summarise', Error[]>(),
  };
  const fail = (method: 'cluster' | 'research' | 'summarise', error: Error) => { state.failures.set(method, [...(state.failures.get(method) ?? []), error]); };
  const stopIfAborted = (signal: AbortSignal) => { if (signal.aborted) throw new Error('aborted'); };
  const agent: KeywordAgent = {
    cluster: async (input, signal) => {
      const batch = state.clusterCalls.length;
      state.clusterCalls.push(input);
      await state.gate?.(batch);
      stopIfAborted(signal);
      const failure = state.failures.get('cluster')?.shift();
      if (failure) throw failure;
      return state.clusterFn ? state.clusterFn(input, batch) : state.clusterOutputs[batch] ?? { clusters: [] };
    },
    research: async (input, signal) => {
      state.researchCalls.push(input);
      await state.gate?.(0);
      stopIfAborted(signal);
      const failure = state.failures.get('research')?.shift();
      if (failure) throw failure;
      return state.researchOutput;
    },
    summarise: async (input, signal) => {
      state.reportCalls.push(input);
      await state.gate?.(0);
      stopIfAborted(signal);
      const failure = state.failures.get('summarise')?.shift();
      if (failure) throw failure;
      return state.reportOutput;
    },
  };
  return { agent, state, fail };
}
