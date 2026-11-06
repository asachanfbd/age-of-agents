import path from 'node:path';
import type { ConceptView } from './concepts.ts';
import type { ImageSize } from './imageRules.ts';
import { IMAGE_SIZE_MAX, IMAGE_SIZE_MIN, IMAGES_PER_CALL_MAX } from './limits.ts';
import { PLATFORM_LABELS, imageRange } from './rules.ts';
import type { Platform } from './rules.ts';
import { STUDIO_MCP_SERVER_NAME } from './studioInstructions.ts';
import { STUDIO_TABS, STUDIO_TOOLS, STYLE_SECTION_OF } from './studioTabs.ts';

export interface ImageInstructionInput {
  concept: Pick<ConceptView, 'id' | 'title' | 'brief'>;
  post: { id: string; platform: Platform; format: string; scheduledAt: string };
  buildingDir: string;
  size: ImageSize;
  /** `still-<hex>`: every still id of this post is `<prefix>-<file name>`. */
  stillPrefix: string;
  /** The post's text: its finalized text, else its latest draft; null when it has none yet. */
  postText: { text: string; finalized: boolean } | null;
  /** The finalized script's file, or null. */
  scriptFile: string | null;
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

/** The image count rule in words: "exactly 1 image", "1 to 4 images", "2 to 20 images". */
export function countRuleText(platform: Platform, format: string): string {
  const range = imageRange(platform, format)!;
  return range.min === range.max ? `exactly ${range.min} image` : `${range.min} to ${range.max} images`;
}

/**
 * The system prompt of an images session, which runs in the Building's shared Remotion project and designs still compositions.
 * Images carry text, so it includes the writing skill, like the writing tabs.
 */
export function imagesSystemPrompt(input: ImageInstructionInput): string {
  const { concept, post, buildingDir, size, stillPrefix, postText, scriptFile, brandFiles, colours, skillText, reopened, performance, reference } = input;
  const knowledge = path.join(buildingDir, 'knowledge');
  const own = `src/concepts/${concept.id}/images/${post.id}/`;
  const tool = (name: string) => `\`${name}\``;
  const colourLines = colours.length ? colours.map((c) => `- ${c.name}: ${c.hex}`).join('\n') : '(none recorded yet)';
  const fileLines = brandFiles.length ? brandFiles.map((f) => `- ${f}`).join('\n') : '(none uploaded yet)';
  return [
    `You are the image designer of a Content Studio for one business, working with its owner in a chat. You design images as code: still compositions with Remotion (React) in this folder, the Building's shared Remotion project, rendered to PNG. You may edit files and run shell commands without asking for permission. Make no network requests: use only files on this machine.`,
    `## This tab's job\n\n${STUDIO_TABS.images!.job}`,
    `## The Concept\n\nTitle: ${concept.title}\n\nBrief:\n${concept.brief || '(none)'}`,
    `## This post\n\nPlatform: ${PLATFORM_LABELS[post.platform]}\nFormat: ${post.format}\nScheduled: ${post.scheduledAt}\nImages: ${countRuleText(post.platform, post.format)}. Finalize needs a finished render with that many images.\nSize: ${size.width}x${size.height} px by default. Use another size only when the owner asks (width and height from ${IMAGE_SIZE_MIN} to ${IMAGE_SIZE_MAX.toLocaleString('en-US')} px).`,
    postText
      ? `## The post's text\n\nThe ${postText.finalized ? 'finalized' : 'latest draft of the'} text of this post. The images should work with it:\n\n${postText.text}`
      : `## The post's text\n\nNo post text yet.`,
    scriptFile
      ? `## The video script\n\nThe Concept's finalized script is in ${scriptFile}.`
      : `## The video script\n\nNo finalized script yet.`,
    `## Brand\n\n${knowledge}${path.sep} holds the business knowledge; use its brand files and colours for every image. When the owner tells you a new fact about the business you may edit these files, and you must say in the chat that you did. ${path.join(knowledge, 'writing-style.md')} is the writing style: text on the images follows its General section and its "${STYLE_SECTION_OF[post.platform]}" section.\n\nBrand files in ${path.join(knowledge, 'files')}${path.sep}:\n${fileLines}\n\nColours (${path.join(knowledge, 'colours.json')}):\n${colourLines}\n\nTo use a logo or a font, copy it into public/brand/ and load it with \`staticFile('brand/<name>')\`. src/brand/ holds brand components shared with every video of this Building: reuse them, and change them carefully, never breaking another Concept's video.`,
    performance ?? '',
    reference ?? '',
    `## Media\n\nThe owner's files for this Concept are in public/concepts/${concept.id}/media/ (load them with \`staticFile('concepts/${concept.id}/media/<name>')\`). ${tool(STUDIO_TOOLS.listMedia)} lists them; you may use them in the images.`,
    `## Where to edit\n\n- Put each image in its own file in ${own}, named with lower-case letters, digits and dashes (for example slide-01.tsx). Each file exports \`export const still = { component: Slide };\`, where Slide is a React component that reads its size from \`useVideoConfig()\`.\n- The composition id of a file is "${stillPrefix}-<file name without .tsx>", for example "${stillPrefix}-slide-01". The daemon lists them in src/concepts/registry.ts; never edit that file.\n- Edit nothing else of other Concepts or posts.`,
    `## Rendering\n\nRender only with ${tool(STUDIO_TOOLS.renderImages)} (from the \`${STUDIO_MCP_SERVER_NAME}\` tools), never with the Remotion CLI yourself: its PNGs are what the owner sees. Pass the composition ids in the order the images should appear (1 to ${IMAGES_PER_CALL_MAX}), and width and height only for another size. Each call replaces this round's images. It returns when every image is rendered, or the error; one render runs at a time per Building, so it may wait in a queue. ${tool(STUDIO_TOOLS.getConcept)} returns the Concept, its posts and the state of its assets.`,
    `## Alt text\n\nSave alt text with ${tool(STUDIO_TOOLS.saveDraft)}: one line per image, in image order, each at most 1,000 characters.`,
    skillText === null ? '' : `## Writing skill\n\nFollow this skill for all text you write, on the images and in the alt text.\n\n${skillText}`,
    reopened ? `## Starting point\n\nThe owner reopened these images after finalizing them. The still code in ${own} is the finalized round's; continue from it.` : '',
  ].filter(Boolean).join('\n\n');
}
