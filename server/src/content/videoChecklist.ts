import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentInputError, ContentNotFoundError } from './errors.ts';
import { CHECKLIST_DETAIL_MAX, CHECKLIST_ID_MAX, CHECKLIST_ITEMS_MAX, CHECKLIST_LABEL_MAX } from './limits.ts';
import type { MediaItem } from './videoMedia.ts';
import { charCount } from './validate.ts';

/**
 * The asset checklist of a video round: the agent publishes it with `set_checklist`, the owner ticks each item (provided, or not
 * needed) and may link media files, and Confirm locks it and tells the agent what it has. Rows are per round, so a new round
 * starts empty.
 */

export interface ChecklistInput { id: string; label: string; detail: string | null }
export interface ChecklistItem extends ChecklistInput { ticked: boolean; mediaIds: string[] }
export interface Checklist { round: number; items: ChecklistItem[]; confirmedAt: string | null }

const ITEM_ID = new RegExp(`^[a-z0-9-]{1,${CHECKLIST_ID_MAX}}$`);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** 1 to 30 items with unique ids; single-line labels, so the confirm message typed into the terminal stays one line. */
export function parseChecklist(value: unknown): ChecklistInput[] {
  if (!Array.isArray(value)) throw new ContentInputError('items must be a list', 'items');
  if (value.length < 1 || value.length > CHECKLIST_ITEMS_MAX) throw new ContentInputError(`items must have 1 to ${CHECKLIST_ITEMS_MAX} entries`, 'items');
  const seen = new Set<string>();
  return value.map((raw, i): ChecklistInput => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ContentInputError(`items[${i}] must be an object`, 'items');
    const { id, label, detail } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !ITEM_ID.test(id)) throw new ContentInputError(`items[${i}].id must be 1 to ${CHECKLIST_ID_MAX} characters of a-z, 0-9 and -`, 'items');
    if (seen.has(id)) throw new ContentInputError(`items[${i}].id "${id}" is used twice`, 'items');
    seen.add(id);
    if (typeof label !== 'string' || !label.trim() || charCount(label.trim()) > CHECKLIST_LABEL_MAX || CONTROL.test(label)) {
      throw new ContentInputError(`items[${i}].label must be one line of 1 to ${CHECKLIST_LABEL_MAX} characters`, 'items');
    }
    if (detail !== undefined && detail !== null && (typeof detail !== 'string' || charCount(detail) > CHECKLIST_DETAIL_MAX)) {
      throw new ContentInputError(`items[${i}].detail must be at most ${CHECKLIST_DETAIL_MAX} characters`, 'items');
    }
    return { id, label: label.trim(), detail: typeof detail === 'string' && detail.trim() ? detail.trim() : null };
  });
}

/** The new list in its own order; an id that stays keeps its tick and links, a new id starts unticked. */
export function replaceChecklist(previous: ChecklistItem[], next: ChecklistInput[]): ChecklistItem[] {
  return next.map((item) => {
    const kept = previous.find((p) => p.id === item.id);
    return { ...item, ticked: kept?.ticked ?? false, mediaIds: kept?.mediaIds ?? [] };
  });
}

// ---- the confirm message --------------------------------------------------------------------------

/** "0:48", "2:14", "1:00:05": whole seconds, rounded. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const fileLine = (m: Pick<MediaItem, 'name' | 'kind' | 'durationMs' | 'size'>): string =>
  `${m.name} (${m.kind}, ${m.kind !== 'image' && m.durationMs !== null ? formatDuration(m.durationMs) : formatSize(m.size)})`;

/**
 * What Confirm types into the agent's terminal, as if the owner wrote it: the media folder relative to the Remotion project, every
 * file, and every checklist item with its linked files. One line, pasted whole before Enter is pressed (see `typeIntoSession`).
 */
export function confirmMessage(mediaFolder: string, media: Pick<MediaItem, 'id' | 'name' | 'kind' | 'durationMs' | 'size'>[], items: ChecklistItem[]): string {
  const files = media.length ? media.map(fileLine).join('; ') : 'none';
  const nameOf = (id: string) => media.find((m) => m.id === id)?.name;
  const checklist = items.map((item) => {
    const names = item.mediaIds.map(nameOf).filter((n): n is string => !!n);
    return `${item.label} → ${names.length ? names.join(', ') : '(no file linked)'}`;
  }).join('; ');
  return `All assets are provided. Media folder: ${mediaFolder}. Files: ${files}. Checklist: ${checklist}. Start building the video.`.replace(/[\r\n]+/g, ' ');
}

// ---- storage ----------------------------------------------------------------------------------------

interface ItemRow { itemId: string; label: string; detail: string | null; ticked: number; mediaIds: string }
interface RoundRow { confirmedAt: number | null; scriptChanged: number }

