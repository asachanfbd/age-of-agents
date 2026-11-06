import { normalizePageUrl } from '../urls.ts';

/**
 * The crawl's view of the Building's site. Pages are keyed by the normalised address (always `https://`, see
 * `normalizePageUrl`) so they line up with the Pages tab; the real request uses the site's own scheme.
 */
export class CrawlSite {
  readonly host: string;
  readonly #alias: string;
  #scheme: 'http' | 'https';
  #requestHost: string;

  constructor(siteUrl: string) {
    const url = new URL(siteUrl);
    this.#scheme = url.protocol === 'http:' ? 'http' : 'https';
    this.host = url.host.toLowerCase().replace(/\.$/, '');
    this.#requestHost = this.host;
    this.#alias = this.host.startsWith('www.') ? this.host.slice(4) : `www.${this.host}`;
  }

  /** The page key for a link or Location, or null when it is not a followable address. `www.` and the bare host are one site. */
  keyOf(href: string, base: string): string | null {
    let absolute: string;
    try { absolute = new URL(href, base).href; } catch { return null; }
    const key = normalizePageUrl(absolute);
    if (!key) return null;
    const url = new URL(key);
    if (url.host === this.#alias) { url.host = this.host; return normalizePageUrl(url.href) ?? null; }
    return key;
  }

  isInternal(key: string): boolean {
    return new URL(key).host === this.host;
  }

  /** Where requests actually go: the configured address until a redirect shows the site answers on another scheme or `www.` variant. */
  get origin(): string {
    return `${this.#scheme}://${this.#requestHost}`;
  }

  /** The address to request for a page key. */
  fetchUrl(key: string): string {
    return `${this.origin}${key.slice(`https://${this.host}`.length)}`;
  }

  /**
   * Learns the site's real origin from a redirect `Location`. Pages are keyed by one host, so a redirect that only switches
   * `http`/`https` or `www.`/bare maps back to the same key; requests must follow it for the page to ever answer.
   * Returns true when the origin changed.
   */
  adoptOrigin(location: string, base: string): boolean {
    let url: URL;
    try { url = new URL(location, base); } catch { return false; }
    const host = url.host.toLowerCase().replace(/\.$/, '');
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || (host !== this.host && host !== this.#alias)) return false;
    const scheme = url.protocol === 'http:' ? 'http' : 'https';
    if (scheme === this.#scheme && host === this.#requestHost) return false;
    this.#scheme = scheme;
    this.#requestHost = host;
    return true;
  }

  /**
   * For a redirect that lands on the same page key (a scheme, `www.` or trailing-slash change), returns the literal address to
   * request next, adopting its origin. Null when the redirect leaves the site, reaches another page, or repeats `base` unchanged.
   */
  sameKeyRedirect(location: string, base: string, key: string): string | null {
    if (this.keyOf(location, base) !== key) return null;
    const next = new URL(location, base);
    const host = next.host.toLowerCase().replace(/\.$/, '');
    if ((next.protocol !== 'http:' && next.protocol !== 'https:') || (host !== this.host && host !== this.#alias)) return null;
    if (next.href === new URL(base).href) return null;
    this.adoptOrigin(location, base);
    return next.href;
  }

  get homeKey(): string {
    return `https://${this.host}/`;
  }
}
