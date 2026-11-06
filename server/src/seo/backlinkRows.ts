import { isIsoDay, addDays } from './dates.ts';
import { MAX_PAGE_URL_LENGTH, isSiteHost, normalizePageUrl } from './urls.ts';
import type { BacklinkField, Mapping } from './backlinkMapping.ts';

export const MAX_ANCHOR_LENGTH = 1000;
export const MAX_EXTRA_LENGTH = 500;
export const MAX_EXTRA_COLUMNS = 50;
export const MIN_LINK_DATE = '1990-01-01';
export const LINK_TYPES = ['follow', 'nofollow', 'sponsored', 'ugc'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** One valid link row as the importer applies it. A metric the file did not give is null, never 0. */
export interface LinkInput {
  key: string;
  sourceUrl: string;
  sourceHost: string;
  targetUrl: string;
  anchor: string;
  /** Comma-separated link types in a fixed order, or null when the file did not say. */
  linkType: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  sourceDr: number | null;
  sourceUr: number | null;
  sourceTraffic: number | null;
  pageDr: number | null;
  pageUr: number | null;
  pageTraffic: number | null;
  otherHost: boolean;
  extras: Record<string, string>;
}

export interface RowContext { siteUrl: string; today: string; headers: string[]; mapping: Mapping }
export type RowResult = { ok: true; link: LinkInput } | { ok: false; error: string; key: string | null };

export const linkKey = (sourceUrl: string, targetUrl: string, anchor: string): string => `${sourceUrl}\n${targetUrl}\n${anchor}`;

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A metric as a number, or null when blank. Both `62.5` and `62,5` are decimals; `12,400` is a thousand-separated whole number. */
export function parseMetric(raw: string, label: string, max: number | null): number | null {
  const text = raw.trim();
  if (!text) return null;
  const plain = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replace(/,/g, '') : /^-?\d+,\d{1,2}$/.test(text) ? text.replace(',', '.') : text;
  if (!/^-?\d+(\.\d+)?$/.test(plain)) throw new Error(`${label} is not a number: ${text.slice(0, 40)}`);
  const n = Number(plain);
  if (n < 0 || (max !== null && n > max) || !Number.isFinite(n)) throw new Error(`${label} is out of range: ${text.slice(0, 40)}${max !== null ? ` (0 to ${max})` : ''}`);
  return n;
}

function parseTraffic(raw: string, label: string): number | null {
  const n = parseMetric(raw, label, null);
  if (n === null) return null;
  const whole = Math.round(n);
  if (!Number.isSafeInteger(whole)) throw new Error(`${label} is out of range: ${raw.trim().slice(0, 40)}`);
  return whole;
}

const DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** A date as `YYYY-MM-DD`. Only ISO dates and datetimes are read: `10/01/2026` could be either month, so it is refused. */
export function parseLinkDate(raw: string, label: string, today: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const day = DATE.exec(text)?.[1];
  if (!day || !isIsoDay(day)) throw new Error(`${label} is not a date (use YYYY-MM-DD): ${text.slice(0, 40)}`);
  if (day < MIN_LINK_DATE || day > addDays(today, 1)) throw new Error(`${label} is outside ${MIN_LINK_DATE} to tomorrow: ${day}`);
  return day;
}

export function parseLinkType(raw: string): string | null {
  const tokens = raw.toLowerCase().split(/[\s,;|/+]+/).filter(Boolean);
  if (!tokens.length) return null;
  const found = new Set<LinkType>();
  for (const token of tokens) {
    const type = token === 'dofollow' || token === 'do-follow' ? 'follow' : token === 'no-follow' ? 'nofollow' : token;
    if (!(LINK_TYPES as readonly string[]).includes(type)) throw new Error(`Link type is not follow, nofollow, sponsored or ugc: ${token.slice(0, 40)}`);
    found.add(type as LinkType);
  }
  return LINK_TYPES.filter((t) => found.has(t)).join(',');
}

function resolveTarget(raw: string, siteUrl: string): string | null {
  const text = raw.trim();
  return text.startsWith('/') ? normalizePageUrl(new URL(text, siteUrl).href) : normalizePageUrl(text);
}

/** Turns one file row into a link, or says why it cannot be one. `key` is set when the source and target parse, so a full export can tell a bad row from an absent link. */
export function parseRow(cells: string[], ctx: RowContext): RowResult {
  const column = (field: BacklinkField): string => {
    const header = ctx.mapping[field];
    const at = header === undefined ? -1 : ctx.headers.indexOf(header);
    return at < 0 ? '' : (cells[at] ?? '');
  };
  let key: string | null = null;
  try {
    if (cells.length > ctx.headers.length) throw new Error('The row has more cells than the header');
    const sourceText = column('sourceUrl').trim();
    if (!sourceText) throw new Error('Source URL is missing');
    if (sourceText.length > MAX_PAGE_URL_LENGTH) throw new Error(`Source URL is longer than ${MAX_PAGE_URL_LENGTH} characters`);
    const sourceUrl = normalizePageUrl(sourceText);
    if (!sourceUrl) throw new Error(`Source URL is not a full http or https address: ${sourceText.slice(0, 60)}`);
    const targetText = column('targetUrl').trim();
    if (!targetText) throw new Error('Target URL missing');
    const targetUrl = resolveTarget(targetText, ctx.siteUrl);
    if (!targetUrl) throw new Error(`Target URL is not a valid address: ${targetText.slice(0, 60)}`);
    const anchor = clean(column('anchor'));
    key = linkKey(sourceUrl, targetUrl, anchor);
    if (anchor.length > MAX_ANCHOR_LENGTH) throw new Error(`Anchor text is longer than ${MAX_ANCHOR_LENGTH} characters`);
    const firstSeen = parseLinkDate(column('firstSeen'), 'First seen', ctx.today);
    const lastSeen = parseLinkDate(column('lastSeen'), 'Last seen', ctx.today);
    if (firstSeen && lastSeen && firstSeen > lastSeen) throw new Error('First seen is after last seen');
    return {
      ok: true,
      link: {
        key, sourceUrl, sourceHost: new URL(sourceUrl).hostname, targetUrl, anchor, linkType: parseLinkType(column('linkType')), firstSeen, lastSeen,
        sourceDr: parseMetric(column('sourceDr'), 'DR', 100), sourceUr: parseMetric(column('sourceUr'), 'UR', 100), sourceTraffic: parseTraffic(column('sourceTraffic'), 'Source traffic'),
        pageDr: parseMetric(column('pageDr'), 'Page DR', 100), pageUr: parseMetric(column('pageUr'), 'Page UR', 100), pageTraffic: parseTraffic(column('pageTraffic'), 'Page traffic'),
        otherHost: !isSiteHost(targetUrl, ctx.siteUrl),
        extras: extrasOf(cells, ctx),
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message, key };
  }
}

/** The columns no field uses, by header, trimmed, without empty values; at most the first 50 such columns. */
export function extraHeaders(headers: string[], mapping: Mapping): string[] {
  const mapped = new Set(Object.values(mapping));
  return headers.filter((h) => !mapped.has(h));
}

function extrasOf(cells: string[], ctx: RowContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of extraHeaders(ctx.headers, ctx.mapping).slice(0, MAX_EXTRA_COLUMNS)) {
    const value = (cells[ctx.headers.indexOf(header)] ?? '').trim();
    if (value) out[header] = value.slice(0, MAX_EXTRA_LENGTH);
  }
  return out;
}
