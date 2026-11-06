import { ApiError } from './serverApi';
import { TEXT_NAMES } from './contentRules';
import type { AssetKind, AssetState, Platform, PostStatus } from './contentRules';
import type { ConceptDto, FailedChangeDto } from './contentTypes';
import type { ImportedFilter } from './contentImport';
import type { OverallResult } from './contentTargets';

/** The wire value `empty` reads as "Not started" everywhere on screen. */
export const ASSET_STATE_LABELS: Record<AssetState, string> = { empty: 'Not started', drafting: 'Drafting', finalized: 'Finalized' };
export const assetStateLabel = (state: string): string => ASSET_STATE_LABELS[state as AssetState] ?? ASSET_STATE_LABELS.empty;

export const ASSET_STATE_DOT: Record<AssetState, string> = { empty: 'border border-muted-foreground bg-transparent', drafting: 'bg-warning', finalized: 'bg-success' };

export const STATUS_LABELS: Record<PostStatus, string> = { draft: 'Draft', finalized: 'Finalized', published: 'Published' };
export const STATUS_TONE: Record<PostStatus, string> = {
  draft: 'border-warning/50 bg-warning/20 text-warning-foreground',
  finalized: 'border-success/50 bg-success/15 text-success-foreground',
  published: 'border-info/50 bg-info/15 text-info-foreground',
};

/** What a colour added in the Knowledge tab starts as. */
export const NEW_COLOUR_HEX = '#000000';

export const FORMAT_LABELS: Record<string, string> = { text: 'Text', image: 'Image', carousel: 'Carousel', video: 'Video', reel: 'Reel', article: 'Article' };
export const formatLabel = (format: string): string => FORMAT_LABELS[format] ?? format;

/** What an asset is called for the post that needs it ("Caption" on Instagram, "Tweet" on X). */
export function assetLabel(kind: AssetKind, platform?: Platform): string {
  if (kind === 'post-text') return platform && platform !== 'blog' ? TEXT_NAMES[platform] : 'Post text';
  return { script: 'Script', video: 'Video', 'image-set': 'Images', article: 'Article', thumbnail: 'Thumbnail' }[kind];
}

export type ListSort = 'newest' | 'views';
export const LIST_SORT_LABELS: Record<ListSort, string> = { newest: 'Newest first', views: 'Most views' };
export interface ListFilters { status: '' | PostStatus; platform: '' | Platform; result: '' | OverallResult; imported: ImportedFilter; archived: boolean; search: string; sort: ListSort }
export const emptyFilters = (): ListFilters => ({ status: '', platform: '', result: '', imported: '', archived: false, search: '', sort: 'newest' });
export const LIST_PAGE_SIZE = 50;

/** The list request's query: empty filters are left out, search is trimmed. */
export function listParams(filters: ListFilters, offset = 0, limit = LIST_PAGE_SIZE): Record<string, string | number | boolean | undefined> {
  return { limit, offset: offset || undefined, status: filters.status, platform: filters.platform, result: filters.result, imported: filters.imported, archived: filters.archived, q: filters.search.trim(), ...(filters.sort === 'views' ? { sort: 'views' } : {}) };
}

/** Every control that changes data is disabled in a read-only Building; history and lists stay readable. */
export const controlsDisabled = (readOnly: boolean): boolean => readOnly;
export const READ_ONLY_TITLE = 'This Building is read-only';

/** The version the server holds now, when a save was refused because an agent changed the file. */
export function staleVersionOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const current = (error.details as { details?: { current?: unknown } }).details?.current;
  return typeof current === 'string' ? current : null;
}

/** The asset kinds a finalize refusal named, for the inline reason on the post's row. */
export function missingFrom(error: unknown): AssetKind[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const missing = (error.details as { details?: { missing?: unknown } }).details?.missing;
  return Array.isArray(missing) ? (missing as AssetKind[]) : null;
}

/** The changes a refused retro accept names (409 `details.failed`), or null for any other error. */
export function failedChangesFrom(error: unknown): FailedChangeDto[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const failed = (error.details as { details?: { failed?: unknown } }).details?.failed;
  return Array.isArray(failed) ? (failed as FailedChangeDto[]) : null;
}

export const missingMessage = (missing: AssetKind[], platform: Platform): string => `Not ready: ${missing.map((k) => assetLabel(k, platform)).join(', ')} not finalized`;

/** Editing state of one agent-editable document: what was opened, what is typed, and whether the server refused the save as stale. */
export interface DocState { version: string; saved: string; text: string; conflictVersion: string | null }
export const openDoc = (version: string, text: string): DocState => ({ version, saved: text, text, conflictVersion: null });
export const editDoc = (s: DocState, text: string): DocState => ({ ...s, text });
export const isDirty = (s: DocState): boolean => s.text !== s.saved;
/** A document written elsewhere reloads only when the open copy has no unsaved edits. */
export const shouldReloadDoc = (s: DocState | null): boolean => !s || !isDirty(s);
export const markConflict = (s: DocState, current: string): DocState => ({ ...s, conflictVersion: current });
/** Overwrite re-sends the typed text against the version the server holds now. */
export const overwriteVersion = (s: DocState): string => s.conflictVersion ?? s.version;
export const savedDoc = (s: DocState, version: string): DocState => ({ version, saved: s.text, text: s.text, conflictVersion: null });

/** The Writing skill file field as the daemon takes it: surrounding spaces dropped, empty meaning the default (null). */
export const skillFileValue = (text: string): string | null => text.trim() || null;

export type ConceptStatusLabel = 'Draft' | 'In progress' | 'Ready' | 'Published' | 'Archived';
export const CONCEPT_STATUS_VARIANT: Record<ConceptStatusLabel, 'secondary' | 'warning' | 'success'> = { Draft: 'secondary', 'In progress': 'warning', Ready: 'success', Published: 'success', Archived: 'secondary' };

/** Where a Concept stands, from its progress and posts: Archived, else Draft (no posts or nothing finalized), Ready (everything finalized) or In progress. An imported Concept has no drafting to measure, so it reads Published while a post is. */
export function conceptStatus(concept: Pick<ConceptDto, 'archived' | 'posts' | 'progress' | 'imported'>): ConceptStatusLabel {
  const { finalized, needed } = concept.progress;
  if (concept.archived) return 'Archived';
  if (concept.imported) return concept.posts.some((p) => p.status === 'published') ? 'Published' : 'Ready';
  if (concept.posts.length === 0 || finalized === 0) return 'Draft';
  return needed > 0 && finalized >= needed ? 'Ready' : 'In progress';
}

/** The header's facts after the status and creation date: the finalized-texts progress (left out when no text is needed) and the post count. An imported Concept shows no progress, and says when it has a script. */
export function conceptFactParts(concept: Pick<ConceptDto, 'posts' | 'progress' | 'imported' | 'assets'>): string[] {
  const { finalized, needed } = concept.progress;
  const count = concept.posts.length;
  const posts = `${count} ${count === 1 ? 'post' : 'posts'}`;
  if (concept.imported) return [posts, ...(concept.assets.some((a) => a.kind === 'script' && a.state === 'finalized') ? ['Script'] : [])];
  return [...(needed > 0 ? [`${finalized} of ${needed} texts finalized`] : []), posts];
}
/** The word before the creation date in the header. */
export const createdWord = (concept: Pick<ConceptDto, 'imported'>): string => (concept.imported ? 'Imported' : 'Created');
