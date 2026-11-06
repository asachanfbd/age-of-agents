/**
 * The Thumbnail tab's pure rules. The thumbnail asset's calls and files have the shape of an image set's, so the pane reads them through
 * `thumbnailAsImages` and reuses the Images tab's state, slot and preview rules. "Use this one" is local state: the pick travels as the
 * body of Finalize (`{ file }`), the server has no separate choose route.
 */
import type { ImageCallDto, ImageFileDto, ImagesPartDto } from './contentImages';
import { imagesState, shownRound } from './contentImages';
import type { ImagesState } from './contentImages';
import type { StudioViewDto } from './contentStudio';
import type { ConceptDto, PostDto } from './contentTypes';
import { reopenBlockReason } from './contentStats';

export const EMPTY_THUMBNAILS_TEXT = "No thumbnails yet. The agent's renders appear here.";
export const CHOOSE_THUMBNAIL_HINT = 'Choose a thumbnail to finalize.';
export const NO_THUMBNAIL_POST_TEXT = 'Add a video or reel post to use this tab';
export const THUMBNAIL_NOT_FINALIZED_HINT = 'No final thumbnail yet. Finalize it in the Thumbnail tab.';
export const THUMBNAIL_CONTEXT = 'Thumbnail for the video and reel posts';
const FALLBACK_RATIO = '16 / 9';

/** The pick: a file of one round, so a new round never inherits it. */
export interface ThumbnailChoice { round: number; name: string }

/**
 * The view with the thumbnail part read as an images part (rounds' `thumbnails` as `images`, no zip). The Images helpers used here read only
 * the rounds, setup, default size and Finalize reason; `platform`, `format` and `range` are unused placeholders. Null part, same view.
 */
export function thumbnailAsImages(view: StudioViewDto | null): StudioViewDto | null {
  const t = view?.thumbnail;
  if (!view || !t) return view;
  const images: ImagesPartDto = {
    setup: t.setup, blockedReason: t.blockedReason, platform: 'linkedin', format: 'video', defaultSize: t.defaultSize, range: { min: 1, max: 5 },
    stills: t.stills, rounds: t.rounds.map((r) => ({ round: r.round, call: r.call, images: r.thumbnails, zipUrl: null })), finalizeBlocked: t.finalizeBlocked,
  };
  return { ...view, images };
}

export const thumbnailState = (view: StudioViewDto | null): ImagesState => imagesState(view?.thumbnail ? thumbnailAsImages(view) : null);

/** The variants of the round the gallery shows. */
export const thumbnailVariants = (view: StudioViewDto): ImageFileDto[] => shownRound(thumbnailAsImages(view)!)?.images ?? [];

/** The picked file if it is still in the shown round; a lone variant is picked for the owner. */
export function effectiveChoice(choice: ThumbnailChoice | null, view: StudioViewDto | null): string | null {
  if (!view?.thumbnail || view.asset.state === 'finalized') return null;
  const variants = thumbnailVariants(view);
  const round = Math.max(view.asset.round, 1);
  if (choice && choice.round === round && variants.some((v) => v.name === choice.name)) return choice.name;
  return variants.length === 1 ? variants[0].name : null;
}

/** Why Finalize is disabled, or null: read-only, an ended session, the server's reason (a render still running ...), then the missing pick. */
export function thumbnailFinalizeHint(view: StudioViewDto, readOnly: boolean, readOnlyTitle: string, chosen: string | null): string | null {
  if (view.asset.state === 'finalized' || !view.thumbnail) return null;
  if (readOnly) return readOnlyTitle;
  if (view.session?.state === 'ended') return 'Resume the session to finalize.';
  return view.thumbnail.finalizeBlocked ?? (chosen ? null : CHOOSE_THUMBNAIL_HINT);
}

/** CSS `aspect-ratio` from the real size; 16 / 9 when the size is missing. */
export const tileRatio = (file: Pick<ImageFileDto, 'width' | 'height'>): string => (file.width > 0 && file.height > 0 ? `${file.width} / ${file.height}` : FALLBACK_RATIO);
/** "1280 × 720". */
export const sizeCaption = (file: Pick<ImageFileDto, 'width' | 'height'>): string => `${file.width} × ${file.height}`;

const variantsText = (n: number): string => `${n} ${n === 1 ? 'variant' : 'variants'}`;
/** "1280 × 720 · 3 variants"; the default size alone before anything is made. */
export function thumbnailSizeLine(view: StudioViewDto): string | null {
  const t = view.thumbnail;
  if (!t) return null;
  const variants = thumbnailVariants(view);
  const size = variants[0] ?? t.defaultSize;
  return variants.length ? `${sizeCaption(size)} · ${variantsText(variants.length)}` : sizeCaption(size);
}

/** "Rendering thumbnail 2 of 3…". */
export const renderingThumbnailText = (call: ImageCallDto): string => `Rendering thumbnail ${Math.min(call.done + 1, call.total)} of ${call.total}…`;

/** "The render failed: ... The thumbnails that were made stay." */
export const THUMBNAIL_FAILED_NOTE = 'The thumbnails that were made stay; the agent got this answer too.';

/** Runs one piece of work at a time: a call made while another is in flight is dropped (null), so a double-click sends one request. */
export function singleFlight(): <T>(work: () => Promise<T>) => Promise<T | null> {
  let running = false;
  return async (work) => {
    if (running) return null;
    running = true;
    try { return await work(); } finally { running = false; }
  };
}

// ---- the Concept ----------------------------------------------------------------------------------------

export const isVideoPost = (post: Pick<PostDto, 'format'>): boolean => post.format === 'video' || post.format === 'reel';
export const hasVideoPost = (concept: Pick<ConceptDto, 'posts'>): boolean => concept.posts.some(isVideoPost);
/** The Concept's thumbnail asset, or null when it has no video or reel post (the tab is off then). */
export const thumbnailAssetOf = (concept: Pick<ConceptDto, 'posts' | 'assets'>) => (hasVideoPost(concept) ? concept.assets.find((a) => a.kind === 'thumbnail') ?? null : null);
/** The Concept-level assets to list: the thumbnail only belongs to a Concept with a video or reel post. */
export const conceptAssets = (concept: Pick<ConceptDto, 'posts' | 'assets'>) => concept.assets.filter((a) => a.kind !== 'thumbnail' || hasVideoPost(concept));
/** Why Reopen is blocked: a published video or reel post uses the thumbnail. */
export const thumbnailReopenBlock = (concept: Pick<ConceptDto, 'posts'>, assetId: string): string | null => reopenBlockReason(concept, { id: assetId });

/**
 * Keeps the previous thumbnail part when nothing in it changed, so a terminal chunk or another asset's event does not redraw the gallery.
 * The part is small (a few rounds of at most 5 files), so comparing it whole is cheap enough.
 */
export function shareThumbnail<T>(previous: T | undefined, next: T): T {
  return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
