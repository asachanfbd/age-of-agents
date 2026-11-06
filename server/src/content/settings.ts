import { renameProject } from '../projects/projectService.ts';
import type { ProjectRecord } from '../domain/types.ts';
import type { ContentCtx } from './context.ts';
import { readMeta, writeMeta } from './db.ts';
import { ContentInputError } from './errors.ts';
import { TIMEZONE_KEY } from './runtime.ts';
import { parseSpeakingWpm, saveSpeakingWpm, speakingSpeed } from './speakingSpeed.ts';
import type { SpeakingSpeed } from './speakingSpeed.ts';
import { evaluationDays, parseEvaluationDays, saveEvaluationDays } from './targets.ts';
import { parseName, parseTimezone } from './validate.ts';
import { defaultWritingSkillFile, parseWritingSkillFile, saveWritingSkillOverride, writingSkillOverride } from './writingSkill.ts';

export interface SettingsView {
  name: string;
  timezone: string;
  /** The Building's folder, which agents are pointed at. */
  folder: string;
  /** The Building's own "Writing skill file", or null when the default applies. */
  writingSkillFile: string | null;
  /** The file used when `writingSkillFile` is null. */
  defaultWritingSkillFile: string;
  /** "Apply retro changes without review": a valid retro proposal is applied at once. */
  autoApplyRetro: boolean;
  /** "Judge a post after N days": a post's results use its first snapshot captured at least this long after publishing. */
  evaluationDays: number;
  /** "Speaking speed (words per minute)": the Script footer's estimated length uses it. */
  speakingSpeed: SpeakingSpeed;
}

export const AUTO_APPLY_RETRO_KEY = 'autoApplyRetro';
export const autoApplyRetro = (ctx: ContentCtx): boolean => readMeta(ctx.db, AUTO_APPLY_RETRO_KEY) === 'true';

function parseAutoApplyRetro(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ContentInputError('autoApplyRetro must be true or false', AUTO_APPLY_RETRO_KEY);
  return value;
}

export const settingsView = (ctx: ContentCtx, project: ProjectRecord): SettingsView => ({
  name: project.name, timezone: ctx.timezone(), folder: ctx.dir,
  writingSkillFile: writingSkillOverride(ctx), defaultWritingSkillFile: defaultWritingSkillFile(), autoApplyRetro: autoApplyRetro(ctx), evaluationDays: evaluationDays(ctx),
  speakingSpeed: speakingSpeed(ctx),
});

export async function updateSettings(ctx: ContentCtx, project: ProjectRecord, body: unknown): Promise<SettingsView> {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = b.name === undefined ? undefined : parseName(b.name);
  const timezone = b.timezone === undefined ? undefined : parseTimezone(b.timezone);
  const skillFile = b.writingSkillFile === undefined ? undefined : await parseWritingSkillFile(b.writingSkillFile);
  const autoApply = b.autoApplyRetro === undefined ? undefined : parseAutoApplyRetro(b.autoApplyRetro);
  const days = b.evaluationDays === undefined ? undefined : parseEvaluationDays(b.evaluationDays);
  const wpm = b.speakingWpm === undefined ? undefined : parseSpeakingWpm(b.speakingWpm);
  if (days !== undefined) saveEvaluationDays(ctx, days);
  if (wpm !== undefined) saveSpeakingWpm(ctx, wpm);
  if (timezone !== undefined) writeMeta(ctx.db, TIMEZONE_KEY, timezone);
  if (skillFile !== undefined) saveWritingSkillOverride(ctx, skillFile);
  if (autoApply !== undefined) writeMeta(ctx.db, AUTO_APPLY_RETRO_KEY, String(autoApply));
  if (name !== undefined && name !== project.name) await renameProject(project.id, name);
  return settingsView(ctx, { ...project, name: name ?? project.name });
}
