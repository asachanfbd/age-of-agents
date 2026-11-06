import type { ProjectRecord } from '../domain/types.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoUpstreamError, ServiceError } from './errors.ts';
import { readSettings } from './settings.ts';
import type { SeoSettings } from './settings.ts';
import { accessTokenFor } from './tokens.ts';

/** The Building's settings; every caller has already established that the Building is an SEO Building. */
export async function settingsOf(project: ProjectRecord): Promise<SeoSettings> {
  return (await readSettings(project.id))!;
}

export const gscPropertyOf = (settings: SeoSettings): string | null => {
  const c = settings.connections.gsc;
  return c.connected && c.property ? c.property : null;
};

/** The origin sitemaps, robots.txt and the IndexNow key file are read from: the site address the Building was created with. */
export const siteOrigin = (settings: SeoSettings): string => new URL(settings.siteUrl).origin;

/** Runs a Search Console call with a fresh token; the property must be chosen. A refusal becomes an upstream error with a reason the person can read. */
export async function withGsc<T>(project: ProjectRecord, call: (token: string, property: string) => Promise<T>): Promise<T> {
  const settings = await settingsOf(project);
  const property = gscPropertyOf(settings);
  if (!property) throw new SeoConflictError('Connect Search Console and choose a property first', { connect: 'gsc' });
  const { services, now } = seoDeps();
  const token = await accessTokenFor(project.id, 'gsc', { services, now }).catch((error) => {
    if (error instanceof ServiceError) throw new SeoUpstreamError(error.message);
    throw error;
  });
  return call(token, property);
}
