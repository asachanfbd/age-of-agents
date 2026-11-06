import { randomUUID } from 'node:crypto';
import { getStore, guardedWrite } from '../buildings/buildingStorage.ts';
import { assertWritable } from '../buildings/normalize.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import { projectsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { raiseNotification } from '../notifications/notificationService.ts';
import { pacificToday } from './dates.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoNotFoundError, SeoUpstreamError } from './errors.ts';
import { buildReport, keyNumbers } from './reportBuild.ts';
import type { ReportData } from './reportBuild.ts';
import { gatherInputs, liveReport, parseReportQuery } from './reportData.ts';
import type { ReportQuery } from './reportData.ts';
import { exportFileName, periodLabel, reportCsv, reportHtml, reportMarkdown, requireCsvTable } from './reportExport.ts';
import { defaultReportName, lastFullMonth, lastFullWeek, reportName } from './reportPeriod.ts';
import { readSentSummary, parseSummary, summaryInput, summaryOf } from './reportSummary.ts';
import { oneOf } from './pages.ts';

export type ReportSource = 'manual' | 'scheduled';
export type Cadence = 'weekly' | 'monthly';

export interface SavedMeta { id: string; name: string; source: ReportSource; savedAt: string; periodKey: string; from: string; to: string; hasSummary: boolean }
export interface SavedReport extends SavedMeta { report: ReportData }

const locks = new Map<string, Promise<unknown>>();

/** One change to a Building's saved reports at a time, so two saves never interleave. */
export function withReportLock<T>(buildingId: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(buildingId) ?? Promise.resolve()).then(work, work);
  locks.set(buildingId, next.catch(() => undefined));
  return next;
}

const summaries = new Set<string>();

/** Forgets a deleted Building's in-memory report state. */
export function forgetReports(buildingId: string): void {
  locks.delete(buildingId);
  summaries.delete(buildingId);
}

const META_COLUMNS = ['uid', 'name', 'source', 'savedAt', 'periodKey', 'rangeFrom', 'rangeTo', 'hasSummary'];

const metaOf = (r: Record<string, string | number>): SavedMeta => ({
  id: String(r.uid), name: String(r.name), source: String(r.source) as ReportSource, savedAt: String(r.savedAt), periodKey: String(r.periodKey),
  from: String(r.rangeFrom), to: String(r.rangeTo), hasSummary: r.hasSummary === 1,
});

/** Saved reports, newest first. Only the summary columns are read; each report's document stays on disk until it is opened. */
export async function listReports(project: ProjectRecord): Promise<SavedMeta[]> {
  const store = await getStore(project);
  const { rows } = await store.groupSums({ source: 'seo_reports', groupBy: META_COLUMNS });
  return rows.map(metaOf).sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.id < b.id ? 1 : -1));
}

async function readSaved(store: BulkStore, id: string): Promise<SavedReport | null> {
  const { rows } = await store.groupSums({ source: 'seo_reports', groupBy: [...META_COLUMNS, 'data'], where: { uid: id }, limit: 1 });
  const row = rows[0];
  return row ? { ...metaOf(row), report: JSON.parse(String(row.data)) as ReportData } : null;
}

export async function getReport(project: ProjectRecord, id: string): Promise<SavedReport> {
  const saved = await readSaved(await getStore(project), id);
  if (!saved) throw new SeoNotFoundError('There is no such saved report');
  return saved;
}

export async function latestReport(project: ProjectRecord): Promise<SavedReport | null> {
  const [newest] = await listReports(project);
  return newest ? getReport(project, newest.id) : null;
}

export async function deleteReport(project: ProjectRecord, id: string): Promise<void> {
  assertWritable(project);
  await withReportLock(project.id, async () => {
    await getReport(project, id);
    await guardedWrite(project, (store) => store.replaceRows([{ table: 'seo_reports', where: { uid: id }, rows: [] }]));
  });
}

async function persist(project: ProjectRecord, name: string, source: ReportSource, report: ReportData, periodKey: string): Promise<SavedMeta> {
  const meta: SavedMeta = { id: randomUUID(), name, source, savedAt: seoDeps().now().toISOString(), periodKey, from: report.period.current?.from ?? '', to: report.period.current?.to ?? '', hasSummary: report.summary !== null };
  await guardedWrite(project, (store) => store.replaceRows([{
    table: 'seo_reports', where: { uid: meta.id },
    rows: [[meta.id, meta.name, meta.source, meta.savedAt, meta.periodKey, meta.from, meta.to, meta.hasSummary ? 1 : 0, JSON.stringify(report)]],
  }]));
  return meta;
}

function requireReportable(report: ReportData): void {
  if (report.state === 'setup') throw new SeoConflictError('There is nothing to report yet: connect a source first', { setup: true });
}

/** Saves the report for the requested period, with the AI summary the person generated for it (if any). */
export async function saveReport(project: ProjectRecord, body: unknown): Promise<SavedMeta> {
  assertWritable(project);
  const input = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const report = await liveReport(project, input);
  requireReportable(report);
  const sent = readSentSummary(input.summary);
  // A summary written for other numbers is not attached: it would describe a report that no longer exists.
  const kept = sent && sent.digest === report.digest ? sent : null;
  const saved: ReportData = { ...report, summary: kept };
  const name = reportName(input.name, defaultNameFor(report));
  return withReportLock(project.id, () => persist(project, name, 'manual', saved, report.period.key));
}

