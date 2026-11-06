/**
 * Domain types for the scene and its store. Mirrors the vocabulary in
 * docs/glossary.md (Project, Task, Home Base) and the server's own shapes
 * (server/src/domain/types.ts) — see store/worldStore.ts for how a
 * ServerProject/ServerTask from web/src/lib/serverApi.ts gets mapped in.
 */

import type { ProjectSyncState, TerminalRuntimeStatus, TestingSetupMode, TokenUsage } from './lib/serverApi';
import type { GitProviderId } from './lib/gitProvider';
import type { BugAttributes, BugTaskRef } from './lib/bugs';

export type BuildingStatus = 'idle' | 'developing' | 'blocked';

export interface ProjectData {
  id: string;
  name: string;
  /** The Project's folder name under projects/; it never changes when the project is renamed. */
  slug: string;
  repositoryUrl?: string;
  /** World-space [x, z] on the ground plane. */
  position: [number, number];
  status: BuildingStatus;
  /** The active Task's id, if status is 'developing' or 'blocked'. */
  activeTaskId: string | null;
  /** How many tasks have been started on this project, ever. */
  taskCount: number;
  /** The checked-out branch's last-known comparison against its remote — null until the daemon's poller has checked at least once, or for a Project with no repository. See lib/gitSync.ts. */
  sync: ProjectSyncState | null;
  /** The Catalog Workflow this Project's Tasks run through — null/absent means "use the Catalog's default Workflow". See lib/serverApi.ts's ServerProject.workflowId. */
  workflowId?: string | null;
  /** Whether the checked-out branch is pulled automatically when safe — absent reads as on. */
  autoPullEnabled?: boolean;
  /** Where the Project's repository is hosted — absent reads as GitHub. See lib/gitProvider.ts. */
  gitProvider?: GitProviderId;
  /** The `gh` login this Project's GitHub operations run as; null/absent is the machine default. See lib/githubAccounts.ts. */
  githubAccount?: string | null;
  /** Set while the Project's folder is on a pull request's branch through the PR tab's Check out: the PR, its local branch, and where Return goes. See lib/pullRequestActions.ts. */
  prCheckout?: PullRequestCheckout | null;
  /** The Building Type (see lib/buildingTypes.ts); absent reads as Software. */
  typeId?: string;
  typeVersion?: number;
  /** The daemon no longer registers this Building's type: it opens read-only with a notice. */
  typeUnavailable?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string | null;
}

export interface PullRequestCheckout {
  number: number;
  branch: string;
  previousBranch: string;
}

/** The pull request a conflict-resolution run works on — mirrors server/src/domain/types.ts. */
export interface PullRequestConflictTarget {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  pushRemote: string;
}

export interface TaskData {
  conversationId?: string;
  archived?: boolean;
  sessionId?: string | null;
  runtimeStatus?: TerminalRuntimeStatus;
  runtimeWaitingReason?: string | null;
  runtimeStatusChangedAt?: string | null;
  branch?: string;
  /** Set only for a Task running in its own isolated git worktree — absent for one working directly in the Project's own folder. See the branch menu's folder-busy rule in lib/branchMenu.ts. */
  worktreePath?: string;
  id: string;
  projectId: string;
  executorId: string;
  /** Interactive CLI Tasks render a live PTY instead of a structured transcript. */
  executionMode: 'structured' | 'terminal';
  description: string;
  status: 'developing' | 'blocked' | 'done' | 'failed' | 'stopped';
  /** 'auto' bypassed permission prompts; 'approval' ran gated, asking before tool use. Set once at Task creation from the request or the Template's default — see server/src/domain/types.ts's Autonomy. */
  autonomy: 'auto' | 'approval';
  /** 'plan' (the workspace chat's default) or 'execute' (real coding work). */
  kind: 'plan' | 'execute';
  /** Set when this Task ran one Tasks-breakdown PlanItem, null for a freeform/chat Task. */
  planItemId: string | null;
  /** A planning session's number within its Project — the "<n>." its created tasks are titled with. */
  planningSessionNumber?: number;
  planningQueueOrder?: number;
  planningCompletedAt?: string | null;
  planningCreatedTaskCount?: number;
  planningAutoCompleteArmed?: boolean;
  /** Set on a planning-style session that files bugs: 'plan-and-bugs' also files tasks and sets dependencies; 'bug-report' is the earlier kind. Absent on a planning conversation. */
  planningPurpose?: 'bug-report' | 'plan-and-bugs';
  /** A bug-filing session created with no coding agent available: it has no CLI yet. */
  cliNotStarted?: boolean;
  /** A planning session's short generated name — absent until it arrives, and on every other Task. */
  title?: string;
  blockedQuestion: string | null;
  failureReason: string | null;
  /** Running token-usage total for this Task's session. */
  tokenUsage: TokenUsage;
  /** Set when this Task runs one step of a WorkflowRun — null/absent for a freeform Task, a planning Task, or one that predates workflows. Paired with `workflowStepId`. */
  workflowRunId?: string | null;
  /** The WorkflowStep (by its snapshot id) this Task is running — see `workflowRunId`. */
  workflowStepId?: string | null;
  /** When this Task was created — a session's start, for the history/planning list summaries. */
  createdAt: string;
  /** Last modified — used as a settled (blocked/done/failed/stopped) Task's end when `completedAt` is unset. */
  updatedAt: string;
  /** Set once a Task finishes `'done'` (see server/src/worker/workerManager.ts's settleDone); null otherwise, including for `'blocked'`/`'failed'`/`'stopped'`. */
  completedAt: string | null;
}

