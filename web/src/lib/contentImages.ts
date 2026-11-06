/**
 * The Content Studio Images tab: what the daemon sends (mirrors server/src/content/imageStudio.ts), the size table (duplicated from
 * server/src/content/imageRules.ts and pinned by tests/fixtures/contentImageCases.json), and the pure rules the gallery, the preview
 * and the post switcher are drawn from. Finalize's reason comes from the daemon (`finalizeBlocked`), which owns the count rule.
 */
import type { SetupDto } from './contentVideo';
import type { StudioViewDto } from './contentStudio';
import type { AssetState, Platform } from './contentRules';
import type { AssetDto, PostDto } from './contentTypes';
import { PLATFORM_LABELS } from './contentRules';
import { assetStateLabel, formatLabel } from './contentView';
import type { PostChipModel } from './contentPostTabs';

export type ImageCallStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';
export interface ImageCallDto {
  id: string; status: ImageCallStatus; compositionIds: string[]; width: number; height: number; done: number; total: number; error: string | null;
  queuePosition: number | null; waitingFor: { conceptTitle: string; kind: 'video' | 'images' | 'thumbnail' } | null; createdAt: string; finishedAt: string | null;
}
export interface ImageFileDto { index: number; name: string; compositionId: string | null; width: number; height: number; size: number; url: string; downloadUrl: string }
export interface ImageRoundDto { round: number; call: ImageCallDto; images: ImageFileDto[]; zipUrl: string | null }
export interface ImageSize { width: number; height: number }
export interface ImagesPartDto {
  setup: SetupDto; blockedReason: string | null; platform: Platform; format: string; defaultSize: ImageSize; range: { min: number; max: number };
  stills: string[]; rounds: ImageRoundDto[]; finalizeBlocked: string | null;
}
/** The Thumbnail tab's part (mirrors server/src/content/thumbnailStudio.ts): its calls are image calls of 1 to 5 stills; `final` is the owner's pick once finalized. */
export interface ThumbnailRoundDto { round: number; call: ImageCallDto; thumbnails: ImageFileDto[] }
export interface ThumbnailPartDto {
  setup: SetupDto; blockedReason: string | null; defaultSize: ImageSize; stills: string[]; rounds: ThumbnailRoundDto[]; finalizeBlocked: string | null;
  final: { round: number; name: string; url: string; downloadUrl: string } | null;
}

// ---- sizes and the count range (server/src/content/imageRules.ts, rules.ts) ----------------------------

export const IMAGE_SIZES: Partial<Record<Platform, Partial<Record<string, ImageSize>>>> = {
  instagram: { image: { width: 1080, height: 1350 }, carousel: { width: 1080, height: 1350 } },
  linkedin: { image: { width: 1200, height: 1200 }, carousel: { width: 1080, height: 1350 } },
  x: { image: { width: 1600, height: 900 } },
  facebook: { image: { width: 1200, height: 1200 }, carousel: { width: 1080, height: 1080 } },
};
export const defaultImageSize = (platform: Platform, format: string): ImageSize | null => IMAGE_SIZES[platform]?.[format] ?? null;

/** How many images a post's set holds (server rules.ts `imageRange`). */
export function imageRange(platform: Platform, format: string): { min: number; max: number } | null {
  if (format === 'image') return platform === 'x' ? { min: 1, max: 4 } : { min: 1, max: 1 };
  if (format === 'carousel') return { min: 2, max: platform === 'facebook' ? 10 : 20 };
  return null;
}

const SHORT_NAMES: Record<Platform, string> = { linkedin: 'LinkedIn', instagram: 'Instagram', x: 'X', facebook: 'Facebook', blog: 'Blog' };
const countText = (r: { min: number; max: number }): string => (r.min === r.max ? `${r.min} ${r.min === 1 ? 'image' : 'images'}` : `${r.min} to ${r.max} images`);

// ---- the pane ------------------------------------------------------------------------------------------

/** The round the gallery shows: the asset's current round (the finalized one once finalized). */
export const shownRound = (view: StudioViewDto): ImageRoundDto | null => view.images?.rounds.find((r) => r.round === Math.max(view.asset.round, 1)) ?? null;

/** Earlier rounds that kept images, newest first. */
export const previousImageRounds = (view: StudioViewDto): ImageRoundDto[] =>
  (view.images?.rounds ?? []).filter((r) => r.round < Math.max(view.asset.round, 1) && r.images.length > 0).sort((a, b) => b.round - a.round);

