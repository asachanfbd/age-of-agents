import type { ContentCtx } from './context.ts';
import type { StatCounts } from './stats.ts';
import { emptyCounts, statsDelta } from './stats.ts';

export type SourceKind = 'image' | 'text';
/** Evidence kept with a saved snapshot: the pasted text or a screenshot, stored as `<id>` plus the extension under the snapshot's folder. */
export interface SourceMeta { id: string; kind: SourceKind; name: string; size: number; contentType: string; file: string }
export type SourceView = Omit<SourceMeta, 'file'>;

export interface StatRow { id: string; postId: string; capturedAt: number; enteredAt: number; counts: string; watchTime: number | null; note: string; sources: string; seq: number }
export interface StatView { id: string; capturedAt: string; enteredAt: string; counts: StatCounts; watchTime: number | null; note: string; sources: SourceView[] }
export interface StatsSummary { count: number; latest: StatView | null; delta: StatCounts | null }

const iso = (ms: number): string => new Date(ms).toISOString();
const SELECT = 'SELECT *, rowid AS seq FROM post_stats';
const ORDER = 'ORDER BY capturedAt DESC, enteredAt DESC, rowid DESC';

export const sourcesOf = (row: StatRow): SourceMeta[] => JSON.parse(row.sources) as SourceMeta[];
export const countsOf = (row: StatRow): StatCounts => ({ ...emptyCounts(), ...(JSON.parse(row.counts) as Partial<StatCounts>) });

export function statView(row: StatRow): StatView {
  return {
    id: row.id, capturedAt: iso(row.capturedAt), enteredAt: iso(row.enteredAt), counts: countsOf(row), watchTime: row.watchTime, note: row.note,
    sources: sourcesOf(row).map(({ file: _file, ...rest }) => rest),
  };
}

/** A post's snapshots, newest captured first. */
export function statRows(ctx: ContentCtx, postId: string): StatRow[] {
  return ctx.db.prepare(`${SELECT} WHERE postId = ? ${ORDER}`).all(postId) as StatRow[];
}

export function statRow(ctx: ContentCtx, postId: string, statId: string): StatRow | undefined {
  return ctx.db.prepare(`${SELECT} WHERE id = ? AND postId = ?`).get(statId, postId) as StatRow | undefined;
}

/** Each post's snapshots, newest captured first. */
export function statRowsByPost(ctx: ContentCtx, postIds: string[]): Map<string, StatRow[]> {
  const byPost = new Map<string, StatRow[]>();
  if (!postIds.length) return byPost;
  const rows = ctx.db.prepare(`${SELECT} WHERE postId IN (${postIds.map(() => '?').join(',')}) ${ORDER}`).all(...postIds) as StatRow[];
  for (const row of rows) byPost.set(row.postId, [...(byPost.get(row.postId) ?? []), row]);
  return byPost;
}

/** The latest snapshot of each post with the change since the one before it, for the post and Concept views. */
export function statSummaries(ctx: ContentCtx, postIds: string[], byPost: Map<string, StatRow[]> = statRowsByPost(ctx, postIds)): Map<string, StatsSummary> {
  const out = new Map<string, StatsSummary>();
  for (const [postId, list] of byPost) {
    const latest = countsOf(list[0]!);
    out.set(postId, { count: list.length, latest: statView(list[0]!), delta: statsDelta(latest, list[1] ? countsOf(list[1]) : null) });
  }
  return out;
}

export const earliestCapture = (ctx: ContentCtx, postId: string): number | null =>
  (ctx.db.prepare('SELECT MIN(capturedAt) AS at FROM post_stats WHERE postId = ?').get(postId) as { at: number | null }).at;
