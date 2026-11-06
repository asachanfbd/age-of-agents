import { ContentConflictError, ContentInputError } from './errors.ts';
import { readText, versionOf, writeTextAtomic } from './files.ts';
import { SECTION_MAX_CHARS } from './limits.ts';
import { charCount } from './validate.ts';

export function parseSectionContent(value: unknown, field = 'content'): string {
  if (typeof value !== 'string') throw new ContentInputError(`${field} must be text`, field);
  if (charCount(value) > SECTION_MAX_CHARS) throw new ContentInputError(`${field} must be at most ${SECTION_MAX_CHARS} characters`, field);
  return value;
}
export function parseVersion(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ContentInputError('version is required', 'version');
  return value;
}

/** Saves a document unless the file changed since the caller read it (an agent may edit the files directly). */
export async function saveVersioned(file: string, body: Record<string, unknown>): Promise<{ content: string; version: string; changedAt: string | null }> {
  const content = parseSectionContent(body.content), version = parseVersion(body.version);
  const current = versionOf((await readText(file)).content);
  if (current !== version) throw new ContentConflictError('Changed by an agent since you opened it', { current });
  await writeTextAtomic(file, content);
  return { content, version: versionOf(content), changedAt: (await readText(file)).changedAt };
}