export type PlanItemStatus = 'pending' | 'developing' | 'blocked' | 'done' | 'failed' | 'stopped';

/** Where a task's automatic merge stands — see server/src/domain/types.ts's `AutoMergeState`. */
export type AutoMergeState = 'waiting' | 'merging' | 'resolving' | 'blocked' | 'provider' | 'agent' | 'merged' | 'failed' | 'no-pr' | 'cannot-merge';

/** What the Git provider last said about a task's own pull request — see server/src/domain/types.ts's `TaskPullRequestReading`. */
export interface TaskPullRequestData {
  state: 'open' | 'merged' | 'closed' | 'none';
  prNumber: number | null;
  readAt: string;
}

/** A task's Auto-merge toggle and state, as the daemon stores it (`PlanItemRecord.autoMerge`). */
export interface AutoMergeData {
  enabled: boolean;
  state: AutoMergeState;
  reasons: string[];
  /** Failing or running checks the base branch doesn't require: shown, never a blocker. */
  warnings?: string[];
  prNumber: number | null;
  /** The conflict-resolution run this task's auto-merge started. */
  runId: string | null;
  mergedAt: string | null;
  branchWarning: string | null;
  branchNote: string | null;
  updatedAt: string;
}

/** What the person can do with one click from a waiting reason — see server/src/domain/types.ts's `DependencyAction`. */
export type DependencyActionName = 'toggle-auto-merge' | 'sync' | 'remove-dependency' | 'retry-parent';

export interface DependencyReasonData {
  parentId?: string;
  text: string;
  blocked: boolean;
  action?: DependencyActionName;
}

/** The start options replayed when a waiting task starts by itself. */
export interface DependentStartOptionsData {
  executorId?: string;
  workflowId?: string;
  createBranch?: boolean;
  skippedStepIds?: string[];
}

/** A task the person started that is waiting for its parent tasks (`PlanItemRecord.waiting`). */
export interface WaitingData {
  options: DependentStartOptionsData;
  state: 'waiting' | 'blocked';
  reasons: DependencyReasonData[];
  since: string;
  longWaitNotified: boolean;
  manualWaitSince?: string;
  updatedAt: string;
}

/** One task card in the Project workspace. */
export interface PlanItemData {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: PlanItemStatus;
  /** Set only on a bug; an item without it is a task (`lib/bugs.ts`'s `isBugItem`). */
  type?: 'bug';
  /** A bug's attributes, present exactly when `type` is 'bug'. */
  bug?: BugAttributes;
  /** A task filed by a bug report session only: the bug it was filed with, copied at filing time. */
  relatedBug?: BugTaskRef;
  /** A task filed by a bug report session only: that session's number. */
  reportSessionNumber?: number;
  order: number;
  planningQueueOrder?: number;
  /** Position within its planning group's ready tasks — see `comparePlanningGroupOrder`. */
  planningGroupOrder?: number;
  taskIds: string[];
  /** The worker (Executor) assigned to run this item, or null until one is assigned or the first run records its own. Locked once the item has started. */
  executorId: string | null;
  /** The planning Task whose session created this item, when one did — absent/null for an item typed by hand. */
  planningTaskId?: string | null;
  planningRef?: { session: number; task: number };
  /** The most recent WorkflowRun executing this item, if any has ever started. */
  workflowRunId?: string | null;
  /** Set only on a testing-setup item the Testing tab started. */
  testingSetup?: { mode: TestingSetupMode };
  /** Set only on the item the PR tab's Merge created to resolve a pull request's conflicts. */
  prConflict?: PullRequestConflictTarget;
  /** The task's Auto-merge; absent until it was ever switched on. */
  autoMerge?: AutoMergeData;
  /** The task's own pull request as last read, for a task without Auto-merge; absent until a reading succeeded. */
  pullRequest?: TaskPullRequestData;
  /** Ids of the same-project tasks this one waits for; absent means none. */
  dependsOn?: string[];
  /** Present while the task waits for its parents to be merged; it stays in Planning meanwhile. */
  waiting?: WaitingData;
  /** Hidden from every Tasks-board column (Completed included). */
  archived?: boolean;
  createdAt: string;
  /** Last modified — for an item marked done by hand (no Task), this is when it was completed. */
  updatedAt: string;
}
