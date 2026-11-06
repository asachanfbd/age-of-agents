import type { ContentCtx } from './context.ts';
import { RETRO_LOG_MAX } from './limits.ts';
import type { StyleChange } from './retroRules.ts';
import type { AssetKind, Platform } from './rules.ts';

/**
 * The retro's rows: one `retros` row per finished retro and one `style_proposals` row for each retro that proposed
 * changes. A retro that is still running is not stored (see `retros.ts`).
 */

/** `proposal` waits for the owner; `applied` and `discarded` are what the owner (or auto-apply) did with it. */
export type RetroStatus = 'proposal' | 'applied' | 'discarded' | 'nothing' | 'skipped' | 'failed';
export type ProposalState = 'pending' | 'applied' | 'discarded';
/** Statuses the retro log lists: retros that made no proposal. */
export const LOGGED_STATUSES: readonly RetroStatus[] = ['failed', 'nothing', 'skipped'];

/** `imported`: "Learn from this" on an imported Concept, stored on its script asset but reading all of its text. */
export type RetroSourceKind = 'asset' | 'imported';
export interface RetroSource { kind: RetroSourceKind; conceptId: string; conceptTitle: string; assetId: string; assetKind: AssetKind; platform: Platform | null; format: string | null }
export interface ProposalDto {
  id: string; at: string; summary: string; source: RetroSource; draftCount: number; roundCount: number; changes: StyleChange[];
  /** Why auto-apply refused it, so it waits for the owner. */
  autoApplyError: string | null;
}
export interface RetroLogEntry { id: string; at: string; status: RetroStatus; reason: string | null; source: RetroSource; draftCount: number; roundCount: number }
/** An asset's last retro, as its finalized view shows it. */
export interface RetroStatusView { status: RetroStatus | 'running'; reason?: string; proposalId?: string; changeCount?: number; at: string }

export interface RetroRecord { id: string; assetId: string; conceptId: string; status: RetroStatus; reason: string | null; draftCount: number; roundCount: number; sourceKind: RetroSourceKind }
export interface ProposalRow { id: string; retroId: string; assetId: string; at: number; summary: string; styleVersion: string; changes: string; state: ProposalState; autoApplyError: string | null }

interface SourceColumns { sourceKind: RetroSourceKind; conceptId: string; title: string; assetId: string; kind: AssetKind; platform: Platform | null; format: string | null }
const SOURCE_JOIN = 'JOIN assets a ON a.id = r.assetId JOIN concepts c ON c.id = a.conceptId LEFT JOIN posts p ON p.id = a.postId';
const SOURCE_COLUMNS = 'r.sourceKind AS sourceKind, a.conceptId AS conceptId, c.title AS title, a.id AS assetId, a.kind AS kind, p.platform AS platform, p.format AS format';
const sourceOf = (r: SourceColumns): RetroSource => ({ kind: r.sourceKind, conceptId: r.conceptId, conceptTitle: r.title, assetId: r.assetId, assetKind: r.kind, platform: r.platform ?? null, format: r.format ?? null });
const iso = (ms: number) => new Date(ms).toISOString();

export function insertRetro(ctx: ContentCtx, r: RetroRecord): void {
  ctx.db.prepare('INSERT INTO retros (id, assetId, conceptId, at, status, reason, draftCount, roundCount, sourceKind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.id, r.assetId, r.conceptId, ctx.now(), r.status, r.reason, r.draftCount, r.roundCount, r.sourceKind);
}

export function insertProposal(ctx: ContentCtx, p: { id: string; retroId: string; assetId: string; summary: string; styleVersion: string; changes: StyleChange[] }): void {
  ctx.db.prepare('INSERT INTO style_proposals (id, retroId, assetId, at, summary, styleVersion, changes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, p.retroId, p.assetId, ctx.now(), p.summary, p.styleVersion, JSON.stringify(p.changes));
}

export const proposalRow = (ctx: ContentCtx, id: string): ProposalRow | undefined =>
  ctx.db.prepare('SELECT * FROM style_proposals WHERE id = ?').get(id) as ProposalRow | undefined;

export const changesOf = (row: Pick<ProposalRow, 'changes'>): StyleChange[] => JSON.parse(row.changes) as StyleChange[];

/** Moves a proposal on and its retro with it, so the asset's last retro reads "applied" or "discarded". */
export function settleProposal(ctx: ContentCtx, row: ProposalRow, state: Exclude<ProposalState, 'pending'>): void {
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE style_proposals SET state = ? WHERE id = ?').run(state, row.id);
    ctx.db.prepare('UPDATE retros SET status = ? WHERE id = ?').run(state, row.retroId);
  })();
}

export function setAutoApplyError(ctx: ContentCtx, id: string, error: string): void {
  ctx.db.prepare('UPDATE style_proposals SET autoApplyError = ? WHERE id = ?').run(error, id);
}

/** Every pending proposal, newest first. */
export function pendingProposals(ctx: ContentCtx): ProposalDto[] {
  const rows = ctx.db.prepare(`SELECT sp.*, r.draftCount, r.roundCount, ${SOURCE_COLUMNS} FROM style_proposals sp JOIN retros r ON r.id = sp.retroId ${SOURCE_JOIN}
    WHERE sp.state = 'pending' ORDER BY sp.at DESC, sp.rowid DESC`).all() as Array<ProposalRow & SourceColumns & { draftCount: number; roundCount: number }>;
  return rows.map((r) => ({
    id: r.id, at: iso(r.at), summary: r.summary, source: sourceOf(r), draftCount: r.draftCount, roundCount: r.roundCount, changes: changesOf(r), autoApplyError: r.autoApplyError,
  }));
}

/** The newest failed and "Nothing to learn" retros, newest first. */
export function retroLog(ctx: ContentCtx): RetroLogEntry[] {
  const marks = LOGGED_STATUSES.map(() => '?').join(',');
  const rows = ctx.db.prepare(`SELECT r.id AS id, r.at AS at, r.status AS status, r.reason AS reason, r.draftCount AS draftCount, r.roundCount AS roundCount, ${SOURCE_COLUMNS}
    FROM retros r ${SOURCE_JOIN} WHERE r.status IN (${marks}) ORDER BY r.at DESC, r.rowid DESC LIMIT ?`).all(...LOGGED_STATUSES, RETRO_LOG_MAX) as Array<SourceColumns & { id: string; at: number; status: RetroStatus; reason: string | null; draftCount: number; roundCount: number }>;
  return rows.map((r) => ({ id: r.id, at: iso(r.at), status: r.status, reason: r.reason, source: sourceOf(r), draftCount: r.draftCount, roundCount: r.roundCount }));
}

/** The asset's newest finished retro, or null when it never had one. */
export function lastRetro(ctx: ContentCtx, assetId: string): RetroStatusView | null {
  const row = ctx.db.prepare(`SELECT r.at AS at, r.status AS status, r.reason AS reason, sp.id AS proposalId, sp.changes AS changes FROM retros r
    LEFT JOIN style_proposals sp ON sp.retroId = r.id WHERE r.assetId = ? ORDER BY r.at DESC, r.rowid DESC LIMIT 1`).get(assetId) as
    { at: number; status: RetroStatus; reason: string | null; proposalId: string | null; changes: string | null } | undefined;
  if (!row) return null;
  return {
    status: row.status, at: iso(row.at),
    ...(row.reason !== null && { reason: row.reason }),
    ...(row.proposalId !== null && { proposalId: row.proposalId, changeCount: changesOf({ changes: row.changes! }).length }),
  };
}
