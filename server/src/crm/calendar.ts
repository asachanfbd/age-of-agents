import type { FollowupRow } from './chains.ts';
import type { CrmCtx } from './context.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import { followupView } from './followups.ts';
import type { FollowupView } from './followups.ts';
import { SENT_NO_RESPONSE_DAYS } from './limits.ts';
import { buildSessions, SESSION_MINUTES } from './sessions.ts';
import { MESSAGE_TYPES } from './settings.ts';
import type { DailySlot, FollowupType } from './settings.ts';
import { addDays, dayBounds, freeIntervals, isIsoDay, localDay, parseClock, weekday, zonedMs } from './zoned.ts';
import type { Interval } from './zoned.ts';

const OPEN = "('planned','pending','approved','failed')";
const DAY_ITEMS_MAX = 5_000;
const SESSIONS_MAX = 60;
const MIN = 60_000;
const FIXED_TYPES: readonly FollowupType[] = ['online_meeting', 'in_person_meeting', 'appointment'];

export interface CalendarItem extends FollowupView { overdue: boolean }
export interface SessionView { key: string; kind: 'messages' | 'calls'; minutes: number; count: number; start: number | null; end: number | null; state: 'suggested' | 'accepted' | 'unplaced'; items: CalendarItem[] }
export interface SlotView { id: string; name: string; minutes: number; start: number | null; end: number | null; state: 'placed' | 'skipped' | 'no_room'; conflict: boolean; fixedStart: boolean }
export interface FixedView { item: CalendarItem; start: number; end: number }
export interface DayView {
  day: string; label: string; window: Interval | null; overdue: CalendarItem[]; fixed: FixedView[]; sessions: SessionView[]; slots: SlotView[];
  freeMinutes: number; truncated: boolean; moreSessions: number;
}

export function parseFrom(ctx: CrmCtx, q: Record<string, unknown>): string {
  if (q.view !== undefined || q.week !== undefined || q.month !== undefined) throw new CrmInputError('The calendar pages by day only', 'view');
  const today = localDay(ctx.now(), ctx.settings().timezone);
  if (q.from === undefined || q.from === '') return today;
  if (!isIsoDay(q.from)) throw new CrmInputError('from must be a date like 2026-03-14', 'from');
  return q.from;
}

const labelFor = (today: string, day: string) => (day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : day === addDays(today, 2) ? 'Day after' : day === addDays(today, -1) ? 'Yesterday' : day);

function loadItems(ctx: CrmCtx, startMs: number, endMs: number, includeOverdue: boolean, openOnly: boolean): { rows: FollowupRow[]; truncated: boolean } {
  const lower = includeOverdue ? '' : ' AND dueAt >= ?';
  const state = openOnly ? ` AND state IN ${OPEN}` : " AND state <> 'cancelled'";
  const rows = ctx.db.prepare(`SELECT * FROM followups WHERE dueAt < ?${lower}${state} AND catchUp = 0 ORDER BY dueAt, id LIMIT ?`)
    .all(...(includeOverdue ? [endMs, DAY_ITEMS_MAX + 1] : [endMs, startMs, DAY_ITEMS_MAX + 1])) as FollowupRow[];
  return { rows: rows.slice(0, DAY_ITEMS_MAX), truncated: rows.length > DAY_ITEMS_MAX };
}

function slotsFor(ctx: CrmCtx, day: string): Array<DailySlot & { skipped: boolean }> {
  const overrides = new Map((ctx.db.prepare('SELECT * FROM slot_days WHERE day = ?').all(day) as Array<{ slotId: string; start: string | null; minutes: number | null; skipped: number }>).map((o) => [o.slotId, o]));
  return ctx.settings().dailySlots.map((s) => {
    const o = overrides.get(s.id);
    return { ...s, start: o?.start ?? s.start, minutes: o?.minutes ?? s.minutes, skipped: o?.skipped === 1 };
  });
}

/** Takes up to `minutes` from the first free intervals; returns what was placed. */
function take(free: Interval[], minutes: number, from?: number): { placed: Interval | null; free: Interval[] } {
  const need = minutes * MIN;
  for (let i = 0; i < free.length; i++) {
    const f = free[i]!;
    const start = Math.max(f.start, from ?? f.start);
    if (f.end - start < need) continue;
    const placed = { start, end: start + need };
    const rest = [...free.slice(0, i), ...(start > f.start ? [{ start: f.start, end: start }] : []), ...(placed.end < f.end ? [{ start: placed.end, end: f.end }] : []), ...free.slice(i + 1)];
    return { placed, free: rest };
  }
  return { placed: null, free };
}

