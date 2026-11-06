import type { Platform } from './contentRules';
import type { ConceptDto, ExtractionReplyDto, PostDto, StatCountsDto, StatDto, StatField } from './contentTypes';
import { localDay } from './contentZone';

/** The limits below mirror server/src/content/limits.ts (the server is the judge; these give the form its messages early). */
export const COUNT_MAX = 1_000_000_000_000;
export const LIVE_URL_MAX = 2_000;
export const NOTE_MAX = 1_000;
export const WATCH_TIME_MAX = 86_400;
export const FUTURE_TOLERANCE_MS = 5 * 60_000;
export const EXTRACT_TEXT_MAX = 20_000;
export const EXTRACT_IMAGES_MAX = 10;
export const EXTRACT_IMAGE_MAX_BYTES = 10 * 1_048_576;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export const STAT_FIELDS: StatField[] = ['impressions', 'reach', 'views', 'likes', 'comments', 'shares', 'saves', 'linkClicks', 'profileVisits', 'followersGained'];
export interface PlatformField { key: StatField; label: string }
const f = (key: StatField, label: string): PlatformField => ({ key, label });
/** Duplicated from server/src/content/stats.ts; `contentStudioHelpers.test.mjs` pins them together. */
export const PLATFORM_STAT_FIELDS: Record<Platform, PlatformField[]> = {
  linkedin: [f('impressions', 'Impressions'), f('likes', 'Reactions'), f('comments', 'Comments'), f('shares', 'Reposts'), f('linkClicks', 'Clicks'), f('followersGained', 'Followers gained')],
  instagram: [f('reach', 'Reach'), f('views', 'Views'), f('likes', 'Likes'), f('comments', 'Comments'), f('shares', 'Shares'), f('saves', 'Saves'), f('profileVisits', 'Profile visits'), f('followersGained', 'Followers gained')],
  x: [f('impressions', 'Views'), f('likes', 'Likes'), f('comments', 'Replies'), f('shares', 'Reposts'), f('saves', 'Bookmarks'), f('linkClicks', 'Link clicks'), f('profileVisits', 'Profile visits')],
  facebook: [f('reach', 'Reach'), f('views', 'Views'), f('likes', 'Reactions'), f('comments', 'Comments'), f('shares', 'Shares'), f('linkClicks', 'Link clicks')],
  blog: [f('views', 'Views'), f('linkClicks', 'Link clicks'), f('comments', 'Comments')],
};
export const hasWatchTime = (format: string): boolean => format === 'video' || format === 'reel';

// ---- display ---------------------------------------------------------------
/** An unknown count reads "—", never 0. */
export const formatCount = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
/** Signed change since the previous snapshot; "—" when either side was unknown or there is no previous snapshot. */
export function formatDelta(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n > 0 ? `+${formatCount(n)}` : n < 0 ? `−${formatCount(-n)}` : '0';
}
export const formatWatchTime = (s: number | null): string => (s === null ? '—' : `${s}s`);

/** Change per field between a snapshot and the one before it (mirror of the server's `statsDelta`). */
export function statsDelta(latest: StatCountsDto, previous: StatCountsDto | null): StatCountsDto | null {
  if (!previous) return null;
  return Object.fromEntries(STAT_FIELDS.map((k) => [k, latest[k] === null || previous[k] === null ? null : latest[k]! - previous[k]!])) as StatCountsDto;
}
/** Newest captured first, ties by entry time; the first two are the latest and the one before it. */
export function sortStats(list: StatDto[]): StatDto[] {
  return [...list].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || Date.parse(b.enteredAt) - Date.parse(a.enteredAt));
}
export function latestAndPrevious(list: StatDto[]): { latest: StatDto | null; previous: StatDto | null; delta: StatCountsDto | null } {
  const [latest = null, previous = null] = sortStats(list);
  return { latest, previous, delta: latest ? statsDelta(latest.counts, previous?.counts ?? null) : null };
}
/** The one-line summary on the post row: the platform's fields that have a value, with their change. */
export function summaryLine(platform: Platform, latest: StatDto, delta: StatCountsDto | null): Array<{ label: string; value: string; delta: string | null }> {
  return PLATFORM_STAT_FIELDS[platform].filter((x) => latest.counts[x.key] !== null).map((x) => ({ label: x.label, value: formatCount(latest.counts[x.key]), delta: delta ? formatDelta(delta[x.key]) : null }));
}

