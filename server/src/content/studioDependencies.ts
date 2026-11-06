import type { ConceptView } from './concepts.ts';
import type { AssetKind } from './rules.ts';
import { studioTabFor } from './studioTabs.ts';

/** Finalizing an asset of kind `after` starts the first session of every not yet started asset of kind `start`. */
export interface StartRule { after: AssetKind; start: AssetKind }

/**
 * Which asset kinds start by themselves once an upstream asset is finalized. The thumbnail starts with the script, so it is made in
 * parallel with the video, and again after the video for a thumbnail that was never started.
 */
export const START_RULES: readonly StartRule[] = [
  { after: 'script', start: 'video' },
  { after: 'script', start: 'post-text' },
  { after: 'script', start: 'article' },
  { after: 'script', start: 'image-set' },
  { after: 'script', start: 'thumbnail' },
  { after: 'video', start: 'thumbnail' },
];

export const kindsToStartAfter = (finalized: AssetKind, rules: readonly StartRule[] = START_RULES): AssetKind[] =>
  rules.filter((r) => r.after === finalized).map((r) => r.start);

export interface AutoStart { assetId: string; kind: AssetKind }

/**
 * The assets to start after an asset of kind `finalized` is finalized: those the rules name that are still `empty`, have no
 * session yet and have an agent pane. Assets are found through the posts' needs, so a video or thumbnail only counts when a post
 * needs it; the order is the posts' order, and a shared asset (the video, the thumbnail) comes once.
 */
export function assetsToStart(concept: ConceptView, finalized: AssetKind, hasSession: (assetId: string) => boolean, rules: readonly StartRule[] = START_RULES): AutoStart[] {
  const kinds = kindsToStartAfter(finalized, rules);
  const picked = new Map<string, AutoStart>();
  for (const post of concept.posts) {
    for (const asset of post.needs) {
      if (picked.has(asset.id) || !kinds.includes(asset.kind) || asset.state !== 'empty' || hasSession(asset.id)) continue;
      if (studioTabFor(asset.kind, asset.postId === null ? null : post.platform)) picked.set(asset.id, { assetId: asset.id, kind: asset.kind });
    }
  }
  return [...picked.values()];
}
