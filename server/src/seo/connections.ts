import { randomBytes } from 'node:crypto';
import { SecretsStore } from '../buildings/secrets.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, SeoUpstreamError, ServiceError } from './errors.ts';
import type { ConnectionRecord, GoogleService, ServiceId } from './settings.ts';
import { GOOGLE_SERVICES, readSettings, updateSettings } from './settings.ts';
import { GOOGLE_SCOPES } from './services.ts';
import type { PropertyChoice } from './services.ts';
import { runningSync, stopSync, syncBusy } from './sync.ts';
import { accessTokenFor, saveTokens, secretKeys } from './tokens.ts';
import { googleClientSaved, readGoogleClient } from './googleClient.ts';
import { siteHost } from './siteUrl.ts';

export type ConnectionState = 'not-connected' | 'connected' | 'needs-attention' | 'syncing';

/** A connection that failed or was refused shows its reason as needing attention, even when it never finished connecting. */
export function deriveState(record: Pick<ConnectionRecord, 'connected' | 'reason'>, syncing: boolean): ConnectionState {
  if (syncing && record.connected) return 'syncing';
  if (record.reason) return 'needs-attention';
  return record.connected ? 'connected' : 'not-connected';
}

export const isGoogleService = (value: string): value is GoogleService => (GOOGLE_SERVICES as readonly string[]).includes(value);

interface PendingConsent { buildingId: string; service: GoogleService; redirectUri: string; expiresAt: number }
const consents = new Map<string, PendingConsent>();

const secretsOf = (buildingId: string) => new SecretsStore(buildingId);

/** Starts the consent flow for one Google service and returns the link to open. The state is single use and expires. */
export async function startConsent(buildingId: string, service: GoogleService, redirectUri: string): Promise<{ authUrl: string }> {
  const client = await readGoogleClient();
  if (!client) throw new SeoInputError('Add the Google client in Settings > Google (SEO) first');
  const { now, services, oauthStateTtlMs } = seoDeps();
  for (const [state, c] of consents) if (c.expiresAt <= now().getTime()) consents.delete(state);
  const state = randomBytes(24).toString('base64url');
  consents.set(state, { buildingId, service, redirectUri, expiresAt: now().getTime() + oauthStateTtlMs });
  return { authUrl: services.oauth.authUrl({ clientId: client.clientId, redirectUri, scopes: [...GOOGLE_SCOPES[service]], state }) };
}

export interface ConsentResult { buildingId: string; service: GoogleService; ok: boolean; message: string }

/** Finishes the consent flow from Google's redirect. A wrong, expired or reused state is refused. */
export async function completeConsent(query: { code?: unknown; state?: unknown; error?: unknown }): Promise<ConsentResult> {
  const state = typeof query.state === 'string' ? query.state : '';
  const pending = consents.get(state);
  consents.delete(state);
  const { now, services } = seoDeps();
  if (!pending || pending.expiresAt <= now().getTime()) throw new SeoInputError('This sign-in link is invalid or has expired. Start again from Settings.');
  const { buildingId, service } = pending;
  if (typeof query.error === 'string' || typeof query.code !== 'string' || !query.code) {
    const message = query.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google did not complete the sign-in.';
    await updateSettings(buildingId, (s) => { s.connections[service].reason = message; });
    return { buildingId, service, ok: false, message };
  }
  const client = await readGoogleClient();
  if (!client) throw new SeoInputError('The saved Google client is missing');
  let tokens;
  try { tokens = await services.oauth.exchangeCode({ ...client, code: query.code, redirectUri: pending.redirectUri }); } catch (error) {
    const message = error instanceof ServiceError ? error.message : 'Google sign-in failed.';
    await updateSettings(buildingId, (s) => { s.connections[service].reason = message; });
    return { buildingId, service, ok: false, message };
  }
  if (!tokens.refreshToken) {
    const message = 'Google did not return a long-lived sign-in. Remove the app from your Google account permissions and connect again.';
    await updateSettings(buildingId, (s) => { s.connections[service].reason = message; });
    return { buildingId, service, ok: false, message };
  }
  // Tokens first: a connection is never marked connected without a usable token behind it.
  await saveTokens(buildingId, service, tokens, now());
  await updateSettings(buildingId, (s) => { s.connections[service] = { ...s.connections[service], connected: true, account: tokens.account, connectedAt: now().toISOString(), reason: null, backoffUntil: null }; });
  return { buildingId, service, ok: true, message: 'Connected. You can close this tab and return to the app.' };
}