export function buildDay(ctx: CrmCtx, day: string, today: string): DayView {
  const s = ctx.settings();
  const tz = s.timezone;
  const bounds = dayBounds(day, tz);
  const isToday = day === today;
  const { rows, truncated } = loadItems(ctx, bounds.start, bounds.end, isToday, day >= today);
  /** Overdue means the owner can act on it now: a failed item waiting for its retry is not overdue. */
  const mark = (r: FollowupRow): CalendarItem => ({ ...followupView(ctx, r), overdue: r.dueAt < dayBounds(today, tz).start && ['planned', 'pending', 'approved'].includes(r.state) });
  const items = rows.map(mark);
  const overdue = isToday ? items.filter((i) => i.overdue) : [];
  const dayItems = items.filter((i) => !overdue.includes(i));
  const dur = (i: CalendarItem) => i.durationMin * MIN;

  const fixed: FixedView[] = dayItems.filter((i) => FIXED_TYPES.includes(i.type)).map((i) => ({ item: i, start: i.dueAt, end: i.dueAt + dur(i) }));
  const wh = s.workingHours[weekday(day)]!;
  const window: Interval | null = wh.open ? { start: zonedMs(day, parseClock(wh.start)!, tz), end: zonedMs(day, parseClock(wh.end)!, tz) } : null;
  const busy: Interval[] = fixed.map((f) => ({ start: f.start, end: f.end }));

  const slots: SlotView[] = [];
  const slotDefs = slotsFor(ctx, day);
  for (const d of slotDefs) if (!d.skipped && d.start) {
    const start = zonedMs(day, parseClock(d.start)!, tz);
    const end = start + d.minutes * MIN;
    const conflict = busy.some((b) => b.start < end && start < b.end);
    slots.push({ id: d.id, name: d.name, minutes: d.minutes, start, end, state: 'placed', conflict, fixedStart: true });
  }
  for (const sl of slots) busy.push({ start: sl.start!, end: sl.end! });
  let free = window ? freeIntervals(window, busy) : [];
  for (const d of slotDefs) {
    if (d.skipped) { slots.push({ id: d.id, name: d.name, minutes: d.minutes, start: null, end: null, state: 'skipped', conflict: false, fixedStart: d.start !== null }); continue; }
    if (d.start) continue;
    const t = take(free, d.minutes);
    if (!t.placed) { slots.push({ id: d.id, name: d.name, minutes: d.minutes, start: null, end: null, state: 'no_room', conflict: false, fixedStart: false }); continue; }
    free = t.free;
    slots.push({ id: d.id, name: d.name, minutes: d.minutes, start: t.placed.start, end: t.placed.end, state: 'placed', conflict: false, fixedStart: false });
  }

  const decisions = new Map((ctx.db.prepare('SELECT key, state, start FROM block_days WHERE day = ?').all(day) as Array<{ key: string; state: string; start: string | null }>).map((d) => [d.key, d]));
  const sessionItems = [...overdue, ...dayItems].filter((i) => (MESSAGE_TYPES.includes(i.type) || i.type === 'call') && ['planned', 'pending', 'approved', 'failed'].includes(i.state));
  const built = buildSessions(sessionItems.map((i) => ({ id: i.id, type: i.type, dueAt: i.dueAt })), s);
  const byId = new Map(sessionItems.map((i) => [i.id, i]));
  const sessions: SessionView[] = [];
  const counters = { messages: 0, calls: 0 };
  let moreSessions = 0;
  for (const b of built) {
    const key = `${b.kind}:${counters[b.kind]++}`;
    const dec = decisions.get(key);
    if (dec?.state === 'skipped') continue;
    if (sessions.length >= SESSIONS_MAX) { moreSessions++; continue; }
    let start: number | null = null, end: number | null = null;
    let state: SessionView['state'] = 'unplaced';
    if (dec?.state === 'accepted' && dec.start) {
      start = zonedMs(day, parseClock(dec.start)!, tz); end = start + SESSION_MINUTES * MIN; state = 'accepted';
      free = freeIntervals({ start: window?.start ?? start, end: window?.end ?? end }, [...busy, { start, end }]).filter((f) => f.end > f.start);
      busy.push({ start, end });
    } else if (isToday || day > today) {
      const t = take(free, SESSION_MINUTES, isToday ? Math.max(ctx.now(), window?.start ?? 0) : undefined);
      if (t.placed) { free = t.free; start = t.placed.start; end = t.placed.end; state = 'suggested'; }
    }
    sessions.push({ key, kind: b.kind, minutes: b.minutes, count: b.items.length, start, end, state, items: b.items.map((i) => byId.get(i.id)!) });
  }
  const freeMinutes = Math.round(free.reduce((m, f) => m + (f.end - f.start), 0) / MIN);
  return { day, label: labelFor(today, day), window, overdue, fixed, sessions, slots, freeMinutes, truncated, moreSessions };
}

