import { addDays } from './dates.ts';
import { SeoInputError } from './errors.ts';
import { statusOf } from './backlinkImport.ts';
import type { LinkRec, LinkStatus } from './backlinkImport.ts';
import { LINK_STATUSES } from './backlinkImport.ts';
import { LINK_TYPES } from './backlinkRows.ts';

export const PERIOD_DAYS = [7, 28, 90] as const;
export const DEFAULT_PERIOD = 28;
export const MAX_SEARCH_LENGTH = 200;
export const LINK_SORTS = ['source', 'domain', 'target', 'anchor', 'type', 'firstSeen', 'lastSeen', 'status', 'dr', 'ur', 'traffic', 'pageDr', 'pageTraffic'] as const;
export type LinkSort = (typeof LINK_SORTS)[number];
export const LINK_VIEWS = ['all', 'new', 'lost'] as const;
export type LinkView = (typeof LINK_VIEWS)[number];

export interface LinkQuery {
  view: LinkView;
  period: number;
  status: LinkStatus | null;
  type: string | null;
  drMin: number | null;
  drMax: number | null;
  domain: string;
  target: string;
  search: string;
  sort: LinkSort;
  dir: 'asc' | 'desc';
}

/** The first day of a period of `days` days ending today; a link first seen on that day is inside it. */
export const periodStart = (today: string, days: number): string => addDays(today, -days);

export function requirePeriod(value: unknown): number {
  if (value === undefined || value === '') return DEFAULT_PERIOD;
  const n = Number(value);
  if (!(PERIOD_DAYS as readonly number[]).includes(n)) throw new SeoInputError(`period must be one of ${PERIOD_DAYS.join(', ')}`);
  return n;
}

export const requireNote = (value: unknown): string => {
  if (value !== undefined && typeof value !== 'string') throw new SeoInputError('note must be text');
  const note = (value ?? '').trim();
  if (note.length > 2000) throw new SeoInputError('A note can be at most 2,000 characters.');
  return note;
};

export const isLive = (link: LinkRec): boolean => !link.lostAt;

const nullsLast = (a: number | string | null, b: number | string | null, dir: 1 | -1): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a < b ? -dir : a > b ? dir : 0;
};

function sortValue(link: LinkRec, sort: LinkSort, latestBatch: number): number | string | null {
  switch (sort) {
    case 'source': return link.sourceUrl;
    case 'domain': return link.sourceHost;
    case 'target': return link.targetUrl;
    case 'anchor': return link.anchor.toLowerCase();
    case 'type': return link.linkType;
    case 'firstSeen': return link.firstSeen;
    case 'lastSeen': return link.lastSeen;
    case 'status': return statusOf(link, latestBatch);
    case 'dr': return link.sourceDr;
    case 'ur': return link.sourceUr;
    case 'traffic': return link.sourceTraffic;
    case 'pageDr': return link.pageDr;
    case 'pageTraffic': return link.pageTraffic;
  }
}

export function validateQuery(q: LinkQuery): LinkQuery {
  if (q.drMin !== null && q.drMax !== null && q.drMin > q.drMax) throw new SeoInputError('The lowest DR cannot be above the highest DR.');
  if (q.status !== null && !LINK_STATUSES.includes(q.status)) throw new SeoInputError(`status must be one of ${LINK_STATUSES.join(', ')}`);
  if (q.type !== null && !(LINK_TYPES as readonly string[]).includes(q.type)) throw new SeoInputError(`type must be one of ${LINK_TYPES.join(', ')}`);
  if (q.search.length > MAX_SEARCH_LENGTH) throw new SeoInputError(`search can be at most ${MAX_SEARCH_LENGTH} characters`);
  return q;
}

/** The links a query selects, sorted. Empty values sort last in either direction and ties break on the link id, so pages never overlap. */
export function selectLinks(links: LinkRec[], q: LinkQuery, latestBatch: number, today: string): LinkRec[] {
  const from = periodStart(today, q.period);
  const needle = q.search.toLowerCase();
  const domain = q.domain.toLowerCase();
  const picked = links.filter((l) => {
    if (q.view === 'new' && (!isLive(l) || l.firstSeen < from)) return false;
    if (q.view === 'lost' && (!l.lostAt || l.lostAt < from)) return false;
    if (q.status && statusOf(l, latestBatch) !== q.status) return false;
    if (q.type && !(l.linkType ?? '').split(',').includes(q.type)) return false;
    if ((q.drMin !== null || q.drMax !== null) && (l.sourceDr === null || (q.drMin !== null && l.sourceDr < q.drMin) || (q.drMax !== null && l.sourceDr > q.drMax))) return false;
    if (domain && l.sourceHost !== domain) return false;
    if (q.target && l.targetUrl !== q.target) return false;
    return !needle || `${l.sourceUrl}\n${l.anchor}\n${l.targetUrl}`.toLowerCase().includes(needle);
  });
  const dir = q.dir === 'asc' ? 1 : -1;
  return picked.sort((a, b) => nullsLast(sortValue(a, q.sort, latestBatch), sortValue(b, q.sort, latestBatch), dir) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

export interface DomainRollup { domain: string; links: number; bestDr: number | null; totalTraffic: number | null }
export interface TargetRollup { target: string; links: number; domains: number; bestDr: number | null; otherHost: boolean }

const maxOf = (values: Array<number | null>): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => (b > a ? b : a)) : null;
};
const sumOf = (values: Array<number | null>): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
};

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  return groups;
}

/** Links per referring domain over the links that are not lost. Domains are exact hosts: `www.` and subdomains are separate. */
export function domainRollup(links: LinkRec[]): DomainRollup[] {
  return [...groupBy(links.filter(isLive), (l) => l.sourceHost)].map(([domain, rows]) => ({
    domain, links: rows.length, bestDr: maxOf(rows.map((r) => r.sourceDr)), totalTraffic: sumOf(rows.map((r) => r.sourceTraffic)),
  })).sort((a, b) => b.links - a.links || (a.domain < b.domain ? -1 : 1));
}

export function targetRollup(links: LinkRec[]): TargetRollup[] {
  return [...groupBy(links.filter(isLive), (l) => l.targetUrl)].map(([target, rows]) => ({
    target, links: rows.length, domains: new Set(rows.map((r) => r.sourceHost)).size, bestDr: maxOf(rows.map((r) => r.sourceDr)), otherHost: rows[0]!.otherHost,
  })).sort((a, b) => b.links - a.links || (a.target < b.target ? -1 : 1));
}

export interface BacklinkSummary {
  total: number;
  referringDomains: number;
  newInPeriod: number;
  lostInPeriod: number;
  /** Mean of each referring domain's best DR, over the domains that have one; null when none do. */
  averageDr: number | null;
  /** Links with a DR out of all links, so a partial import is visible. */
  withDr: number;
}

export function summarise(links: LinkRec[], period: number, today: string): BacklinkSummary {
  const live = links.filter(isLive);
  const from = periodStart(today, period);
  const drs = domainRollup(links).map((d) => d.bestDr).filter((v): v is number => v !== null);
  return {
    total: live.length,
    referringDomains: new Set(live.map((l) => l.sourceHost)).size,
    newInPeriod: live.filter((l) => l.firstSeen >= from).length,
    lostInPeriod: links.filter((l) => l.lostAt && l.lostAt >= from).length,
    averageDr: drs.length ? Math.round((drs.reduce((a, b) => a + b, 0) / drs.length) * 10) / 10 : null,
    withDr: live.filter((l) => l.sourceDr !== null).length,
  };
}