/** The properties the connected account can see, from the live service. A refusal is reported and changes nothing. */
export async function listProperties(buildingId: string, service: 'gsc' | 'ga4'): Promise<PropertyChoice[]> {
  const settings = await readSettings(buildingId);
  if (!settings?.connections[service].connected) throw new SeoConflictError('Connect this service first');
  const { services, now } = seoDeps();
  try {
    const token = await accessTokenFor(buildingId, service, { services, now });
    return await services[service].listProperties(token);
  } catch (error) {
    if (error instanceof ServiceError) throw new SeoUpstreamError(error.message);
    throw error;
  }
}

/** Picks the property to read. Changing an already chosen one needs `confirm`; the old property's data stays and is marked as the previous property. */
export async function selectProperty(buildingId: string, service: 'gsc' | 'ga4', property: unknown, confirm: boolean): Promise<void> {
  if (typeof property !== 'string' || !property) throw new SeoInputError('property is required');
  if (syncBusy(buildingId)) throw new SeoConflictError('A sync is running; wait for it to finish before changing the property');
  const choices = await listProperties(buildingId, service);
  if (!choices.some((c) => c.id === property)) throw new SeoInputError('That property is not in the list this Google account can see');
  const current = (await readSettings(buildingId))!.connections[service].property;
  if (current && current !== property && !confirm) {
    throw new SeoConflictError('Changing the property needs confirmation. The data already stored is kept and marked as belonging to the previous property.', { requiresConfirmation: true, from: current, to: property });
  }
  await updateSettings(buildingId, (s) => {
    const c = s.connections[service];
    if (current && current !== property) s.previousProperties.push({ service, property: current, replacedAt: seoDeps().now().toISOString() });
    c.property = property;
    c.reason = null;
    c.backoffUntil = null;
  });
}

/** Stops syncing and forgets the sign-in; the data already stored stays. Safe to repeat. */
export async function disconnect(buildingId: string, service: ServiceId): Promise<void> {
  // Only the Google data services sync; disconnecting Ads, Bing or IndexNow leaves a running backfill alone.
  if (service === 'gsc' || service === 'ga4') await stopSync(buildingId);
  const secrets = secretsOf(buildingId);
  const keys = service === 'gsc' || service === 'ga4' ? [secretKeys.access(service), secretKeys.refresh(service)]
    : service === 'ads' ? [secretKeys.access('ads'), secretKeys.refresh('ads'), secretKeys.adsDeveloperToken]
      : service === 'bing' ? [secretKeys.bingApiKey] : [secretKeys.indexNowKey];
  for (const key of keys) await secrets.delete(key);
  await updateSettings(buildingId, (s) => {
    const previous = s.connections[service];
    if ((service === 'gsc' || service === 'ga4') && previous.property && previous.connected) s.previousProperties.push({ service, property: previous.property, replacedAt: seoDeps().now().toISOString() });
    s.connections[service] = { connected: false };
  });
}

const DEVELOPER_TOKEN = /^[A-Za-z0-9_-]{10,64}$/;
const CUSTOMER_ID = /^\d{3}-?\d{3}-?\d{4}$/;

