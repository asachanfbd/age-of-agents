import { randomUUID } from 'node:crypto';
import { getStore, guardedWrite } from '../buildings/buildingStorage.ts';
import { assertWritable } from '../buildings/normalize.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import type { ReplaceStep } from '../buildings/contract.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { seoDeps } from './deps.ts';
import { SeoInputError, SeoNotFoundError } from './errors.ts';
import { readFile } from './backlinkCsv.ts';
import type { ParsedFile } from './backlinkCsv.ts';
import { lostCount, planImport, statusOf } from './backlinkImport.ts';
import type { ImportMode, LinkRec } from './backlinkImport.ts';
import { applyPreset, mappingName, PRESETS, suggestPreset, validateMapping } from './backlinkMapping.ts';
import type { Mapping } from './backlinkMapping.ts';
import { domainRollup, LINK_SORTS, LINK_VIEWS, requireNote, requirePeriod, selectLinks, summarise, targetRollup, validateQuery } from './backlinkMetrics.ts';
import type { LinkQuery, LinkSort, LinkView } from './backlinkMetrics.ts';
import { extraHeaders, parseRow } from './backlinkRows.ts';
import type { LinkInput } from './backlinkRows.ts';
import { BACKLINK_TABLES, NO_METRIC } from './backlinkTables.ts';
import type { BatchRow } from './backlinkTables.ts';
import { csvLine } from './keywordCsv.ts';
import { withKeywordLock } from './keywords.ts';
import { oneOf, textParam, wholeParam } from './pages.ts';
import { settingsOf } from './siteAccess.ts';

export const MAX_LISTED_PROBLEMS = 200;
export const MAX_BACKLINK_PAGE_SIZE = 500;
export const DEFAULT_BACKLINK_PAGE_SIZE = 50;
const SAMPLE_ROWS = 5;
const MAX_FILE_NAME = 200;

type Table = 'seo_backlinks' | 'seo_backlink_batches' | 'seo_backlink_mappings';
const columnsOf = (table: Table): string[] => BACKLINK_TABLES.find((t) => t.name === table)!.columns.map((c) => c.name);
const metric = (n: number | null): number => n ?? NO_METRIC;
const unmetric = (n: number): number | null => (n === NO_METRIC ? null : n);

async function readTable<T>(store: BulkStore, table: Table): Promise<T[]> {
  const { rows } = await store.groupSums({ source: table, groupBy: columnsOf(table) });
  return rows as unknown as T[];
}

type LinkRow = Record<string, string | number>;
const linkFromRow = (r: LinkRow): LinkRec => ({
  uid: r.uid as string, key: r.key as string, sourceUrl: r.sourceUrl as string, sourceHost: r.sourceHost as string, targetUrl: r.targetUrl as string, anchor: r.anchor as string,
  linkType: (r.linkType as string) || null, firstSeen: r.firstSeen as string, lastSeen: r.lastSeen as string,
  sourceDr: unmetric(r.sourceDr as number), sourceUr: unmetric(r.sourceUr as number), sourceTraffic: unmetric(r.sourceTraffic as number),
  pageDr: unmetric(r.pageDr as number), pageUr: unmetric(r.pageUr as number), pageTraffic: unmetric(r.pageTraffic as number),
  otherHost: r.otherHost === 1, extras: JSON.parse((r.extras as string) || '{}') as Record<string, string>, note: r.note as string,
  firstBatch: r.firstBatch as number, lostAt: r.lostAt as string,
});
const linkToArray = (l: LinkRec): Array<string | number> => [
  l.uid, l.key, l.sourceUrl, l.sourceHost, l.targetUrl, l.anchor, l.linkType ?? '', l.firstSeen, l.lastSeen,
  metric(l.sourceDr), metric(l.sourceUr), metric(l.sourceTraffic), metric(l.pageDr), metric(l.pageUr), metric(l.pageTraffic),
  l.otherHost ? 1 : 0, JSON.stringify(l.extras), l.note, l.firstBatch, l.lostAt,
];
const linkStep = (l: LinkRec): ReplaceStep => ({ table: 'seo_backlinks', where: { uid: l.uid }, rows: [linkToArray(l)] });

interface State { links: LinkRec[]; byKey: Map<string, LinkRec>; batches: BatchRow[]; latestBatch: number }

async function readState(store: BulkStore): Promise<State> {
  const [rows, batches] = await Promise.all([readTable<LinkRow>(store, 'seo_backlinks'), readTable<BatchRow>(store, 'seo_backlink_batches')]);
  const links = rows.map(linkFromRow);
  return { links, byKey: new Map(links.map((l) => [l.key, l])), batches: batches.sort((a, b) => b.seq - a.seq), latestBatch: batches.reduce((m, b) => Math.max(m, b.seq), 0) };
}