// ---- Publish ---------------------------------------------------------------
export interface PostActions { publish: boolean; editPublish: boolean; unpublish: boolean; finalize: boolean; unfinalize: boolean; delete: boolean; addStats: boolean }
/** Which actions a post offers in each status (the server answers 409 for the rest). An imported post stays out of drafting: it can only be unpublished and published again. */
export function postActions(status: PostDto['status'], imported = false): PostActions {
  return {
    publish: status === 'finalized', editPublish: status === 'published', unpublish: status === 'published', finalize: !imported && status === 'draft',
    unfinalize: !imported && status === 'finalized', delete: status !== 'published', addStats: status === 'published',
  };
}
export const isHttpUrl = (text: string): boolean => { try { const u = new URL(text); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch { return false; } };
export const USED_BY_PUBLISHED = 'Used by a published post';
/** The reason Reopen is disabled for an asset, or null: a published post that needs the asset keeps it. The script is never needed by a post. */
export function reopenBlockReason(concept: Pick<ConceptDto, 'posts'>, asset: { id: string }): string | null {
  return concept.posts.some((p) => p.status === 'published' && p.needs.some((a) => a.id === asset.id)) ? USED_BY_PUBLISHED : null;
}
/** The instant a post sits on in the calendar: its published time while published, its scheduled time otherwise. */
export const placedAt = (post: Pick<PostDto, 'status' | 'publishedAt' | 'scheduledAt'>): string => (post.status === 'published' && post.publishedAt ? post.publishedAt : post.scheduledAt);
export const placedDay = (post: Pick<PostDto, 'status' | 'publishedAt' | 'scheduledAt'>, tz: string): string => localDay(Date.parse(placedAt(post)), tz);

export interface FieldCheck { errors: Record<string, string>; ok: boolean }
const result = (errors: Record<string, string>): FieldCheck => ({ errors, ok: Object.keys(errors).length === 0 });
export function checkPublishForm(url: string, publishedAt: string | null, now: number): FieldCheck {
  const errors: Record<string, string> = {};
  const text = url.trim();
  if (text.length && [...text].length > LIVE_URL_MAX) errors.liveUrl = `The URL can be at most ${LIVE_URL_MAX} characters`;
  else if (text && !isHttpUrl(text)) errors.liveUrl = 'Enter an http or https URL';
  if (!publishedAt) errors.publishedAt = 'Pick a date and time';
  else if (Date.parse(publishedAt) > now + FUTURE_TOLERANCE_MS) errors.publishedAt = 'The time cannot be in the future';
  return result(errors);
}

// ---- Stats form --------------------------------------------------------------
export interface StatForm {
  capturedAt: string | null;
  counts: Partial<Record<StatField, string>>;
  watchTime: string;
  note: string;
  /** Fields the agent filled and the owner has not touched since ("capturedAt", a count key, ...). */
  fromAgent: string[];
}
export const emptyStatForm = (capturedAt: string | null): StatForm => ({ capturedAt, counts: {}, watchTime: '', note: '', fromAgent: [] });
export function formFromStat(stat: StatDto): StatForm {
  return {
    capturedAt: stat.capturedAt,
    counts: Object.fromEntries(STAT_FIELDS.filter((k) => stat.counts[k] !== null).map((k) => [k, String(stat.counts[k])])),
    watchTime: stat.watchTime === null ? '' : String(stat.watchTime), note: stat.note, fromAgent: [],
  };
}

/** A typed count: empty is unknown (null), otherwise plain digits from 0 to 10^12. `undefined` means invalid. */
export function parseTypedCount(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n <= COUNT_MAX ? n : undefined;
}
/** Watch time: seconds with at most one decimal. `undefined` means invalid. */
export function parseTypedWatchTime(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d)?$/.test(t)) return undefined;
  const n = Number(t);
  return n <= WATCH_TIME_MAX ? n : undefined;
}