/** Attaches Google Ads (Keyword Planner) and checks what the account really returns, exact numbers or ranges. */
export async function connectAds(buildingId: string, input: { developerToken?: unknown; customerId?: unknown }): Promise<{ ok: boolean; volume: 'exact' | 'range' | 'unknown'; message?: string }> {
  if (typeof input.developerToken !== 'string' || !DEVELOPER_TOKEN.test(input.developerToken.trim())) throw new SeoInputError('A Google Ads developer token is required');
  if (typeof input.customerId !== 'string' || !CUSTOMER_ID.test(input.customerId.trim())) throw new SeoInputError('customerId must look like 123-456-7890');
  const settings = await readSettings(buildingId);
  if (!settings?.connections.ads.connected) throw new SeoConflictError('Sign in with Google for Ads first');
  const { services, now } = seoDeps();
  await secretsOf(buildingId).set(secretKeys.adsDeveloperToken, input.developerToken.trim());
  let result;
  try {
    const accessToken = await accessTokenFor(buildingId, 'ads', { services, now });
    result = await services.ads.check({ accessToken, developerToken: input.developerToken.trim(), customerId: input.customerId.trim() });
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    result = { ok: false, volume: 'unknown' as const, message: error.message };
  }
  await updateSettings(buildingId, (s) => {
    Object.assign(s.connections.ads, { customerId: input.customerId, volume: result.volume, checkedAt: now().toISOString(), reason: result.ok ? null : result.message ?? 'Google Ads access does not work yet.' });
  });
  return result;
}

/** Attaches Bing Webmaster with an API key and checks that it can see this site. */
export async function connectBing(buildingId: string, apiKey: unknown): Promise<{ ok: boolean; message?: string }> {
  if (typeof apiKey !== 'string' || apiKey.trim().length < 8) throw new SeoInputError('A Bing Webmaster API key is required');
  const settings = (await readSettings(buildingId))!;
  await secretsOf(buildingId).set(secretKeys.bingApiKey, apiKey.trim());
  let result: { ok: boolean; message?: string };
  try { result = await seoDeps().services.bing.check({ apiKey: apiKey.trim(), siteUrl: settings.siteUrl }); } catch (error) {
    result = { ok: false, message: error instanceof ServiceError ? error.message : 'Bing could not be reached.' };
  }
  await updateSettings(buildingId, (s) => {
    Object.assign(s.connections.bing, { connected: true, account: siteHost(s.siteUrl), checkedAt: seoDeps().now().toISOString(), reason: result.ok ? null : result.message ?? 'Bing access does not work yet.' });
  });
  return result;
}

const INDEXNOW_KEY = /^[A-Za-z0-9-]{8,128}$/;

export function validateIndexNowKey(key: unknown): string {
  if (typeof key !== 'string' || !INDEXNOW_KEY.test(key)) throw new SeoInputError('An IndexNow key is 8 to 128 letters, digits or dashes');
  return key;
}

/** Saves the IndexNow key (generated when the caller sends none). The Sitemaps task serves it from the site. */
export async function saveIndexNowKey(buildingId: string, key: unknown): Promise<void> {
  const value = key === undefined || key === null ? randomBytes(16).toString('hex') : validateIndexNowKey(key);
  await secretsOf(buildingId).set(secretKeys.indexNowKey, value);
  await updateSettings(buildingId, (s) => { s.connections.indexnow = { connected: true, connectedAt: seoDeps().now().toISOString() }; });
}

export interface ConnectionView {
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

/** Everything the Connections screen shows. Secrets appear only as the `saved` flags. */
export async function connectionsView(buildingId: string) {
  const settings = (await readSettings(buildingId))!;
  const secrets = await secretsOf(buildingId).list();
  const has = (key: string) => secrets.some((s) => s.key === key);
  const job = runningSync(buildingId);
  const views = (['gsc', 'ga4', 'ads', 'bing', 'indexnow'] as const).map((service): ConnectionView => {
    const c = settings.connections[service];
    const syncing = job !== undefined && (service === 'gsc' || service === 'ga4') && c.connected && job.dataset === service;
    const state = deriveState(c, syncing);
    return {
      service, state, account: c.account, property: c.property, reason: c.reason ?? undefined, lastSyncAt: c.lastSyncAt,
      progress: syncing ? { done: job!.done, total: job!.total } : undefined, volume: c.volume, customerId: c.customerId,
    };
  });
  return {
    siteUrl: settings.siteUrl,
    googleClientSaved: await googleClientSaved(),
    adsDeveloperTokenSaved: has(secretKeys.adsDeveloperToken),
    bingKeySaved: has(secretKeys.bingApiKey),
    indexNowKeySaved: has(secretKeys.indexNowKey),
    connections: views,
    previousProperties: settings.previousProperties,
    keywordMarket: settings.keywordMarket ?? null,
  };
}
