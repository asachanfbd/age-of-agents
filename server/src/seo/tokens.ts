import { SecretsStore } from '../buildings/secrets.ts';
import { ServiceError } from './errors.ts';
import type { GoogleService } from './settings.ts';
import { readSettings, updateSettings } from './settings.ts';
import type { SeoServices } from './services.ts';
import { readGoogleClient } from './googleClient.ts';

/** Refresh this long before the access token expires so a call never starts with a token about to die. */
export const REFRESH_SKEW_MS = 120_000;

export const secretKeys = {
  refresh: (service: GoogleService) => `google.${service}.refreshToken`,
  access: (service: GoogleService) => `google.${service}.accessToken`,
  adsDeveloperToken: 'ads.developerToken',
  bingApiKey: 'bing.apiKey',
  indexNowKey: 'indexnow.key',
} as const;

export interface TokenDeps { services: SeoServices; now: () => Date }

const inflight = new Map<string, Promise<string>>();

/** Stores a token pair for a service, remembering when the access token dies. */
export async function saveTokens(buildingId: string, service: GoogleService, tokens: { accessToken: string; refreshToken?: string; expiresInSec: number }, now: Date): Promise<void> {
  const secrets = new SecretsStore(buildingId);
  await secrets.set(secretKeys.access(service), tokens.accessToken);
  if (tokens.refreshToken) await secrets.set(secretKeys.refresh(service), tokens.refreshToken);
  await updateSettings(buildingId, (s) => { s.connections[service].accessExpiresAt = new Date(now.getTime() + tokens.expiresInSec * 1000).toISOString(); });
}

/** A usable access token for a service, refreshed when near expiry. Concurrent callers share one refresh. Throws `ServiceError('auth')` when only reconnecting can help. */
export function accessTokenFor(buildingId: string, service: GoogleService, deps: TokenDeps): Promise<string> {
  const key = `${buildingId}:${service}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = (async () => {
    const settings = await readSettings(buildingId);
    const secrets = new SecretsStore(buildingId);
    const expiresAt = settings?.connections[service].accessExpiresAt;
    const access = await secrets.get(secretKeys.access(service));
    if (access && expiresAt && Date.parse(expiresAt) - deps.now().getTime() > REFRESH_SKEW_MS) return access;
    // The app-wide client: a Building whose sign-in came from another client is refused by Google and must reconnect.
    const [client, refreshToken] = await Promise.all([readGoogleClient(), secrets.get(secretKeys.refresh(service))]);
    if (!client || !refreshToken) throw new ServiceError('auth', 'Google sign-in is missing; connect the service again');
    const tokens = await deps.services.oauth.refresh({ ...client, refreshToken });
    await saveTokens(buildingId, service, tokens, deps.now());
    return tokens.accessToken;
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}
