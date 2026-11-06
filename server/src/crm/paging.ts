import type { Db } from './db.ts';
import { CrmInputError } from './errors.ts';
import { LIST_DEFAULT, LIST_LIMIT_MAX } from './limits.ts';

export interface Page<T> { rows: T[]; total: number; limit: number; offset: number; hasMore: boolean }

/** Missing means the default page; above the maximum is clamped; zero, negative, fractional or non-numeric is refused. */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return LIST_DEFAULT;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new CrmInputError('limit must be a positive whole number', 'limit');
  return Math.min(n, LIST_LIMIT_MAX);
}
export function parseOffset(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new CrmInputError('offset must be a whole number from 0', 'offset');
  return n;
}

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface PageSpec<R, T> { select: string; where: string[]; params: unknown[]; order: string; limit: unknown; offset: unknown; map: (r: R) => T; countFrom?: string }

/** One server-side page plus the exact total for the same filters. `order` must end in a unique key so pages never skip or repeat a row. */
export function pageOf<R, T>(db: Db, spec: PageSpec<R, T>): Page<T> {
  const limit = parseLimit(spec.limit), offset = parseOffset(spec.offset);
  const where = spec.where.length ? ` WHERE ${spec.where.join(' AND ')}` : '';
  const from = spec.countFrom ?? spec.select.slice(spec.select.toUpperCase().indexOf(' FROM ') + 1);
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from.replace(/^FROM/i, 'FROM')}${where}`).get(...(spec.params as never[])) as { n: number }).n;
  const rows = db.prepare(`${spec.select}${where} ORDER BY ${spec.order} LIMIT ? OFFSET ?`).all(...(spec.params as never[]), limit, offset) as R[];
  return { rows: rows.map(spec.map), total, limit, offset, hasMore: offset + rows.length < total };
}
