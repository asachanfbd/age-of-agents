import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveSafePath } from './fileTree.ts';

/**
 * Creating an empty file or folder from the project popup's file browsers (the Documents and Code
 * tabs). Each caller picks its own root and naming rules. The path comes from an HTTP request, so it
 * is checked segment by segment and then resolved through `resolveSafePath` before anything is written.
 */

export type EntryType = 'file' | 'folder';

export class EntryExistsError extends Error {
  constructor(entryPath: string) {
    super(`"${entryPath}" already exists`);
    this.name = 'EntryExistsError';
  }
}

export class InvalidEntryPathError extends Error {
  constructor(entryPath: string, reason = 'use folder/file names without empty parts, "." or ".."') {
    super(`"${entryPath}" is not a valid path — ${reason}`);
    this.name = 'InvalidEntryPathError';
  }
}

/** Splits a requested path into trimmed segments, accepting `\` as a separator and rejecting empty, `.` and `..` parts. */
export function entryPathSegments(relativePath: string): string[] {
  const segments = String(relativePath).trim().replace(/\\/g, '/').split('/').map((segment) => segment.trim());
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new InvalidEntryPathError(relativePath);
  return segments;
}

/** Creates an empty file or folder at `normalized` (relative to `root`), making any missing parent folders. Never overwrites. */
export async function createEntry(root: string, normalized: string, type: EntryType): Promise<string> {
  const target = await resolveSafePath(root, normalized);

  const existing = await stat(target).catch(() => null);
  if (existing) throw new EntryExistsError(normalized);

  if (type === 'folder') {
    await mkdir(target, { recursive: true });
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '', { encoding: 'utf-8', flag: 'wx' });
  }
  return normalized;
}
