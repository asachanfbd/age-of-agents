/**
 * The two git steps both app-update paths share, runnable in any working directory so they can be
 * exercised against a temporary repository: the fast-forward pull, and the rollback that restores the
 * previous commit. Neither ever discards local changes: git itself refuses to overwrite them, and the
 * refusal comes back as a message naming the files.
 */
import { git, currentBranch, fetchOrigin } from '../projects/git.ts';
import { overwriteRefusalMessage } from '../projects/incomingOverlap.ts';

export interface GitStepResult { ok: boolean; output: string }

function failure(error: unknown): GitStepResult {
  const message = (error as Error).message;
  const refusal = overwriteRefusalMessage(message);
  return { ok: false, output: refusal ? `Update not applied: ${refusal}.` : message };
}

/** Fetches and fast-forwards the checked-out branch to `origin/<branch>`. A merge git refuses leaves the checkout as it was. */
export async function pullFastForward(cwd: string): Promise<GitStepResult> {
  try {
    const branch = await currentBranch(cwd);
    await fetchOrigin(cwd);
    return { ok: true, output: await git(cwd, ['merge', '--ff-only', `origin/${branch}`]) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Moves the current branch back to `sha` with `--keep`: files the update changed return to their old
 * content, while every local change survives. If a file the update changed was edited since the pull,
 * git refuses and nothing moves, so the result reports a failed rollback instead of discarding the edit.
 * The branch is reset rather than detached so later updates still find a branch.
 */
export async function rollbackToCommit(cwd: string, sha: string): Promise<GitStepResult> {
  try {
    return { ok: true, output: await git(cwd, ['reset', '--keep', sha]) };
  } catch (error) {
    return { ok: false, output: (error as Error).message };
  }
}
