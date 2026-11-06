/**
 * Thin client for agent-visual-os's daemon (server/). No caching, no
 * retries — the store owns reconciling responses and WS pushes into state.
 * See docs/architecture.md#background-daemon-not-session-bound.
 */
import type { CronPreview, HistoryPage, JobHistoryEntry, JobRequest, ScheduledJob, SchedulesView } from './schedules';
import type { ScheduleEvent } from '../store/schedulesStore';
import type { AgentSession, AgentSessionEvent } from './agentSessions';
import type { StudioEvent } from './contentStudio';
import type { RemotionStudioEvent } from './contentRemotion';
import type { ServerBuildingType } from './buildingTypes';
import type { DataQuery, StorageJobDto, StorageStatusDto } from './buildingStorage';
import { dataQueryString } from './buildingStorage';
import type { ConfigSlot, SlotEdit } from './typeConfig';
import type { ReportDto, SavedMetaDto, SavedReportDto, ScheduleStateDto, SummaryDto } from './seoReports';
import type { ProposalDto, ProposalRowDto, ScheduleDto, TaskDetailDto, TaskListDto, TaskRowDto } from './seoTasks';
import type { BacklinksDto, BatchDto, CommitDto, DomainRollupDto, ImportRequestDto, MappingDto, OverviewDto, PreviewDto, TargetRollupDto } from './seoBacklinks';
import type { AddResultDto, ClustersDto, KeywordDetailDto, KeywordsDto, ProposalsDto, RunDto, SuggestionDto } from './seoKeywords';
import type { CompareDto, CrawlLogDto, CrawlLogPageDto, CrawlSettingsDto, GraphDto, MatrixDto, OverviewDto as LinksOverviewDto, PageLinksDto, RunDto as CrawlRunDto } from './seoInternalLinks';
import type { PageDetailDto, PagesDto } from './seoPages';
import type { BingDto, KeyFileDto, LogEntryDto, SitemapsDto, SubmitOutcomeDto, UrlRowDto } from './seoSitemaps';
import type { ConnectionsViewDto, DataStatusDto, DiscardPreviewDto } from './seoWorkspace';
import type { ActivityEntry, CallOutcome, LinkRequest, LinksResponse, LinkView, SubscriptionView } from './connections';
import type { BugInfoStatus } from './bugs';
import type { GitProviderId } from './gitProvider';
import type { AccountCheck, GithubAccountsResult } from './githubAccounts';
import type { MergeRequestOptions, MergeResponse, MergeStateResponse } from './pullRequestActions';
import type { PullRequestsResponse } from './pullRequests';
import type { AutoMergeData, TaskPullRequestData, DependencyReasonData, PullRequestCheckout, PullRequestConflictTarget, WaitingData } from '../types';

export type ProjectStatus = 'idle' | 'developing' | 'blocked';
export type TaskStatus = 'developing' | 'blocked' | 'done' | 'failed' | 'stopped';
export type TerminalRuntimeStatus = 'starting' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'stopped' | 'disconnected';

/**
 * How a Project's checked-out branch compares to `origin/<branch>` as of the
 * daemon's last `git fetch` (every 60s — see server/src/projects/gitSyncPoller.ts).
 * `behind`/`diverged` mean the remote has commits this checkout doesn't.
 */
export type GitSyncStatus = 'synced' | 'ahead' | 'behind' | 'diverged' | 'no-remote' | 'unknown';

/** See server/src/domain/types.ts's ProjectSyncState. Never persisted server-side — a point-in-time reading, refreshed live over `/ws` as a 'projectSync' WorkerEvent. */
export interface ProjectSyncState {
  projectId: string;
  branch: string;
  status: GitSyncStatus;
  aheadBy: number;
  behindBy: number;
  checkedAt: string;
  /** Why a behind or diverged branch was not pulled automatically, in plain words — see server/src/domain/types.ts's ProjectSyncState. */
  deferredReason?: string;
  /** Set with `deferredReason` when local changes overlapping the incoming commits caused the deferral (capped); `blockingFilesTotal` is the exact count. */
  blockingFiles?: BlockingFile[];
  blockingFilesTotal?: number;
  /** The most recent automatic pull of this branch. */
  lastAutoPull?: { commits: number; at: string };
}

// ---- App update (task 7.001): the daemon's own git checkout vs. origin, and its idle-aware self-update ----

/** A local file an incoming update would collide with. */
export interface BlockingFile {
  path: string;
  kind: 'modified' | 'deleted' | 'untracked';
}

/** Whether the daemon's last check found anything to apply, and why not when it didn't. */
export type AppUpdateAvailability = 'up-to-date' | 'available' | 'cant-auto-update' | 'could-not-check';
/** Whether an available update only touches the web app (applies with zero daemon interruption) or needs both processes restarted. Set only while `availability === 'available'`. */
export type AppUpdateClassification = 'web-only' | 'server';
/** Where an apply is in its lifecycle; `'idle'` means no apply is in flight (the common case — see `availability` for what's available). */
export type AppUpdatePhase = 'idle' | 'held' | 'updating' | 'updated' | 'failed';

export interface AppUpdateCommit {
  sha: string;
  subject: string;
}

/** What's currently keeping a `'server'`-classified update from applying — all zero means nothing is blocking it. */
export interface AppUpdateBlockingCounts {
  testRuns: number;
  commands: number;
  terminalSessions: number;
}

/**
 * GET /api/app-update's whole reading, pushed live over `/ws` as an 'appUpdate' WorkerEvent whenever
 * it changes. See docs/architecture.md for why only a clean fast-forward with no local changes is
 * ever auto-applied, and why a server-touching change waits for every count in `blocking` to reach
 * zero before restarting.
 */
export interface AppUpdateStatus {
  mode: 'dev' | 'prod';
  canApply: boolean;
  applyBlockedReason: string | null;
  availability: AppUpdateAvailability;
  branch: string;
  /** Short sha of HEAD as of the last successful check. */
  currentCommit: string | null;
  aheadBy: number;
  behindBy: number;
  /** Set only when `availability === 'available'`. */
  classification: AppUpdateClassification | null;
  installWebDeps: boolean;
  /** Newest first, capped at 10 — see `incomingCommitsTruncated`. */
  incomingCommits: AppUpdateCommit[];
  incomingCommitsTruncated: boolean;
  /** Set when `availability === 'cant-auto-update'`. */
  cantUpdateReason: string | null;
  /** Local files the incoming update also changes (capped); local changes elsewhere never appear. Older daemons omit both fields. */
  blockingFiles?: BlockingFile[];
  blockingFilesTotal?: number;
  /** Set when the MOST RECENT check attempt failed. */
  checkError: string | null;
  /** The last attempted check (success or fail); null only before the very first check ever. */
  checkedAt: string | null;
  /** Null means "never had a successful check" — distinguishes "nothing to show" from "showing a stale-but-real result" when `checkError` is set. */
  lastSuccessfulCheckAt: string | null;
  phase: AppUpdatePhase;
  blocking: AppUpdateBlockingCounts;
  /** Set once `phase` reaches `'updated'`. */
  updatedToCommit: string | null;
  failureMessage: string | null;
  failureLogPath: string | null;
}

export interface ServerProject {
  id: string;
  name: string;
  repositoryUrl?: string;
  slug: string;
  relativePath: string;
  status: ProjectStatus;
  position: [number, number] | null;
  activeTaskId: string | null;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Attached by GET /api/projects[/:id] from the daemon's in-memory poller
   * cache — null until the poller's first tick, or for a Project with no
   * repository. A 'project' WorkerEvent (unlike the REST responses) never
   * carries this field — see worldStore.ts's mergeWorkerEvent, which
   * preserves the previously known reading rather than treating its absence
   * as "cleared".
   */
  sync?: ProjectSyncState | null;
  /**
   * The Catalog Workflow (see WorkflowRecord) this Project's Tasks run through — null/absent means
   * "use the Catalog's default Workflow". Set via `serverApi.setProjectWorkflow`. See
   * server/src/domain/types.ts's ProjectRecord.workflowId.
   */
  workflowId?: string | null;
  /** Whether the checked-out branch is pulled automatically when safe; absent reads as on — see server/src/domain/types.ts's ProjectRecord.autoPullEnabled. */
  autoPullEnabled?: boolean;
  /** Where the repository is hosted — see server/src/domain/types.ts's ProjectRecord.gitProvider. */
  gitProvider?: GitProviderId;
  githubAccount?: string | null;
  /** See server/src/domain/types.ts's ProjectRecord.prCheckout. */
  prCheckout?: PullRequestCheckout | null;
  /** Building Type fields the daemon derives on every read (server/src/buildings/normalize.ts). */
  typeId?: string;
  typeVersion?: number;
  typeUnavailable?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string | null;
}

/** Token usage + cost — see server/src/domain/types.ts's TokenUsage. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}

/** Rolled-up usage across every Task an executor has ever run — see server/src/executors/executorUsage.ts. */
export interface ExecutorUsageSummary {
  totalTokens: number;
  taskCount: number;
}

export interface ExecutorLimits {
  observedAt: number;
  fiveHour: { usedPercentage: number; resetsAt: number | null } | null;
  sevenDay: { usedPercentage: number; resetsAt: number | null } | null;
}

export interface ExecutorProfile {
  limits?: ExecutorLimits | null;
  id: string;
  label: string;
  /** Interactive CLI adapter used to run and resume tasks — see server/src/domain/types.ts's ExecutorProfile. */
  kind: 'claude-cli' | 'codex-cli';
  /** The command/alias run to launch this agent in the background — see server/executors.example.json. */
  bin: string;
  /** Extra environment variables set on that command, e.g. to pick a specific logged-in account. */
  env: Record<string, string>;
  /** This executor's total token usage across every Task it has ever run — see GET /api/executors. */
  usage: ExecutorUsageSummary;
  /** True for the one app-wide default coding agent; absent from an older daemon, which reads as no default. */
  isDefault?: boolean;
}

/** Agent analytics (docs/agent-analytics.md) — mirrors server/src/analytics. All times are epoch milliseconds. */
export type QuotaWindowKey = 'fiveHour' | 'sevenDay';
export interface AnalyticsAgent {
  /** The profile's id, or `retired-<link id>` for a removed profile's retained history. */
  id: string;
  label: string;
  kind: ExecutorProfile['kind'];
  retired: boolean;
  retiredAt: number | null;
  /** Other configured profiles on the same provider account: one shared capacity, not several. */
  sharedWith: string[];
}
export interface AnalyticsHistoryStatus { loadError: string | null; saveError: string | null }
export type CapacityState = 'measured' | 'stale' | 'failed' | 'expired' | 'unavailable' | 'awaiting';
/** One window right now. Only `measured`, `stale` and `failed` carry a percentage. */
export interface CurrentCapacity { state: CapacityState; remaining: number | null; used: number | null; observedAt: number | null; resetsAt: number | null }
export interface SeriesPoint { at: number; remaining: number; used: number; resetsAt: number | null; segment: number }
export type GapReason = 'no-readings' | 'check-failed' | 'window-unavailable';
export interface SeriesGap { from: number; to: number; reason: GapReason }
export interface SeriesReset { at: number; before: number; after: number }
export interface WindowSeries { points: SeriesPoint[]; gaps: SeriesGap[]; resets: SeriesReset[] }
export type DecreaseUnavailableReason = 'missing-boundary-reading' | 'reset' | 'gap' | 'in-progress';
/** An observed fall in remaining capacity (percentage points), or why none can be stated; `sharedWith` counts other sessions working at the same time. */
export type DecreaseView = ({ available: true; points: number; from: number; to: number } | { available: false; reason: DecreaseUnavailableReason }) & { sharedWith: number };
export type ActivityKind = 'planning' | 'coding' | 'background';
export interface ActivitySegment { state: 'active' | 'waiting'; start: number; end: number | null }
export type ActivityTarget =
  | { kind: 'run'; projectId: string; runId: string; stepId: string; round: number | null }
  | { kind: 'task'; projectId: string; taskId: string }
  | { kind: 'item'; projectId: string; planItemId: string };
export interface ActivityView {
  id: string;
  kind: ActivityKind;
  agentLabel: string;
  projectName: string | null;
  label: string;
  deleted: boolean;
  workflow: { name: string; stepName: string; round: number | null } | null;
  startedAt: number;
  endedAt: number | null;
  approximate: boolean;
  segments: ActivitySegment[];
  activeMs: number;
  decrease: Record<QuotaWindowKey, DecreaseView>;
  target: ActivityTarget | null;
}
export type UsageFailureReason = 'no-access' | 'provider-error';
export interface AnalyticsCheckStatus {
  lastSuccessAt: number | null;
  lastFailure: { at: number; reason: UsageFailureReason } | null;
  nextEligibleAt: number | null;
}
export interface AgentDayView {
  agent: AnalyticsAgent;
  now: number;
  range: { from: number; to: number };
  earliestAt: number;
  current: Record<QuotaWindowKey, CurrentCapacity>;
  check: AnalyticsCheckStatus;
  series: Record<QuotaWindowKey, WindowSeries>;
  activities: ActivityView[];
  unattributed: { window: QuotaWindowKey; from: number; to: number; points: number }[];
  history: AnalyticsHistoryStatus;
}
export interface AnalyticsRefreshResult {
  result: 'refreshed' | 'not-eligible' | 'failed';
  failureReason: UsageFailureReason | null;
  nextEligibleAt: number | null;
  check: AnalyticsCheckStatus;
  history: AnalyticsHistoryStatus;
}
export type ComparisonMetric = 'activeDuration' | 'tokens' | 'fiveHourDecrease' | 'sevenDayDecrease';
export interface MetricComparison { value: number | null; median: number | null; samples: number; enoughHistory: boolean; highUsage: boolean }
export interface TokenCounts { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }
export type RoundStatus = 'running' | 'completed' | 'failed' | 'stopped';
export interface StepRoundRow {
  id: string;
  projectName: string | null;
  label: string;
  deleted: boolean;
  workflowName: string;
  stepName: string;
  round: number | null;
  status: RoundStatus;
  startedAt: number;
  finishedAt: number | null;
  duration: { ms: number | null; live: boolean; approximate: boolean };
  tokens: { counts: TokenCounts; total: number; partial: boolean } | null;
  decrease: Record<QuotaWindowKey, DecreaseView>;
  comparison: Record<ComparisonMetric, MetricComparison>;
  highUsage: ComparisonMetric[];
  target: ActivityTarget | null;
}
export interface AgentStepsView { agent: AnalyticsAgent; now: number; rows: StepRoundRow[] }
export interface AnalyticsAgentList { agents: AnalyticsAgent[]; collectionStartedAt: number | null; history: AnalyticsHistoryStatus }

/** The settings panel's add/edit form fields — everything about an executor except its server-assigned id, usage, and limits. */
export interface ExecutorInput {
  label: string;
  kind: 'claude-cli' | 'codex-cli';
  bin: string;
  env?: Record<string, string>;
}

/** What POST/PATCH /api/executors return: the bare configured row, with no usage/limits (those are rolled up only by GET /api/executors). */
export type ExecutorConfig = Pick<ExecutorProfile, 'id' | 'label' | 'kind' | 'bin' | 'env'>;

/** 'plan' is the workspace chat's default (docs restricted, no shell); 'execute' is real coding work. See server/src/domain/types.ts's TaskKind. */
export type TaskKind = 'plan' | 'execute';

/** 'auto' bypasses permission prompts; 'approval' runs gated, asking before tool use. See server/src/domain/types.ts's Autonomy. */
export type Autonomy = 'auto' | 'approval';

