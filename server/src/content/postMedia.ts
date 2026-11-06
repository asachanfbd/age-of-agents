import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { ContentNotFoundError } from './errors.ts';
import { conceptDir, getConcept } from './concepts.ts';
import type { AssetView, PostView } from './concepts.ts';
import { buildZip } from './zip.ts';

/**
 * What a finalized post hands over to be posted by hand. The post-text and article assets hold the text itself. The
 * image-set and thumbnail assets' `content` is a JSON list of file paths (one for the thumbnail) and the video asset's `content`
 * is one file path, all relative to the Concept's folder; the Images, Thumbnail and Video tabs write them. A path that leaves the folder reads as missing.
 */
export interface MediaFileView { index: number; name: string; missing: boolean }
export interface PostMediaView {
  text: string | null; images: MediaFileView[] | null; video: { name: string; missing: boolean } | null;
  /** Video and reel posts only, once the thumbnail is finalized. */
  thumbnail: { name: string; missing: boolean } | null;
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
export const mediaType = (name: string): string => TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

function finalizedAsset(post: PostView, kind: AssetView['kind']): AssetView | undefined {
  const asset = post.needs.find((a) => a.kind === kind);
  return asset?.state === 'finalized' ? asset : undefined;
}

function imagePaths(asset: AssetView | undefined): string[] {
  if (!asset?.content) return [];
  try {
    const list = JSON.parse(asset.content) as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch { return []; }
}

/** The file's bytes, or null when the reference is unsafe or the file is gone. */
async function readMedia(ctx: ContentCtx, conceptId: string, reference: string): Promise<Buffer | null> {
  const root = conceptDir(ctx, conceptId);
  const file = path.resolve(root, reference);
  if (!file.startsWith(root + path.sep)) return null;
  try { return await readFile(file); } catch { return null; }
}

function postOfConcept(ctx: ContentCtx, conceptId: string, postId: string): PostView {
  const post = getConcept(ctx, conceptId).posts.find((p) => p.id === postId);
  if (!post) throw new ContentNotFoundError('That post does not exist');
  return post;
}

export async function postMedia(ctx: ContentCtx, conceptId: string, postId: string): Promise<PostMediaView> {
  const post = postOfConcept(ctx, conceptId, postId);
  const text = finalizedAsset(post, 'post-text') ?? finalizedAsset(post, 'article');
  const images = post.needs.some((a) => a.kind === 'image-set') ? imagePaths(finalizedAsset(post, 'image-set')) : null;
  const video = finalizedAsset(post, 'video');
  const [thumbnail] = imagePaths(finalizedAsset(post, 'thumbnail'));
  return {
    text: text?.content ?? null,
    images: images && await Promise.all(images.map(async (ref, index) => ({ index, name: path.basename(ref), missing: (await readMedia(ctx, conceptId, ref)) === null }))),
    video: video?.content ? { name: path.basename(video.content), missing: (await readMedia(ctx, conceptId, video.content)) === null } : null,
    thumbnail: thumbnail ? { name: path.basename(thumbnail), missing: (await readMedia(ctx, conceptId, thumbnail)) === null } : null,
  };
}

export interface MediaFile { name: string; type: string; bytes: Buffer }

export async function postImage(ctx: ContentCtx, conceptId: string, postId: string, index: number): Promise<MediaFile> {
  const refs = imagePaths(finalizedAsset(postOfConcept(ctx, conceptId, postId), 'image-set'));
  const ref = Number.isInteger(index) ? refs[index] : undefined;
  const bytes = ref === undefined ? null : await readMedia(ctx, conceptId, ref);
  if (ref === undefined || !bytes) throw new ContentNotFoundError('That image is not available');
  return { name: path.basename(ref), type: mediaType(ref), bytes };
}

export async function postVideo(ctx: ContentCtx, conceptId: string, postId: string): Promise<MediaFile> {
  const ref = finalizedAsset(postOfConcept(ctx, conceptId, postId), 'video')?.content;
  const bytes = ref ? await readMedia(ctx, conceptId, ref) : null;
  if (!ref || !bytes) throw new ContentNotFoundError('The video is not available');
  return { name: path.basename(ref), type: mediaType(ref), bytes };
}

export async function postThumbnail(ctx: ContentCtx, conceptId: string, postId: string): Promise<MediaFile> {
  const [ref] = imagePaths(finalizedAsset(postOfConcept(ctx, conceptId, postId), 'thumbnail'));
  const bytes = ref ? await readMedia(ctx, conceptId, ref) : null;
  if (!ref || !bytes) throw new ContentNotFoundError('The thumbnail is not available');
  return { name: path.basename(ref), type: mediaType(ref), bytes };
}

/** Every present image of the set in one zip; a file that is gone is left out. */
export async function postImagesZip(ctx: ContentCtx, conceptId: string, postId: string): Promise<Buffer> {
  const refs = imagePaths(finalizedAsset(postOfConcept(ctx, conceptId, postId), 'image-set'));
  const entries = (await Promise.all(refs.map(async (ref) => ({ name: path.basename(ref), bytes: await readMedia(ctx, conceptId, ref) })))).filter((e): e is { name: string; bytes: Buffer } => e.bytes !== null);
  if (!entries.length) throw new ContentNotFoundError('There are no images to download');
  return buildZip(entries);
}
