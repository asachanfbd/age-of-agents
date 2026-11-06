import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOCS_DIR } from './blueprint.ts';
import { NotAFileError, readFileSafely, resolveSafePath } from './fileTree.ts';
import type { FileReadResult } from './fileTree.ts';
import { createEntry, entryPathSegments } from './projectEntries.ts';
import type { EntryType } from './projectEntries.ts';

/**
 * The Documents tab's editable view of a Project's whole `.docs/` folder — every file and folder in
 * it, not just the blueprint and plan documents `documents.ts` lists. Every path here comes from an
 * HTTP request, so each one resolves through `resolveSafePath` against the docs directory itself
 * (never the wider project), the same guard the Code tab's reader uses.
 */

export interface DocsTree {
  /** Relative file paths inside `.docs`, POSIX-separated, sorted. */
  files: string[];
  /** Relative folder paths inside `.docs`, POSIX-separated, sorted — includes empty folders. */
  folders: string[];
}

const docsRoot = (projectRoot: string) => path.join(projectRoot, DOCS_DIR);

/** Lists every file and folder under `.docs/`; a project with no docs folder yet has an empty tree. */
export async function listDocsTree(projectRoot: string): Promise<DocsTree> {
  const tree: DocsTree = { files: [], folders: [] };
  await walk(docsRoot(projectRoot), '', tree);
  tree.files.sort((a, b) => a.localeCompare(b));
  tree.folders.sort((a, b) => a.localeCompare(b));
  return tree;
}

async function walk(directory: string, prefix: string, tree: DocsTree): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      tree.folders.push(relative);
      await walk(path.join(directory, entry.name), relative, tree);
    } else if (entry.isFile()) {
      tree.files.push(relative);
    }
  }
}

export function readDocsFile(projectRoot: string, relativePath: string): Promise<FileReadResult> {
  return readFileSafely(docsRoot(projectRoot), relativePath);
}

/** Overwrites an existing docs file — editing never creates one (see `createDocsEntry`). */
export async function writeDocsFile(projectRoot: string, relativePath: string, content: string): Promise<void> {
  const target = await resolveSafePath(docsRoot(projectRoot), relativePath);
  const info = await stat(target);
  if (!info.isFile()) throw new NotAFileError(relativePath);
  await writeFile(target, content, 'utf-8');
}

/**
 * Creates an empty file or folder, making any missing parent folders. A file name with no
 * extension gets `.md` — the docs folder holds markdown. Returns the path actually created
 * (relative to `.docs`), which differs from the request only by that added extension.
 */
export async function createDocsEntry(projectRoot: string, relativePath: string, type: EntryType): Promise<string> {
  const segments = entryPathSegments(relativePath);
  const last = segments.length - 1;
  if (type === 'file' && !path.extname(segments[last]!)) segments[last] += '.md';
  return createEntry(docsRoot(projectRoot), segments.join('/'), type);
}