export interface ServerTask {
  conversationId?: string;
  archived?: boolean;
  branch?: string;
  /** Set only for a Task running in its own isolated git worktree — absent for one working directly in the Project's own folder. Mirrors `WorkflowRunRecord.worktreePath` and is what the branch menu's folder-busy rule reads. See server/src/domain/types.ts's TaskRecord. */
  worktreePath?: string;
  id: string;
  projectId: string;
  templateId: string;
  executorId: string;
  executionMode?: 'structured' | 'terminal';
  description: string;
  status: TaskStatus;
  autonomy: Autonomy;
  kind: TaskKind;
  /** Set when this Task ran one Tasks-breakdown PlanItem, null for a freeform/chat Task. */
  planItemId: string | null;
  /** A planning session's number within its Project — see server/src/domain/types.ts's TaskRecord. */
  planningSessionNumber?: number;
  planningQueueOrder?: number;
  planningCompletedAt?: string | null;
  planningCreatedTaskCount?: number;
  planningAutoCompleteArmed?: boolean;
  /** Set on a plan-and-bugs or bug report session — see server/src/domain/types.ts's TaskRecord. */
  planningPurpose?: 'bug-report' | 'plan-and-bugs';
  /** A bug-filing session with no CLI yet — see server/src/domain/types.ts's TaskRecord. */
  cliNotStarted?: boolean;
  /** A planning session's generated title — see server/src/projects/planItemTitler.ts's `requestSessionTitle`. */
  title?: string;
  sessionId: string | null;
  runtimeStatus?: TerminalRuntimeStatus;
  runtimeWaitingReason?: string | null;
  runtimeStatusChangedAt?: string | null;
  blockedQuestion: string | null;
  failureReason: string | null;
  /** Running token-usage total for this Task's session — see server/src/domain/types.ts's TokenUsage. */
  tokenUsage: TokenUsage;
  /** Set when this Task runs one step of a WorkflowRun — null/absent for a freeform Task, a planning Task, or one that predates workflows. Paired with `workflowStepId`. See server/src/domain/types.ts's TaskRecord. */
  workflowRunId?: string | null;
  /** The WorkflowStep (by its snapshot id) this Task is running — see `workflowRunId`. */
  workflowStepId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TerminalRuntimeState {
  taskId: string;
  sessionId: string | null;
  status: TerminalRuntimeStatus | null;
  waitingReason: string | null;
  changedAt: string;
}

/** One of the fixed Project Popover tabs — see server/src/projects/plan.ts. */
export type PlanDocKey = 'specifications' | 'requirements' | 'testCases' | 'e2eTesting' | 'performanceTesting';

export interface PlanDoc {
  key: PlanDocKey;
  title: string;
  content: string;
}

export type PlanItemStatus = 'pending' | 'developing' | 'blocked' | 'done' | 'failed' | 'stopped';

/** One top-level Planning entry in a reorder request — see server/src/worker/workerManager.ts's PlanningQueueEntryRef. */
export interface PlanningQueueOrderEntry {
  kind: 'session' | 'task' | 'reference';
  id: string;
}

/** One task card — see server/src/domain/types.ts's PlanItemRecord. */
export interface PlanItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: PlanItemStatus;
  /** 'task' or 'bug'; absent on an item stored before types existed, which reads as a task. */
  type?: 'task' | 'bug';
  /** A bug's attributes as the daemon stores them; read defensively by `lib/bugs.ts`'s `readBugAttributes`. */
  bug?: unknown;
  /** A task filed by a bug report session only; see server/src/domain/types.ts's PlanItemRecord. */
  relatedBug?: unknown;
  reportSessionNumber?: number;
  order: number;
  planningQueueOrder?: number;
  /** Position within its planning group's ready tasks; absent sorts after positioned tasks, by task number. */
  planningGroupOrder?: number;
  taskIds: string[];
  /** The Milestone this item belongs to or null. No UI reads this yet. */
  milestoneId: string | null;
  /** The worker (Executor) that ran this item, recorded once it first starts; absent/null before then. See server/src/domain/types.ts's PlanItemRecord. */
  executorId?: string | null;
  /** The planning Task whose session created this item, when one did — absent/null for an item typed by hand. See server/src/domain/types.ts's PlanItemRecord. */
  planningTaskId?: string | null;
  planningRef?: { session: number; task: number };
  /** The most recent WorkflowRun executing this item, if any has ever started — see WorkflowRunRecord. */
  workflowRunId?: string | null;
  /** Set only on a testing-setup item the Testing tab started — see server/src/testing/setup.ts. */
  testingSetup?: { mode: TestingSetupMode };
  /** Set only on the item the PR tab's Merge created for a conflicting pull request — see server/src/worker/conflictResolution.ts. */
  prConflict?: PullRequestConflictTarget;
  /** The task's Auto-merge toggle and state; absent until it was ever switched on. See server/src/projects/autoMergeService.ts. */
  autoMerge?: AutoMergeData;
  /** The task's own pull request as last read; absent until a reading succeeded. See server/src/projects/pullRequestStateService.ts. */
  pullRequest?: TaskPullRequestData;
  /** Ids of the tasks this one waits for. See server/src/projects/dependencyService.ts. */
  dependsOn?: string[];
  /** Present while the task waits for its parents. */
  waiting?: WaitingData;
  /** Hidden from every Tasks-board column (Completed included). Absent means not archived. */
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Which Testing-tab entry point started a testing setup: config absent, valid or invalid at the time. */
export type TestingSetupMode = 'setup' | 'reconfigure' | 'repair';

/** What the setup evidence check found — mirrors server/src/domain/types.ts's TestingSetupEvidence. */
export interface TestingSetupEvidence {
  ok: boolean;
  checkedAt: string;
  config: { state: 'absent' | 'valid' | 'invalid'; suiteCount: number; issues: { path: string; message: string }[] };
  actions: {
    suiteId: string;
    actionId: string;
    runId: string | null;
    status: TestRunStatus | null;
    counts: NormalizedTestResult['counts'] | null;
    problem: string | null;
  }[];
  problems: string[];
}

/** A start accepted while its Project was at its task limit; it starts by itself when a slot frees. */
export interface PlanItemQueueEntry {
  id: string;
  projectId: string;
  planItemId: string;
  executorId?: string;
  workflowId?: string;
  createBranch?: boolean;
  skippedStepIds?: string[];
  position?: number;
  createdAt: string;
}

/** GET /api/projects/:id/testing/setup — the Project's active setup (or its latest completed one). */
export interface TestingSetupState {
  planItem: PlanItem;
  run: WorkflowRunRecord | null;
  queueEntry: PlanItemQueueEntry | null;
  active: boolean;
}

/** POST /api/projects/:id/testing/setup — `existing` when an active setup was returned instead of a new one. */
export interface TestingSetupStartResult {
  existing: boolean;
  planItem: PlanItem;
  run: WorkflowRunRecord | null;
  queueEntry: PlanItemQueueEntry | null;
}

/** A new Tasks-breakdown item. Leave `title` out to have the daemon name it from `description` in the background. */
export interface PlanItemDraft {
  title?: string;
  description: string;
}

/**
 * What `PATCH /api/plan-items/:id` accepts. `status` may only be 'done' (mark complete: commits and
 * completes its run without running the remaining steps); `archived` is refused (409) while the item
 * is developing — see server/src/api/router.ts. The coding agent is chosen only when a task starts
 * (`POST /api/plan-items/:id/execute`'s `executorId`), never patched in beforehand.
 */
export interface PlanItemPatch {
  title?: string;
  description?: string;
  order?: number;
  status?: 'done';
  archived?: boolean;
}

export interface ProjectPlan {
  docs: PlanDoc[];
  items: PlanItem[];
}

/** One parent of a dependent task, as `GET .../dependencies` reports it. */
export interface ParentStatus {
  id: string;
  label: string;
  title: string;
  satisfied: boolean;
  reason: DependencyReasonData | null;
}

/** Start on a dependent task: a run now, or the task waiting (staying in Planning). */
export type StartWhenReadyResult =
  | { started: true; run: WorkflowRunRecord }
  | { started: false; item: PlanItem; entry?: PlanItemQueueEntry };

/** Start on an ordinary task: a run now (201), or a place on the Project's waiting list (202). */
export type ExecutePlanItemResult = { started: true; run: WorkflowRunRecord } | { started: false; entry: PlanItemQueueEntry };

/** How `POST /api/plan-items/:id/execute` runs an item — each field left out takes the daemon's default. */
export interface ExecutePlanItemOptions {
  executorId?: string;
  /** An enabled Catalog Workflow; default: the Project's own, else the Catalog default. */
  workflowId?: string;
  /** true: a worktree on a new branch (needs a linked repository); false: the Project's own folder and checked-out branch. */
  createBranch?: boolean;
  /** Steps of that workflow to leave out of this run — the Start task dialog's unchecked steps. Omitted when every step runs. */
  skippedStepIds?: string[];
  /** The Start task dialog's Auto-merge switch. Saved only when the start is accepted; left out, the task's setting is unchanged. */
  autoMerge?: boolean;
}

/** A file browser's listing — POSIX-relative paths, empty folders included: the Documents tab's `.docs/` folder (server/src/projects/docsFiles.ts) or the Code tab's whole project (server/src/projects/fileTree.ts). */
export interface FileListing {
  files: string[];
  folders: string[];
}

export type EntryKind = 'file' | 'folder';

/** One file read from `.docs/` — see server/src/projects/fileTree.ts's FileReadResult. */
export type DocsFileContent = { kind: 'text'; content: string } | { kind: 'binary' } | { kind: 'too-large'; size: number };

/**
 * The Project testing contract, v1 — see server/src/testing/types.ts (the source of truth) and
 * docs/testing-contract.md. The UI consumes only this normalized, framework-neutral model; it never
 * parses a framework's own output.
 */
export type TestSuiteKind = 'unit' | 'integration' | 'e2e' | 'performance' | 'security' | 'accessibility' | 'contract' | 'custom';
/** `result` actions may replace their suite/action's latest result; `utility` actions (e.g. "Update snapshots") only keep a log. */
export type TestActionPurpose = 'result' | 'utility';
export type CollectorFormat = 'junit-xml' | 'lcov' | 'cobertura-xml' | 'sarif' | 'avos-result';
export type MetricDirection = 'lower-is-better' | 'higher-is-better' | 'neutral';

export interface CollectorConfig {
  id: string;
  format: CollectorFormat;
  /** Relative to the Test Run's artifact directory. */
  path: string;
}

export interface TestActionConfig {
  id: string;
  label: string;
  purpose: TestActionPurpose;
  command: string;
  /** Relative to the Project root; `.` for the root itself. */
  workingDirectory: string;
  enabled: boolean;
  collectors: CollectorConfig[];
}

export interface MetricDisplayConfig {
  key: string;
  label: string;
  unit?: string;
  direction: MetricDirection;
}

export interface TestSuiteConfig {
  id: string;
  label: string;
  kind: TestSuiteKind;
  description?: string;
  enabled: boolean;
  /** The result action "Run all" executes for this suite. */
  primaryActionId: string;
  actions: TestActionConfig[];
  metrics: MetricDisplayConfig[];
}

export interface TestingConfig {
  schemaVersion: 1;
  suites: TestSuiteConfig[];
}

export type ContractIssueCode =
  | 'unreadable'
  | 'malformed-json'
  | 'unsupported-schema-version'
  | 'unsupported-format'
  | 'invalid-value'
  | 'invalid-id'
  | 'duplicate-id'
  | 'unsafe-path'
  | 'missing-primary-action';

/** `path` locates the problem inside config.json, e.g. `suites[0].actions[1].id` (empty for the whole document). */
export interface ContractIssue {
  code: ContractIssueCode;
  path: string;
  message: string;
}

/** GET /api/projects/:id/testing/config — `absent` is a normal state; `invalid` drives "Repair testing". */
export type TestingConfigState =
  | { state: 'absent'; path: string }
  | { state: 'valid'; path: string; config: TestingConfig }
  | { state: 'invalid'; path: string; issues: ContractIssue[] };

export type TestOutcome = 'passed' | 'failed' | 'error' | 'skipped';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** A normalized Collector result — see server/src/domain/types.ts's NormalizedTestResult. */
export interface NormalizedTestResult {
  outcome: TestOutcome;
  durationMs?: number;
  counts?: { total?: number; passed?: number; failed?: number; errored?: number; skipped?: number };
  metrics: { key: string; label?: string; value: number; unit?: string; threshold?: { operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; value: number }; status?: 'pass' | 'warn' | 'fail' }[];
  findings: { id?: string; ruleId?: string; severity: FindingSeverity; title: string; description?: string; location?: { path?: string; line?: number } }[];
  cases: { id?: string; name: string; group?: string; outcome: TestOutcome; durationMs?: number; message?: string }[];
}

export type TestRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'stopped';

/** The small result summary kept on every run record — see server/src/domain/types.ts's TestResultSummary. */
export interface TestResultSummary {
  outcome: TestOutcome;
  durationMs?: number;
  counts?: NormalizedTestResult['counts'];
  metrics: NormalizedTestResult['metrics'];
  findingCounts: Record<FindingSeverity, number>;
}

/**
 * One Test Run as lists, the overview and WS events carry it — mirrors server/src/domain/types.ts's
 * TestRunRecord (the source of truth). The log and full result come only with TestRunDetail.
 */
export interface TestRun {
  id: string;
  projectId: string;
  batchId: string | null;
  suite: { id: string; label: string; kind: TestSuiteKind };
  action: Pick<TestActionConfig, 'id' | 'label' | 'purpose' | 'command' | 'workingDirectory' | 'collectors'>;
  trigger: 'manual' | 'agent';
  taskId: string | null;
  executionRoot: string;
  cwd: string | null;
  branch: string | null;
  commit: string | null;
  status: TestRunStatus;
  exitCode: number | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  outputTruncated: boolean;
  summary: TestResultSummary | null;
  diagnostics: { code: string; message: string; collectorId?: string }[];
  artifactDir: string | null;
  /** Set on a failed or errored run until anyone opens it — see `CommandRun.failureUnopened`. */
  failureUnopened?: true;
}

/** GET /api/test-runs/:runId — the record plus its log and full result, read from the run's own files. */
export type TestRunDetail = TestRun & { output: string; result: NormalizedTestResult | null };

/** One action in GET /api/projects/:id/testing — see server/src/testing/testRunner.ts's TestActionOverview. */
export interface TestActionOverview {
  id: string;
  label: string;
  purpose: TestActionPurpose;
  enabled: boolean;
  latestResult: TestRun | null;
  latestRun: TestRun | null;
  activeRun: TestRun | null;
}

export interface TestSuiteOverview {
  id: string;
  label: string;
  kind: TestSuiteKind;
  enabled: boolean;
  primaryActionId: string;
  /** Latest passed/failed/error run of any result action in this suite, on the Project's own working tree. */
  latestResult: TestRun | null;
  actions: TestActionOverview[];
}

/** GET /api/projects/:id/testing — the config state, every suite's latest results, and the run queue. */
export interface TestingOverview {
  config: TestingConfigState;
  suites: TestSuiteOverview[];
  /** Running run first, then the queue in execution order. */
  queue: TestRun[];
}

export interface TestRunPage {
  runs: TestRun[];
  total: number;
  limit: number;
  offset: number;
}

/** One file read result from the Code tab's read-only file endpoint — see server/src/projects/fileTree.ts's FileReadResult. */
export type CodeFileContent =
  | { path: string; kind: 'text'; content: string }
  | { path: string; kind: 'binary' }
  | { path: string; kind: 'too-large'; size: number };

/** One entry in a Task's transcript — see server/src/domain/types.ts's TaskTurn. */
export interface TaskTurn {
  role: 'prompt' | 'answer' | 'raw-event' | 'result';
  content: string;
  at: string;
}

export interface TaskContext {
  id: string;
  taskId: string;
  turns: TaskTurn[];
}

/**
 * A user-defined shell command, run from a Project's own root directory —
 * not a Task (no LLM, no session). See server/src/domain/types.ts's
 * ProjectCommandRecord. `highlighted` commands (at most 3 per project) show
 * as header buttons on the workspace; the rest reach through a "⋯" menu.
 */
export interface ProjectCommand {
  id: string;
  projectId: string;
  name: string;
  command: string;
  highlighted: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The Commands settings form's fields — see ExecutorInput's equivalent role. `highlighted` is optional: omitting it (or passing false) creates a plain, un-highlighted command, matching the server's own default. */
export interface CommandInput {
  name: string;
  command: string;
  highlighted?: boolean;
}

export type CommandRunStatus = 'running' | 'success' | 'failed' | 'stopped';

/** What produced a CommandRun — see server/src/domain/types.ts's CommandRunOrigin. Only `'adhoc'` runs offer "Save as command" in the log popup. */
export type CommandRunOrigin = 'saved' | 'sync' | 'adhoc';

/** Where a CommandRun ran — see server/src/domain/types.ts's CommandRunLocation. */
export type CommandRunLocation =
  | { kind: 'main' }
  | { kind: 'task'; workflowRunId: string; planItemId: string; branch: string | null; taskRef: string | null };

/** One execution of a ProjectCommand — the log popup's and History tab's source data. See server/src/domain/types.ts's CommandRunRecord. */
export interface CommandRun {
  id: string;
  projectId: string;
  commandId: string;
  commandName: string;
  commandText: string;
  origin: CommandRunOrigin;
  /** Absent on runs from before locations were recorded; those ran in the main checkout. */
  location?: CommandRunLocation;
  status: CommandRunStatus;
  exitCode: number | null;
  output: string;
  startedAt: string;
  completedAt: string | null;
  /** True for a branch sync the daemon ran by itself. */
  automatic?: true;
  /** Set on a failed (non-sync) run until anyone opens its log: the 3D village keeps a red machine for it. */
  failureUnopened?: true;
}

export type NotificationSeverity = 'info' | 'warning' | 'critical';

/**
 * What raised a Notification — see server/src/domain/types.ts's NotificationKind. Severity is
 * fixed per kind on the server; this client never computes or sends one.
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

/** What a Notification is about, and where clicking it goes — see server/src/domain/types.ts's NotificationSubject. */
export type NotificationSubject =
  | { type: 'task'; projectId: string; conversationId: string; taskId: string }
  | { type: 'command'; projectId: string; commandId: string; runId: string }
  | { type: 'project'; projectId: string }
  | { type: 'testRun'; projectId: string; runId: string }
  | { type: 'skill'; repo: string }
  /** The app-update notification's subject (task 7.001) — there's only ever one, so there's nothing per-instance to carry. */
  | { type: 'app' }
  /** A scheduled job's failed run, or the job turning itself off — clicking opens that Building's Schedules tab. */
  | { type: 'scheduledJob'; projectId: string; jobId: string }
  /** A task's Auto-merge needing attention — clicking opens that project's Tasks board. */
  | { type: 'autoMerge'; projectId: string; planItemId: string };

/** See server/src/domain/types.ts's NotificationRecord — the building dot's severity, toasts, and the Notifications drawer's shared source data. */
export interface ServerNotification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  subject: NotificationSubject;
  /** Null for a project-less subject — a Catalog skill install, or the app-update notification. */
  projectId: string | null;
  title: string;
  description: string;
  /** Owned by the user: null until they've seen it. */
  readAt: string | null;
  /** Owned by the system: null while the condition that raised this is still true. */
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The daemon's live WorkerEvent feed — see server/src/worker/workerManager.ts's WorkerEvent, server/src/commands/commandRunner.ts's CommandEvent, server/src/projects/gitSyncPoller.ts's GitSyncEvent, server/src/catalog/skillInstall.ts's SkillInstallEvent, server/src/testing/testRunner.ts's TestRunEvent, and server/src/notifications/notificationService.ts's NotificationEvent, all broadcast over the same /ws connection (see server/src/api/ws.ts). */
export type DefaultChangeReason = 'manual' | 'exhausted' | 'removed' | 'initial';

export type SeoJobKind = 'crawl' | 'sitemaps' | 'inspection' | 'keywords-research' | 'keywords-cluster';

/** A long-running SEO job — see server/src/seo/jobs.ts. `progress` is the crawl's page counts. */
export interface SeoJobDto {
  id: string;
  buildingId: string;
  kind: SeoJobKind;
  status: 'running' | 'complete' | 'stopped' | 'failed';
  startedAt: string;
  progress?: { fetched: number; queued: number; failed: number };
  error?: string;
}

/** A Content Studio background job — see server/src/content/jobs.ts: the Remotion project's install, a video, image or thumbnail render, Remotion Studio, or an Insights refresh. */
export interface ContentJobDto {
  id: string;
  buildingId: string;
  kind: 'remotion-setup' | 'render' | 'images' | 'thumbnail' | 'remotion-studio' | 'insights';
  status: 'running' | 'complete' | 'stopped' | 'failed';
  startedAt: string;
  conceptId?: string;
  renderId?: string;
  /** Image and thumbnail renders: their asset, for its Stop route. */
  assetId?: string;
  percent?: number | null;
  /** Image and thumbnail renders: stills finished and asked for. */
  done?: number;
  total?: number;
  /** Remotion Studio only. */
  phase?: 'starting' | 'running';
  error?: string;
}

export type LiveTerminalSessionKind = 'planning' | 'bug-report' | 'task' | 'agent' | 'content-studio';

/** One live terminal session (PTY); the daemon lists exactly the ones that hold back an app update. */
export interface LiveTerminalSession {
  id: string;
  kind: LiveTerminalSessionKind;
  projectId: string | null;
  title: string;
}

export type WorkerEvent =
  | { type: 'terminalSessions'; sessions: LiveTerminalSession[] }
  | { type: 'seoJob'; job: SeoJobDto }
  | { type: 'contentJob'; job: ContentJobDto }
  | { type: 'project'; project: ServerProject }
  /** The Project was deleted: every view drops it. */
  | { type: 'projectDeleted'; projectId: string }
  | { type: 'task'; task: ServerTask }
  | { type: 'taskDeleted'; id: string; projectId: string }
  | { type: 'log'; taskId: string; turn: TaskTurn }
  | { type: 'planItem'; planItem: PlanItem }
  | { type: 'planItemDeleted'; id: string; projectId: string }
  | { type: 'planItemQueue'; projectId: string; entries: PlanItemQueueEntry[] }
  | { type: 'planningCompletionError'; projectId: string; session: number; message: string }
  | { type: 'commandRun'; run: CommandRun }
  | { type: 'commandRunLog'; runId: string; chunk: string }
  | { type: 'projectSync'; sync: ProjectSyncState }
  | { type: 'notification'; notification: ServerNotification }
  | { type: 'skillInstall'; run: SkillInstallRun }
  | { type: 'skillInstallLog'; runId: string; chunk: string }
  /** A Test Run's status/log, or a queued one removed — see server/src/testing/testRunner.ts's TestRunEvent. */
  | { type: 'testRun'; run: TestRun }
  | { type: 'testRunLog'; runId: string; projectId: string; chunk: string }
  | { type: 'testRunRemoved'; runId: string; projectId: string }
  /** A WorkflowRun's status/step/approval state changed — see server/src/worker/workerManager.ts's WorkerEvent. */
  | { type: 'workflowRun'; run: WorkflowRunRecord }
  | { type: 'workflowRunDeleted'; runId: string; projectId: string }
  /** One StepRun (one attempt at one WorkflowStep) changed — see server/src/worker/workerManager.ts's WorkerEvent. */
  | { type: 'stepRun'; stepRun: StepRunRecord }
  /** The daemon's app-update reading changed — see AppUpdateStatus and server/src/app-update's update checker/idle watcher (task 7.001). */
  | { type: 'appUpdate'; status: AppUpdateStatus }
  | { type: 'executors.default_changed'; defaultExecutorId: string; previousExecutorId: string | null; reason: DefaultChangeReason }
  /** A Building's jobs, or one job's history, changed — see server/src/scheduler/scheduler.ts's ScheduleEvent. */
  | ScheduleEvent
  /** An Agent terminal session started, was renamed or changed state, or was deleted — see server/src/terminal/agentSessions.ts. */
  | AgentSessionEvent
  /** A Content Studio agent pane changed (session, draft, finalize, reopen) — see server/src/content/studioSessions.ts. */
  | StudioEvent
  | RemotionStudioEvent;

// ---- Catalog: agents (Templates) and skills, backed by the daemon's repo-root catalog/ folder — see server/src/catalog/catalogService.ts ----

/**
 * Mirrors server/src/domain/types.ts's TemplateRecord. No `description` field: it lives only in the
 * agent markdown file's own frontmatter (readAgentPersona reads it from disk), never returned by
 * list/get — only accepted as input by create/update/upload below.
 */
export interface CatalogAgent {
  id: string;
  name: string;
  avatar: string;
  manager: boolean;
  defaultAutonomy: Autonomy;
  /** Path to the agent markdown file, relative to catalog/ (e.g. "agents/builder.md"). */
  agentFile: string;
  /** Disabled Templates stay in the Catalog but shouldn't be offered when starting a new Task. */
  enabled: boolean;
}

export interface CreateCatalogAgentInput {
  id: string;
  name: string;
  description: string;
  body?: string;
  avatar?: string;
  manager?: boolean;
  defaultAutonomy?: Autonomy;
  enabled?: boolean;
}

export interface UpdateCatalogAgentInput {
  name?: string;
  description?: string;
  body?: string;
  avatar?: string;
  manager?: boolean;
  defaultAutonomy?: Autonomy;
}

/** POST /catalog/agents/upload's fields — `file` (the raw `.md` file) is base64-encoded client-side before it travels in the JSON body, matching this router's upload convention (no multipart middleware — see server/src/api/router.ts's decodeBase64 doc comment). */
export interface UploadCatalogAgentInput {
  id: string;
  file: Blob;
  name?: string;
  avatar?: string;
  manager?: boolean;
  defaultAutonomy?: Autonomy;
  enabled?: boolean;
}

/** Mirrors server/src/domain/types.ts's SkillRecord. */
export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  triggers?: string[];
  avatar?: string;
  enabled: boolean;
  /** This skill's folder, relative to catalog/ (e.g. "skills/roadmap-runner"). */
  skillDir: string;
  /** Filenames alongside SKILL.md in skillDir, sorted. */
  supportFiles: string[];
}

export interface CreateCatalogSkillInput {
  id: string;
  name: string;
  description: string;
  body?: string;
  avatar?: string;
  triggers?: string[];
  enabled?: boolean;
}

export interface UpdateCatalogSkillInput {
  name?: string;
  description?: string;
  body?: string;
  avatar?: string;
  triggers?: string[];
}

/** POST /catalog/skills/upload's fields — `file` (a zip with SKILL.md at its root) is base64-encoded the same way UploadCatalogAgentInput's file is. */
export interface UploadCatalogSkillInput {
  id: string;
  file: Blob;
  name?: string;
  avatar?: string;
  triggers?: string[];
  enabled?: boolean;
}

export type SkillInstallStatus = 'running' | 'success' | 'failed';

/** One `npx skills add <owner/repo>` run — mirrors server/src/catalog/skillInstall.ts's SkillInstallRun. Kept in the daemon's memory only, for its process lifetime. */
export interface SkillInstallRun {
  id: string;
  repo: string;
  status: SkillInstallStatus;
  output: string;
  startedAt: string;
  completedAt: string | null;
}

// ---- Catalog: Workflows (task 3.012) — an ordered list of Steps a Project's Tasks run through ----

/**
 * The agent/skills/executor/instructions one WorkflowStep runs with — mirrors server/src/domain/types.ts's WorkflowAgentConfig.
 * `agent` is attached server-side (GET/POST/PUT resolve `agentId` against the Catalog — see
 * `withResolvedAgents` in server/src/api/router.ts); `avatar` is undefined when the agentId doesn't
 * resolve to a known Catalog agent.
 */
export interface WorkflowAgentConfig {
  /** A CatalogAgent id — validated to exist in the Catalog at Workflow save time. */
  agentId: string;
  /** CatalogSkill ids attached to the session: listed for the agent to read on demand, or loaded in full when also in `preloadSkillIds`. */
  skillIds?: string[];
  /** The subset of `skillIds` pasted in full every run ("Always load"); omitted when empty, meaning all on demand. */
  preloadSkillIds?: string[];
  /** An ExecutorProfile id overriding the run's own executor for just this stage/step; null/undefined defers to the run's executor. */
  executorId?: string | null;
  /** Appended to the stage/step's prompt. */
  instructions: string;
  agent?: { id: string; name: string; avatar?: string };
}

/** One step of a Workflow's `steps` list. "Complete" (commit, push, raise PR) is built-in and never a WorkflowStep of its own. See server/src/domain/types.ts's WorkflowStep. */
export interface WorkflowStep extends WorkflowAgentConfig {
  /** Unique (within its Workflow) kebab-case slug. */
  id: string;
  name: string;
  /** Whether this step may change code. */
  canEditCode: boolean;
  /** Whether a read-only step may run shell commands and use the testing tools; absent reads as off. */
  canRunCommands?: boolean;
  /** Whether this step pauses the run for a human decision instead of advancing straight to the next step. */
  requiresApproval: boolean;
  /** Makes this step a review-type loop origin — see server/src/domain/types.ts's WorkflowStep.loopBack. Null/absent for a step that isn't a loop origin. */
  loopBack?: { toStepId: string; maxRounds: number } | null;
  /** Only on an approval step: the earlier step Request changes sends the run back to — see server/src/domain/types.ts's WorkflowStep.requestChangesToStepId. Null/absent re-runs the approval step itself. */
  requestChangesToStepId?: string | null;
  /** What the step's detail in the run view offers as a Quick look; absent or null means none. See server/src/domain/types.ts's QuickLookKind. */
  quickLook?: QuickLookKind | null;
}

export type QuickLookKind = 'none' | 'code' | 'diff' | 'documents' | 'commands';

/** Where a WorkflowRun's work is right now — see server/src/projects/quickLook.ts's RunLocation. */
export interface RunLocation {
  kind: 'worktree' | 'project-folder' | 'removed';
  branch: string | null;
  baseBranch: string | null;
}

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One file in a Quick look diff — see server/src/projects/branchDiff.ts's ChangedFile. */
export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  untracked?: boolean;
}

