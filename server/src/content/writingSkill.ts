import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { deleteMeta, readMeta, writeMeta } from './db.ts';
import { ContentInputError } from './errors.ts';
import { SKILL_PATH_MAX } from './limits.ts';

export const WRITING_SKILL_KEY = 'writingSkillFile';

/** Where the human-content-writing skill lives unless the Building's Settings name another file. */
export const defaultWritingSkillFile = (home: string = homedir()): string => path.join(home, '.claude', 'skills', 'human-content-writing-skill', 'SKILL.md');

/** The Building's override, or null when it uses the default. */
export const writingSkillOverride = (ctx: ContentCtx): string | null => readMeta(ctx.db, WRITING_SKILL_KEY) ?? null;

export const writingSkillPath = (ctx: ContentCtx, home?: string): string => writingSkillOverride(ctx) ?? defaultWritingSkillFile(home);

/** An absolute path to an existing readable file; empty or null clears the override (the default applies). */
export async function parseWritingSkillFile(value: unknown): Promise<string | null> {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ContentInputError('writingSkillFile must be a file path', WRITING_SKILL_KEY);
  const file = value.trim();
  if (!file) return null;
  const fail = (message: string) => new ContentInputError(message, WRITING_SKILL_KEY);
  if (file.length > SKILL_PATH_MAX) throw fail(`writingSkillFile must be at most ${SKILL_PATH_MAX} characters`);
  if (file.includes('\0')) throw fail('writingSkillFile must not contain a NUL character');
  if (!path.isAbsolute(file)) throw fail('writingSkillFile must be an absolute path');
  try {
    if (!(await stat(file)).isFile()) throw fail('writingSkillFile must be a file, not a folder');
    await access(file, constants.R_OK);
  } catch (error) {
    if (error instanceof ContentInputError) throw error;
    throw fail('writingSkillFile must be an existing readable file');
  }
  return file;
}

export function saveWritingSkillOverride(ctx: ContentCtx, file: string | null): void {
  if (file === null) deleteMeta(ctx.db, WRITING_SKILL_KEY);
  else writeMeta(ctx.db, WRITING_SKILL_KEY, file);
}

/** The skill's full text, or null when the file is missing, a folder or unreadable. */
export async function readWritingSkill(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}
