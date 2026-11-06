import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord, WorkflowRunRecord } from '../domain/types.ts';
import { changedFileDiff, listChangedFiles, mergeBase } from './branchDiff.ts';
import type { ChangedFile, DiffRange } from './branchDiff.ts';
import { listDocsTree, readDocsFile } from './docsFiles.ts';
import type { DocsTree } from './docsFiles.ts';
import { listProjectTree, readFileSafely } from './fileTree.ts';
import type { FileReadResult, ProjectTree } from './fileTree.ts';
import { git, isOwnGitRepo } from './git.ts';
import { projectAbsolutePath, projectWorktreesRoot } from './projectService.ts';

/**
 * A WorkflowRun's Quick look (task 5.008): live, read-only views of the directory the run works in
 * — its own worktree, or the Project's folder for a run started without a separate branch. Every
 * read resolves that directory with `resolveRunLocation` and then goes through the same path guards
 * as the Code and Documents tabs, plus a refusal of anything under `.git` (a worktree's `.git` file
 * names the main repository's path).
 */

export class WorkingCopyRemovedError extends Error {
  constructor() {
    super('The task\'s working copy has been removed');
    this.name = 'WorkingCopyRemovedError';
  }
}

export class RunOutsideProjectError extends Error {
  constructor() {
    super('This task\'s working copy is outside its project');
    this.name = 'RunOutsideProjectError';
  }
}

export class NoRepositoryDiffError extends Error {
  constructor() {
    super('This project has no git repository, so there are no changes to show');
    this.name = 'NoRepositoryDiffError';
  }
}

export class GitPathRefusedError extends Error {
  constructor(requestedPath: string) {
    super(`"${requestedPath}" is inside .git and can't be read here`);
    this.name = 'GitPathRefusedError';
  }
}

export class NotAChangedFileError extends Error {
  constructor(requestedPath: string) {
    super(`"${requestedPath}" has no changes`);
    this.name = 'NotAChangedFileError';
  }
}

/**
 * Where a run's work is right now:
 * - `worktree`: its own worktree, still on disk.
 * - `project-folder`: a run started without a separate branch (or on a repository-less Project) works in the Project's folder.
 * - `removed`: it had its own worktree (or branch), which is gone — removed once the run completed. The branch is kept.
 */
export type RunLocation =
  | { kind: 'worktree'; root: string; branch: string | null; baseBranch: string | null }
  | { kind: 'project-folder'; root: string; branch: string | null }
  | { kind: 'removed'; branch: string | null; baseBranch: string | null };

type ReadableLocation = Exclude<RunLocation, { kind: 'removed' }>;

async function isDirectory(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isDirectory();
  } catch {
    return false;
  }
}

