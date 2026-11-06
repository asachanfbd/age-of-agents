import type { Accent } from './accent';
import type { CalendarItemDto, SessionDto, SlotDto } from './crmTypes';

export const COLUMN_HEADINGS = ['Today', 'Tomorrow', 'Day after'] as const;

/** Today, Tomorrow and Day after name the first three days from today; any other day is shown by its date. */
export function headingFor(day: string, today: string): string {
  const offset = [0, 1, 2].find((n) => pageDay(today, n) === day);
  return offset === undefined ? day : COLUMN_HEADINGS[offset]!;
}

/** Day paging only: one day back or forward, across month and year ends. There is no week or month view. */
export function pageDay(from: string, delta: number): string {
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  dt.setUTCFullYear(dt.getUTCFullYear());
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function sessionLabel(s: Pick<SessionDto, 'kind' | 'count' | 'minutes'>): string {
  const noun = s.kind === 'calls' ? (s.count === 1 ? 'call' : 'calls') : (s.count === 1 ? 'message' : 'messages');
  return `${s.count} ${noun} · ${s.minutes} min`;
}

/** Which sessions are expanded; the count of items never changes by expanding. */
export function toggleExpanded(open: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(open);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

export const OVERDUE_BADGE = 'Overdue';
export const DELAYED_CAP_LABEL = 'delayed by daily cap';
export function itemBadges(item: Pick<CalendarItemDto, 'overdue' | 'delayReason' | 'state' | 'catchUp'>): string[] {
  const out: string[] = [];
  if (item.overdue) out.push(OVERDUE_BADGE);
  if (item.delayReason) out.push(item.delayReason);
  if (item.state === 'failed') out.push(item.catchUp ? 'Used all tries' : 'Retry due later');
  return out;
}

export const blockStateLabel = (s: Pick<SessionDto, 'state'>): string => (s.state === 'accepted' ? 'Booked' : s.state === 'suggested' ? 'Suggested' : 'No free time');
export const slotStateLabel = (s: Pick<SlotDto, 'state' | 'conflict'>): string => (s.state === 'skipped' ? 'Skipped today' : s.state === 'no_room' ? 'No room' : s.conflict ? 'Conflicts with a meeting' : 'Placed');

/** Block and slot actions (accept, move, skip, resize) are disabled in a read-only Building. */
export const blockActionsEnabled = (readOnly: boolean, s: Pick<SessionDto, 'state'>): { accept: boolean; move: boolean; skip: boolean } =>
  ({ accept: !readOnly && s.state === 'suggested', move: !readOnly, skip: !readOnly });
export const slotActionsEnabled = (readOnly: boolean): boolean => !readOnly;

// ---- slot geometry (drag, resize) ---------------------------------------------

export const SNAP_MINUTES = 5;
export const MIN_DURATION_MINUTES = 5;
export const minutesToPx = (minutes: number, pxPerMinute: number): number => minutes * pxPerMinute;
export const pxToMinutes = (px: number, pxPerMinute: number): number => px / pxPerMinute;
export const snap = (minutes: number): number => Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;

export interface Span { start: number; end: number }
/** Moves a span by a pixel delta: snapped to 5 minutes and kept inside the working hours. */
export function moveSpan(span: Span, deltaPx: number, pxPerMinute: number, hours: Span): Span {
  const length = span.end - span.start;
  const start = Math.min(Math.max(snap(span.start + pxToMinutes(deltaPx, pxPerMinute)), hours.start), hours.end - length);
  return { start, end: start + length };
}
/** Resizes the end of a span by a pixel delta: snapped, never below the minimum duration, never past the working hours. */
export function resizeSpan(span: Span, deltaPx: number, pxPerMinute: number, hours: Span): Span {
  const end = Math.min(Math.max(snap(span.end + pxToMinutes(deltaPx, pxPerMinute)), span.start + MIN_DURATION_MINUTES), hours.end);
  return { start: span.start, end };
}
export const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const MEETING_TYPES = new Set(['online_meeting', 'in_person_meeting', 'appointment']);
/** The colour of a calendar item's card: overdue and failed in orange, waiting for you in yellow, meetings green, calls charcoal, the rest neutral. */
export function itemAccent(item: Pick<CalendarItemDto, 'overdue' | 'state' | 'type'>): Accent {
  if (item.overdue || item.state === 'failed') return 'orange';
  if (item.state === 'pending') return 'yellow';
  if (MEETING_TYPES.has(item.type)) return 'green';
  return item.type === 'call' ? 'charcoal' : 'neutral';
}

/** Item types that carry a message to send; mirrors MESSAGE_TYPES in server/src/crm/settings.ts. Every other type is a call, meeting or task. */
const MESSAGE_TYPES: ReadonlySet<string> = new Set(['message', 'email', 'dm']);
export const isMessageType = (type: string): boolean => MESSAGE_TYPES.has(type);

const OPEN_STATES: ReadonlySet<string> = new Set(['planned', 'pending', 'approved']);
/** Whether "Mark done" applies: a non-message item the server's complete accepts (planned, pending or approved). */
export const canMarkDone = (item: { type: string; state: string }): boolean => !isMessageType(item.type) && OPEN_STATES.has(item.state);
