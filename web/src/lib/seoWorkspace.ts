/**
 * Pure view-models for the SEO Building's workspace: the tab list, empty states, metric formatting, the connection
 * cards, the create-form check and the retention notice. Kept free of React so the rules are testable without a DOM.
 */

import type { SeoJobKind } from './serverApi';

export const SEO_TYPE_ID = 'seo';

export const SEO_TABS = [
  { key: 'keywords', label: 'Keywords' },
  { key: 'sitemaps', label: 'Sitemaps' },
  { key: 'pages', label: 'Pages' },
  { key: 'reports', label: 'Reports' },
  { key: 'backlinks', label: 'Backlinks' },
  { key: 'internal-links', label: 'Internal links' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'settings', label: 'Settings' },
] as const;
export type SeoTab = (typeof SEO_TABS)[number]['key'];

/** The tab that owns each background job, so the status footer can open the Building where the work is shown. */
const SEO_JOB_TABS: Record<SeoJobKind, SeoTab> = {
  crawl: 'internal-links',
  sitemaps: 'sitemaps',
  inspection: 'sitemaps',
  'keywords-research': 'keywords',
  'keywords-cluster': 'keywords',
};
export const seoTabForJob = (kind: SeoJobKind): SeoTab => SEO_JOB_TABS[kind];

export const SEO_SETTINGS_SECTIONS = [
  { key: 'connections', label: 'Connections' },
  { key: 'data', label: 'Data' },
] as const;
export type SeoSettingsSection = (typeof SEO_SETTINGS_SECTIONS)[number]['key'];

/** A gap is an em dash with "no data"; a stored zero is `0`. */
export function formatMetric(value: number | null | undefined, options: { connected?: boolean; digits?: number } = {}): { text: string; title: string } {
  if (options.connected === false) return { text: 'Not connected', title: 'Connect this service in Settings → Connections' };
  if (value === null || value === undefined || Number.isNaN(value)) return { text: '—', title: 'no data' };
  const digits = options.digits ?? 0;
  return { text: value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }), title: '' };
}

export type ConnectionState = 'not-connected' | 'connected' | 'needs-attention' | 'syncing';
export type ServiceId = 'gsc' | 'ga4' | 'ads' | 'bing' | 'indexnow';

export interface ConnectionDto {
  service: ServiceId;
  state: ConnectionState;
  account?: string;
  property?: string;
  reason?: string;
  lastSyncAt?: string;
  progress?: { done: number; total: number };
  volume?: 'exact' | 'range' | 'unknown';
  customerId?: string;
}

export interface ConnectionsViewDto {
  siteUrl: string;
  googleClientSaved: boolean;
  adsDeveloperTokenSaved: boolean;
  bingKeySaved: boolean;
  indexNowKeySaved: boolean;
  connections: ConnectionDto[];
  previousProperties: Array<{ service: 'gsc' | 'ga4'; property: string; replacedAt: string }>;
  /** The Google Ads language and location Keyword Planner uses for keyword research, or null until chosen. */
  keywordMarket: { languageId: string; locationId: string } | null;
}

export const SERVICE_LABELS: Record<ServiceId, string> = {
  gsc: 'Google Search Console',
  ga4: 'Google Analytics 4',
  ads: 'Google Ads (Keyword Planner)',
  bing: 'Bing Webmaster',
  indexnow: 'IndexNow',
};
export const OPTIONAL_SERVICES: ServiceId[] = ['ads', 'bing'];

const STATE_LABELS: Record<ConnectionState, string> = { 'not-connected': 'Not connected', connected: 'Connected', 'needs-attention': 'Needs attention', syncing: 'Syncing' };

export interface ConnectionCard {
  title: string;
  statusLabel: string;
  tone: 'muted' | 'good' | 'warning' | 'info';
  detail: string | null;
  actions: Array<'connect' | 'choose-property' | 'sync-now' | 'disconnect' | 'reconnect'>;
  syncNowDisabled: boolean;
}

export function connectionCard(c: ConnectionDto): ConnectionCard {
  const syncable = c.service === 'gsc' || c.service === 'ga4';
  const tone = c.state === 'connected' ? 'good' : c.state === 'needs-attention' ? 'warning' : c.state === 'syncing' ? 'info' : 'muted';
  const actions: ConnectionCard['actions'] = [];
  if (c.state === 'not-connected') actions.push('connect');
  else {
    if (syncable) actions.push('choose-property', 'sync-now');
    if (c.state === 'needs-attention') actions.push('reconnect');
    actions.push('disconnect');
  }
  const detail = c.state === 'syncing' && c.progress ? `Syncing ${progressPercent(c.progress.done, c.progress.total)}%` : c.reason ?? (c.account ? `${c.account}${c.property ? ` · ${c.property}` : ''}` : null);
  return { title: SERVICE_LABELS[c.service], statusLabel: STATE_LABELS[c.state], tone, detail, actions, syncNowDisabled: c.state === 'syncing' };
}

