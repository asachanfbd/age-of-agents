/**
 * Domain vocabulary from docs/glossary.md, as the shapes the daemon actually
 * persists. See docs/architecture.md#one-central-runtime-state-store-docs-stay-per-project
 * for why this lives in one file-based store instead of being split up.
 */

import type { GitProviderId } from '../projects/gitProvider.ts';
import type { FindingSeverity, ResultCase, ResultCounts, ResultFinding, ResultMetric, TestActionConfig, TestingConfigState, TestOutcome, TestSuiteKind } from '../testing/types.ts';

export type ProjectStatus = 'idle' | 'developing' | 'blocked';

/** A commit-identity override for one `gh` account, keyed by the lowercase login. */
export interface GithubIdentityRecord {
  id: string;
  name: string;
  email: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  repositoryUrl?: string;
  slug: string;
  /** Project's working directory, relative to the repo root (e.g. "projects/my-app"). */
  relativePath: string;
  status: ProjectStatus;
  /** World-space [x, z] on the scene's ground plane. Owned by the frontend's plot layout. */
  position: [number, number] | null;
  /**
   * The most recently started Task that is still active (developing/blocked),
   * kept for backward compatibility with UI built around "the" one active
   * Task per Project — null when nothing is active. See `activeTaskIds` for
   * the full set now that a Project can run more than one concurrent Task —
   * see docs/architecture.md#concurrent-tasks-per-project.
   */
  activeTaskId: string | null;
  /**
   * Every currently active (developing/blocked) Task on this Project, oldest
   * first — `activeTaskId` is always `activeTaskIds.at(-1) ?? null`. Absent
   * on a Project record written before this field existed; treat that as
   * `[]`, the same defensive pattern `TaskRecord.tokenUsage` already uses for
   * records older than it (see `workerManager.ts`'s project active-task
   * helpers, which do exactly that). No UI yet renders more than one at a
   * time — see the roadmap note on the same architecture section above for
   * why the concurrency this backs stays deliberately small.
   */
  activeTaskIds: string[];
  taskCount: number;
  /** How many bugs with no numbered introducing task have ever been filed here: the last `B.<NNN>` handed out, never reused. */
  bugSequence?: number;
  /**
   * The Catalog Workflow (see WorkflowRecord) this Project's Tasks run through — null/absent means
   * "use the Catalog's default Workflow" (`catalog/workflowService.ts`'s `getDefaultWorkflow`), the
   * same absent-means-default convention as `PlanItemRecord.executorId`. Set via
   * `PATCH /api/projects/:id/workflow`. A Workflow deleted while Projects still reference it resets
   * every one of them back to null/default (see `catalog/workflowService.ts`'s `deleteWorkflow`).
   */
  workflowId?: string | null;
  /** Whether the checked-out branch is fast-forwarded automatically when it is behind origin and that is safe (`projects/autoPull.ts`). Absent on a Project stored before the setting existed, which reads as on. */
  autoPullEnabled?: boolean;
  /** Where this Project's repository is hosted — absent on a Project stored before the setting existed, which reads as GitHub (`projects/gitProvider.ts`'s `gitProviderFor`). */
  gitProvider?: GitProviderId;
  /** The `gh` login this Project's GitHub operations and agent sessions run as. Absent or null means the machine default. */
  githubAccount?: string | null;
  /**
   * Set while the Project's own folder is on a pull request's branch because of the PR tab's Check
   * out: which PR, the local branch it was checked out as, and the branch to Return to. Cleared by
   * Return and by any ordinary branch switch.
   */
  prCheckout?: PullRequestCheckout | null;
  /**
   * The Building Type (see `buildings/registry.ts`). Absent on a Project stored before Building
   * Types existed, which reads as `software` (`buildings/normalize.ts`).
   */
  typeId?: string;
  /** The type version this Building's data was last migrated to. Absent reads as 1. */
  typeVersion?: number;
  /** Owner and tenant: single local user for now (`buildings/ownership.ts`). Absent reads as the local user. */
  ownerId?: string;
  tenantId?: string;
  /** Why this Building is read-only (set by a failed migration or a version newer than the code); absent means writable. */
  readOnlyReason?: string | null;
  /** The IANA timezone this Building's schedules are evaluated in; absent or null means the host's (`scheduler/cron.ts`). */
  timezone?: string | null;
  /** Set once the type's declared default jobs were copied to this Building, so a deleted default stays deleted. */
  scheduledJobsSeeded?: boolean;
  /** Size at which the Building's bulk storage raises a warning; absent means the platform default. */
  storageWarningBytes?: number;
  /** Set once the warning notification fired for the current crossing, cleared when the size drops back under. */
  storageWarned?: boolean;
  /** Set when a storage error (e.g. disk full) stopped ingestion; cleared by the person resuming. */
  ingestionStoppedReason?: string | null;
  /** The most recent backup of this Building's bulk data (pre-migration or an export). */
  lastBackup?: { file: string; at: string; reason: 'migration' | 'export' } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestCheckout {
  number: number;
  /** The local branch holding the PR head: the head branch's own name, or a PR-specific name for a fork. */
  branch: string;
  previousBranch: string;
}

export type TaskStatus = 'developing' | 'blocked' | 'done' | 'failed' | 'stopped';

/**
 * 'plan' is a planning session: always an interactive CLI, it researches and
 * talks the requirement through with the user, then manages the Project's
 * PlanItems through its MCP tools — never running commands or touching
 * source (see server/src/projects/plan.ts). 'execute' is every
 * other Task — the original freeform "Start a task" flow, and running one
 * breakdown PlanItem for real.
 */
export type TaskKind = 'plan' | 'execute';

/**
 * 'auto' runs the Worker with `--permission-mode bypassPermissions` (full
 * autonomy). 'approval' runs it under the CLI's default permission mode,
 * which currently *denies* gated tool calls outright rather than pausing for
 * one — see docs/architecture.md's "Known gray area" spike notes. There is no
 * real approval-relay yet; see server/README.md, "Known simplifications."
 */
export type Autonomy = 'auto' | 'approval';

/**
 * Whether a Task is driven by a live PTY in the project popup ('terminal' — every Task now runs
 * this way, see docs/architecture.md) or the removed headless/structured background adapter
 * ('structured'). 'structured' survives only as a historical value on a Task record from before
 * that removal — nothing writes it any more, but old records keep it for their own display.
 */
export type TaskExecutionMode = 'structured' | 'terminal';

/** Live state of an interactive CLI process/turn, independent of the Task's persisted lifecycle. */
export type TerminalRuntimeStatus = 'starting' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'stopped' | 'disconnected';

/**
 * Token usage + cost extracted from a `claude -p` turn's stream-json `result`
 * event (see server/src/worker/claudeProcess.ts's `extractTokenUsage`).
 * Accumulated per Task as a running total across every turn in that Task's
 * conversation — a Task is one `claude -p` session (docs/glossary.md), so
 * this is "the number of tokens consumed in each session" the footer
 * displays, rolled up per executor by
 * server/src/executors/executorUsage.ts.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}

export const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
};

export interface TaskRecord {
  /** Owner and tenant: the single local user until accounts exist (`buildings/ownership.ts`). */
  ownerId?: string;
  tenantId?: string;
  conversationId?: string;
  archived?: boolean;
  branch?: string;
  /**
   * Absolute path to this Task's own isolated git worktree, set only when
   * this Task was not its Project's first/only concurrently active Task at
   * creation time — see `assignTaskWorkspace` in `workerManager.ts` and
   * docs/architecture.md#concurrent-tasks-per-project.
   * Undefined means this Task runs directly in the Project's own working
   * directory (`projectAbsolutePath`) — the common single-Task case,
   * unchanged from pre-worktree v1 behavior. Cleared implicitly once the
   * worktree directory itself is removed after the Task settles (the
   * directory goes away; this field is left as a historical record of where
   * it ran rather than being nulled out).
   */
  worktreePath?: string;
  id: string;
  projectId: string;
  templateId: string;
  /**
   * Catalog Skills folded into this Task's Worker session alongside its
   * Template persona — see workerManager.ts's `runTurn`/`buildAppendSystemPrompt`
   * and catalogService.ts's `readSkillBody`. Validated (must exist and be
   * enabled) at Task-creation time in `startTask`, same as `templateId`.
   * Undefined for a Task created before this field existed, or one that had
   * no Skills chosen — treated the same as an empty array everywhere it's
   * read, the same defensive pattern `ProjectRecord.activeTaskIds` and
   * `TaskRecord.tokenUsage` already use for fields older records predate.
   */
  skillIds?: string[];
  /** The subset of `skillIds` whose full SKILL.md is pasted into the system prompt every run; the rest are listed in an index for the agent to Read on demand. Absent or empty means all on demand. */
  preloadSkillIds?: string[];
  /** Which account/CLI ran this Task — see ExecutorProfile. */
  executorId: string;
  /** Persisted at creation so historical Tasks keep the correct UI even if their executor is edited later. */
  executionMode?: TaskExecutionMode;
  description: string;
  status: TaskStatus;
  autonomy: Autonomy;
  /**
   * Copied from TemplateRecord.manager at creation time, the same way
   * `autonomy` is copied from `template.defaultAutonomy` — a persisted,
   * runtime-inspectable record of whether this Task's Worker is a Manager
   * Template, independent of the Catalog entry changing later. A Manager
   * Worker delegates substantial sub-tasks to native Claude Code sub-agents
   * (the Task/Agent tool) instead of doing all the work directly — see
   * docs/architecture.md's "Manager and sub-agent flow" section. The daemon
   * uses this flag to guarantee the Task tool is never disallowed for such a
   * Task, regardless of its `kind` — see workerManager.ts's
   * `resolveDisallowedTools`.
   */
  manager: boolean;
  /** 'plan' (the workspace chat's default) or 'execute' (real coding work) — see TaskKind. */
  kind: TaskKind;
  /** Set when this Task is running one Tasks-breakdown PlanItem (POST /api/plan-items/:id/execute), null for a freeform/chat Task. */
  planItemId: string | null;
  /** A 'plan'-kind Task's session number within its Project (the "<n>." in the tasks it creates) — shared by every Task in one planning conversation. Absent on execute Tasks and on planning Tasks that predate it. */
  planningSessionNumber?: number;
  /** Shared Planning-column order. Lower values appear first; copied to every follow-up in the conversation. */
  planningQueueOrder?: number;
  /** Set on every member when planning is completed. Completed planning sessions appear in Archived. */
  planningCompletedAt?: string | null;
  /** Lifetime count used to distinguish an empty, never-used session from one eligible for auto-completion. */
  planningCreatedTaskCount?: number;
  /** Armed by a newly-created linked task and cleared when a completed session is restored. */
  planningAutoCompleteArmed?: boolean;
  /**
   * Set on a 'plan'-kind session that files bugs (see worker/bugTracker.ts): 'plan-and-bugs' files numbered tasks and bugs and sets
   * their dependencies; 'bug-report' is the earlier kind, which stays as created. Absent on a planning conversation.
   */
  planningPurpose?: 'bug-report' | 'plan-and-bugs';
  /** A bug report session created with no coding agent available: it has no CLI yet, and its description stays editable until one is started for it. */
  cliNotStarted?: boolean;
  /** A planning session's short generated name (see projects/planItemTitler.ts's `requestSessionTitle`) — copied onto its follow-ups. Absent until the title turn finishes, and on every other Task. */
  title?: string;
  /** The CLI conversation id, assigned before Claude starts or discovered from Codex output. */
  sessionId: string | null;
  /** Settings captured on the first CLI launch so resumed conversations retain their original instructions and permissions. */
  sessionSetup?: { systemPrompt: string; readOnly: boolean; disallowedTools?: string[]; testing: boolean; canRunCommands?: boolean };
  /** Executable and account environment used for the original CLI conversation. */
  sessionExecutor?: { kind: 'claude-cli' | 'codex-cli'; bin: string; env: Record<string, string> };
  /** Live PTY/turn state. Present only for interactive terminal Tasks. */
  runtimeStatus?: TerminalRuntimeStatus;
  /** Human-readable reason for a waiting/failed runtime state, when known. */
  runtimeWaitingReason?: string | null;
  /** When runtimeStatus last changed. */
  runtimeStatusChangedAt?: string | null;
  /** Ids of the Test Runs this Task's own testing-tool calls waited on (bounded, most recent last), whoever started them. */
  awaitedTestRunIds?: string[];
  /** True while the last turn-end hook was held back as "Waiting on a test run" instead of being surfaced as a wait for the owner. */
  runtimeDeferredWait?: boolean;
  /** Set while status is 'blocked': the question the Worker ended its turn with. */
  blockedQuestion: string | null;
  /** Set only when status is 'failed': what went wrong (spawn error, bad exit, etc.). */
  failureReason: string | null;
  /** Running total across every turn run so far in this Task's session — see TokenUsage. Zero for a Task created before this field existed. */
  tokenUsage: TokenUsage;
  /**
   * Set when this Task runs one step of a WorkflowRun (see WorkflowRunRecord/StepRunRecord in this
   * file and workerManager.ts's run engine) — null/absent for a freeform Task, a planning Task, or
   * one that predates workflows. Paired with `workflowStepId`; together they let a settled Task's
   * outcome be routed to the run's advance logic instead of the ordinary settle* cleanup.
   */
  workflowRunId?: string | null;
  /** The WorkflowStep (by its snapshot id) this Task is running — see `workflowRunId`. */
  workflowStepId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type TaskTurnRole = 'prompt' | 'answer' | 'raw-event' | 'result';

export interface TaskTurn {
  role: TaskTurnRole;
  content: string;
  at: string;
}

/** The running transcript for one Task — the read-only terminal transcript's source data. */
export interface TaskContextRecord {
  id: string;
  taskId: string;
  turns: TaskTurn[];
}

/**
 * One of the fixed, always-present sections of a Project's plan (the
 * "Full-fledged Project Popover"'s tabs — docs/roadmap.md). Human-readable
 * markdown per docs/architecture.md's "docs stay per-project" split — see
 * server/src/projects/plan.ts for the on-disk filenames and stub content.
 */
export type PlanDocKey = 'specifications' | 'requirements' | 'testCases' | 'e2eTesting' | 'performanceTesting';

export type PlanItemStatus = 'pending' | 'developing' | 'blocked' | 'done' | 'failed' | 'stopped';

/** Every PlanItem is a task or a bug; a record stored before types existed reads as 'task'. */
export type PlanItemType = 'task' | 'bug';
export type BugSeverity = 'critical' | 'high' | 'medium' | 'low';
/** Advisory only: it never blocks filing or starting a bug. */
export type BugInfoStatus = 'enough' | 'needs-more-info';

/** A task a bug points at, with its number and title copied when the bug was filed so they outlive the task. */
export interface BugTaskRef {
  planItemId: string;
  /** "4.002", or null for a task with no number. */
  number: string | null;
  title: string;
}

export interface BugIntroducedBy extends BugTaskRef {
  commit: string | null;
}

/** The failing test an agent-found bug was filed for; the dedupe key within one Project. */
export interface BugTestRef {
  suiteId: string;
  actionId: string;
  caseId: string;
}

/** Who reported a regression: the person at the board, or a bug report session (by its number). */
export type BugRegressionReporter = { kind: 'person' } | { kind: 'report-session'; sessionNumber: number };

/** One report that a completed bug's fix did not cure it. Recorded when the reopen starts; never edited or removed. */
export interface BugRegression {
  reason: string;
  /** ISO timestamp. */
  reportedAt: string;
  reporter: BugRegressionReporter;
}

/** What a 'bug'-type PlanItem carries beyond a task. Unset is null, and an unreadable stored value reads as null. */
export interface BugAttributes {
  severity: BugSeverity | null;
  infoStatus: BugInfoStatus | null;
  introducedBy: BugIntroducedBy | null;
  suspectedLocation: string | null;
  /** Agent-found bugs only: the task whose run hit the failing test. */
  foundWhileWorkingOn: BugTaskRef | null;
  /** The bug report session that filed it (its `planningSessionNumber`); null for an agent-found bug. */
  reportSessionNumber: number | null;
  testRef: BugTestRef | null;
  /** Position among its introducing task's ready bugs; null sorts after positioned bugs, by creation time. */
  groupOrder: number | null;
  /** The reporter's free-text sections, kept so an edit can rewrite the structured description. */
  summary: string | null;
  expectedVsActual: string | null;
  stepsToReproduce: string | null;
  /** Every regression reported on this bug, oldest first. A stored bug without the list reads as empty. */
  regressions: BugRegression[];
}

/** Where a planning-session-created PlanItem sits in its session's sequence — rendered as "<session>.<task, three digits>", e.g. "3.002". */
export interface PlanningRef {
  session: number;
  task: number;
}

/**
 * One task card on the Tasks board: a unit of proposed work a planning
 * chat turn suggested (or a person added by hand), executable on its own or
 * as part of a batch (docs/roadmap.md's "Task Execution & Tracking"). Its
 * `status` mirrors the most recent TaskRecord in `taskIds`, if any have run
 * yet — see server/src/projects/planItemService.ts.
 */
export interface PlanItemRecord {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: PlanItemStatus;
  /** Set at creation and never changed. Absent on a record stored before types existed, which reads as 'task'. */
  type?: PlanItemType;
  /** Present only on a 'bug' (see projects/bugs.ts's `readBugAttributes`). */
  bug?: BugAttributes;
  /** A task filed by a bug report session only: the bug it was filed alongside, copied when the task was created so it outlives the bug. */
  relatedBug?: BugTaskRef;
  /** A task filed by a bug report session only: that session's `planningSessionNumber`, which marks the task as the session's own. */
  reportSessionNumber?: number;
  /** How many bugs have ever been filed against this item: the last `<number>.<NNN>` suffix handed out, never reused. */
  bugSequence?: number;
  /** Manual ordering for display — lower sorts first. */
  order: number;
  /** Shared top-level Planning-column order. Nested items retain it for release/restoration. */
  planningQueueOrder?: number;
  /** Position among its planning group's ready tasks — lower first; absent sorts after positioned tasks, by `planningRef.task`. Never affects numbering, branches or stacking. */
  planningGroupOrder?: number;
  /** Instructions left for individual steps, keyed by step id: appended once to the end of that step's input the next time it starts, then removed. */
  stepNotes?: Record<string, string>;
  /** Every Task run for this item, chronological (usually zero or one; more if re-run after 'failed'). */
  taskIds: string[];
  /** Set when a planning session created this item: its session and task numbers (see planItemService.ts's `createPlanningPlanItem`). */
  planningRef?: PlanningRef;
  /** The Milestone this item belongs to (its file's id, e.g. "milestone-1"), or null for a plain, milestone-less item. Nothing sets it any more; items linked by older planning sessions keep their value. */
  milestoneId: string | null;
  /**
   * The planning Task (a 'plan'-kind TaskRecord id) whose session created this item, when one did —
   * absent/null for a standalone item typed by hand through the Planning column. Distinct from
   * `planningRef`, which only records *where* in a session's numbering the item sits: the Tasks
   * board reads this for a card's provenance ("Planning session N" vs "Added manually").
   */
  planningTaskId?: string | null;
  /** The most recent WorkflowRun executing this item, if any has ever started — see WorkflowRunRecord. */
  workflowRunId?: string | null;
  /**
   * The Executor ("worker") that ran this item, recorded once its first Task starts and fixed from
   * then on (a re-run reuses it — see workerManager.ts's `executePlanItem`). Unset before the item
   * has ever run, and absent on items that predate this field. The coding agent is chosen fresh each
   * time a task starts (the Start task dialog), so this is history, not a future default.
   */
  executorId?: string | null;
  /**
   * Set only on the PlanItem a "Set up / Reconfigure / Repair testing" click created (see
   * testing/setup.ts). The daemon alone sets it, so an ordinary item can never be passed off as a
   * setup item: it routes the item's WorkflowRun through the built-in testing-setup workflow and
   * its approval gate instead of the Project's own workflow.
   */
  testingSetup?: { mode: TestingSetupMode };
  /**
   * Set only on the PlanItem the PR tab's Merge created for a conflicting pull request (see
   * worker/conflictResolution.ts). The daemon alone sets it: it routes the item's WorkflowRun
   * through the built-in conflict-resolution workflow instead of the Project's own.
   */
  prConflict?: PullRequestConflictTarget;
  /** The task's Auto-merge toggle and where its automatic merge stands. Absent until the toggle was ever switched on. */
  autoMerge?: AutoMergeRecord;
  /** The task's own pull request as last read from the provider, for tasks without Auto-merge; see `TaskPullRequestReading`. */
  pullRequest?: TaskPullRequestReading;
  /** Other tasks of the same project this task waits for: it starts only once each parent's work is in the checked-out branch (see projects/dependencies.ts). Absent reads as none. */
  dependsOn?: string[];
  /** Present while the person asked to start this task and it is waiting for its parents; the task stays in Planning until its run is accepted. */
  waiting?: PlanItemWaiting;
  /** Set only on the PlanItem a scheduled job's run created (see scheduler/runStarter.ts). Such an item starts beside the Planning queue and never holds it. */
  scheduledJobId?: string;
  /** Hidden from every Tasks-board column (Completed included) — set via `PATCH /api/plan-items/:id {archived}`. Absent means not archived. */
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What the person can do from a waiting reason with one click. */
export type DependencyAction = 'toggle-auto-merge' | 'sync' | 'remove-dependency' | 'retry-parent';

/** Why one parent is not satisfied yet. `blocked` reasons never resolve by themselves. */
export interface DependencyReason {
  /** The parent the reason is about; absent for a reason about the start itself (a rejected automatic start). */
  parentId?: string;
  text: string;
  blocked: boolean;
  action?: DependencyAction;
}

/** The start options chosen when the person pressed Start, replayed when the task starts by itself. */
export interface DependentStartOptions {
  executorId?: string;
  workflowId?: string;
  createBranch?: boolean;
  skippedStepIds?: string[];
}

export interface PlanItemWaiting {
  options: DependentStartOptions;
  /** `blocked` when any reason is blocked; the task never starts by itself until the person acts. */
  state: 'waiting' | 'blocked';
  reasons: DependencyReason[];
  since: string;
  /** Whether the "waiting for a manual merge for a long time" notification was already raised. */
  longWaitNotified: boolean;
  /** When the task began waiting on a manual merge or pull (a reason the person must act on); absent while nothing needs them. */
  manualWaitSince?: string;
  updatedAt: string;
}

/** The pull request a conflict-resolution run works on, read from the provider when the run started. */
export interface PullRequestConflictTarget {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  /** Where the resolution is pushed: `origin`, or the fork's clone URL for a PR from a fork. */
  pushRemote: string;
  /** The task (plan item) whose Auto-merge started this run; it decides whether the run may merge once the conflicts are resolved. */
  autoMergeItemId?: string;
}

/**
 * Where a task's automatic merge stands (see projects/autoMerge.ts). `waiting` covers "on, the
 * task has not finished yet"; `provider` and `agent` are the two retried "can't act right now"
 * states; `failed` is the only one that needs a Retry.
 */
export type AutoMergeState = 'waiting' | 'merging' | 'resolving' | 'blocked' | 'provider' | 'agent' | 'merged' | 'failed' | 'no-pr' | 'cannot-merge';

/** What the Git provider last said about a task's own pull request: `none` when its branch never had one. */
export type TaskPullRequestState = 'open' | 'merged' | 'closed' | 'none';

/** The last successful reading of a task's own pull request (see projects/pullRequestStateService.ts); absent until one succeeds. */
export interface TaskPullRequestReading {
  state: TaskPullRequestState;
  prNumber: number | null;
  readAt: string;
}

export interface AutoMergeRecord {
  enabled: boolean;
  state: AutoMergeState;
  /** Why the state is what it is, in plain words (blockers, the provider's or the agent's problem, the failure). */
  reasons: string[];
  /** Checks the base branch doesn't require that are failing or running: shown, never a blocker. */
  warnings: string[];
  /** The task's own pull request, once its Complete step raised one. */
  prNumber: number | null;
  /** The conflict-resolution run this task's auto-merge started and is waiting on. */
  runId: string | null;
  mergedAt: string | null;
  /** What the merge said about the remote head branch (a failed deletion / left in place on purpose). */
  branchWarning: string | null;
  branchNote: string | null;
  updatedAt: string;
}

/**
 * How a conflict-resolution run ended once its step finished: `merged` (the PR re-checked clean and
 * was merged), `resolved` (conflicts are gone but other blockers need the person's confirmation), or
 * `failed` (still conflicting, no longer mergeable, or the merge was refused).
 */
export type PullRequestConflictOutcome = 'merged' | 'resolved' | 'failed';

/** Which Testing-tab entry point started a testing setup: config absent, valid or invalid at start time. */
export type TestingSetupMode = 'setup' | 'reconfigure' | 'repair';

/** One enabled suite's primary action as the setup evidence check found it — see TestingSetupEvidence. */
export interface TestingSetupActionEvidence {
  suiteId: string;
  actionId: string;
  /** The latest agent run of this action from the setup's implementation step, if any. */
  runId: string | null;
  status: TestRunStatus | null;
  counts: ResultCounts | null;
  /** Null when this action counts as validated; otherwise why it doesn't. */
  problem: string | null;
}

/**
 * What the testing-setup evidence check found the last time the implementation step reported it was
 * done (testing/setup.ts's `evaluateSetupEvidence`). The run completes only when `ok`.
 */
export interface TestingSetupEvidence {
  ok: boolean;
  checkedAt: string;
  config: { state: TestingConfigState['state']; suiteCount: number; issues: { path: string; message: string }[] };
  actions: TestingSetupActionEvidence[];
  problems: string[];
}

/**
 * One start accepted while its Project was at its task limit: the Project's waiting list. It starts by itself, first
 * come first served, as soon as a slot frees — see `POST /api/plan-items/:id/execute` and `workerManager.ts`'s
 * `enqueuePlanItemExecution`/`advanceQueueIfIdle`, and docs/architecture.md's "Sequential plan-item execution queue".
 * Deliberately separate from `TaskRecord`: this is a promise to run
 * something, not a running (or ever-run) Task — it's removed from the queue
 * collection the instant it actually starts, becoming an ordinary
 * `TaskRecord` (linked back via `planItemId`) instead of a queue entry with
 * some "running" status of its own. Runs in `position` order (lowest first,
 * ties by `createdAt`), which can be changed with `workerManager.ts`'s `reorderPlanItemQueue`.
 * The start's Auto-merge choice is saved on the plan item itself when the start is accepted.
 */
export interface PlanItemQueueEntry {
  id: string;
  projectId: string;
  planItemId: string;
  /** Same optional overrides `POST /api/plan-items/:id/execute` accepts — threaded through unchanged to the eventual `executePlanItem` call once this entry reaches the front of the queue. */
  executorId?: string;
  templateId?: string;
  autonomy?: Autonomy;
  workflowId?: string;
  /** An already-resolved Workflow to run as given, in place of the `workflowId` lookup (see StartPlanItemOptions.workflow). */
  workflow?: WorkflowRecord;
  createBranch?: boolean;
  /** The steps the Start task dialog left out, kept as chosen until this entry starts. Absent on entries queued before step selection existed; read as none. */
  skippedStepIds?: string[];
  /** Where this entry runs in its Project's queue — lower starts sooner. Absent on entries that predate reordering; read those as 0. */
  position?: number;
  createdAt: string;
}
export interface TemplateRecord {
  id: string;
  name: string;
  avatar: string;
  manager: boolean;
  defaultAutonomy: Autonomy;
  /** Path to the agent markdown file, relative to catalog/ (e.g. "agents/builder.md"). */
  agentFile: string;
  /** Disabled Templates stay in the Catalog but are never picked as a Task's default and shouldn't be offered when starting a new one. */
  enabled: boolean;
}

/**
 * A Skill in the Catalog: `catalog/skills/<id>/SKILL.md` (format-compatible
 * with Claude Code's own skill format) plus the game-only metadata `catalog-index.json`
 * tracks alongside it. See TemplateRecord's doc comment for the same split
 * applied to agents. Assignable to a Task via `TaskRecord.skillIds` — each
 * chosen Skill is listed (name, id, description, SKILL.md path) in its Worker's
 * `--append-system-prompt` for the agent to Read on demand, or, when also in
 * `TaskRecord.preloadSkillIds`, has its full `SKILL.md` body
 * (`catalogService.ts`'s `readSkillBody`) folded in after the Template
 * persona, in skill-id order — see `workerManager.ts`'s `startTask`
 * (validation) and `buildAppendSystemPrompt`.
 */
export interface SkillRecord {
  id: string;
  /** Display name shown in the Catalog UI — independent of the `name:` frontmatter key inside SKILL.md, which is always kept equal to `id` (that's what makes the file a valid, invocable Claude Code skill). */
  name: string;
  /** Read live from SKILL.md's frontmatter `description` field, not duplicated in the sidecar index. */
  description: string;
  /** Game-only phrases that should surface/suggest this Skill — has no Claude Code meaning of its own. */
  triggers?: string[];
  avatar?: string;
  enabled: boolean;
  /** This skill's folder, relative to catalog/ (e.g. "skills/roadmap-runner"). */
  skillDir: string;
  /** Filenames alongside SKILL.md in `skillDir`, sorted — resource files the skill can reference. */
  supportFiles: string[];
}

/**
 * One way to invoke an agent CLI: a binary plus the environment that picks a
 * specific logged-in account (e.g. CLAUDE_CONFIG_DIR for a given Claude
 * profile). See server/executors.example.json — the real server/executors.json
 * is machine-specific and git-ignored.
 */
export interface ExecutorProfile {
  id: string;
  label: string;
  /** CLI adapter used to execute and resume tasks. Every Task now runs as an interactive CLI session — see docs/architecture.md. */
  kind: 'claude-cli' | 'codex-cli';
  bin: string;
  env: Record<string, string>;
}

/**
 * A user-defined shell command, run from a Project's own root directory on
 * demand — a plain `spawn`, not a Task: no LLM, no session, no autonomy
 * setting. See docs/architecture.md's "Project Commands" decision.
 * `highlighted` commands (at most 3 per Project — enforced in
 * `commands/commandService.ts`) show as one-click buttons on the workspace
 * header; the rest are reachable through a "⋯" menu.
 */
export interface ProjectCommandRecord {
  id: string;
  projectId: string;
  name: string;
  /** The literal shell command line, run via a shell (`sh -c`) so it can use pipes/`&&`/etc. */
  command: string;
  highlighted: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * How a Project's checked-out branch compares to its `origin` counterpart,
 * as of the last `git fetch` — see `projects/gitSyncPoller.ts`.
 * - `synced`: HEAD and `origin/<branch>` point at the same commit.
 * - `ahead`: local commits not yet pushed; nothing new on the remote.
 * - `behind`: the remote has commits this checkout doesn't — the case this
 *   poller exists to catch (docs/architecture.md has no other way to notice
 *   a branch moving on GitHub while it's checked out locally).
 * - `diverged`: both sides have commits the other lacks.
 * - `no-remote`: the branch has never been pushed, so there's nothing to compare against.
 * - `unknown`: not yet checked, or the last check failed (detached HEAD, network error, etc.).
 */
export type GitSyncStatus = 'synced' | 'ahead' | 'behind' | 'diverged' | 'no-remote' | 'unknown';

/** 'behind' and 'diverged' are the two statuses that mean "the remote moved and this checkout hasn't caught up" — the states GitSyncPoller and the UI treat as needing attention. */
export const OUT_OF_SYNC_STATUSES: readonly GitSyncStatus[] = ['behind', 'diverged'];

/**
 * One Project's git-fetch-derived comparison against its remote branch, kept
 * in memory only (never persisted — it's a point-in-time reading, cheap to
 * recompute) by `projects/gitSyncPoller.ts` and pushed live over `/ws` as a
 * `projectSync` event. Surfaced to the frontend as `ProjectRecord`'s `sync`
 * field on every GET /api/projects response — see api/router.ts.
 */
export type BlockingFileKind = 'modified' | 'deleted' | 'untracked';

/** One local file an incoming update would collide with: changed locally and also changed (or, if untracked, added) by the update. */
export interface BlockingFile { path: string; kind: BlockingFileKind }

export interface ProjectSyncState {
  projectId: string;
  /** The branch this reading is for — stale (and ignorable) once the Project checks out a different one, since a fresh reading for the new branch follows within GIT_SYNC_REFRESH_MS. */
  branch: string;
  status: GitSyncStatus;
  /** Commits on HEAD not yet on origin/<branch>. */
  aheadBy: number;
  /** Commits on origin/<branch> not yet on HEAD. */
  behindBy: number;
  checkedAt: string;
  /** Why a behind or diverged branch was not pulled automatically, in plain words. Omitted when there is nothing to explain. */
  deferredReason?: string;
  /** Set with `deferredReason` when local changes overlapping the incoming commits caused the deferral: the first files (capped) and the exact count. */
  blockingFiles?: BlockingFile[];
  blockingFilesTotal?: number;
  /** The most recent automatic pull of this branch, kept while the branch stays in sync. */
  lastAutoPull?: { commits: number; at: string };
}

/**
 * Task 7.001 ("idle-aware app updates"): whether the daemon's own checkout (APP_CHECKOUT_ROOT, see
 * config.ts) has an update available from origin, and the state of applying one. Distinct from
 * `GitSyncStatus`/`ProjectSyncState`, which compare a registered *Project*'s checkout — this is the
 * app checking itself. See appUpdate/appUpdateDetector.ts.
 */
export type AppUpdateAvailability = 'up-to-date' | 'available' | 'cant-auto-update' | 'could-not-check';

/** Whether an available update only touches `web/` (applies live, no daemon restart) or anything else (needs a stop/start — see appUpdate/webOnlyUpdateRunner.ts and appUpdate/serverUpdateRunner.ts). */
export type AppUpdateClassification = 'web-only' | 'server';

/** Lifecycle of applying an update — owned by appUpdate/appUpdateService.ts, never persisted (lost on a daemon restart, by design: a held update does not survive one). */
export type AppUpdatePhase = 'idle' | 'held' | 'updating' | 'updated' | 'failed';

/** One incoming commit's identity, for the "what's changing" list in the update popover. */
export interface AppUpdateCommit { sha: string; subject: string }

/**
 * The three independently-zero counts that decide whether it's safe to apply a 'server'-classified
 * update right now (a 'web-only' one never needs this — see appUpdateService.ts's `apply`). Computed
 * fresh on demand by appUpdate/appUpdateBlocking.ts's `computeBlockingCounts` — cheap, so never cached.
 */
export interface AppUpdateBlockingCounts {
  testRuns: number;
  commands: number;
  terminalSessions: number;
}

/** The footer item's and update popover's whole data source — see appUpdate/appUpdateService.ts. */
export interface AppUpdateStatus {
  mode: 'dev' | 'prod';
  /** False in dev mode, or whenever availability isn't 'available', or while held/updating (no re-apply mid-flight). */
  canApply: boolean;
  /** Set whenever canApply is false and there's something specific to say (dev mode, already held, etc.); null when canApply is true or the reason is just "nothing to apply" (up-to-date). */
  applyBlockedReason: string | null;
  availability: AppUpdateAvailability;
  branch: string;
  /** Short sha of HEAD as of the last check; null only if never successfully checked (not a git checkout, etc.). */
  currentCommit: string | null;
  aheadBy: number;
  behindBy: number;
  /** Set only when availability === 'available'. */
  classification: AppUpdateClassification | null;
  installWebDeps: boolean;
  incomingCommits: AppUpdateCommit[];
  incomingCommitsTruncated: boolean;
  /** Set when availability === 'cant-auto-update' (overlapping local changes / ahead / diverged — names which). */
  cantUpdateReason: string | null;
  /** Local files the incoming update also changes (capped; empty when none block). Local changes to other files never appear here. */
  blockingFiles: BlockingFile[];
  /** How many files block, including those cut from `blockingFiles`. */
  blockingFilesTotal: number;
  /** Set when the most recent check attempt failed; the OTHER fields above still reflect the last successful check, untouched. */
  checkError: string | null;
  /** Last attempted check, success or failure; null only before the very first check ever runs. */
  checkedAt: string | null;
  /** Last check that succeeded; null if there has never been one. Footer/popover use this (not checkedAt) to tell "first-ever check failed, nothing to show" apart from "a later check failed, previous result still shown". */
  lastSuccessfulCheckAt: string | null;
  phase: AppUpdatePhase;
  blocking: AppUpdateBlockingCounts;
  /** Short sha, set once phase reaches 'updated'. */
  updatedToCommit: string | null;
  failureMessage: string | null;
  /** Path (relative to RUN_DIR) to the update log, set whenever phase is 'failed' (or 'updated', for consistency — same log). */
  failureLogPath: string | null;
}

export type CommandRunStatus = 'running' | 'success' | 'failed' | 'stopped';

/**
 * What produced a CommandRun: `'saved'` runs a persisted ProjectCommandRecord
 * (`commandId` is that record's real id); `'sync'` is the branch-sync
 * button's fixed `git fetch`/`merge --ff-only` (`commandId` a synthetic
 * per-project constant — see `commandRunner.ts`'s `runProjectSync`);
 * `'adhoc'` is a one-off typed directly into the "Run custom command" dialog
 * (`commandId` a synthetic, run-unique id — see `runAdHocCommand`). Only
 * `'adhoc'` runs offer "Save as command" in the log popup, since a `'saved'`
 * run already is one and a `'sync'` run is a fixed system action, not
 * something worth saving as a reusable command.
 */
export type CommandRunOrigin = 'saved' | 'sync' | 'adhoc';

/**
 * Where a CommandRun ran: the Project's own folder (`main`, what the header's commands use), or a
 * WorkflowRun's own worktree (`task`, started from that run's Quick look). `taskRef` is the item's
 * planning number ("5.008") when it has one.
 */
export type CommandRunLocation =
  | { kind: 'main' }
  | { kind: 'task'; workflowRunId: string; planItemId: string; branch: string | null; taskRef: string | null };

/**
 * One execution of a ProjectCommand (or a sync/ad hoc run — see
 * `CommandRunOrigin`) — the log popup's and History tab's source data.
 * Carries its own snapshot of the command's name/text
 * (`commandName`/`commandText`) so a run stays meaningful in History even
 * after the command that produced it is edited or deleted.
 */
export interface CommandRunRecord {
  id: string;
  projectId: string;
  commandId: string;
  commandName: string;
  commandText: string;
  origin: CommandRunOrigin;
  /** Absent on runs recorded before locations existed; those ran in the Project's own folder. */
  location?: CommandRunLocation;
  status: CommandRunStatus;
  /** Set once the process exits on its own; null while running or if it was stopped before exiting. */
  exitCode: number | null;
  /** Combined stdout+stderr, appended to as the process runs. */
  output: string;
  startedAt: string;
  completedAt: string | null;
  /** True for a branch sync the daemon ran by itself (`projects/autoPull.ts`); absent for one a person started. */
  automatic?: true;
  /**
   * Set when a non-sync run fails, and cleared once anyone opens its log (`POST /command-runs/:id/opened`):
   * the 3D village keeps a red machine for it until then. Absent on runs that failed before this existed, which count as opened.
   */
  failureUnopened?: true;
}

/**
 * A Test Run's lifecycle — see docs/testing-contract.md's "Test Runs" section. `queued`/`running`
 * are active; the rest are terminal. `failed` means a valid report (or, with no collectors, the
 * exit code) said tests/thresholds failed; `error` means the run couldn't produce a trustworthy
 * result at all (spawn failure, missing/malformed required artifact, the daemon restarting mid-run).
 */
export type TestRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'stopped';

/** Who asked for a Test Run: a person in the UI/REST (`manual`) or a Worker on behalf of its Task (`agent`). */
export type TestRunTrigger = 'manual' | 'agent';

export type TestRunDiagnosticCode =
  | 'config-unavailable'
  | 'unsafe-working-directory'
  | 'spawn-failed'
  | 'artifact-missing'
  | 'artifact-unsafe-path'
  | 'artifact-malformed'
  | 'exit-code-mismatch'
  | 'truncated'
  | 'artifact-cleanup-failed'
  | 'log-write-failed'
  | 'background-processes-stopped'
  | 'timed-out'
  | 'interrupted'
  | 'internal-error';

/** Why a run ended up the way it did — shown next to the result, never silently dropped. */
export interface TestRunDiagnostic {
  code: TestRunDiagnosticCode;
  message: string;
  /** Set when the diagnostic is about one declared Collector. */
  collectorId?: string;
}

/**
 * The framework-neutral result every Collector format is normalized into (the `avos-result`
 * shape minus its envelope). Merged across an action's Collectors; `cases`/`findings` have a
 * generous sanity cap (see testing/collectors.ts) with a `truncated` diagnostic when anything was
 * dropped. Stored in the run's own `<id>.result.json`, not in `test-runs.json` — see testing/runFiles.ts.
 */
export interface NormalizedTestResult {
  outcome: TestOutcome;
  durationMs?: number;
  counts?: ResultCounts;
  metrics: ResultMetric[];
  findings: ResultFinding[];
  cases: ResultCase[];
}

/**
 * The part of a NormalizedTestResult small enough to keep on the run record itself, so History,
 * the overview and WS events can show an outcome without reading the run's result file.
 */
export interface TestResultSummary {
  outcome: TestOutcome;
  durationMs?: number;
  counts?: ResultCounts;
  metrics: ResultMetric[];
  findingCounts: Record<FindingSeverity, number>;
}

/**
 * One execution of a Test Action. The record is persisted centrally (`test-runs.json`), never
 * under a Project's `.docs/`; its log and full result live in per-run files beside it (see
 * testing/runFiles.ts). Carries its own suite/action snapshot so History stays readable after the
 * config renames or removes the action. See testing/testRunner.ts.
 */
export interface TestRunRecord {
  id: string;
  projectId: string;
  /** Shared by every run a single "Run all" request enqueued; null for a single-action run. */
  batchId: string | null;
  suite: { id: string; label: string; kind: TestSuiteKind };
  /** Refreshed from the config read at start time, so it records what actually ran. */
  action: Pick<TestActionConfig, 'id' | 'label' | 'purpose' | 'command' | 'workingDirectory' | 'collectors'>;
  trigger: TestRunTrigger;
  /** The Task an `agent` run was requested for (its worktree is the execution root). */
  taskId: string | null;
  /** Absolute directory the action's `workingDirectory` is resolved under: the Project's primary working tree, or the Task's own cwd/worktree. */
  executionRoot: string;
  /** Absolute cwd the command actually ran in; null until it starts. */
  cwd: string | null;
  branch: string | null;
  commit: string | null;
  status: TestRunStatus;
  /** The process's own exit code — kept alongside `result`, since a failing report usually comes with a nonzero exit. */
  exitCode: number | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  /** True once some of the log was left out to stay within its bounds — see testing/runLog.ts. */
  outputTruncated: boolean;
  /** Null for utility actions, result actions with no Collectors, and runs that never parsed anything. */
  summary: TestResultSummary | null;
  diagnostics: TestRunDiagnostic[];
  /** The per-run artifact directory while it exists; null once cleaned up. */
  artifactDir: string | null;
  /** Set when the run finishes `failed` or `error`, cleared once anyone opens it (`POST /test-runs/:id/opened`) — see `CommandRunRecord.failureUnopened`. */
  failureUnopened?: true;
}

/**
 * Milestone 5 (docs/milestones/milestone-5-notification-system.md): the
 * shared primitive every producer — Task lifecycle, Command runs, git-sync,
 * Catalog installs — reports into. Drives the building dot's color, toasts,
 * and the Notifications drawer; independent of any one TaskRecord/CommandRunRecord,
 * which stay the source of truth for their own history.
 *
 * Two independent axes replace the old single `status` field: `readAt` is the user's own call (have
 * they seen it), `resolvedAt` is the system's (is the condition that raised it still true). Resolving
 * also marks read — see notifications/notificationService.ts's `resolveNotifications`.
 */
export type NotificationSeverity = 'info' | 'warning' | 'critical';

/**
 * What a Notification is about, and where clicking it goes. A subject's *identity* — what
 * `raiseNotification` dedupes an unresolved Notification on — is its `type` plus whichever field
 * names the thing itself (`conversationId`/`commandId`/`projectId`/`repo`); `taskId`/`runId` are
 * NOT part of identity, only carried for the deep link to the latest attempt.
 */
export type NotificationSubject =
  | { type: 'task'; projectId: string; conversationId: string; taskId: string }
  | { type: 'command'; projectId: string; commandId: string; runId: string }
  | { type: 'project'; projectId: string }
  | { type: 'testRun'; projectId: string; runId: string }
  | { type: 'skill'; repo: string }
  | { type: 'app' }
  | { type: 'scheduledJob'; projectId: string; jobId: string }
  /** Task-scoped: auto-merge and dependent-task notifications (their kinds differ, so identities never clash). */
  | { type: 'autoMerge'; projectId: string; planItemId: string };

/**
 * What raised a Notification. The first six are this milestone's own producers (see the raise/resolve
 * catalog in docs/milestones/milestone-5-notification-system.md); the last three
 * (`testing.failed`/`workflow.*`) keep two pre-existing producers (a manual Test Run failing,
 * a WorkflowRun entering awaiting-approval/needs-attention) working under this model — neither was
 * named in this milestone's own spec, and dropping their Notifications outright would have been a
 * silent behavior regression, so Development added them rather than removing the behavior.
 */
export type NotificationKind =
  | 'task.needs_input'
  | 'task.failed'
  | 'task.completed'
  | 'task.limit_reached'
  | 'command.failed'
  | 'command.completed'
  | 'git.out_of_sync'
  | 'github.account_failed'
  | 'git.auto_pull_failed'
  | 'skill.install_failed'
  | 'testing.failed'
  | 'testing.passed'
  | 'workflow.awaiting_approval'
  | 'workflow.needs_attention'
  | 'app.update_available'
  | 'storage.problem'
  | 'schedule.run_failed'
  | 'schedule.job_disabled'
  | 'connection.awaiting_approval'
  | 'connection.subscription_disabled'
  | 'automerge.blocked'
  | 'automerge.merged'
  | 'automerge.conflict_failed'
  | 'automerge.failed'
  | 'seo.tasks_overdue'
  | 'seo.report_published'
  | 'seo.crawl_failed'
  | 'crm.connection_needs_attention'
  | 'dependency.started'
  | 'dependency.blocked'
  | 'dependency.long_wait'
  | 'executor.default_switched';

export const NOTIFICATION_KINDS: NotificationKind[] = [
  'task.needs_input', 'task.failed', 'task.completed', 'task.limit_reached',
  'command.failed', 'command.completed', 'git.out_of_sync', 'github.account_failed', 'git.auto_pull_failed', 'skill.install_failed',
  'testing.failed', 'testing.passed', 'workflow.awaiting_approval', 'workflow.needs_attention',
  'app.update_available', 'storage.problem', 'schedule.run_failed', 'schedule.job_disabled',
  'connection.awaiting_approval', 'connection.subscription_disabled',
  'automerge.blocked', 'automerge.merged', 'automerge.conflict_failed', 'automerge.failed',
  'seo.tasks_overdue', 'seo.report_published', 'seo.crawl_failed', 'crm.connection_needs_attention', 'dependency.started', 'dependency.blocked', 'dependency.long_wait',
  'executor.default_switched',
];

/** Severity is fixed per kind — never a caller-supplied value. */
export const NOTIFICATION_SEVERITY_BY_KIND: Record<NotificationKind, NotificationSeverity> = {
  'task.needs_input': 'warning',
  'task.failed': 'critical',
  'task.completed': 'info',
  'task.limit_reached': 'warning',
  'command.failed': 'warning',
  'command.completed': 'info',
  'git.out_of_sync': 'warning',
  'github.account_failed': 'warning',
  'git.auto_pull_failed': 'warning',
  'skill.install_failed': 'warning',
  'testing.failed': 'warning',
  'testing.passed': 'info',
  'workflow.awaiting_approval': 'warning',
  'workflow.needs_attention': 'critical',
  'app.update_available': 'info',
  'storage.problem': 'warning',
  'schedule.run_failed': 'warning',
  'schedule.job_disabled': 'critical',
  'connection.awaiting_approval': 'warning',
  'connection.subscription_disabled': 'warning',
  'automerge.blocked': 'warning',
  'automerge.merged': 'info',
  'automerge.conflict_failed': 'warning',
  'automerge.failed': 'warning',
  'seo.tasks_overdue': 'warning',
  'seo.report_published': 'info',
  'seo.crawl_failed': 'warning',
  'crm.connection_needs_attention': 'warning',
  'dependency.started': 'info',
  'dependency.blocked': 'warning',
  'dependency.long_wait': 'warning',
  'executor.default_switched': 'info',
};

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  subject: NotificationSubject;
  /** Derived from `subject` at raise time — null for the two project-less subjects (a Catalog skill install, or an app update). Denormalized so a plain projectId filter never has to branch on subject.type. */
  projectId: string | null;
  /** Short, specific — the task's first line / command name / project name / skill repo. Shown on the dot's hover and in toasts. */
  title: string;
  /** Longer detail, shown in the Notifications drawer. */
  description: string;
  /** Owned by the user: null until they've seen it. */
  readAt: string | null;
  /** Owned by the system: null while the condition that raised this is still true. */
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Read AND resolved Notifications with `resolvedAt` older than this are pruned — see notificationService.ts's `pruneNotifications`. */
export const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Task 3.012 ("Configurable task workflows"): every executed Task now runs through a Catalog
 * Workflow — an ordered list of Steps, each run by exactly one Catalog agent, each receiving every
 * earlier step's outputs as input. See `catalog/workflowService.ts` for storage/CRUD/validation and
 * `worker/workflowPrompt.ts` + `workerManager.ts`'s run engine for how a WorkflowRecord becomes a
 * running WorkflowRunRecord. This supersedes the older proposal in
 * docs/milestones/milestone-9-workflow-catalog.md.
 */

/** The agent/skills/executor/instructions one WorkflowStep runs with. */
export interface WorkflowAgentConfig {
  /** A TemplateRecord id — validated to exist in the Catalog at Workflow save time (`catalog/workflowService.ts`). */
  agentId: string;
  /** SkillRecord ids attached to the session, loaded on demand or in full per `preloadSkillIds`, same rules as TaskRecord.skillIds. */
  skillIds?: string[];
  /** The subset of `skillIds` to paste in full every run ("always load"); validated at Workflow save. Absent or empty means all on demand. */
  preloadSkillIds?: string[];
  /** An ExecutorProfile id overriding the run's own executor for just this stage/step; null/undefined defers to the run's executor. */
  executorId?: string | null;
  /** Appended to the stage/step's prompt — see worker/workflowPrompt.ts's buildStepPrompt. */
  instructions: string;
}

/** One step of a Workflow's `steps` list. "Complete" (commit, push, raise PR) is built-in and never a WorkflowStep of its own. */
export interface WorkflowStep extends WorkflowAgentConfig {
  /** Unique (within its Workflow) kebab-case slug — stable across edits so a WorkflowRun's StepRuns keep pointing at the right step even if steps are reordered/renamed later (the run itself works off a frozen `workflowSnapshot`, though, so this only matters within one snapshot). */
  id: string;
  name: string;
  /** Whether this step may change code — Development and Docs & Retro do; every read-only stage (planning, review, test-case design) does not, and is enforced the same way a 'plan'-kind Task is (see workerManager.ts's `resolveDisallowedTools`). */
  canEditCode: boolean;
  /** Whether a read-only step may run shell commands (install dependencies, run tests, build) and use the testing tools. It still gets no file-editing tools and is never committed; absent reads as off, and a step with `canEditCode` gains nothing from it. */
  canRunCommands?: boolean;
  /** Whether this step pauses the run for a human decision (`awaiting-approval`) instead of advancing straight to the next step. */
  requiresApproval: boolean;
  /**
   * Makes this step a review-type loop origin: a `verdict: 'issues'` sent to `complete_step` re-runs
   * `toStepId` (which must be an EARLIER step in this Workflow's `steps` array) and everything
   * between it and this step, then re-runs this step itself, up to `maxRounds` times before the run
   * pauses `needs-attention` for a human decision (`POST /api/workflow-runs/:id/loop`). Null/absent
   * for a step that isn't a loop origin.
   */
  loopBack?: { toStepId: string; maxRounds: number } | null;
  /**
   * Only on a `requiresApproval` step: the EARLIER step (by id) that Request changes sends the run
   * back to. That step runs a new round continuing its latest session with the person's comment,
   * then the run carries on forward through the following steps (any review loop included) and
   * this step waits for approval again. Null/absent re-runs this step itself. A testing setup run
   * ignores it and keeps its own proposal rules.
   */
  requestChangesToStepId?: string | null;
  /** What this step's detail in the run view offers as a Quick look at the task's work in progress. Absent or null reads as `'none'`. */
  quickLook?: QuickLookKind | null;
}

/**
 * A WorkflowStep's Quick look: a live, read-only view of the run's working directory in the run
 * view — the file browser (`code`), the branch's changes against its base (`diff`), the `.docs/`
 * browser (`documents`), or the Project's commands run from that directory (`commands`).
 */
export type QuickLookKind = 'none' | 'code' | 'diff' | 'documents' | 'commands';

export const QUICK_LOOK_KINDS: readonly QuickLookKind[] = ['none', 'code', 'diff', 'documents', 'commands'];

export interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  /** A disabled Workflow stays in the Catalog but is never offered as a Project's default or selectable choice — same convention as TemplateRecord/SkillRecord's `enabled`. */
  enabled: boolean;
  /**
   * The fixed first segment of a branch a run of this Workflow creates (`bugfix` gives
   * `bugfix/<ref>-<summary>`) — a lowercase slug. Null/absent gives `feature` — see
   * projects/branchName.ts's `resolveBranchName`.
   */
  branchType?: string | null;
  /** Ordered; "Complete" (commit, push, raise PR) is implicit and always runs last, after every step here. */
  steps: WorkflowStep[];
}

/** The start-up steps of a run, in order: `stack` decides the base branch, `name` picks the branch, `worktree` creates it, `hooks` installs the CLI hooks, `launch` starts the first step's agent. */
export type RunStartupStepId = 'name' | 'worktree' | 'hooks' | 'launch';

export interface RunStartupStep {
  id: RunStartupStepId;
  /** What the person reads while the step is current, e.g. "Creating worktree". */
  name: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  /** Why the step failed; set only when `state` is 'failed'. */
  reason?: string;
}

/** The visible, persisted state of a run's start-up (status 'starting', or a start that ended in failure/attention). Absent on a run that never had one. */
export interface RunStartup {
  steps: RunStartupStep[];
  /** The run reuses its item's existing branch (a retry), so a cleanup must never delete it. */
  reuseBranch: boolean;
}

export type WorkflowRunStatus = 'starting' | 'running' | 'awaiting-approval' | 'needs-attention' | 'completing' | 'completed' | 'failed' | 'stopped';

/**
 * One run of a Workflow against one PlanItem — created by `workerManager.ts`'s `executePlanItem`
 * instead of a bare execute Task. Snapshots its WorkflowRecord at creation time
 * (`workflowSnapshot`) so a later Catalog edit never changes an in-flight run. Works in its own
 * worktree, or in place in the Project's folder, which it then keeps until it settles — see
 * workerManager.ts's `assignWorkflowRunWorkspace`.
 */
export interface WorkflowRunRecord {
  id: string;
  projectId: string;
  planItemId: string;
  workflowId: string;
  workflowSnapshot: WorkflowRecord;
  status: WorkflowRunStatus;
  /** Set while the run is 'starting', and kept if the start ended in 'failed'/'stopped'/'needs-attention' before the agent launched. Absent on runs from before start-up was a visible phase. */
  startup?: RunStartup;
  /** The WorkflowStep (snapshot id) currently running/awaiting a decision; null once past the last step (the Complete stage is running) or before the run has any repository-backed steps. */
  currentStepId: string | null;
  /** The branch this run's worktree was created off — the Project's own checked-out branch, or a stacked prior run's branch (see stacking in workerManager.ts's `startWorkflowRun`). Undefined for a repository-less Project, and for a run started with `createBranch: false` (it has no branch of its own to diff or raise a PR from). */
  baseBranch?: string;
  /**
   * This run's own branch — `<type>/<ref>-<summary>` (planning-session tasks) or `<type>/<summary>`
   * (a task added by hand), where `type` is `feature`/`bugfix` (or the Workflow's own fixed
   * `branchType`, if it has one) and `summary` is a slug of the task's title, deduplicated against
   * any existing branch — see projects/branchName.ts's `resolveBranchName`. Reused as-is on a
   * retry/resume of the same PlanItem, never regenerated. Kept even after the run's worktree is removed, so its PR/branch stays
   * reachable. For a run started with `createBranch: false`, the Project's own checked-out branch it
   * works on in place. Undefined for a repository-less Project.
   */
  branch?: string;
  /** Absolute path to this run's own git worktree, shared by its steps and retained after cleanup so a settled session can restore the same path from the task branch. Undefined for a repository-less or in-place run. */
  worktreePath?: string;
  /** A completed run's reopened editing session left changes in a recreated working copy. */
  pendingInspectChanges?: { taskId: string; worktreePath: string; state: 'pending' | 'committing' | 'discarding'; hasChanges: boolean; error?: string } | null;
  executorId: string;
  prUrl: string | null;
  /** Set once the Complete stage finishes (success or not) — see workerManager.ts's `completeWorkflowRun`. */
  completionReport: string | null;
  /** Set while status is 'needs-attention': why a human needs to look (a step ended without completing, a loop exhausted its rounds, restart recovery found an orphaned step, etc.). */
  attentionReason: string | null;
  /**
   * Internal bookkeeping for a loop-origin step's round budget: `POST /api/workflow-runs/:id/loop`
   * with `action: 'another-round'` increments this rather than silently exceeding
   * `WorkflowStep.loopBack.maxRounds` forever — an explicit human override, not part of the public
   * Workflow definition. Zero until a loop is ever overridden.
   */
  loopRoundAllowance: number;
  /**
   * The steps left out when the run was started (the Start task dialog's unchecked steps), in
   * workflow order. Each has one round-1 'skipped' StepRunRecord made at start, and the run never
   * starts, pauses on or loops back to one of them. Absent on runs started before this existed; read as none.
   */
  skippedStepIds?: string[];
  /**
   * Set only on a run that re-runs a completed bug after a reported regression. `roundOffsets` maps a
   * step id to the highest round that step reached in the bug's earlier runs, so this run's round 1 of
   * that step is shown as the next round (`offset + round`). A step with no entry is on its first round.
   */
  regression?: { roundOffsets: Record<string, number> };
  /** Set only on a testing-setup run (see PlanItemRecord.testingSetup and testing/setup.ts). */
  testingSetup?: { mode: TestingSetupMode; evidence: TestingSetupEvidence | null };
  /** Set only on a conflict-resolution run (see PlanItemRecord.prConflict): its pull request, and how it ended once it has. */
  prConflict?: PullRequestConflictTarget & { outcome: PullRequestConflictOutcome | null; detail: string | null };
  /**
   * A denormalized summary of the currently-running round's `StepRunRecord.progress` (task 5.017),
   * kept in step with it by `reportProgress` and cleared to null whenever a new step round starts
   * (`startStepTask`) — so the Running board card can show "N/M · ~estimate" without loading the
   * run's full step/round detail. Absent on records written before this existed, or before the
   * current round has ever reported; read the same as null.
   */
  currentStepProgress?: StepProgressSummary | null;
  /**
   * The current step's active round's own `createdAt`, mirrored here by `startStepTask` alongside
   * `currentStepId` (task 5.003) so the Running board card's live timer doesn't need the run's full
   * round history loaded. Reset to the new round's `createdAt` every time a round starts; null
   * before any step has started, and absent on records written before this field existed (read the
   * same as null).
   */
  currentStepRoundStartedAt?: string | null;
  /**
   * Every earlier round's own ms (`completedAt - createdAt`) for the step now at
   * `currentStepRoundStartedAt`, summed by `priorRoundsMs` in workerManager.ts and carried forward so
   * the live timer's running total continues across rounds instead of restarting at zero. Zero on a
   * step's first-ever round; absent (read as 0) on records written before this field existed.
   */
  currentStepPriorRoundsMs?: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type StepRunStatus = 'running' | 'awaiting-approval' | 'changes-requested' | 'done' | 'skipped' | 'failed' | 'stopped';

export type StepProgressItemState = 'pending' | 'in-progress' | 'done' | 'skipped';

/** One checklist item in a step session's self-reported progress — see `StepRunProgress`. */
export interface StepProgressItem {
  text: string;
  state: StepProgressItemState;
  note: string | null;
  /** A 1-2 word label for the item ("writing code"), trimmed by `worker/stepProgress.ts`'s `trimShortLabel`; absent on progress stored before labels existed. */
  short?: string | null;
}

/**
 * A running step session's self-reported progress (task 5.017: `report_progress`), replacing the
 * round's previous progress wholesale on every call — never merged field-by-field, and never kept as
 * a history. `estimatedAt` is stamped by the server the instant a non-null `estimate` is given, so the
 * UI can show how stale it is; both are null together whenever the agent gives no estimate.
 */
export interface StepRunProgress {
  checklist: StepProgressItem[];
  currentActivity: string | null;
  estimate: string | null;
  estimatedAt: string | null;
}

/** The board card's and 3D village's whole need from a run's current progress: counts, the agent's own estimate text, verbatim, and the first in-progress item's `short` label. `total` includes skipped items; `done` does not. */
export interface StepProgressSummary {
  done: number;
  total: number;
  estimate: string | null;
  /** Null when no item is in progress or it has no label; absent on summaries stored before labels existed. */
  currentLabel?: string | null;
}

export interface StepRunOutput {
  name: string;
  format: 'markdown' | 'html';
  content: string;
}

export interface StepRunApproval {
  decision: 'approved' | 'changes-requested';
  comment: string | null;
  at: string;
}

/**
 * One attempt at one WorkflowStep within a WorkflowRun. `round` starts at 1 and increments whenever
 * the step runs again in the same run (a loop re-run, Request changes, a resumed stop, or a manual
 * retry); every later round except a retry continues the step's latest earlier session (see
 * workerManager.ts's `startStepTask`). Every StepRunRecord for a given
 * (runId, stepId) pair is kept, never overwritten, so the full review/revision history stays
 * available to later prompts (see worker/workflowPrompt.ts) and the UI's stage stepper.
 */
export interface StepRunRecord {
  id: string;
  runId: string;
  stepId: string;
  round: number;
  /** The TaskRecord actually running this attempt — null for a step left out at start (it never gets one). */
  taskId: string | null;
  status: StepRunStatus;
  summary: string | null;
  outputs: StepRunOutput[];
  /** Required by `complete_step` only when this step is a loop origin (`WorkflowStep.loopBack` set) — null otherwise or before completion. */
  verdict: 'pass' | 'issues' | null;
  /** Set only when status is 'skipped' — the `skip_step` tool's `reason`, or SKIPPED_AT_START_REASON for a step left out at start. */
  skippedReason: string | null;
  /**
   * `complete_step`'s optional `planningGap`: free text the step used to flag an ambiguity that
   * planning should have resolved before it started. Every one raised in a run is folded into later
   * steps' prompts (worker/workflowPrompt.ts), so the retro step can fix it at the source. Absent on
   * records written before this field existed.
   */
  planningGap?: string | null;
  approval: StepRunApproval | null;
  /**
   * This round's self-reported progress (task 5.017's `report_progress`), only ever written while
   * the round is `status: 'running'` — wholly replaced on every call, never merged or history-kept.
   * Stays on the record once the round settles, so a finished round's collapsible Progress section and
   * a failed/stopped round's "last known state" can still show it. Absent until first reported, and
   * always absent on a fresh round (a new StepRunRecord never inherits an earlier round's progress).
   */
  progress?: StepRunProgress | null;
  createdAt: string;
  completedAt: string | null;
}

/** One slot's saved choices for a Building Type; both fields are optional overrides of the type's defaults. */
export interface SlotConfig {
  /** A Catalog workflow id, or null for the type's built-in default. */
  workflowId: string | null;
  /** Step id -> Catalog agent id, for steps of the effective workflow. */
  stepAgents: Record<string, string>;
}

/** Configuration is per Building Type (id = the type id), never per Building. */
export interface BuildingTypeConfigRecord {
  id: string;
  slots: Record<string, SlotConfig>;
  updatedAt: string;
}

/** One live PTY (pseudo-terminal), as the status footer lists it. One entry per PTY, so the list's length equals `AppUpdateBlockingCounts.terminalSessions`. */
export interface LiveTerminalSessionDto {
  /** The terminal registry's key: a Task id, an Agent session id or a Content Studio session id. */
  id: string;
  kind: 'planning' | 'bug-report' | 'task' | 'agent' | 'content-studio';
  /** The Project (or Content Building) it belongs to; null when the record behind the PTY can no longer be found. */
  projectId: string | null;
  title: string;
}
