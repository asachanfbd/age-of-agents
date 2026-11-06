import type { PullRequestConflictTarget, WorkflowRecord } from '../domain/types.ts';

/**
 * The built-in workflow behind the PR tab's Merge on a conflicting pull request: one write-capable
 * step with no approval gate, run instead of the Project's own workflow. The run works in its own
 * worktree on a run-local branch created at the PR's head commit, so it never needs the PR's branch
 * checked out (that branch may be checked out in the Project's own folder). The daemon pushes the
 * step's commits to the PR's head branch and then re-checks and merges the PR — see
 * workerManager.ts's `finishConflictRun`. Defined in code so a Catalog edit can never change it.
 */

export const CONFLICT_RESOLUTION_WORKFLOW_ID = 'pr-conflict-resolution';
export const CONFLICT_RESOLUTION_STEP_ID = 'resolve-conflicts';
const CONFLICT_AGENT_ID = 'software-engineer';

type ConflictPullRequest = Pick<PullRequestConflictTarget, 'number' | 'title' | 'headBranch' | 'baseBranch'>;

export function conflictRunTitle(pr: Pick<PullRequestConflictTarget, 'number' | 'title'>): string {
  return `Resolve conflicts: #${pr.number} ${pr.title}`;
}

/** The run-local branch a conflict run's worktree is on. Unique per run, so it never collides with the PR's own branch or an earlier run's. */
export function conflictRunBranch(pr: Pick<PullRequestConflictTarget, 'number'>, runId: string): string {
  return `pr-conflicts/${pr.number}-${runId.slice(0, 8)}`;
}

export function conflictPlanItemDescription(pr: ConflictPullRequest): string {
  return `Pull request #${pr.number} "${pr.title}" (${pr.headBranch} → ${pr.baseBranch}) conflicts with its base branch. Resolve the conflicts so it can be merged.`;
}

function instructions(pr: ConflictPullRequest): string {
  return `Pull request #${pr.number} merges the head branch "${pr.headBranch}" into the base branch "${pr.baseBranch}", and the two conflict. Your working directory is a dedicated worktree already at the pull request's head commit.

Do this:
1. Run \`git fetch origin ${pr.baseBranch}\`, then \`git merge origin/${pr.baseBranch}\` to merge the base branch "${pr.baseBranch}" into the head branch's work.
2. Resolve every conflict so that both sides' intent is kept. Read the surrounding code and the history of each side when the right resolution is not obvious.
3. Run the project's build or tests if that is cheap, to check the resolution.
4. Commit the merge with \`git commit\`. Then call complete_step with a summary of each conflict and how you resolved it. The daemon pushes your commits to "${pr.headBranch}" and merges the pull request.

Rules:
- Merge only. Never rebase, amend, reset or otherwise rewrite existing commits.
- Never force push (\`--force\`, \`--force-with-lease\`, \`+refspec\`). Do not push at all: the daemon does it.
- Work only in this worktree. Never touch the project's main checkout or switch branches there.
- Change only what resolving the conflicts needs. Do not merge the pull request yourself.
- If you cannot resolve a conflict safely, stop and say why instead of guessing.
Do not call skip_step: this step cannot be skipped.`;
}

export function conflictResolutionWorkflow(pr: ConflictPullRequest): WorkflowRecord {
  return {
    id: CONFLICT_RESOLUTION_WORKFLOW_ID,
    name: 'Resolve PR conflicts',
    description: 'Merges a pull request\'s base branch into its head branch and resolves the conflicts, so the pull request can be merged.',
    enabled: true,
    steps: [
      {
        id: CONFLICT_RESOLUTION_STEP_ID,
        name: 'Resolve conflicts',
        agentId: CONFLICT_AGENT_ID,
        canEditCode: true,
        requiresApproval: false,
        instructions: instructions(pr),
      },
    ],
  };
}
