/**
 * The closed sets and pure rules of Content Studio: platforms, formats, the assets a post needs, the finalize rule and
 * the Concept tab bar. `web/src/lib/contentRules.ts` duplicates this file; `contentRules.test.ts (SU28)` pins them together.
 */

export const PLATFORMS = ['linkedin', 'instagram', 'x', 'facebook', 'blog'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = { linkedin: 'LinkedIn', instagram: 'Instagram', x: 'X (Twitter)', facebook: 'Facebook', blog: 'Blog' };

export const FORMATS_BY_PLATFORM: Record<Platform, readonly string[]> = {
  linkedin: ['text', 'image', 'carousel', 'video'],
  instagram: ['image', 'carousel', 'reel'],
  x: ['text', 'image', 'video'],
  facebook: ['text', 'image', 'carousel', 'video'],
  blog: ['article'],
};

export const ASSET_KINDS = ['script', 'video', 'post-text', 'image-set', 'article', 'thumbnail'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
/** Kinds one Concept holds once, shared by its posts (`postId` null): the script, the video and the video's thumbnail. */
export const CONCEPT_ASSET_KINDS: readonly AssetKind[] = ['script', 'video', 'thumbnail'];
export const isConceptAssetKind = (kind: AssetKind): boolean => CONCEPT_ASSET_KINDS.includes(kind);
export const ASSET_STATES = ['empty', 'drafting', 'finalized'] as const;
export type AssetState = (typeof ASSET_STATES)[number];
export const POST_STATUSES = ['draft', 'finalized', 'published'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** What the post text is called on each platform. */
export const TEXT_NAMES: Record<Exclude<Platform, 'blog'>, string> = { linkedin: 'Post', instagram: 'Caption', x: 'Tweet', facebook: 'Post' };

export interface ImageRange { min: number; max: number }
/**
 * Images a post's image set holds. The carousel limits are the platforms' published limits at the time of writing
 * (LinkedIn and Instagram 20, Facebook 10); revisit them when a platform changes its own.
 */
export function imageRange(platform: Platform, format: string): ImageRange | null {
  if (format === 'image') return platform === 'x' ? { min: 1, max: 4 } : { min: 1, max: 1 };
  if (format === 'carousel') return { min: 2, max: platform === 'facebook' ? 10 : 20 };
  return null;
}

export const isPlatform = (value: unknown): value is Platform => typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
export const isFormatOf = (platform: Platform, format: unknown): boolean => typeof format === 'string' && FORMATS_BY_PLATFORM[platform].includes(format);

/** The asset kinds a post needs finalized before it can be finalized, in a stable order. The script is never one of them. */
export function assetsNeeded(platform: Platform, format: string): AssetKind[] {
  if (platform === 'blog') return ['article'];
  const needed: AssetKind[] = ['post-text'];
  if (format === 'image' || format === 'carousel') needed.push('image-set');
  if (format === 'video' || format === 'reel') needed.push('video', 'thumbnail');
  return needed;
}

/**
 * What a post of a Concept lists as needed. An imported Concept's posts are published directly, so they need only the
 * assets that were imported (finalized) and never show a missing one; `stateOf` reads an asset's state.
 */
export function postNeeds(platform: Platform, format: string, imported: boolean, stateOf: (kind: AssetKind) => AssetState | undefined): AssetKind[] {
  const needed = assetsNeeded(platform, format);
  return imported ? needed.filter((kind) => stateOf(kind) === 'finalized') : needed;
}

/** Every refused change to an imported Concept's content answers with this. */
export const IMPORTED_READ_ONLY = 'Imported content is read-only; delete and import again';

export interface FinalizeCheck { ok: boolean; missing: AssetKind[] }
/** `stateOf` reads the state of one needed asset; anything not finalized (empty or drafting) is missing. */
export function finalizeCheck(needed: AssetKind[], stateOf: (kind: AssetKind) => AssetState | undefined): FinalizeCheck {
  const missing = needed.filter((kind) => stateOf(kind) !== 'finalized');
  return { ok: missing.length === 0, missing };
}

/** An asset going back to `drafting` takes a finalized post back to draft; a draft or published post is left as it is. */
export const statusAfterAssetDrafting = (status: PostStatus): PostStatus => (status === 'finalized' ? 'draft' : status);

export const CONCEPT_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'script', label: 'Script' },
  { key: 'video', label: 'Video' },
  { key: 'thumbnail', label: 'Thumbnail' },
  { key: 'remotion', label: 'Remotion' },
  { key: 'images', label: 'Images' },
  { key: 'post-content', label: 'Post content' },
  { key: 'captions', label: 'Captions' },
  { key: 'blog', label: 'Blog' },
] as const;
export type ConceptTab = (typeof CONCEPT_TABS)[number]['key'];

export interface PostShape { platform: Platform; format: string }
export interface TabState { key: ConceptTab; label: string; enabled: boolean; reason: string | null }

const isVideo = (p: PostShape) => p.format === 'video' || p.format === 'reel';
const isImageLike = (p: PostShape) => p.format === 'image' || p.format === 'carousel';
/** `compositionReady`: the Video tab's session has scaffolded the Concept's composition in the shared Remotion project. */
export interface TabContext { scriptFinalized: boolean; compositionReady?: boolean; imported?: boolean }
interface TabRule { applies: (posts: PostShape[], context: TabContext) => boolean; reason: (posts: PostShape[], context: TabContext) => string }
const needsVideoPost = 'Add a video or reel post to use this tab';
const IMPORTED_NO_REMOTION = 'Imported content has no Remotion project';
const simple = (applies: (posts: PostShape[]) => boolean, reason: string): TabRule => ({ applies: (posts) => applies(posts), reason: () => reason });
/** Video also waits for the Concept's script to be finalized; the reason names whichever condition (or both) is missing. */
const videoReason = (posts: PostShape[], context: TabContext): string => {
  const noPost = !posts.some(isVideo);
  if (noPost && !context.scriptFinalized) return 'Add a video or reel post and finalize the script to use this tab';
  return noPost ? needsVideoPost : 'Finalize the script to use this tab';
};
/** Remotion Studio shows the Concept's composition, which the Video tab's session creates; the missing post is named first. */
const remotionReason = (posts: PostShape[]): string => (posts.some(isVideo) ? 'Start the video in the Video tab first' : needsVideoPost);
const TAB_RULES: Record<ConceptTab, TabRule> = {
  overview: simple(() => true, ''),
  script: simple(() => true, ''),
  video: { applies: (posts, context) => posts.some(isVideo) && context.scriptFinalized, reason: videoReason },
  thumbnail: simple((posts) => posts.some(isVideo), needsVideoPost),
  remotion: { applies: (posts, context) => posts.some(isVideo) && !!context.compositionReady, reason: remotionReason },
  images: simple((posts) => posts.some(isImageLike), 'Add an image or carousel post to use this tab'),
  'post-content': simple((posts) => posts.some((p) => p.platform === 'linkedin' || p.platform === 'x' || p.platform === 'facebook'), 'Add a LinkedIn, X or Facebook post to use this tab'),
  captions: simple((posts) => posts.some((p) => p.platform === 'instagram'), 'Add an Instagram post to use this tab'),
  blog: simple((posts) => posts.some((p) => p.platform === 'blog'), 'Add a blog post to use this tab'),
};

/** An imported Concept's tabs only show what was imported, so Video needs no finalized script and nothing leads to Remotion. */
const IMPORTED_TAB_RULES: Partial<Record<ConceptTab, TabRule>> = {
  video: simple((posts) => posts.some(isVideo), needsVideoPost),
  remotion: simple(() => false, IMPORTED_NO_REMOTION),
};

/** Which Concept tabs are usable for a Concept with these posts and script state, and why not when disabled. Later tasks add conditions here. */
export function conceptTabStates(posts: PostShape[], context: TabContext = { scriptFinalized: false }): TabState[] {
  return CONCEPT_TABS.map(({ key, label }) => {
    const rule = (context.imported && IMPORTED_TAB_RULES[key]) || TAB_RULES[key];
    const enabled = rule.applies(posts, context);
    return { key, label, enabled, reason: enabled ? null : rule.reason(posts, context) };
  });
}