export function calendar(ctx: CrmCtx, q: Record<string, unknown>) {
  const tz = ctx.settings().timezone;
  const today = localDay(ctx.now(), tz);
  const from = parseFrom(ctx, q);
  return { timezone: tz, today, from, days: [0, 1, 2].map((n) => buildDay(ctx, addDays(from, n), today)) };
}

// ---- suggested blocks and daily slots -------------------------------------

export function decideBlock(ctx: CrmCtx, day: unknown, key: unknown, body: unknown): { ok: true } {
  if (!isIsoDay(day)) throw new CrmInputError('day must be a date like 2026-03-14', 'day');
  const b = (body ?? {}) as { action?: unknown; start?: unknown };
  if (typeof key !== 'string' || !/^(messages|calls):\d+$/.test(key)) throw new CrmNotFoundError('That block does not exist');
  const view = buildDay(ctx, day, localDay(ctx.now(), ctx.settings().timezone));
  const block = view.sessions.find((s) => s.key === key);
  if (!block) throw new CrmNotFoundError('That block does not exist');
  const save = (state: string, start: string | null) => ctx.db.prepare('INSERT INTO block_days (day, key, state, start) VALUES (?, ?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET state = excluded.state, start = excluded.start').run(day, key, state, start);
  if (b.action === 'skip') { save('skipped', null); return { ok: true }; }
  if (b.action === 'accept' && b.start === undefined) {
    if (block.start === null) throw new CrmConflictError('There is no free time for this block. Move it to a gap.');
    save('accepted', clockOf(ctx, day, block.start)); return { ok: true };
  }
  if (b.action !== 'accept' && b.action !== 'move') throw new CrmInputError('action must be accept, move or skip', 'action');
  const m = parseClock(b.start);
  if (m === null) throw new CrmInputError('start must be HH:MM', 'start');
  const tz = ctx.settings().timezone;
  const start = zonedMs(day, m, tz), end = start + SESSION_MINUTES * MIN;
  if (view.window && (start < view.window.start || end > view.window.end)) throw new CrmConflictError('That time is outside working hours');
  if (!view.window) throw new CrmConflictError('That day is not a working day');
  const others = [...view.fixed.map((f) => ({ start: f.start, end: f.end })), ...view.slots.filter((s) => s.start !== null).map((s) => ({ start: s.start!, end: s.end! })), ...view.sessions.filter((s) => s.state === 'accepted' && s.key !== key).map((s) => ({ start: s.start!, end: s.end! }))];
  if (others.some((o) => o.start < end && start < o.end)) throw new CrmConflictError('That time is taken by another item');
  save('accepted', b.start as string);
  return { ok: true };
}

