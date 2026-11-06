import type { Accent } from './accent';
import type { ChannelDto, ContactDto, PageDto, TimelineEntryDto } from './crmTypes';

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;
export const COMMENT_MAX = 5000;

export type StatusKind = 'dnc' | 'awaiting_approval' | 'pending_reachout' | 'no_response';
/** `resurfaceAt` is the instant a no-response contact comes back; the UI shows it in the Building time zone. */
export interface RowStatus { kind: StatusKind; label: string; resurfaceAt?: number }

/** The statuses a Prospects row shows, in precedence order: do-not-contact, awaiting approval, pending reachout, no response. */
export function rowStatuses(c: ContactDto): RowStatus[] {
  const out: RowStatus[] = [];
  if (c.dnc || c.channels.some((ch) => ch.dnc)) out.push({ kind: 'dnc', label: 'Do not contact' });
  if (c.awaitingApproval) out.push({ kind: 'awaiting_approval', label: 'Awaiting approval' });
  if (c.pendingReachout) out.push({ kind: 'pending_reachout', label: 'Pending reachout' });
  if (c.noResponse) out.push({ kind: 'no_response', label: 'No response', ...(c.resurfaceAt ? { resurfaceAt: c.resurfaceAt } : {}) });
  return out;
}
export const primaryStatus = (c: ContactDto): RowStatus | null => rowStatuses(c)[0] ?? null;

export const clampPageSize = (n: number): number => (Number.isInteger(n) && n > 0 ? Math.min(n, PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT);

export const EMPTY_PAGE_TEXT = 'No contacts match. Clear the search or the filters.';

/** "Rows 1-50 of 98,412", or the empty-page text. */
export function pagingLabel(page: Pick<PageDto<unknown>, 'rows' | 'total' | 'offset'>): string {
  if (page.total === 0 || page.rows.length === 0) return EMPTY_PAGE_TEXT;
  return `Rows ${(page.offset + 1).toLocaleString('en-US')}-${(page.offset + page.rows.length).toLocaleString('en-US')} of ${page.total.toLocaleString('en-US')}`;
}

export function pageNav(page: Pick<PageDto<unknown>, 'rows' | 'total' | 'offset' | 'limit'>): { canPrev: boolean; canNext: boolean; prevOffset: number; nextOffset: number } {
  const limit = clampPageSize(page.limit);
  return {
    canPrev: page.offset > 0, canNext: page.offset + page.rows.length < page.total,
    prevOffset: Math.max(0, page.offset - limit), nextOffset: page.offset + limit,
  };
}

export interface ListQuery { search: string; segment?: string; stage?: string; channel?: string; batch?: string; flag?: string; tag?: string; offset: number; limit: number }
export const initialQuery = (): ListQuery => ({ search: '', offset: 0, limit: PAGE_SIZE_DEFAULT });
/** Changing the search or any filter starts again at the first page; paging keeps the filters. */
export function withFilter(q: ListQuery, change: Partial<Omit<ListQuery, 'offset'>>): ListQuery { return { ...q, ...change, offset: 0 }; }
export const withOffset = (q: ListQuery, offset: number): ListQuery => ({ ...q, offset: Math.max(0, offset) });
export function queryParams(q: ListQuery): Record<string, string | number | undefined> {
  return { search: q.search.trim() || undefined, segment: q.segment, stage: q.stage, channel: q.channel, batch: q.batch, flag: q.flag, tag: q.tag, limit: clampPageSize(q.limit), offset: q.offset };
}

// ---- contact panel ---------------------------------------------------------

export type ChannelBadge = 'Valid' | 'Invalid' | 'Do not contact';
export function channelBadges(ch: ChannelDto): ChannelBadge[] {
  const out: ChannelBadge[] = [ch.invalid ? 'Invalid' : 'Valid'];
  if (ch.dnc) out.push('Do not contact');
  return out;
}

export const EMPTY_VALUE = '(empty)';
export function customFieldRows(contact: Pick<ContactDto, 'custom'>, defs: Array<{ id: string; name: string }>): Array<{ id: string; name: string; value: string; empty: boolean }> {
  return defs.map((d) => { const v = contact.custom[d.id] ?? ''; return { id: d.id, name: d.name, value: v === '' ? EMPTY_VALUE : v, empty: v === '' }; });
}

export function timelineNewestFirst(entries: TimelineEntryDto[]): TimelineEntryDto[] {
  return [...entries].sort((a, b) => b.at - a.at || b.id - a.id);
}

/** The due time of a reachout/followup "planned" entry, or null for any other entry. */
export function plannedDueAt(e: Pick<TimelineEntryDto, 'kind' | 'data'>): number | null {
  if (e.kind !== 'reachout_planned' && e.kind !== 'followup_planned') return null;
  const dueAt = e.data.dueAt;
  return typeof dueAt === 'number' && Number.isFinite(dueAt) ? dueAt : null;
}

export function commentCounter(text: string): { count: number; remaining: number; over: boolean; canSend: boolean } {
  const count = [...text].length;
  return { count, remaining: COMMENT_MAX - count, over: count > COMMENT_MAX, canSend: text.trim().length > 0 && count <= COMMENT_MAX };
}

export const SEGMENT_LABEL: Record<string, string> = { prospect: 'Prospect', customer: 'Customer', lost_prospect: 'Lost prospect', lost_customer: 'Lost customer' };

/** The card colour of a timeline entry: comments yellow, losses and failures orange, sends and replies green, merges and stage moves charcoal. */
export function timelineAccent(kind: string): Accent {
  if (kind === 'comment') return 'yellow';
  if (/lost|failed|dnc/.test(kind)) return 'orange';
  if (/sent|reply|response|customer/.test(kind)) return 'green';
  if (/merge|stage/.test(kind)) return 'charcoal';
  return 'neutral';
}

export interface DetailRow { key: string; label: string; value: string; empty: boolean }
/** The "Detailed Information" rows other than channels: company, title, source and tags, then each custom field. */
export function detailRows(c: Pick<ContactDto, 'company' | 'title' | 'source' | 'tags' | 'custom'>, defs: Array<{ id: string; name: string }>): DetailRow[] {
  const plain = (key: string, label: string, value: string | null | undefined): DetailRow => ({ key, label, value: value?.trim() ? value : EMPTY_VALUE, empty: !value?.trim() });
  return [
    plain('company', 'Company', c.company), plain('title', 'Title', c.title), plain('source', 'Source', c.source), plain('tags', 'Tags', c.tags.join(', ')),
    ...customFieldRows(c, defs).map((r) => ({ key: `custom-${r.id}`, label: r.name, value: r.value, empty: r.empty })),
  ];
}