/** 0 to 100, clamped; an unknown total reads as 0 rather than NaN. */
export function progressPercent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export function volumeLabel(volume: 'exact' | 'range' | 'unknown' | undefined): string {
  if (volume === 'exact') return 'Exact search volumes';
  if (volume === 'range') return 'Volumes may be ranges (rounded to 10, 100, 1,000 …; typical for low-spend accounts)';
  return 'Volumes not checked yet';
}

/** Secret inputs never carry a value: after saving only "Saved" is shown and the person can replace it. */
export function secretField(saved: boolean): { value: ''; placeholder: string; badge: string | null } {
  return { value: '', placeholder: saved ? 'Saved. Type to replace' : '', badge: saved ? 'Saved' : null };
}

export function syncWording(schedulerPresent: boolean): string {
  return schedulerPresent
    ? 'Data refreshes daily on the schedule. Sync now fetches right away.'
    : 'There is no daily schedule on this install: data refreshes when you open this Building or press Sync now.';
}

const MAX_SITE_URL = 2048;

/** The create form's check; mirrors the daemon's rules so the person sees the problem before the request. */
export function validateSiteUrlInput(input: string): { ok: true; normalized: string } | { ok: false; error: string } {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Enter your site address, for example https://example.com' };
  if (text.length > MAX_SITE_URL) return { ok: false, error: `The address must be at most ${MAX_SITE_URL} characters` };
  if (/\s/.test(text)) return { ok: false, error: 'The address must not contain spaces' };
  let url: URL;
  try { url = new URL(text); } catch { return { ok: false, error: 'Use a full address such as https://example.com' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'The address must start with http:// or https://' };
  if (!url.hostname) return { ok: false, error: 'The address needs a host name' };
  if (url.username || url.password) return { ok: false, error: 'Remove the user name and password from the address' };
  return { ok: true, normalized: `${url.protocol}//${url.hostname.replace(/\.$/, '')}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/+$/, '')}` };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

export interface DataStatusDto {
  bytes: number;
  warningBytes: number;
  level: 'ok' | 'warning';
  ingestionStoppedReason: string | null;
  datasets: Array<{ id: 'gsc' | 'ga4'; label: string; rows: number; oldestDay: string | null; lastSyncAt: string | null }>;
  sync: { kind: 'backfill' | 'sync'; status: 'running' | 'done' | 'failed' | 'cancelled'; done: number; total: number; startedAt: string; finishedAt: string | null; error: string | null; waitingUntil: string | null } | null;
  retention: { months: number; ackedMonths: number | null; needsNotice: boolean; description: string; discarding: boolean; lastDiscardAt: string | null };
  previousProperties: ConnectionsViewDto['previousProperties'];
}

export interface DiscardPreviewDto {
  months: number;
  cutoff: string | null;
  total: number;
  tables: Array<{ table: string; label: string; count: number }>;
  acknowledged: boolean;
  note: string;
}

export interface RetentionNotice { title: string; lines: string[]; confirmLabel: string; discardLabel: string }

/** What the person is told before anything is discarded: the counts, the cutoff and the year-over-year limit. */
export function retentionNotice(preview: DiscardPreviewDto): RetentionNotice {
  const lines = preview.tables.filter((t) => t.table !== 'fetch_ledger').map((t) => `${formatCount(t.count)} ${t.label.toLowerCase()} dated before ${preview.cutoff ?? 'the cutoff'}`);
  return {
    title: `Discard data older than ${preview.months} month${preview.months === 1 ? '' : 's'}?`,
    lines: [...(lines.length ? lines : ['Nothing is old enough to discard yet.']), preview.note],
    confirmLabel: 'I understand, allow discarding',
    discardLabel: preview.total > 0 ? `Discard ${formatCount(preview.total)} rows now` : 'Nothing to discard',
  };
}

export function oldestDataLabel(oldestDay: string | null): string {
  return oldestDay ?? 'No data yet';
}

export const SYNC_POLL_MS = 1500;

/** Polling runs only while something is syncing or discarding. */
export function shouldPoll(connections: ConnectionDto[] | undefined, data: DataStatusDto | null | undefined): boolean {
  return Boolean(connections?.some((c) => c.state === 'syncing') || data?.sync?.status === 'running' || data?.retention.discarding);
}
