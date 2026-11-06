import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { git, isOwnGitRepo } from './git.ts';

/**
 * The Code tab's read-only file explorer (docs/roadmap.md's "Project Popover
 * Redesign"): lists a project's real source tree and lets a selected file's
 * content be previewed. Every path here is user-influenced (it travels
 * through an HTTP query string), so every read in this module is resolved
 * through `resolveSafePath` first — see its own doc comment for the threat
 * model.
 */

export class PathTraversalError extends Error {
  constructor(requestedPath: string) {
    super(`"${requestedPath}" resolves outside the project root`);
    this.name = 'PathTraversalError';
  }
}

export class NotAFileError extends Error {
  constructor(requestedPath: string) {
    super(`"${requestedPath}" is not a file`);
    this.name = 'NotAFileError';
  }
}

/**
 * Resolves `requestedPath` against `root` and rejects (throws
 * PathTraversalError) anything that lands outside it — never silently
 * clamps. Two layers, because either alone misses a real case:
 *
 * 1. A syntactic check on the plain resolved path — catches `../../etc/passwd`
 *    and an absolute path like `/etc/passwd` (path.resolve treats a later
 *    absolute segment as replacing everything before it, so an absolute
 *    `requestedPath` still ends up compared against `root` correctly here).
 * 2. A realpath check — catches a symlink *inside* the project whose target
 *    points outside it, which the syntactic check alone can't see. When the
 *    target doesn't exist yet, its nearest existing ancestor is checked
 *    instead: a missing file still resolves (so a read 404s), but one that
 *    would be created through an escaping symlinked folder is rejected.
 */
export async function resolveSafePath(root: string, requestedPath: string): Promise<string> {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) throw new PathTraversalError(String(requestedPath));

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, requestedPath);
  assertWithin(resolvedRoot, resolvedTarget, requestedPath);

  const [realRoot, realTarget] = await Promise.all([canonicalPath(resolvedRoot), canonicalPath(resolvedTarget)]);
  assertWithin(realRoot, realTarget, requestedPath);
  return resolvedTarget;
}

/** The realpath of `absolute`'s nearest existing ancestor, with the not-yet-existing remainder appended. */
async function canonicalPath(absolute: string): Promise<string> {
  const missing: string[] = [];
  for (let current = absolute; ; current = path.dirname(current)) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw error;
      missing.unshift(path.basename(current));
    }
  }
}

function assertWithin(root: string, target: string, requestedPath: string): void {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathTraversalError(requestedPath);
  }
}

/** Noise directories excluded from the plain-walk fallback — mirrors this repo's own .gitignore conventions (node_modules, build output, editor/OS cruft). Only used when the project isn't its own git repo; a tracked git project is scoped by `git ls-files` instead (see listProjectTree). */
const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'dist-ssr', 'build', 'out', '.next', '.turbo', '.cache', '.vite', 'coverage', '.idea', '.vscode',
]);

/** Tracked + untracked-but-not-ignored files, '/'-separated and relative to `root` — respects the project's own .gitignore for free. */
async function listGitTrackedFiles(root: string): Promise<string[]> {
  const output = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return output.split('\0').filter(Boolean).map((entry) => entry.split(path.sep).join('/'));
}

/** Ignored paths as git reports them, with a wholly ignored directory collapsed to one `dir` entry (no trailing slash). */
async function listGitIgnoredPaths(root: string): Promise<Set<string>> {
  const output = await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  return new Set(output.split('\0').filter(Boolean).map((entry) => entry.split(path.sep).join('/').replace(/\/$/, '')));
}

interface WalkResult {
  files: string[];
  folders: string[];
}

/**
 * Never follows a symlink (a directory or a file) while walking, so a link that escapes the project
 * can't be swept into the tree — resolveSafePath's realpath check is the read-time guard for one
 * that's still explicitly requested. `skipDir` prunes a directory (and everything under it).
 */
async function walkDirectory(root: string, dir: string, skipDir: (name: string, relative: string) => boolean, result: WalkResult): Promise<WalkResult> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (skipDir(entry.name, relative)) continue;
      result.folders.push(relative);
      await walkDirectory(root, absolute, skipDir, result);
    } else if (entry.isFile()) {
      result.files.push(relative);
    }
  }
  return result;
}

export interface ProjectTree {
  /** Every real file, '/'-separated relative paths, sorted. */
  files: string[];
  /** Every folder on disk (including empty ones), '/'-separated relative paths, sorted; `.git` and ignored/noise folders are left out. */
  folders: string[];
}

/**
 * The project's file tree for the Code tab. For a project that is its own git repo, files come from
 * `git ls-files` (tracked + untracked-but-not-ignored, using the project's own .gitignore) and folders
 * from a walk that prunes `.git` and anything git ignores — `ls-files` never reports an empty folder,
 * so without the walk a newly created one would be invisible. Any other project is a plain walk with a
 * sensible exclude list for both.
 */
export async function listProjectTree(root: string): Promise<ProjectTree> {
  let tree: WalkResult;
  if (await isOwnGitRepo(root)) {
    const [files, ignored] = await Promise.all([listGitTrackedFiles(root), listGitIgnoredPaths(root)]);
    const walked = await walkDirectory(root, root, (name, relative) => name === '.git' || ignored.has(relative), { files: [], folders: [] });
    tree = { files, folders: walked.folders };
  } else {
    tree = await walkDirectory(root, root, (name) => DEFAULT_EXCLUDED_DIR_NAMES.has(name), { files: [], folders: [] });
  }
  return { files: tree.files.sort(), folders: tree.folders.sort() };
}

const MAX_PREVIEW_BYTES = 1_000_000;

export type FileReadResult =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number };

/** A null byte anywhere in the first chunk is the same cheap-and-reliable text/binary heuristic git itself uses. */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

/**
 * Reads one file for the Code tab's read-only preview. Always resolves `requestedPath` through
 * `resolveSafePath` first — the one enforcement point every caller in this module's HTTP routes
 * goes through. Throws the underlying ENOENT for a missing file (the caller 404s) and
 * NotAFileError for a directory.
 */
export async function readFileSafely(root: string, requestedPath: string): Promise<FileReadResult> {
  const resolved = await resolveSafePath(root, requestedPath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new NotAFileError(requestedPath);
  if (info.size > MAX_PREVIEW_BYTES) return { kind: 'too-large', size: info.size };
  const buffer = await readFile(resolved);
  if (looksBinary(buffer)) return { kind: 'binary' };
  return { kind: 'text', content: buffer.toString('utf-8') };
}
