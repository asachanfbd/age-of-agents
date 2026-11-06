import { localBranchExists } from './git.ts';
import { PLANNING_PREFIX } from './planItemService.ts';
import type { PlanningRef } from '../domain/types.ts';

/**
 * Names a new WorkflowRun's branch from its task alone, with no model call: `<type>/<ref>-<summary>`,
 * where `type` is the Workflow's fixed branch type or `feature`, `ref` is the planning number (absent
 * for a task added by hand) and `summary` is a slug of the task's title.
 */

export const DEFAULT_BRANCH_TYPE = 'feature';
const BRANCH_SUMMARY_MAX_LENGTH = 60;

/** Tidies text into the only shape a git branch segment may take: lowercase `a-z0-9`, single dashes between words, no leading/trailing dash, capped length. Empty when nothing usable survives. */
export function slugifyBranchSummary(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, BRANCH_SUMMARY_MAX_LENGTH).replace(/-+$/, '');
}

/** The branch summary for a task: its title with the planning-session number prefix stripped, slugified; `task` when nothing usable is left. */
export function branchSummaryFromTitle(title: string): string {
  return slugifyBranchSummary(title.replace(PLANNING_PREFIX, '')) || 'task';
}

/** "5-004" for planning session 5, task 4 — null for a task added by hand (no planning number). */
export function planningRefSegment(ref: PlanningRef | null | undefined): string | null {
  return ref ? `${ref.session}-${String(ref.task).padStart(3, '0')}` : null;
}

/** `<type>/<ref>-<summary>`, or `<type>/<summary>` when `ref` is null (a manually-added task has no planning number). */
export function buildBranchName(type: string, ref: string | null, summary: string): string {
  return `${type}/${ref ? `${ref}-` : ''}${summary}`;
}

/**
 * Appends `-2`, `-3`, ... until `candidate` doesn't collide with a branch that already exists
 * locally — so a new task never silently reuses a different task's branch. `exists` is injectable
 * so a unit test can exercise the suffixing without a real git repository.
 */
export async function uniqueBranchName(cwd: string, candidate: string, exists: (cwd: string, branch: string) => Promise<boolean> = localBranchExists): Promise<string> {
  if (!(await exists(cwd, candidate))) return candidate;
  let n = 2;
  while (await exists(cwd, `${candidate}-${n}`)) n += 1;
  return `${candidate}-${n}`;
}

export interface TaskBranchInput {
  title: string;
  /** The Workflow's own fixed branch type, when it has one. */
  branchType: string | null;
  planningRef: PlanningRef | null;
}

/** The branch name a task would get if nothing collided with it. */
export function defaultBranchName(input: TaskBranchInput): string {
  return buildBranchName(input.branchType ?? DEFAULT_BRANCH_TYPE, planningRefSegment(input.planningRef), branchSummaryFromTitle(input.title));
}

/** The new branch name for a task that has none yet, made unique against `cwd`'s existing local branches. */
export function resolveBranchName(input: TaskBranchInput, cwd: string): Promise<string> {
  return uniqueBranchName(cwd, defaultBranchName(input));
}
