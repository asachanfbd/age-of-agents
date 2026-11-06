import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { readMeta, writeMeta } from './db.ts';
import { knowledgeDir, readText, versionOf } from './files.ts';
import { HISTORY_MAX } from './limits.ts';
import { pendingProposals } from './retroStore.ts';
import type { ProposalDto } from './retroStore.ts';
import { saveVersioned } from './versioned.ts';

export const STYLE_FILE = 'writing-style.md';
export const STYLE_SECTIONS = ['General', 'LinkedIn', 'Instagram', 'X', 'Facebook', 'Blog', 'Video script'] as const;

export const starterStyle = (): string => `# Writing style\n\n${STYLE_SECTIONS.map((s) => `## ${s}\n\n`).join('')}`;

export const styleFile = (ctx: ContentCtx): string => path.join(knowledgeDir(ctx.dir), STYLE_FILE);

export interface StyleView { content: string; version: string; changedAt: string | null; sections: readonly string[]; /** Pending retro proposals, newest first. */ proposals: ProposalDto[] }
export interface HistoryEntry { id: number; at: string; who: 'person' | 'agent' | 'retro'; summary: string; /** A retro change applied without review. */ autoApplied: boolean }

export async function readStyle(ctx: ContentCtx): Promise<StyleView> {
  const { content, changedAt } = await readText(styleFile(ctx));
  return { content, version: versionOf(content), changedAt, sections: STYLE_SECTIONS, proposals: pendingProposals(ctx) };
}

/** "+2 lines, -1 line" by comparing the two texts line by line, ignoring order. */
export function diffSummary(before: string, after: string): string {
  const count = (text: string) => { const m = new Map<string, number>(); for (const l of text.split('\n')) m.set(l, (m.get(l) ?? 0) + 1); return m; };
  const a = count(before), b = count(after);
  let added = 0, removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  if (!added && !removed) return 'No changes';
  const plural = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
  return [added && `+${plural(added)}`, removed && `-${plural(removed)}`].filter(Boolean).join(', ');
}

export const recordStyleHistory = (ctx: ContentCtx, who: HistoryEntry['who'], summary: string, autoApplied = false): void => {
  ctx.db.prepare('INSERT INTO style_history (at, who, summary, autoApplied) VALUES (?, ?, ?, ?)').run(ctx.now(), who, summary, autoApplied ? 1 : 0);
};

/**
 * An edit an agent made on disk since the last version the daemon recorded is logged as an agent entry, so the
 * history stays complete without watching the folder. Called with the file's content just before the daemon writes it.
 */
export function noteDiskEdit(ctx: ContentCtx, before: string): void {
  const recorded = readMeta(ctx.db, STYLE_VERSION_KEY);
  if (recorded !== undefined && recorded !== versionOf(before)) recordStyleHistory(ctx, 'agent', 'Edited on disk');
}

export const STYLE_VERSION_KEY = 'style_version';

/** Saves the writing style; an agent's edit on disk since the last save is logged before the person's own entry. */
export async function putStyle(ctx: ContentCtx, body: unknown): Promise<StyleView> {
  const before = (await readText(styleFile(ctx))).content;
  const saved = await saveVersioned(styleFile(ctx), (body ?? {}) as Record<string, unknown>);
  noteDiskEdit(ctx, before);
  recordStyleHistory(ctx, 'person', diffSummary(before, saved.content));
  writeMeta(ctx.db, STYLE_VERSION_KEY, saved.version);
  return { ...saved, sections: STYLE_SECTIONS, proposals: pendingProposals(ctx) };
}

/** The newest entries first. */
export function styleHistory(ctx: ContentCtx): HistoryEntry[] {
  const rows = ctx.db.prepare('SELECT * FROM style_history ORDER BY id DESC LIMIT ?').all(HISTORY_MAX) as Array<{ id: number; at: number; who: HistoryEntry['who']; summary: string; autoApplied: number }>;
  return rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), who: r.who, summary: r.summary, autoApplied: r.autoApplied === 1 }));
}
