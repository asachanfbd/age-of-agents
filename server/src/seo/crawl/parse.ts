import * as cheerio from 'cheerio';
import { MAX_ANCHOR, MAX_DESCRIPTION, MAX_LINKS_PER_PAGE, MAX_TITLE } from './rules.ts';
import type { CrawlSite } from './site.ts';

export type LinkLocation = 'nav' | 'header' | 'footer' | 'body';

export interface ParsedLink { target: string; anchor: string; nofollow: boolean; location: LinkLocation }

export interface ParsedPage {
  title: string | null;
  description: string | null;
  canonical: string | null;
  noindex: boolean;
  links: ParsedLink[];
  /** Links to other hosts or schemes, counted not followed. */
  externalCount: number;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const SKIPPED_SCHEMES = /^(mailto|tel|javascript|data|sms|ftp|file|blob):/i;

/** A `<nav>` inside a footer counts as footer: the closest of footer, header, nav/role=navigation wins in that order. */
function locationOf($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): LinkLocation {
  const anchor = $(el);
  if (anchor.closest('footer, [role="contentinfo"]').length) return 'footer';
  if (anchor.closest('nav, [role="navigation"]').length) return 'nav';
  if (anchor.closest('header, [role="banner"]').length) return 'header';
  return 'body';
}

const noindexIn = (value: string | undefined) => !!value && /(^|[\s,])(noindex|none)([\s,]|$)/i.test(value);

/** Reads one HTML page. `pageUrl` is the address it was fetched from (for relative links); `xRobots` is the `X-Robots-Tag` header. */
export function parseHtml(html: string, pageUrl: string, site: CrawlSite, xRobots: string | null = null): ParsedPage {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').first().attr('href');
  const base = baseHref ? (() => { try { return new URL(baseHref, pageUrl).href; } catch { return pageUrl; } })() : pageUrl;
  const title = collapse($('head title').first().text() || $('title').first().text());
  const description = $('meta[name="description" i]').first().attr('content');
  const canonicalHref = $('link[rel~="canonical" i]').first().attr('href');
  let canonical: string | null = null;
  if (canonicalHref) { try { canonical = new URL(canonicalHref, base).href; } catch { canonical = null; } }
  const noindex = noindexIn(xRobots ?? undefined)
    || $('meta[name="robots" i], meta[name="googlebot" i]').toArray().some((m) => noindexIn($(m).attr('content')));

  const links: ParsedLink[] = [];
  let externalCount = 0;
  for (const el of $('a[href]').toArray()) {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || SKIPPED_SCHEMES.test(href)) continue;
    const key = site.keyOf(href, base);
    if (!key) continue;
    if (!site.isInternal(key)) { externalCount += 1; continue; }
    if (links.length >= MAX_LINKS_PER_PAGE) continue;
    const text = collapse($(el).text()) || collapse($(el).find('img[alt]').first().attr('alt') ?? '');
    links.push({
      target: key,
      anchor: truncate(text, MAX_ANCHOR),
      nofollow: /(^|\s)nofollow(\s|$)/i.test($(el).attr('rel') ?? ''),
      location: locationOf($, el),
    });
  }
  return {
    title: title ? truncate(title, MAX_TITLE) : null,
    description: description?.trim() ? truncate(collapse(description), MAX_DESCRIPTION) : null,
    canonical,
    noindex,
    links,
    externalCount,
  };
}
