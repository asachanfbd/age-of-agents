import { pacificToday } from './dates.ts';

/** Google's daily URL Inspection limit per property. */
export const DAILY_INSPECTION_QUOTA = 2000;
/** The slice kept for manual requests: the background pass stops at `DAILY_INSPECTION_QUOTA - MANUAL_RESERVE`. */
export const MANUAL_RESERVE = 200;
export const BACKGROUND_LIMIT = DAILY_INSPECTION_QUOTA - MANUAL_RESERVE;
/** A page is inspected again by the background pass once its last inspection is this old. */
export const REINSPECT_AFTER_DAYS = 7;

export type InspectionKind = 'manual' | 'background';

/** The quota day: Google resets the count at midnight Pacific time. */
export const quotaDay = (now: Date): string => pacificToday(now);

/** When the quota day after the one `now` falls in begins (Pacific midnight, DST-aware; offsets are whole hours so it is a whole UTC hour). */
export function nextQuotaReset(now: Date): Date {
  const today = quotaDay(now);
  const cursor = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  while (quotaDay(cursor) === today) cursor.setTime(cursor.getTime() + 3_600_000);
  return cursor;
}

/** How many of `wanted` inspections may be made now given what is already used. Background stops at the reserve line; manual may use everything. */
export function grantable(used: number, wanted: number, kind: InspectionKind): number {
  const limit = kind === 'manual' ? DAILY_INSPECTION_QUOTA : BACKGROUND_LIMIT;
  return Math.max(0, Math.min(wanted, limit - used));
}

export interface Inspectable { url: string; pending: boolean; inspectedAt: string | null; lastmod: string | null; firstSeen: string }

/**
 * The order the background pass works in: URLs the person asked for and are still waiting, then never-inspected URLs, then
 * URLs whose sitemap `lastmod` is newer than their last inspection, then the oldest inspections (only those older than
 * `REINSPECT_AFTER_DAYS`). Ties break by URL so the order is stable.
 */
export function inspectionOrder(candidates: Inspectable[], now: Date): Inspectable[] {
  const staleBefore = now.getTime() - REINSPECT_AFTER_DAYS * 86_400_000;
  const rank = (c: Inspectable): number | null => {
    if (c.pending) return 0;
    if (!c.inspectedAt) return 1;
    if (c.lastmod && Date.parse(c.lastmod) > Date.parse(c.inspectedAt)) return 2;
    return Date.parse(c.inspectedAt) < staleBefore ? 3 : null;
  };
  return candidates
    .map((c) => ({ c, r: rank(c) }))
    .filter((x): x is { c: Inspectable; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || (a.r === 3 ? Date.parse(a.c.inspectedAt!) - Date.parse(b.c.inspectedAt!) : 0) || (a.c.url < b.c.url ? -1 : a.c.url > b.c.url ? 1 : 0))
    .map((x) => x.c);
}

export type IndexingState = 'indexed' | 'not-indexed' | 'unknown';
export interface IndexingResult { state: IndexingState; reason: string; raw: string }

/** Maps Google's index status to the three states shown. An answer that is not recognised stays "unknown" and keeps Google's wording. */
export function mapIndexStatus(status: { verdict?: string; coverageState?: string } | undefined): IndexingResult {
  const raw = status?.coverageState ?? '';
  if (status?.verdict === 'PASS') return { state: 'indexed', reason: '', raw };
  if (status?.verdict === 'FAIL' || status?.verdict === 'NEUTRAL') return { state: 'not-indexed', reason: raw || 'Not indexed (Google gave no reason)', raw };
  return { state: 'unknown', reason: '', raw };
}
