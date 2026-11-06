import { SeoInputError } from './errors.ts';

export const MAX_SITE_URL_LENGTH = 2048;

/**
 * The canonical form of a site URL: http or https, lowercase host without a trailing dot, default port dropped, no
 * credentials, query or fragment, and no trailing slash. `www.` is kept because it is a different GSC property.
 */
export function normalizeSiteUrl(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new SeoInputError('siteUrl is required');
  const text = input.trim();
  if (text.length > MAX_SITE_URL_LENGTH) throw new SeoInputError(`siteUrl must be at most ${MAX_SITE_URL_LENGTH} characters`);
  if (/\s/.test(text)) throw new SeoInputError('siteUrl must not contain spaces');
  let url: URL;
  try { url = new URL(text); } catch { throw new SeoInputError('siteUrl must be a full http or https address such as https://example.com'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SeoInputError('siteUrl must start with http:// or https://');
  if (!url.hostname) throw new SeoInputError('siteUrl needs a host name');
  if (url.username || url.password) throw new SeoInputError('siteUrl must not contain a user name or password');
  const host = url.hostname.replace(/\.$/, '');
  const port = url.port ? `:${url.port}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${host}${port}${path}`;
}

export function siteHost(siteUrl: string): string {
  return new URL(siteUrl).hostname;
}
