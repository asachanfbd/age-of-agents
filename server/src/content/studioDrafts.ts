import type { ContentCtx } from './context.ts';
import { ContentInputError } from './errors.ts';
import { DRAFT_MAX_CHARS } from './limits.ts';
import { platformDraftProblem } from './platformLimits.ts';
import type { AssetKind, Platform } from './rules.ts';
import { scriptDraftProblem } from './scriptDraftRules.ts';
import { charCount } from './validate.ts';

export interface StudioDraft { id: number; round: number; text: string; savedAt: string }
interface DraftRow { id: number; assetId: string; round: number; text: string; savedAt: number }

const draftOf = (row: DraftRow): StudioDraft => ({ id: row.id, round: row.round, text: row.text, savedAt: new Date(row.savedAt).toISOString() });

/**
 * The trimmed text is what is stored. A post's text follows its platform's limits (`platformLimits.ts`), which replace
 * the general 1 to DRAFT_MAX_CHARS code points that a Concept-level asset (the script) keeps. A script must also be only
 * the spoken text (`scriptDraftRules.ts`).
 */
export function parseDraftText(value: unknown, platform: Platform | null = null, kind: AssetKind | null = null): string {
  if (typeof value !== 'string') throw new ContentInputError('text must be a string', 'text');
  const text = value.trim();
  if (!text) throw new ContentInputError('text must not be empty', 'text');
  const problem = platform ? platformDraftProblem(platform, text)
    : charCount(text) > DRAFT_MAX_CHARS ? `text must be at most ${DRAFT_MAX_CHARS} characters`
    : kind === 'script' ? scriptDraftProblem(text) : null;
  if (problem) throw new ContentInputError(problem, 'text');
  return text;
}

/** Every call keeps its own row, so a round's history stays; the newest row is the draft. */
export function insertDraft(ctx: ContentCtx, assetId: string, round: number, text: string): StudioDraft {
  const savedAt = ctx.now();
  const { lastInsertRowid } = ctx.db.prepare('INSERT INTO studio_drafts (assetId, round, text, savedAt) VALUES (?, ?, ?, ?)').run(assetId, round, text, savedAt);
  return draftOf({ id: Number(lastInsertRowid), assetId, round, text, savedAt });
}

export function latestDraft(ctx: ContentCtx, assetId: string, round: number): StudioDraft | null {
  const row = ctx.db.prepare('SELECT * FROM studio_drafts WHERE assetId = ? AND round = ? ORDER BY id DESC LIMIT 1').get(assetId, round) as DraftRow | undefined;
  return row ? draftOf(row) : null;
}

/** Every draft of the asset, oldest first. */
export function draftsOf(ctx: ContentCtx, assetId: string): StudioDraft[] {
  return (ctx.db.prepare('SELECT * FROM studio_drafts WHERE assetId = ? ORDER BY id').all(assetId) as DraftRow[]).map(draftOf);
}
