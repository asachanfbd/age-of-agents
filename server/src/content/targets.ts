import type { ContentCtx } from './context.ts';
import { deleteMeta, readMeta, writeMeta } from './db.ts';
import { ContentInputError } from './errors.ts';
import { isPlatform, PLATFORMS } from './rules.ts';
import type { Platform } from './rules.ts';
import { COUNT_TARGET_MAX, emptyTargets, TARGET_FIELDS } from './targetRules.ts';
import type { TargetField, Targets } from './targetRules.ts';

/** The newest target changes kept and shown. */
export const TARGET_HISTORY_MAX = 50;
export const EVALUATION_DAYS_DEFAULT = 7;
export const EVALUATION_DAYS_KEY = 'evaluationDays';

export interface TargetHistoryEntry { id: number; at: string; who: 'person'; platform: Platform; before: Targets; after: Targets }

const targetsKey = (platform: Platform): string => `targets.${platform}`;

export function parsePlatformParam(value: unknown): Platform {
  if (!isPlatform(value)) throw new ContentInputError('platform must be linkedin, instagram, x, facebook or blog', 'platform');
  return value;
}

export function readTargets(ctx: ContentCtx, platform: Platform): Targets {
  const raw = readMeta(ctx.db, targetsKey(platform));
  return raw ? { ...emptyTargets(), ...(JSON.parse(raw) as Partial<Targets>) } : emptyTargets();
}

export const readAllTargets = (ctx: ContentCtx): Record<Platform, Targets> =>
  Object.fromEntries(PLATFORMS.map((p) => [p, readTargets(ctx, p)])) as Record<Platform, Targets>;

export function evaluationDays(ctx: ContentCtx): number {
  const raw = readMeta(ctx.db, EVALUATION_DAYS_KEY);
  return raw === undefined ? EVALUATION_DAYS_DEFAULT : Number(raw);
}

/** Whole days from 1 to 90. */
export function parseEvaluationDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 90) {
    throw new ContentInputError('evaluationDays must be a whole number of days from 1 to 90', EVALUATION_DAYS_KEY);
  }
  return value;
}

export function saveEvaluationDays(ctx: ContentCtx, days: number): void {
  if (days === EVALUATION_DAYS_DEFAULT) deleteMeta(ctx.db, EVALUATION_DAYS_KEY); else writeMeta(ctx.db, EVALUATION_DAYS_KEY, String(days));
}

function parseTarget(field: TargetField, value: unknown): number | null {
  if (value === null) return null;
  if (field === 'engagementRate') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || Math.round(value * 100) / 100 !== value) {
      throw new ContentInputError('engagementRate must be a percent from 0 to 100 with at most 2 decimals', field);
    }
    return value;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > COUNT_TARGET_MAX) {
    throw new ContentInputError(`${field} must be a whole number from 0 to ${COUNT_TARGET_MAX}`, field);
  }
  return value;
}

/** A body over `base`: an explicit `null` clears a field, an omitted key keeps it, an unknown key is refused. */
export function parseTargets(body: unknown, base: Targets): Targets {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ContentInputError('The request body must be a JSON object');
  const out = { ...base };
  for (const [key, raw] of Object.entries(body)) {
    if (!(TARGET_FIELDS as readonly string[]).includes(key)) throw new ContentInputError(`${key} is not a target field`, key);
    out[key as TargetField] = parseTarget(key as TargetField, raw);
  }
  return out;
}

const sameTargets = (a: Targets, b: Targets): boolean => TARGET_FIELDS.every((f) => a[f] === b[f]);

/** Saves one platform's targets. Answers whether anything changed; a change adds a history entry and the table keeps the newest `TARGET_HISTORY_MAX`. */
export function putTargets(ctx: ContentCtx, platform: Platform, body: unknown): { targets: Targets; changed: boolean } {
  const before = readTargets(ctx, platform);
  const after = parseTargets(body, before);
  if (sameTargets(before, after)) return { targets: before, changed: false };
  ctx.db.transaction(() => {
    writeMeta(ctx.db, targetsKey(platform), JSON.stringify(after));
    ctx.db.prepare('INSERT INTO target_history (at, who, platform, oldValues, newValues) VALUES (?, ?, ?, ?, ?)').run(ctx.now(), 'person', platform, JSON.stringify(before), JSON.stringify(after));
    ctx.db.prepare('DELETE FROM target_history WHERE id NOT IN (SELECT id FROM target_history ORDER BY id DESC LIMIT ?)').run(TARGET_HISTORY_MAX);
  })();
  return { targets: after, changed: true };
}

export function targetHistory(ctx: ContentCtx): TargetHistoryEntry[] {
  const rows = ctx.db.prepare('SELECT * FROM target_history ORDER BY id DESC LIMIT ?').all(TARGET_HISTORY_MAX) as Array<{ id: number; at: number; who: 'person'; platform: Platform; oldValues: string; newValues: string }>;
  return rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), who: r.who, platform: r.platform, before: JSON.parse(r.oldValues) as Targets, after: JSON.parse(r.newValues) as Targets }));
}