export function checkStatForm(form: StatForm, ctx: { format: string; publishedAt: string; now: number }): FieldCheck {
  const errors: Record<string, string> = {};
  if (!form.capturedAt) errors.capturedAt = 'Pick a date and time';
  else if (Date.parse(form.capturedAt) > ctx.now + FUTURE_TOLERANCE_MS) errors.capturedAt = 'The time cannot be in the future';
  else if (Date.parse(form.capturedAt) < Date.parse(ctx.publishedAt)) errors.capturedAt = 'The time cannot be before the post was published';
  let any = false;
  for (const [key, text] of Object.entries(form.counts)) {
    const n = parseTypedCount(text ?? '');
    if (n === undefined) errors[key] = 'Whole number from 0 to 1,000,000,000,000';
    else if (n !== null) any = true;
  }
  if (!any && !Object.keys(errors).some((k) => k !== 'capturedAt')) errors.counts = 'Enter at least one count';
  if (parseTypedWatchTime(form.watchTime) === undefined) errors.watchTime = 'Seconds with at most 1 decimal';
  else if (form.watchTime.trim() && !hasWatchTime(ctx.format)) errors.watchTime = 'Only for video and reel posts';
  if ([...form.note].length > NOTE_MAX) errors.note = `The note can be at most ${NOTE_MAX.toLocaleString('en-US')} characters`;
  return result(errors);
}

/** The request body for a checked form; unknown counts are sent as null. */
export function statBody(form: StatForm, platform: Platform, extractionId?: string) {
  const counts = Object.fromEntries(PLATFORM_STAT_FIELDS[platform].map((x) => [x.key, parseTypedCount(form.counts[x.key] ?? '') ?? null]));
  const watch = parseTypedWatchTime(form.watchTime);
  return { capturedAt: form.capturedAt!, counts, watchTime: watch ?? null, note: form.note.trim(), ...(extractionId ? { extractionId } : {}) };
}

export interface Prefilled { form: StatForm; unused: string[] }
/** Applies the agent's answer to the form: only values it read are filled (and marked); a missing capturedAt keeps the form's. */
export function applyExtraction(form: StatForm, reply: Extract<ExtractionReplyDto, { ok: true }>): Prefilled {
  const counts = { ...form.counts };
  const marks = new Set(form.fromAgent);
  for (const [key, n] of Object.entries(reply.counts)) if (n !== null && n !== undefined) { counts[key as StatField] = String(n); marks.add(key); }
  const capturedAt = reply.capturedAt ?? form.capturedAt;
  if (reply.capturedAt) marks.add('capturedAt');
  return { form: { ...form, counts, capturedAt, fromAgent: [...marks] }, unused: reply.unused };
}
/** The mark goes away once the owner changes that field. */
export const clearMark = (form: StatForm, key: string): StatForm => ({ ...form, fromAgent: form.fromAgent.filter((k) => k !== key) });
export const unusedText = (unused: string[]): string | null => (unused.length ? `Not used: ${unused.join(', ')}` : null);
export const failureText = (reason: string): string => `Could not read the stats: ${reason}`;

/** The upload checks before anything is sent. */
export function checkUpload(text: string, files: Array<{ type: string; size: number }>): string | null {
  if (!text.trim() && !files.length) return 'Paste the stats text or add a screenshot';
  if ([...text].length > EXTRACT_TEXT_MAX) return `The text can be at most ${EXTRACT_TEXT_MAX.toLocaleString('en-US')} characters`;
  if (files.length > EXTRACT_IMAGES_MAX) return `At most ${EXTRACT_IMAGES_MAX} images`;
  if (files.some((x) => !IMAGE_TYPES.includes(x.type))) return 'Images must be PNG, JPEG or WebP';
  if (files.some((x) => x.size > EXTRACT_IMAGE_MAX_BYTES)) return 'Each image can be at most 10 MB';
  return null;
}
/** Whether closing the form must discard its extraction: one that was never saved. */
export const shouldDiscard = (extractionId: string | null, saved: boolean): boolean => extractionId !== null && !saved;

/** What "Most views" ranks a Concept by: its best published post's latest views (impressions where a platform reports views under that name); null without stats. */
export function conceptViews(concept: Pick<ConceptDto, 'posts'>): number | null {
  let best: number | null = null;
  for (const post of concept.posts) {
    const counts = post.status === 'published' ? post.stats?.latest?.counts : undefined;
    const views = counts ? (counts.views ?? counts.impressions) : null;
    if (views !== null && views !== undefined && (best === null || views > best)) best = views;
  }
  return best;
}
