import type { AssetKind, Platform } from './rules.ts';

/** What one agent-pane tab of a Concept is for. A tab is an entry here with its tools. */
export interface StudioTabDefinition {
  tab: string;
  assetKind: AssetKind;
  /** The platforms whose posts this tab covers; empty for a Concept-level asset (the script, the video, the thumbnail). */
  platforms: readonly Platform[];
  /** Written into the session's instructions as the tab's job. */
  job: string;
  /** The first message of a fresh session, so the agent starts working without waiting for the owner. */
  startMessage: string;
  /** The `writing-style.md` heading, besides General, that this tab's text must follow; a post tab (images included) follows its post's platform. Null for the video tab too, which writes no text, and the thumbnail tab, which follows General only. */
  styleSection: string | null;
  /** Tool names the session's tool server exposes (see `terminal/studioSessionTool.ts`). */
  tools: readonly string[];
}

export const STUDIO_TOOLS = {
  saveDraft: 'save_draft', getConcept: 'get_concept', setChecklist: 'set_checklist', reportSpeakingRate: 'report_speaking_rate', listMedia: 'list_media', renderImages: 'render_images', renderThumbnails: 'render_thumbnails', getPerformance: 'get_performance',
  getReferenceContent: 'get_reference_content', saveImportedConcept: 'save_imported_concept',
} as const;

/** The `writing-style.md` heading of each platform. */
export const STYLE_SECTION_OF: Record<Platform, string> = { linkedin: 'LinkedIn', instagram: 'Instagram', x: 'X', facebook: 'Facebook', blog: 'Blog' };

/**
 * The saved script is read straight into a teleprompter or voice-over and its words set the estimated length, so the
 * draft holds only what is spoken. `save_draft` refuses the worst cases (`scriptDraftRules.ts`).
 */
export const SCRIPT_ONLY_RULE = [
  'The draft you save must be only the spoken script, as plain paragraphs: the exact words the owner will say, read straight into a teleprompter or voice-over. Its words also set the estimated video length.',
  'Do not put any of these in the draft:',
  '- a title or headings (no lines starting with #)',
  '- labels such as "Hook:", "Intro:", "Scene 1" or "CTA:"',
  '- bracketed or parenthesised stage or camera directions such as [pause] or (show screen)',
  '- timestamps',
  '- word-count or duration notes',
  '- notes to the owner',
  '- a preface such as "Here is the script"',
  '- markdown emphasis, bullets or code fences',
  '- emoji, unless they are spoken',
  'Anything you want to tell the owner (questions, notes, assumptions, alternatives) goes in the chat, never in the draft.',
  'End a spoken lead-in with a full stop rather than a colon, and keep an aside inside its sentence rather than on a line of its own in brackets: save_draft refuses a short line ending in ":" and a line that is only a bracketed direction.',
].join('\n');

const WRITING_TOOLS = [STUDIO_TOOLS.saveDraft, STUDIO_TOOLS.getConcept, STUDIO_TOOLS.getPerformance, STUDIO_TOOLS.getReferenceContent];
/** The import session has no Concept: it reads what was imported and saves new imported Concepts. */
export const IMPORT_SESSION_TOOLS = [STUDIO_TOOLS.saveImportedConcept, STUDIO_TOOLS.getReferenceContent];