export type ImagesState = 'loading' | 'setup' | 'setupfail' | 'empty' | 'rendering' | 'queued' | 'failed' | 'stopped' | 'rendered' | 'finalized';

export function imagesState(view: StudioViewDto | null): ImagesState {
  if (!view?.images) return 'loading';
  if (view.asset.state === 'finalized') return 'finalized';
  if (!view.session && view.images.setup.status === 'running') return 'setup';
  if (!view.session && view.images.setup.status === 'failed') return 'setupfail';
  const call = shownRound(view)?.call;
  if (!call) return 'empty';
  return call.status === 'done' ? 'rendered' : call.status === 'running' ? 'rendering' : call.status;
}

/** Why Finalize is disabled, or null: read-only and an ended session here, then the server's own reason (the count rule over the round's newest call and its files). */
export function imagesFinalizeHint(view: StudioViewDto, readOnly: boolean, readOnlyTitle: string): string | null {
  if (view.asset.state === 'finalized' || !view.images) return null;
  if (readOnly) return readOnlyTitle;
  if (view.session?.state === 'ended') return 'Resume the session to finalize.';
  return view.images.finalizeBlocked;
}

const plural = (n: number): string => `${n} ${n === 1 ? 'image' : 'images'}`;

/** "7 images · 1080 × 1350 px · Instagram carousel default", or "Custom size"; while rendering "7 images requested", after a failure "4 of 7 images". */
export function sizeLine(view: StudioViewDto): string | null {
  const images = view.images;
  const round = shownRound(view);
  if (!images || !round?.call) return null;
  const { call } = round;
  const count = call.status === 'done' ? plural(round.images.length)
    : call.status === 'running' || call.status === 'queued' ? `${plural(call.total)} requested` : `${round.images.length} of ${plural(call.total)}`;
  const fits = call.width === images.defaultSize.width && call.height === images.defaultSize.height;
  const kind = fits ? `${SHORT_NAMES[images.platform]} ${images.format} default` : 'Custom size';
  return `${count} · ${call.width} × ${call.height} px · ${kind}`;
}

export type SlotKind = 'done' | 'rendering' | 'waiting' | 'missing';
export interface GallerySlot { index: number; kind: SlotKind; image: ImageFileDto | null }

/** The tiles of a round: finished images, then while running one "Rendering…" and the rest waiting; after a failure the rest "Not made". */
export function gallerySlots(round: ImageRoundDto | null): GallerySlot[] {
  if (!round?.call) return (round?.images ?? []).map((image) => ({ index: image.index, kind: 'done', image }));
  const { call } = round;
  const total = call.status === 'done' ? round.images.length : Math.max(call.total, round.images.length);
  return Array.from({ length: total }, (_, i) => {
    const index = i + 1;
    const image = round.images.find((x) => x.index === index) ?? null;
    if (image) return { index, kind: 'done', image };
    if (call.status === 'running' && index === round.images.length + 1) return { index, kind: 'rendering', image: null };
    return { index, kind: call.status === 'running' || call.status === 'queued' ? 'waiting' : 'missing', image: null };
  });
}

/** "Rendering image 4 of 7". */
export const renderingText = (call: ImageCallDto): string => `Rendering image ${Math.min(call.done + 1, call.total)} of ${call.total}`;
/** "3 of 7 done · still-…-slide-04". */
export const renderingDetail = (call: ImageCallDto): string => `${call.done} of ${call.total} done${call.compositionIds[call.done] ? ` · ${call.compositionIds[call.done]}` : ''}`;
export function queuedImagesText(call: ImageCallDto): string {
  const what = { images: 'an image render', thumbnail: 'a thumbnail render', video: 'a video render' }[call.waitingFor?.kind ?? 'video'];
  const concept = call.waitingFor ? ` (Concept "${call.waitingFor.conceptTitle}")` : '';
  return `Image render is queued. Waiting for ${what} in this Building to finish${concept}. One render runs at a time.`;
}
/** The red alert of a failed or stopped call; the error already names the image. */
export const failedText = (call: ImageCallDto, noun = 'image'): string => (call.status === 'stopped' ? `The render was stopped after ${call.done} ${call.done === 1 ? noun : `${noun}s`}.` : `The render failed: ${call.error ?? 'unknown error'}.`);

