import { git } from './git.ts';
import { readFileSafely } from './fileTree.ts';

/**
 * The Quick look Diff view's git reads: which files changed between a starting commit and either a
 * later ref or the working tree, and one file's unified diff. Every path handed back to git comes
 * from git's own change list and always follows `--`, so a requested path can never become a git
 * option or name a file outside the change set.
 */

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  /** The path before a rename; absent otherwise. */
  oldPath?: string;
  status: ChangedFileStatus;
  /** Line counts; null for a binary file. */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** A new file git doesn't track yet — only possible when comparing against the working tree. */
  untracked?: boolean;
}

/** `to: 'working-tree'` compares `from` with the files on disk, untracked ones included. */
export interface DiffRange {
  from: string;
  to: string | 'working-tree';
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'];

function rangeArgs(range: DiffRange): string[] {
  return range.to === 'working-tree' ? [range.from] : [range.from, range.to];
}

/** The newest commit both refs share — what a branch's changes are measured from, so later commits on the base don't show up as changes. */
export async function mergeBase(root: string, a: string, b: string): Promise<string> {
  return git(root, ['merge-base', a, b]);
}

/** Maps a `--name-status` letter to the four statuses the view shows; copies read as additions and type changes as modifications. */
function statusFromLetter(letter: string): ChangedFileStatus {
  switch (letter) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

/** Parses `git diff --name-status -z`: a status token, then one path, or two (old, new) for a rename or copy. */
export function parseNameStatus(output: string): { status: ChangedFileStatus; path: string; oldPath?: string }[] {
  const tokens = output.split('\0');
  const entries: { status: ChangedFileStatus; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token) continue;
    const letter = token[0]!;
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      entries.push(letter === 'R' ? { status: 'renamed', path: newPath, oldPath } : { status: 'added', path: newPath });
    } else {
      entries.push({ status: statusFromLetter(letter), path: tokens[i + 1] ?? '' });
      i += 1;
    }
  }
  return entries;
}

/** Parses `git diff --numstat -z` into counts keyed by (new) path; `-\t-` marks a binary file. */
export function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const tokens = output.split('\0');
  const counts = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]!);
    if (!match) continue;
    let filePath = match[3]!;
    if (!filePath) {
      // A rename: the old and new paths follow as their own tokens.
      filePath = tokens[i + 2] ?? '';
      i += 2;
    }
    const binary = match[1] === '-';
    counts.set(filePath, {
      additions: binary ? null : Number(match[1]),
      deletions: binary ? null : Number(match[2]),
      binary,
    });
  }
  return counts;
}

async function listUntracked(root: string): Promise<string[]> {
  const output = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return output.split('\0').filter(Boolean);
}

/** A file's lines as a diff shows them, or null when it can't be shown as text (binary, too large, or unreadable). */
async function readTextLines(root: string, filePath: string): Promise<string[] | null> {
  try {
    const result = await readFileSafely(root, filePath);
    if (result.kind !== 'text') return null;
    if (result.content === '') return [];
    const lines = result.content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  } catch {
    return null;
  }
}

async function untrackedFile(root: string, filePath: string): Promise<ChangedFile> {
  const lines = await readTextLines(root, filePath);
  return lines === null
    ? { path: filePath, status: 'added', additions: null, deletions: null, binary: true, untracked: true }
    : { path: filePath, status: 'added', additions: lines.length, deletions: 0, binary: false, untracked: true };
}

/** Every file changed in `range`, sorted by path. Against the working tree, untracked (not ignored) files count as added. */
export async function listChangedFiles(root: string, range: DiffRange): Promise<ChangedFile[]> {
  const args = rangeArgs(range);
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(root, ['diff', ...DIFF_FLAGS, '--name-status', '-z', ...args]),
    git(root, ['diff', ...DIFF_FLAGS, '--numstat', '-z', ...args]),
    range.to === 'working-tree' ? listUntracked(root) : Promise.resolve([]),
  ]);
  const counts = parseNumstat(numstat);
  const files: ChangedFile[] = parseNameStatus(nameStatus).map((entry) => ({
    ...entry,
    ...(counts.get(entry.path) ?? { additions: null, deletions: null, binary: false }),
  }));
  files.push(...(await Promise.all(untracked.map((filePath) => untrackedFile(root, filePath)))));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** An untracked file's diff, written the way git shows a new file. */
async function untrackedDiff(root: string, filePath: string): Promise<string> {
  const lines = (await readTextLines(root, filePath)) ?? [];
  const header = [`diff --git a/${filePath} b/${filePath}`, 'new file', '--- /dev/null', `+++ b/${filePath}`];
  if (lines.length === 0) return header.join('\n');
  return [...header, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
}

/** One changed file's unified diff within `range` — a rename is diffed across both of its paths. */
export async function changedFileDiff(root: string, range: DiffRange, file: ChangedFile): Promise<string> {
  if (file.untracked) return untrackedDiff(root, file.path);
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  return git(root, ['diff', ...DIFF_FLAGS, ...rangeArgs(range), '--', ...paths]);
}
