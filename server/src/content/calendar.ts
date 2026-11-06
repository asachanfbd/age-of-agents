import { dayBounds, dayText } from '../crm/zoned.ts';
import type { ContentCtx } from './context.ts';
import { ContentInputError } from './errors.ts';
import { getConcept } from './concepts.ts';
import type { PostView } from './concepts.ts';

/** A published post sits on its published day, any other post on its scheduled day. */
const PLACED = "CASE WHEN status = 'published' AND publishedAt IS NOT NULL THEN publishedAt ELSE scheduledAt END";
const placedAt = (p: PostView): string => (p.status === 'published' && p.publishedAt ? p.publishedAt : p.scheduledAt);

export interface CalendarPost extends PostView { conceptTitle: string }

/** `YYYY-MM` with a real month and a year from 0001; anything else is refused. */
export function parseMonth(value: unknown): { year: number; month: number } {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})$/.exec(value) : null;
  const year = m ? Number(m[1]) : 0, month = m ? Number(m[2]) : 0;
  if (!m || year < 1 || month < 1 || month > 12) throw new ContentInputError('month must be YYYY-MM', 'month');
  return { year, month };
}

/** `[start, end)` of a month as instants in the zone, so a post at 23:30 on the last local day is in and 00:00 the next month is out. */
export function monthBounds(year: number, month: number, timezone: string): { start: number; end: number } {
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return { start: dayBounds(dayText(year, month, 1), timezone).start, end: dayBounds(dayText(next.y, next.m, 1), timezone).start };
}

export function calendar(ctx: ContentCtx, query: Record<string, unknown>): { month: string; timezone: string; posts: CalendarPost[] } {
  const unknown = Object.keys(query).find((k) => k !== 'month');
  if (unknown) throw new ContentInputError(`Unknown parameter ${unknown}`, unknown);
  const { year, month } = parseMonth(query.month);
  const timezone = ctx.timezone();
  const { start, end } = monthBounds(year, month, timezone);
  const ids = ctx.db.prepare(`SELECT DISTINCT conceptId FROM posts WHERE ${PLACED} >= ? AND ${PLACED} < ?`).all(start, end) as Array<{ conceptId: string }>;
  const posts: CalendarPost[] = [];
  for (const { conceptId } of ids) {
    const concept = getConcept(ctx, conceptId);
    for (const p of concept.posts) {
      const at = Date.parse(placedAt(p));
      if (at >= start && at < end) posts.push({ ...p, conceptTitle: concept.title });
    }
  }
  posts.sort((a, b) => placedAt(a).localeCompare(placedAt(b)) || a.id.localeCompare(b.id));
  return { month: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`, timezone, posts };
}
