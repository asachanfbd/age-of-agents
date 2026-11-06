import type { CrmCtx } from './context.ts';
import { batchIdOf } from './imports.ts';
import { toCsv } from './csv.ts';
import { CrmInputError } from './errors.ts';
import { parsePeriod, previousWindow } from './reportPeriod.ts';
import type { Window } from './reportPeriod.ts';
import { localDay } from './zoned.ts';

export interface Metrics {
  prospectsAdded: number | null; reachoutsSent: number | null; followupsSent: number | null; onTime: number | null; delayed: number | null;
  maxDelayMinutes: number | null; lostProspects: number | null; lostCustomers: number | null; newCustomers: number | null;
}
export interface PeriodResult { label: string; startDay: string; endDay: string; metrics: Metrics }
export interface BreakdownRow { label: string; added: number | null; reachoutsSent: number | null; followupsSent: number | null }
export interface Report {
  period: PeriodResult; previous: PeriodResult; beforeFirstRecord: boolean; firstRecordDay: string | null; hasRecords: boolean;
  byChannel: BreakdownRow[]; bySource: BreakdownRow[];
}

const EVENT_KINDS = "('added','reachout_sent','followup_sent','followup_done','segment_moved')";

/** Counts are read from the timeline, so a contact that later changes segment does not change an earlier period. A metric with no recorded event is null. */
function metricsFor(ctx: CrmCtx, w: Window, batch: number | null): Metrics {
  const batchSql = batch === null ? '' : ' AND c.batchId = ?';
  const bp = batch === null ? [] : [batch];
  const groups = ctx.db.prepare(
    `SELECT t.kind AS kind, json_extract(t.data, '$.from') AS fromSeg, json_extract(t.data, '$.to') AS toSeg, COUNT(*) AS n
     FROM timeline t JOIN contacts c ON c.id = t.contactId WHERE t.at >= ? AND t.at < ? AND t.kind IN ${EVENT_KINDS}${batchSql} GROUP BY 1, 2, 3`,
  ).all(w.start, w.end, ...bp) as Array<{ kind: string; fromSeg: string | null; toSeg: string | null; n: number }>;
  const sum = (f: (g: (typeof groups)[number]) => boolean): number | null => { const m = groups.filter(f); return m.length ? m.reduce((a, g) => a + g.n, 0) : null; };
  const limit = ctx.settings().onTimeMinutes * 60_000;
  const timing = ctx.db.prepare(
    `SELECT COUNT(*) AS n, SUM(json_extract(t.data, '$.delayMs') <= ?) AS onTime, MAX(json_extract(t.data, '$.delayMs')) AS maxDelay
     FROM timeline t JOIN contacts c ON c.id = t.contactId WHERE t.at >= ? AND t.at < ? AND t.kind IN ('followup_sent','followup_done')${batchSql}`,
  ).get(limit, w.start, w.end, ...bp) as { n: number; onTime: number | null; maxDelay: number | null };
  return {
    prospectsAdded: sum((g) => g.kind === 'added'), reachoutsSent: sum((g) => g.kind === 'reachout_sent'), followupsSent: sum((g) => g.kind === 'followup_sent'),
    onTime: timing.n ? timing.onTime ?? 0 : null, delayed: timing.n ? timing.n - (timing.onTime ?? 0) : null,
    maxDelayMinutes: timing.n && timing.maxDelay !== null && timing.maxDelay > limit ? Math.round(timing.maxDelay / 60_000) : null,
    lostProspects: sum((g) => g.kind === 'segment_moved' && g.toSeg === 'lost_prospect'), lostCustomers: sum((g) => g.kind === 'segment_moved' && g.toSeg === 'lost_customer'),
    newCustomers: sum((g) => g.kind === 'segment_moved' && g.toSeg === 'customer' && g.fromSeg === 'prospect'),
  };
}

