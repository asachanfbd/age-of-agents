import path from 'node:path';
import type { ConceptView } from './concepts.ts';
import { PLATFORM_LIMITS, PLATFORM_RULE_TEXT, THREAD_SEPARATOR } from './platformLimits.ts';
import { PLATFORM_LABELS } from './rules.ts';
import type { AssetState, Platform } from './rules.ts';
import { STUDIO_TOOLS, styleSectionFor, type StudioTabDefinition } from './studioTabs.ts';

export const STUDIO_MCP_SERVER_NAME = 'agent_visual_os_studio';

export interface OtherPost { platform: Platform; format: string; scheduledAt: string; /** The state of its text (post text or article); null when it needs none. */ textState: AssetState | null }

/** What a post tab's session is told about its own post, taken when the session starts. */
export interface PostBrief {
  platform: Platform;
  format: string;
  scheduledAt: string;
  /** The Building's time zone, for the local scheduled time. */
  timeZone: string;
  /** The finalized script's file, or null when the script is not finalized or its file is missing. */
  scriptFile: string | null;
  /** The Concept's other posts, without this one. */
  others: OtherPost[];
}

export interface StudioInstructionInput {
  tab: StudioTabDefinition;
  concept: Pick<ConceptView, 'title' | 'brief' | 'posts'>;
  /** The Building's folder; the agent reads `knowledge/` inside it. */
  buildingDir: string;
  /** The writing skill's full text, or null when its file is missing. */
  skillText: string | null;
  /** A reopened asset's finalized text, the starting point of its new round. */
  startingText?: string | null;
  /** Set for a post's text or article. */
  post?: PostBrief | null;
  /** The "Targets and Insights" section (`performanceSection`). */
  performance?: string;
  /** The "Reference content" section (`referenceSection`). */
  reference?: string;
}

const TEXT_STATE_LABELS: Record<AssetState, string> = { empty: 'Not started', drafting: 'Drafting', finalized: 'Finalized' };

const postLine = (post: ConceptView['posts'][number]): string => `- ${PLATFORM_LABELS[post.platform]}, ${post.format}, scheduled ${post.scheduledAt}`;

/** An instant as the ISO text plus its wall-clock time in the Building zone. */
export function scheduledText(instant: string, timeZone: string): string {
  const local = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(instant));
  return `${instant} (${local}, ${timeZone})`;
}

function postSections(post: PostBrief): string[] {
  const limit = PLATFORM_LIMITS[post.platform];
  const thread = post.platform === 'x'
    ? `\n\nA thread is allowed: put a line containing only \`${THREAD_SEPARATOR}\` between tweets. Each tweet may have at most ${limit.max} characters, and a thread at most ${limit.maxTweets} tweets.`
    : '';
  const others = post.others.length
    ? post.others.map((o) => `- ${PLATFORM_LABELS[o.platform]}, ${o.format}, scheduled ${o.scheduledAt}, text: ${o.textState ? TEXT_STATE_LABELS[o.textState] : 'none needed'}`).join('\n')
    : '(none: this is the only post)';
  return [
    `## This post\n\nPlatform: ${PLATFORM_LABELS[post.platform]}\nFormat: ${post.format}\nScheduled: ${scheduledText(post.scheduledAt, post.timeZone)}`,
    `## Platform rules\n\n${PLATFORM_RULE_TEXT[post.platform]}.${thread}\n\nCharacters are counted as Unicode code points after trimming. \`${STUDIO_TOOLS.saveDraft}\` refuses a draft that breaks these rules with a message naming the limit; shorten it and save again.`,
    post.scriptFile
      ? `## The video script\n\nThe Concept's finalized script is in ${post.scriptFile}. Read it so this text matches the video.`
      : `## The video script\n\nNo finalized script yet, so write from the brief.`,
    `## The Concept's other posts\n\nVary the wording between platforms.\n\n${others}`,
  ];
}

/** The system prompt of a writing session; both CLIs receive exactly this text. */
export function studioSystemPrompt(input: StudioInstructionInput): string {
  const { tab, concept, buildingDir, skillText, startingText, post, performance, reference } = input;
  const knowledge = path.join(buildingDir, 'knowledge');
  const conceptPosts = post ? '' : `\n\nPosts:\n${concept.posts.length ? concept.posts.map(postLine).join('\n') : '(none yet)'}`;
  const sections = [
    `You are the writing agent of a Content Studio for one business, working with its owner in a chat. You may edit files and run shell commands without asking for permission.`,
    `## This tab's job\n\n${tab.job}`,
    `## The Concept\n\nTitle: ${concept.title}\n\nBrief:\n${concept.brief || '(none)'}${conceptPosts}`,
    ...(post ? postSections(post) : []),
    `## Read these first\n\n- ${knowledge}${path.sep} holds the business knowledge. When the owner tells you a new fact about the business you may edit these files, and you must say in the chat that you did.\n- ${path.join(knowledge, 'writing-style.md')} is the writing style: follow its General section and its "${styleSectionFor(tab, post?.platform ?? null)}" section.`,
    performance ?? '',
    reference ?? '',
    skillText === null
      ? ''
      : `## Writing skill\n\nFollow this skill for all text you write.\n\n${skillText}`,
    `## Saving drafts\n\nEvery complete draft must be saved with the \`${STUDIO_TOOLS.saveDraft}\` tool (from the \`${STUDIO_MCP_SERVER_NAME}\` tools). Drafts are the only way text reaches the owner's result pane, so text you only write in the chat is not seen there. Each call stores a new version and the newest wins. \`${STUDIO_TOOLS.getConcept}\` returns the Concept, its posts and the state of its assets.`,
    startingText ? `## Starting point\n\nThe owner reopened this after finalizing it. This is the finalized text; start from it:\n\n${startingText}` : '',
  ];
  return sections.filter(Boolean).join('\n\n');
}

/** Appended to the instructions when a lost conversation is restarted in the same round. */
export const resumeContext = (lastDraft: string): string => `## Where this round stood\n\nThe earlier conversation of this round could not be reopened. The latest saved draft was:\n\n${lastDraft}`;
