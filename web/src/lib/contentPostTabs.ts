/**
 * The Post content, Captions and Blog tabs: which posts each covers, the post switcher, the context line and the
 * result pane's counters, thread cards and copy text. Pure, so each rule is tested on its own.
 */
import { charCount, countHashtags, formatCount, PLATFORM_LIMITS, PLATFORM_RULE_TEXT, splitThread } from './contentLimits';
import { PLATFORM_LABELS, TEXT_NAMES } from './contentRules';
import type { AssetState, ConceptTab, Platform } from './contentRules';
import type { AssetDto, PostDto } from './contentTypes';
import { assetStateLabel, formatLabel } from './contentView';

export type PostTextTab = Extract<ConceptTab, 'post-content' | 'captions' | 'blog'>;

export const POST_TEXT_TABS: Record<PostTextTab, { platforms: readonly Platform[]; label: string }> = {
  'post-content': { platforms: ['linkedin', 'x', 'facebook'], label: 'LinkedIn, X and Facebook posts' },
  captions: { platforms: ['instagram'], label: 'Instagram posts' },
  blog: { platforms: ['blog'], label: 'Blog posts' },
};

export const isPostTextTab = (tab: string): tab is PostTextTab => tab in POST_TEXT_TABS;

/** The posts a tab covers, in the Concept's order. */
export const postsForTab = (posts: PostDto[], tab: PostTextTab): PostDto[] => posts.filter((p) => POST_TEXT_TABS[tab].platforms.includes(p.platform));

/** The post's text asset: the post text, or the article of a blog post. */
export const textAssetOf = (post: PostDto): AssetDto | undefined => post.needs.find((a) => a.kind === 'post-text' || a.kind === 'article');

const textState = (post: PostDto): AssetState => textAssetOf(post)?.state ?? 'empty';

/** The switcher opens on the first post whose text is not finalized, else the first; null when the tab has none. */
export const defaultPostId = (posts: PostDto[]): string | null => (posts.find((p) => textState(p) !== 'finalized') ?? posts[0])?.id ?? null;

/** The chosen post while it still exists; otherwise (deleted, or nothing chosen yet) the default. */
export const selectedPostId = (posts: PostDto[], chosen: string | null): string | null => (posts.some((p) => p.id === chosen) ? chosen : defaultPostId(posts));

/** Arrow keys move between chips and wrap at both ends. */
export function nextChipIndex(index: number, count: number, key: string): number {
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  return index;
}

export interface PostChipModel { id: string; platform: Platform; platformLabel: string; format: string; scheduledAt: string; state: AssetState; stateLabel: string }
export const postChipModel = (post: PostDto): PostChipModel => ({
  id: post.id, platform: post.platform, platformLabel: PLATFORM_LABELS[post.platform], format: formatLabel(post.format), scheduledAt: post.scheduledAt,
  state: textState(post), stateLabel: assetStateLabel(textState(post)),
});

export const switcherLabel = (tab: PostTextTab, count: number): string => `${POST_TEXT_TABS[tab].label} · ${count} ${count === 1 ? 'post' : 'posts'}`;

/** The full scheduled date and time in the Building zone. */
export const fullDateText = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(instant));

export interface ContextLine { title: string; rest: string }
/** The line under the switcher: platform · format (bold), then the full date and the platform rule. */
export const contextLine = (post: PostDto, timeZone: string): ContextLine => ({
  title: `${PLATFORM_LABELS[post.platform]} · ${formatLabel(post.format)}`,
  rest: `scheduled ${fullDateText(post.scheduledAt, timeZone)} · ${PLATFORM_RULE_TEXT[post.platform]}`,
});

/** From this share of a limit the counter warns. */
export const NEAR_LIMIT = 0.9;

export interface Counter { label: string; status: string; near: boolean; percent: number }
/** "1,284 / 3,000 characters" (a tweet card leaves the unit out) with what is left; near and at the limit say so in words, not only in colour. */
export function counter(count: number, max: number, unit: string): Counter {
  const near = count >= max * NEAR_LIMIT;
  const status = count > max ? `Over the limit by ${formatCount(count - max)}`
    : count === max ? 'At the limit'
      : near ? `Near the limit · ${formatCount(max - count)} left` : `${formatCount(max - count)} left`;
  return { label: `${formatCount(count)} / ${formatCount(max)}${unit ? ` ${unit}` : ''}`, status, near, percent: Math.min(100, (count / max) * 100) };
}

/** The blog shows its count against the allowed range, without a meter. */
export const blogCounter = (text: string): string => {
  const { min, max } = PLATFORM_LIMITS.blog;
  return `${formatCount(charCount(text))} characters · allowed ${formatCount(min!)} to ${formatCount(max)}`;
};

/** The counters under a LinkedIn, Facebook or Instagram text (characters, and hashtags on Instagram). */
export function textCounters(platform: Platform, text: string): Counter[] {
  const limit = PLATFORM_LIMITS[platform];
  const out = [counter(charCount(text), limit.max, 'characters')];
  if (limit.maxHashtags !== undefined) out.push(counter(countHashtags(text), limit.maxHashtags, 'hashtags'));
  return out;
}

export interface TweetCard { index: number; label: string; text: string; counter: Counter; copyLabel: string }
export interface ThreadView { heading: string; tweets: TweetCard[] }
/** An X draft as tweet cards: "Thread · N tweets (up to 25)" or "Single tweet", each tweet with its own count. */
export function threadView(text: string): ThreadView {
  const { max, maxTweets } = PLATFORM_LIMITS.x;
  const tweets = splitThread(text);
  return {
    heading: tweets.length > 1 ? `Thread · ${tweets.length} tweets (up to ${maxTweets})` : 'Single tweet',
    tweets: tweets.map((t, i) => ({ index: i, label: `Tweet ${i + 1} of ${tweets.length}`, text: t, counter: counter(charCount(t), max, ''), copyLabel: `Copy tweet ${i + 1}` })),
  };
}

/** What the header Copy puts on the clipboard: an X thread's tweets separated by a blank line, otherwise the raw text (Markdown for the blog). */
export const copyTextFor = (platform: Platform, text: string): string => (platform === 'x' ? splitThread(text).join('\n\n') : text);

export const copyLabelFor = (platform: Platform, text: string): string =>
  platform === 'x' && splitThread(text).length > 1 ? 'Copy thread' : platform === 'blog' ? 'Copy Markdown' : 'Copy';

/** What the text is called on its platform, in lower case ("tweet", "article"). */
export const textNameOf = (platform: Platform): string => (platform === 'blog' ? 'article' : TEXT_NAMES[platform].toLowerCase());

/** Shown once the text is final: finalizing it does not finalize the post. */
export const finalizedNote = (platform: Platform): { before: string; link: string; after: string } =>
  ({ before: `This ${textNameOf(platform)} is final. The post itself is finalized from `, link: 'Overview', after: ' once all its assets are final.' });
