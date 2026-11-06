import { randomUUID } from 'node:crypto';
import type { ContentCtx } from './context.ts';
import { deleteMeta, readMeta, writeMeta } from './db.ts';
import { ContentInputError, ContentNotFoundError } from './errors.ts';

export const SPEAKING_WPM_KEY = 'speakingWpm';
export const SPEAKING_WPM_DEFAULT = 150;
export const SPEAKING_WPM_MIN = 20;
export const SPEAKING_WPM_MAX = 400;

/**
 * Where the speed comes from: `default` until something sets it, `detected` once the video agent has reported recordings, and
 * `manual` when the owner saved a value, which stays authoritative until it is cleared.
 */
export type SpeakingSpeedSource = 'default' | 'manual' | 'detected';
export interface SpeakingSpeed { speakingWpm: number; source: SpeakingSpeedSource; sampleCount: number }

const inRange = (n: number): boolean => Number.isInteger(n) && n >= SPEAKING_WPM_MIN && n <= SPEAKING_WPM_MAX;

/** The detected speed of one recording must be plausible speech. */
export const SAMPLE_WPM_MIN = 40;
export const SAMPLE_WPM_MAX = 400;
export const SAMPLE_WORDS_MIN = 5;
export const SAMPLE_SECONDS_MIN = 3;
export const SAMPLE_SECONDS_MAX = 7200;

interface SampleRow { id: string; mediaId: string; conceptId: string; wordsPerMinute: number; words: number; durationSeconds: number; createdAt: number }

export interface SpeakingRateSample extends Omit<SampleRow, 'createdAt'> { mediaName: string; createdAt: string }

/** The Building's recordings, oldest first. */
export function speakingRateSamples(ctx: ContentCtx): SpeakingRateSample[] {
  const rows = ctx.db.prepare(`SELECT s.*, m.name AS mediaName FROM speaking_rate_samples s JOIN media m ON m.id = s.mediaId ORDER BY s.createdAt, s.seq`)
    .all() as Array<SampleRow & { mediaName: string; seq: number }>;
  return rows.map(({ seq: _seq, createdAt, ...r }) => ({ ...r, createdAt: new Date(createdAt).toISOString() }));
}

/** The Building's speaking speed; a manual value that is not a whole number in range reads as unset. */
export function speakingSpeed(ctx: ContentCtx): SpeakingSpeed {
  const raw = readMeta(ctx.db, SPEAKING_WPM_KEY);
  const stored = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const { words, seconds, count } = ctx.db.prepare('SELECT COALESCE(SUM(words), 0) AS words, COALESCE(SUM(durationSeconds), 0) AS seconds, COUNT(*) AS count FROM speaking_rate_samples').get() as { words: number; seconds: number; count: number };
  if (inRange(stored)) return { speakingWpm: stored, source: 'manual', sampleCount: count };
  if (count > 0) return { speakingWpm: Math.round(words / (seconds / 60)), source: 'detected', sampleCount: count };
  return { speakingWpm: SPEAKING_WPM_DEFAULT, source: 'default', sampleCount: 0 };
}

/** Drops the owner's value so the detected average (or the default) applies again. A no-op when none is saved. */
export const clearManualSpeakingWpm = (ctx: ContentCtx): void => deleteMeta(ctx.db, SPEAKING_WPM_KEY);

/** Removes one recording; the speed is recomputed from the rest. */
export function deleteSpeakingRateSample(ctx: ContentCtx, id: string): void {
  if (ctx.db.prepare('DELETE FROM speaking_rate_samples WHERE id = ?').run(id).changes === 0) throw new ContentNotFoundError('That recording does not exist');
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Stores what the agent measured for one audio or video file of the Concept; a second report for the same file replaces the first
 * and keeps its id. Returns the sample's rate.
 */
export function recordSpeakingRate(ctx: ContentCtx, conceptId: string, body: Record<string, unknown>): { id: string; wordsPerMinute: number } {
  const { mediaId, words, durationSeconds } = body;
  if (typeof mediaId !== 'string' || !mediaId || mediaId.length > 100) throw new ContentInputError('mediaId must be the id of a media file', 'mediaId');
  if (!isNumber(words) || !Number.isSafeInteger(words) || words < SAMPLE_WORDS_MIN) throw new ContentInputError(`words must be a whole number of at least ${SAMPLE_WORDS_MIN}`, 'words');
  if (!isNumber(durationSeconds) || durationSeconds < SAMPLE_SECONDS_MIN || durationSeconds > SAMPLE_SECONDS_MAX) {
    throw new ContentInputError(`durationSeconds must be from ${SAMPLE_SECONDS_MIN} to ${SAMPLE_SECONDS_MAX}`, 'durationSeconds');
  }
  const media = ctx.db.prepare('SELECT kind FROM media WHERE id = ? AND conceptId = ?').get(mediaId, conceptId) as { kind: string } | undefined;
  if (!media || (media.kind !== 'video' && media.kind !== 'audio')) throw new ContentInputError("mediaId must be one of this Concept's video or audio files", 'mediaId');
  const wordsPerMinute = words / (durationSeconds / 60);
  if (!(wordsPerMinute >= SAMPLE_WPM_MIN && wordsPerMinute <= SAMPLE_WPM_MAX)) {
    throw new ContentInputError(`The rate is ${Math.round(wordsPerMinute)} words per minute; speech is from ${SAMPLE_WPM_MIN} to ${SAMPLE_WPM_MAX}. Check the word count and the duration`, 'wordsPerMinute');
  }
  const existing = ctx.db.prepare('SELECT id FROM speaking_rate_samples WHERE mediaId = ?').get(mediaId) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  ctx.db.prepare(`INSERT INTO speaking_rate_samples (id, mediaId, conceptId, wordsPerMinute, words, durationSeconds, createdAt, source, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'agent', COALESCE((SELECT MAX(seq) FROM speaking_rate_samples), 0) + 1)
    ON CONFLICT(mediaId) DO UPDATE SET wordsPerMinute = excluded.wordsPerMinute, words = excluded.words, durationSeconds = excluded.durationSeconds, createdAt = excluded.createdAt, seq = excluded.seq`)
    .run(id, mediaId, conceptId, wordsPerMinute, words, durationSeconds, ctx.now());
  return { id, wordsPerMinute };
}

export function parseSpeakingWpm(value: unknown): number {
  if (typeof value !== 'number' || !inRange(value)) {
    throw new ContentInputError(`speakingWpm must be a whole number from ${SPEAKING_WPM_MIN} to ${SPEAKING_WPM_MAX}`, SPEAKING_WPM_KEY);
  }
  return value;
}

/** Any saved value, the default included, is the owner's choice and reads back as `manual`. */
export const saveSpeakingWpm = (ctx: ContentCtx, wpm: number): void => writeMeta(ctx.db, SPEAKING_WPM_KEY, String(wpm));
