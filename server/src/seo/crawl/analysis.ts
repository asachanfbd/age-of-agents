import { INCOMPLETE_AVG_LINKS, INCOMPLETE_MIN_PAGES, MAX_REDIRECT_HOPS } from './rules.ts';
import { isHtml } from './fetchPage.ts';
import type { LinkRecord, PageRecord, RawLink } from './types.ts';

export type Resolution = { kind: 'page'; page: PageRecord } | { kind: 'external' } | { kind: 'loop' } | { kind: 'too-many' } | { kind: 'unknown' };

/** Follows `redirectTo` from an address to the page that finally answers. */
export function resolveFinal(url: string, pages: Map<string, PageRecord>): Resolution {
  const seen = new Set<string>();
  let current = url;
  for (let hop = 0; ; hop++) {
    const page = pages.get(current);
    if (!page) return { kind: 'unknown' };
    if (!page.redirectTo) return { kind: 'page', page };
    if (page.redirectExternal) return { kind: 'external' };
    if (seen.has(current)) return { kind: 'loop' };
    seen.add(current);
    if (hop >= MAX_REDIRECT_HOPS) return { kind: 'too-many' };
    current = page.redirectTo;
  }
}

/** True for a page that is a node in the graph: it answered itself (no redirect) or failed. */
export const isNode = (page: PageRecord) => !page.redirectTo;

const isBroken = (page: PageRecord) => (page.status !== null && page.status >= 400) || (page.status === null && page.error !== 'robots');

export interface Analysis { pages: PageRecord[]; links: LinkRecord[]; uncrawledLinks: number; incomplete: boolean }

/**
 * Turns raw crawl results into the stored snapshot content: links to a redirecting address are attributed to the page it ends
 * on (and keep the address in `via`), loops and over-long chains are recorded on the page as failed, counts are per unique
 * page pair (a page linking twice to one target counts once), depth is the fewest clicks from the home page, and an orphan is a
 * sitemap page with no inbound internal link.
 */
export function analyse(input: PageRecord[], rawLinks: RawLink[], sitemapUrls: Iterable<string>, homeKey: string): Analysis {
  const pages = input.map((p): PageRecord => ({ ...p, depth: null, inbound: 0, outbound: 0, orphan: false, inSitemap: false }));
  const byUrl = new Map(pages.map((p) => [p.url, p]));

  for (const page of pages) {
    if (!page.redirectTo || page.redirectExternal) continue;
    const res = resolveFinal(page.url, byUrl);
    if (res.kind === 'loop') page.error = 'redirect-loop';
    else if (res.kind === 'too-many') page.error = 'too-many-redirects';
  }
  for (const url of sitemapUrls) {
    const res = resolveFinal(url, byUrl);
    const own = byUrl.get(url);
    if (own) own.inSitemap = true;
    if (res.kind === 'page') res.page.inSitemap = true;
  }

  const links: LinkRecord[] = [];
  const keys = new Set<string>();
  let uncrawledLinks = 0;
  for (const raw of rawLinks) {
    const res = resolveFinal(raw.to, byUrl);
    if (res.kind === 'external') continue;
    if (res.kind !== 'page') { uncrawledLinks += 1; continue; }
    const target = res.page;
    if (target.url === raw.from) continue;
    const via = target.url === raw.to ? null : raw.to;
    const key = `${raw.from}\n${target.url}\n${raw.anchor}\n${raw.location}\n${via ?? ''}`;
    if (keys.has(key)) continue;
    keys.add(key);
    links.push({ from: raw.from, to: target.url, anchor: raw.anchor, nofollow: raw.nofollow, location: raw.location, via, broken: isBroken(target) });
  }

  const inFrom = new Map<string, Set<string>>();
  const outTo = new Map<string, Set<string>>();
  for (const l of links) {
    (inFrom.get(l.to) ?? inFrom.set(l.to, new Set()).get(l.to)!).add(l.from);
    (outTo.get(l.from) ?? outTo.set(l.from, new Set()).get(l.from)!).add(l.to);
  }
  const homeRes = resolveFinal(homeKey, byUrl);
  const home = homeRes.kind === 'page' ? homeRes.page : null;
  const queue: PageRecord[] = [];
  if (home) { home.depth = 0; queue.push(home); }
  for (let i = 0; i < queue.length; i++) {
    const page = queue[i]!;
    for (const to of outTo.get(page.url) ?? []) {
      const next = byUrl.get(to)!;
      if (next.depth === null) { next.depth = page.depth! + 1; queue.push(next); }
    }
  }
  for (const page of pages) {
    page.inbound = inFrom.get(page.url)?.size ?? 0;
    page.outbound = outTo.get(page.url)?.size ?? 0;
    page.orphan = isNode(page) && page.inSitemap && page.inbound === 0 && page !== home;
  }
  return { pages, links, uncrawledLinks, incomplete: looksIncomplete(pages) };
}

/** Few internal links per HTML page usually means the site builds its links with JavaScript, which this crawl does not run. */
export function looksIncomplete(pages: PageRecord[]): boolean {
  const html = pages.filter((p) => isNode(p) && p.status !== null && p.status < 400 && isHtml(p.contentType) && !p.error);
  if (html.length < INCOMPLETE_MIN_PAGES) return false;
  return html.reduce((sum, p) => sum + p.outbound, 0) / html.length < INCOMPLETE_AVG_LINKS;
}
