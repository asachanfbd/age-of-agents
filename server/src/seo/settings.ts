import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildingDir } from '../buildings/secrets.ts';
import { DEFAULT_RETENTION_MONTHS } from './dates.ts';
import { SeoNotFoundError } from './errors.ts';

export type ServiceId = 'gsc' | 'ga4' | 'ads' | 'bing' | 'indexnow';
export const GOOGLE_SERVICES = ['gsc', 'ga4', 'ads'] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

/** Everything a connection remembers that is not a secret. Tokens and keys live in the secrets store. */
export interface ConnectionRecord {
  connected: boolean;
  account?: string;
  property?: string;
  connectedAt?: string;
  /** When the saved access token stops working (ISO). */
  accessExpiresAt?: string;
  lastSyncAt?: string;
  /** Why the connection needs attention; cleared by the next success. */
  reason?: string | null;
  /** While set and in the future, sync leaves this connection alone (quota back-off). */
  backoffUntil?: string | null;
  /** Ads only: how volumes came back at the last check. */
  volume?: 'exact' | 'range' | 'unknown';
  /** Ads: customer id; Bing: nothing. */
  customerId?: string;
  checkedAt?: string;
}

export interface PreviousProperty { service: 'gsc' | 'ga4'; property: string; replacedAt: string }

export interface SeoSettings {
  siteUrl: string;
  retentionMonths: number;
  /** The window the person was last told about; discarding is allowed only when the window is no smaller than this. */
  retentionAckedMonths: number | null;
  connections: Record<ServiceId, ConnectionRecord>;
  previousProperties: PreviousProperty[];
  /** Language and location Keyword Planner uses (Google Ads ids); research gives no volumes until both are set. */
  keywordMarket?: { languageId: string; locationId: string };
  /** When the person last started a discard (ISO). */
  lastDiscardAt?: string | null;
}

export function defaultSettings(siteUrl: string): SeoSettings {
  return {
    siteUrl,
    retentionMonths: DEFAULT_RETENTION_MONTHS,
    retentionAckedMonths: null,
    connections: { gsc: { connected: false }, ga4: { connected: false }, ads: { connected: false }, bing: { connected: false }, indexnow: { connected: false } },
    previousProperties: [],
  };
}

const queues = new Map<string, Promise<unknown>>();

const fileOf = (buildingId: string) => path.join(buildingDir(buildingId), 'seo.json');

export async function readSettings(buildingId: string): Promise<SeoSettings | null> {
  try {
    const parsed = JSON.parse(await readFile(fileOf(buildingId), 'utf8')) as SeoSettings;
    return { ...defaultSettings(parsed.siteUrl), ...parsed, connections: { ...defaultSettings(parsed.siteUrl).connections, ...parsed.connections } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function write(buildingId: string, settings: SeoSettings): Promise<void> {
  const file = fileOf(buildingId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2));
  await rename(tmp, file);
}

/** Read-modify-write of one Building's settings, queued so two changes never overwrite each other. */
export function updateSettings(buildingId: string, change: (settings: SeoSettings) => void): Promise<SeoSettings> {
  const run = async () => {
    const settings = await readSettings(buildingId);
    if (!settings) throw new SeoNotFoundError();
    change(settings);
    await write(buildingId, settings);
    return settings;
  };
  const next = (queues.get(buildingId) ?? Promise.resolve()).then(run, run);
  queues.set(buildingId, next.catch(() => undefined));
  return next;
}

export async function createSettings(buildingId: string, siteUrl: string): Promise<void> {
  await write(buildingId, defaultSettings(siteUrl));
}
