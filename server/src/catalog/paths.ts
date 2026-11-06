import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Path-traversal guards for the Catalog's filesystem writes. Structurally
 * parallel to `projects/fileTree.ts`'s `resolveSafePath` (same two-layer
 * approach: a syntactic check, then a realpath check that also catches a
 * symlink escape) but kept as its own small copy rather than imported,
 * because the root here is `.claude/agents/` or a single skill's own folder
 * under `.claude/skills/`, not an arbitrary Project's working directory, and
 * the error messages should say so plainly rather than talk about "the
 * project root".
 */

export class CatalogPathTraversalError extends Error {
  constructor(kind: string, requested: string) {
    super(`That ${kind} isn't valid — it resolves outside the Catalog's managed directory`);
    this.name = 'CatalogPathTraversalError';
  }
}

export class InvalidIdError extends Error {
  constructor(kind: string, rule = 'use only letters, digits, "-" and "_"') {
    super(`That ${kind} isn't valid — ${rule}`);
    this.name = 'InvalidIdError';
  }
}

/** Agent ids (→ `<id>.md`) and skill ids (→ a folder of that name) are both plain slugs — no dots, slashes, or leading punctuation, so a resolved path can never contain a traversal segment in the first place. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function assertValidId(kind: string, id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new InvalidIdError(`${kind} id`);
}

/** A skill support-file name — allows the dots a real filename needs (unlike an id), but still rejects anything that could change directory or collide with the reserved SKILL.md. */
export function assertSafeFileName(name: unknown): asserts name is string {
  const valid = typeof name === 'string' && name.trim() !== '' && name !== 'SKILL.md'
    && !name.includes('/') && !name.includes('\\') && !name.startsWith('.') && !name.includes('\0');
  if (!valid) throw new InvalidIdError('skill support file name', 'it must not be empty or SKILL.md, start with ".", or contain a slash');
}

function assertWithin(root: string, target: string, kind: string, requested: string): void {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new CatalogPathTraversalError(kind, requested);
  }
}

/**
 * Resolves `segment` against `root`, rejecting (never clamping) anything
 * that lands outside it, including via a symlink already sitting inside
 * `root` whose target escapes it. Safe to call for a path that doesn't
 * exist yet (the common case here — most callers are about to create it):
 * the realpath check is skipped, not treated as an error, when the target
 * is simply missing.
 */
export async function resolveWithinCatalogDir(root: string, segment: string, kind: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, segment);
  assertWithin(resolvedRoot, resolvedTarget, kind, segment);

  const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
  let realTarget: string;
  try {
    realTarget = await realpath(resolvedTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolvedTarget;
    throw error;
  }
  assertWithin(realRoot, realTarget, kind, segment);
  return resolvedTarget;
}

export async function agentFilePath(agentsDir: string, id: string): Promise<string> {
  assertValidId('agent', id);
  return resolveWithinCatalogDir(agentsDir, `${id}.md`, 'agent id');
}

export async function skillDirPath(skillsDir: string, id: string): Promise<string> {
  assertValidId('skill', id);
  return resolveWithinCatalogDir(skillsDir, id, 'skill id');
}

export async function skillFilePath(skillDir: string, fileName: string): Promise<string> {
  assertSafeFileName(fileName);
  return resolveWithinCatalogDir(skillDir, fileName, 'skill support file');
}
