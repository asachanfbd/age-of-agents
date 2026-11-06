import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { INSIGHTS_MARKDOWN_MAX } from './limits.ts';
import { PLATFORM_LABELS } from './rules.ts';
import type { Platform } from './rules.ts';
import { setFields } from './targetRules.ts';
import type { TargetField, Targets } from './targetRules.ts';
import { readTargets } from './targets.ts';

export const INSIGHTS_FILE = 'insights.md';
export const INSIGHTS_PATH_RULE = 'Read the Insights before proposing anything. Prefer what works, avoid what does not, and say which insight a choice follows.';

export const insightsPath = (buildingDir: string): string => path.join(buildingDir, 'knowledge', INSIGHTS_FILE);

const FIELD_LABELS: Record<TargetField, string> = { views: 'views', likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves', engagementRate: 'engagement rate (%)', followersGained: 'followers gained' };
const labelOf = (platform: Platform, field: TargetField): string =>
  field === 'views' && (platform === 'linkedin' || platform === 'x') ? 'views (impressions on this platform)' : FIELD_LABELS[field];

/** The targets of one platform in words; says so when none is set. */
export function targetsText(platform: Platform, targets: Targets): string {
  const set = setFields(targets);
  const name = PLATFORM_LABELS[platform];
  return set.length ? `- ${name}: ${set.map((f) => `${labelOf(platform, f)} at least ${targets[f]}`).join(', ')}` : `- ${name}: no targets set`;
}

/** The "Targets and Insights" section every studio session and the retro carries, for the platforms the asset is for. `file` is how the Insights file is named to the reader (the retro, which runs outside the Building's folder, gets a relative name). */
export function performanceSection(ctx: ContentCtx, platforms: readonly Platform[], file = insightsPath(ctx.dir)): string {
  const unique = [...new Set(platforms)];
  const targets = unique.length
    ? `Targets for this asset's platform${unique.length > 1 ? 's' : ''} (a published post is judged on these):\n${unique.map((p) => targetsText(p, readTargets(ctx, p))).join('\n')}`
    : 'This Concept has no posts yet, so no platform targets apply.';
  return `## Targets and Insights\n\n${targets}\n\n${file} is the Insights document: what has worked and not worked on published posts. ${INSIGHTS_PATH_RULE} The \`get_performance\` tool (when you have it) returns published posts with their stats, target results and text.`;
}

/** The headless Insights agent's instructions. */
export function insightsInstructions(): string {
  return [
    'You analyse the performance of published social media and blog posts for one business and write its Insights document. Agents that write the next scripts, posts, images and videos read it before they propose anything.',
    'You are given the path of a JSON data file. Read it with your read tool and use nothing else. It holds: the newest published posts that have stats (Concept title and brief, platform, format, weekday and hour in the Building time zone, the finalized text (first 1,000 characters) and its length, the script hook (its first 3 lines), video seconds or image count, the latest stats with engagement rate, and the result against the platform targets), imported posts (the owner\'s earlier work from outside this system, marked "imported": true, which may have no stats: "stats" is null; use those for what was written, such as hooks, length and format, never as evidence of what performed), the current targets per platform, the previous Insights document, and the owner notes.',
    `Write Markdown of at most ${INSIGHTS_MARKDOWN_MAX.toLocaleString('en-US')} characters with these sections, as "## " headings, in this order: Summary, What works, What does not work, Hooks, Formats and length, Timing, Per platform, Open questions.`,
    'Rules:\n- Every claim names its evidence: how many posts it rests on and one example Concept title.\n- With fewer than 5 judged posts (a result other than too early or no target) on a platform, that platform\'s part of "Per platform" says exactly "Not enough data yet (N posts)" with N the number of its posts, and makes no claims.\n- Do not invent numbers. Say when the data is thin or mixed.\n- Keep what the previous document got right when the new data agrees, and change it when it does not.\n- Take the owner notes into account, but do not repeat them: the app shows them separately.',
    'Answer only with your final JSON per the given schema: "status" (always "done"), "message" (one short line) and "text". "text" must be exactly one JSON object and nothing else: { "markdown": string }.',
  ].join('\n\n');
}
