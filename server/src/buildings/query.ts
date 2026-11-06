import type { RollupSpec, TableSpec } from './contract.ts';
import { rollupTable } from './schema.ts';

/** A malformed request to the bulk layer: always the caller's fault, always a 400. */
export class QueryError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'prefix';
const OPS: Record<FilterOp, string> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'LIKE', prefix: 'LIKE' };

export interface Filter { col: string; op: FilterOp; value: string | number }

export interface ListRequest {
  sort?: string;
  dir?: string;
  filters?: Filter[];
  search?: string;
  limit?: unknown;
  cursor?: string;
}

export interface ListQuery {
  sql: string;
  params: Array<string | number>;
  pageSize: number;
  sortCol: string;
}

/** No limit means the default page, never everything; above the maximum is clamped; anything else non-positive or non-numeric is rejected. */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_PAGE_SIZE;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new QueryError('limit must be a positive whole number');
  return Math.min(n, MAX_PAGE_SIZE);
}

export function encodeCursor(sortValue: string | number, id: number): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString('base64url');
}

export function decodeCursor(cursor: string): [string | number, number] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && (typeof parsed[0] === 'string' || typeof parsed[0] === 'number') && Number.isInteger(parsed[1])) {
      return [parsed[0], parsed[1] as number];
    }
  } catch { /* falls through to the error below */ }
  throw new QueryError('cursor is not valid');
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function bindable(table: TableSpec, col: string, value: unknown): string | number {
  const type = col === 'id' ? 'integer' : table.columns.find((c) => c.name === col)?.type;
  if (type === 'integer' || type === 'real') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(n)) throw new QueryError(`${col} needs a numeric value`);
    return n;
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new QueryError(`${col} needs a text value`);
  return String(value);
}

/** Builds the keyset-paginated SELECT for a table. Every identifier comes from the allow-lists, every value is bound. */
export function buildListQuery(table: TableSpec, req: ListRequest): ListQuery {
  const pageSize = parseLimit(req.limit);
  const sortCol = req.sort ?? 'id';
  if (sortCol !== 'id' && !table.sortable.includes(sortCol)) throw new QueryError(`cannot sort ${table.name} by "${sortCol}"`);
  const dirRaw = (req.dir ?? 'asc').toLowerCase();
  if (dirRaw !== 'asc' && dirRaw !== 'desc') throw new QueryError('dir must be "asc" or "desc"');
  const cmp = dirRaw === 'asc' ? '>' : '<';
  const where: string[] = [];
  const params: Array<string | number> = [];

  for (const f of req.filters ?? []) {
    if (!(f?.op in OPS)) throw new QueryError(`unknown filter operator "${String(f?.op)}"`);
    if (!table.filterable.includes(f.col)) throw new QueryError(`cannot filter ${table.name} by "${String(f.col)}"`);
    if (f.op === 'contains' || f.op === 'prefix') {
      const text = escapeLike(String(f.value));
      where.push(`${f.col} LIKE ? ESCAPE '\\'`);
      params.push(f.op === 'contains' ? `%${text}%` : `${text}%`);
    } else {
      where.push(`${f.col} ${OPS[f.op]} ?`);
      params.push(bindable(table, f.col, f.value));
    }
  }

  const search = req.search?.trim();
  if (search) {
    const cols = table.searchable ?? [];
    if (!cols.length) throw new QueryError(`${table.name} is not searchable`);
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < cols.length; i++) params.push(`%${escapeLike(search)}%`);
  }

  if (req.cursor) {
    const [sortValue, id] = decodeCursor(req.cursor);
    if (sortCol === 'id') {
      where.push(`id ${cmp} ?`);
      params.push(id);
    } else {
      where.push(`(${sortCol}, id) ${cmp} (?, ?)`);
      params.push(bindable(table, sortCol, sortValue), id);
    }
  }

  const direction = dirRaw.toUpperCase();
  const order = sortCol === 'id' ? `id ${direction}` : `${sortCol} ${direction}, id ${direction}`;
  const sql = `SELECT * FROM ${table.name}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${pageSize + 1}`;
  return { sql, params, pageSize, sortCol };
}

export interface AggregateRequest {
  groupBy?: string[];
  range?: { col: string; from?: string | number; to?: string | number };
  /** Equality filters on group-by columns (e.g. one property's rows only). */
  where?: Record<string, string | number>;
  orderBy?: string;
  dir?: string;
  limit?: unknown;
}

export interface AggregateQuery { sql: string; params: Array<string | number> }

/** Reads only the maintained roll-up table, never the raw rows. */
export function buildAggregateQuery(rollup: RollupSpec, req: AggregateRequest): AggregateQuery {
  const groupBy = req.groupBy ?? [];
  for (const g of groupBy) if (!rollup.groupBy.includes(g)) throw new QueryError(`cannot group ${rollup.name} by "${g}"`);
  const limit = parseLimit(req.limit ?? 10);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (req.range) {
    if (!rollup.groupBy.includes(req.range.col)) throw new QueryError(`cannot range ${rollup.name} by "${req.range.col}"`);
    if (req.range.from !== undefined) { where.push(`${req.range.col} >= ?`); params.push(req.range.from); }
    if (req.range.to !== undefined) { where.push(`${req.range.col} <= ?`); params.push(req.range.to); }
  }
  for (const [col, value] of Object.entries(req.where ?? {})) {
    if (!rollup.groupBy.includes(col)) throw new QueryError(`cannot filter ${rollup.name} by "${col}"`);
    where.push(`${col} = ?`);
    params.push(value);
  }
  const select = [...groupBy, ...rollup.measures.map((m) => `SUM(${m}) AS ${m}`), 'SUM(rows) AS rows'];
  const orderCol = req.orderBy ?? groupBy[0];
  if (orderCol && !groupBy.includes(orderCol) && ![...rollup.measures, 'rows'].includes(orderCol)) throw new QueryError(`cannot order ${rollup.name} by "${orderCol}"`);
  const dirRaw = (req.dir ?? (req.orderBy && rollup.measures.includes(req.orderBy) ? 'desc' : 'asc')).toLowerCase();
  if (dirRaw !== 'asc' && dirRaw !== 'desc') throw new QueryError('dir must be "asc" or "desc"');
  const sql = `SELECT ${select.join(', ')} FROM ${rollupTable(rollup.name)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
    + `${groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : ''}${groupBy.length && orderCol ? ` ORDER BY ${orderCol} ${dirRaw.toUpperCase()}` : ''} LIMIT ${groupBy.length ? limit : 1}`;
  return { sql, params };
}

/** Converts a row given as an object into the table's column order, rejecting a missing or mistyped column. */
export function toRowArray(table: TableSpec, row: unknown): Array<string | number> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new QueryError(`each ${table.name} row must be an object`);
  return table.columns.map((c) => {
    const value = (row as Record<string, unknown>)[c.name];
    if (value === undefined || value === null) throw new QueryError(`${c.name} is required`);
    if (c.type === 'text') {
      if (typeof value !== 'string') throw new QueryError(`${c.name} must be text`);
      return value;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || (c.type === 'integer' && !Number.isInteger(value))) throw new QueryError(`${c.name} must be a ${c.type === 'integer' ? 'whole ' : ''}number`);
    return value;
  });
}

/** One per-group sum request over a table or roll-up (`source` is a table name or `rollup:<name>`); see `groupSums` in the worker. */
export interface GroupSumsRequest {
  source: string;
  groupBy?: string[];
  measures?: string[];
  where?: Record<string, string | number>;
  match?: { col: string; exact: string[]; prefixes: string[] };
  range?: { col: string; from: string; to: string };
  orderBy?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
}