/** Every link the Building holds, lost ones included, and whether anything has been imported yet. */
export async function readLinks(project: ProjectRecord): Promise<{ links: LinkRec[]; imported: boolean }> {
  const state = await readState(await getStore(project));
  return { links: state.links, imported: state.batches.length > 0 };
}

const todayOf = (): string => seoDeps().now().toISOString().slice(0, 10);

async function context(project: ProjectRecord): Promise<{ store: BulkStore; siteUrl: string }> {
  return { store: await getStore(project), siteUrl: (await settingsOf(project)).siteUrl };
}

// ---- import --------------------------------------------------------------------------------------------------------

export interface ImportRequest { fileName: unknown; content: unknown; format?: unknown; mapping?: unknown; mode?: unknown; confirm?: unknown; rememberAs?: unknown }
export interface Problem { row: number; message: string }

interface Analysis {
  file: ParsedFile;
  mapping: Mapping;
  valid: LinkInput[];
  problems: Problem[];
  /** Keys of rows that were invalid but still name a link. */
  skippedKeys: Set<string>;
  duplicates: number;
  invalid: number;
}

function bytesOf(content: unknown): Buffer {
  if (typeof content !== 'string' || !content) throw new SeoInputError('The file is empty.');
  return Buffer.from(content, 'base64');
}

function resolveMapping(file: ParsedFile, format: unknown, mapping: unknown): Mapping | null {
  if (mapping !== undefined && mapping !== null) return validateMapping(mapping, file.headers);
  const preset = typeof format === 'string' && format !== 'auto' ? PRESETS.find((p) => p.id === format) : suggestPreset(file.headers);
  if (format !== undefined && format !== 'auto' && format !== 'manual' && !preset) throw new SeoInputError(`format must be auto, manual or one of ${PRESETS.map((p) => p.id).join(', ')}`);
  return preset ? validateMapping(applyPreset(preset, file.headers), file.headers) : null;
}