export const EMPTY_IMAGES_TEXT = 'No images yet. Tell the agent what you want.';
export const NO_IMAGE_POSTS_TEXT = 'No image or carousel posts in this Concept';
export const NO_ALT_TEXT = 'No alt text';

/** "3 · 1080 × 1350". */
export const tileCaption = (image: Pick<ImageFileDto, 'index' | 'width' | 'height'>): string => `${image.index} · ${image.width} × ${image.height}`;

// ---- alt text --------------------------------------------------------------------------------------------

/** The round's alt text lines (its newest `save_draft`), one per image; lines past the last image are not shown on tiles. */
export function altLines(view: StudioViewDto, round = Math.max(view.asset.round, 1)): string[] {
  const text = view.rounds.find((r) => r.round === round)?.draft?.text ?? '';
  return text ? text.split('\n') : [];
}
export const altFor = (lines: string[], index: number): string | null => lines[index - 1]?.trim() || null;
/** What Copy puts on the clipboard: the lines in image order. */
export const altCopyText = (lines: string[]): string => lines.join('\n');

// ---- the preview -----------------------------------------------------------------------------------------

export interface PreviewNav { title: string; hasPrevious: boolean; hasNext: boolean; single: boolean }
/** "Image 3 of 7"; previous and next stop at the ends (no wrap); a single image has no navigation. */
export function previewNav(position: number, count: number, noun = 'image'): PreviewNav {
  if (count <= 1) return { title: `Single ${noun}`, hasPrevious: false, hasNext: false, single: true };
  return { title: `${noun[0].toUpperCase()}${noun.slice(1)} ${position} of ${count}`, hasPrevious: position > 1, hasNext: position < count, single: false };
}
/** The next position for ← / →, clamped to the ends. */
export function stepPreview(position: number, count: number, key: string): number {
  if (key === 'ArrowLeft') return Math.max(1, position - 1);
  if (key === 'ArrowRight') return Math.min(count, position + 1);
  return position;
}

export function formatPngSize(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
/** "1080 × 1350 px · 412 KB · still-…-slide-03". */
export const previewFacts = (image: ImageFileDto): string => [`${image.width} × ${image.height} px`, formatPngSize(image.size), image.compositionId].filter(Boolean).join(' · ');

// ---- the post switcher ------------------------------------------------------------------------------------

export const isImagePost = (post: Pick<PostDto, 'format'>): boolean => post.format === 'image' || post.format === 'carousel';
export const imagePosts = (posts: PostDto[]): PostDto[] => posts.filter(isImagePost);
export const imageSetOf = (post: PostDto): AssetDto | undefined => post.needs.find((a) => a.kind === 'image-set');
const setState = (post: PostDto): AssetState => imageSetOf(post)?.state ?? 'empty';

/** Opens on the first image or carousel post whose set is not finalized, else the first. */
export const defaultImagePostId = (posts: PostDto[]): string | null => (posts.find((p) => setState(p) !== 'finalized') ?? posts[0])?.id ?? null;
export const selectedImagePostId = (posts: PostDto[], chosen: string | null): string | null => (posts.some((p) => p.id === chosen) ? chosen : defaultImagePostId(posts));
export const imageChipModel = (post: PostDto): PostChipModel => ({
  id: post.id, platform: post.platform, platformLabel: PLATFORM_LABELS[post.platform], format: formatLabel(post.format), scheduledAt: post.scheduledAt,
  state: setState(post), stateLabel: assetStateLabel(setState(post)),
});
export const imageSwitcherLabel = (count: number): string => `Image and carousel posts · ${count} ${count === 1 ? 'post' : 'posts'}`;
/** The line under the switcher: platform · format, then the size and the count rule. */
export function imageContextLine(post: PostDto): { title: string; rest: string } {
  const size = defaultImageSize(post.platform, post.format);
  const range = imageRange(post.platform, post.format);
  return { title: `${PLATFORM_LABELS[post.platform]} · ${formatLabel(post.format)}`, rest: `${size ? `${size.width} × ${size.height} px` : ''}${range ? ` · ${countText(range)}` : ''}` };
}

/** Keeps the previous images part when nothing in it changed, so a terminal chunk or another asset's event does not redraw the gallery. */
export function shareImages(previous: ImagesPartDto | undefined, next: ImagesPartDto): ImagesPartDto {
  return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