export const STUDIO_TABS: Record<string, StudioTabDefinition> = {
  script: {
    tab: 'script',
    assetKind: 'script',
    platforms: [],
    job: `Write the spoken script for a short-form video of this Concept. If the length, the hook or the call to action is unclear, make a sensible choice and note it in the chat; the owner can ask for changes.\n\n${SCRIPT_ONLY_RULE}`,
    startMessage: "Write the first draft of the script now, from the Concept's title and brief, the business knowledge and the writing style. Save it with the save_draft tool.",
    styleSection: 'Video script',
    tools: WRITING_TOOLS,
  },
  'post-content': {
    tab: 'post-content',
    assetKind: 'post-text',
    platforms: ['linkedin', 'x', 'facebook'],
    job: 'Write the text of this one post, ready to publish on its platform, within the platform rules below. If the angle or the call to action is unclear, ask the owner before writing.',
    startMessage: "Write the first draft of this post's text now, from the Concept's brief, the business knowledge and the writing style. Save it with the save_draft tool.",
    styleSection: null,
    tools: WRITING_TOOLS,
  },
  captions: {
    tab: 'captions',
    assetKind: 'post-text',
    platforms: ['instagram'],
    job: 'Write the Instagram caption of this one post, ready to publish, within the platform rules below. If the angle or the call to action is unclear, ask the owner before writing.',
    startMessage: "Write the first draft of this post's caption now, from the Concept's brief, the business knowledge and the writing style. Save it with the save_draft tool.",
    styleSection: null,
    tools: WRITING_TOOLS,
  },
  blog: {
    tab: 'blog',
    assetKind: 'article',
    platforms: ['blog'],
    job: 'Write the blog article of this post in Markdown, within the rules below. If the angle, the audience or the length is unclear, ask the owner before writing.',
    startMessage: "Write the first draft of this post's article now, from the Concept's brief, the business knowledge and the writing style. Save it with the save_draft tool.",
    styleSection: null,
    tools: WRITING_TOOLS,
  },
  video: {
    tab: 'video',
    assetKind: 'video',
    platforms: [],
    job: 'Make the video of this Concept with Remotion from its finalized script.',
    startMessage: 'Build the video of this Concept now from its finalized script, following your instructions.',
    styleSection: null,
    tools: [STUDIO_TOOLS.getConcept, STUDIO_TOOLS.getPerformance, STUDIO_TOOLS.getReferenceContent, STUDIO_TOOLS.setChecklist, STUDIO_TOOLS.reportSpeakingRate, STUDIO_TOOLS.listMedia],
  },
  images: {
    tab: 'images',
    assetKind: 'image-set',
    platforms: ['linkedin', 'instagram', 'x', 'facebook'],
    job: "Design this post's image set as still compositions in Remotion and render them to PNG with the business's brand files and colours. If the message, the number of slides or the look is unclear, ask the owner before building.",
    startMessage: "Design this post's image set now from the post text and brand files, following your instructions. Save the alt text with the save_draft tool.",
    styleSection: null,
    tools: [STUDIO_TOOLS.getConcept, STUDIO_TOOLS.getPerformance, STUDIO_TOOLS.getReferenceContent, STUDIO_TOOLS.saveDraft, STUDIO_TOOLS.listMedia, STUDIO_TOOLS.renderImages],
  },
  thumbnail: {
    tab: 'thumbnail',
    assetKind: 'thumbnail',
    platforms: [],
    job: "Design the thumbnail of this Concept's video as still compositions in Remotion and render them to PNG with the business's brand files and colours. Every video and reel post of the Concept uses it. If the message or the look is unclear, ask the owner before building.",
    startMessage: 'Design 2 to 4 thumbnail variants for this video now from the script and brand files, following your instructions, and render them. Save the alt text with the save_draft tool.',
    styleSection: null,
    tools: [STUDIO_TOOLS.getConcept, STUDIO_TOOLS.getPerformance, STUDIO_TOOLS.getReferenceContent, STUDIO_TOOLS.saveDraft, STUDIO_TOOLS.listMedia, STUDIO_TOOLS.renderThumbnails],
  },
};

/** The tab whose pane works on an asset of this kind, for the post's platform (null for a Concept-level asset); undefined when it has no pane yet. */
export const studioTabFor = (assetKind: AssetKind, platform: Platform | null = null): StudioTabDefinition | undefined =>
  Object.values(STUDIO_TABS).find((t) => t.assetKind === assetKind && (platform === null ? t.platforms.length === 0 : t.platforms.includes(platform)));

/** The `writing-style.md` heading the session follows besides General. */
export const styleSectionFor = (tab: StudioTabDefinition, platform: Platform | null): string => tab.styleSection ?? (platform ? STYLE_SECTION_OF[platform] : 'General');