/** Refuses a recorded worktree path outside the Project's own worktrees folder, so no read can leave the Project. */
function assertInsideProjectWorktrees(project: ProjectRecord, worktreePath: string): void {
  const relative = path.relative(projectWorktreesRoot(project), path.resolve(worktreePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new RunOutsideProjectError();
}

export async function resolveRunLocation(run: WorkflowRunRecord, project: ProjectRecord): Promise<RunLocation> {
  if (run.projectId !== project.id) throw new RunOutsideProjectError();
  const branch = run.branch ?? null;
  const baseBranch = run.baseBranch ?? null;
  if (run.worktreePath) {
    assertInsideProjectWorktrees(project, run.worktreePath);
    return (await isDirectory(run.worktreePath))
      ? { kind: 'worktree', root: run.worktreePath, branch, baseBranch }
      : { kind: 'removed', branch, baseBranch };
  }
  // Only a run with its own branch has a base branch; without a worktree, that branch's working copy is gone.
  if (baseBranch) return { kind: 'removed', branch, baseBranch };
  return { kind: 'project-folder', root: projectAbsolutePath(project), branch };
}

/** The location as the web sees it — never the absolute path on disk. */
export function publicRunLocation(location: RunLocation): { kind: RunLocation['kind']; branch: string | null; baseBranch: string | null } {
  return { kind: location.kind, branch: location.branch, baseBranch: location.kind === 'project-folder' ? null : location.baseBranch };
}

/** The run's location when its working copy can still be read or run in; a removed one throws WorkingCopyRemovedError. */
export async function readableLocation(run: WorkflowRunRecord, project: ProjectRecord): Promise<ReadableLocation> {
  const location = await resolveRunLocation(run, project);
  if (location.kind === 'removed') throw new WorkingCopyRemovedError();
  return location;
}

function assertNotGitPath(requestedPath: string): void {
  const segments = requestedPath.split(/[\\/]+/);
  if (segments.some((segment) => segment.toLowerCase() === '.git')) throw new GitPathRefusedError(requestedPath);
}

export async function quickLookCodeTree(run: WorkflowRunRecord, project: ProjectRecord): Promise<ProjectTree> {
  return listProjectTree((await readableLocation(run, project)).root);
}

export async function quickLookCodeFile(run: WorkflowRunRecord, project: ProjectRecord, requestedPath: string): Promise<FileReadResult> {
  assertNotGitPath(requestedPath);
  return readFileSafely((await readableLocation(run, project)).root, requestedPath);
}

export async function quickLookDocsTree(run: WorkflowRunRecord, project: ProjectRecord): Promise<DocsTree> {
  return listDocsTree((await readableLocation(run, project)).root);
}

export async function quickLookDocsFile(run: WorkflowRunRecord, project: ProjectRecord, requestedPath: string): Promise<FileReadResult> {
  assertNotGitPath(requestedPath);
  return readDocsFile((await readableLocation(run, project)).root, requestedPath);
}

/**
 * What the Diff view compares, and where git runs:
 * - `worktree`: the branch's changes since it left its base, including uncommitted and untracked work on disk.
 * - `branch`: the worktree is gone, so the kept branch is compared with its base from the Project's folder.
 * - `project-folder`: a run without its own branch — uncommitted changes against HEAD.
 */
export type DiffSource = 'worktree' | 'branch' | 'project-folder';

interface DiffPlan {
  source: DiffSource;
  root: string;
  range: DiffRange;
  base: string | null;
  branch: string | null;
}

/** Throws WorkingCopyRemovedError for a removed worktree whose branch (or base) can't be read either. */
async function planDiff(run: WorkflowRunRecord, project: ProjectRecord): Promise<DiffPlan> {
  const location = await resolveRunLocation(run, project);
  if (location.kind === 'project-folder') {
    if (!(await isOwnGitRepo(location.root))) throw new NoRepositoryDiffError();
    return { source: 'project-folder', root: location.root, range: { from: 'HEAD', to: 'working-tree' }, base: null, branch: location.branch };
  }
  if (location.kind === 'worktree') {
    const base = location.baseBranch ?? 'HEAD';
    const from = location.baseBranch ? await mergeBase(location.root, location.baseBranch, 'HEAD') : 'HEAD';
    return { source: 'worktree', root: location.root, range: { from, to: 'working-tree' }, base, branch: location.branch };
  }
  const root = projectAbsolutePath(project);
  if (!location.branch || !location.baseBranch) throw new WorkingCopyRemovedError();
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${location.branch}`]);
    const from = await mergeBase(root, `refs/heads/${location.baseBranch}`, `refs/heads/${location.branch}`);
    return { source: 'branch', root, range: { from, to: `refs/heads/${location.branch}` }, base: location.baseBranch, branch: location.branch };
  } catch {
    throw new WorkingCopyRemovedError();
  }
}

export interface QuickLookDiff {
  source: DiffSource;
  /** The branch compared against; null for a project-folder run (it compares with HEAD). */
  base: string | null;
  branch: string | null;
  files: ChangedFile[];
}

export async function quickLookDiff(run: WorkflowRunRecord, project: ProjectRecord): Promise<QuickLookDiff> {
  const plan = await planDiff(run, project);
  return { source: plan.source, base: plan.base, branch: plan.branch, files: await listChangedFiles(plan.root, plan.range) };
}

/** Diff text past this size is not sent; the view says the file is too large to show. */
const MAX_FILE_DIFF_CHARS = 1_000_000;

export type QuickLookFileDiff =
  | { path: string; kind: 'text'; diff: string }
  | { path: string; kind: 'binary' }
  | { path: string; kind: 'too-large' };

/** One file's diff. Only a path in the change set is diffed; any other path is NotAChangedFileError. */
export async function quickLookDiffFile(run: WorkflowRunRecord, project: ProjectRecord, requestedPath: string): Promise<QuickLookFileDiff> {
  const plan = await planDiff(run, project);
  const file = (await listChangedFiles(plan.root, plan.range)).find((entry) => entry.path === requestedPath);
  if (!file) throw new NotAChangedFileError(requestedPath);
  if (file.binary) return { path: file.path, kind: 'binary' };
  const diff = await changedFileDiff(plan.root, plan.range, file);
  return diff.length > MAX_FILE_DIFF_CHARS ? { path: file.path, kind: 'too-large' } : { path: file.path, kind: 'text', diff };
}
