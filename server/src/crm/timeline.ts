import type { Statement } from 'better-sqlite3';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import { COMMENT_MAX } from './limits.ts';
import type { CrmCtx } from './context.ts';
import { pageOf, type Page } from './paging.ts';

export const TIMELINE_KINDS = [
  'added', 'imported_again', 'stage_changed', 'reachout_planned', 'reachout_approved', 'reachout_sent', 'reachout_failed', 'reachout_retried',
  'reachout_cancelled', 'reachout_delayed', 'followup_planned', 'followup_approved', 'followup_sent', 'followup_failed', 'followup_retried',
  'followup_cancelled', 'followup_done', 'followup_delayed', 'response_logged', 'comment', 'comment_edited', 'comment_deleted', 'mom',
  'merged', 'unmerged', 'merge_value_kept', 'segment_moved', 'building_attached', 'building_detached', 'dnc_changed', 'channel_changed',
  'no_response', 'contact_edited', 'building_work',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineEntry { id: number; contactId: number; kind: TimelineKind; at: number; text: string; data: Record<string, unknown>; deleted: boolean; editedAt: number | null }

interface Row { id: number; contactId: number; kind: TimelineKind; at: number; text: string; data: string; deleted: number; editedAt: number | null }
const toEntry = (r: Row): TimelineEntry => ({ id: r.id, contactId: r.contactId, kind: r.kind, at: r.at, text: r.deleted ? '' : r.text, data: JSON.parse(r.data), deleted: r.deleted === 1, editedAt: r.editedAt });

const insertStatements = new WeakMap<object, Statement<unknown[]>>();

export function addEntry(ctx: CrmCtx, contactId: number, kind: TimelineKind, text: string, data: Record<string, unknown> = {}, at = ctx.now()): number {
  let insert = insertStatements.get(ctx.db);
  if (!insert) { insert = ctx.db.prepare('INSERT INTO timeline (contactId, kind, at, text, data) VALUES (?, ?, ?, ?, ?)'); insertStatements.set(ctx.db, insert); }
  return Number(insert.run(contactId, kind, at, text, JSON.stringify(data)).lastInsertRowid);
}
export function listTimeline(ctx: CrmCtx, contactId: number, limit: unknown, offset: unknown): Page<TimelineEntry> {
  return pageOf<Row, TimelineEntry>(ctx.db, {
    select: 'SELECT * FROM timeline', where: ['contactId = ?'], params: [contactId], order: 'at DESC, id DESC', limit, offset, map: toEntry,
  });
}

function commentText(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new CrmInputError('A comment cannot be empty', 'text');
  if ([...raw].length > COMMENT_MAX) throw new CrmInputError(`A comment can be at most ${COMMENT_MAX} characters`, 'text');
  return raw.trim();
}

export function addComment(ctx: CrmCtx, contactId: number, raw: unknown): TimelineEntry {
  const text = commentText(raw);
  const id = addEntry(ctx, contactId, 'comment', text);
  return toEntry(ctx.db.prepare('SELECT * FROM timeline WHERE id = ?').get(id) as Row);
}

function ownComment(ctx: CrmCtx, contactId: number, entryId: number): Row {
  const row = ctx.db.prepare('SELECT * FROM timeline WHERE id = ? AND contactId = ?').get(entryId, contactId) as Row | undefined;
  if (!row) throw new CrmNotFoundError('That timeline entry does not exist');
  if (row.kind !== 'comment') throw new CrmConflictError('Only comments can be changed; other timeline entries are a permanent record');
  if (row.deleted) throw new CrmConflictError('That comment was deleted');
  return row;
}

export function editComment(ctx: CrmCtx, contactId: number, entryId: number, raw: unknown): TimelineEntry {
  const row = ownComment(ctx, contactId, entryId);
  const text = commentText(raw);
  ctx.db.prepare('UPDATE timeline SET text = ?, editedAt = ? WHERE id = ?').run(text, ctx.now(), entryId);
  addEntry(ctx, contactId, 'comment_edited', 'Comment edited', { entryId, before: row.text });
  return toEntry(ctx.db.prepare('SELECT * FROM timeline WHERE id = ?').get(entryId) as Row);
}

export function deleteComment(ctx: CrmCtx, contactId: number, entryId: number): void {
  ownComment(ctx, contactId, entryId);
  ctx.db.prepare("UPDATE timeline SET deleted = 1, text = '' WHERE id = ?").run(entryId);
  addEntry(ctx, contactId, 'comment_deleted', 'Comment deleted', { entryId });
}

/** Inserts a Building-work entry unless one with the same work key exists; returns whether a row was written. */
export function addWorkEntry(ctx: CrmCtx, contactId: number, workKey: string, text: string, data: Record<string, unknown>, at: number): boolean {
  const result = ctx.db.prepare('INSERT OR IGNORE INTO timeline (contactId, kind, at, text, data, workKey) VALUES (?, ?, ?, ?, ?, ?)')
    .run(contactId, 'building_work', at, text, JSON.stringify(data), workKey);
  return result.changes === 1;
}
export function hasWorkEntry(ctx: CrmCtx, workKey: string): boolean {
  return ctx.db.prepare('SELECT 1 FROM timeline WHERE workKey = ?').get(workKey) !== undefined;
}
