import type { SpeakingSpeedDto } from './contentScript';
import type { AssetKind, AssetState, Platform, PostStatus } from './contentRules';
import type { PostResult } from './contentTargets';

export interface AssetDto { id: string; kind: AssetKind; postId: string | null; state: AssetState; content: string | null; finalizedAt: string | null; round: number }
export interface PostDto {
  id: string; conceptId: string; platform: Platform; format: string; scheduledAt: string; status: PostStatus; note: string | null; createdAt: string;
  /** The assets the post needs, each with its state. */
  needs: AssetDto[];
  publishedAt: string | null;
  liveUrl: string | null;
  /** Only for a published post. */
  stats: StatsSummaryDto | null;
  /** Against the platform's targets; null while the post is not published. */
  result: PostResultDto | null;
  /** An imported post's free text about images or video kept elsewhere. */
  externalAssets?: string | null;
}
export interface ConceptDto {
  id: string; title: string; brief: string; archived: boolean; createdAt: string; updatedAt: string;
  /** Made outside the system: its posts are published directly and its content is read-only. */
  imported?: boolean;
  posts: PostDto[]; assets: AssetDto[]; progress: { finalized: number; needed: number };
  /** The Concept's Remotion composition once the Video tab has scaffolded it, else null. */
  compositionId: string | null;
}
/** A published post's result plus the engagement rate of its latest snapshot (server/src/content/results.ts). */
export interface PostResultDto extends PostResult { engagementRate: number | null }
/** Per platform, over every published post of the matching Concepts: judged posts are those with a result other than too early or no target. */
export interface PlatformResultSummaryDto { platform: Platform; judged: number; onTarget: number; tooEarly: number; noTarget: number }
export interface ConceptPageDto { rows: ConceptDto[]; total: number; limit: number; offset: number; hasMore: boolean; summary: PlatformResultSummaryDto[] }
export interface CalendarPostDto extends PostDto { conceptTitle: string }
export interface CalendarDto { month: string; timezone: string; posts: CalendarPostDto[] }
export interface ContentSettingsDto { name: string; timezone: string; folder: string; writingSkillFile: string | null; defaultWritingSkillFile: string; autoApplyRetro: boolean; evaluationDays: number; speakingSpeed: SpeakingSpeedDto }
export interface SectionMetaDto { id: string; name: string; builtin: boolean; file: string; version: string; changedAt: string | null }
export interface SectionDto extends SectionMetaDto { content: string }
export interface BrandFileDto { name: string; size: number; changedAt: string; image: boolean }
export interface ColourDto { name: string; hex: string }
export interface StyleDto { content: string; version: string; changedAt: string | null; sections: string[]; /** Pending retro proposals, newest first. */ proposals: ProposalDto[] }
export interface StyleHistoryDto { id: number; at: string; who: 'person' | 'agent' | 'retro'; summary: string; autoApplied: boolean }

/** One change a writing-style retro proposes (mirrors server/src/content/retroRules.ts). */
export interface StyleChangeDto { id: number; section: string; action: 'add' | 'replace' | 'remove'; find?: string; text?: string; reason: string }
export interface RetroSourceDto { /** `imported`: "Learn from this" on an imported Concept. */ kind?: 'asset' | 'imported'; conceptId: string; conceptTitle: string; assetId: string; assetKind: AssetKind; platform: Platform | null; format: string | null }
export interface ProposalDto { id: string; at: string; summary: string; source: RetroSourceDto; draftCount: number; roundCount: number; changes: StyleChangeDto[]; autoApplyError: string | null }
export interface RetroLogEntryDto { id: string; at: string; status: 'failed' | 'nothing' | 'skipped'; reason: string | null; source: RetroSourceDto; draftCount: number; roundCount: number }
/** A change an accept refused because the writing style changed since the proposal was made. */
export interface FailedChangeDto { id: number; section: string; action: StyleChangeDto['action']; reason: string }
export interface AcceptBody { exclude?: number[]; changes?: Array<{ id: number; find?: string; text?: string }> }
export interface NewPostInput { platform: Platform; format: string; scheduledAt: string }
export type StatField = 'impressions' | 'reach' | 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'linkClicks' | 'profileVisits' | 'followersGained';
export type StatCountsDto = Record<StatField, number | null>;
export interface StatSourceDto { id: string; kind: 'image' | 'text'; name: string; size: number; contentType: string }
export interface StatDto { id: string; capturedAt: string; enteredAt: string; counts: StatCountsDto; watchTime: number | null; note: string; sources: StatSourceDto[] }
export interface StatsSummaryDto { count: number; latest: StatDto | null; delta: StatCountsDto | null }
export interface PostMediaDto {
  text: string | null; images: Array<{ index: number; name: string; missing: boolean }> | null; video: { name: string; missing: boolean } | null;
  /** Video and reel posts only, once the thumbnail is finalized. */
  thumbnail: { name: string; missing: boolean } | null;
}
export interface StatInput { capturedAt: string; counts: Partial<Record<StatField, number | null>>; watchTime?: number | null; note?: string; extractionId?: string }
export type ExtractionReplyDto = { ok: true; extractionId: string; counts: Partial<StatCountsDto>; capturedAt: string | null; unused: string[] } | { ok: false; reason: string };

export type TargetsDto = import('./contentTargets').Targets;
export interface TargetsResponseDto { targets: Record<Platform, TargetsDto>; evaluationDays: number }
export interface TargetHistoryDto { id: number; at: string; who: 'person'; platform: Platform; before: TargetsDto; after: TargetsDto }
export type InsightsState = 'never-run' | 'ready' | 'running' | 'failed';
export interface InsightsDto {
  state: InsightsState; markdown: string; notes: string; notesVersion: string;
  lastError: { reason: string; at: string } | null; updatedAt: string | null; postCount: number | null; nextRefreshAt: string | null;
}
export interface InsightsVersionDto { id: number; at: string; trigger: 'stats' | 'targets' | 'manual'; markdown: string; postCount: number }
