/** View-models for a Building's bulk data: paged queries, the Settings storage section and the ingest job. */

export const PAGE_SIZE = 50;

export interface DataQuery {
  sort?: string;
  dir?: 'asc' | 'desc';
  search?: string;
  filters?: Array<{ col: string; op: string; value: string }>;
  cursor?: string | null;
  limit?: number;
}

/** Every list request carries a limit; there is no way to ask for all rows. */
export function dataQueryString(query: DataQuery): string {
  const params = new URLSearchParams();
  const requested = Math.floor(query.limit ?? PAGE_SIZE);
  params.set('limit', String(Number.isFinite(requested) ? Math.min(Math.max(1, requested), 200) : PAGE_SIZE));
  if (query.sort) params.set('sort', query.sort);
  if (query.dir) params.set('dir', query.dir);
  if (query.search?.trim()) params.set('search', query.search.trim());
  for (const f of query.filters ?? []) if (f.value !== '') params.append('filter', `${f.col}:${f.op}:${f.value}`);
  if (query.cursor) params.set('cursor', query.cursor);
  return params.toString();
}

export interface PagerState {
  /** Cursors of the pages before this one; the first page has none. */
  history: Array<string | null>;
  nextCursor: string | null;
}

export function pagerInfo(pager: PagerState, rowsOnPage: number, limit = PAGE_SIZE) {
  const page = pager.history.length + 1;
  const from = rowsOnPage === 0 ? 0 : pager.history.length * limit + 1;
  return {
    page,
    canPrev: pager.history.length > 0,
    canNext: pager.nextCursor !== null,
    label: rowsOnPage === 0 ? 'No rows' : `Rows ${from.toLocaleString()} to ${(from + rowsOnPage - 1).toLocaleString()}`,
  };
}

export function nextPager(pager: PagerState, currentCursor: string | null, nextCursor: string | null): PagerState {
  return { history: [...pager.history, currentCursor], nextCursor };
}

export function prevPager(pager: PagerState): { pager: PagerState; cursor: string | null } {
  const history = pager.history.slice(0, -1);
  return { pager: { history, nextCursor: null }, cursor: pager.history.at(-1) ?? null };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Parses "2 GB" / "500 MB" / "1.5gb" into bytes; null when it is not a positive size. */
export function parseSize(text: string): number | null {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) return null;
  const power = ['b', 'kb', 'mb', 'gb', 'tb'].indexOf((match[2] ?? 'b').toLowerCase());
  const bytes = Math.floor(Number(match[1]) * 1024 ** power);
  return bytes > 0 ? bytes : null;
}

export interface StorageStatusDto {
  bytes: number;
  warningBytes: number;
  level: 'ok' | 'warning';
  retention: { rule: { table: string; months: number; mode: string } | null; description: string };
  lastBackup: { file: string; at: string; reason: 'migration' | 'export' } | null;
  readOnlyReason: string | null;
  ingestionStoppedReason: string | null;
  secrets: Array<{ key: string; hasSecret: true }>;
}

export function storageSummary(status: StorageStatusDto, retentionRunning: boolean) {
  return {
    size: formatBytes(status.bytes),
    threshold: formatBytes(status.warningBytes),
    percent: Math.min(100, Math.round((status.bytes / status.warningBytes) * 100)),
    warning: status.level === 'warning',
    retentionText: status.retention.description,
    canRunRetention: status.retention.rule !== null && !retentionRunning && status.readOnlyReason === null,
    backupText: status.lastBackup
      ? `${status.lastBackup.reason === 'migration' ? 'Before a migration' : 'Export'} on ${status.lastBackup.at.slice(0, 10)}`
      : 'No backup yet',
    banner: status.readOnlyReason ?? (status.ingestionStoppedReason ? `Ingestion is stopped: ${status.ingestionStoppedReason}` : null),
  };
}

export type StorageJobStatus = 'running' | 'done' | 'cancelled' | 'failed';
export interface StorageJobDto { id: string; kind: 'ingest' | 'retention'; status: StorageJobStatus; done: number; total: number; phase?: 'indexing'; error?: string }

export function jobSummary(job: StorageJobDto) {
  const percent = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : 0;
  const label = job.status === 'running' && job.phase === 'indexing' ? 'All rows added. Building indexes…'
    : job.status === 'running' ? `${percent}% (${job.done.toLocaleString()} of ${job.total.toLocaleString()} rows)`
    : job.status === 'done' ? 'Finished'
      : job.status === 'cancelled' ? `Cancelled after ${job.done.toLocaleString()} rows`
        : `Failed: ${job.error ?? 'unknown error'}`;
  return { percent, label, running: job.status === 'running', canCancel: job.status === 'running' };
}

/** A new threshold typed by the person; null with a message when it cannot be saved, checked before any request. */
export function checkThreshold(text: string): { bytes: number } | { error: string } {
  const bytes = parseSize(text);
  return bytes === null ? { error: 'Enter a size such as 500 MB or 2 GB.' } : { bytes };
}

/** The first day kept by a retention rule at `now` (UTC), mirroring the daemon: rows dated before it are discarded. */
export function retentionCutoffDate(months: number, now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())).toISOString().slice(0, 10);
}

/** What the person is asked to confirm before "Run now" deletes data. */
export function retentionConfirmText(rule: { table: string; months: number; mode: string }, now: Date): string {
  const roll = rule.mode === 'rollup' ? 'Roll-up totals keep covering those days.' : 'Roll-up totals are reduced to match.';
  return `Delete every row in "${rule.table}" dated before ${retentionCutoffDate(rule.months, now)}? This cannot be undone. ${roll}`;
}

export const NO_SECRETS_TEXT = 'No credentials are saved for this Building. A type that needs one (for example an API key) lists it here.';