export function readChecklist(ctx: ContentCtx, assetId: string, round: number): Checklist {
  const rows = ctx.db.prepare('SELECT * FROM video_checklist_items WHERE assetId = ? AND round = ? ORDER BY position').all(assetId, round) as ItemRow[];
  const meta = roundRow(ctx, assetId, round);
  return {
    round,
    items: rows.map((r) => ({ id: r.itemId, label: r.label, detail: r.detail, ticked: r.ticked === 1, mediaIds: JSON.parse(r.mediaIds) as string[] })),
    confirmedAt: meta?.confirmedAt ? new Date(meta.confirmedAt).toISOString() : null,
  };
}

const roundRow = (ctx: ContentCtx, assetId: string, round: number): RoundRow | undefined =>
  ctx.db.prepare('SELECT confirmedAt, scriptChanged FROM video_rounds WHERE assetId = ? AND round = ?').get(assetId, round) as RoundRow | undefined;

function ensureRound(ctx: ContentCtx, assetId: string, round: number): void {
  ctx.db.prepare('INSERT OR IGNORE INTO video_rounds (assetId, round) VALUES (?, ?)').run(assetId, round);
}

export const isConfirmed = (ctx: ContentCtx, assetId: string, round: number): boolean => !!roundRow(ctx, assetId, round)?.confirmedAt;

export function writeChecklist(ctx: ContentCtx, assetId: string, round: number, items: ChecklistItem[]): void {
  ctx.db.transaction(() => {
    ensureRound(ctx, assetId, round);
    ctx.db.prepare('DELETE FROM video_checklist_items WHERE assetId = ? AND round = ?').run(assetId, round);
    const insert = ctx.db.prepare('INSERT INTO video_checklist_items (assetId, round, itemId, position, label, detail, ticked, mediaIds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    items.forEach((item, i) => insert.run(assetId, round, item.id, i, item.label, item.detail, item.ticked ? 1 : 0, JSON.stringify(item.mediaIds)));
  })();
}

/** The agent's `set_checklist`: replaces the round's list (keeping ticks of ids that stay) until it is confirmed. */
export function setChecklist(ctx: ContentCtx, assetId: string, round: number, rawItems: unknown): Checklist {
  if (isConfirmed(ctx, assetId, round)) throw new ContentConflictError('Checklist is confirmed');
  const items = parseChecklist(rawItems);
  writeChecklist(ctx, assetId, round, replaceChecklist(readChecklist(ctx, assetId, round).items, items));
  return readChecklist(ctx, assetId, round);
}

/** The owner ticks or unticks an item, or changes its linked media (each id must be one of the Concept's files). */
export function patchChecklistItem(ctx: ContentCtx, assetId: string, round: number, itemId: string, body: unknown, conceptMediaIds: string[]): Checklist {
  const b = (body ?? {}) as { ticked?: unknown; mediaIds?: unknown };
  if (b.ticked !== undefined && typeof b.ticked !== 'boolean') throw new ContentInputError('ticked must be true or false', 'ticked');
  let mediaIds: string[] | undefined;
  if (b.mediaIds !== undefined) {
    if (!Array.isArray(b.mediaIds) || !b.mediaIds.every((id) => typeof id === 'string' && conceptMediaIds.includes(id))) {
      throw new ContentInputError('mediaIds must list media files of this Concept', 'mediaIds');
    }
    mediaIds = [...new Set(b.mediaIds as string[])];
  }
  const list = readChecklist(ctx, assetId, round);
  const item = list.items.find((i) => i.id === itemId);
  if (!item) throw new ContentNotFoundError('That checklist item does not exist');
  if (list.confirmedAt) throw new ContentConflictError('Checklist is confirmed');
  ctx.db.prepare('UPDATE video_checklist_items SET ticked = ?, mediaIds = ? WHERE assetId = ? AND round = ? AND itemId = ?')
    .run((b.ticked ?? item.ticked) ? 1 : 0, JSON.stringify(mediaIds ?? item.mediaIds), assetId, round, itemId);
  return readChecklist(ctx, assetId, round);
}

/** Why Confirm cannot run yet, or null when every item is ticked and the list is not confirmed. */
export function confirmBlocker(list: Checklist): string | null {
  if (list.confirmedAt) return 'The checklist is already confirmed';
  if (!list.items.length) return 'The agent has not published a checklist yet';
  const left = list.items.filter((i) => !i.ticked).length;
  return left ? `Tick every item to confirm (${left} left)` : null;
}

export function markConfirmed(ctx: ContentCtx, assetId: string, round: number): void {
  ensureRound(ctx, assetId, round);
  ctx.db.prepare('UPDATE video_rounds SET confirmedAt = ? WHERE assetId = ? AND round = ?').run(ctx.now(), assetId, round);
}

export const scriptChanged = (ctx: ContentCtx, assetId: string, round: number): boolean => roundRow(ctx, assetId, round)?.scriptChanged === 1;

export function markScriptChanged(ctx: ContentCtx, assetId: string, round: number): void {
  ensureRound(ctx, assetId, round);
  ctx.db.prepare('UPDATE video_rounds SET scriptChanged = 1 WHERE assetId = ? AND round = ?').run(assetId, round);
}