/** Checks every row, yielding to other requests after each chunk of rows so a large file does not hold the daemon. */
async function analyse(file: ParsedFile, mapping: Mapping, siteUrl: string, today: string): Promise<Analysis> {
  const out: Analysis = { file, mapping, valid: [], problems: [], skippedKeys: new Set(), duplicates: 0, invalid: 0 };
  const firstRow = new Map<string, number>();
  const ctx = { siteUrl, today, headers: file.headers, mapping };
  const chunk = seoDeps().limits.backlinkChunkRows;
  for (const [index, { row, cells }] of file.rows.entries()) {
    if (index > 0 && index % chunk === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const result = parseRow(cells, ctx);
    if (!result.ok) {
      out.invalid++;
      out.problems.push({ row, message: result.error });
      if (result.key) out.skippedKeys.add(result.key);
      continue;
    }
    const seenAt = firstRow.get(result.link.key);
    if (seenAt !== undefined) { out.duplicates++; out.problems.push({ row, message: `Duplicate of row ${seenAt}` }); continue; }
    firstRow.set(result.link.key, row);
    out.valid.push(result.link);
  }
  return out;
}

async function parseImportRequest(body: ImportRequest, siteUrl: string): Promise<Analysis | { file: ParsedFile; mapping: null }> {
  if (!siteUrl) throw new SeoInputError('Set the site address for this Building first: backlinks to it are matched against it.');
  const file = readFile(body.fileName, bytesOf(body.content), seoDeps().limits.backlinkFileBytes);
  const mapping = resolveMapping(file, body.format, body.mapping);
  return mapping ? await analyse(file, mapping, siteUrl, todayOf()) : { file, mapping: null };
}

const requireMode = (value: unknown): ImportMode => {
  if (value !== 'full' && value !== 'partial') throw new SeoInputError('Say whether the file is a full export or a partial update.');
  return value;
};

const fileInfo = (file: ParsedFile) => ({ encoding: file.encoding, delimiter: file.delimiter, headers: file.headers, rows: file.rows.length });

/** Reads a file and says what importing it would do; nothing is saved. Without a usable mapping it returns only the file's headers and the presets. */
export async function previewImport(project: ProjectRecord, body: ImportRequest): Promise<Record<string, unknown>> {
  const { store, siteUrl } = await context(project);
  const analysis = await parseImportRequest(body, siteUrl);
  const presets = PRESETS.map((p) => ({ id: p.id, name: p.name }));
  if (!analysis.mapping) return { ...fileInfo(analysis.file), presets, suggested: null, needsMapping: true };
  const a = analysis as Analysis;
  const mode = body.mode === undefined ? null : requireMode(body.mode);
  const state = await readState(store);
  return {
    ...fileInfo(a.file), presets, suggested: suggestPreset(a.file.headers)?.id ?? null, needsMapping: false, mapping: a.mapping,
    extraColumns: extraHeaders(a.file.headers, a.mapping), valid: a.valid.length, invalid: a.invalid, duplicates: a.duplicates,
    problems: a.problems.slice(0, MAX_LISTED_PROBLEMS), problemsTotal: a.problems.length,
    willBeLost: mode === 'full' ? lostCount(state.byKey, a.valid, a.skippedKeys) : 0,
    sample: a.valid.slice(0, SAMPLE_ROWS).map((l) => ({ sourceUrl: l.sourceUrl, targetUrl: l.targetUrl, anchor: l.anchor, linkType: l.linkType, firstSeen: l.firstSeen, lastSeen: l.lastSeen, sourceDr: l.sourceDr, sourceUr: l.sourceUr, sourceTraffic: l.sourceTraffic, otherHost: l.otherHost })),
  };
}

/** Saves an import: the links, the batch and (when asked) the mapping land in one step, so a failure leaves the previous state untouched. */
export async function commitImport(project: ProjectRecord, body: ImportRequest): Promise<Record<string, unknown>> {
  assertWritable(project);
  const mode = requireMode(body.mode);
  return withKeywordLock(project.id, async () => {
    const { store, siteUrl } = await context(project);
    const analysis = await parseImportRequest(body, siteUrl);
    if (!analysis.mapping) throw new SeoInputError('Map the source and target columns before importing.');
    const a = analysis as Analysis;
    if (!a.valid.length) throw new SeoInputError('The file has no valid rows, so nothing was imported.');
    if (a.problems.length && body.confirm !== true) throw new SeoInputError(`The file has ${a.problems.length} problem rows. Confirm to import only the valid rows.`);
    const state = await readState(store);
    const today = todayOf();
    const seq = state.latestBatch + 1;
    const plan = planImport(state.byKey, a.valid, a.skippedKeys, mode, seq, today, randomUUID);
    const batch: BatchRow = { seq, uid: randomUUID(), fileName: String(body.fileName).slice(0, MAX_FILE_NAME), mode, importedAt: seoDeps().now().toISOString(), fileRows: a.file.rows.length, ...plan.counts, skipped: a.problems.length };
    const steps: ReplaceStep[] = [...plan.changes.map(linkStep), { table: 'seo_backlink_batches', where: { uid: batch.uid }, rows: [columnsOf('seo_backlink_batches').map((c) => (batch as unknown as LinkRow)[c]!)] }];
    if (body.rememberAs !== undefined && body.rememberAs !== null && body.rememberAs !== '') {
      const name = mappingName(body.rememberAs);
      steps.push({ table: 'seo_backlink_mappings', where: { name }, rows: [[name, JSON.stringify(a.mapping)]] });
    }
    await guardedWrite(project, (s) => s.replaceRows(steps));
    return { batch, counts: plan.counts, skipped: a.problems.length };
  });
}

export async function listMappings(project: ProjectRecord): Promise<Array<{ name: string; mapping: Mapping }>> {
  const { store } = await context(project);
  const rows = await readTable<{ name: string; mapping: string }>(store, 'seo_backlink_mappings');
  return rows.map((r) => ({ name: r.name, mapping: JSON.parse(r.mapping) as Mapping })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listBatches(project: ProjectRecord): Promise<BatchRow[]> {
  return (await readState((await context(project)).store)).batches;
}

// ---- reading -------------------------------------------------------------------------------------------------------

function numberParam(value: unknown, name: string): number | null {
  if (value === undefined || value === '') return null;
  const n = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n > 100) throw new SeoInputError(`${name} must be a number from 0 to 100`);
  return n;
}

export function parseLinkQuery(raw: Record<string, unknown>): LinkQuery & { limit: number; offset: number } {
  const status = textParam(raw.status, 'status');
  const type = textParam(raw.type, 'type');
  return {
    ...validateQuery({
      view: oneOf(raw.view, 'view', LINK_VIEWS, 'all'), period: requirePeriod(raw.period), status: (status || null) as LinkQuery['status'], type: type || null,
      drMin: numberParam(raw.drMin, 'drMin'), drMax: numberParam(raw.drMax, 'drMax'), domain: textParam(raw.domain, 'domain'), target: textParam(raw.target, 'target'),
      search: textParam(raw.search, 'search').trim(), sort: oneOf<LinkSort>(raw.sort, 'sort', LINK_SORTS, 'firstSeen'), dir: oneOf(raw.dir, 'dir', ['asc', 'desc'] as const, 'desc'),
    }),
    limit: wholeParam(raw.limit, 'limit', 1, MAX_BACKLINK_PAGE_SIZE, DEFAULT_BACKLINK_PAGE_SIZE),
    offset: wholeParam(raw.offset, 'offset', 0, 10_000_000, 0),
  };
}

const viewOf = (l: LinkRec, latestBatch: number) => ({
  uid: l.uid, sourceUrl: l.sourceUrl, sourceHost: l.sourceHost, targetUrl: l.targetUrl, anchor: l.anchor, linkType: l.linkType, firstSeen: l.firstSeen, lastSeen: l.lastSeen,
  status: statusOf(l, latestBatch), lostAt: l.lostAt || null, sourceDr: l.sourceDr, sourceUr: l.sourceUr, sourceTraffic: l.sourceTraffic, pageDr: l.pageDr, pageUr: l.pageUr,
  pageTraffic: l.pageTraffic, otherHost: l.otherHost, extras: l.extras, note: l.note,
});

export async function listLinks(project: ProjectRecord, raw: Record<string, unknown>) {
  const q = parseLinkQuery(raw);
  const state = await readState((await context(project)).store);
  const selected = selectLinks(state.links, q, state.latestBatch, todayOf());
  return { links: selected.slice(q.offset, q.offset + q.limit).map((l) => viewOf(l, state.latestBatch)), total: selected.length, limit: q.limit, offset: q.offset };
}

export async function backlinkOverview(project: ProjectRecord, raw: Record<string, unknown>) {
  const period = requirePeriod(raw.period);
  const state = await readState((await context(project)).store);
  return { summary: summarise(state.links, period, todayOf()), period, hasImports: state.batches.length > 0 };
}

export async function backlinkDomains(project: ProjectRecord) {
  return { domains: domainRollup((await readState((await context(project)).store)).links) };
}

export async function backlinkTargets(project: ProjectRecord) {
  return { targets: targetRollup((await readState((await context(project)).store)).links) };
}

const EXPORT_HEADERS = ['Source URL', 'Source domain', 'Target URL', 'Anchor', 'Link type', 'First seen', 'Last seen', 'Status', 'Lost on', 'DR', 'UR', 'Source traffic', 'Page DR', 'Page UR', 'Page traffic', 'Other host', 'Note'];

export async function exportLinks(project: ProjectRecord, raw: Record<string, unknown>): Promise<string> {
  const q = parseLinkQuery(raw);
  const state = await readState((await context(project)).store);
  const selected = selectLinks(state.links, q, state.latestBatch, todayOf());
  const extras = [...new Set(selected.flatMap((l) => Object.keys(l.extras)))];
  const lines = [csvLine([...EXPORT_HEADERS, ...extras])];
  for (const l of selected) {
    lines.push(csvLine([
      l.sourceUrl, l.sourceHost, l.targetUrl, l.anchor, l.linkType, l.firstSeen, l.lastSeen, statusOf(l, state.latestBatch), l.lostAt, l.sourceDr, l.sourceUr, l.sourceTraffic,
      l.pageDr, l.pageUr, l.pageTraffic, l.otherHost ? 'yes' : 'no', l.note, ...extras.map((e) => l.extras[e]),
    ]));
  }
  return `${lines.join('\n')}\n`;
}

// ---- editing -------------------------------------------------------------------------------------------------------

async function editLink(project: ProjectRecord, uid: string, change: (link: LinkRec) => LinkRec | null): Promise<void> {
  assertWritable(project);
  await withKeywordLock(project.id, async () => {
    const { store } = await context(project);
    const link = (await readState(store)).links.find((l) => l.uid === uid);
    if (!link) throw new SeoNotFoundError('There is no such backlink.');
    const next = change(link);
    await guardedWrite(project, (s) => s.replaceRows([next ? linkStep(next) : { table: 'seo_backlinks', where: { uid }, rows: [] }]));
  });
}

export const deleteLink = (project: ProjectRecord, uid: string): Promise<void> => editLink(project, uid, () => null);

export async function setNote(project: ProjectRecord, uid: string, note: unknown): Promise<{ note: string }> {
  const text = requireNote(note);
  await editLink(project, uid, (l) => ({ ...l, note: text }));
  return { note: text };
}