function breakdown(ctx: CrmCtx, w: Window, batch: number | null, by: 'channel' | 'source'): BreakdownRow[] {
  const bp = batch === null ? [] : [batch];
  const batchSql = batch === null ? '' : ' AND c.batchId = ?';
  const label = by === 'channel' ? "COALESCE(json_extract(t.data, '$.channelType'), 'unknown')" : 'COALESCE(b.name, c.source)';
  const rows = ctx.db.prepare(
    `SELECT ${label} AS label, SUM(t.kind = 'added') AS added, SUM(t.kind = 'reachout_sent') AS reach, SUM(t.kind = 'followup_sent') AS fu
     FROM timeline t JOIN contacts c ON c.id = t.contactId LEFT JOIN batches b ON b.id = c.batchId
     WHERE t.at >= ? AND t.at < ? AND t.kind IN ('added','reachout_sent','followup_sent')${batchSql}${by === 'channel' ? " AND t.kind <> 'added'" : ''} GROUP BY 1 ORDER BY 1`,
  ).all(w.start, w.end, ...bp) as Array<{ label: string; added: number; reach: number; fu: number }>;
  const none = (n: number) => (n > 0 ? n : null);
  return rows.map((r) => ({ label: r.label, added: by === 'source' ? none(r.added) : null, reachoutsSent: none(r.reach), followupsSent: none(r.fu) }));
}

export function buildReport(ctx: CrmCtx, q: Record<string, unknown>): Report {
  const tz = ctx.settings().timezone;
  const today = localDay(ctx.now(), tz);
  const w = parsePeriod(q.period ?? 'week', q.date, today, tz);
  const batch = batchIdOf(ctx, q.batch);
  const prev = previousWindow(w, tz);
  const first = ctx.db.prepare("SELECT MIN(at) AS at FROM timeline WHERE kind IN ('added','reachout_sent','followup_sent','followup_done','segment_moved')").get() as { at: number | null };
  const firstRecordDay = first.at === null ? null : localDay(first.at, tz);
  const result = (win: Window): PeriodResult => ({ label: win.label, startDay: win.startDay, endDay: win.endDay, metrics: metricsFor(ctx, win, batch) });
  return {
    period: result(w), previous: result(prev), hasRecords: first.at !== null, firstRecordDay,
    beforeFirstRecord: first.at !== null && w.end <= first.at,
    byChannel: breakdown(ctx, w, batch, 'channel'), bySource: breakdown(ctx, w, batch, 'source'),
  };
}

export const REPORT_TABLES = ['summary', 'by-channel', 'by-source'] as const;
export type ReportTable = (typeof REPORT_TABLES)[number];

const NO_DATA = 'no data';
const cell = (v: number | null) => (v === null ? NO_DATA : v);

export function reportCsv(ctx: CrmCtx, q: Record<string, unknown>): { name: string; csv: string } {
  const table = q.table;
  if (!REPORT_TABLES.includes(table as ReportTable)) throw new CrmInputError(`table must be one of ${REPORT_TABLES.join(', ')}`, 'table');
  const r = buildReport(ctx, q);
  const name = `crm-${table as string}-${r.period.label}.csv`;
  if (table === 'summary') {
    const keys: Array<[keyof Metrics, string]> = [['prospectsAdded', 'Prospects added'], ['reachoutsSent', 'Reachouts sent'], ['followupsSent', 'Followups sent'], ['onTime', 'Followups on time'], ['delayed', 'Followups delayed'], ['maxDelayMinutes', 'Longest delay (minutes)'], ['lostProspects', 'Lost prospects'], ['lostCustomers', 'Lost customers'], ['newCustomers', 'New customers']];
    return { name, csv: toCsv(['Metric', r.period.label, r.previous.label], keys.map(([k, label]) => [label, cell(r.period.metrics[k]), cell(r.previous.metrics[k])])) };
  }
  const rows = table === 'by-channel' ? r.byChannel : r.bySource;
  return { name, csv: toCsv([table === 'by-channel' ? 'Channel' : 'Source', 'Prospects added', 'Reachouts sent', 'Followups sent'], rows.map((b) => [b.label, cell(b.added), cell(b.reachoutsSent), cell(b.followupsSent)])) };
}
