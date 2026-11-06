/**
 * The text limits of each platform, and the pure rules that count against them: code points, X threads and Instagram
 * hashtags. The result pane counts with them; the daemon enforces them on `save_draft`. `server/src/content/platformLimits.ts`
 * holds the same table and counting rules (the packages cannot import each other); `server/tests/platformLimits.test.ts (U02)` pins them together.
 *
 * Simplifications: characters are code points, so an emoji with a variation selector counts 2 and X's own counting
 * (a URL as 23) is not modelled; a `#word` inside a URL counts as a hashtag.
 */
import type { Platform } from './contentRules.ts';

export interface PlatformLimit {
  /** Fewest characters (the blog article only). */
  min?: number;
  /** Most characters: of the whole text, or of each tweet on X. */
  max: number;
  /** Most tweets in an X thread. */
  maxTweets?: number;
  /** Most hashtags (Instagram). */
  maxHashtags?: number;
}

export const PLATFORM_LIMITS: Record<Platform, PlatformLimit> = {
  linkedin: { max: 3_000 },
  x: { max: 280, maxTweets: 25 },
  facebook: { max: 63_206 },
  instagram: { max: 2_200, maxHashtags: 30 },
  blog: { min: 300, max: 50_000 },
};

/** Each platform's rule in plain words, for the agent's instructions and the line under the post switcher. */
export const PLATFORM_RULE_TEXT: Record<Platform, string> = {
  linkedin: 'Post text up to 3,000 characters',
  facebook: 'Post text up to 63,206 characters',
  x: 'One tweet up to 280 characters, or a thread of up to 25 tweets split by a line with only ---',
  instagram: 'Caption up to 2,200 characters and 30 hashtags',
  blog: 'Markdown article starting with a # title, 300 to 50,000 characters',
};

export const THREAD_SEPARATOR = '---';

/** Characters are code points, not UTF-16 units. */
export const charCount = (s: string): number => [...s].length;

/** Thousands separators, as every message and counter shows a number. */
export const formatCount = (n: number): string => n.toLocaleString('en-US');

/**
 * The tweets of an X draft: a line whose only content (ignoring spaces, tabs and `\r`) is `---` separates them. Each
 * tweet is trimmed and empty ones are dropped, so a leading, trailing or doubled separator adds no empty tweet.
 */
export function splitThread(text: string): string[] {
  const tweets: string[] = [];
  let lines: string[] = [];
  const flush = () => { const tweet = lines.join('\n').trim(); if (tweet) tweets.push(tweet); lines = []; };
  for (const line of text.split('\n')) {
    if (line.replace(/[ \t\r]/g, '') === THREAD_SEPARATOR) flush();
    else lines.push(line);
  }
  flush();
  return tweets;
}

/** A hashtag is `#` followed by letters, digits or `_`. */
export const countHashtags = (text: string): number => (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
