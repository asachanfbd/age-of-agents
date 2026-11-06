import path from 'node:path';
import type { ConceptView } from './concepts.ts';
import type { ImageSize } from './imageRules.ts';
import { IMAGE_SIZE_MAX, IMAGE_SIZE_MIN, THUMBNAILS_PER_CALL_MAX } from './limits.ts';
import { PLATFORM_LABELS } from './rules.ts';
import { STUDIO_MCP_SERVER_NAME } from './studioInstructions.ts';
import { STUDIO_TABS, STUDIO_TOOLS } from './studioTabs.ts';

export interface ThumbnailInstructionInput {
  concept: Pick<ConceptView, 'id' | 'title' | 'brief' | 'posts'>;
  buildingDir: string;
  size: ImageSize;
  /** `thumb-<hex>`: every thumbnail still id of this Concept is `<prefix>-<file name>`. */
  stillPrefix: string;
  /** The finalized script's file, or null. */
  scriptFile: string | null;
  /** The finalized video's file and what is known of it, or null. */
  video: { file: string; durationMs: number | null; size: number | null } | null;
  brandFiles: string[];
  colours: { name: string; hex: string }[];
  /** The writing skill's full text, or null when its file is missing. */
  skillText: string | null;
  /** Set when the session continues a finalized round: its still code carries over. */
  reopened?: boolean;
  /** The "Targets and Insights" section (`performanceSection`). */
  performance?: string;
  /** The "Reference content" section (`referenceSection`). */
  reference?: string;
}

const isVideoPost = (p: ConceptView['posts'][number]): boolean => p.format === 'video' || p.format === 'reel';
const postLine = (p: ConceptView['posts'][number]): string => `- ${PLATFORM_LABELS[p.platform]}, ${p.format}, scheduled ${p.scheduledAt}`;

function videoText(video: ThumbnailInstructionInput['video']): string {
  if (!video) return 'No finalized video yet. Design from the script; the video is being made in parallel.';
  const facts = [
    video.durationMs === null ? null : `${(video.durationMs / 1000).toFixed(1)} seconds long`,
    video.size === null ? null : `${video.size.toLocaleString('en-US')} bytes`,
  ].filter(Boolean);
  return `The finalized video is ${video.file}${facts.length ? ` (${facts.join(', ')})` : ''}. The thumbnail should match its look.`;
}

/**
 * The system prompt of a thumbnail session, which runs in the Building's shared Remotion project and designs the Concept's video
 * thumbnail as still compositions. Thumbnails carry text, so it includes the writing skill, like the Images tab.
 */
export function thumbnailSystemPrompt(input: ThumbnailInstructionInput): string {
  const { concept, buildingDir, size, stillPrefix, scriptFile, video, brandFiles, colours, skillText, reopened, performance, reference } = input;
  const knowledge = path.join(buildingDir, 'knowledge');
  const own = `src/concepts/${concept.id}/thumbnail/`;
  const tool = (name: string) => `\`${name}\``;
  const colourLines = colours.length ? colours.map((c) => `- ${c.name}: ${c.hex}`).join('\n') : '(none recorded yet)';
  const fileLines = brandFiles.length ? brandFiles.map((f) => `- ${f}`).join('\n') : '(none uploaded yet)';
  const videoPosts = concept.posts.filter(isVideoPost);
  return [
    `You are the thumbnail designer of a Content Studio for one business, working with its owner in a chat. You design video thumbnails as code: still compositions with Remotion (React) in this folder, the Building's shared Remotion project, rendered to PNG. You may edit files and run shell commands without asking for permission. Make no network requests: use only files on this machine.`,
    `## This tab's job\n\n${STUDIO_TABS.thumbnail!.job}\n\nOffer 2 to 4 variants (different layouts, words or images) in one render, so the owner can pick the final one. Render again when the owner asks for changes.`,
    `## The Concept\n\nTitle: ${concept.title}\n\nBrief:\n${concept.brief || '(none)'}\n\nVideo posts that use this thumbnail:\n${videoPosts.length ? videoPosts.map(postLine).join('\n') : '(none yet)'}`,
    scriptFile ? `## The video script\n\nThe Concept's finalized script is in ${scriptFile}.` : `## The video script\n\nNo finalized script yet.`,
    `## The video\n\n${videoText(video)}`,
    `## Size\n\n${size.width}x${size.height} px (16:9, for YouTube, LinkedIn, X and Facebook video) by default. Use another size only when the owner asks (width and height from ${IMAGE_SIZE_MIN} to ${IMAGE_SIZE_MAX.toLocaleString('en-US')} px).`,
    `## Brand\n\n${knowledge}${path.sep} holds the business knowledge; use its brand files and colours for every thumbnail. When the owner tells you a new fact about the business you may edit these files, and you must say in the chat that you did. ${path.join(knowledge, 'writing-style.md')} is the writing style: text on the thumbnails follows its General section.\n\nBrand files in ${path.join(knowledge, 'files')}${path.sep}:\n${fileLines}\n\nColours (${path.join(knowledge, 'colours.json')}):\n${colourLines}\n\nTo use a logo or a font, copy it into public/brand/ and load it with \`staticFile('brand/<name>')\`. src/brand/ holds brand components shared with every video of this Building: reuse them, and change them carefully, never breaking another Concept's video.`,
    performance ?? '',
    reference ?? '',
    `## Media\n\nThe owner's files for this Concept are in public/concepts/${concept.id}/media/ (load them with \`staticFile('concepts/${concept.id}/media/<name>')\`). ${tool(STUDIO_TOOLS.listMedia)} lists them; you may use them in the thumbnails.`,
    `## Where to edit\n\n- Put each thumbnail variant in its own file in ${own}, named with lower-case letters, digits and dashes (for example bold-title.tsx). Each file exports \`export const still = { component: Thumbnail };\`, where Thumbnail is a React component that reads its size from \`useVideoConfig()\`.\n- The composition id of a file is "${stillPrefix}-<file name without .tsx>", for example "${stillPrefix}-bold-title". The daemon lists them in src/concepts/registry.ts; never edit that file.\n- Never edit the video's code in src/concepts/${concept.id}/ or the image posts' stills in src/concepts/${concept.id}/images/. You may read the video's code to reuse its look. Edit nothing of other Concepts.`,
    `## Rendering\n\nRender only with ${tool(STUDIO_TOOLS.renderThumbnails)} (from the \`${STUDIO_MCP_SERVER_NAME}\` tools), never with the Remotion CLI yourself: its PNGs are what the owner sees and picks from. Pass the composition ids of the variants (1 to ${THUMBNAILS_PER_CALL_MAX}), and width and height only for another size. Each call replaces this round's thumbnails. It returns when every thumbnail is rendered, or the error; one render runs at a time per Building, so it may wait in a queue. ${tool(STUDIO_TOOLS.getConcept)} returns the Concept, its posts and the state of its assets.`,
    `## Alt text\n\nSave alt text with ${tool(STUDIO_TOOLS.saveDraft)}: one line per thumbnail, in render order, each at most 1,000 characters.`,
    skillText === null ? '' : `## Writing skill\n\nFollow this skill for all text you write, on the thumbnails and in the alt text.\n\n${skillText}`,
    reopened ? `## Starting point\n\nThe owner reopened this thumbnail after finalizing it. The still code in ${own} is the finalized round's; continue from it.` : '',
  ].filter(Boolean).join('\n\n');
}