/** `source` says what was compared — see server/src/projects/quickLook.ts's DiffSource. */
export interface QuickLookDiff {
  source: 'worktree' | 'branch' | 'project-folder';
  base: string | null;
  branch: string | null;
  files: ChangedFile[];
}

export type QuickLookFileDiff =
  | { path: string; kind: 'text'; diff: string }
  | { path: string; kind: 'binary' }
  | { path: string; kind: 'too-large' };

/** Mirrors server/src/domain/types.ts's WorkflowRecord. */
export interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  /** A disabled Workflow stays in the Catalog but is never offered as a Project's default or selectable choice. */
  enabled: boolean;
  /** The fixed first segment of a branch a run of this Workflow creates (`bugfix` gives `bugfix/…`). Null/absent gives `feature`. See server/src/domain/types.ts's WorkflowRecord.branchType. */
  branchType?: string | null;
  /** Ordered; "Complete" is implicit and always runs last, after every step here. */
  steps: WorkflowStep[];
}

/** POST /api/catalog/workflows's body — see server/src/catalog/workflowService.ts's WorkflowInput. */
export interface WorkflowInput {
  id: string;
  name: string;
  description: string;
  enabled?: boolean;
  /** Null on an update clears it, so runs are named `feature/…` again. */
  branchType?: string | null;
  steps: WorkflowStep[];
}