function defaultNameFor(report: ReportData): string {
  const w = report.period.current ?? report.period.requested.current;
  return `${w.from} to ${w.to}`;
}

// ---- scheduled reports ---------------------------------------------------------------------------------------------

const scheduledKey = (cadence: Cadence, from: string): string => `scheduled:${cadence}:${from}`;

/** Builds the report a schedule saves: the last full week (or month) against the one before it. Refuses when there is nothing to report or it was already saved. */
export async function prepareScheduledReport(project: ProjectRecord, cadence: Cadence): Promise<{ report: ReportData; key: string; name: string }> {
  const today = pacificToday(seoDeps().now());
  const { current, previous } = cadence === 'weekly' ? lastFullWeek(today) : lastFullMonth(today);
  const query: ReportQuery = parseReportQuery({ preset: 'custom', from: current.from, to: current.to, compareFrom: previous.from, compareTo: previous.to });
  const report = buildReport(await gatherInputs(project, query));
  if (report.state === 'setup') throw new SeoConflictError('There is nothing to report yet');
  const key = scheduledKey(cadence, current.from);
  if ((await listReports(project)).some((r) => r.periodKey === key)) throw new SeoConflictError('This period was already saved');
  return { report, key, name: defaultReportName(cadence, current) };
}

/** Saves a prepared scheduled report, raises the notification and publishes `report-published`. */
export async function saveScheduledReport(project: ProjectRecord, prepared: { report: ReportData; key: string; name: string }): Promise<SavedMeta> {
  const meta = await withReportLock(project.id, async () => {
    if ((await listReports(project)).some((r) => r.periodKey === prepared.key)) throw new SeoConflictError('This period was already saved');
    return persist(project, prepared.name, 'scheduled', prepared.report, prepared.key);
  });
  await raiseNotification({
    kind: 'seo.report_published', subject: { type: 'project', projectId: project.id },
    title: `SEO report: ${meta.name}`, description: `${project.name}: ${periodLabel(prepared.report)}`,
  });
  try {
    const { connections } = await import('../connections/index.ts');
    await connections.publishEvent({ sourceBuildingId: project.id, eventId: 'report-published', payload: { reportId: meta.id, period: periodLabel(prepared.report), source: 'scheduled' } });
  } catch (error) {
    console.error('Could not publish report-published:', error);
  }
  return meta;
}

// ---- the AI summary --------------------------------------------------------------------------------------------------

/** Asks the agent to write the summary for the requested period. One at a time per Building; the report is usable with or without it. */
export async function generateSummary(project: ProjectRecord, rawQuery: Record<string, unknown>) {
  const report = await liveReport(project, rawQuery);
  requireReportable(report);
  if (summaries.has(project.id)) throw new SeoConflictError('A summary is already being written');
  summaries.add(project.id);
  const { agent, limits, now } = seoDeps();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      agent.summarise(summaryInput(project.id, report), abort.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new SeoUpstreamError(`The agent did not answer within ${Math.max(1, Math.round(limits.agentTimeoutMs / 1000))} seconds`)); }, limits.agentTimeoutMs); }),
    ]);
    return summaryOf(parseSummary(output), report, now().toISOString());
  } finally {
    clearTimeout(timer);
    summaries.delete(project.id);
  }
}

// ---- exports ---------------------------------------------------------------------------------------------------------

export const EXPORT_FORMATS = ['csv', 'md', 'html'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportFile { fileName: string; contentType: string; body: string }

export function renderExport(report: ReportData, meta: { name: string; savedAt: string | null }, query: Record<string, unknown>): ExportFile {
  const format: ExportFormat = oneOf(query.format, 'format', EXPORT_FORMATS, 'md');
  if (format === 'csv') {
    const table = requireCsvTable(query.table);
    return { fileName: exportFileName(`${meta.name} ${table}`, 'csv'), contentType: 'text/csv', body: reportCsv(report, table) };
  }
  if (format === 'html') return { fileName: exportFileName(meta.name, 'html'), contentType: 'text/html', body: reportHtml(report, meta) };
  return { fileName: exportFileName(meta.name, 'md'), contentType: 'text/markdown', body: reportMarkdown(report, meta) };
}

export async function exportLive(project: ProjectRecord, query: Record<string, unknown>): Promise<ExportFile> {
  const report = await liveReport(project, query);
  return renderExport(report, { name: `SEO report ${defaultNameFor(report)}`, savedAt: null }, query);
}

export async function exportSaved(project: ProjectRecord, id: string, query: Record<string, unknown>): Promise<ExportFile> {
  const saved = await getReport(project, id);
  return renderExport(saved.report, { name: saved.name, savedAt: saved.savedAt }, query);
}

// ---- the cross-Building capability ---------------------------------------------------------------------------------

/** The outputs of `get-latest-report`: the newest saved report as Markdown with its key numbers, or `found: false`. */
export async function latestReportOutputs(buildingId: string): Promise<Record<string, unknown>> {
  const project = await projectsDb.get(buildingId);
  const latest = project ? await latestReport(project) : null;
  if (!latest) return { found: false, markdown: '', period: '', savedAt: '', keyNumbers: {} };
  return {
    found: true, markdown: reportMarkdown(latest.report, { name: latest.name, savedAt: latest.savedAt }), period: periodLabel(latest.report), savedAt: latest.savedAt,
    keyNumbers: Object.fromEntries(Object.entries(keyNumbers(latest.report)).filter(([, v]) => v !== null)),
  };
}
