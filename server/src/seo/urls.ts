/** The longest URL the sitemap protocol allows. */
export const MAX_PAGE_URL_LENGTH = 2048;

const TRACKING_PARAM = /^(utm_.*|gclid|fbclid|msclkid)$/i;
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** Upper-cases percent escapes and decodes the ones that stand for an unreserved character, so `%7e` and `~` are one path. */
function canonicalEscapes(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

function canonicalQuery(search: string): string {
  const kept = search.replace(/^\?/, '').split('&').filter((part) => {
    if (!part) return false;
    let name = part.split('=')[0]!;
    try { name = decodeURIComponent(name); } catch { /* keep the raw name */ }
    return !TRACKING_PARAM.test(name);
  });
  kept.sort();
  return kept.length ? `?${canonicalEscapes(kept.join('&'))}` : '';
}

/**
 * The one spelling of a page address, so variants count as one page: https, lowercase host, no fragment, default ports
 * (80 and 443) dropped, no trailing slash except the root, tracking parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`)
 * removed, the remaining parameters sorted, percent escapes in one case. Path case is kept, and `www.` is NOT merged with
 * the bare domain (they are different properties). Returns null for anything that is not an absolute http(s) address.
 */
export function normalizePageUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > MAX_PAGE_URL_LENGTH) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, '');
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  const path = canonicalEscapes(url.pathname).replace(/\/+$/, '') || '/';
  return `https://${host}${port}${path}${canonicalQuery(url.search)}`;
}

/** A page address as a site-relative path with its query, e.g. `/blog/post?page=2`. */
export function pathOf(normalizedUrl: string): string {
  const url = new URL(normalizedUrl);
  return `${url.pathname}${url.search}`;
}

/** Turns a GA4 `pagePath` (or any site-relative path) into the normalised page address for a site. */
export function pageUrlFromPath(path: string, siteUrl: string): string | null {
  if (!path.startsWith('/')) return null;
  return normalizePageUrl(new URL(path, siteUrl).href);
}

/** The domain behind a Search Console property: `sc-domain:example.com` or a URL-prefix property. */
export function propertyScope(property: string): { kind: 'domain'; domain: string } | { kind: 'prefix'; origin: string; path: string } | null {
  if (property.startsWith('sc-domain:')) return { kind: 'domain', domain: property.slice('sc-domain:'.length).toLowerCase() };
  try {
    const url = new URL(property);
    return { kind: 'prefix', origin: `${url.protocol}//${url.host}`.toLowerCase(), path: url.pathname };
  } catch { return null; }
}

/**
 * Whether a page belongs to a Search Console property. A domain property covers the domain and every subdomain over http
 * and https; a URL-prefix property covers exactly its host (www is different) and path prefix, in either protocol, because
 * the normalised address is always https.
 */
export function isOnProperty(normalizedUrl: string, property: string): boolean {
  const scope = propertyScope(property);
  if (!scope) return false;
  const url = new URL(normalizedUrl);
  if (scope.kind === 'domain') return url.hostname === scope.domain || url.hostname.endsWith(`.${scope.domain}`);
  const prefix = new URL(scope.origin);
  const hostMatches = url.hostname === prefix.hostname && (url.port === normalizedPort(prefix));
  return hostMatches && url.pathname.startsWith(scope.path.replace(/\/+$/, '') || '/');
}

const normalizedPort = (url: URL) => (url.port === '80' || url.port === '443' ? '' : url.port);

/** The address Google must be given to inspect a page: the property's own protocol for a URL-prefix property. */
export function inspectionUrlFor(normalizedUrl: string, property: string): string {
  const scope = propertyScope(property);
  return scope?.kind === 'prefix' && scope.origin.startsWith('http://') ? normalizedUrl.replace(/^https:/, 'http:') : normalizedUrl;
}

/** Whether a sitemap entry's host is the site's own host (case-insensitive; `www.` is a different host). */
export function isSiteHost(normalizedUrl: string, siteUrl: string, property?: string | null): boolean {
  const url = new URL(normalizedUrl);
  const site = new URL(siteUrl);
  if (url.hostname === site.hostname.toLowerCase() && url.port === normalizedPort(site)) return true;
  const scope = property ? propertyScope(property) : null;
  return scope?.kind === 'domain' && (url.hostname === scope.domain || url.hostname.endsWith(`.${scope.domain}`));
}

/** The spellings Search Console may have stored for one normalised page: both protocols, with and without a trailing slash, encoded and not. */
export function rawVariants(normalizedUrl: string): string[] {
  const url = new URL(normalizedUrl);
  const bare = url.pathname === '/' ? '' : url.pathname;
  const paths = new Set<string>([bare, `${bare}/`]);
  try { const decoded = decodeURI(bare); paths.add(decoded); paths.add(`${decoded}/`); } catch { /* not decodable */ }
  const out = new Set<string>();
  for (const scheme of ['https', 'http']) {
    for (const p of paths) out.add(`${scheme}://${url.host}${p}${url.search}`);
  }
  if (url.pathname === '/') for (const scheme of ['https', 'http']) out.add(`${scheme}://${url.host}`);
  return [...out];
}