/** PUT /api/catalog/workflows/:id's body — see server/src/catalog/workflowService.ts's UpdateWorkflowInput. */
export type UpdateWorkflowInput = Partial<Omit<WorkflowInput, 'id'>>;

/** One step of a run's start-up — mirrors server/src/domain/types.ts's RunStartupStep. */
export interface RunStartupStep {
  id: 'name' | 'worktree' | 'hooks' | 'launch';
  name: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  reason?: string;
}

/** A run's start-up before its first agent launches; absent on a run from before the phase existed. */
export interface RunStartup {
  steps: RunStartupStep[];
  reuseBranch: boolean;
}

export type WorkflowRunStatus = 'starting' | 'running' | 'awaiting-approval' | 'needs-attention' | 'completing' | 'completed' | 'failed' | 'stopped';

/**
 * One run of a Workflow against one PlanItem. Snapshots its WorkflowRecord at creation time
 * (`workflowSnapshot`) so a later Catalog edit never changes an in-flight run. Mirrors
 * server/src/domain/types.ts's WorkflowRunRecord.
 */
export interface WorkflowRunRecord {
  id: string;
  projectId: string;
  planItemId: string;
  workflowId: string;
  workflowSnapshot: WorkflowRecord;
  status: WorkflowRunStatus;
  /** Set while the run is 'starting', and kept if the start ended before the agent launched. */
  startup?: RunStartup;
  /** The WorkflowStep (snapshot id) currently running/awaiting a decision; null once past the last step or before the run has any repository-backed steps. */
  currentStepId: string | null;
  baseBranch?: string;
  branch?: string;
  worktreePath?: string;
  pendingInspectChanges?: { taskId: string; worktreePath: string; state: 'pending' | 'committing' | 'discarding'; hasChanges: boolean; error?: string } | null;
  executorId: string;
  prUrl: string | null;
  /** Set once the Complete stage finishes (success or not). */
  completionReport: string | null;
  /** Set while status is 'needs-attention': why a human needs to look. */
  attentionReason: string | null;
  /** Internal bookkeeping for a loop-origin step's round budget — see WorkflowStep.loopBack. */
  loopRoundAllowance: number;
  /** Set only on a run that re-ran a completed bug after a regression: per step, the rounds it had in earlier runs, so this run's rounds are numbered after them. */
  regression?: { roundOffsets: Record<string, number> };
  /** Set only on a testing-setup run — its mode and latest validation evidence. */
  testingSetup?: { mode: TestingSetupMode; evidence: TestingSetupEvidence | null };
  /** Set only on a conflict-resolution run: its pull request, and how it ended once it has (`outcome` null until then). */
  prConflict?: PullRequestConflictTarget & { outcome: 'merged' | 'resolved' | 'failed' | null; detail: string | null };
  /**
   * A live summary of the currently-running round's self-reported progress (task 5.017) — null/absent
   * until first reported, and cleared whenever a new step round starts. Drives the Running board
   * card's "N/M · ~estimate" line without needing this run's full step/round detail loaded.
   */
  currentStepProgress?: StepProgressSummary | null;
  /**
   * The current step's active round's own `createdAt` (task 5.003) — mirrored onto the run record
   * alongside `currentStepId`, so the Running board card's live timer doesn't need the run's full
   * round history loaded. Null before any step has started; absent on records predating this field.
   */
  currentStepRoundStartedAt?: string | null;
  /**
   * Every earlier round's own ms for the step now at `currentStepRoundStartedAt`, carried forward so
   * the live timer's total continues across rounds instead of restarting at zero. Zero on a step's
   * first-ever round; absent (read as 0) on records predating this field.
   */
  currentStepPriorRoundsMs?: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type StepRunStatus = 'running' | 'awaiting-approval' | 'changes-requested' | 'done' | 'skipped' | 'failed' | 'stopped';

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

export type StepProgressItemState = 'pending' | 'in-progress' | 'done' | 'skipped';

/** One checklist item in a step session's self-reported progress — see `StepRunProgress`. */
export interface StepProgressItem {
  text: string;
  state: StepProgressItemState;
  note: string | null;
}

/**
 * A running step session's self-reported progress (task 5.017's `report_progress`): a checklist, a
 * current-activity line, and the agent's own time estimate. Wholly replaced on every call — never a
 * merge of fields, and never kept as history, so there is one state to render, not several.
 * `estimatedAt` is stamped by the daemon the instant a non-null `estimate` is given, so the UI can
 * show how stale it is; both are null together whenever the agent gives no estimate.
 */
export interface StepRunProgress {
  checklist: StepProgressItem[];
  currentActivity: string | null;
  estimate: string | null;
  estimatedAt: string | null;
}

/** The board card's whole need from a run's current progress — see `WorkflowRunRecord.currentStepProgress`. `total` includes skipped items; `done` does not. */
export interface StepProgressSummary {
  done: number;
  total: number;
  estimate: string | null;
  /** The first in-progress checklist item's 1-2 word label ("writing code"); null or absent when there is none. */
  currentLabel?: string | null;
}

/**
 * One attempt at one WorkflowStep within a WorkflowRun. `round` starts at 1 and increments for a
 * request-changes resume, a loop re-run, or a manual retry — every StepRunRecord for a given
 * (runId, stepId) pair is kept, never overwritten. Mirrors server/src/domain/types.ts's StepRunRecord.
 */
export interface StepRunRecord {
  id: string;
  runId: string;
  stepId: string;
  round: number;
  /** The TaskRecord actually running this attempt — null only in the instant between the StepRunRecord being created and its Task starting. */
  taskId: string | null;
  status: StepRunStatus;
  summary: string | null;
  outputs: StepRunOutput[];
  /** Required by the daemon only when this step is a loop origin — null otherwise or before completion. */
  verdict: 'pass' | 'issues' | null;
  /** Set only when status is 'skipped'. */
  skippedReason: string | null;
  approval: StepRunApproval | null;
  /** This round's self-reported progress (task 5.017) — absent until first reported, and always absent on a fresh round. Stays on the record once the round settles, for the finished view's collapsible Progress section. */
  progress?: StepRunProgress | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * GET /api/workflow-runs/:id — the run plus every step's full round history, shaped for a frontend
 * Stepper: one entry per WorkflowStep with every round it's had so far. See workerManager.ts's
 * getWorkflowRunDetail.
 */
export interface WorkflowRunDetail {
  run: WorkflowRunRecord;
  steps: { step: WorkflowStep; rounds: StepRunRecord[]; earlierRounds?: EarlierStepRun[] }[];
  /** The task's pending per-step notes, keyed by step id. */
  stepNotes?: Record<string, string>;
}

/** A round from an earlier run of a reopened bug, with the round number it was shown as then. Read-only history. */
export type EarlierStepRun = StepRunRecord & { displayRound: number };

const DEFAULT_BASE_URL = 'http://localhost:4500';

function baseUrl(): string {
  // import.meta.env only exists under Vite; plain Node (tests) sees `env` as undefined here.
  return import.meta.env?.VITE_SERVER_URL ?? DEFAULT_BASE_URL;
}

/** A daemon path as an absolute URL, for links the browser opens itself (downloads). */
export function absoluteUrl(path: string): string {
  return `${baseUrl()}${path}`;
}

/** The bidirectional PTY channel for one interactive CLI Task. */
export function terminalWebSocketUrl(taskId: string): string {
  const url = new URL(baseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/terminal';
  url.search = new URLSearchParams({ taskId }).toString();
  return url.toString();
}

/**
 * Base64-encodes a File/Blob for the Catalog upload endpoints, which take raw file bytes as base64
 * inside the JSON body (see UploadCatalogAgentInput/UploadCatalogSkillInput doc comments). Built on
 * `Blob#arrayBuffer` and the global `btoa`, both available in the browser and under Node's test
 * runner, so this needs no DOM-only File APIs or a Buffer polyfill.
 */
export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000; // Avoids a single String.fromCharCode(...bytes) call blowing the call stack on a large file.
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** A failed daemon request, carrying its HTTP status (e.g. 410 when a task's working copy has been removed). */
export class ApiError extends Error {
  readonly status: number;
  /** The rest of the error response, for the few failures that say more than a message (e.g. the default branch Return offers). */
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error ?? `Request to ${path} failed with ${res.status}`, res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Capped exponential backoff for `connectLiveUpdates`'s reconnect loop: 1s, 2s, 4s, 8s, 15s, 15s, ... — exported (pulled out as a pure function, like `mergeWorkerEvent`) so the schedule itself is testable without a real WebSocket. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

export type WatchedRunKind = 'command' | 'test';

/**
 * Runs whose log popup or detail drawer is open in this window, with how many views show each. The
 * daemon skips its "completed" notification for a watched run; it keeps watches per socket, so every
 * (re)connect re-sends the current set.
 */
const watchedRuns = new Map<string, { kind: WatchedRunKind; runId: string; views: number }>();
let liveSocket: WebSocket | null = null;
const SOCKET_OPEN = 1;

function sendWatch(type: 'watchRun' | 'unwatchRun', kind: WatchedRunKind, runId: string): void {
  if (liveSocket?.readyState === SOCKET_OPEN) liveSocket.send(JSON.stringify({ type, kind, runId }));
}

/** Tells the daemon this window is showing the run; returns the function that releases it (call when the popup or drawer closes). */
export function watchRun(kind: WatchedRunKind, runId: string): () => void {
  const key = `${kind}:${runId}`;
  const entry = watchedRuns.get(key) ?? { kind, runId, views: 0 };
  entry.views += 1;
  watchedRuns.set(key, entry);
  if (entry.views === 1) sendWatch('watchRun', kind, runId);
  return () => {
    const current = watchedRuns.get(key);
    if (!current) return;
    current.views -= 1;
    if (current.views > 0) return;
    watchedRuns.delete(key);
    sendWatch('unwatchRun', kind, runId);
  };
}

export const serverApi = {
  githubAccounts: (): Promise<GithubAccountsResult> => request('/api/github/accounts'),
  saveGithubIdentity: (login: string, identity: { name: string; email: string }): Promise<GithubAccountsResult> =>
    request(`/api/github/accounts/${encodeURIComponent(login)}/identity`, { method: 'PUT', body: JSON.stringify(identity) }),
  resetGithubIdentity: (login: string): Promise<GithubAccountsResult> =>
    request(`/api/github/accounts/${encodeURIComponent(login)}/identity`, { method: 'DELETE' }),
  /** Global Settings > Google (SEO). Write-only: the daemon only ever says whether a client is saved. */
  googleOAuthClient: (): Promise<{ saved: boolean }> => request('/api/settings/google-oauth-client'),
  saveGoogleOAuthClient: (clientId: string, clientSecret: string): Promise<{ saved: true }> =>
    request('/api/settings/google-oauth-client', { method: 'PUT', body: JSON.stringify({ clientId, clientSecret }) }),
  removeGoogleOAuthClient: (): Promise<void> => request('/api/settings/google-oauth-client', { method: 'DELETE' }),
  setProjectGithubAccount: (projectId: string, githubAccount: string | null): Promise<ServerProject> =>
    request(`/api/projects/${projectId}/github-account`, { method: 'PATCH', body: JSON.stringify({ githubAccount }) }),
  checkProjectGithubAccount: (projectId: string): Promise<AccountCheck> =>
    request(`/api/projects/${projectId}/github-account/check`, { method: 'POST' }),
  openPullRequests: (id: string): Promise<PullRequestsResponse> =>
    request(`/api/projects/${id}/open-pull-requests`),
  setProjectAutoPull: (projectId: string, autoPullEnabled: boolean): Promise<ServerProject> =>
    request(`/api/projects/${projectId}/auto-pull`, { method: 'PATCH', body: JSON.stringify({ autoPullEnabled }) }),
  setProjectGitProvider: (projectId: string, gitProvider: GitProviderId): Promise<ServerProject> =>
    request(`/api/projects/${projectId}/git-provider`, { method: 'PATCH', body: JSON.stringify({ gitProvider }) }),
  getProject: (id: string): Promise<ServerProject> => request(`/api/projects/${id}`),
  pullRequestMergeState: (id: string, number: number): Promise<MergeStateResponse> =>
    request(`/api/projects/${id}/pull-requests/${number}/merge-state`),
  mergePullRequest: (id: string, number: number, options: MergeRequestOptions = {}): Promise<MergeResponse> =>
    request(`/api/projects/${id}/pull-requests/${number}/merge`, { method: 'POST', body: JSON.stringify(options) }),
  checkoutPullRequest: (id: string, number: number): Promise<ServerProject> =>
    request(`/api/projects/${id}/pull-requests/${number}/checkout`, { method: 'POST' }),
  /** Back to the branch from before the checkout, or to `branch` (the offered default branch) when that one is gone. */
  returnFromPullRequest: (id: string, branch?: string): Promise<ServerProject> =>
    request(`/api/projects/${id}/pull-requests/return`, { method: 'POST', body: JSON.stringify(branch ? { branch } : {}) }),
  projectBranches: (id: string): Promise<{ current: string; branches: string[] }> => request(`/api/projects/${id}/branches`),
  checkoutBranch: (id: string, branch: string, create: boolean): Promise<{ current: string; branches: string[] }> =>
    request(`/api/projects/${id}/branches`, { method: 'POST', body: JSON.stringify({ branch, create }) }),
  listProjects: (): Promise<ServerProject[]> => request('/api/projects'),

  createProject: (name: string, position: [number, number] | null, repositoryUrl?: string, typeId?: string, siteUrl?: string, timezone?: string): Promise<ServerProject> =>
    request('/api/projects', { method: 'POST', body: JSON.stringify({ name, position, repositoryUrl, typeId, siteUrl, timezone }) }),
  seoConnections: (id: string): Promise<ConnectionsViewDto> => request(`/api/projects/${id}/seo/connections`),
  seoStartConsent: (id: string, service: 'gsc' | 'ga4' | 'ads'): Promise<{ authUrl: string }> =>
    request(`/api/projects/${id}/seo/connections/${service}/connect`, { method: 'POST' }),
  seoProperties: (id: string, service: 'gsc' | 'ga4'): Promise<{ properties: Array<{ id: string; label: string }> }> =>
    request(`/api/projects/${id}/seo/connections/${service}/properties`),
  seoSelectProperty: (id: string, service: 'gsc' | 'ga4', property: string, confirm: boolean): Promise<ConnectionsViewDto> =>
    request(`/api/projects/${id}/seo/connections/${service}/property`, { method: 'PUT', body: JSON.stringify({ property, confirm }) }),
  seoConnectAds: (id: string, developerToken: string, customerId: string): Promise<{ ok: boolean; volume: 'exact' | 'range' | 'unknown'; message?: string; connections: ConnectionsViewDto }> =>
    request(`/api/projects/${id}/seo/connections/ads`, { method: 'PUT', body: JSON.stringify({ developerToken, customerId }) }),
  seoConnectBing: (id: string, apiKey: string): Promise<{ ok: boolean; message?: string; connections: ConnectionsViewDto }> =>
    request(`/api/projects/${id}/seo/connections/bing`, { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  seoSaveIndexNow: (id: string, key?: string): Promise<ConnectionsViewDto> =>
    request(`/api/projects/${id}/seo/connections/indexnow`, { method: 'PUT', body: JSON.stringify(key ? { key } : {}) }),
  seoDisconnect: (id: string, service: string): Promise<ConnectionsViewDto> =>
    request(`/api/projects/${id}/seo/connections/${service}`, { method: 'DELETE' }),
  seoSyncNow: (id: string): Promise<{ id: string; status: string }> => request(`/api/projects/${id}/seo/sync`, { method: 'POST' }),
  seoSyncOnOpen: (id: string): Promise<{ started: boolean }> => request(`/api/projects/${id}/seo/sync/on-open`, { method: 'POST' }),
  seoData: (id: string): Promise<DataStatusDto> => request(`/api/projects/${id}/seo/data`),
  seoSetData: (id: string, patch: { retentionMonths?: number; warningBytes?: number }): Promise<DataStatusDto> =>
    request(`/api/projects/${id}/seo/data`, { method: 'PATCH', body: JSON.stringify(patch) }),
  seoDiscardPreview: (id: string): Promise<DiscardPreviewDto> => request(`/api/projects/${id}/seo/data/discard/preview`),
  seoAcknowledgeDiscard: (id: string): Promise<DiscardPreviewDto> => request(`/api/projects/${id}/seo/data/discard/acknowledge`, { method: 'POST' }),
  seoPages: (id: string, params: URLSearchParams): Promise<PagesDto> => request(`/api/projects/${id}/seo/pages?${params}`),
  seoPageDetail: (id: string, url: string, params: URLSearchParams): Promise<PageDetailDto> => request(`/api/projects/${id}/seo/pages/detail?${new URLSearchParams({ url, ...Object.fromEntries(params) })}`),
  // The Internal links tab (server/src/api/seoRoutes.ts). A conflict (409) on start carries `details.runId` of the run in progress.
  seoInternalLinks: (id: string): Promise<LinksOverviewDto> => request(`/api/projects/${id}/seo/internal-links`),
  seoCrawlSettings: (id: string, patch: Partial<CrawlSettingsDto>): Promise<CrawlSettingsDto> => request(`/api/projects/${id}/seo/internal-links/settings`, { method: 'PUT', body: JSON.stringify(patch) }),
  seoCrawlRun: (id: string): Promise<CrawlRunDto | null> => request(`/api/projects/${id}/seo/internal-links/crawl`),
  seoStartCrawl: (id: string, resume: boolean): Promise<CrawlRunDto> => request(`/api/projects/${id}/seo/internal-links/crawl`, { method: 'POST', body: JSON.stringify({ resume }) }),
  seoRunningJobs: (): Promise<{ jobs: SeoJobDto[] }> => request('/api/seo/jobs/running'),
  contentRunningJobs: (): Promise<{ jobs: ContentJobDto[] }> => request('/api/content/jobs/running'),
  contentStopRender: (id: string, conceptId: string, renderId: string): Promise<unknown> => request(`/api/projects/${id}/content/concepts/${conceptId}/video/renders/${renderId}/stop`, { method: 'POST' }),
  contentStopImageRender: (id: string, assetId: string, renderId: string): Promise<unknown> => request(`/api/projects/${encodeURIComponent(id)}/content/assets/${encodeURIComponent(assetId)}/images/renders/${encodeURIComponent(renderId)}/stop`, { method: 'POST' }),
  contentStopThumbnailRender: (id: string, assetId: string, renderId: string): Promise<unknown> => request(`/api/projects/${encodeURIComponent(id)}/content/assets/${encodeURIComponent(assetId)}/thumbnail/renders/${encodeURIComponent(renderId)}/stop`, { method: 'POST' }),
  contentStopInsights: (id: string): Promise<unknown> => request(`/api/projects/${encodeURIComponent(id)}/content/insights/stop`, { method: 'POST' }),
  contentStopStudio: (id: string): Promise<unknown> => request(`/api/projects/${id}/content/remotion/studio/stop`, { method: 'POST' }),
  seoStopCrawl: (id: string): Promise<CrawlRunDto | null> => request(`/api/projects/${id}/seo/internal-links/crawl/stop`, { method: 'POST' }),
  seoGraph: (id: string, snapshot: string): Promise<GraphDto> => request(`/api/projects/${id}/seo/internal-links/graph?snapshot=${encodeURIComponent(snapshot)}`),
  seoGraphPage: (id: string, snapshot: string, url: string): Promise<PageLinksDto> => request(`/api/projects/${id}/seo/internal-links/page?${new URLSearchParams({ snapshot, url })}`),
  seoMatrix: (id: string, body: object): Promise<MatrixDto> => request(`/api/projects/${id}/seo/internal-links/matrix`, { method: 'POST', body: JSON.stringify(body) }),
  seoMatrixExport: async (id: string, body: object): Promise<{ csv: string; filename: string }> => {
    const res = await fetch(`${baseUrl()}/api/projects/${id}/seo/internal-links/matrix/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const failed = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(failed.error ?? 'The export failed', res.status, failed);
    }
    return { csv: await res.text(), filename: /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'matrix.csv' };
  },
  seoCrawlLog: (id: string, params: URLSearchParams): Promise<CrawlLogDto> => request(`/api/projects/${id}/seo/internal-links/log?${params}`),
  seoCrawlLogPage: (id: string, snapshot: string, url: string): Promise<CrawlLogPageDto> => request(`/api/projects/${id}/seo/internal-links/log/page?${new URLSearchParams({ snapshot, url })}`),
  seoCrawlLogExport: async (id: string, params: URLSearchParams): Promise<{ csv: string; filename: string }> => {
    const res = await fetch(`${baseUrl()}/api/projects/${id}/seo/internal-links/log/export?${params}`);
    if (!res.ok) {
      const failed = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(failed.error ?? 'The export failed', res.status, failed);
    }
    return { csv: await res.text(), filename: /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'crawl-log.csv' };
  },
  seoCompare: (id: string, from: string, to: string): Promise<CompareDto> => request(`/api/projects/${id}/seo/internal-links/compare?${new URLSearchParams({ from, to })}`),
  // The Backlinks tab (server/src/api/seoRoutes.ts).
  seoBacklinks: (id: string, params: URLSearchParams): Promise<BacklinksDto> => request(`/api/projects/${id}/seo/backlinks?${params}`),
  seoBacklinkOverview: (id: string, period: number): Promise<OverviewDto> => request(`/api/projects/${id}/seo/backlinks/overview?period=${period}`),
  seoBacklinkDomains: (id: string): Promise<{ domains: DomainRollupDto[] }> => request(`/api/projects/${id}/seo/backlinks/domains`),
  seoBacklinkTargets: (id: string): Promise<{ targets: TargetRollupDto[] }> => request(`/api/projects/${id}/seo/backlinks/targets`),
  seoBacklinkBatches: (id: string): Promise<{ batches: BatchDto[] }> => request(`/api/projects/${id}/seo/backlinks/batches`),
  seoBacklinkMappings: (id: string): Promise<{ mappings: MappingDto[] }> => request(`/api/projects/${id}/seo/backlinks/mappings`),
  seoBacklinksExportUrl: (id: string, params: URLSearchParams): string => `${baseUrl()}/api/projects/${id}/seo/backlinks/export?${params}`,
  seoPreviewBacklinkImport: (id: string, body: ImportRequestDto): Promise<PreviewDto> => request(`/api/projects/${id}/seo/backlinks/import/preview`, { method: 'POST', body: JSON.stringify(body) }),
  seoCommitBacklinkImport: (id: string, body: ImportRequestDto): Promise<CommitDto> => request(`/api/projects/${id}/seo/backlinks/import`, { method: 'POST', body: JSON.stringify(body) }),
  seoSetBacklinkNote: (id: string, uid: string, note: string): Promise<{ note: string }> => request(`/api/projects/${id}/seo/backlinks/${encodeURIComponent(uid)}/note`, { method: 'PUT', body: JSON.stringify({ note }) }),
  seoDeleteBacklink: (id: string, uid: string): Promise<void> => request(`/api/projects/${id}/seo/backlinks/${encodeURIComponent(uid)}`, { method: 'DELETE' }),
  // The Reports tab (server/src/api/seoReportRoutes.ts).
  seoReport: (id: string, params: URLSearchParams): Promise<ReportDto> => request(`/api/projects/${id}/seo/reports/live?${params}`),
  seoReportSummary: (id: string, body: Record<string, string>): Promise<SummaryDto> => request(`/api/projects/${id}/seo/reports/summary`, { method: 'POST', body: JSON.stringify(body) }),
  seoSavedReports: (id: string): Promise<{ reports: SavedMetaDto[] }> => request(`/api/projects/${id}/seo/reports`),
  seoSavedReport: (id: string, reportId: string): Promise<SavedReportDto> => request(`/api/projects/${id}/seo/reports/${encodeURIComponent(reportId)}`),
  seoSaveReport: (id: string, body: Record<string, unknown>): Promise<SavedMetaDto> => request(`/api/projects/${id}/seo/reports`, { method: 'POST', body: JSON.stringify(body) }),
  seoDeleteReport: (id: string, reportId: string): Promise<void> => request(`/api/projects/${id}/seo/reports/${encodeURIComponent(reportId)}`, { method: 'DELETE' }),
  seoReportSchedule: (id: string): Promise<ScheduleStateDto> => request(`/api/projects/${id}/seo/reports/schedule`),
  seoReportExportUrl: (id: string, path: string): string => `${baseUrl()}/api/projects/${id}/seo/${path}`,
  // The Tasks panel (server/src/api/seoTaskRoutes.ts).
  seoTasks: (id: string, params: URLSearchParams): Promise<TaskListDto> => request(`/api/projects/${id}/seo/tasks?${params}`),
  seoTask: (id: string, taskId: string): Promise<TaskDetailDto> => request(`/api/projects/${id}/seo/tasks/${encodeURIComponent(taskId)}`),
  seoRelatedTasks: (id: string, type: string, ref: string): Promise<{ inData: boolean; tasks: TaskRowDto[] }> => request(`/api/projects/${id}/seo/tasks/related?${new URLSearchParams({ type, ref })}`),
  seoCreateTask: (id: string, body: Record<string, unknown>): Promise<TaskRowDto> => request(`/api/projects/${id}/seo/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  seoUpdateTask: (id: string, taskId: string, body: Record<string, unknown>): Promise<TaskRowDto> => request(`/api/projects/${id}/seo/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  seoDeleteTask: (id: string, taskId: string): Promise<void> => request(`/api/projects/${id}/seo/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
  seoTaskCsvUrl: (id: string, taskId: string): string => `${baseUrl()}/api/projects/${id}/seo/tasks/${encodeURIComponent(taskId)}/csv`,
  seoStartAgentTask: (id: string, body: Record<string, unknown>): Promise<TaskDetailDto> => request(`/api/projects/${id}/seo/agent-tasks`, { method: 'POST', body: JSON.stringify(body) }),
  seoStopAgentTask: (id: string, taskId: string): Promise<TaskDetailDto> => request(`/api/projects/${id}/seo/agent-tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST' }),
  seoProposal: (id: string, taskId: string): Promise<ProposalDto> => request(`/api/projects/${id}/seo/agent-tasks/${encodeURIComponent(taskId)}/proposal`),
  seoChangeProposalRow: (id: string, taskId: string, rowId: string, body: Record<string, unknown>): Promise<ProposalRowDto> => request(`/api/projects/${id}/seo/agent-tasks/${encodeURIComponent(taskId)}/proposal/rows/${encodeURIComponent(rowId)}`, { method: 'PUT', body: JSON.stringify(body) }),
  seoDecideAllPending: (id: string, taskId: string, decision: 'accepted' | 'rejected'): Promise<{ changed: number }> => request(`/api/projects/${id}/seo/agent-tasks/${encodeURIComponent(taskId)}/proposal/decide-all`, { method: 'POST', body: JSON.stringify({ decision }) }),
  seoApproveProposal: (id: string, taskId: string): Promise<TaskDetailDto> => request(`/api/projects/${id}/seo/agent-tasks/${encodeURIComponent(taskId)}/approve`, { method: 'POST' }),
  seoRetryHandoff: (id: string, taskId: string): Promise<TaskDetailDto> => request(`/api/projects/${id}/seo/agent-tasks/${encodeURIComponent(taskId)}/handoff/retry`, { method: 'POST' }),
  seoManualHandoff: (id: string, taskId: string): Promise<TaskDetailDto> => request(`/api/projects/${id}/seo/agent-tasks/${encodeURIComponent(taskId)}/handoff/manual`, { method: 'POST' }),
  seoProposalCsvUrl: (id: string, taskId: string): string => `${baseUrl()}/api/projects/${id}/seo/agent-tasks/${encodeURIComponent(taskId)}/proposal.csv`,
  seoSchedules: (id: string): Promise<{ actions: Array<{ id: string; label: string }>; schedules: ScheduleDto[] }> => request(`/api/projects/${id}/seo/schedules`),
  seoCronPreview: (id: string, cron: string): Promise<{ cron: string; timezone: string; runs: string[] }> => request(`/api/projects/${id}/seo/schedules/cron-preview?${new URLSearchParams({ cron })}`),
  seoCreateSchedule: (id: string, body: Record<string, unknown>): Promise<ScheduleDto> => request(`/api/projects/${id}/seo/schedules`, { method: 'POST', body: JSON.stringify(body) }),
  seoUpdateSchedule: (id: string, jobId: string, body: Record<string, unknown>): Promise<ScheduleDto> => request(`/api/projects/${id}/seo/schedules/${encodeURIComponent(jobId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  seoDeleteSchedule: (id: string, jobId: string): Promise<void> => request(`/api/projects/${id}/seo/schedules/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  seoRunSchedule: (id: string, jobId: string): Promise<{ schedule: ScheduleDto }> => request(`/api/projects/${id}/seo/schedules/${encodeURIComponent(jobId)}/run`, { method: 'POST' }),
  seoScheduleHistory: (id: string, jobId: string): Promise<{ entries: Array<{ id: string; outcome: string; note: string | null; startedAt: string; startedBy: string }> }> => request(`/api/projects/${id}/seo/schedules/${encodeURIComponent(jobId)}/history`),
  // The Keywords tab (server/src/api/seoRoutes.ts). Cluster and keyword ids travel in bodies, never in paths.
  seoClusters: (id: string, params: URLSearchParams): Promise<ClustersDto> => request(`/api/projects/${id}/seo/keywords/clusters?${params}`),
  seoKeywords: (id: string, params: URLSearchParams): Promise<KeywordsDto> => request(`/api/projects/${id}/seo/keywords?${params}`),
  seoKeywordDetail: (id: string, key: string, params: URLSearchParams): Promise<KeywordDetailDto> => request(`/api/projects/${id}/seo/keywords/detail?${new URLSearchParams({ key, ...Object.fromEntries(params) })}`),
  seoKeywordsExportUrl: (id: string, params: URLSearchParams): string => `${baseUrl()}/api/projects/${id}/seo/keywords/export?${params}`,
  seoAddKeywords: (id: string, keywords: string[]): Promise<AddResultDto> => request(`/api/projects/${id}/seo/keywords`, { method: 'POST', body: JSON.stringify({ keywords }) }),
  seoImportKeywords: (id: string, csv: string): Promise<AddResultDto> => request(`/api/projects/${id}/seo/keywords/import`, { method: 'POST', body: JSON.stringify({ csv }) }),
  seoUpdateKeyword: (id: string, body: { key: string; status?: string; targetPage?: string | null }): Promise<unknown> => request(`/api/projects/${id}/seo/keywords/item`, { method: 'PATCH', body: JSON.stringify(body) }),
  seoMoveKeywords: (id: string, keys: string[], clusterId: string | null): Promise<unknown> => request(`/api/projects/${id}/seo/keywords/move`, { method: 'POST', body: JSON.stringify({ keys, clusterId }) }),
  seoCreateCluster: (id: string, name: string): Promise<{ id: string; name: string }> => request(`/api/projects/${id}/seo/keywords/clusters`, { method: 'POST', body: JSON.stringify({ name }) }),
  seoRenameCluster: (id: string, clusterId: string, name: string): Promise<unknown> => request(`/api/projects/${id}/seo/keywords/clusters/${encodeURIComponent(clusterId)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  seoDeleteCluster: (id: string, clusterId: string): Promise<unknown> => request(`/api/projects/${id}/seo/keywords/clusters/${encodeURIComponent(clusterId)}`, { method: 'DELETE' }),
  seoMergeClusters: (id: string, sourceIds: string[], targetId: string): Promise<unknown> => request(`/api/projects/${id}/seo/keywords/clusters/merge`, { method: 'POST', body: JSON.stringify({ sourceIds, targetId }) }),
  seoSplitCluster: (id: string, clusterId: string, keys: string[], name: string): Promise<{ id: string; name: string }> =>
    request(`/api/projects/${id}/seo/keywords/clusters/${encodeURIComponent(clusterId)}/split`, { method: 'POST', body: JSON.stringify({ keys, name }) }),
  seoKeywordRun: (id: string, kind: 'cluster' | 'research'): Promise<RunDto | null> => request(`/api/projects/${id}/seo/keywords/${kind}-run`),
  seoStartKeywordRun: (id: string, kind: 'cluster' | 'research', body: object = {}): Promise<RunDto> => request(`/api/projects/${id}/seo/keywords/${kind}-run`, { method: 'POST', body: JSON.stringify(body) }),
  seoStopKeywordRun: (id: string, kind: 'cluster' | 'research'): Promise<RunDto> => request(`/api/projects/${id}/seo/keywords/${kind}-run/stop`, { method: 'POST' }),
  seoSuggestions: (id: string): Promise<{ suggestions: SuggestionDto[] }> => request(`/api/projects/${id}/seo/keywords/suggestions`),
  seoHandleSuggestion: (id: string, suggestionId: string, action: 'apply' | 'dismiss'): Promise<unknown> => request(`/api/projects/${id}/seo/keywords/suggestions/${encodeURIComponent(suggestionId)}/${action}`, { method: 'POST' }),
  seoProposals: (id: string, status = 'pending'): Promise<ProposalsDto> => request(`/api/projects/${id}/seo/keywords/proposals?${new URLSearchParams({ status })}`),
  seoAcceptProposals: (id: string, ids: string[], clusterId?: string): Promise<{ accepted: number; alreadyAccepted: number }> =>
    request(`/api/projects/${id}/seo/keywords/proposals/accept`, { method: 'POST', body: JSON.stringify(clusterId ? { ids, clusterId } : { ids }) }),
  seoRejectProposals: (id: string, ids: string[]): Promise<{ rejected: number }> => request(`/api/projects/${id}/seo/keywords/proposals/reject`, { method: 'POST', body: JSON.stringify({ ids }) }),
  seoSetKeywordMarket: (id: string, languageId: string, locationId: string): Promise<unknown> => request(`/api/projects/${id}/seo/keywords/market`, { method: 'PUT', body: JSON.stringify({ languageId, locationId }) }),
  seoRefreshVolumes: (id: string): Promise<{ updated: number }> => request(`/api/projects/${id}/seo/keywords/volumes/refresh`, { method: 'POST' }),
  seoSitemaps: (id: string): Promise<SitemapsDto> => request(`/api/projects/${id}/seo/sitemaps`),
  seoReadSitemaps: (id: string, sitemap?: string): Promise<{ read: number; found: number }> =>
    request(`/api/projects/${id}/seo/sitemaps/${sitemap ? 'reread' : 'read'}`, { method: 'POST', body: JSON.stringify(sitemap ? { sitemap } : {}) }),
  seoSitemapUrls: (id: string, params: URLSearchParams): Promise<{ total: number; offset: number; limit: number; rows: UrlRowDto[] }> => request(`/api/projects/${id}/seo/sitemaps/urls?${params}`),
  seoInspect: (id: string, urls: string[]): Promise<{ results: Array<{ url: string; status: string }>; quota: SitemapsDto['quota'] }> =>
    request(`/api/projects/${id}/seo/sitemaps/urls/inspect`, { method: 'POST', body: JSON.stringify({ urls }) }),
  seoBingCheck: (id: string, urls: string[]): Promise<{ results: Record<string, BingDto> }> =>
    request(`/api/projects/${id}/seo/sitemaps/bing-check`, { method: 'POST', body: JSON.stringify({ urls }) }),
  seoKeyCheck: (id: string, force: boolean): Promise<KeyFileDto> => request(`/api/projects/${id}/seo/indexnow/key-check`, { method: force ? 'POST' : 'GET' }),
  seoIndexNowSubmit: (id: string, body: { mode: 'selected'; urls: string[] } | { mode: 'sitemap' | 'new-or-changed'; sitemap?: string }): Promise<SubmitOutcomeDto> =>
    request(`/api/projects/${id}/seo/indexnow/submit`, { method: 'POST', body: JSON.stringify(body) }),
  seoIndexNowLog: (id: string): Promise<{ entries: LogEntryDto[]; hasMore: boolean }> => request(`/api/projects/${id}/seo/indexnow/log?limit=100`),
  seoDiscard: (id: string): Promise<{ id: string; status: string }> => request(`/api/projects/${id}/seo/data/discard`, { method: 'POST' }),

  // ---- Building Types: the create flow, the Catalog's slot configuration, and a Building's bulk data ----

  listBuildingTypes: (): Promise<ServerBuildingType[]> => request('/api/building-types'),
  // A Building's Schedules area — see server/src/api/scheduleRoutes.ts.
  getSchedules: (id: string): Promise<SchedulesView> => request(`/api/projects/${id}/schedules`),
  setScheduleTimezone: (id: string, timezone: string | null): Promise<SchedulesView> =>
    request(`/api/projects/${id}/schedules`, { method: 'PATCH', body: JSON.stringify({ timezone }) }),
  restoreScheduleDefaults: (id: string): Promise<SchedulesView> => request(`/api/projects/${id}/schedules/restore-defaults`, { method: 'POST' }),
  previewScheduleCron: (id: string, cron: string): Promise<CronPreview> => request(`/api/projects/${id}/schedules/cron-preview?${new URLSearchParams({ cron })}`),
  createScheduleJob: (id: string, job: JobRequest): Promise<ScheduledJob> => request(`/api/projects/${id}/schedules/jobs`, { method: 'POST', body: JSON.stringify(job) }),
  updateScheduleJob: (id: string, jobId: string, patch: JobRequest): Promise<ScheduledJob> =>
    request(`/api/projects/${id}/schedules/jobs/${jobId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteScheduleJob: (id: string, jobId: string): Promise<void> => request(`/api/projects/${id}/schedules/jobs/${jobId}`, { method: 'DELETE' }),
  runScheduleJobNow: (id: string, jobId: string): Promise<{ entry: JobHistoryEntry; job: ScheduledJob }> => request(`/api/projects/${id}/schedules/jobs/${jobId}/run`, { method: 'POST' }),
  getScheduleHistory: (id: string, jobId: string, cursor?: string): Promise<HistoryPage> =>
    request(`/api/projects/${id}/schedules/jobs/${jobId}/history${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`),
  // Links, capability calls, event subscriptions and the Activity log — see server/src/api/connectionRoutes.ts.
  listAllLinks: (): Promise<LinkView[]> => request('/api/links'),
  getLinks: (id: string): Promise<LinksResponse> => request(`/api/projects/${id}/links`),
  createLink: (link: LinkRequest): Promise<LinkView> => request('/api/links', { method: 'POST', body: JSON.stringify(link) }),
  updateLink: (linkId: string, patch: LinkRequest): Promise<LinkView> => request(`/api/links/${linkId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteLink: (linkId: string): Promise<void> => request(`/api/links/${linkId}`, { method: 'DELETE' }),
  getSubscriptions: (id: string): Promise<SubscriptionView[]> => request(`/api/projects/${id}/subscriptions`),
  createSubscription: (subscription: { subscriberBuildingId: string; sourceBuildingId: string; eventId: string; jobId: string }): Promise<SubscriptionView> =>
    request('/api/subscriptions', { method: 'POST', body: JSON.stringify(subscription) }),
  setSubscriptionEnabled: (subscriptionId: string, enabled: boolean): Promise<SubscriptionView> =>
    request(`/api/subscriptions/${subscriptionId}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteSubscription: (subscriptionId: string): Promise<void> => request(`/api/subscriptions/${subscriptionId}`, { method: 'DELETE' }),
  callCapability: (id: string, call: { targetBuildingId: string; capabilityId: string; inputs: Record<string, unknown>; idempotencyKey?: string }): Promise<CallOutcome> =>
    request(`/api/projects/${id}/capability-calls`, { method: 'POST', body: JSON.stringify(call) }),
  decideCapabilityCall: (callId: string, decision: 'approve' | 'request-changes' | 'stop'): Promise<CallOutcome | { callId: string; state: string }> =>
    request(`/api/capability-calls/${callId}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }),
  getActivity: (id: string, query: string): Promise<{ entries: ActivityEntry[] }> => request(`/api/projects/${id}/activity${query}`),
  getBuildingTypeConfig: (typeId: string): Promise<{ type: ServerBuildingType; slots: ConfigSlot[] }> =>
    request(`/api/building-types/${encodeURIComponent(typeId)}/config`),
  setSlotConfig: (typeId: string, slotId: string, change: SlotEdit): Promise<{ slots: ConfigSlot[] }> =>
    request(`/api/building-types/${encodeURIComponent(typeId)}/slots/${encodeURIComponent(slotId)}`, { method: 'PUT', body: JSON.stringify(change) }),
  resetSlotConfig: (typeId: string, slotId: string): Promise<{ slots: ConfigSlot[] }> =>
    request(`/api/building-types/${encodeURIComponent(typeId)}/slots/${encodeURIComponent(slotId)}`, { method: 'DELETE' }),
  listBuildingData: (id: string, table: string, query: DataQuery): Promise<{ rows: Array<Record<string, string | number>>; nextCursor: string | null; total: number | null }> =>
    request(`/api/projects/${id}/data/${encodeURIComponent(table)}?${dataQueryString(query)}`),
  buildingAggregate: (id: string, rollup: string, params: Record<string, string>): Promise<{ rows: Array<Record<string, string | number>>; source: string }> =>
    request(`/api/projects/${id}/rollups/${encodeURIComponent(rollup)}?${new URLSearchParams(params)}`),
  insertBuildingRows: (id: string, table: string, rows: Array<Record<string, string | number>>): Promise<{ inserted: number }> =>
    request(`/api/projects/${id}/data/${encodeURIComponent(table)}`, { method: 'POST', body: JSON.stringify({ rows }) }),
  startSyntheticIngest: (id: string, table: string, rows: number): Promise<StorageJobDto> =>
    request(`/api/projects/${id}/data/${encodeURIComponent(table)}/synthetic`, { method: 'POST', body: JSON.stringify({ rows }) }),
  getStorage: (id: string): Promise<StorageStatusDto> => request(`/api/projects/${id}/storage`),
  setStorageThreshold: (id: string, warningBytes: number): Promise<StorageStatusDto> =>
    request(`/api/projects/${id}/storage`, { method: 'PATCH', body: JSON.stringify({ warningBytes }) }),
  runRetention: (id: string): Promise<StorageJobDto> => request(`/api/projects/${id}/storage/retention`, { method: 'POST', body: '{}' }),
  exportStorage: (id: string): Promise<{ file: string }> => request(`/api/projects/${id}/storage/export`, { method: 'POST' }),
  resumeIngestion: (id: string): Promise<StorageStatusDto> => request(`/api/projects/${id}/storage/resume`, { method: 'POST' }),
  getStorageJob: (id: string, jobId: string): Promise<StorageJobDto> => request(`/api/projects/${id}/storage/jobs/${jobId}`),
  cancelStorageJob: (id: string, jobId: string): Promise<StorageJobDto> => request(`/api/projects/${id}/storage/jobs/${jobId}/cancel`, { method: 'POST' }),
  listSecrets: (id: string): Promise<Array<{ key: string; hasSecret: true }>> => request(`/api/projects/${id}/secrets`),
  saveSecret: (id: string, key: string, value: string): Promise<{ key: string; hasSecret: true }> =>
    request(`/api/projects/${id}/secrets/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) }),

  updateProjectPosition: (id: string, position: [number, number]): Promise<ServerProject> =>
    request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ position }) }),

  /** The sync icon's click action: starts a real CommandRun that fetches and fast-forwards the checked-out branch up to its remote — see server/src/commands/commandRunner.ts's runProjectSync. */
  syncProjectBranch: (id: string): Promise<CommandRun> => request(`/api/projects/${id}/sync`, { method: 'POST' }),

  renameProject: (id: string, name: string): Promise<ServerProject> =>
    request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  deleteProject: (id: string): Promise<void> => request(`/api/projects/${id}`, { method: 'DELETE' }),

  listExecutors: (): Promise<ExecutorProfile[]> => request('/api/executors'),
  listAnalyticsAgents: (): Promise<AnalyticsAgentList> => request('/api/analytics/agents'),
  /** One agent's readings and activity between two instants: one day as this browser's timezone cuts it. */
  getAnalyticsDay: (agentId: string, from: number, to: number): Promise<AgentDayView> =>
    request(`/api/analytics/agents/${encodeURIComponent(agentId)}?from=${from}&to=${to}`),
  getAnalyticsSteps: (agentId: string): Promise<AgentStepsView> => request(`/api/analytics/agents/${encodeURIComponent(agentId)}/steps`),
  refreshAnalytics: (agentId: string): Promise<AnalyticsRefreshResult> =>
    request(`/api/analytics/agents/${encodeURIComponent(agentId)}/refresh`, { method: 'POST' }),

  // ---- Settings panel: add/edit/remove the coding agents ----

  createExecutor: (input: ExecutorInput): Promise<ExecutorConfig> =>
    request('/api/executors', { method: 'POST', body: JSON.stringify(input) }),

  updateExecutor: (id: string, patch: Partial<ExecutorInput>): Promise<ExecutorConfig> =>
    request(`/api/executors/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteExecutor: (id: string): Promise<void> => request(`/api/executors/${id}`, { method: 'DELETE' }),
  setDefaultExecutor: (executorId: string): Promise<{ defaultExecutorId: string }> =>
    request('/api/executors/default', { method: 'PUT', body: JSON.stringify({ executorId }) }),

  /**
   * `templateId`/`skillIds` are optional — omit both (leave `undefined`) to keep the server's own
   * "no explicit choice = default Template, no extra Skills" fallback (see
   * server/src/worker/workerManager.ts's startTask); `JSON.stringify` drops `undefined`-valued
   * fields entirely rather than sending `null`/`[]`, so a caller building this from a picker should
   * pass `undefined`, not an empty string/array, for "nothing chosen".
   */
  startTask: (
    projectId: string,
    description: string,
    executorId?: string,
    autonomy?: Autonomy,
    templateId?: string,
    skillIds?: string[],
  ): Promise<ServerTask> =>
    request(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify({ description, executorId, autonomy, templateId, skillIds }) }),

  /** Reopens a settled interactive CLI session without sending another prompt. */
  resumeTerminalTask: (taskId: string): Promise<ServerTask> =>
    request(`/api/tasks/${taskId}/resume`, { method: 'POST' }),

  /** Continues a settled (non-terminal/"structured") Task's conversation with a fresh instruction, as a new linked Task. */
  followUpTask: (taskId: string, instruction: string): Promise<ServerTask> =>
    request(`/api/tasks/${taskId}/followup`, { method: 'POST', body: JSON.stringify({ instruction }) }),

  stepReopenOptions: (taskId: string): Promise<{ choiceRequired: boolean; permissionsAvailable: boolean; reason?: string }> =>
    request(`/api/tasks/${taskId}/reopen-session/options`),

  /** Reopens a settled step's conversation with its original setup or read-only permissions. */
  reopenStepSession: (taskId: string, mode?: 'permissions' | 'read-only'): Promise<{ location: 'worktree' | 'recreated-worktree' | 'project'; mode: 'permissions' | 'read-only'; reason?: string }> =>
    request(`/api/tasks/${taskId}/reopen-session`, { method: 'POST', body: JSON.stringify({ mode }) }),

  resolveStepInspectChanges: (runId: string, decision: 'commit-push' | 'discard'): Promise<WorkflowRunRecord> =>
    request(`/api/workflow-runs/${runId}/reopen-changes`, { method: 'POST', body: JSON.stringify({ decision }) }),

  /** Ends a session `reopenStepSession` opened. */
  closeStepSession: (taskId: string): Promise<void> =>
    request(`/api/tasks/${taskId}/reopen-session`, { method: 'DELETE' }),

  /** Marks a paused interactive CLI Task completed directly. */
  completeTerminalTask: (taskId: string): Promise<ServerTask> =>
    request(`/api/tasks/${taskId}/complete`, { method: 'POST' }),

  /** Commits and pushes an ongoing ('developing'/'blocked') Task's work so far without completing it. `committed` is false when there was nothing new to commit. */
  interimCommitTask: (taskId: string): Promise<{ committed: boolean; message: string }> =>
    request(`/api/tasks/${taskId}/interim-commit`, { method: 'POST' }),

  stopTask: (taskId: string): Promise<ServerTask> => request(`/api/tasks/${taskId}/stop`, { method: 'POST' }),

  archiveSession: (taskId: string, archived: boolean): Promise<void> =>
    request(`/api/tasks/${taskId}/archive`, { method: 'PATCH', body: JSON.stringify({ archived }) }),

  /** Renames a session — it and its follow-ups. */
  renameSession: (taskId: string, title: string): Promise<void> =>
    request(`/api/tasks/${taskId}/title`, { method: 'PATCH', body: JSON.stringify({ title }) }),

  /** Deletes a settled session — the Task, its follow-ups and their transcripts. */
  deleteSession: (taskId: string): Promise<void> => request(`/api/tasks/${taskId}/session`, { method: 'DELETE' }),

  listTasksForProject: (projectId: string): Promise<ServerTask[]> => request(`/api/projects/${projectId}/tasks`),

  getTaskRuntime: (taskId: string): Promise<TerminalRuntimeState> => request(`/api/tasks/${taskId}/runtime`),

  getTaskTranscript: (taskId: string): Promise<TaskContext> => request(`/api/tasks/${taskId}/transcript`),

  // ---- Testing tab: the config state (read fresh from `.docs/testing/config.json`), latest results and Test Runs ----

  getTestingOverview: (projectId: string): Promise<TestingOverview> => request(`/api/projects/${projectId}/testing`),

  listTestRuns: (projectId: string, limit = 10, status?: TestRunStatus): Promise<TestRunPage> =>
    request(`/api/projects/${projectId}/test-runs?limit=${limit}${status ? `&status=${status}` : ''}`),

  getTestRun: (runId: string): Promise<TestRunDetail> => request(`/api/test-runs/${runId}`),

  runTestAction: (projectId: string, suiteId: string, actionId: string): Promise<TestRun> =>
    request(`/api/projects/${projectId}/test-runs`, { method: 'POST', body: JSON.stringify({ suiteId, actionId }) }),

  runAllTests: (projectId: string): Promise<{ batchId: string; runs: TestRun[] }> =>
    request(`/api/projects/${projectId}/test-runs/run-all`, { method: 'POST', body: JSON.stringify({}) }),

  stopTestRun: (runId: string): Promise<TestRun> => request(`/api/test-runs/${runId}/stop`, { method: 'POST' }),

  /** A Project's failed or errored test runs nobody has opened yet (the 3D village's red machines). */
  listUnopenedTestFailures: (projectId: string): Promise<TestRunPage> =>
    request(`/api/projects/${projectId}/test-runs?failureUnopened=true&limit=100`),

  /** Records that someone opened this test run, clearing its unopened failure. */
  markTestRunOpened: (runId: string): Promise<TestRun> => request(`/api/test-runs/${runId}/opened`, { method: 'POST' }),

  removeQueuedTestRun: (runId: string): Promise<void> => request(`/api/test-runs/${runId}`, { method: 'DELETE' }),

  // ---- Testing setup (task 2.005): an approval-gated setup Task ----

  getTestingSetup: (projectId: string): Promise<TestingSetupState | null> => request(`/api/projects/${projectId}/testing/setup`),

  startTestingSetup: (projectId: string, executorId?: string): Promise<TestingSetupStartResult> =>
    request(`/api/projects/${projectId}/testing/setup`, { method: 'POST', body: JSON.stringify({ executorId }) }),

  /** Approves exactly the proposal round the person was shown — the only action that unlocks the setup's write step. */
  approveTestingSetup: (runId: string, proposalRound: number, comment?: string): Promise<WorkflowRunRecord> =>
    request(`/api/testing-setup/${runId}/approve`, { method: 'POST', body: JSON.stringify({ proposalRound, comment }) }),

  reviseTestingSetup: (runId: string, comment: string): Promise<WorkflowRunRecord> =>
    request(`/api/testing-setup/${runId}/revise`, { method: 'POST', body: JSON.stringify({ comment }) }),

  rejectTestingSetup: (runId: string): Promise<WorkflowRunRecord> => request(`/api/testing-setup/${runId}/reject`, { method: 'POST' }),

  // ---- Documents tab: the whole editable `.docs/` folder ----

  getDocsTree: (projectId: string): Promise<FileListing> => request(`/api/projects/${projectId}/docs/tree`),

  getDocsFile: (projectId: string, path: string): Promise<DocsFileContent> =>
    request(`/api/projects/${projectId}/docs/file?path=${encodeURIComponent(path)}`),

  saveDocsFile: (projectId: string, path: string, content: string): Promise<{ path: string; content: string }> =>
    request(`/api/projects/${projectId}/docs/file`, { method: 'PUT', body: JSON.stringify({ path, content }) }),

  /** Creates an empty file or folder; the returned `path` is what was actually created (a file name with no extension gets ".md"). */
  createDocsEntry: (projectId: string, path: string, type: EntryKind): Promise<{ path: string; type: EntryKind }> =>
    request(`/api/projects/${projectId}/docs/entries`, { method: 'POST', body: JSON.stringify({ path, type }) }),

  // ---- Code tab: whole-project file-tree explorer, read-only apart from creating files and folders ----

  listProjectCodeTree: (projectId: string): Promise<FileListing> => request(`/api/projects/${projectId}/code/tree`),

  /** Creates an empty file or folder anywhere in the project (not inside `.git`); the returned `path` is the normalized path created. */
  createCodeEntry: (projectId: string, path: string, type: EntryKind): Promise<{ path: string; type: EntryKind }> =>
    request(`/api/projects/${projectId}/code/entries`, { method: 'POST', body: JSON.stringify({ path, type }) }),

  getProjectCodeFile: (projectId: string, path: string): Promise<CodeFileContent> =>
    request(`/api/projects/${projectId}/code/file?path=${encodeURIComponent(path)}`),

  // ---- Quick look (task 5.008): live, read-only views of a WorkflowRun's working copy ----

  getQuickLookLocation: (runId: string): Promise<RunLocation> => request(`/api/workflow-runs/${runId}/quick-look`),

  listQuickLookCodeTree: (runId: string): Promise<FileListing> => request(`/api/workflow-runs/${runId}/quick-look/code/tree`),

  getQuickLookCodeFile: (runId: string, path: string): Promise<CodeFileContent> =>
    request(`/api/workflow-runs/${runId}/quick-look/code/file?path=${encodeURIComponent(path)}`),

  getQuickLookDocsTree: (runId: string): Promise<FileListing> => request(`/api/workflow-runs/${runId}/quick-look/docs/tree`),

  getQuickLookDocsFile: (runId: string, path: string): Promise<DocsFileContent> =>
    request(`/api/workflow-runs/${runId}/quick-look/docs/file?path=${encodeURIComponent(path)}`),

  getQuickLookDiff: (runId: string): Promise<QuickLookDiff> => request(`/api/workflow-runs/${runId}/quick-look/diff`),

  getQuickLookDiffFile: (runId: string, path: string): Promise<QuickLookFileDiff> =>
    request(`/api/workflow-runs/${runId}/quick-look/diff/file?path=${encodeURIComponent(path)}`),

  // ---- Project plan: the Full-fledged Project Popover's tab content (docs/roadmap.md) ----

  getPlan: (projectId: string): Promise<ProjectPlan> => request(`/api/projects/${projectId}/plan`),

  createPlanItem: (projectId: string, draft: PlanItemDraft): Promise<PlanItem> =>
    request(`/api/projects/${projectId}/plan-items`, { method: 'POST', body: JSON.stringify(draft) }),

  updatePlanItem: (id: string, patch: PlanItemPatch): Promise<PlanItem> =>
    request(`/api/plan-items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  /** Puts the listed items in this sequence (each keeps a slot one of them already held) — one board column after a drop. Returns the project's full list in its new order. */
  reorderPlanItems: (projectId: string, ids: string[]): Promise<PlanItem[]> =>
    request(`/api/projects/${projectId}/plan-items/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),

  /** Saves the top-level Planning order: sessions, standalone tasks and bugs, and top-level introducing-task cards (`reference`, by that task's id). */
  reorderPlanningQueue: (projectId: string, entries: PlanningQueueOrderEntry[]): Promise<void> =>
    request(`/api/projects/${projectId}/planning-queue/order`, { method: 'PUT', body: JSON.stringify({ entries }) }),

  /** Saves the order of the ready bugs grouped under one introducing task. */
  reorderBugGroup: (projectId: string, introducerId: string, ids: string[]): Promise<void> =>
    request(`/api/projects/${projectId}/planning-queue/bugs/${introducerId}/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),

  /** Flips a not-started bug's advisory Info status. 409 once the bug has started. */
  setBugInfoStatus: (id: string, infoStatus: BugInfoStatus): Promise<PlanItem> =>
    request(`/api/plan-items/${id}`, { method: 'PATCH', body: JSON.stringify({ infoStatus }) }),

  /** Starts a plan-and-bugs session. Without `executorId` it is created with no CLI, to be started later with `startDeferredSession`. */
  startPlanAndBugsSession: (projectId: string, description: string, executorId?: string, autonomy?: Autonomy): Promise<ServerTask> =>
    request(`/api/projects/${projectId}/plan-and-bugs`, { method: 'POST', body: JSON.stringify({ description, executorId, autonomy }) }),

  /** Saves a not-started session's description. 409 once its CLI has started. */
  updateSessionDescription: (taskId: string, description: string): Promise<ServerTask> =>
    request(`/api/tasks/${taskId}/description`, { method: 'PATCH', body: JSON.stringify({ description }) }),

  /** Starts the CLI of a session created without one, on the chosen agent. */
  startDeferredSession: (taskId: string, executorId: string): Promise<ServerTask> =>
    request(`/api/tasks/${taskId}/start-session`, { method: 'POST', body: JSON.stringify({ executorId }) }),

  /** Saves one planning group's ready-task order; `sessionId` is any Task of that planning conversation. */
  reorderPlanningGroup: (projectId: string, sessionId: string, ids: string[]): Promise<void> =>
    request(`/api/projects/${projectId}/planning-queue/sessions/${sessionId}/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),

  completePlanningSession: (taskId: string): Promise<void> =>
    request(`/api/tasks/${taskId}/planning-complete`, { method: 'POST' }),

  /** Switches a task's Auto-merge on or off. 409 when the task cannot have a pull request. */
  setAutoMerge: (projectId: string, itemId: string, enabled: boolean): Promise<PlanItem> =>
    request(`/api/projects/${projectId}/plan-items/${itemId}/auto-merge`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  /** Retries a failed auto-merge (or one waiting for an agent). */
  retryAutoMerge: (projectId: string, itemId: string): Promise<PlanItem> =>
    request(`/api/projects/${projectId}/plan-items/${itemId}/auto-merge/retry`, { method: 'POST' }),
  /** Replaces a ready task's parents. 400 malformed, 404 unknown or other project, 409 cycle / self / started / no repository. */
  setDependencies: (projectId: string, itemId: string, dependsOn: string[]): Promise<PlanItem> =>
    request(`/api/projects/${projectId}/plan-items/${itemId}/dependencies`, { method: 'PUT', body: JSON.stringify({ dependsOn }) }),
  /** Each parent with whether it is satisfied now and why not. */
  dependencyStatus: (projectId: string, itemId: string): Promise<ParentStatus[]> =>
    request(`/api/projects/${projectId}/plan-items/${itemId}/dependencies`),
  /** Starts a dependent task now when every parent is satisfied, else makes it wait. */
  startWhenReady: (projectId: string, itemId: string, options: ExecutePlanItemOptions): Promise<StartWhenReadyResult> =>
    request(`/api/projects/${projectId}/plan-items/${itemId}/start-when-ready`, { method: 'POST', body: JSON.stringify(options) }),
  cancelWaiting: (projectId: string, itemId: string): Promise<PlanItem> =>
    request(`/api/projects/${projectId}/plan-items/${itemId}/cancel-waiting`, { method: 'POST' }),
  /** Makes every ready task of a planning session depend on the previous one, optionally with Auto-merge on. */
  chainPlanningGroup: (projectId: string, session: number, autoMerge: boolean): Promise<PlanItem[]> =>
    request(`/api/projects/${projectId}/planning-groups/${session}/chain`, { method: 'POST', body: JSON.stringify({ autoMerge }) }),
  deletePlanItem: (id: string): Promise<void> => request(`/api/plan-items/${id}`, { method: 'DELETE' }),

  /**
   * Runs one Tasks-breakdown PlanItem for real: accepts the start and returns its WorkflowRun in the
   * 'starting' state — the worktree and agent are set up in the background (`run.startup`). 400 for a
   * bad executor/workflow, or `createBranch` without a repository; 409 when the task limit is reached
   * or the project folder is busy.
   */
  /**
   * Reports a regression on a completed bug and starts its round 2. 400 for a blank or over-long
   * reason; 404 for an unknown bug; 409 when the bug is not completed or the start is refused
   * (task limit reached, project folder busy).
   */
  reportRegression: (id: string, reason: string): Promise<{ item: PlanItem; run: WorkflowRunRecord; workflowNote: string | null }> =>
    request(`/api/plan-items/${id}/regression`, { method: 'POST', body: JSON.stringify({ reason }) }),

  executePlanItem: async (id: string, options: ExecutePlanItemOptions): Promise<ExecutePlanItemResult> => {
    const answer = await request<WorkflowRunRecord | { started: false; entry: PlanItemQueueEntry }>(`/api/plan-items/${id}/execute`, { method: 'POST', body: JSON.stringify(options) });
    return 'entry' in answer ? answer : { started: true, run: answer };
  },

  /** The Project's waiting list, in the order its tasks will start. */
  listPlanItemQueue: (projectId: string): Promise<PlanItemQueueEntry[]> => request(`/api/projects/${projectId}/plan-item-queue`),
  /** Takes a task off the waiting list; it goes back to unstarted. */
  removeFromWaitingList: (entryId: string): Promise<void> => request(`/api/plan-item-queue/${entryId}`, { method: 'DELETE' }),

  // ---- Project Commands: user-defined shell commands, run from the project's root (Commands tab) ----

  listAgentSessions: (projectId: string): Promise<AgentSession[]> => request(`/api/projects/${projectId}/agent-sessions`),
  startAgentSession: (projectId: string, executorId: string): Promise<AgentSession> =>
    request(`/api/projects/${projectId}/agent-sessions`, { method: 'POST', body: JSON.stringify({ executorId }) }),
  resumeAgentSession: (id: string): Promise<AgentSession> => request(`/api/agent-sessions/${id}/resume`, { method: 'POST' }),
  renameAgentSession: (id: string, name: string): Promise<AgentSession> =>
    request(`/api/agent-sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  endAgentSession: (id: string): Promise<AgentSession> => request(`/api/agent-sessions/${id}/end`, { method: 'POST' }),
  deleteAgentSession: (id: string): Promise<void> => request(`/api/agent-sessions/${id}`, { method: 'DELETE' }),

  listCommands: (projectId: string): Promise<ProjectCommand[]> => request(`/api/projects/${projectId}/commands`),

  createCommand: (projectId: string, input: CommandInput): Promise<ProjectCommand> =>
    request(`/api/projects/${projectId}/commands`, { method: 'POST', body: JSON.stringify(input) }),

  updateCommand: (id: string, patch: Partial<CommandInput> & { highlighted?: boolean }): Promise<ProjectCommand> =>
    request(`/api/commands/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteCommand: (id: string): Promise<void> => request(`/api/commands/${id}`, { method: 'DELETE' }),

  /** `workflowRunId` runs it in that WorkflowRun's working copy (its Quick look) instead of the project's folder. */
  runCommand: (id: string, workflowRunId?: string): Promise<CommandRun> =>
    request(`/api/commands/${id}/run`, { method: 'POST', body: JSON.stringify(workflowRunId ? { workflowRunId } : {}) }),

  /** "Run a custom command and see the output right away" — a one-off shell command, never saved as a ProjectCommand unless the caller separately saves it via createCommand. `workflowRunId` works as for runCommand. */
  runAdHocCommand: (projectId: string, command: string, workflowRunId?: string): Promise<CommandRun> =>
    request(`/api/projects/${projectId}/commands/run-adhoc`, { method: 'POST', body: JSON.stringify(workflowRunId ? { command, workflowRunId } : { command }) }),

  stopCommandRun: (runId: string): Promise<CommandRun> => request(`/api/command-runs/${runId}/stop`, { method: 'POST' }),

  /** `status`, when given, narrows this to just runs currently in that state — see loadActiveCommandRuns in worldStore.ts for why (finding a project's still-running commands, e.g. a long-lived `npm run dev`, without pulling every past run's full output). */
  listCommandRuns: (projectId: string, status?: CommandRunStatus): Promise<CommandRun[]> =>
    request(`/api/projects/${projectId}/command-runs${status ? `?status=${status}` : ''}`),

  getCommandRun: (runId: string): Promise<CommandRun> => request(`/api/command-runs/${runId}`),

  /** A Project's failed command runs whose log nobody has opened yet (the 3D village's red machines). */
  listUnopenedCommandFailures: (projectId: string): Promise<CommandRun[]> =>
    request(`/api/projects/${projectId}/command-runs?failureUnopened=true`),

  /** Records that someone opened this run's log, clearing its unopened failure. */
  markCommandRunOpened: (runId: string): Promise<CommandRun> => request(`/api/command-runs/${runId}/opened`, { method: 'POST' }),

  // ---- Catalog: agents (Templates) and skills, backed by the daemon's repo-root catalog/ folder ----

  listCatalogAgents: (): Promise<CatalogAgent[]> => request('/api/catalog/agents'),
  getCatalogAgent: (id: string): Promise<CatalogAgent> => request(`/api/catalog/agents/${id}`),
  createCatalogAgent: (input: CreateCatalogAgentInput): Promise<CatalogAgent> =>
    request('/api/catalog/agents', { method: 'POST', body: JSON.stringify(input) }),
  updateCatalogAgent: (id: string, patch: UpdateCatalogAgentInput): Promise<CatalogAgent> =>
    request(`/api/catalog/agents/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCatalogAgent: (id: string): Promise<void> => request(`/api/catalog/agents/${id}`, { method: 'DELETE' }),
  setCatalogAgentEnabled: (id: string, enabled: boolean): Promise<CatalogAgent> =>
    request(`/api/catalog/agents/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  uploadCatalogAgentFile: async ({ file, ...meta }: UploadCatalogAgentInput): Promise<CatalogAgent> =>
    request('/api/catalog/agents/upload', { method: 'POST', body: JSON.stringify({ ...meta, contentBase64: await toBase64(file) }) }),

  listCatalogSkills: (): Promise<CatalogSkill[]> => request('/api/catalog/skills'),
  getCatalogSkill: (id: string): Promise<CatalogSkill> => request(`/api/catalog/skills/${id}`),
  createCatalogSkill: (input: CreateCatalogSkillInput): Promise<CatalogSkill> =>
    request('/api/catalog/skills', { method: 'POST', body: JSON.stringify(input) }),
  updateCatalogSkill: (id: string, patch: UpdateCatalogSkillInput): Promise<CatalogSkill> =>
    request(`/api/catalog/skills/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCatalogSkill: (id: string): Promise<void> => request(`/api/catalog/skills/${id}`, { method: 'DELETE' }),
  setCatalogSkillEnabled: (id: string, enabled: boolean): Promise<CatalogSkill> =>
    request(`/api/catalog/skills/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  uploadCatalogSkillZip: async ({ file, ...meta }: UploadCatalogSkillInput): Promise<CatalogSkill> =>
    request('/api/catalog/skills/upload', { method: 'POST', body: JSON.stringify({ ...meta, contentBase64: await toBase64(file) }) }),
  addCatalogSkillFile: async (id: string, name: string, file: Blob): Promise<CatalogSkill> =>
    request(`/api/catalog/skills/${id}/files`, { method: 'POST', body: JSON.stringify({ name, contentBase64: await toBase64(file) }) }),
  removeCatalogSkillFile: (id: string, name: string): Promise<CatalogSkill> =>
    request(`/api/catalog/skills/${id}/files/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  /**
   * Kicks off `npx skills add <owner/repo>` on the daemon (server/src/catalog/skillInstall.ts) and
   * returns the new run right away, same "optimistic, return what you started" contract as
   * runCommand. Its running/log/settled updates then arrive live over the same /ws connection as
   * everything else — see the WorkerEvent union's 'skillInstall'/'skillInstallLog' cases and
   * worldStore.ts's mergeWorkerEvent — this being a background daemon process, not session-bound
   * (docs/architecture.md#background-daemon-not-session-bound), same as CommandRun.
   */
  installCatalogSkill: (repo: string): Promise<SkillInstallRun> =>
    request('/api/catalog/skills/install', { method: 'POST', body: JSON.stringify({ repo }) }),
  /** The run's state as of right now — for a client that opens after the run already started and missed its WS events. */
  getCatalogSkillInstallRun: (runId: string): Promise<SkillInstallRun> => request(`/api/catalog/skills/install/${runId}`),

  // ---- Catalog: Workflows (task 3.012) — an ordered list of Steps a Project's Tasks run through ----

  listCatalogWorkflows: (): Promise<WorkflowRecord[]> => request('/api/catalog/workflows'),
  getCatalogWorkflow: (id: string): Promise<WorkflowRecord> => request(`/api/catalog/workflows/${id}`),
  createCatalogWorkflow: (input: WorkflowInput): Promise<WorkflowRecord> =>
    request('/api/catalog/workflows', { method: 'POST', body: JSON.stringify(input) }),
  updateCatalogWorkflow: (id: string, patch: UpdateWorkflowInput): Promise<WorkflowRecord> =>
    request(`/api/catalog/workflows/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCatalogWorkflow: (id: string): Promise<void> => request(`/api/catalog/workflows/${id}`, { method: 'DELETE' }),

  /** Sets (or, with `workflowId: null`, resets to the Catalog default) which Workflow a Project's Tasks run through. */
  setProjectWorkflow: (projectId: string, workflowId: string | null): Promise<ServerProject> =>
    request(`/api/projects/${projectId}/workflow`, { method: 'PATCH', body: JSON.stringify({ workflowId }) }),

  // ---- Workflow runs (task 3.012): one run per executed PlanItem, its Steps' full round history, and its approval/loop/stop actions ----

  listWorkflowRunsForProject: (projectId: string): Promise<WorkflowRunRecord[]> => request(`/api/projects/${projectId}/workflow-runs`),
  getWorkflowRunDetail: (runId: string): Promise<WorkflowRunDetail> => request(`/api/workflow-runs/${runId}`),
  approveWorkflowRun: (runId: string, comment?: string): Promise<WorkflowRunRecord> =>
    request(`/api/workflow-runs/${runId}/approve`, { method: 'POST', body: JSON.stringify({ comment }) }),
  requestChangesWorkflowRun: (runId: string, comment: string): Promise<WorkflowRunRecord> =>
    request(`/api/workflow-runs/${runId}/request-changes`, { method: 'POST', body: JSON.stringify({ comment }) }),
  decideWorkflowRunLoop: (runId: string, action: 'another-round' | 'continue', comment?: string): Promise<WorkflowRunRecord> =>
    request(`/api/workflow-runs/${runId}/loop`, { method: 'POST', body: JSON.stringify({ action, comment }) }),
  /** Saves a note for one step of a task (an empty note clears it); the server appends it to that step's input when it next starts. */
  setStepNote: (planItemId: string, stepId: string, note: string): Promise<unknown> =>
    request(`/api/plan-items/${planItemId}/step-notes/${stepId}`, { method: 'PUT', body: JSON.stringify({ note }) }),
  retryWorkflowStep: (runId: string): Promise<WorkflowRunRecord> => request(`/api/workflow-runs/${runId}/retry-step`, { method: 'POST' }),
  stopWorkflowRun: (runId: string): Promise<WorkflowRunRecord> => request(`/api/workflow-runs/${runId}/stop`, { method: 'POST' }),
  /** Resumes a `stopped` run's current step in its own session ("Continue."); 409 unless the run is stopped. */
  resumeWorkflowRun: (runId: string): Promise<WorkflowRunRecord> => request(`/api/workflow-runs/${runId}/resume`, { method: 'POST' }),

  /** `?resolved=`/`?read=`/`?severity=`/`?projectId=` narrow the listing — the Notifications drawer's source data (initial load; live updates arrive over `/ws` as 'notification' WorkerEvents). `projectId: 'none'` means the one project-less subject (a skill install). */
  listNotifications: (filter?: { resolved?: boolean; read?: boolean; severity?: NotificationSeverity; projectId?: string | 'none' }): Promise<ServerNotification[]> => {
    const params = new URLSearchParams();
    if (filter?.resolved !== undefined) params.set('resolved', String(filter.resolved));
    if (filter?.read !== undefined) params.set('read', String(filter.read));
    if (filter?.severity) params.set('severity', filter.severity);
    if (filter?.projectId) params.set('projectId', filter.projectId);
    const query = params.toString();
    return request(`/api/notifications${query ? `?${query}` : ''}`);
  },

  /** Marks exactly the given ids read. */
  markNotificationsRead: (ids: string[]): Promise<void> =>
    request('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) }),

  /** Marks every Notification matching this subject's identity (any kind) read. */
  markSubjectRead: (subject: NotificationSubject): Promise<void> =>
    request('/api/notifications/read', { method: 'POST', body: JSON.stringify({ subject }) }),

  markNotificationUnread: (id: string): Promise<void> => request(`/api/notifications/${id}/unread`, { method: 'POST' }),

  /** "Mark all as read" — marks read only what matches `filter` (the drawer's current filters). */
  markAllNotificationsRead: (filter: { resolved?: boolean; read?: boolean; severity?: NotificationSeverity; projectId?: string | 'none' } = {}): Promise<void> =>
    request('/api/notifications/read-all', { method: 'POST', body: JSON.stringify(filter) }),

  /**
   * Connects to the daemon's live event feed, and keeps reconnecting
   * (capped exponential backoff, 1s–15s) for as long as the caller hasn't
   * disposed it — the daemon can restart out from under an open tab (a dev
   * `node --watch` reload, or the machine sleeping/waking), and a socket
   * that silently stays dead makes the whole app look like it stopped
   * updating until the page is manually reloaded. `onReconnect`, if given,
   * fires once a *re*-connection actually opens (never the first one — the
   * caller already has fresh state from whatever it fetched right before
   * calling this), so it can re-sync anything it might have missed while
   * disconnected. `onDisconnect`, if given, fires from the socket's `'close'`
   * listener every time a live connection drops (mirroring `onReconnect`'s
   * `'open'`) — e.g. so the store can track a `wsConnected` flag for the
   * app-update reconnect banner. Returns a cleanup function that stops
   * reconnecting too.
   */
  connectLiveUpdates(onEvent: (event: WorkerEvent) => void, onReconnect?: () => void, onDisconnect?: () => void): () => void {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempt = 0;
    let hasConnectedBefore = false;

    function connect(): void {
      const wsUrl = baseUrl().replace(/^http/, 'ws') + '/ws';
      socket = new WebSocket(wsUrl);
      socket.addEventListener('open', () => {
        attempt = 0;
        liveSocket = socket;
        for (const { kind, runId } of watchedRuns.values()) sendWatch('watchRun', kind, runId);
        if (hasConnectedBefore) onReconnect?.();
        hasConnectedBefore = true;
      });
      socket.addEventListener('message', (message) => {
        try {
          onEvent(JSON.parse(message.data as string) as WorkerEvent);
        } catch {
          // Ignore a malformed frame rather than tearing down the whole connection over one bad message.
        }
      });
      socket.addEventListener('close', () => {
        if (stopped) return;
        onDisconnect?.();
        const delay = reconnectDelayMs(attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (liveSocket === socket) liveSocket = null;
      socket?.close();
    };
  },

  // ---- App update (task 7.001) ----

  getAppUpdate: (): Promise<AppUpdateStatus> => request('/api/app-update'),
  /** Forces an immediate re-check; always allowed, any mode/phase. */
  checkAppUpdateNow: (): Promise<AppUpdateStatus> => request('/api/app-update/check', { method: 'POST' }),
  /**
   * Starts a web-only update right away, or moves a server-touching one to `'held'` (waiting for
   * idle). Also what the popover's "Retry" button calls after a failed apply — there's no separate
   * retry endpoint. 409 if already held/updating; 400 if not updatable for any other reason.
   */
  applyAppUpdate: (): Promise<AppUpdateStatus> => request('/api/app-update/apply', { method: 'POST' }),
  /** A no-op success (200, not 409) when nothing is held. */
  cancelAppUpdate: (): Promise<AppUpdateStatus> => request('/api/app-update/cancel', { method: 'POST' }),
};