function clockOf(ctx: CrmCtx, day: string, ms: number): string {
  const minutes = Math.round((ms - zonedMs(day, 0, ctx.settings().timezone)) / MIN);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Resizes, moves or skips a daily slot for one day; the default in Settings is untouched. */
export function overrideSlot(ctx: CrmCtx, day: unknown, slotId: string, body: unknown): { ok: true } {
  if (!isIsoDay(day)) throw new CrmInputError('day must be a date like 2026-03-14', 'day');
  const slot = ctx.settings().dailySlots.find((s) => s.id === slotId);
  if (!slot) throw new CrmNotFoundError('That slot does not exist');
  const b = (body ?? {}) as { start?: unknown; minutes?: unknown; skipped?: unknown };
  let start: string | null = null, minutes: number | null = null, skipped = 0;
  if (b.start !== undefined) { if (b.start !== null && parseClock(b.start) === null) throw new CrmInputError('start must be HH:MM', 'start'); start = b.start as string | null; }
  if (b.minutes !== undefined) {
    if (typeof b.minutes !== 'number' || !Number.isSafeInteger(b.minutes) || b.minutes < 1 || b.minutes > 1440) throw new CrmInputError('minutes must be a whole number from 1 to 1440', 'minutes');
    minutes = b.minutes;
  }
  if (b.skipped !== undefined) { if (typeof b.skipped !== 'boolean') throw new CrmInputError('skipped must be true or false', 'skipped'); skipped = b.skipped ? 1 : 0; }
  ctx.db.prepare('INSERT INTO slot_days (day, slotId, start, minutes, skipped) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, slotId) DO UPDATE SET start = excluded.start, minutes = excluded.minutes, skipped = excluded.skipped').run(day, slotId, start, minutes, skipped);
  return { ok: true };
}

// ---- Expand Today ---------------------------------------------------------

export interface ExpandGroup { id: 'sent_no_response' | 'overdue' | 'awaiting_approval' | 'failed_retry' | 'agenda'; title: string; emptyText: string; cards: unknown[] }

export function expandToday(ctx: CrmCtx) {
  const s = ctx.settings();
  const now = ctx.now();
  const today = localDay(now, s.timezone);
  const dayStart = dayBounds(today, s.timezone).start;
  const seen = new Set<number>();
  const take1 = (rows: FollowupRow[], extra?: (r: FollowupRow) => Record<string, unknown>) => rows.filter((r) => !seen.has(r.id)).map((r) => { seen.add(r.id); return { ...followupView(ctx, r), ...(extra?.(r) ?? {}) }; });
  const q = (sql: string, ...p: unknown[]) => ctx.db.prepare(sql).all(...p as never[]) as FollowupRow[];

  const firstCheckMs = s.cadence.gapDays[0] * 86_400_000;
  const sent = q(`SELECT f.* FROM followups f JOIN contacts c ON c.id = f.contactId WHERE f.state = 'sent' AND f.doneAt IS NULL AND f.kind IN ('reachout','followup') AND c.segment = 'prospect'
      AND f.sentAt <= ? AND f.sentAt >= ? AND (f.checkedAt IS NULL OR f.checkedAt < ?) ORDER BY f.sentAt, f.id LIMIT 500`, now - firstCheckMs, now - SENT_NO_RESPONSE_DAYS * 86_400_000, dayStart);
  const overdue = q(`SELECT * FROM followups WHERE state IN ('planned','pending','approved') AND dueAt < ? ORDER BY dueAt, id LIMIT 500`, dayStart);
  const approval = q(`SELECT f.* FROM followups f JOIN channels ch ON ch.id = f.channelId WHERE f.state = 'pending' AND ch.type = 'email' ORDER BY f.dueAt, f.id LIMIT 500`);
  const failed = q(`SELECT * FROM followups WHERE state = 'failed' AND (catchUp = 1 OR (retryAt IS NOT NULL AND retryAt <= ?)) ORDER BY updatedAt, id LIMIT 500`, now);
  const day = buildDay(ctx, today, today);

  const groups: ExpandGroup[] = [
    { id: 'sent_no_response', title: 'Sent, no response logged', emptyText: 'Nothing is waiting for a response.', cards: take1(sent) },
    { id: 'overdue', title: 'Overdue followups', emptyText: 'No followups are overdue.', cards: take1(overdue) },
    { id: 'awaiting_approval', title: 'Awaiting approval', emptyText: 'No messages are waiting for approval.', cards: take1(approval) },
    { id: 'failed_retry', title: 'Failed, retry due', emptyText: 'No failed items need a retry.', cards: take1(failed) },
    { id: 'agenda', title: "Today's agenda", emptyText: 'Nothing is planned for today.', cards: agendaCards(day) },
  ];
  return { today, groups, total: groups.reduce((n, g) => n + g.cards.length, 0) };
}

function agendaCards(day: DayView): unknown[] {
  const entries: Array<{ at: number; card: unknown }> = [
    ...day.fixed.map((f) => ({ at: f.start, card: { card: 'fixed', ...f } })),
    ...day.slots.filter((s) => s.start !== null).map((s) => ({ at: s.start!, card: { card: 'slot', ...s } })),
    ...day.sessions.map((s) => ({ at: s.start ?? Number.MAX_SAFE_INTEGER, card: { card: 'session', ...s, items: undefined, itemIds: s.items.map((i) => i.id) } })),
  ].sort((a, b) => a.at - b.at);
  return entries.length ? [{ card: 'agenda', freeMinutes: day.freeMinutes, entries: entries.map((e) => e.card) }] : [];
}
