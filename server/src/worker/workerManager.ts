import { runCodexTurn } from './codexProcess.ts';
import { summarizeProgress, trimShortLabel } from './stepProgress.ts';
import {
  addWorktree, addWorktreeForBranch, restoreWorktreeForBranch, taskBranchExists, currentBranch, commitAndPush, commitAndPushHeadTo, git, isOwnGitRepo, removeWorktree, withProjectLock,
  diffStat, diffNameStatus, diffForFile, ghPrCreate, ghPrViewForBranch, localBranchExists, workingTreeChanges,
} from '../projects/git.ts';
import { redactSecrets } from '../redaction.ts';
import { githubSessionEnv, withProjectGithub } from '../github/accounts.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { tasksDb, taskContextsDb, planItemQueueDb, workflowRunsDb, stepRunsDb, testRunsDb, planItemsDb } from '../db/collections.ts';
import { getProject, patchProjectWith, projectAbsolutePath, projectWorktreePath, taskWorkingDirectory } from '../projects/projectService.ts';
import { getDefaultAgent, getAgent, readAgentPersona, listSkills, readSkillBody, AgentNotFoundError, SkillNotFoundError } from '../catalog/catalogService.ts';
import { WorkflowNotFoundError, getWorkflow, getDefaultWorkflow, NoWorkflowAvailableError, resolveWorkflowForProject, snapshotWorkflow } from '../catalog/workflowService.ts';
import { withOwnership } from '../buildings/ownership.ts';
import { assertWritable } from '../buildings/normalize.ts';
import { primarySlotWorkflow, slotWorkflow, withStepAgents } from '../buildings/slotConfig.ts';
import { CATALOG_DIR, PROJECTS_DIR } from '../config.ts';
import { preloadSkillsProblem } from '../catalog/skillPreload.ts';
import { ExecutorNotFoundError, getDefaultExecutor, getExecutor, listExecutors } from '../executors/executorService.ts';
import { PLAN_DISALLOWED_TOOLS, PLAN_INSTRUCTIONS, buildPlanInstructions } from '../projects/plan.ts';
import type { PlanningTaskDraft } from '../projects/plan.ts';
import {
  PlanItemCompletedError, PlanItemHasActiveTaskError, PlanItemNotCompletableError, PlanItemNotFoundError, archivePlanItem as archivePlanItemRecord,
  comparePlanningGroupOrder, completePlanItem as completePlanItemRecord, createPlanItem, createPlanningPlanItem, deletePlanItem as deletePlanItemRecord,
  deletePlanningPlanItem, editPlanningPlanItem, getPlanItem, listPlanItems, readPlanItem, updatePlanItem,
} from '../projects/planItemService.ts';
import {
  BugNotPlanningTaskError, appendRegression, assertRegressionReportable, bugGroupId, isBug, isReadyBug, linkedSessionNumber, parseRegressionReason, regressionRoundOffsets,
} from '../projects/bugs.ts';
import { BUG_REPORT_INSTRUCTIONS, PLAN_AND_BUGS_INSTRUCTIONS, bugReportMcpServer, planAndBugsMcpServer } from '../terminal/bugReportTool.ts';
import { isBugReportSession, isPlanAndBugsSession } from '../projects/sessionKinds.ts';
import { TaskNotBugFilingSessionError, createBugTracker } from './bugTracker.ts';
import { isActive as isTestRunActive, testRunner as defaultTestRunner } from '../testing/testRunner.ts';
import type { TestRunEvent } from '../testing/testRunner.ts';
import { runClaudeTurn as runClaudeTurnDefault } from './claudeProcess.ts';
import type { ClaudeTurnResult, StreamJsonEvent } from './claudeProcess.ts';
import type {
  Autonomy, BugRegression, BugRegressionReporter, ExecutorProfile, NotificationKind, NotificationSubject, PlanItemQueueEntry, PlanItemRecord, ProjectRecord, PullRequestConflictOutcome,
  PullRequestConflictTarget, RunStartup, RunStartupStepId, SkillRecord, StepProgressItem,
  StepProgressSummary, StepRunOutput, StepRunProgress, StepRunRecord, StepRunStatus, TaskKind, TaskRecord, TaskTurn, TemplateRecord, TerminalRuntimeStatus, TestRunRecord,
  TokenUsage, WorkflowRecord, WorkflowRunRecord, WorkflowStep,
} from '../domain/types.ts';
import { ZERO_TOKEN_USAGE } from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { terminalSessionManager, type TerminalSessionHost } from '../terminal/terminalSessionManager.ts';
import {
  ProjectFolderBusyError, UNSETTLED_RUN_STATUSES, activeTaskIdsOf, assertProjectFolderFree, isActiveTask, isProjectFolderBusy, isLiveTask, liveTasksOf, type SessionRegistry,
} from './projectFolderGuard.ts';
import { ensureProjectCliHooks } from '../terminal/projectCliHooks.ts';
import { capabilityMcpServer } from '../terminal/capabilityTool.ts';
import { connections } from '../connections/index.ts';
import { planTaskMcpServer } from '../terminal/planTaskTool.ts';
import { stepTaskMcpServer } from '../terminal/stepTaskTool.ts';
import { TESTING_TOOL_INSTRUCTIONS, testTaskMcpServer } from '../terminal/testTaskTool.ts';
import type { McpServerLaunch } from '../terminal/mcpServers.ts';
import {
  buildChangesRequestedMessage, buildRegressionMessage, buildRerunMessage, buildReviewFixMessage, buildStepPrompt,
  type PlanningGapNote, type StagePromptHistory, type StepHistoryRound,
} from './workflowPrompt.ts';
import { appendStepNote, assertStepId, keepStepNotesFor, parseStepNote, StepNoteValidationError, withStepNote } from '../projects/stepNotes.ts';
import { stepOutputFiles as defaultStepOutputFiles, type StepOutputFiles } from './stepOutputFiles.ts';
import { SKIPPED_AT_START_REASON, resolveSkippedStepIds } from './stepSelection.ts';
import { summarizeWorkflowRun, stitchFallbackSummary, buildCompletionReport, buildPrBody } from './workflowSummarizer.ts';
import { resolveBranchName } from '../projects/branchName.ts';
import {
  beginStartupStep, currentStartupStep, failStartupStep, finishStartupStep, isStartupIncomplete,
  normalizeStartup, planStartup, resetStartup, startupKindOf, type StartupKind,
} from './runStartup.ts';
import type { BackgroundTurnTracker } from '../analytics/activityRecorder.ts';
import { trackBackgroundTurn } from '../analytics/index.ts';
import { getExecutorLimits } from '../executors/claudeUsage.ts';
import { loadTestingConfig } from '../testing/config.ts';
import {
  SETUP_IMPLEMENTATION_STEP_ID, SETUP_PROPOSAL_STEP_ID, SETUP_TITLES, assertSetupWorkflowSafe, evaluateSetupEvidence,
  setupModeFor, setupPlanItemDescription, testingSetupWorkflow,
} from '../testing/setup.ts';
import { named, namedAtStart } from '../domain/displayName.ts';
import { conflictPlanItemDescription, conflictResolutionWorkflow, conflictRunBranch, conflictRunTitle } from './conflictResolution.ts';
import {
  MAX_CONCURRENT_TASKS_PER_PROJECT, SessionStillRunningError, TaskConflictError, TaskLimitReachedError, type SlotOccupant,
} from './taskConflicts.ts';
import { fetchPullRequestHead, mergePullRequest, readPullRequest } from '../projects/pullRequestActions.ts';
import { classifyMergeState } from '../projects/pullRequestMerge.ts';
import type { PullRequestReading } from '../projects/pullRequestMerge.ts';

export { TaskConflictError, TaskLimitReachedError, SessionStillRunningError };

export class TaskNotFoundError extends Error {
  constructor() {
    super('This task no longer exists — it may have been deleted');
    this.name = 'TaskNotFoundError';
  }
}

/** `name` is the Task's human name for the message — see `taskName`; unknown falls back to generic wording. */
export class TaskNotBlockedError extends Error {
  constructor(name?: string) {
    super(`${namedAtStart('task', name)} is not blocked, so there's nothing to answer`);
    this.name = 'TaskNotBlockedError';
  }
}

export class TaskNotFollowableError extends Error {
  constructor(name?: string) {
    super(`${namedAtStart('task', name)} is still active — answer it (if blocked) or stop it (if developing) instead of a follow-up`);
    this.name = 'TaskNotFollowableError';
  }
}

export class PlanningSessionArchivedError extends Error {
  constructor() {
    super('Restore this completed planning session from Archived before resuming it');
    this.name = 'PlanningSessionArchivedError';
  }
}

export class TerminalSessionNotResumableError extends Error {
  constructor(name?: string) {
    super(`${namedAtStart('task', name)} ended before its CLI session id was recorded, so this older terminal session cannot be resumed in-app`);
    this.name = 'TerminalSessionNotResumableError';
  }
}

export class TaskNotPlanningSessionError extends Error {
  constructor() {
    super('This session is not a running planning session, so it cannot manage tasks');
    this.name = 'TaskNotPlanningSessionError';
  }
}

/** A bug report session's description or agent was changed after its CLI had already started. */
export class SessionAlreadyStartedError extends Error {
  constructor() {
    super('This session has already started, so its description and coding agent can no longer be changed');
    this.name = 'SessionAlreadyStartedError';
  }
}

export class PlanningQueueConflictError extends Error {
  constructor() {
    super('The Planning queue changed — reload and try reordering again');
    this.name = 'PlanningQueueConflictError';
  }
}

export class TaskNotTerminalError extends Error {
  constructor(name?: string) {
    super(`${namedAtStart('task', name)} is not an interactive CLI task, so it cannot be resumed without an instruction`);
    this.name = 'TaskNotTerminalError';
  }
}

export class TaskNotPausedError extends Error {
  constructor(name?: string) {
    super(`${namedAtStart('task', name)} is not a paused interactive CLI task, so there's nothing to mark completed`);
    this.name = 'TaskNotPausedError';
  }
}

export class TaskNotInterimCommittableError extends Error {
  constructor(name?: string) {
    super(`${namedAtStart('task', name)} is not an ongoing task on a repository branch, so there's nothing to commit`);
    this.name = 'TaskNotInterimCommittableError';
  }
}

type NamedExecutor = Pick<ExecutorProfile, 'label' | 'kind'>;

export class ExecutorNotSupportedError extends Error {
  constructor(executor: NamedExecutor) {
    super(`${namedAtStart('executor', executor.label)} (${executor.kind}) cannot run this kind of Task`);
    this.name = 'ExecutorNotSupportedError';
  }
}

/** Planning runs only in an interactive CLI (claude-cli / codex-cli) — its tasks are managed live through the session's MCP tools. */
export class PlanningRequiresCliError extends Error {
  constructor(executor: NamedExecutor) {
    super(`${namedAtStart('executor', executor.label)} (${executor.kind}) is not an interactive CLI, so it cannot run a planning session`);
    this.name = 'PlanningRequiresCliError';
  }
}

export class PlanItemQueueEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`No queued plan-item execution with id "${id}" — it may have already started or been removed`);
    this.name = 'PlanItemQueueEntryNotFoundError';
  }
}

/** Re-exported for existing callers (api/router.ts's error-to-status mapping, tests) — see `projectFolderGuard.ts`'s doc comment for where this now lives and who else throws it. */
export { ProjectFolderBusyError };

/** `createBranch: true` on a Project with no linked repository — there's no git repo to branch. */
export class BranchRequiresRepositoryError extends Error {
  constructor(project: Pick<ProjectRecord, 'name'>) {
    super(`Project "${project.name}" has no linked repository, so a task can't be started on a new branch`);
    this.name = 'BranchRequiresRepositoryError';
  }
}

export class TemplateDisabledError extends Error {
  constructor(template: Pick<TemplateRecord, 'name'>) {
    super(`${namedAtStart('agent', template.name)} is disabled in the Catalog and can't be assigned to a new Task`);
    this.name = 'TemplateDisabledError';
  }
}

export class InvalidPreloadSkillsError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'InvalidPreloadSkillsError';
  }
}

export class SkillDisabledError extends Error {
  constructor(skill: Pick<SkillRecord, 'name'>) {
    super(`${namedAtStart('skill', skill.name)} is disabled in the Catalog and can't be assigned to a new Task`);
    this.name = 'SkillDisabledError';
  }
}

export class WorkflowRunNotFoundError extends Error {
  constructor() {
    super('This workflow run no longer exists');
    this.name = 'WorkflowRunNotFoundError';
  }
}

/** Thrown by an approval/loop/retry/stop action that doesn't fit the run's current status — e.g. approving a run that isn't `awaiting-approval`. `taskTitle` is the run's PlanItem title (see `runNotActionable`). */
export class WorkflowRunNotActionableError extends Error {
  constructor(taskTitle: string | undefined, action: string, status: string) {
    super(`The workflow of ${named('task', taskTitle)} cannot ${action} while its status is "${status}"`);
    this.name = 'WorkflowRunNotActionableError';
  }
}

/** The testing relay's (`/api/agent-testing`) equivalent of `TaskNotPlanningSessionError`: only a currently active coding Task that may edit code can run its Project's configured tests. */
export class TaskNotTestingSessionError extends Error {
  constructor(id: string) {
    super(`Task "${id}" is not an active coding session, so it cannot run tests`);
    this.name = 'TaskNotTestingSessionError';
  }
}

/** Settled rounds cannot complete or skip; their live reopened sessions can still read the diff. */
export class TaskNotWorkflowStepError extends Error {
  constructor() {
    super('This session is not a running workflow step session');
    this.name = 'TaskNotWorkflowStepError';
  }
}

/** A testing-setup step tried something its safety rules forbid (skipping, an empty proposal, finishing without evidence) — the message tells the agent what to do instead. */
export class TestingSetupStepRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestingSetupStepRefusedError';
  }
}

/** `skip_step` on a step whose run exists only to do that step (a conflict-resolution run). */
export class StepNotSkippableError extends Error {
  constructor(stepName: string) {
    super(`"${stepName}" can't be skipped — call complete_step instead, or stop and say why you can't finish.`);
    this.name = 'StepNotSkippableError';
  }
}

/** A testing-setup run was asked to do something only its own approval action may do, or an approval named a proposal round that isn't the one awaiting a decision. */
export class TestingSetupApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestingSetupApprovalError';
  }
}

/** What starting (or finding) a Project's testing setup returns — see `startTestingSetup`. */
export interface TestingSetupStartResult {
  /** True when an active or queued setup already existed and was returned instead of a new one. */
  existing: boolean;
  planItem: PlanItemRecord;
  run: WorkflowRunRecord | null;
  queueEntry: PlanItemQueueEntry | null;
}

/** A step conversation cannot be reopened or its pending changes resolved; `reason` finishes the sentence. */
export class StepInspectSessionError extends Error {
  constructor(name: string | undefined, reason: string) {
    super(`${namedAtStart('task', name)} ${reason}`);
    this.name = 'StepInspectSessionError';
  }
}
/** The Software Building Type's slot whose workflow a bug starts with — see buildings/types/software.ts. */
const BUG_WORKFLOW_SLOT_ID = 'bug';

/** One top-level Planning entry in a reorder request: a session, a standalone task or bug, or an introducing-task card. */
export interface PlanningQueueEntryRef {
  kind: 'session' | 'task' | 'reference';
  id: string;
}

export type WorkerEvent =
  | { type: 'project'; project: ProjectRecord }
  | { type: 'projectDeleted'; projectId: string }
  | { type: 'task'; task: TaskRecord }
  | { type: 'taskDeleted'; id: string; projectId: string }
  | { type: 'log'; taskId: string; turn: TaskTurn }
  | { type: 'planItem'; planItem: PlanItemRecord }
  | { type: 'planItemDeleted'; id: string; projectId: string }
  | { type: 'planItemQueue'; projectId: string; entries: PlanItemQueueEntry[] }
  | { type: 'planningCompletionError'; projectId: string; session: number; message: string }
  | { type: 'workflowRun'; run: WorkflowRunRecord }
  | { type: 'workflowRunDeleted'; runId: string; projectId: string }
  | { type: 'stepRun'; stepRun: StepRunRecord };

type PlanItemExecutionResult =
  | { started: true; run: WorkflowRunRecord }
  | { started: false; entry: PlanItemQueueEntry };

/** How `POST /api/plan-items/:id/execute` starts a PlanItem — see `executePlanItem`. */
export interface StartPlanItemOptions {
  /** The run's executor (any step that doesn't pick its own uses it). */
  executorId?: string;
  /** The Catalog Workflow to run; defaults to the Project's resolved one. */
  workflowId?: string;
  /** A dedicated worktree on a new branch (true), or the Project's own folder and branch (false). Defaults to true for a Project with a repository, false otherwise. */
  createBranch?: boolean;
  /** Steps of that Workflow left out of this run (the Start task dialog's unchecked steps) — see `resolveSkippedStepIds`. Ignored for a testing setup. */
  skippedStepIds?: string[];
  /** An already-resolved Workflow to run as given, in place of a Catalog lookup: a scheduled job's single-prompt workflow, or a slot's workflow with the job's approval gate applied (scheduler/runStarter.ts). */
  workflow?: WorkflowRecord;
  /** Set only by `reopenBug`: this start is a completed bug's round 2 — a fresh branch, the new regression recorded on the bug as the start is accepted, and the earlier rounds' numbers carried forward. */
  regression?: { entry: BugRegression; roundOffsets: Record<string, number> };
}

type Listener = (event: WorkerEvent) => void;

/** A run's in-flight start-up: `cancel` stops it at its next step boundary; `settled` resolves once it has finished or cleaned up. */
interface StartupHandle {
  cancelled: boolean;
  cancel: () => void;
  onCancel: Promise<void>;
  settled: Promise<void>;
}

export interface WorkerManagerDeps {
  /**
   * Every Task now runs via the interactive-CLI path (`runTerminalTask`/`terminalSessions` below) —
   * this is only still reachable from one internal "run one throwaway turn" primitive unrelated to
   * any Task executor: the Complete stage's headless summarizer turn
   * (`completeWorkflowRun`/`worker/workflowSummarizer.ts`). Optional (defaults to the real CLI)
   * so a test that never drives it doesn't need to supply one.
   */
  runClaudeTurn?: typeof runClaudeTurnDefault;
  runCodexTurn?: typeof runCodexTurn;
  /** Injectable PTY host for interactive CLI Tasks. */
  terminalSessions?: TerminalSessionHost;
  /**
   * Used by the Complete stage's headless summarizer turn to pick which executor runs it (see `executors/leastUsedExecutor.ts`). Injectable so tests
   * never trigger the real `listExecutors`/`getExecutorLimits` — the latter shells out to the OS
   * keychain per executor, which is both slow and a real side effect no test should depend on.
   */
  listExecutors?: typeof listExecutors;
  getExecutorLimits?: typeof getExecutorLimits;
  /** The git writes a Task/WorkflowRun makes in its working directory — injectable so a test can assert what was committed where without a real repository or remote. */
  commitAndPush?: typeof commitAndPush;
  removeWorktree?: typeof removeWorktree;
  /** Where step outputs are saved for later steps' prompts — injectable so a test can make writes fail. */
  stepOutputFiles?: StepOutputFiles;
  /** How a conflict-resolution run waits for the provider to recompute a PR's merge state after its push — see `recheckPullRequest`. Overridable so tests don't wait. */
  pullRequestRecheck?: { attempts: number; delayMs: number };
  /** Records the Complete-stage summarizer turn as background work. Absent, it runs unrecorded. */
  trackBackgroundTurn?: BackgroundTurnTracker;
  /**
   * The slow, fallible steps of a run's start-up, injectable so a test can delay, gate or fail each
   * one: the worktree creation, and the CLI hook install.
   */
  addWorktree?: typeof addWorktree;
  addWorktreeForBranch?: typeof addWorktreeForBranch;
  ensureCliHooks?: typeof ensureProjectCliHooks;
  fetchPullRequestHead?: typeof fetchPullRequestHead;
  /** Subscribes to Test Run events — injectable so a test can drive run completions without a real runner. */
  onTestEvent?: (listener: (event: TestRunEvent) => void) => () => void;
  /** How long after an awaited Test Run ends the CLI may stay silent before the deferred turn-end wait is surfaced (`TEST_RUN_GRACE_MS`). */
  testRunGraceMs?: number;
}

/** Runtime reason shown while a turn-end is held back because the agent is waiting on a Test Run it started. */
export const WAITING_ON_TEST_RUN = 'Waiting on a test run';
/** After an awaited Test Run ends, how long the CLI may stay idle before its deferred turn-end wait is surfaced. */
export const TEST_RUN_GRACE_MS = 60_000;
/** A Test Run that ended this recently still covers a turn-end, since its `Stop` hook can land just after the run settles. */
export const RECENT_COMPLETION_MS = 5_000;
/** Most recent awaited Test Run ids kept on a Task. */
const MAX_AWAITED_TEST_RUNS = 20;

/**
 * Whether a turn-end hook (`Stop`, or a `Notification` of type `idle_prompt`) only means the agent
 * is waiting for a Test Run its own testing tool handed back, not for a person. Approval and input
 * requests are never covered.
 */
export function isTurnEndCoveredByTestRun(
  event: Record<string, unknown>,
  awaitedRunIds: readonly string[] | undefined,
  runs: readonly Pick<TestRunRecord, 'id' | 'status' | 'completedAt'>[],
  now = Date.now(),
  recentMs = RECENT_COMPLETION_MS,
): boolean {
  const name = String(event.hook_event_name ?? '');
  const notificationType = String(event.notification_type ?? event.type ?? '');
  const turnEnd = name === 'Stop' || (name === 'Notification' && notificationType === 'idle_prompt');
  if (!turnEnd || !awaitedRunIds?.length) return false;
  return runs.some((run) => {
    if (!awaitedRunIds.includes(run.id)) return false;
    if (run.status === 'queued' || run.status === 'running') return true;
    return run.completedAt !== null && now - Date.parse(run.completedAt) <= recentMs;
  });
}

/**
 * Builds one Worker orchestrator: the piece that turns a start-task/answer
 * call into a real `claude -p` turn and keeps the file-based database and
 * subscribed listeners (the WS layer) in sync with the outcome. A factory
 * rather than a module of loose functions so tests can swap in a fake
 * `runClaudeTurn` — see tests/workerManager.test.ts.
 */
export function createWorkerManager(deps: WorkerManagerDeps = {}) {
  const listeners = new Set<Listener>();
  const terminalSessions = deps.terminalSessions ?? terminalSessionManager;
  const pushTaskBranch = deps.commitAndPush ?? commitAndPush;
  /** Commits and pushes as the project's GitHub account (the machine default when it has none). */
  const commitWork = (project: ProjectRecord, cwd: string, branch: string, message: string) =>
    withProjectGithub(project, 'commit and push the task branch', () => pushTaskBranch(cwd, branch, message));
  const removeRunWorktree = deps.removeWorktree ?? removeWorktree;
  const createWorktree = deps.addWorktree ?? addWorktree;
  const createWorktreeForBranch = deps.addWorktreeForBranch ?? addWorktreeForBranch;
  const installCliHooks = deps.ensureCliHooks ?? ensureProjectCliHooks;
  const fetchPrHead = deps.fetchPullRequestHead ?? fetchPullRequestHead;
  const outputFiles = deps.stepOutputFiles ?? defaultStepOutputFiles;
  /** User-requested stops are expected control flow, not Worker failures. */
  const stoppedTasks = new Set<string>();
  const abortedStartTasks = new Set<string>();
  /** Step Task ids whose settled CLI session is reopened ad hoc for inspection — see `reopenStepSession`. */
  const inspectSessions = new Set<string>();
  const inspectSessionModes = new Map<string, 'permissions' | 'read-only'>();
  const inspectSessionTesting = new Set<string>();
  const settlingInspectRuns = new Set<string>();
  const completedInspectOwners = new Map<string, string>();
  /** A CLI conversation may have many Task records, but only one live process. */
  const conversationOwners = new Map<string, string>();
  const conversationExitWaiters = new Map<string, Set<() => void>>();

  function claimConversation(sessionId: string | null | undefined, taskId: string): void {
    if (!sessionId) return;
    if (conversationOwners.has(sessionId)) throw new Error('This CLI conversation already has a live process');
    conversationOwners.set(sessionId, taskId);
  }

  function releaseConversation(sessionId: string | null | undefined, taskId: string): void {
    if (sessionId && conversationOwners.get(sessionId) === taskId) conversationOwners.delete(sessionId);
    for (const done of conversationExitWaiters.get(taskId) ?? []) done();
    conversationExitWaiters.delete(taskId);
  }

  function waitForConversationExit(taskId: string): Promise<void> {
    if (![...conversationOwners.values()].includes(taskId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = conversationExitWaiters.get(taskId) ?? new Set<() => void>();
      waiters.add(resolve);
      conversationExitWaiters.set(taskId, waiters);
    });
  }
  /** Serializes a planning session's task changes per Project, so concurrent `create_task` calls can't pick the same task number — see `requirePlanningSession`. */
  const planningLocks = new Map<string, Promise<unknown>>();
  /** Serializes human decisions (approve, request changes, loop, retry, stop) per WorkflowRun — see `withRunLock`. */
  const runLocks = new Map<string, Promise<unknown>>();
  /** Serializes the testing-setup queue per Project. */
  const queueLocks = new Map<string, Promise<unknown>>();
  /** Serializes testing-setup starts per Project, so a double click finds the first click's setup — see `startTestingSetup`. */
  const setupLocks = new Map<string, Promise<unknown>>();
  /** Serializes conflict-run starts per pull request, so two Merge clicks can't both create a run. */
  const conflictLocks = new Map<string, Promise<unknown>>();
  /** Serializes branch naming plus worktree creation per Project, so two starts can't pick the same new branch name or race inside one repository. */
  const repoLocks = new Map<string, Promise<unknown>>();
  /** The in-flight start-up of each run, by run id — see `launchStartup`. */
  const startups = new Map<string, StartupHandle>();
  /** The latest start-up per PlanItem, so a new start of the same item waits for the previous one's cleanup. */
  const startupTails = new Map<string, Promise<void>>();
  const pullRequestRecheck = deps.pullRequestRecheck ?? { attempts: 15, delayMs: 2_000 };

  function onWorkerEvent(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Publishes an event. A plan item goes out as every read returns it, with its type and readable bug attributes. */
  function emit(event: WorkerEvent): void {
    const published = event.type === 'planItem' ? { ...event, planItem: readPlanItem(event.planItem) } : event;
    for (const listener of listeners) listener(published);
  }

  /**
   * A Task's `task.*` Notification identity (docs/milestones/milestone-5-notification-system.md): a
   * conversation — a Task and every follow-up/resume `continueTask` ever creates from it — is keyed
   * by `conversationId ?? id`, so raising/resolving against whichever Task is currently live always
   * lands on the one Notification for the whole chain. `taskId` is just the latest attempt, for the
   * deep link — see NotificationSubject's doc comment.
   */
  function taskSubject(task: TaskRecord): NotificationSubject {
    return { type: 'task', projectId: task.projectId, conversationId: task.conversationId ?? task.id, taskId: task.id };
  }

  /** Resolves `kinds` of `task.*` Notifications for `task`'s conversation — see `taskSubject`. */
  function resolveTaskNotifications(task: TaskRecord, kinds: NotificationKind[]): Promise<void> {
    return resolveNotifications(taskSubject(task), kinds);
  }

  /**
   * Resolves every `task.*` Notification for a whole conversation's `members` (every Task
   * `archiveSession`/`deleteSession` act on) — looping per member rather than computing one shared
   * identity, since a conversation's very first Task (before any follow-up) and its later follow-ups
   * can resolve to two different `conversationId`s (the first has none yet, so it falls back to its
   * own id; a follow-up inherits whatever `continueTask` recorded) and either could still hold an
   * open Notification.
   */
  async function resolveSessionNotifications(members: TaskRecord[]): Promise<void> {
    for (const member of members) await resolveTaskNotifications(member, ['task.needs_input', 'task.failed', 'task.completed']);
  }

  async function startTask(input: {
    projectId: string;
    description: string;
    templateId?: string;
    /** Catalog Skills attached to the Worker's session, on demand unless in `preloadSkillIds` — see TaskRecord.skillIds and buildAppendSystemPrompt below. Each must reference an existing, enabled Skill. */
    skillIds?: string[];
    /** The subset of `skillIds` to load in full every run; the rest are on demand — see TaskRecord.preloadSkillIds. */
    preloadSkillIds?: string[];
    executorId?: string;
    autonomy?: Autonomy;
    /** 'execute' (default) is real coding work; 'plan' is the workspace chat's restricted planning mode — see domain/types.ts's TaskKind. */
    kind?: TaskKind;
    /** Set when this Task runs one Tasks-breakdown PlanItem (POST /api/plan-items/:id/execute) — see projects/planItemService.ts. */
    planItemId?: string | null;
    /** Makes a 'plan'-kind session a plan-and-bugs (or earlier bug report) session — see TaskRecord.planningPurpose. */
    planningPurpose?: TaskRecord['planningPurpose'];
    /** Creates the session without a CLI, for when no coding agent is available: `launchDeferredSession` starts it later. */
    deferCli?: boolean;
  }): Promise<TaskRecord> {
    return withProjectLock(input.projectId, async () => {
      const project = await getProject(input.projectId);
      const sharedTaskCount = await claimConcurrencySlot(project, input.kind ?? 'execute', terminalSessions);

      if (input.planItemId) await getPlanItem(input.planItemId); // 404s if the referenced item doesn't exist

      const planning = input.kind === 'plan';

      // No explicit templateId falls back to the Catalog's default — getDefaultAgent() only ever
      // returns an enabled agent, so the `enabled` check below only applies when a templateId was
      // actually chosen.
      const template = input.templateId ? await getAgent(input.templateId) : await getDefaultAgent();
      if (!template) throw new AgentNotFoundError();
      if (input.templateId && !template.enabled) throw new TemplateDisabledError(template);
      const autonomy = input.autonomy ?? template.defaultAutonomy;

      const skillIds = input.skillIds;
      const preloadProblem = preloadSkillsProblem(skillIds, input.preloadSkillIds);
      if (preloadProblem) throw new InvalidPreloadSkillsError(preloadProblem);
      await assertSkillsUsable(skillIds);

      const executor = input.deferCli ? null : await resolveStartExecutor(input.executorId, planning);
      const executionMode = 'terminal' as const;

      const taskId = randomUUID();
      const workspace = await assignTaskWorkspace(project, taskId, sharedTaskCount);

      const now = new Date().toISOString();
      const task: TaskRecord = {
        id: taskId,
        projectId: project.id,
        templateId: template.id,
        skillIds,
        ...(input.preloadSkillIds?.length ? { preloadSkillIds: input.preloadSkillIds } : {}),
        executorId: executor?.id ?? '',
        executionMode,
        description: input.description,
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
        // A session with no CLI yet is settled, not running: nothing is live and a restart leaves it alone.
        status: executor ? 'developing' : 'stopped',
        ...(executor ? {} : { cliNotStarted: true }),
        ...(input.planningPurpose ? { planningPurpose: input.planningPurpose } : {}),
        autonomy,
        manager: template.manager,
        kind: input.kind ?? 'execute',
        planItemId: input.planItemId ?? null,
        ...(planning ? {
          planningSessionNumber: await nextPlanningSessionNumber(project.id),
          planningQueueOrder: -Date.now(),
          planningCompletedAt: null,
          planningCreatedTaskCount: 0,
          planningAutoCompleteArmed: false,
        } : {}),
        sessionId: null,
        ...(executor ? { runtimeStatus: 'starting' as const } : {}),
        runtimeWaitingReason: null,
        runtimeStatusChangedAt: now,
        blockedQuestion: null,
        failureReason: null,
        tokenUsage: ZERO_TOKEN_USAGE,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      await tasksDb.insert(withOwnership(task));
      await taskContextsDb.insert({ id: task.id, taskId: task.id, turns: [] });
      if (!executor) {
        emit({ type: 'task', task });
        return task;
      }

      const updatedProject = await addActiveTask(project.id, task.id);
    emit({ type: 'project', project: updatedProject });
    emit({ type: 'task', task });

    if (task.planItemId) await syncPlanItem(task.planItemId, task);

    // A terminal Task must have its PTY registered before the API returns; the project popup
    // connects immediately and should never race a still-being-created session.
    await runTerminalTask(task, project, template);

    return requireTask(task.id);
    });
  }

  /**
   * The executor a new session runs on. With none chosen, a planning session defaults to the first
   * interactive CLI configured (planning always needs one). Planning gets its own, clearer error for
   * a non-CLI executor; the generic one still covers an ordinary Task (every valid
   * ExecutorProfile.kind is a CLI kind now, so this only ever fires for a stale/hand-edited
   * executors.json entry — see docs/architecture.md).
   */
  async function resolveStartExecutor(executorId: string | undefined, planning: boolean): Promise<ExecutorProfile> {
    const executor = executorId
      ? await getExecutor(executorId)
      : (planning ? (await listExecutors()).find(isInteractiveCli) : undefined) ?? await getDefaultExecutor();
    if (!executor) throw new ExecutorNotFoundError();
    if (planning && !isInteractiveCli(executor)) throw new PlanningRequiresCliError(executor);
    if (!isInteractiveCli(executor)) throw new ExecutorNotSupportedError(executor);
    return executor;
  }

  /** A session created without a CLI (`startTask`'s `deferCli`) that still has none. Call under the Project's lock. */
  async function requireDeferredSession(taskId: string): Promise<TaskRecord> {
    const task = await requireTask(taskId);
    if (!task.cliNotStarted) throw new SessionAlreadyStartedError();
    return task;
  }

  /** Saves the person's edit of a not-yet-started session's description: what its CLI will be given first. */
  async function updateDeferredSessionDescription(taskId: string, description: string): Promise<TaskRecord> {
    const { projectId } = await requireTask(taskId);
    return withProjectLock(projectId, async () => {
      await requireDeferredSession(taskId);
      const updated = await requireTaskUpdate(taskId, { description });
      emit({ type: 'task', task: updated });
      return updated;
    });
  }

  /**
   * Starts the CLI of a session created without one, on the agent the person now picked, with its
   * stored description as the first message. A refused agent leaves the session not started.
   */
  async function launchDeferredSession(taskId: string, input: { executorId?: string; autonomy?: Autonomy }): Promise<TaskRecord> {
    const { projectId } = await requireTask(taskId);
    return withProjectLock(projectId, async () => {
      const pending = await requireDeferredSession(taskId);
      const project = await getProject(projectId);
      assertWritable(project);
      const executor = await resolveStartExecutor(input.executorId, pending.kind === 'plan');
      const template = (await getAgent(pending.templateId)) ?? (await getDefaultAgent());
      if (!template) throw new AgentNotFoundError();
      const task = await requireTaskUpdate(taskId, {
        executorId: executor.id,
        status: 'developing',
        cliNotStarted: false,
        runtimeStatus: 'starting',
        runtimeStatusChangedAt: new Date().toISOString(),
        ...(input.autonomy ? { autonomy: input.autonomy } : {}),
      });
      emit({ type: 'project', project: await addActiveTask(projectId, taskId) });
      emit({ type: 'task', task });
      await runTerminalTask(task, project, template);
      return requireTask(taskId);
    });
  }

  /**
   * 'blocked' is now only ever seen on a Task predating the removal of the structured/headless
   * executor contract — no live Task can reach it any more (see settleDone/settleFailed's
   * doc comments and TaskStatus's history). Answering one continues it the same way every other
   * Task now runs: through the interactive CLI, resuming the exact same session in place (not a new
   * Task record, matching this call's existing same-id contract) on whichever executor it was
   * already using.
   */
  async function answerTask(taskId: string, answer: string): Promise<TaskRecord> {
    const task = await requireTask(taskId);
    if (task.status !== 'blocked') throw new TaskNotBlockedError(await taskName(task));

    const project = await getProject(task.projectId);
    const template = (await getAgent(task.templateId)) ?? (await getDefaultAgent());
    const executor = await getExecutor(task.executorId);
    if (!executor) throw new ExecutorNotFoundError();
    if (!isInteractiveCli(executor)) throw new ExecutorNotSupportedError(executor);

    const now = new Date().toISOString();
    const updated = await requireTaskUpdate(taskId, {
      status: 'developing',
      blockedQuestion: null,
      executionMode: 'terminal',
      runtimeStatus: 'starting',
      runtimeWaitingReason: null,
      runtimeStatusChangedAt: now,
    });
    await resolveTaskNotifications(updated, ['task.needs_input']);
    const updatedProject = await refreshProjectStatus(project.id);
    emit({ type: 'project', project: updatedProject });
    emit({ type: 'task', task: updated });

    await runTerminalTask(updated, project, template, task.sessionId, answer, 'answer');

    return requireTask(taskId);
  }

  /**
   * Marks a paused ('stopped') terminal Task completed — settles it 'done' immediately. (A
   * Workflow's own documentation-and-retro pass is now a Workflow step — see workerManager.ts's run
   * engine — not something asked about here.)
   */
  async function completeTerminalTask(taskId: string): Promise<TaskRecord> {
    const task = await requireTask(taskId);
    if (task.executionMode !== 'terminal' || task.status !== 'stopped') throw new TaskNotPausedError(await taskName(task));
    const project = await getProject(task.projectId);
    const result: ClaudeTurnResult = { sessionId: task.sessionId ?? '', status: 'done', message: 'Marked completed.', raw: { type: 'manual.complete' } };
    return finishTerminalTaskDone(task, project, result);
  }

  /**
   * Commits and pushes an ongoing ('developing'/'blocked') Task's work so far without settling it —
   * the Task keeps running on its branch and still gets its own final commit when it completes.
   * Only an ongoing Task still has its working directory: a settled one's worktree is already gone.
   */
  async function interimCommitTask(taskId: string): Promise<{ committed: boolean; message: string }> {
    const task = await requireTask(taskId);
    if ((task.status !== 'developing' && task.status !== 'blocked') || !task.branch) throw new TaskNotInterimCommittableError(await taskName(task));
    const project = await getProject(task.projectId);
    if (!project.repositoryUrl || await isConflictRunTask(task)) throw new TaskNotInterimCommittableError(await taskName(task));
    const message = `Interim Commit ${new Date().toISOString()}`;
    const committed = await commitWork(project, taskWorkingDirectory(project, task), task.branch, message);
    return { committed, message };
  }

  /**
   * Commits and pushes a Task's work on its branch, for a Project backed by a repository. Skipped
   * when the Task's working directory is gone or isn't a git checkout — a pre-workflow Task's
   * worktree is removed as soon as it pauses (see settleStopped), so there is nothing left to commit.
   */
  /** The `env`/`unsetEnv` pair that gives a terminal session the project's GitHub account (nothing for Machine default). */
  async function sessionGithub(project: ProjectRecord, executorEnv: Record<string, string>) {
    const github = await githubSessionEnv(project, executorEnv);
    return { env: { ...executorEnv, ...github.set }, unsetEnv: github.unset };
  }

  async function commitTaskWork(task: TaskRecord, project: ProjectRecord): Promise<void> {
    if (!project.repositoryUrl) return;
    const cwd = taskWorkingDirectory(project, task);
    if (!(await isOwnGitRepo(cwd))) return;
    if (!task.branch) throw new Error('Task has no recorded branch; start a new task.');
    await commitWork(project, cwd, task.branch, `Agent task: ${task.description.split('\n')[0]!.slice(0, 100)}`);
  }

  /** Settles a terminal Task 'done' outside the normal onExit path — used for a completion that needs no further CLI turn. Mirrors onExit's own 'done' branch. */
  async function finishTerminalTaskDone(task: TaskRecord, project: ProjectRecord, result: ClaudeTurnResult): Promise<TaskRecord> {
    await commitTaskWork(task, project);
    await appendTurn(task.id, { role: 'result', content: result.message, at: new Date().toISOString() });
    await settleDone(task, project, result, task.tokenUsage ?? ZERO_TOKEN_USAGE);
    return requireTask(task.id);
  }

  /**
   * Continues a finished Task's conversation with a fresh instruction — the
   * "Interactive task-specific chat ... to reply to the agent or provide
   * further instructions" roadmap item, for the case a Task already ended
   * (done/failed) rather than being 'blocked' (which already has its own
   * reply path, answerTask). Creates a new TaskRecord — a Task's own
   * lifecycle stays terminal once it settles — but resumes the *same* CLI
   * session (`--resume`, carrying full prior context) and, if the original
   * ran a PlanItem, stays linked to it, so the breakdown item's history
   * reads as one continuous thread across follow-ups.
   */
  async function followUpTask(taskId: string, instruction: string): Promise<TaskRecord> {
    const prior = await requireTask(taskId);
    if (prior.kind === 'plan' && prior.archived) throw new PlanningSessionArchivedError();
    if (prior.status === 'developing' || prior.status === 'blocked') throw new TaskNotFollowableError(await taskName(prior));
    if (prior.executionMode === 'terminal' && !prior.sessionId) throw new TerminalSessionNotResumableError(await taskName(prior));

    return continueTask(prior, instruction, instruction);
  }

  /** Reopens a settled interactive CLI conversation without adding a synthetic user message. */
  async function resumeTerminalTask(taskId: string): Promise<TaskRecord> {
    const prior = await requireTask(taskId);
    if (prior.kind === 'plan' && prior.archived) throw new PlanningSessionArchivedError();
    if (prior.status === 'developing' || prior.status === 'blocked') throw new TaskNotFollowableError(await taskName(prior));
    if (prior.executionMode !== 'terminal') throw new TaskNotTerminalError(await taskName(prior));
    if (!prior.sessionId) throw new TerminalSessionNotResumableError(await taskName(prior));

    return continueTask(prior, prior.description, null);
  }

  async function continueTask(prior: TaskRecord, description: string, terminalPrompt: string | null): Promise<TaskRecord> {
    if (prior.workflowRunId) throw new StepInspectSessionError(await taskName(prior), 'is a workflow step; reopen it from the run\'s Session view');
    return withProjectLock(prior.projectId, async () => {
      const liveSibling = prior.sessionId && conversationOwners.has(prior.sessionId);
      if (liveSibling) throw new TaskNotFollowableError(await taskName(prior));
      const members = prior.kind === 'plan' ? await sessionMembers(prior) : [];
      if (members.some((member) => member.archived)) throw new PlanningSessionArchivedError();
      // A follow-up/resume starting is "the conversation moved on" — its needs_input/failed/completed
      // Notifications (if any) no longer describe the current state.
      await resolveTaskNotifications(prior, ['task.needs_input', 'task.failed', 'task.completed']);
      const project = await getProject(prior.projectId);
      const sharedTaskCount = await claimConcurrencySlot(project, prior.kind, terminalSessions);

      const template = (await getAgent(prior.templateId)) ?? (await getDefaultAgent());

      const taskId = randomUUID();
      // A follow-up's own worktree (if the prior Task had one) is long gone by now — settling
      // removes it (see cleanupWorktree) — so a follow-up is assigned a workspace exactly like any
      // other new Task: the Project's own directory if it's currently the only active one, or a
      // fresh worktree otherwise. See docs/architecture.md#concurrent-tasks-per-project.
      const workspace = await assignTaskWorkspace(project, taskId, sharedTaskCount);

      const now = new Date().toISOString();
      const priorCreatedCount = Math.max(...members.map((member) => member.planningCreatedTaskCount ?? 0), 0);
      const legacyLinkedCount = prior.kind === 'plan' && prior.planningSessionNumber
        ? (await listPlanItems(project.id)).filter((item) => item.planningRef?.session === prior.planningSessionNumber).length
        : 0;
      const planningCreatedTaskCount = Math.max(priorCreatedCount, legacyLinkedCount);
      const task: TaskRecord = {
        id: taskId,
        projectId: project.id,
        templateId: prior.templateId,
        skillIds: prior.skillIds,
        ...(prior.preloadSkillIds ? { preloadSkillIds: prior.preloadSkillIds } : {}),
        executorId: prior.executorId,
        executionMode: 'terminal',
        description,
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
        status: 'developing',
        autonomy: prior.autonomy,
        manager: prior.manager,
        sessionSetup: prior.sessionSetup,
        sessionExecutor: prior.sessionExecutor,
        kind: prior.kind,
        ...(prior.planningSessionNumber ? {
          planningSessionNumber: prior.planningSessionNumber,
          planningQueueOrder: prior.planningQueueOrder,
          planningCompletedAt: prior.planningCompletedAt ?? null,
          planningCreatedTaskCount,
          planningAutoCompleteArmed: prior.planningAutoCompleteArmed ?? planningCreatedTaskCount > 0,
        } : {}),
        // A continued session keeps its kind: its tools and instructions follow this field.
        ...(prior.planningPurpose ? { planningPurpose: prior.planningPurpose } : {}),
        ...(prior.title ? { title: prior.title } : {}),
        conversationId: prior.conversationId ?? prior.sessionId ?? prior.id,
        planItemId: prior.planItemId,
        sessionId: prior.sessionId,
        runtimeStatus: 'starting' as const,
        runtimeWaitingReason: null,
        runtimeStatusChangedAt: now,
        blockedQuestion: null,
        failureReason: null,
        tokenUsage: ZERO_TOKEN_USAGE,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      await tasksDb.insert(withOwnership(task));
      await taskContextsDb.insert({ id: task.id, taskId: task.id, turns: [] });

      const updatedProject = await addActiveTask(project.id, task.id);
      emit({ type: 'project', project: updatedProject });
      emit({ type: 'task', task });

      if (task.planItemId) await syncPlanItem(task.planItemId, task);

      // Every Task now runs via the interactive-CLI path — including a follow-up of a Task that
      // predates that (its own `executionMode`/`sessionId` may say otherwise), which resumes on best
      // effort: see TerminalSessionNotResumableError's guard in followUpTask/resumeTerminalTask.
      await runTerminalTask(task, project, template, prior.sessionId, terminalPrompt);

      return task;
    });
  }

  /** Stops an in-flight Task's interactive-CLI session. Its exit callback settles the Task as `stopped`. */
  async function stopTask(taskId: string): Promise<TaskRecord> {
    const task = await requireTask(taskId);
    stoppedTasks.add(taskId);
    if (!terminalSessions.stop(taskId)) stoppedTasks.delete(taskId);
    return task;
  }

  /**
   * Starts one Tasks-breakdown PlanItem — `POST /api/plan-items/:id/execute`, the only way a task
   * leaves Planning. Creates a WorkflowRun through a Catalog Workflow (see `startWorkflowRun` and
   * `StartPlanItemOptions`). Once the item has run, its recorded executor is locked and wins over a
   * caller-supplied one; before that (an unstarted item — the only case the Start task dialog ever
   * hits), the caller's choice wins over any stale saved executor.
   * `templateId`/`skillIds`/`autonomy` don't apply: each WorkflowStep picks its own.
   */
  async function executePlanItem(planItemId: string, options: StartPlanItemOptions = {}): Promise<WorkflowRunRecord> {
    const item = await getPlanItem(planItemId);
    const locked = item.taskIds.length > 0 ? item.executorId : undefined;
    const workflowId = options.workflowId ?? (isBug(item) ? await bugWorkflowId(item.projectId) : undefined);
    return startWorkflowRun(item, { ...options, workflowId, executorId: locked ?? options.executorId ?? item.executorId ?? undefined });
  }

  /** The workflow a bug starts with when none is chosen: its Building Type's "Fix a bug" slot. Undefined when that workflow is disabled or gone, so the Project's default runs. */
  async function bugWorkflowId(projectId: string): Promise<string | undefined> {
    const project = await getProject(projectId);
    return (await slotWorkflow(project.typeId ?? 'software', BUG_WORKFLOW_SLOT_ID))?.id;
  }

  /**
   * The workflow a regression re-runs: the one the bug's last run used, while it is still enabled. Otherwise the
   * "Start a bug" fallback — the bug workflow, else the Project's default — with a note saying so.
   */
  async function regressionWorkflow(item: PlanItemRecord, lastRun: WorkflowRunRecord | undefined): Promise<{ workflowId?: string; note: string | null }> {
    const last = lastRun ? await getWorkflow(lastRun.workflowId) : undefined;
    if (last?.enabled) return { workflowId: last.id, note: null };
    const fallbackId = await bugWorkflowId(item.projectId);
    if (!lastRun) return { workflowId: fallbackId, note: null };
    const used = fallbackId ? 'the bug workflow' : "the Project's default workflow";
    return { workflowId: fallbackId, note: `The workflow of the earlier run ("${lastRun.workflowSnapshot.name}") is disabled or gone, so ${used} ran instead.` };
  }

  /**
   * Reports a regression on a completed bug and starts its round 2 at once: the same bug goes back to
   * Running, and every step of the bug's workflow runs again from the first step on a fresh branch.
   * The reason is recorded as the start is accepted, so a refused start (concurrency cap, busy folder,
   * no usable agent) changes nothing. Two simultaneous reopens are serialised by the Project lock, so
   * the second finds the bug already running and is refused.
   */
  async function reopenBug(bugId: string, input: { reason: unknown; reporter: BugRegressionReporter }): Promise<{ item: PlanItemRecord; run: WorkflowRunRecord; workflowNote: string | null }> {
    const reason = parseRegressionReason(input.reason);
    const { projectId } = await getPlanItem(bugId);
    let workflowNote: string | null = null;
    const run = await withProjectLock(projectId, async () => {
      const item = await getPlanItem(bugId);
      assertRegressionReportable(item);
      const earlierRuns = await workflowRunsDb.find((candidate) => candidate.planItemId === item.id);
      const lastRun = item.workflowRunId ? await workflowRunsDb.get(item.workflowRunId) : undefined;
      const workflow = await regressionWorkflow(item, lastRun);
      workflowNote = workflow.note;
      const roundOffsets = regressionRoundOffsets(await Promise.all(earlierRuns.map(async (earlier) => ({
        run: earlier, stepRuns: await stepRunsDb.find((stepRun) => stepRun.runId === earlier.id),
      }))));
      return acceptWorkflowRun(item, {
        workflowId: workflow.workflowId,
        executorId: lastRun?.executorId,
        regression: { entry: { reason, reportedAt: new Date().toISOString(), reporter: input.reporter }, roundOffsets },
      });
    });
    launchStartup(run.id, bugId);
    return { item: await getPlanItem(bugId), run, workflowNote };
  }

  /**
   * Whether a new run would fit right now: under the Project's concurrency cap and, for a Project with no repository
   * (whose runs work in its own folder), with that folder free. A start can still lose the slot to another one; this
   * only saves preparing a start that cannot fit.
   */
  async function hasFreeSlot(projectId: string): Promise<boolean> {
    try {
      const project = await getProject(projectId);
      await claimConcurrencySlot(project, 'execute', terminalSessions);
      return Boolean(project.repositoryUrl) || !(await isProjectFolderBusy(project, terminalSessions));
    } catch (error) {
      if (error instanceof TaskConflictError) return false;
      throw error;
    }
  }

  /** Runs `fn` after every earlier queue decision for this Project has settled, whatever the outcome — see `queueLocks`'s doc comment. */
  function withQueueLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return serializeOn(queueLocks, projectId, fn);
  }

  /** Every pending (not-yet-started) queued plan-item execution for a Project, in the order they'll run — the "list the queue" read backing `GET /api/projects/:id/plan-item-queue`. */
  async function listPlanItemQueue(projectId: string): Promise<PlanItemQueueEntry[]> {
    const entries = await planItemQueueDb.find((e) => e.projectId === projectId);
    return entries.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.createdAt.localeCompare(b.createdAt));
  }

  /** Saves `entries` as this Project's queue in exactly this sequence (positions 0..n-1), writing only the entries whose position changed. */
  async function saveQueueOrder(entries: PlanItemQueueEntry[]): Promise<void> {
    await Promise.all(entries.map((entry, position) => (entry.position === position ? undefined : planItemQueueDb.update(entry.id, { position }))));
  }

  /** `entries` with `entry` placed at `index` (clamped; undefined = the end) — any existing copy of it removed first. */
  function placeInQueue(entries: PlanItemQueueEntry[], entry: PlanItemQueueEntry, index: number | undefined): PlanItemQueueEntry[] {
    const others = entries.filter((e) => e.id !== entry.id);
    const at = Math.max(0, Math.min(index ?? others.length, others.length));
    return [...others.slice(0, at), entry, ...others.slice(at)];
  }

  async function emitQueueChanged(projectId: string): Promise<void> {
    emit({ type: 'planItemQueue', projectId, entries: await listPlanItemQueue(projectId) });
  }

  /**
   * The start entry point for `POST /api/plan-items/:id/execute` and a released dependent task: starts the
   * item's Task now (`executePlanItem`) unless its Project is at its task limit, in which case it persists a
   * `PlanItemQueueEntry` and returns that for the frontend to show as "waiting for a free slot". Only the
   * task limit queues a start; every other refusal still throws. The slot is the single gate — a Project with
   * free slots starts any number of items at once. An entry is also queued, first come first served, behind
   * entries already waiting, so a new start never jumps the line. Runs inside `withQueueLock` so near-simultaneous
   * starts for one Project cannot both claim the last slot.
   *
   * A queued entry goes at `queueIndex` (0 = next to run; omitted = the end). An item that's already queued isn't
   * queued twice: its existing entry is returned, moved to `queueIndex` if one is given.
   */
  async function enqueuePlanItemExecution(
    planItemId: string,
    options: StartPlanItemOptions & { queueIndex?: number } = {},
  ): Promise<PlanItemExecutionResult> {
    const item = await getPlanItem(planItemId); // 404s if the referenced item doesn't exist
    return withQueueLock(item.projectId, async () => {
      const queue = await listPlanItemQueue(item.projectId);
      const existing = queue.find((e) => e.planItemId === planItemId);
      if (existing) {
        if (options.queueIndex === undefined) return { started: false, entry: existing };
        const ordered = placeInQueue(queue, existing, options.queueIndex);
        await saveQueueOrder(ordered);
        await emitQueueChanged(item.projectId);
        return { started: false, entry: { ...existing, position: ordered.indexOf(existing) } };
      }
      let limitReached: TaskLimitReachedError | undefined;
      if (queue.length === 0) {
        try {
          return { started: true, run: await executePlanItem(planItemId, options) };
        } catch (error) {
          // A Project with no repository has one slot, which an unsettled run holds by keeping the Project's own folder.
          const folderIsTheSlot = error instanceof ProjectFolderBusyError && !(await getProject(item.projectId)).repositoryUrl;
          if (!(error instanceof TaskLimitReachedError) && !folderIsTheSlot) throw error;
          limitReached = error instanceof TaskLimitReachedError ? error : undefined;
        }
      }
      const entry: PlanItemQueueEntry = {
        id: randomUUID(),
        projectId: item.projectId,
        planItemId,
        // The caller's choice (the Start task dialog's selection) wins over a stale saved
        // assignment — see `executePlanItem`'s own precedence for an unstarted item.
        executorId: options.executorId ?? item.executorId ?? undefined,
        ...(options.workflowId ? { workflowId: options.workflowId } : {}),
        ...(options.workflow ? { workflow: options.workflow } : {}),
        ...(options.createBranch !== undefined ? { createBranch: options.createBranch } : {}),
        ...(options.skippedStepIds?.length ? { skippedStepIds: options.skippedStepIds } : {}),
        createdAt: new Date().toISOString(),
      };
      const ordered = placeInQueue(queue, entry, options.queueIndex);
      entry.position = ordered.indexOf(entry);
      await planItemQueueDb.insert(entry);
      await saveQueueOrder(ordered);
      await emitQueueChanged(item.projectId);
      if (limitReached) await raiseTaskLimitNotification(item.projectId, limitReached);
      // Entries were already waiting: a slot may have freed without a settle reaching them, so give the line a turn.
      else if (queue.length > 0) await advanceQueueLocked(item.projectId);
      return { started: false, entry };
    });
  }

  /** Removes a not-yet-started entry — `DELETE /api/plan-item-queue/:entryId`, the "remove from queue" UI action. Stopping the *currently running* queued Task instead uses the ordinary `stopTask`, since a started entry is no longer a queue entry at all. */
  async function removeQueuedPlanItemExecution(entryId: string): Promise<void> {
    const found = await planItemQueueDb.get(entryId);
    if (!found) throw new PlanItemQueueEntryNotFoundError(entryId);
    // Under the Project's queue lock: an advance in the middle of starting this entry would otherwise put it back after the removal.
    await withQueueLock(found.projectId, async () => {
      if (!(await planItemQueueDb.get(entryId))) throw new PlanItemQueueEntryNotFoundError(entryId);
      await planItemQueueDb.delete(entryId);
      await emitQueueChanged(found.projectId);
      if ((await listPlanItemQueue(found.projectId)).length === 0) await resolveTaskLimitNotification(found.projectId);
    });
  }

  /**
   * Sets the order a Project's queued executions will run in — the Tasks tab's In Progress swimlane
   * after a drag. `entryIds` go first, in this sequence; any entry not listed (say, one queued while
   * the drag was in flight) keeps its relative place after them. Returns the queue in its new order.
   */
  async function reorderPlanItemQueue(projectId: string, entryIds: string[]): Promise<PlanItemQueueEntry[]> {
    return withQueueLock(projectId, async () => {
      const queue = await listPlanItemQueue(projectId);
      const byId = new Map(queue.map((entry) => [entry.id, entry]));
      const listed = entryIds.map((id) => {
        const entry = byId.get(id);
        if (!entry) throw new PlanItemQueueEntryNotFoundError(id);
        return entry;
      });
      await saveQueueOrder([...listed, ...queue.filter((entry) => !entryIds.includes(entry.id))]);
      await emitQueueChanged(projectId);
      return listPlanItemQueue(projectId);
    });
  }

  /**
   * Starts as many queued executions for a Project as it has free slots — called whenever a Task settles or is
   * deleted (see the settle helpers below), when a plan item is completed or deleted by hand, and once per
   * Project at daemon start. A no-op when the queue is empty or the Project is still at its task limit. A stopped
   * or paused Task keeps its slot (`liveTasksOf`), so the line never takes it behind its back.
   */
  function advanceQueueIfIdle(projectId: string): Promise<void> {
    return withQueueLock(projectId, () => advanceQueueLocked(projectId));
  }

  /** Advances every Project that has waiting entries; the daemon calls it once at start so a persisted line resumes. */
  async function advanceAllQueues(): Promise<void> {
    const projectIds = new Set((await planItemQueueDb.find(() => true)).map((entry) => entry.projectId));
    await Promise.all([...projectIds].map((projectId) => advanceQueueIfIdle(projectId)));
  }

  /** One project-scoped notice that queued tasks are waiting for a free slot; raising again while it is unresolved updates it in place. */
  async function raiseTaskLimitNotification(projectId: string, error: TaskLimitReachedError): Promise<void> {
    const limit = error.details.limit as number;
    await raiseNotification({
      kind: 'task.limit_reached',
      subject: { type: 'project', projectId },
      title: `${error.details.projectName} is waiting for a free task slot`,
      description: `${error.message} Queued tasks start on their own once a slot frees up (limit: ${limit}).`,
    });
  }

  function resolveTaskLimitNotification(projectId: string): Promise<void> {
    return resolveNotifications({ type: 'project', projectId }, ['task.limit_reached']);
  }

  /** The actual dequeue-and-start step, run only from inside `withQueueLock` (directly or via its own recursion below) — never call this without holding that lock. */
  async function advanceQueueLocked(projectId: string): Promise<void> {
    const queue = await listPlanItemQueue(projectId);
    const next = queue[0];
    if (!next) {
      await resolveTaskLimitNotification(projectId);
      return;
    }

    await planItemQueueDb.delete(next.id);
    await emitQueueChanged(projectId);
    try {
      await executePlanItem(next.planItemId, {
        executorId: next.executorId, workflowId: next.workflowId, workflow: next.workflow, createBranch: next.createBranch, skippedStepIds: next.skippedStepIds,
      });
    } catch (error) {
      if (error instanceof TaskConflictError || error instanceof ProjectFolderBusyError) {
        // No free concurrency slot right now (or the in-place folder is busy). Put this entry back at the
        // front of the queue rather than dropping it; the next settle on this Project calls
        // advanceQueueIfIdle again and retries it.
        await planItemQueueDb.insert(next);
        await emitQueueChanged(projectId);
        if (error instanceof TaskLimitReachedError) await raiseTaskLimitNotification(projectId, error);
        return;
      }
      // The PlanItem itself is gone, or some other permanent error — drop it and try the next one
      // rather than stalling the rest of the queue behind one bad entry.
      console.error(`Dropping queued plan-item execution ${next.id} (plan item ${next.planItemId}): ${(error as Error).message}`);
    }
    // More free slots may remain, and a dropped entry must not stall the rest of the line.
    await advanceQueueLocked(projectId);
  }

  function getTaskTranscript(taskId: string) {
    return taskContextsDb.get(taskId);
  }

  function getTask(id: string): Promise<TaskRecord> {
    return requireTask(id);
  }

  /** Every Task of `task`'s conversation — it and its follow-ups. */
  function sessionMembers(task: TaskRecord): Promise<TaskRecord[]> {
    const key = task.conversationId ?? task.sessionId ?? task.id;
    return tasksDb.find(t => t.projectId === task.projectId && t.kind === task.kind && (t.conversationId ?? t.sessionId ?? t.id) === key);
  }

  /** `sessionMembers`, refusing while any of them is still live. Call under the Project's lock. */
  async function idleSessionMembers(task: TaskRecord): Promise<TaskRecord[]> {
    const members = await sessionMembers(task);
    const live = members.find((member) => isLiveTask(member, terminalSessions));
    if (live) throw new SessionStillRunningError({ taskId: live.id, title: live.title ?? live.description.split('\n')[0]!.trim() });
    return members;
  }

  async function archiveSession(taskId: string, archived: boolean): Promise<void> {
    const task = await requireTask(taskId);
    if (task.kind === 'plan' && archived) return completePlanningSession(taskId);
    await withProjectLock(task.projectId, async () => {
      const hasReadyLinkedTask = !archived && !!task.planningSessionNumber && (await listPlanItems(task.projectId)).some(
        (item) => linkedSessionNumber(item) === task.planningSessionNumber && item.status === 'pending' && !item.archived,
      );
      const members = await idleSessionMembers(task);
      if (!archived && members.every((member) => !member.archived)) return;
      const updated = await tasksDb.updateMany(members.map((member) => ({ id: member.id, patch: {
        archived,
        ...(member.kind === 'plan' && !archived ? { planningCompletedAt: null, planningAutoCompleteArmed: hasReadyLinkedTask } : {}),
      } })));
      if (archived) await resolveSessionNotifications(members);
      for (const member of updated) emit({ type: 'task', task: member });
    });
  }

  /** Completes one idle planning conversation without changing any task it created. */
  async function completePlanningSession(taskId: string): Promise<void> {
    const task = await requireTask(taskId);
    if (task.kind !== 'plan') throw new TaskNotPlanningSessionError();
    await withProjectLock(task.projectId, async () => {
      await serializeOn(planningLocks, task.projectId, async () => {
        const members = await idleSessionMembers(task);
        if (members.every((member) => member.archived)) return;
        const latest = members.reduce((newest, member) => member.createdAt > newest.createdAt ? member : newest, members[0]!);
        const items = await listPlanItems(task.projectId);
        // A Plan & bugs session also releases its standalone ready bugs (a bug under its introducing task's card keeps that card's slot);
        // a planning or earlier bug report session releases only the tasks numbered under it, as before.
        const releases = isPlanAndBugsSession(latest)
          ? (item: PlanItemRecord) => linkedSessionNumber(item) === latest.planningSessionNumber && !(isBug(item) && bugGroupId(item))
          : (item: PlanItemRecord) => item.planningRef?.session === latest.planningSessionNumber;
        const ready = items.filter((item) => releases(item) && item.status === 'pending' && !item.archived)
          .sort(comparePlanningGroupOrder);
        const readyIds = new Set(ready.map((item) => item.id));
        const parentOrder = latest.planningQueueOrder ?? -new Date(latest.createdAt).getTime();
        // Release children into the group's slot; their order survives deletion of the group.
        const nextOrder = Math.min(...[
          ...items.filter((item) => !readyIds.has(item.id)).map((item) => item.planningQueueOrder),
          ...((await listTasksForProject(task.projectId)).filter((member) => member.kind === 'plan' && !member.archived && member.planningSessionNumber !== latest.planningSessionNumber).map((member) => member.planningQueueOrder)),
        ].filter((order): order is number => order !== undefined && Number.isFinite(order) && order > parentOrder));
        const span = Number.isFinite(nextOrder) ? nextOrder - parentOrder : 1;
        const now = new Date().toISOString();
        const released = ready.length ? await planItemsDb.updateMany(ready.map((item, index) => ({ id: item.id, patch: {
          planningQueueOrder: parentOrder + span * (index + 1) / (ready.length + 1), updatedAt: now,
        } }))) : [];
        let updated: TaskRecord[];
        try {
          updated = await tasksDb.updateMany(members.map((member) => ({ id: member.id, patch: {
            archived: true, planningCompletedAt: now, planningAutoCompleteArmed: false,
          } })));
        } catch (error) {
          // The queue and sessions use separate files; do not publish either side of a failed transition.
          if (released.length) await planItemsDb.updateMany(ready.map((item) => ({ id: item.id, patch: {
            planningQueueOrder: item.planningQueueOrder, updatedAt: item.updatedAt,
          } })));
          throw error;
        }
        await resolveSessionNotifications(members);
        for (const item of released) emit({ type: 'planItem', planItem: item });
        for (const member of updated) emit({ type: 'task', task: member });
      });
    });
  }

  /** Latest-state auto-completion check. Call while holding the Project's planning lock. */
  async function maybeAutoCompletePlanningSessionUnlocked(projectId: string, session: number | undefined): Promise<void> {
    if (!session) return;
    const members = await tasksDb.find((candidate) => candidate.projectId === projectId && candidate.kind === 'plan' && candidate.planningSessionNumber === session);
    if (members.length === 0 || members.every((member) => member.archived)) return;
    const latest = members.reduce((newest, member) => member.createdAt > newest.createdAt ? member : newest, members[0]!);
    const linkedItems = (await listPlanItems(projectId)).filter((item) => linkedSessionNumber(item) === session);
    const createdCount = latest.planningCreatedTaskCount ?? linkedItems.length;
    if (!createdCount || !(latest.planningAutoCompleteArmed ?? true)) return;
    const ready = linkedItems.some((item) => item.status === 'pending' && !item.archived);
    if (ready || members.some((member) => isLiveTask(member, terminalSessions))) return;
    const now = new Date().toISOString();
    const updated = await tasksDb.updateMany(members.map((member) => ({ id: member.id, patch: {
      archived: true, planningCompletedAt: now, planningAutoCompleteArmed: false,
    } })));
    await resolveSessionNotifications(members);
    for (const member of updated) emit({ type: 'task', task: member });
  }

  /** Serializes completion with planning-agent creates, so a stale empty-group check cannot win. */
  async function maybeAutoCompletePlanningSession(projectId: string, session: number | undefined): Promise<void> {
    if (!session) return;
    await serializeOn(planningLocks, projectId, () => maybeAutoCompletePlanningSessionUnlocked(projectId, session));
  }

  /** Checks the session behind an item that just left Planning: a task's planning conversation, or a bug's report session. */
  async function maybeAutoCompleteForItem(item: Pick<PlanItemRecord, 'projectId' | 'planningRef' | 'type' | 'bug' | 'reportSessionNumber'>): Promise<void> {
    await maybeAutoCompletePlanningSession(item.projectId, linkedSessionNumber(item));
  }

  /** Keep lifetime eligibility when the final task of a pre-feature session is about to be deleted. */
  async function rememberLegacyPlanningTasks(item: PlanItemRecord): Promise<void> {
    const session = item.planningRef?.session;
    if (!session) return;
    const members = await tasksDb.find((task) => task.projectId === item.projectId && task.kind === 'plan' && task.planningSessionNumber === session);
    if (!members.length || members.some((member) => member.planningCreatedTaskCount !== undefined || member.planningAutoCompleteArmed !== undefined)) return;
    const count = (await listPlanItems(item.projectId)).filter((linked) => linked.planningRef?.session === session).length;
    if (!count) return;
    const updated = await tasksDb.updateMany(members.map((member) => ({ id: member.id, patch: {
      planningCreatedTaskCount: count, planningAutoCompleteArmed: true,
    } })));
    for (const member of updated) emit({ type: 'task', task: member });
  }

  /** Renames a session — every Task of its conversation, so follow-ups keep the name. Allowed while it's live. */
  async function renameSession(taskId: string, title: string): Promise<void> {
    const task = await requireTask(taskId);
    await withProjectLock(task.projectId, async () => {
      for (const member of await sessionMembers(task)) {
        const updated = await tasksDb.update(member.id, { title });
        if (updated) emit({ type: 'task', task: updated });
      }
    });
  }

  /** Deletes a settled session — every Task of its conversation and their transcripts. Tasks it created on the board are left alone. */
  async function deleteSession(taskId: string): Promise<void> {
    const task = await requireTask(taskId);
    await withProjectLock(task.projectId, async () => {
      const members = await idleSessionMembers(task);
      await resolveSessionNotifications(members);
      for (const member of members) {
        await tasksDb.delete(member.id);
        await taskContextsDb.delete(member.id);
        emit({ type: 'taskDeleted', id: member.id, projectId: task.projectId });
      }
    });
  }

  function listTasksForProject(projectId: string): Promise<TaskRecord[]> {
    return tasksDb.find((t) => t.projectId === projectId);
  }

  /**
   * Validates the complete mixed Planning queue before changing any order, restoring it if a write
   * fails. A `reference` entry is a top-level introducing-task card, named by that task's id: its
   * slot is held by the ready bugs grouped under it. A group shown beneath a planning conversation
   * is not a top-level entry, and neither is a bug inside any group.
   */
  async function reorderPlanningQueue(projectId: string, entries: PlanningQueueEntryRef[]): Promise<void> {
    await withProjectLock(projectId, async () => {
      const [tasks, items] = await Promise.all([listTasksForProject(projectId), listPlanItems(projectId)]);
      const activeSessions = new Set(tasks.filter((task) => task.kind === 'plan' && !task.archived).map((task) => task.planningSessionNumber).filter((value): value is number => !!value));
      const sessionById = new Map(tasks.filter((task) => task.kind === 'plan' && !task.archived).map((task) => [task.id, task.planningSessionNumber]));
      const grouped = (item: PlanItemRecord) => isReadyBug(item) && bugGroupId(item) !== null;
      const standalone = new Map(items.filter((item) => !grouped(item) && item.status !== 'done' && item.status !== 'blocked' && !item.archived && !item.workflowRunId && (item.status !== 'pending' || !item.planningRef || !activeSessions.has(item.planningRef.session))).map((item) => [item.id, item]));
      const groups = new Map<string, PlanItemRecord[]>();
      for (const item of items.filter(grouped)) groups.set(bugGroupId(item)!, [...(groups.get(bugGroupId(item)!) ?? []), item]);
      const itemsById = new Map(items.map((item) => [item.id, item]));
      const underConversation = (introducerId: string) => {
        const session = itemsById.get(introducerId)?.planningRef?.session;
        return session !== undefined && activeSessions.has(session);
      };
      const topLevelGroups = new Set([...groups.keys()].filter((id) => !underConversation(id)));
      const seenSessions = new Set<number>();
      const seenTasks = new Set<string>();
      const seenGroups = new Set<string>();
      for (const entry of entries) {
        if (entry.kind === 'session') {
          const session = sessionById.get(entry.id);
          if (!session || seenSessions.has(session)) throw new PlanItemNotFoundError();
          seenSessions.add(session);
        } else if (entry.kind === 'reference') {
          if (!groups.has(entry.id)) throw new PlanItemNotFoundError();
          if (!topLevelGroups.has(entry.id) || seenGroups.has(entry.id)) throw new PlanningQueueConflictError();
          seenGroups.add(entry.id);
        } else {
          if (!standalone.has(entry.id) || seenTasks.has(entry.id)) throw new PlanItemNotFoundError();
          seenTasks.add(entry.id);
        }
      }
      if (seenSessions.size !== activeSessions.size || seenTasks.size !== standalone.size || seenGroups.size !== topLevelGroups.size) throw new PlanningQueueConflictError();
      const changedItems: PlanItemRecord[] = [];
      const changedTasks: TaskRecord[] = [];
      const committedItems: PlanItemRecord[] = [];
      const committedTasks: TaskRecord[] = [];
      try {
        for (const [planningQueueOrder, entry] of entries.entries()) {
          if (entry.kind === 'task') {
            const previous = standalone.get(entry.id)!;
            changedItems.push(previous);
            committedItems.push(await updatePlanItem(entry.id, { planningQueueOrder }));
          } else if (entry.kind === 'reference') {
            for (const bug of groups.get(entry.id)!) {
              changedItems.push(bug);
              committedItems.push(await updatePlanItem(bug.id, { planningQueueOrder }));
            }
          } else {
            const session = sessionById.get(entry.id)!;
            for (const member of tasks.filter((task) => task.kind === 'plan' && task.planningSessionNumber === session)) {
              changedTasks.push(member);
              const updated = await tasksDb.update(member.id, { planningQueueOrder });
              if (!updated) throw new PlanningQueueConflictError();
              committedTasks.push(updated);
            }
          }
        }
      } catch (error) {
        // Each collection write is atomic, but a queue spans two collections. Restore the
        // original slots before publishing anything if a later write fails.
        await Promise.all([
          ...changedItems.map((item) => planItemsDb.update(item.id, { planningQueueOrder: item.planningQueueOrder, updatedAt: item.updatedAt })),
          ...changedTasks.map((task) => tasksDb.update(task.id, { planningQueueOrder: task.planningQueueOrder })),
        ]);
        throw error;
      }
      for (const planItem of committedItems) emit({ type: 'planItem', planItem });
      for (const task of committedTasks) emit({ type: 'task', task });
    });
  }

  /**
   * Saves the order of one active planning group's ready tasks. `ids` must be exactly that group's
   * current ready tasks: a task elsewhere (another group, standalone, started) or a stale set is a
   * conflict, and nothing changes. The session is named by any of its conversation's Task ids.
   */
  async function reorderPlanningGroup(projectId: string, sessionTaskId: string, ids: string[]): Promise<void> {
    await withProjectLock(projectId, async () => {
      const session = await tasksDb.get(sessionTaskId);
      if (!session || session.projectId !== projectId || session.kind !== 'plan' || !session.planningSessionNumber) throw new TaskNotFoundError();
      if (session.archived) throw new PlanningQueueConflictError();
      const items = await listPlanItems(projectId);
      const ready = new Set(items.filter((item) => item.planningRef?.session === session.planningSessionNumber && item.status === 'pending' && !item.archived).map((item) => item.id));
      for (const id of ids) {
        if (!items.some((item) => item.id === id)) throw new PlanItemNotFoundError();
        if (!ready.has(id)) throw new PlanningQueueConflictError();
      }
      if (new Set(ids).size !== ready.size || ids.length !== ready.size) throw new PlanningQueueConflictError();
      const now = new Date().toISOString();
      const updated = await planItemsDb.updateMany(ids.map((id, planningGroupOrder) => ({ id, patch: { planningGroupOrder, updatedAt: now } })));
      for (const planItem of updated) emit({ type: 'planItem', planItem });
    });
  }

  /**
   * Moves every unsettled Task working in the Project's own directory (not a worktree) from branch
   * `from` onto `to` — after a new branch was created over that directory's in-progress work (see
   * projectService.ts's `checkoutProjectBranch`), so each Task's own branch checks and final
   * `commitAndPush` follow the work onto the new branch instead of failing on the old one.
   */
  async function retargetPrimaryTasks(projectId: string, from: string, to: string): Promise<void> {
    const tasks = await tasksDb.find((t) => t.projectId === projectId && !t.worktreePath && t.branch === from && t.status !== 'done' && t.status !== 'failed');
    for (const task of tasks) emit({ type: 'task', task: await requireTaskUpdate(task.id, { branch: to }) });
  }

  /** Every Task ever run, across every Project — the source data for the footer's per-executor usage totals (see executors/executorUsage.ts). */
  function listAllTasks(): Promise<TaskRecord[]> {
    return tasksDb.find(() => true);
  }

  const handleTerminalHook = (taskId: string, event: Record<string, unknown>): Promise<TaskRecord> => processTerminalHook(taskId, event, true);

  async function loadTestRuns(ids: readonly string[]): Promise<TestRunRecord[]> {
    const runs = await Promise.all(ids.map((id) => testRunsDb.get(id)));
    return runs.filter((run): run is TestRunRecord => Boolean(run));
  }

  /** `honorTestRuns` false applies a turn-end as a real wait even when a Test Run the agent awaited has just ended (see `applyDeferredWait`). */
  async function processTerminalHook(taskId: string, event: Record<string, unknown>, honorTestRuns: boolean): Promise<TaskRecord> {
    const task = await requireTask(taskId);
    if (task.executionMode !== 'terminal') throw new TaskNotTerminalError(await taskName(task));
    const rawNext = terminalRuntimeFromHook(event);
    if (!rawNext || (task.status !== 'developing' && rawNext.status !== 'completed')) return task;
    // A workflow step session's CLI fires Stop/Notification hooks the instant a turn ends — normally
    // the very turn in which the model calls complete_step/skip_step, just before the daemon tears
    // that session down via endStepSession. Once this round's StepRun is no longer 'running', any
    // further "waiting for input" is residue of that teardown (a false attention alarm), so it reads
    // as an ordinary "still running" tick and `settleWorkflowStepTaskExit` settles the exit 'done'.
    // While the round is still unresolved, though, it is a genuine question from the step: surfaced
    // on its WorkflowRun as needs-attention (see `syncStepQuestionOnRun`) and answered in the step's
    // own live session, after which the step carries on and reports as usual.
    const openStepRun = task.workflowRunId ? await findRunningStepRun(taskId) : undefined;
    const spuriousStepWait = Boolean(task.workflowRunId) && !openStepRun && rawNext.status === 'waiting_input';
    // A turn-end while the agent waits for a Test Run it started is not a question for the owner:
    // hold it back as "running" and let `applyDeferredWait` surface it if the CLI stays idle afterwards.
    const coveredByTestRun = honorTestRuns && !spuriousStepWait && isTurnEndCoveredByTestRun(event, task.awaitedTestRunIds, await loadTestRuns(task.awaitedTestRunIds ?? []));
    const next = coveredByTestRun
      ? { status: 'running' as const, reason: WAITING_ON_TEST_RUN }
      : spuriousStepWait ? { status: 'running' as const, reason: null } : rawNext;
    const wasWaiting = task.runtimeStatus === 'waiting_input';
    const terminalWasAttached = terminalSessions.isAttached(taskId);
    const updated = await requireTaskUpdate(taskId, {
      runtimeStatus: next.status,
      runtimeWaitingReason: next.reason,
      runtimeStatusChangedAt: new Date().toISOString(),
      runtimeDeferredWait: coveredByTestRun,
    });

    // The Task itself stays `developing` while its PTY is alive: input still goes directly to that
    // process. Project/plan status are attention states, however, so mirror the live CLI pause there
    // and reverse it as soon as the user submits input or the CLI starts another tool.
    const waiting = next.status === 'waiting_input';
    const active = task.status === 'developing';
    // A workflow step Task's PlanItem status is owned by its run (`syncPlanItemForRun`, fed by
    // `syncStepQuestionOnRun` below) — mirroring the step session here would drag a completed run's
    // item back to 'developing' when its final session's late Stop hook lands after completion.
    if (active && updated.planItemId && !task.workflowRunId) await syncPlanItem(updated.planItemId, updated, waiting ? 'blocked' : 'developing');
    if (active && openStepRun) await syncStepQuestionOnRun(openStepRun, waiting ? stepQuestionFromHook(event, next.reason) : null);
    if (active && waiting && !wasWaiting && !terminalWasAttached && !task.workflowRunId) {
      await raiseNotification({
        kind: 'task.needs_input',
        subject: taskSubject(updated),
        title: `Needs your input: ${firstLine(updated.description)}`,
        description: next.reason ?? 'The interactive CLI is waiting for input. Open its session to continue.',
      });
    } else if (active && wasWaiting && !waiting) {
      await resolveTaskNotifications(updated, ['task.needs_input']);
    }
    if (active) {
      const updatedProject = await refreshProjectStatus(task.projectId);
      emit({ type: 'project', project: updatedProject });
    }
    emit({ type: 'task', task: updated });
    return updated;
  }

  /** Appends the Test Runs a Task's testing tool is waiting on, keeping the most recent `MAX_AWAITED_TEST_RUNS`. */
  async function recordAwaitedTestRuns(taskId: string, runIds: readonly string[]): Promise<void> {
    await tasksDb.updateWith(taskId, (live) => ({
      awaitedTestRunIds: [...new Set([...(live.awaitedTestRunIds ?? []), ...runIds])].slice(-MAX_AWAITED_TEST_RUNS),
    }));
  }

  /**
   * The CLI was left idle after an awaited Test Run ended, so the turn-end held back by
   * `processTerminalHook` is now a real wait. A no-op unless that hold is still in place (any CLI
   * activity since clears it) and every awaited run has ended — which also makes a repeated call
   * harmless.
   */
  async function applyDeferredWait(taskId: string): Promise<void> {
    const task = await tasksDb.get(taskId);
    if (!task?.runtimeDeferredWait || task.status !== 'developing') return;
    if ((await loadTestRuns(task.awaitedTestRunIds ?? [])).some(isTestRunActive)) return;
    await processTerminalHook(taskId, { hook_event_name: 'Stop' }, false);
  }

  const graceTimers = new Set<NodeJS.Timeout>();
  const unsubscribeTestEvents = (deps.onTestEvent ?? defaultTestRunner.onTestEvent)((event) => {
    if (event.type !== 'testRun' || isTestRunActive(event.run)) return;
    const { id } = event.run;
    void tasksDb.find((t) => Boolean(t.awaitedTestRunIds?.includes(id))).then((tasks) => {
      for (const { id: taskId } of tasks) {
        const timer = setTimeout(() => {
          graceTimers.delete(timer);
          applyDeferredWait(taskId)
            .catch((error) => console.error(`Task ${taskId}: deferred test-run wait failed:`, error));
        }, deps.testRunGraceMs ?? TEST_RUN_GRACE_MS);
        timer.unref();
        graceTimers.add(timer);
      }
    });
  });

  /** Stops the grace timers and the Test Run subscription. */
  function dispose(): void {
    unsubscribeTestEvents();
    for (const timer of graceTimers) clearTimeout(timer);
    graceTimers.clear();
  }

  /** A restart kills every CLI session, so a held-back turn-end can never be resumed or surfaced: drop it without raising attention. */
  async function clearDeferredTestRunWaits(): Promise<void> {
    const stale = await tasksDb.find((t) => Boolean(t.runtimeDeferredWait) || Boolean(t.awaitedTestRunIds?.length) || t.runtimeWaitingReason === WAITING_ON_TEST_RUN);
    for (const task of stale) {
      await requireTaskUpdate(task.id, {
        runtimeDeferredWait: false,
        awaitedTestRunIds: [],
        ...(task.runtimeWaitingReason === WAITING_ON_TEST_RUN ? { runtimeStatus: 'disconnected' as const, runtimeWaitingReason: null } : {}),
      });
    }
  }

  async function getTaskRuntime(taskId: string) {
    const task = await requireTask(taskId);
    return {
      taskId: task.id,
      sessionId: task.sessionId,
      status: task.runtimeStatus ?? (task.executionMode === 'terminal' ? terminalRuntimeFromTask(task) : null),
      waitingReason: task.runtimeWaitingReason ?? null,
      changedAt: task.runtimeStatusChangedAt ?? task.updatedAt,
    };
  }

  /**
   * Called once at daemon startup. A Task left in 'developing' status is one whose CLI session
   * died with the previous daemon process. Nothing is ever relaunched automatically: a relaunch on
   * every start re-triggered the same Tasks over and over under `node --watch` (each restart — often
   * caused by the relaunched Task's own edits to this repo — resumed them again). A workflow step
   * Task is reported `needs-attention` on its run; any other Task is paused exactly like a plain CLI
   * exit (work committed, status 'stopped'), resumable by hand via `resumeTerminalTask`. 'blocked'
   * Tasks need no action: they're waiting on a human, not interrupted.
   */
  async function resumeInterruptedTasks(): Promise<void> {
    await clearDeferredTestRunWaits();
    await recoverInterruptedStartingRuns();
    const interrupted = await tasksDb.find((t) => t.status === 'developing');
    await recoverInterruptedConflictRuns();
    for (const task of interrupted) {
      if (task.workflowRunId) { await recoverOrphanedWorkflowStepTask(task); continue; }
      try {
        const project = await getProject(task.projectId);
        if (!task.sessionId) {
          await settleFailed(task, project, 'Interactive terminal session ended before its CLI session id was recorded. Start the task again to open a new session.');
          continue;
        }
        await pauseTerminalTask(task, project, task.sessionId);
      } catch (error) {
        // Most likely the project's registry entry is gone. Nothing left to settle it against.
        await requireTaskUpdate(task.id, { status: 'failed', failureReason: `Could not recover after restart: ${(error as Error).message}` }).catch(() => undefined);
      }
    }
  }

  /** Pauses a terminal Task whose CLI is no longer running — commits its work, then settles it 'stopped' (resumable), or 'failed' if the commit fails. */
  async function pauseTerminalTask(task: TaskRecord, project: ProjectRecord, sessionId: string): Promise<void> {
    try {
      await commitTaskWork(task, project);
      await appendTurn(task.id, { role: 'result', content: 'Interactive CLI session paused.', at: new Date().toISOString() });
      await settleStopped(task, project, sessionId);
    } catch (error) {
      await settleFailed(task, project, (error as Error).message);
    }
  }

  async function runTerminalTask(
    task: TaskRecord,
    project: ProjectRecord,
    template: TemplateRecord,
    resumeSessionId: string | null = null,
    prompt: string | null = task.description,
    /** Distinguishes a Task's original description from a later answer to a blocked question, so a chat-style UI can render them differently — see web/src/ui/DetailsPanel.tsx and answerTask. */
    role: 'prompt' | 'answer' = 'prompt',
    rejectLaunchFailure = false,
  ): Promise<boolean> {
    if (prompt !== null) await appendTurn(task.id, { role, content: prompt, at: new Date().toISOString() });
    const cwd = taskWorkingDirectory(project, task);
    try {
      const executor = task.sessionExecutor ?? await getExecutor(task.executorId);
      if (!executor) throw new ExecutorNotFoundError();
      if (executor.kind !== 'claude-cli' && executor.kind !== 'codex-cli') throw new ExecutorNotSupportedError({ ...executor, label: task.executorId });
      if (!task.sessionExecutor) {
        const updated = await requireTaskUpdate(task.id, { sessionExecutor: { kind: executor.kind, bin: executor.bin, env: executor.env } });
        emit({ type: 'task', task: updated });
      }
      if (project.repositoryUrl && (!task.branch || await currentBranch(cwd) !== task.branch)) {
        throw new Error('The checked-out branch no longer matches this task. Restore its branch or start a new task.');
      }
      let sessionId = resumeSessionId ?? task.sessionId;
      if (executor.kind === 'claude-cli' && !sessionId) {
        sessionId = randomUUID();
        const updated = await requireTaskUpdate(task.id, { sessionId });
        emit({ type: 'task', task: updated });
      }
      let setup = task.sessionSetup;
      if (!setup) {
        const stepPermissions = task.workflowRunId ? await resolveStepPermissions(task, task.manager) : null;
        const testing = testingToolsAllowed(task, stepPermissions);
        const persona = await buildAppendSystemPrompt(template, task.skillIds, task.preloadSkillIds);
        setup = {
          systemPrompt: testing ? [persona, TESTING_TOOL_INSTRUCTIONS].filter(Boolean).join('\n\n') : persona,
          disallowedTools: stepPermissions ? stepPermissions.disallowedTools : resolveDisallowedTools(task.kind, task.manager),
          readOnly: stepPermissions ? stepPermissions.readOnly : task.kind === 'plan',
          testing,
          ...(stepPermissions?.canRunCommands ? { canRunCommands: true } : {}),
        };
        const updated = await requireTaskUpdate(task.id, { sessionSetup: setup });
        emit({ type: 'task', task: updated });
      }
      const planInstructions = task.kind !== 'plan' ? undefined
        : isPlanAndBugsSession(task) ? PLAN_AND_BUGS_INSTRUCTIONS
        : isBugReportSession(task) ? BUG_REPORT_INSTRUCTIONS : await buildPlanningInstructions(project);
      let ownedSessionId = sessionId;
      claimConversation(ownedSessionId, task.id);
      try { terminalSessions.start({
        taskId: task.id,
        kind: executor.kind,
        bin: executor.bin,
        cwd,
        ...await sessionGithub(project, executor.env),
        autonomy: task.autonomy,
        systemPrompt: setup.systemPrompt,
        disallowedTools: setup.disallowedTools,
        readOnly: setup.readOnly,
        canRunCommands: setup.canRunCommands,
        mcpServers: await sessionMcpServers(task, setup.testing),
        readOnlyDirs: sessionReadOnlyDirs(task),
        prompt: prompt === null ? '' : composeInteractivePrompt(prompt, task.kind, task.branch, planInstructions),
        sessionId,
        resume: Boolean(resumeSessionId),
        onSessionId: (discoveredSessionId) => {
          if (!ownedSessionId) { claimConversation(discoveredSessionId, task.id); ownedSessionId = discoveredSessionId; }
          void requireTaskUpdate(task.id, { sessionId: discoveredSessionId })
            .then((updated) => emit({ type: 'task', task: updated }))
            .catch((error) => console.error(`Failed to record terminal session id for ${task.id}:`, error));
        },
        onExit: (exitCode, signal, exitedSessionId) => {
          releaseConversation(ownedSessionId ?? exitedSessionId, task.id);
          void (async () => {
            if (abortedStartTasks.delete(task.id)) return;
            const resultSessionId = exitedSessionId ?? sessionId ?? '';
            const stopped = stoppedTasks.delete(task.id);
            if (task.workflowRunId) {
              await settleWorkflowStepTaskExit(task, project, stopped, exitCode, resultSessionId);
              return;
            }
            if (stopped) {
              await settleStopped(task, project, exitedSessionId);
              return;
            }
            if (exitCode !== 0) {
              await settleFailed(task, project, `Interactive CLI exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}.`);
              return;
            }
            // A plain CLI exit only pauses the Task — resumable via the "Resume saved session" action, exactly like an explicit Stop.
            await pauseTerminalTask(task, project, resultSessionId);
          })().catch((error) => console.error(`Failed to settle terminal task ${task.id}:`, error));
        },
      }); } catch (error) { releaseConversation(ownedSessionId, task.id); throw error; }
      const running = await requireTaskUpdate(task.id, {
        runtimeStatus: 'running',
        runtimeWaitingReason: null,
        runtimeStatusChangedAt: new Date().toISOString(),
      });
      emit({ type: 'task', task: running });
      return true;
    } catch (error) {
      if (rejectLaunchFailure) {
        abortedStartTasks.add(task.id);
        if (!terminalSessions.stop(task.id)) abortedStartTasks.delete(task.id);
        throw error;
      }
      await settleFailed(task, project, (error as Error).message);
      return false;
    }
  }

  async function settleDone(task: TaskRecord, project: ProjectRecord, result: ClaudeTurnResult, tokenUsage: TokenUsage): Promise<void> {
    const updated = await requireTaskUpdate(task.id, {
      status: 'done',
      runtimeStatus: task.executionMode === 'terminal' ? 'completed' : task.runtimeStatus,
      runtimeWaitingReason: null,
      runtimeStatusChangedAt: task.executionMode === 'terminal' ? new Date().toISOString() : task.runtimeStatusChangedAt,
      sessionId: result.sessionId || task.sessionId,
      completedAt: new Date().toISOString(),
      tokenUsage,
    });
    if (updated.workflowRunId) { await finalizeWorkflowStepTask(updated, project); return; }
    // Raised before the project frees up (removeActiveTask, below) — same ordering rationale as
    // the emit sequencing below. A follow-up/resume of this exact conversation hasn't started yet
    // (this Task just settled), so resolving needs_input/failed first can never clobber a fresher one.
    await resolveTaskNotifications(updated, ['task.needs_input', 'task.failed']);
    const title = updated.kind === 'plan' && updated.planningSessionNumber
      ? `${isPlanAndBugsSession(updated) ? 'Plan & bugs' : isBugReportSession(updated) ? 'Bug report' : 'Planning'} session #${updated.planningSessionNumber} finished`
      : `Task completed: ${firstLine(updated.description)}`;
    await raiseNotification({ kind: 'task.completed', subject: taskSubject(updated), title, description: result.message.trim() });
    const updatedProject = await removeActiveTask(project.id, task.id);
    emit({ type: 'project', project: updatedProject });
    emit({ type: 'task', task: updated });
    if (updated.kind === 'plan') await maybeAutoCompletePlanningSession(updated.projectId, updated.planningSessionNumber);
    if (updated.planItemId) await syncPlanItem(updated.planItemId, updated);
    await cleanupWorktree(project, updated);
    await advanceQueueIfIdle(project.id);
  }

  /** A person intentionally stopped this run. Keep it resumable/open without producing failure UI or a critical Notification. */
  async function settleStopped(task: TaskRecord, project: ProjectRecord, sessionId?: string): Promise<void> {
    const updated = await requireTaskUpdate(task.id, {
      status: 'stopped',
      runtimeStatus: task.executionMode === 'terminal' ? 'stopped' : task.runtimeStatus,
      runtimeWaitingReason: null,
      runtimeStatusChangedAt: task.executionMode === 'terminal' ? new Date().toISOString() : task.runtimeStatusChangedAt,
      failureReason: null,
      ...(sessionId ? { sessionId } : {}),
    });
    if (updated.workflowRunId) { await finalizeWorkflowStepTask(updated, project); return; }
    await resolveTaskNotifications(updated, ['task.needs_input']);
    const updatedProject = await removeActiveTask(project.id, task.id);
    emit({ type: 'project', project: updatedProject });
    emit({ type: 'task', task: updated });
    if (updated.kind === 'plan') await maybeAutoCompletePlanningSession(updated.projectId, updated.planningSessionNumber);
    if (updated.planItemId) await syncPlanItem(updated.planItemId, updated);
    await cleanupWorktree(project, updated);
    await advanceQueueIfIdle(project.id);
  }

  async function settleFailed(task: TaskRecord, project: ProjectRecord, exitReason: string, sessionId?: string, tokenUsage?: TokenUsage): Promise<void> {
    // A turn error the CLI reported through its hook (a usage limit, say) explains the exit better than the exit code does.
    const reported = await tasksDb.get(task.id);
    const turnError = reported?.runtimeStatus === 'failed' ? reported.runtimeWaitingReason : null;
    const reason = turnError && !exitReason.includes(turnError) ? `${exitReason} The CLI reported: ${turnError}` : exitReason;
    const updated = await requireTaskUpdate(task.id, {
      status: 'failed',
      runtimeStatus: task.executionMode === 'terminal' ? 'failed' : task.runtimeStatus,
      runtimeWaitingReason: task.executionMode === 'terminal' ? reason : task.runtimeWaitingReason,
      runtimeStatusChangedAt: task.executionMode === 'terminal' ? new Date().toISOString() : task.runtimeStatusChangedAt,
      failureReason: reason,
      ...(sessionId ? { sessionId } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
    });
    if (updated.workflowRunId) { await finalizeWorkflowStepTask(updated, project); return; }
    // Raised before the project frees up (removeActiveTask, below) — same ordering rationale as
    // settleDone's own emit sequencing (see requireTaskUpdate above).
    await resolveTaskNotifications(updated, ['task.needs_input']);
    await raiseNotification({
      kind: 'task.failed',
      subject: taskSubject(updated),
      title: `Task failed: ${firstLine(updated.description)}`,
      description: reason,
    });
    const updatedProject = await removeActiveTask(project.id, task.id);
    emit({ type: 'project', project: updatedProject });
    emit({ type: 'task', task: updated });
    if (updated.kind === 'plan') await maybeAutoCompletePlanningSession(updated.projectId, updated.planningSessionNumber);
    if (updated.planItemId) await syncPlanItem(updated.planItemId, updated);
    await cleanupWorktree(project, updated);
    await advanceQueueIfIdle(project.id);
  }

  /** Updates a linked item and applies the same lifecycle effects for direct Tasks and WorkflowRuns. */
  async function syncLinkedPlanItem(
    planItemId: string,
    patch: Parameters<typeof updatePlanItem>[1] | ((item: PlanItemRecord) => Parameters<typeof updatePlanItem>[1]),
    checkCompletion = true,
  ): Promise<PlanItemRecord | null> {
    let item: PlanItemRecord;
    try {
      item = await getPlanItem(planItemId);
    } catch (error) {
      if (error instanceof PlanItemNotFoundError) return null;
      throw error;
    }
    const updated = await updatePlanItem(planItemId, typeof patch === 'function' ? patch(item) : patch);
    emit({ type: 'planItem', planItem: updated });
    if (checkCompletion && item.status === 'pending' && updated.status !== 'pending') await maybeAutoCompleteForItem(updated);
    return updated;
  }

  /** Mirrors a linked PlanItem's status onto its running Task's own — see PlanItemRecord's doc comment in domain/types.ts. */
  async function syncPlanItem(planItemId: string, task: TaskRecord, statusOverride?: PlanItemRecord['status']): Promise<void> {
    // The first run records the worker it used, which locks the item's executor for any re-run.
    await syncLinkedPlanItem(planItemId, (item) => ({
      status: statusOverride ?? task.status,
      taskIds: item.taskIds.includes(task.id) ? item.taskIds : [...item.taskIds, task.id],
      executorId: item.executorId ?? task.executorId,
    }));
  }

  /** The next number for a new planning session in this Project: one past the highest any planning Task there already has. */
  async function nextPlanningSessionNumber(projectId: string): Promise<number> {
    const numbers = (await tasksDb.find((t) => t.projectId === projectId && t.kind === 'plan')).map((t) => t.planningSessionNumber ?? 0);
    return Math.max(0, ...numbers) + 1;
  }

  // ==========================================================================================
  // Workflow run engine (task 3.012) — turns a Catalog Workflow into a running WorkflowRun: an
  // ordered sequence of Catalog-agent StepRuns sharing one git worktree/branch, gated by approvals
  // and review loops, finishing in the built-in Complete stage (commit, push, raise PR).
  // ==========================================================================================

  function findStep(run: WorkflowRunRecord, stepId: string): WorkflowStep | undefined {
    return run.workflowSnapshot.steps.find((step) => step.id === stepId);
  }

  function stepIndex(run: WorkflowRunRecord, stepId: string): number {
    return run.workflowSnapshot.steps.findIndex((step) => step.id === stepId);
  }

  async function requireWorkflowRun(id: string): Promise<WorkflowRunRecord> {
    const run = await workflowRunsDb.get(id);
    if (!run) throw new WorkflowRunNotFoundError();
    return run;
  }

  /** Every StepRunRecord for one (run, step) pair, oldest round first. */
  async function allStepRuns(runId: string, stepId: string): Promise<StepRunRecord[]> {
    const rounds = await stepRunsDb.find((s) => s.runId === runId && s.stepId === stepId);
    return rounds.slice().sort((a, b) => a.round - b.round);
  }

  async function latestStepRun(runId: string, stepId: string): Promise<StepRunRecord | undefined> {
    const rounds = await allStepRuns(runId, stepId);
    return rounds.at(-1);
  }

  /**
   * The workspace a new run is accepted with, from fast local checks only. A run on a new branch
   * (`createBranch`) gets its own worktree path — its branch and base are decided later, during
   * start-up (`runStartup`) — and `priorBranch`'s name when `item` already had a run (a retry/resume
   * reuses it). A conflict run's worktree, run-local branch and base are all known up front. Without
   * `createBranch` the run works in place: the Project's own directory, on whatever branch is checked
   * out there (none for a repository-less Project) — refused while anything else is already working
   * in that directory (see `assertProjectFolderFree`).
   */
  async function acceptRunWorkspace(
    project: ProjectRecord,
    item: PlanItemRecord,
    createBranch: boolean,
    runId: string,
    priorBranch?: string,
  ): Promise<{ kind: StartupKind; baseBranch?: string; branch?: string; worktreePath?: string }> {
    const projectDir = projectAbsolutePath(project);
    const worktreePath = projectWorktreePath(project, `run-${item.id}`);
    if (item.prConflict) {
      return { kind: 'conflict', baseBranch: `origin/${item.prConflict.baseBranch}`, branch: conflictRunBranch(item.prConflict, runId), worktreePath };
    }
    if (!createBranch) {
      await assertProjectFolderFree(project, terminalSessions);
      return { kind: 'in-place', ...(project.repositoryUrl ? { branch: await currentBranch(projectDir) } : {}) };
    }
    if (!project.repositoryUrl) throw new BranchRequiresRepositoryError(project);
    return { kind: 'branch', ...(priorBranch ? { branch: priorBranch } : {}), worktreePath };
  }

  /**
   * The workflow a regular run uses: the explicit choice, else the Project's own, else its Building Type's first
   * slot (configured in the Catalog, defaulting to the type's built-in), else the Catalog default. Per-step agent
   * choices configured for the type are applied to whichever workflow runs.
   */
  async function resolveRunWorkflow(project: ProjectRecord, workflowId?: string): Promise<WorkflowRecord | undefined> {
    const typeId = project.typeId ?? 'software';
    const chosen = workflowId ? await getWorkflow(workflowId)
      : project.workflowId ? await resolveWorkflowForProject(project)
        : (await primarySlotWorkflow(typeId)) ?? (await getDefaultWorkflow());
    if (!chosen && !workflowId) throw new NoWorkflowAvailableError();
    return chosen ? withStepAgents(typeId, chosen) : undefined;
  }

  /**
   * Accepts a start: runs the fast local checks, records a WorkflowRun in the `starting` state and
   * moves its item out of Planning, then returns the run at once. The slow setup — deciding the
   * stack target, naming and creating the branch and worktree, installing the CLI hooks, launching
   * the first step's agent — continues in the background as the run's visible start-up steps (see
   * `launchStartup`). Only the checks and the concurrency-slot claim hold the Project's lock.
   * `executePlanItem`'s real implementation as of task 3.012; the chosen Workflow is snapshotted
   * (`options.workflowId`, else the Project's resolved one).
   */
  async function startWorkflowRun(item: PlanItemRecord, options: StartPlanItemOptions = {}): Promise<WorkflowRunRecord> {
    const run = await withProjectLock(item.projectId, () => acceptWorkflowRun(item, options));
    launchStartup(run.id, item.id);
    return run;
  }

  /** Notes left for steps the chosen workflow doesn't have can never be sent, so they go. */
  async function dropStepNotesOutside(item: PlanItemRecord, stepIds: string[]): Promise<void> {
    await withStepNotesLock(item.id, async () => {
      const current = (await planItemsDb.get(item.id)) ?? item;
      const kept = keepStepNotesFor(current.stepNotes, stepIds);
      if (Object.keys(kept).length === Object.keys(current.stepNotes ?? {}).length) return;
      emit({ type: 'planItem', planItem: await updatePlanItem(item.id, { stepNotes: kept }) });
    });
  }

  /** Runs `work` after every earlier note write for the same task, so read-modify-write updates of `stepNotes` never overwrite each other. */
  const stepNotesQueues = new Map<string, Promise<unknown>>();
  function withStepNotesLock<T>(planItemId: string, work: () => Promise<T>): Promise<T> {
    const run = (stepNotesQueues.get(planItemId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    stepNotesQueues.set(planItemId, tail);
    void tail.then(() => { if (stepNotesQueues.get(planItemId) === tail) stepNotesQueues.delete(planItemId); });
    return run;
  }

  async function acceptWorkflowRun(item: PlanItemRecord, options: StartPlanItemOptions): Promise<WorkflowRunRecord> {
    const project = await getProject(item.projectId);
    // A conflict-resolution run starts beside whatever else is running: it never waits for a slot.
    if (!item.prConflict) await claimConcurrencySlot(project, 'execute', terminalSessions);

    const workflow = item.prConflict ? conflictResolutionWorkflow(item.prConflict)
      : item.testingSetup ? testingSetupWorkflow()
        : options.workflow ?? await resolveRunWorkflow(project, options.workflowId);
    if (!workflow) throw new WorkflowNotFoundError();
    if (item.testingSetup) assertSetupWorkflowSafe(workflow);
    const skippedStepIds = item.testingSetup || item.prConflict ? [] : resolveSkippedStepIds(workflow, options.skippedStepIds);
    const firstStep = workflow.steps.find((step) => !skippedStepIds.includes(step.id));
    if (!firstStep) throw new Error(`${namedAtStart('workflow', workflow.name)} has no steps to run`);
    await dropStepNotesOutside(item, workflow.steps.map((step) => step.id));

    const executor = (options.executorId ? await getExecutor(options.executorId) : undefined)
      ?? (item.executorId ? await getExecutor(item.executorId) : undefined)
      ?? (await getDefaultExecutor());
    if (!executor) throw new ExecutorNotFoundError();
    if (!isInteractiveCli(executor)) throw new ExecutorNotSupportedError(executor);

    // Reject invalid first-step configuration before allocating a run or changing its item.
    await assertSkillsUsable(firstStep.skillIds);
    const firstStepExecutor = (firstStep.executorId ? await getExecutor(firstStep.executorId) : undefined) ?? executor;
    if (!isInteractiveCli(firstStepExecutor)) throw new ExecutorNotSupportedError(firstStepExecutor);

    const priorRun = item.workflowRunId ? await workflowRunsDb.get(item.workflowRunId) : undefined;
    const runId = randomUUID();
    // A regression never reuses the earlier run's branch: round 2 starts on a new one from the base branch.
    const workspace = await acceptRunWorkspace(project, item, options.createBranch ?? Boolean(project.repositoryUrl), runId, options.regression ? undefined : priorRun?.branch);

    const now = new Date().toISOString();
    const run: WorkflowRunRecord = {
      id: runId,
      projectId: project.id,
      planItemId: item.id,
      workflowId: workflow.id,
      workflowSnapshot: snapshotWorkflow(workflow),
      status: 'starting',
      startup: planStartup(workspace.kind, workspace.kind === 'branch' && Boolean(workspace.branch)),
      currentStepId: firstStep.id,
      ...(workspace.baseBranch ? { baseBranch: workspace.baseBranch } : {}),
      ...(workspace.branch ? { branch: workspace.branch } : {}),
      ...(workspace.worktreePath ? { worktreePath: workspace.worktreePath } : {}),
      executorId: executor.id,
      prUrl: null,
      completionReport: null,
      attentionReason: null,
      loopRoundAllowance: 0,
      ...(skippedStepIds.length ? { skippedStepIds } : {}),
      ...(options.regression ? { regression: { roundOffsets: options.regression.roundOffsets } } : {}),
      ...(item.testingSetup ? { testingSetup: { mode: item.testingSetup.mode, evidence: null } } : {}),
      ...(item.prConflict ? { prConflict: { ...item.prConflict, outcome: null, detail: null } } : {}),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const priorItem = await getPlanItem(item.id);
    let linkedItem: PlanItemRecord;
    let runInserted = false;
    try {
      await workflowRunsDb.insert(run);
      runInserted = true;
      // Once the first step Task lands in taskIds, its executor assignment is locked.
      const updated = await syncLinkedPlanItem(item.id, {
        workflowRunId: run.id, status: 'developing', executorId: executor.id, waiting: undefined,
        // A reopened bug returns to the board with its new regression recorded in the same write.
        ...(options.regression ? { bug: appendRegression(item.bug, options.regression.entry), archived: false } : {}),
      }, false);
      if (!updated) throw new PlanItemNotFoundError();
      linkedItem = updated;
      await recordStepsSkippedAtStart(run);
    } catch (error) {
      // A rejected start is not an execution transition. Restore the exact item placement.
      for (const stepRun of await stepRunsDb.find((stepRun) => stepRun.runId === run.id)) await stepRunsDb.delete(stepRun.id);
      await workflowRunsDb.delete(run.id);
      const restored = await planItemsDb.update(item.id, {
        workflowRunId: priorItem.workflowRunId, status: priorItem.status,
        executorId: priorItem.executorId, taskIds: priorItem.taskIds, waiting: priorItem.waiting, updatedAt: priorItem.updatedAt,
        ...(options.regression ? { bug: priorItem.bug, archived: priorItem.archived } : {}),
      });
      if (restored) emit({ type: 'planItem', planItem: restored });
      if (runInserted) emit({ type: 'workflowRunDeleted', runId: run.id, projectId: project.id });
      throw error;
    }
    emit({ type: 'workflowRun', run: (await workflowRunsDb.get(run.id)) ?? run });
    try {
      await maybeAutoCompleteForItem(linkedItem);
    } catch (error) {
      // Execution has already been accepted. Do not turn an archive-write failure into a
      // rejected start response while the task is starting; keep the card and report the error.
      console.error(`Failed to complete planning session ${linkedItem.planningRef?.session}:`, error);
      if (linkedItem.planningRef) emit({
        type: 'planningCompletionError', projectId: project.id,
        session: linkedItem.planningRef.session, message: (error as Error).message,
      });
    }
    return run;
  }

  // ---- A run's start-up: the slow setup after a start is accepted, as visible steps ----

  /** Resolves with a release function once every earlier holder of this Project's repository lock has released it. */
  function acquireRepoLock(projectId: string): Promise<() => void> {
    const prior = repoLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    repoLocks.set(projectId, prior.then(() => held));
    return prior.then(() => release);
  }

  /** Starts a run's start-up in the background, after the previous start-up of the same item (if any) has finished cleaning up. Never rejects. */
  function launchStartup(runId: string, planItemId: string): void {
    let cancel!: () => void;
    const onCancel = new Promise<void>((resolve) => { cancel = resolve; });
    const handle: StartupHandle = { cancelled: false, cancel: () => { handle.cancelled = true; cancel(); }, onCancel, settled: Promise.resolve() };
    const previous = startupTails.get(planItemId) ?? Promise.resolve();
    handle.settled = previous
      .then(() => runStartup(runId, handle))
      .catch((error) => rescueStartup(runId, error))
      .finally(() => {
        if (startups.get(runId) === handle) startups.delete(runId);
        if (startupTails.get(planItemId) === handle.settled) startupTails.delete(planItemId);
      });
    startups.set(runId, handle);
    startupTails.set(planItemId, handle.settled);
  }

  /** A start-up that threw outside its steps (a record vanished mid-way, say) still ends the run Failed rather than leaving it Starting forever. */
  async function rescueStartup(runId: string, error: unknown): Promise<void> {
    console.error(`Failed to start run ${runId}:`, error);
    const run = await workflowRunsDb.get(runId).catch(() => undefined);
    if (run?.status !== 'starting' || !run.startup) return;
    const stepId = (currentStartupStep(run.startup) ?? run.startup.steps.find((step) => step.state === 'pending') ?? run.startup.steps[0]!).id;
    await failStartup(runId, run.startup, stepId, startupErrorReason(error)).catch((cause) => console.error(`Failed to settle run ${runId}:`, cause));
  }

  /** Resolves once the run's in-flight start-up (if any) has finished or cleaned up after a Stop — what tests await instead of polling. */
  function whenStartupSettled(runId: string): Promise<void> {
    return startups.get(runId)?.settled ?? Promise.resolve();
  }

  /** Writes `patch` to a run still starting; null (nothing written) once a Stop has cancelled the start-up. */
  async function patchStartingRun(handle: StartupHandle, runId: string, patch: Partial<WorkflowRunRecord>): Promise<WorkflowRunRecord | null> {
    if (handle.cancelled) return null;
    const updated = await workflowRunsDb.update(runId, { ...patch, updatedAt: new Date().toISOString() });
    if (updated) emit({ type: 'workflowRun', run: updated });
    return updated ?? null;
  }

  /**
   * Runs a `starting` run's steps in order, persisting each step's state as it goes. A failure ends
   * the run Failed (`failStartup`); a Stop (`handle.cancelled`) cleans up whatever this attempt
   * created. Holds no Project or run lock, so a Stop is never blocked behind it.
   */
  async function runStartup(runId: string, handle: StartupHandle): Promise<void> {
    const initial = await workflowRunsDb.get(runId);
    if (!initial) return;
    if (handle.cancelled) { await settleCancelledStartup(runId); return; }
    if (initial.status !== 'starting' || !initial.startup || !initial.currentStepId) return;

    const project = await getProject(initial.projectId);
    const item = await getPlanItem(initial.planItemId);
    const firstStep = findStep(initial, initial.currentStepId)!;
    const projectDir = projectAbsolutePath(project);
    let startup = normalizeStartup(initial.startup);
    const kind = startupKindOf(startup);
    let baseBranch = initial.baseBranch;
    let branch = initial.branch;
    let current = startup.steps[0]!.id;
    let releaseRepo: (() => void) | undefined;
    let launched = false;
    try {
      for (const { id } of startup.steps) {
        current = id;
        startup = beginStartupStep(startup, id);
        if (!(await patchStartingRun(handle, runId, { startup }))) break;
        let patch: Partial<WorkflowRunRecord> = {};
        switch (id) {
          case 'name':
            releaseRepo = await acquireRepoLock(project.id);
            // Every run branches from the Project's own branch; a resumed start-up keeps the base it persisted.
            baseBranch ??= await currentBranch(projectDir);
            if (!startup.reuseBranch) branch = await resolveBranchName({ title: item.title, branchType: initial.workflowSnapshot.branchType ?? null, planningRef: item.planningRef ?? null }, projectDir);
            patch = { branch, baseBranch };
            break;
          case 'worktree':
            releaseRepo ??= await acquireRepoLock(project.id);
            if (handle.cancelled) break;
            await createRunWorktree(initial, project, kind === 'conflict' ? undefined : baseBranch);
            releaseRepo(); releaseRepo = undefined;
            break;
          case 'hooks':
            if (!handle.cancelled) await installCliHooks(initial.worktreePath!);
            break;
          case 'launch':
            if (handle.cancelled) break;
            await startStepTask((await workflowRunsDb.get(runId))!, firstStep, 1, {}, true);
            launched = true;
            break;
        }
        if (id === 'launch' && !launched) break;
        startup = finishStartupStep(startup, id);
        if (id === 'launch') {
          // The agent is running whatever a Stop did meanwhile, so record it even when cancelled: a later Resume must continue the session, not set the run up again.
          const recorded = await workflowRunsDb.update(runId, { startup, updatedAt: new Date().toISOString() });
          if (recorded) emit({ type: 'workflowRun', run: recorded });
        } else {
          if (handle.cancelled) break;
          if (!(await patchStartingRun(handle, runId, { ...patch, startup }))) break;
        }
      }
    } catch (error) {
      if (!handle.cancelled) { await failStartup(runId, startup, current, startupErrorReason(error)); return; }
    } finally {
      releaseRepo?.();
    }
    if (!handle.cancelled) return;
    // A Stop landed while the agent was launching: the session is live, so stop it like a running run's.
    const stopped = current === 'launch' ? await workflowRunsDb.get(runId) : undefined;
    if (stopped?.status === 'running') { await haltWorkflowRun(stopped); return; }
    await settleCancelledStartup(runId);
  }

  /** Creates the run's worktree: on its new branch off `baseBranch`, or (a conflict run) at the pull request's head. Replaces anything an earlier attempt left at the path. */
  async function createRunWorktree(run: WorkflowRunRecord, project: ProjectRecord, baseBranch: string | undefined): Promise<void> {
    const projectDir = projectAbsolutePath(project);
    const worktreePath = run.worktreePath!;
    if (existsSync(worktreePath)) {
      await removeRunWorktree(projectDir, worktreePath).catch((error) => console.error(`Failed to clear the old worktree of run ${run.id}: ${(error as Error).message}`));
    }
    if (run.prConflict) {
      const headSha = await fetchPrHead(project, run.prConflict.number);
      await createWorktree(projectDir, worktreePath, run.branch!, headSha);
      return;
    }
    const branch = (await workflowRunsDb.get(run.id))?.branch ?? run.branch!;
    await createWorktreeForBranch(projectDir, worktreePath, branch, baseBranch ?? branch);
  }

  /** A start-up error as a short reason fit for the card: the projects folder and the home directory are abbreviated, so no absolute path of the machine reaches the screen. */
  function startupErrorReason(error: unknown): string {
    return ((error as Error)?.message ?? String(error)).split(PROJECTS_DIR).join('<projects>').split(homedir()).join('~');
  }

  /**
   * Undoes what a start-up attempt created and returns the run fields to clear: its worktree (and the
   * hooks inside it), a branch the attempt itself created (never one reused from an earlier run, nor
   * the Project's own branch), and any first-step Task rows from a launch that did not complete.
   * Best-effort — a cleanup failure never hides the failure or Stop that caused it.
   */
  async function cleanupStartup(run: WorkflowRunRecord): Promise<Partial<WorkflowRunRecord>> {
    if (!run.startup) return {};
    const startup = normalizeStartup(run.startup);
    const kind = startupKindOf(startup);
    const project = await getProject(run.projectId);
    const projectDir = projectAbsolutePath(project);
    if (run.worktreePath && existsSync(run.worktreePath)) {
      await removeRunWorktree(projectDir, run.worktreePath).catch((error) => console.error(`Failed to remove worktree for run ${run.id}: ${(error as Error).message}`));
    }
    let clear: Partial<WorkflowRunRecord> = {};
    if (kind !== 'in-place' && !startup.reuseBranch && run.branch) {
      if (await localBranchExists(projectDir, run.branch).catch(() => false)) {
        await git(projectDir, ['branch', '-D', run.branch]).catch((error) => console.error(`Failed to remove branch for run ${run.id}: ${(error as Error).message}`));
      }
      if (kind === 'branch') clear = { branch: undefined };
    }
    await rollbackLaunchedTasks(run, project).catch((error) => console.error(`Failed to roll back tasks of run ${run.id}:`, error));
    await removeRunOutputs(run);
    return clear;
  }

  /** Deletes the first-step Task, its StepRun and bookkeeping that a launch created before it failed or was cancelled; the steps skipped at start stay. */
  async function rollbackLaunchedTasks(run: WorkflowRunRecord, project: ProjectRecord): Promise<void> {
    const createdTasks = await tasksDb.find((task) => task.workflowRunId === run.id);
    for (const stepRun of await stepRunsDb.find((stepRun) => stepRun.runId === run.id && stepRun.taskId !== null)) await stepRunsDb.delete(stepRun.id);
    if (!createdTasks.length) return;
    for (const task of createdTasks) {
      await taskContextsDb.delete(task.id);
      await tasksDb.delete(task.id);
      emit({ type: 'taskDeleted', id: task.id, projectId: project.id });
    }
    const createdIds = new Set(createdTasks.map((task) => task.id));
    const item = await getPlanItem(run.planItemId).catch(() => null);
    if (item) {
      const restored = await planItemsDb.update(item.id, { taskIds: item.taskIds.filter((id) => !createdIds.has(id)) });
      if (restored) emit({ type: 'planItem', planItem: restored });
    }
    const restoredProject = await patchProjectWith(project.id, async (current) => ({
      ...await reconcileActiveTasks(activeTaskIdsOf(current).filter((id) => !createdIds.has(id))),
      taskCount: Math.max(0, current.taskCount - createdTasks.length),
    }));
    emit({ type: 'project', project: restoredProject });
  }

  /** Ends a start-up that a step failed: cleans up, marks the run Failed with the step and its reason, and tells the person. */
  async function failStartup(runId: string, startup: RunStartup, stepId: RunStartupStepId, reason: string): Promise<void> {
    const run = await workflowRunsDb.get(runId);
    if (!run) return;
    const clear = await cleanupStartup(run).catch((error): Partial<WorkflowRunRecord> => {
      console.error(`Failed to clean up run ${runId}:`, error);
      return {};
    });
    const failed = await workflowRunsDb.update(runId, {
      ...clear, status: 'failed', startup: failStartupStep(startup, stepId, reason), attentionReason: null, updatedAt: new Date().toISOString(),
    });
    if (!failed) return;
    emit({ type: 'workflowRun', run: failed });
    await syncPlanItemForRun(failed);
    const stepName = failed.startup?.steps.find((step) => step.id === stepId)?.name ?? 'Start-up';
    await raiseAttentionNotification(failed, 'workflow.needs_attention', 'Task failed to start', `"${stepName}" failed: ${reason}`);
    await advanceQueueIfIdle(failed.projectId);
  }

  /** After a Stop (or a restart) during start-up: undoes the attempt's setup and leaves the start-up ready to run again from its first step. */
  async function settleCancelledStartup(runId: string): Promise<void> {
    const run = await workflowRunsDb.get(runId);
    if (!run?.startup) return;
    const clear = await cleanupStartup(run);
    const updated = await workflowRunsDb.update(runId, { ...clear, startup: resetStartup(run.startup), updatedAt: new Date().toISOString() });
    if (updated) emit({ type: 'workflowRun', run: updated });
  }

  /**
   * Runs a run's start-up again from its first step — the Retry of a start that failed or was left
   * unfinished by a restart, and the Resume of one stopped during it. Claims a concurrency slot like
   * any start, so it can be refused while the Project is full.
   */
  async function restartStartup(run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    const restarted = await withProjectLock(run.projectId, async () => {
      const project = await getProject(run.projectId);
      if (!run.prConflict) await claimConcurrencySlot(project, 'execute', terminalSessions);
      const startup = run.startup!;
      // A run left in needs-attention already owns the folder it works in.
      if (startupKindOf(startup) === 'in-place' && run.status !== 'needs-attention') await assertProjectFolderFree(project, terminalSessions);
      const updated = await workflowRunsDb.update(run.id, {
        status: 'starting', startup: resetStartup(startup), attentionReason: null, completedAt: null, updatedAt: new Date().toISOString(),
      });
      if (!updated) throw new WorkflowRunNotFoundError();
      emit({ type: 'workflowRun', run: updated });
      await syncPlanItemForRun(updated);
      return updated;
    });
    launchStartup(run.id, run.planItemId);
    return restarted;
  }

  /** Settles every run the previous daemon left in `starting`: its partial setup is cleaned up (never reused) and the run needs attention, so Retry sets it up again from the first step. */
  async function recoverInterruptedStartingRuns(): Promise<void> {
    for (const run of await workflowRunsDb.find((candidate) => candidate.status === 'starting')) {
      try {
        const clear = await cleanupStartup(run);
        const reason = 'The daemon restarted while this task was starting.';
        const running = run.startup ? currentStartupStep(run.startup) : undefined;
        const startup = run.startup && running ? failStartupStep(run.startup, running.id, 'The daemon restarted during this step.') : run.startup;
        const updated = await workflowRunsDb.update(run.id, { ...clear, ...(startup ? { startup } : {}), updatedAt: new Date().toISOString() });
        await setWorkflowRunNeedsAttention(updated ?? run, reason);
      } catch (error) {
        console.error(`Failed to recover run ${run.id} left starting:`, error);
      }
    }
  }

  /** Records each step left out at start as a finished round-1 'skipped' StepRun with no Task, so the stepper, later prompts and the Complete summary read it like any other skip. */
  async function recordStepsSkippedAtStart(run: WorkflowRunRecord): Promise<void> {
    for (const stepId of run.skippedStepIds ?? []) {
      const stepRun: StepRunRecord = {
        id: randomUUID(),
        runId: run.id,
        stepId,
        round: 1,
        taskId: null,
        status: 'skipped',
        summary: `Skipped: ${SKIPPED_AT_START_REASON}`,
        outputs: [],
        verdict: null,
        skippedReason: SKIPPED_AT_START_REASON,
        approval: null,
        createdAt: run.createdAt,
        completedAt: run.createdAt,
      };
      await stepRunsDb.insert(stepRun);
      emit({ type: 'stepRun', stepRun });
    }
  }

  /**
   * The steps whose rounds feed `step`'s prompt, in workflow order: every earlier step, plus every
   * loop-origin step whose loop `step` sits inside (itself included). A later step only has rounds
   * once its loop has sent the run back, so a re-run Development sees the review that sent it back,
   * and a re-run Code Review sees its own earlier findings.
   */
  function historySteps(run: WorkflowRunRecord, step: WorkflowStep): WorkflowStep[] {
    const index = stepIndex(run, step.id);
    return run.workflowSnapshot.steps.filter((candidate, i) =>
      i < index || (candidate.loopBack != null && i >= index && stepIndex(run, candidate.loopBack.toStepId) <= index));
  }

  /** Every `historySteps` step's contribution to `step`'s prompt — full round history for a loop target/origin or any step that has run more than once, latest round only otherwise (task 3.012's prompt spec). */
  async function buildStepHistory(run: WorkflowRunRecord, step: WorkflowStep): Promise<StagePromptHistory[]> {
    const loopTargets = new Set(run.workflowSnapshot.steps.filter((s) => s.loopBack).map((s) => s.loopBack!.toStepId));
    const history: StagePromptHistory[] = [];
    for (const earlier of historySteps(run, step)) {
      const rounds = await allStepRuns(run.id, earlier.id);
      if (rounds.length === 0) continue;
      const showAllRounds = loopTargets.has(earlier.id) || rounds.length > 1;
      const shown = showAllRounds ? rounds : [rounds.at(-1)!];
      history.push({ stageName: earlier.name, rounds: await Promise.all(shown.map((r) => toHistoryRound(run, r))) });
    }
    return history;
  }

  /**
   * The `historySteps` (other than `step` itself) that finished a round after `step`'s previous
   * round `prior` started — each with just that latest round. Step rounds are stored in creation
   * order, so "after" is positional rather than a timestamp comparison.
   */
  async function stagesRerunSince(run: WorkflowRunRecord, step: WorkflowStep, prior: StepRunRecord): Promise<StagePromptHistory[]> {
    const runRounds = await stepRunsDb.find((s) => s.runId === run.id);
    const newer = runRounds.slice(runRounds.findIndex((r) => r.id === prior.id) + 1);
    const updates: StagePromptHistory[] = [];
    for (const earlier of historySteps(run, step)) {
      if (earlier.id === step.id) continue;
      const latest = newer.filter((r) => r.stepId === earlier.id && r.status !== 'running').sort((a, b) => a.round - b.round).at(-1);
      if (latest) updates.push({ stageName: earlier.name, rounds: [await toHistoryRound(run, latest)] });
    }
    return updates;
  }

  /** The latest round of `step` that ran in an earlier run of the same item, or undefined when the step never ran there. */
  async function regressionPriorStepRun(run: WorkflowRunRecord, step: WorkflowStep): Promise<StepRunRecord | undefined> {
    for (const earlier of (await earlierRunsOf(run)).reverse()) {
      const ran = (await allStepRuns(earlier.id, step.id)).filter((stepRun) => stepRun.taskId && stepRun.status !== 'skipped');
      if (ran.length) return ran.at(-1);
    }
    return undefined;
  }

  /** What a regression run tells a step: the previous fix failed, the bug's reasons, and (when the conversation can't be continued) the step's own earlier output. */
  async function regressionStepMessage(run: WorkflowRunRecord, step: WorkflowStep, item: PlanItemRecord, prior: StepRunRecord | undefined, resumed: boolean): Promise<string> {
    let earlierRound: StepHistoryRound | null = null;
    if (prior && !resumed) {
      const priorRun = await workflowRunsDb.get(prior.runId);
      const round = (priorRun?.regression?.roundOffsets[prior.stepId] ?? 0) + prior.round;
      // Saved under this run's folder (the one a step session may read), apart from this run's own rounds of the step.
      earlierRound = { ...(await toHistoryRound(run, prior, { stepId: `prior-${prior.stepId}`, round })), round };
    }
    return buildRegressionMessage({ regressions: item.bug?.regressions ?? [], resumed, requiresVerdict: Boolean(step.loopBack), earlierRound });
  }

  /** One step round as a later prompt shows it: a skipped round shows its reason as its summary, and each output is referenced by its saved file (see stepOutputFiles.ts). `saveAs` files the outputs under another step id and round. */
  async function toHistoryRound(run: WorkflowRunRecord, r: StepRunRecord, saveAs: { stepId: string; round: number } = r): Promise<StepHistoryRound> {
    const paths = await outputFiles.ensureRound({ projectId: run.projectId, runId: run.id, stepId: saveAs.stepId, round: saveAs.round, outputs: r.outputs });
    return {
      round: r.round,
      summary: r.status === 'skipped' ? `(skipped: ${r.skippedReason ?? 'not applicable'})` : (r.summary ?? ''),
      outputs: r.outputs.map((output, index) => ({ ...output, path: paths[index] })),
      verdict: r.verdict,
      approval: r.approval,
    };
  }

  /** The folder of saved earlier outputs a step Task's session may read (never write); none for any other Task. */
  function stepOutputDirs(task: TaskRecord): string[] | undefined {
    return task.workflowRunId ? [outputFiles.runDir(task.projectId, task.workflowRunId)] : undefined;
  }

  /** What a session may read but never edit: the run's saved step outputs plus each attached skill's Catalog directory (outside the task's cwd), none when neither applies. */
  function sessionReadOnlyDirs(task: TaskRecord): string[] | undefined {
    const dirs = [...(stepOutputDirs(task) ?? []), ...skillDirsOf(task.skillIds)];
    return dirs.length ? dirs : undefined;
  }

  /** Deletes a run's saved step outputs. A failure is logged and never blocks the deletion it's part of. */
  async function removeRunOutputs(run: Pick<WorkflowRunRecord, 'projectId' | 'id'>): Promise<void> {
    await outputFiles.removeRun(run.projectId, run.id)
      .catch((error) => console.error(`Couldn't delete the saved step outputs of run ${run.id}:`, error));
  }

  /** Every `planningGap` any step of `run` has raised so far, in step order then round — see BuildStepPromptInput.planningGaps. */
  async function collectPlanningGaps(run: WorkflowRunRecord): Promise<PlanningGapNote[]> {
    const flagged = await stepRunsDb.find((s) => s.runId === run.id && Boolean(s.planningGap));
    const stepNames = new Map(run.workflowSnapshot.steps.map((s) => [s.id, s.name]));
    return flagged
      .sort((a, b) => stepIndex(run, a.stepId) - stepIndex(run, b.stepId) || a.round - b.round)
      .map((s) => ({ stageName: stepNames.get(s.stepId) ?? s.stepId, round: s.round, note: s.planningGap! }));
  }

  /**
   * The CLI session a later round of `step` continues: its latest earlier round's, when that Task
   * recorded a session id, ran on the same executor, and the CLI still has the conversation. A
   * reopened process must actually exit before the next round starts on that conversation.
   */
  async function continuableSession(run: WorkflowRunRecord, step: WorkflowStep, prior: StepRunRecord | undefined, executor: ExecutorProfile): Promise<string | null> {
    const priorTask = prior?.taskId ? await tasksDb.get(prior.taskId) : undefined;
    if (!priorTask?.sessionId || priorTask.executorId !== executor.id) return null;
    const owner = priorTask.sessionExecutor ?? executor;
    if (terminalSessions.sessionExists && !terminalSessions.sessionExists({ kind: owner.kind, env: owner.env, sessionId: priorTask.sessionId })) return null;
    const liveOwner = conversationOwners.get(priorTask.sessionId);
    if (liveOwner) {
      if (!inspectSessions.has(liveOwner) && liveOwner !== priorTask.id) throw new TaskNotFollowableError(await taskName(priorTask));
      const exited = waitForConversationExit(liveOwner);
      if (terminalSessions.has(liveOwner)) terminalSessions.stop(liveOwner);
      await exited;
    }
    return priorTask.sessionId;
  }

  /**
   * Starts one round of one WorkflowStep's Task — the run's step Tasks always reuse the run's own
   * worktree/branch (never allocate their own) and share its Project's concurrency slot.
   *
   * Round 1 and a `fresh` round start a new session with the full step briefing. Any other later
   * round continues the step's latest earlier session (see `continuableSession`) and is sent only
   * `opts.message` — by default the re-run note naming the earlier steps that ran again since
   * (`buildRerunMessage`). When that session can't be continued, a new session gets the full
   * briefing with the message appended to its instructions, unless `opts.resumeOnly` says the
   * message only makes sense inside the continued session (a stopped run's "Continue."), or
   * `opts.freshFallback` says to start exactly as a `fresh` round instead (Retry).
   */
  async function startStepTask(
    run: WorkflowRunRecord,
    step: WorkflowStep,
    round: number,
    opts: { fresh?: boolean; message?: string; resumeOnly?: boolean; freshFallback?: boolean } = {},
    rejectLaunchFailure = false,
  ): Promise<TaskRecord> {
    const project = await getProject(run.projectId);
    const item = await getPlanItem(run.planItemId);
    const template = (await getAgent(step.agentId)) ?? (await getDefaultAgent());
    const prior = round > 1 && !opts.fresh ? await latestStepRun(run.id, step.id) : undefined;
    const earlierRounds = round > 1 ? await allStepRuns(run.id, step.id) : [];
    // A regression run's first attempt at a step continues that step's latest round from the bug's earlier runs.
    const regressionPrior = run.regression && (round === 1 || opts.fresh) ? await regressionPriorStepRun(run, step) : undefined;
    const resumeFrom = prior ?? (opts.fresh ? undefined : regressionPrior);
    const priorTask = resumeFrom?.taskId ? await tasksDb.get(resumeFrom.taskId) : undefined;
    const configuredExecutor = (step.executorId ? await getExecutor(step.executorId) : undefined) ?? (await getExecutor(run.executorId));
    const savedExecutor = priorTask?.sessionExecutor ? { id: priorTask.executorId, label: priorTask.executorId, ...priorTask.sessionExecutor } : undefined;
    const executor = (savedExecutor && (!configuredExecutor || configuredExecutor.id === savedExecutor.id) ? savedExecutor : configuredExecutor) ?? await getDefaultExecutor();
    if (!executor) throw new ExecutorNotFoundError();
    if (!isInteractiveCli(executor)) throw new ExecutorNotSupportedError(executor);
    const executionMode = 'terminal' as const;

    const resumeSessionId = resumeFrom ? await continuableSession(run, step, resumeFrom, executor) : null;
    // Before any side effects, so the fallback picks its executor, prompt and regression message as a fresh round does.
    if (opts.freshFallback && !resumeSessionId) return startStepTask(run, step, round, { fresh: true }, rejectLaunchFailure);
    const message = prior
      ? opts.message ?? buildRerunMessage({ requiresVerdict: Boolean(step.loopBack), updates: await stagesRerunSince(run, step, prior) })
      : run.regression && (round === 1 || opts.fresh) ? await regressionStepMessage(run, step, item, regressionPrior, Boolean(resumeSessionId)) : undefined;
    const continuedTask = resumeSessionId && prior?.taskId ? await tasksDb.get(prior.taskId) : undefined;
    if (!continuedTask) await assertSkillsUsable(step.skillIds);

    const stepNote = item.stepNotes?.[step.id];
    const prompt = resumeSessionId && message ? appendStepNote(message, stepNote) : buildStepPrompt({
      stepNote,
      taskTitle: item.title,
      taskDescription: item.description,
      stepName: step.name,
      instructions: message && !opts.resumeOnly ? `${step.instructions}\n\n${message}` : step.instructions,
      canEditCode: step.canEditCode,
      canRunCommands: step.canRunCommands,
      requiresVerdict: Boolean(step.loopBack),
      requiresApproval: step.requiresApproval,
      skippable: !run.testingSetup && !run.prConflict,
      branch: run.branch,
      baseBranch: run.baseBranch,
      history: await buildStepHistory(run, step),
      planningGaps: await collectPlanningGaps(run),
    });

    const taskId = randomUUID();
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: taskId,
      projectId: project.id,
      templateId: continuedTask?.templateId ?? template.id,
      skillIds: step.skillIds,
      ...(step.preloadSkillIds?.length ? { preloadSkillIds: step.preloadSkillIds } : {}),
      executorId: executor.id,
      executionMode,
      description: `${step.name}: ${item.title}`,
      branch: run.branch,
      worktreePath: run.worktreePath,
      status: 'developing',
      autonomy: continuedTask?.autonomy ?? template.defaultAutonomy,
      manager: continuedTask?.manager ?? template.manager,
      kind: 'execute',
      planItemId: item.id,
      workflowRunId: run.id,
      workflowStepId: step.id,
      sessionId: resumeSessionId,
      ...(continuedTask ? { sessionSetup: continuedTask.sessionSetup, sessionExecutor: continuedTask.sessionExecutor } : {}),
      runtimeStatus: 'starting' as const,
      runtimeWaitingReason: null,
      runtimeStatusChangedAt: now,
      blockedQuestion: null,
      failureReason: null,
      tokenUsage: ZERO_TOKEN_USAGE,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await tasksDb.insert(withOwnership(task));
    await taskContextsDb.insert({ id: task.id, taskId: task.id, turns: [] });
    const updatedProject = await addActiveTask(project.id, task.id);
    emit({ type: 'project', project: updatedProject });
    emit({ type: 'task', task });
    // Every step Task is still recorded on its PlanItem's own `taskIds` — the run/PlanItem status
    // mapping (`syncPlanItemForRun`) replaces `syncPlanItem`'s status mirroring for a workflow-run
    // Task, but the "every Task ever run for this item" list is unrelated to that and still applies.
    if (!item.taskIds.includes(task.id)) {
      const updatedItem = await updatePlanItem(item.id, { taskIds: [...item.taskIds, task.id] });
      emit({ type: 'planItem', planItem: updatedItem });
    }

    const stepRun: StepRunRecord = {
      id: randomUUID(),
      runId: run.id,
      stepId: step.id,
      round,
      taskId: task.id,
      status: 'running',
      summary: null,
      outputs: [],
      verdict: null,
      skippedReason: null,
      approval: null,
      createdAt: now,
      completedAt: null,
    };
    await stepRunsDb.insert(stepRun);
    emit({ type: 'stepRun', stepRun });

    const runningRun = await workflowRunsDb.update(run.id, {
      status: 'running',
      currentStepId: step.id,
      currentStepProgress: null,
      currentStepRoundStartedAt: now,
      currentStepPriorRoundsMs: priorRoundsMs(earlierRounds),
      completedAt: null,
      updatedAt: now,
    });
    if (runningRun) { emit({ type: 'workflowRun', run: runningRun }); await syncPlanItemForRun(runningRun); }

    const launched = await runTerminalTask(task, project, template, resumeSessionId, prompt, 'prompt', rejectLaunchFailure);
    // A launch that failed never delivered the note, so it stays for the next attempt.
    if (launched && stepNote) await consumeStepNote(item.id, step.id, stepNote);

    return task;
  }

  /** Removes a step's note once it has been sent, unless the person edited it meanwhile. */
  async function consumeStepNote(planItemId: string, stepId: string, sent: string): Promise<void> {
    await withStepNotesLock(planItemId, async () => {
      const current = await planItemsDb.get(planItemId);
      if (current?.stepNotes?.[stepId] !== sent) return;
      emit({ type: 'planItem', planItem: await updatePlanItem(planItemId, { stepNotes: withStepNote(current.stepNotes, stepId, null) }) });
    });
  }

  /**
   * Saves (or, with a null note, clears) the note for one step of a task. Before any run the step id only has to
   * look like an id; once a run exists it must be one of that run's workflow steps.
   */
  async function setStepNote(planItemId: string, stepId: unknown, note: unknown): Promise<PlanItemRecord> {
    assertStepId(stepId);
    const parsed = parseStepNote(note);
    return withStepNotesLock(planItemId, async () => {
      const item = await getPlanItem(planItemId);
      const run = item.workflowRunId ? await workflowRunsDb.get(item.workflowRunId) : undefined;
      if (run && !run.workflowSnapshot.steps.some((step) => step.id === stepId)) {
        throw new StepNoteValidationError(`"${stepId}" is not a step of this task's workflow`);
      }
      const updated = await updatePlanItem(planItemId, { stepNotes: withStepNote(item.stepNotes, stepId, parsed) });
      emit({ type: 'planItem', planItem: updated });
      return updated;
    });
  }

  /** `<ref> <step name>: <summary first line>` (or just `<step name>: ...` with no ref) — the commit made after a code-editing step completes or is skipped. A no-op for a repository-less Project. */
  async function commitStepWork(run: WorkflowRunRecord, project: ProjectRecord, step: WorkflowStep, stepRun: StepRunRecord): Promise<void> {
    if (!project.repositoryUrl || !run.branch) return;
    const item = await getPlanItem(run.planItemId).catch(() => null);
    const ref = item?.planningRef ? `${item.planningRef.session}.${String(item.planningRef.task).padStart(3, '0')}` : null;
    const summaryLine = (stepRun.summary ?? '').split('\n')[0] || step.name;
    const message = ref ? `${ref} ${step.name}: ${summaryLine}` : `${step.name}: ${summaryLine}`;
    await commitWork(project, taskWorkingDirectory(project, run), run.branch, message);
  }

  function planItemStatusForRun(run: WorkflowRunRecord): PlanItemRecord['status'] {
    switch (run.status) {
      case 'awaiting-approval':
      case 'needs-attention':
        return 'blocked';
      case 'stopped': // ordinary runs are resumable; a rejected testing setup is final
        return run.testingSetup ? 'stopped' : 'blocked';
      case 'completed':
        return 'done';
      case 'failed':
        return 'failed';
      default:
        return 'developing';
    }
  }

  /** Mirrors a WorkflowRun's status onto its PlanItem through the shared item lifecycle. */
  async function syncPlanItemForRun(run: WorkflowRunRecord): Promise<void> {
    await syncLinkedPlanItem(run.planItemId, { status: planItemStatusForRun(run) });
    // Leaves a work update on any CRM customer with this Building attached; it never delays or fails the run.
    void import('../crm/runtime.ts').then((crm) => crm.recordRunWork(run)).catch(() => undefined);
  }

  /**
   * Raises a Notification for a run entering `awaiting-approval`/`needs-attention`. Not part of this
   * milestone's own kind table (see domain/types.ts's `NotificationKind` doc comment) — kept as two
   * dedicated kinds (fixed severity each, warning/critical) rather than dropping the behavior.
   * Subject is the whole Project (`{type:'project'}`): at most one WorkflowRun is ever active per
   * Project at a time (the concurrency cap bounds PlanItem execution), so that's a precise enough
   * identity without inventing a run-scoped subject the spec's closed union doesn't have room for.
   */
  async function raiseAttentionNotification(run: WorkflowRunRecord, kind: 'workflow.awaiting_approval' | 'workflow.needs_attention', title: string, description: string): Promise<void> {
    const project = await getProject(run.projectId).catch(() => null);
    await raiseNotification({
      kind,
      subject: { type: 'project', projectId: run.projectId },
      title: project ? `${title} on "${project.name}"` : title,
      description,
    });
  }

  /** Resolves whichever attention Notification is open for this run's Project — called whenever a run leaves `awaiting-approval`/`needs-attention` (approved, changes requested, loop decided, retried, stopped). */
  async function resolveAttentionNotification(run: WorkflowRunRecord): Promise<void> {
    await resolveNotifications({ type: 'project', projectId: run.projectId }, ['workflow.awaiting_approval', 'workflow.needs_attention']);
  }

  async function setWorkflowRunAwaitingApproval(run: WorkflowRunRecord, step: WorkflowStep): Promise<void> {
    await raiseAttentionNotification(run, 'workflow.awaiting_approval', 'Workflow run needs approval', `"${step.name}" is ready for your review.`);
    const updated = await workflowRunsDb.update(run.id, { status: 'awaiting-approval', updatedAt: new Date().toISOString() });
    if (!updated) return;
    emit({ type: 'workflowRun', run: updated });
    await syncPlanItemForRun(updated);
  }

  async function setWorkflowRunNeedsAttention(run: WorkflowRunRecord, reason: string): Promise<void> {
    await resolveAttentionNotification(run);
    await raiseAttentionNotification(run, 'workflow.needs_attention', 'Workflow run needs attention', reason);
    const updated = await workflowRunsDb.update(run.id, { status: 'needs-attention', attentionReason: reason, updatedAt: new Date().toISOString() });
    if (!updated) return;
    emit({ type: 'workflowRun', run: updated });
    await syncPlanItemForRun(updated);
  }

  /** Starts the first step after `fromStep` that wasn't left out at start, or the Complete stage when none is left. */
  async function advanceToNextStepOrComplete(run: WorkflowRunRecord, fromStep: WorkflowStep): Promise<void> {
    const skipped = run.skippedStepIds ?? [];
    const next = run.workflowSnapshot.steps.slice(stepIndex(run, fromStep.id) + 1).find((step) => !skipped.includes(step.id));
    if (!next) { await completeWorkflowRun(run); return; }
    const round = (await allStepRuns(run.id, next.id)).length + 1;
    await startStepTask(run, next, round);
  }

  /** Evaluates a loop-origin step's verdict once it completes — see WorkflowStep.loopBack's doc comment for the full state machine this implements. */
  async function evaluateLoop(run: WorkflowRunRecord, loopStep: WorkflowStep, completedStepRun: StepRunRecord): Promise<void> {
    if (completedStepRun.verdict !== 'issues') { await advanceToNextStepOrComplete(run, loopStep); return; }

    const loopRounds = await allStepRuns(run.id, loopStep.id);
    const budget = loopStep.loopBack!.maxRounds + run.loopRoundAllowance;
    if (loopRounds.length >= budget) {
      await setWorkflowRunNeedsAttention(run, `${loopStep.name} still found issues after ${loopRounds.length} round(s).`);
      return;
    }

    const target = findStep(run, loopStep.loopBack!.toStepId)!;
    const round = (await allStepRuns(run.id, target.id)).length + 1;
    await startStepTask(run, target, round, {
      message: buildReviewFixMessage({ reviewStepName: loopStep.name, reviewRound: completedStepRun.round, reviewSummary: completedStepRun.summary }),
    });
  }

  /**
   * Runs after a step's `complete_step` call (never `skip_step` — see `skipStep`, which bypasses
   * both approval and loop evaluation entirely). Commits a code-editing step's changes, then either
   * pauses for approval, evaluates a loop verdict, or advances to the next step / the Complete stage.
   */
  async function advanceWorkflowRun(run: WorkflowRunRecord, step: WorkflowStep, completedStepRun: StepRunRecord): Promise<void> {
    const project = await getProject(run.projectId);
    if (run.prConflict) { await finishConflictRun(run, project); return; }
    if (step.canEditCode) await commitStepWork(run, project, step, completedStepRun);
    if (run.testingSetup && !step.canEditCode && await readOnlyStepChangedFiles(run, project, step)) return;

    if (step.requiresApproval) { await setWorkflowRunAwaitingApproval(run, step); return; }
    if (step.loopBack) { await evaluateLoop(run, step, completedStepRun); return; }
    await advanceToNextStepOrComplete(run, step);
  }

  /**
   * Defense in depth for a testing setup's read-only steps: the sandbox should make writes
   * impossible, but if the run's worktree changed anyway the proposal is not offered for approval —
   * the run needs attention instead, and nothing is committed. Resolves whether it found changes.
   */
  async function readOnlyStepChangedFiles(run: WorkflowRunRecord, project: ProjectRecord, step: WorkflowStep): Promise<boolean> {
    if (!project.repositoryUrl || !run.worktreePath) return false;
    const changes = await workingTreeChanges(run.worktreePath);
    if (changes.length === 0) return false;
    await setWorkflowRunNeedsAttention(run, `${step.name} is read-only but the working tree changed (${changes.slice(0, 5).join(', ')}${changes.length > 5 ? ', …' : ''}). Nothing was committed; stop this setup and start again.`);
    return true;
  }

  /**
   * The testing-setup rules `complete_step` enforces before recording anything: a proposal round
   * must carry a non-empty proposal to approve, and the implementation step may only report "pass"
   * once the evidence check does (the evidence is saved on the run either way, for the UI).
   */
  async function assertSetupStepCompletable(run: WorkflowRunRecord, step: WorkflowStep, input: { outputs?: StepRunOutput[]; verdict?: 'pass' | 'issues' }): Promise<void> {
    if (step.id === SETUP_PROPOSAL_STEP_ID) {
      if (!(input.outputs ?? []).some((output) => output.content.trim())) {
        throw new TestingSetupStepRefusedError('A testing setup proposal is required: call complete_step with the proposal as a markdown output.');
      }
      return;
    }
    if (step.id !== SETUP_IMPLEMENTATION_STEP_ID || input.verdict !== 'pass') return;
    const project = await getProject(run.projectId);
    const root = run.worktreePath ?? projectAbsolutePath(project);
    const implementationTaskIds = new Set((await tasksDb.find((t) => t.workflowRunId === run.id && t.workflowStepId === SETUP_IMPLEMENTATION_STEP_ID)).map((t) => t.id));
    const agentRuns = await testRunsDb.find((r) => r.projectId === run.projectId && r.trigger === 'agent' && r.taskId !== null && implementationTaskIds.has(r.taskId));
    const evidence = evaluateSetupEvidence(await loadTestingConfig(root), agentRuns);
    const updated = await workflowRunsDb.update(run.id, { testingSetup: { mode: run.testingSetup!.mode, evidence }, updatedAt: new Date().toISOString() });
    if (updated) emit({ type: 'workflowRun', run: updated });
    if (!evidence.ok) {
      throw new TestingSetupStepRefusedError(`Testing setup is not validated yet, so it can't complete:\n- ${evidence.problems.join('\n- ')}`);
    }
  }

  /** This Task's still-unresolved StepRun — present until complete_step/skip_step (or a stop/failure) settles its round. */
  async function findRunningStepRun(taskId: string): Promise<StepRunRecord | undefined> {
    return (await stepRunsDb.find((s) => s.taskId === taskId && s.status === 'running'))[0];
  }

  /**
   * Mirrors a step session's genuine mid-round question onto its WorkflowRun: `question` set flips a
   * 'running' run to needs-attention (raising its notification); `null` (the person answered, the
   * CLI is working again) returns a run that question paused back to 'running'. Only ever called
   * while this step's round is still unresolved, so it can't clobber any other attention state.
   */
  async function syncStepQuestionOnRun(stepRun: StepRunRecord, question: string | null): Promise<void> {
    const run = await workflowRunsDb.get(stepRun.runId);
    if (!run) return;
    if (question !== null && run.status === 'running') { await setWorkflowRunNeedsAttention(run, question); return; }
    if (question !== null || run.status !== 'needs-attention') return;
    await resolveAttentionNotification(run);
    const updated = await workflowRunsDb.update(run.id, { status: 'running', attentionReason: null, updatedAt: new Date().toISOString() });
    if (!updated) return;
    emit({ type: 'workflowRun', run: updated });
    await syncPlanItemForRun(updated);
  }

  /** The Task, run, step and running StepRun behind an MCP tool call — throws TaskNotWorkflowStepError for anything else (foreign/stale task id, a step that already completed, a non-workflow Task). */
  async function requireRunningStepSession(taskId: string): Promise<{ task: TaskRecord; run: WorkflowRunRecord; step: WorkflowStep; stepRun: StepRunRecord }> {
    const task = await tasksDb.get(taskId);
    if (!task || !task.workflowRunId || !task.workflowStepId || task.status !== 'developing') throw new TaskNotWorkflowStepError();
    const run = await workflowRunsDb.get(task.workflowRunId);
    const step = run && findStep(run, task.workflowStepId);
    if (!run || !step) throw new TaskNotWorkflowStepError();
    const stepRun = await findRunningStepRun(taskId);
    if (!stepRun) throw new TaskNotWorkflowStepError();
    return { task, run, step, stepRun };
  }

  /**
   * Closes a step Task's own interactive-CLI session right after complete_step/skip_step has
   * recorded its outcome — a step session's whole job ends the instant it reports one, so leaving it
   * open would both leak the process and leave its Task stuck 'developing' forever (nothing else
   * ever tears it down). This is also half of the false-"needs your input" attention-alert fix: see
   * `handleTerminalHook`'s own doc comment for the other half, and `settleWorkflowStepTaskExit` for
   * how the resulting exit is settled unconditionally 'done' rather than read from its exit code.
   * Never called when advancing the run itself throws — the model's tool call would surface that as
   * an error, and its session may still need to be around to retry.
   */
  function endStepSession(taskId: string): void {
    if (terminalSessions.has(taskId)) terminalSessions.stop(taskId);
  }

  /**
   * `report_progress`'s guard (task 5.017): a running step session (`requireRunningStepSession`)
   * that is also still one of its Project's active Tasks — the same extra check `requireTestingSession`
   * makes beyond `status === 'developing'` alone, closing the race where a Task's status still reads
   * 'developing' for an instant after it's already been dropped from the active set. Deliberately not
   * folded into `requireRunningStepSession` itself, which `completeStep`/`skipStep`/the diff tools also
   * use and which must keep working exactly as today.
   */
  async function requireReportingStepSession(taskId: string): Promise<{ run: WorkflowRunRecord; stepRun: StepRunRecord }> {
    const { task, run, stepRun } = await requireRunningStepSession(taskId);
    const project = await getProject(run.projectId);
    if (!activeTaskIdsOf(project).includes(task.id)) throw new TaskNotWorkflowStepError();
    return { run, stepRun };
  }

  /**
   * `report_progress({checklist?, currentActivity?, estimate?})` (task 5.017) — replaces the calling
   * round's whole progress (never merged, never kept as history) and mirrors a summary onto the run
   * record so the Running board card can show it without loading the run's full detail (see
   * `WorkflowRunRecord.currentStepProgress`). Shape/length limits are enforced by the caller
   * (`POST /api/workflow-steps/progress`) before this ever runs.
   */
  async function reportProgress(taskId: string, input: { checklist?: (Pick<StepProgressItem, 'text' | 'state'> & { note?: string | null; short?: string | null })[]; currentActivity?: string | null; estimate?: string | null }): Promise<StepRunRecord> {
    const { run, stepRun } = await requireReportingStepSession(taskId);
    const estimate = input.estimate ?? null;
    const progress: StepRunProgress = {
      checklist: (input.checklist ?? []).map((item) => ({ text: item.text, state: item.state, note: item.note ?? null, short: trimShortLabel(item.short) })),
      currentActivity: input.currentActivity ?? null,
      estimate,
      estimatedAt: estimate ? new Date().toISOString() : null,
    };
    const updated = await stepRunsDb.update(stepRun.id, { progress });
    if (!updated) throw new TaskNotWorkflowStepError();
    emit({ type: 'stepRun', stepRun: updated });
    const runningRun = await workflowRunsDb.update(run.id, { currentStepProgress: summarizeProgress(progress), updatedAt: new Date().toISOString() });
    if (runningRun) emit({ type: 'workflowRun', run: runningRun });
    return updated;
  }

  /** `complete_step({summary, outputs?, verdict?, planningGap?})` — see terminal/stepTaskTool.ts. */
  async function completeStep(taskId: string, input: { summary: string; outputs?: StepRunOutput[]; verdict?: 'pass' | 'issues'; planningGap?: string }): Promise<StepRunRecord> {
    const { run, step, stepRun } = await requireRunningStepSession(taskId);
    if (step.loopBack && input.verdict !== 'pass' && input.verdict !== 'issues') {
      throw new Error(`Step "${step.name}" reviews earlier work — complete_step needs verdict "pass" or "issues".`);
    }
    if (run.testingSetup) await assertSetupStepCompletable(run, step, input);
    const updated = await stepRunsDb.update(stepRun.id, {
      status: 'done',
      summary: input.summary,
      outputs: input.outputs ?? [],
      verdict: step.loopBack ? (input.verdict ?? null) : null,
      planningGap: input.planningGap?.trim() || null,
      completedAt: new Date().toISOString(),
    });
    if (!updated) throw new TaskNotWorkflowStepError();
    emit({ type: 'stepRun', stepRun: updated });
    await advanceWorkflowRun(run, step, updated);
    endStepSession(taskId);
    return updated;
  }

  /** `skip_step({reason})` — bypasses approval and loop evaluation entirely, per task 3.012's spec. */
  async function skipStep(taskId: string, input: { reason: string }): Promise<StepRunRecord> {
    const { run, step, stepRun } = await requireRunningStepSession(taskId);
    if (run.testingSetup) throw new TestingSetupStepRefusedError(`"${step.name}" is part of a testing setup and can't be skipped — call complete_step instead.`);
    if (run.prConflict) throw new StepNotSkippableError(step.name);
    const project = await getProject(run.projectId);
    const updated = await stepRunsDb.update(stepRun.id, {
      status: 'skipped',
      skippedReason: input.reason,
      summary: `Skipped: ${input.reason}`,
      completedAt: new Date().toISOString(),
    });
    if (!updated) throw new TaskNotWorkflowStepError();
    emit({ type: 'stepRun', stepRun: updated });
    if (step.canEditCode) await commitStepWork(run, project, step, updated);
    await advanceToNextStepOrComplete(run, step);
    endStepSession(taskId);
    return updated;
  }

  /** `diff_summary()` — a file list + stat summary of the run's branch against its base, never the full diff (task 3.012: "don't paste the whole diff into any prompt"). */
  async function stepDiffSummary(taskId: string): Promise<string> {
    const { run } = await requireStepReadSession(taskId);
    if (!run.branch || !run.worktreePath || !run.baseBranch) return 'This run has no branch of its own (no repository is linked, or it works directly on the project\'s checked-out branch), so there is no diff against a base.';
    if (!existsSync(run.worktreePath)) return 'This run has no available branch working copy to diff against its base.';
    const [stat, files] = await Promise.all([diffStat(run.worktreePath, run.baseBranch), diffNameStatus(run.worktreePath, run.baseBranch)]);
    const fileList = files.map((f) => `${f.status}\t${f.path}`).join('\n') || '(no changes)';
    return `${stat}\n\nFiles:\n${fileList}`;
  }

  /** `diff_file({path})` — one file's diff against the run's base branch. */
  async function stepDiffFile(taskId: string, filePath: string): Promise<string> {
    const { run } = await requireStepReadSession(taskId);
    if (!run.branch || !run.worktreePath || !run.baseBranch || !existsSync(run.worktreePath)) return '';
    const diff = await diffForFile(run.worktreePath, run.baseBranch, filePath);
    return diff || '(no changes to this file)';
  }

  async function requireStepReadSession(taskId: string): Promise<{ run: WorkflowRunRecord }> {
    if (!inspectSessions.has(taskId)) return requireRunningStepSession(taskId);
    const task = await requireTask(taskId);
    const run = task.workflowRunId ? await workflowRunsDb.get(task.workflowRunId) : undefined;
    if (!run || !terminalSessions.has(taskId)) throw new TaskNotWorkflowStepError();
    return { run };
  }

  /** Removes a settled WorkflowRun's worktree — the branch itself is kept, same cleanup policy as `cleanupWorktree` for an ordinary Task's worktree. */
  async function cleanupRunWorktree(run: WorkflowRunRecord): Promise<void> {
    if (!run.worktreePath) return;
    try {
      const project = await getProject(run.projectId);
      await removeRunWorktree(projectAbsolutePath(project), run.worktreePath);
      // A conflict run's branch only ever existed to hold its worktree; the work itself is on the PR's branch.
      if (run.prConflict && run.branch) await git(projectAbsolutePath(project), ['branch', '-D', run.branch]);
    } catch (error) {
      console.error(`Failed to remove worktree for workflow run ${run.id}: ${(error as Error).message}`);
    }
  }

  /**
   * The built-in Complete stage: commit/push whatever's left, raise (or reuse) the PR, and store a
   * completion report — see task 3.012's spec for the exact steps. Never leaves the run stuck: a
   * summarizer failure falls back to stitching the step summaries together directly, and a missing
   * `gh`/failed `gh pr create` still completes the run with the error kept in `completionReport`.
   */
  async function completeWorkflowRun(run: WorkflowRunRecord): Promise<void> {
    const project = await getProject(run.projectId);
    const item = await getPlanItem(run.planItemId).catch(() => null);
    const completing = await workflowRunsDb.update(run.id, { status: 'completing', currentStepId: null, updatedAt: new Date().toISOString() });
    if (completing) emit({ type: 'workflowRun', run: completing });

    const stepSummaries = (await Promise.all(run.workflowSnapshot.steps.map(async (step) => {
      const latest = await latestStepRun(run.id, step.id);
      if (!latest) return null;
      return { stepName: step.name, summary: latest.status === 'skipped' ? `Skipped: ${latest.skippedReason ?? ''}` : (latest.summary ?? '') };
    }))).filter((s): s is { stepName: string; summary: string } => s !== null);

    const summarizerInput = { taskTitle: item?.title ?? run.planItemId, taskDescription: item?.description ?? '', stepSummaries };
    const summary = (await summarizeWorkflowRun(summarizerInput, {
      runClaudeTurn: deps.runClaudeTurn ?? runClaudeTurnDefault,
      runCodexTurn: deps.runCodexTurn ?? runCodexTurn,
      listExecutors: deps.listExecutors ?? listExecutors,
      getExecutorLimits: deps.getExecutorLimits ?? getExecutorLimits,
      trackTurn: deps.trackBackgroundTurn,
      turnContext: { workflowRun: run },
    }).catch(() => null)) ?? stitchFallbackSummary(summarizerInput);

    let prUrl: string | null = null;
    let prError: string | undefined;
    // A run on its own branch ends in a PR; one that worked in place (`createBranch: false`) just
    // commits and pushes onto the Project's checked-out branch, like a bare Task does.
    if (project.repositoryUrl && run.branch) {
      try {
        await commitWork(project, taskWorkingDirectory(project, run), run.branch, `${refPrefix(item)}Complete: ${item?.title ?? run.branch}`);
        if (run.worktreePath) prUrl = await openPullRequest(project, run, run.worktreePath, run.branch, item, summary);
      } catch (error) {
        prError = (error as Error).message;
      }
    }

    const now = new Date().toISOString();
    const completed = await workflowRunsDb.update(run.id, {
      status: 'completed',
      prUrl,
      completionReport: buildCompletionReport(summary, prUrl, prError),
      completedAt: now,
      updatedAt: now,
    });
    if (completed) { emit({ type: 'workflowRun', run: completed }); await syncPlanItemForRun(completed); }
    await cleanupRunWorktree(run);
    await advanceQueueIfIdle(run.projectId);
  }

  /** The run's PR URL — its branch's existing PR, or a new one against its base branch. */
  async function openPullRequest(project: ProjectRecord, run: WorkflowRunRecord, worktreePath: string, branch: string, item: PlanItemRecord | null, summary: Parameters<typeof buildPrBody>[0]): Promise<string> {
    return withProjectGithub(project, 'open the pull request', async () => {
      const existing = await ghPrViewForBranch(worktreePath, branch);
      if (existing) return existing.url;
      const created = await ghPrCreate(worktreePath, {
        base: run.baseBranch ?? 'main',
        head: branch,
        title: `${refPrefix(item)}${item?.title ?? branch}`,
        body: buildPrBody(summary),
      });
      return created.url;
    });
  }

  function refPrefix(item: PlanItemRecord | null): string {
    return item?.planningRef ? `${item.planningRef.session}.${String(item.planningRef.task).padStart(3, '0')} ` : '';
  }

  /** Runs `fn` after every earlier decision on this run has settled, so two clicks (approve twice, approve and stop) can't both act on the same paused state. */
  function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return serializeOn(runLocks, runId, fn);
  }

  /** `POST /api/workflow-runs/:id/approve {comment?}` — advances exactly like a normal step completion continuing (start next step / Complete), per task 3.012's spec. A testing setup can only be approved through `approveTestingSetup`. */
  function approveWorkflowRun(runId: string, comment?: string): Promise<WorkflowRunRecord> {
    return withRunLock(runId, () => approveLocked(runId, comment, null));
  }

  /**
   * `POST /api/testing-setup/:runId/approve {proposalRound, comment?}` — the only way to approve a
   * testing-setup proposal, and so the only thing that unlocks its write-capable implementation step
   * (see `resolveStepPermissions`). `proposalRound` must be the round the person was shown: an
   * approval of an older round is refused, since approval covers only the displayed proposal.
   */
  function approveTestingSetup(runId: string, proposalRound: number, comment?: string): Promise<WorkflowRunRecord> {
    return withRunLock(runId, () => approveLocked(runId, comment, proposalRound));
  }

  async function approveLocked(runId: string, comment: string | undefined, setupProposalRound: number | null): Promise<WorkflowRunRecord> {
    const run = await requireWorkflowRun(runId);
    if (run.status !== 'awaiting-approval') throw await runNotActionable(run, 'be approved');
    if (!run.testingSetup && setupProposalRound !== null) throw new TestingSetupApprovalError(`Workflow run "${runId}" is not a testing setup.`);
    const step = run.currentStepId ? findStep(run, run.currentStepId) : undefined;
    if (run.testingSetup) {
      const latest = step ? await latestStepRun(run.id, step.id) : undefined;
      if (setupProposalRound === null) throw new TestingSetupApprovalError('A testing setup proposal can only be approved with the testing setup approval action.');
      if (!latest || latest.round !== setupProposalRound) {
        throw new TestingSetupApprovalError(`Proposal round ${setupProposalRound} is not the one awaiting approval${latest ? ` (round ${latest.round} is)` : ''}.`);
      }
    }
    if (step) {
      const stepRun = await latestStepRun(run.id, step.id);
      if (stepRun) {
        const updated = await stepRunsDb.update(stepRun.id, { approval: { decision: 'approved', comment: comment ?? null, at: new Date().toISOString() } });
        if (updated) emit({ type: 'stepRun', stepRun: updated });
      }
    }
    await resolveAttentionNotification(run);
    if (step) await advanceToNextStepOrComplete(run, step);
    else await completeWorkflowRun(run);
    return requireWorkflowRun(runId);
  }

  /**
   * `POST /api/workflow-runs/:id/request-changes {comment}` — records the decision on the approval
   * step's round, then starts a new round of the step its `requestChangesToStepId` names (or of the
   * approval step itself when unset) that continues that step's latest session with the comment.
   * From there the run carries on forward as usual, back to this approval step. For a testing setup
   * this is always the "revise the proposal" action: the new proposal round stays read-only and
   * needs its own approval.
   */
  function requestChangesWorkflowRun(runId: string, comment: string): Promise<WorkflowRunRecord> {
    return withRunLock(runId, () => requestChangesLocked(runId, comment));
  }

  async function requestChangesLocked(runId: string, comment: string): Promise<WorkflowRunRecord> {
    const run = await requireWorkflowRun(runId);
    if (run.status !== 'awaiting-approval' || !run.currentStepId) throw await runNotActionable(run, 'request changes on');
    const step = findStep(run, run.currentStepId);
    if (!step) throw await runNotActionable(run, 'request changes on');
    const priorStepRun = await latestStepRun(run.id, step.id);
    if (priorStepRun) {
      const updated = await stepRunsDb.update(priorStepRun.id, {
        status: 'changes-requested',
        approval: { decision: 'changes-requested', comment, at: new Date().toISOString() },
      });
      if (updated) emit({ type: 'stepRun', stepRun: updated });
    }
    await resolveAttentionNotification(run);
    const target = requestChangesTarget(run, step);
    const round = (await allStepRuns(run.id, target.id)).length + 1;
    await startStepTask(run, target, round, { message: buildChangesRequestedMessage(comment) });
    return requireWorkflowRun(runId);
  }

  /** The step Request changes on `approvalStep` re-runs: its `requestChangesToStepId` when that names an earlier step of the run's snapshot, otherwise the approval step itself (always, for a testing setup). */
  function requestChangesTarget(run: WorkflowRunRecord, approvalStep: WorkflowStep): WorkflowStep {
    if (run.testingSetup || !approvalStep.requestChangesToStepId) return approvalStep;
    const target = findStep(run, approvalStep.requestChangesToStepId);
    return target && stepIndex(run, target.id) < stepIndex(run, approvalStep.id) ? target : approvalStep;
  }

  /** `POST /api/workflow-runs/:id/loop {action, comment?}` — resolves a loop paused `needs-attention` after exhausting its `maxRounds`. A testing setup can't "continue anyway": that would complete it without validation evidence. */
  function decideWorkflowRunLoop(runId: string, action: 'another-round' | 'continue', comment?: string): Promise<WorkflowRunRecord> {
    return withRunLock(runId, () => decideLoopLocked(runId, action, comment));
  }

  async function decideLoopLocked(runId: string, action: 'another-round' | 'continue', comment?: string): Promise<WorkflowRunRecord> {
    const run = await requireWorkflowRun(runId);
    if (run.status !== 'needs-attention' || !run.currentStepId) throw await runNotActionable(run, 'resolve a loop decision on');
    const step = findStep(run, run.currentStepId);
    if (!step?.loopBack) throw await runNotActionable(run, 'resolve a loop decision on');
    if (run.testingSetup && action === 'continue') throw new TestingSetupApprovalError('A testing setup can only complete once its setup is validated — run another round, retry the step, or stop it.');
    await resolveAttentionNotification(run);
    if (action === 'continue') {
      await workflowRunsDb.update(run.id, { status: 'running', updatedAt: new Date().toISOString() });
      await advanceToNextStepOrComplete(run, step);
      return requireWorkflowRun(runId);
    }
    await workflowRunsDb.update(run.id, { loopRoundAllowance: run.loopRoundAllowance + 1, status: 'running', updatedAt: new Date().toISOString() });
    const target = findStep(run, step.loopBack.toStepId)!;
    const review = await latestStepRun(run.id, step.id);
    const round = (await allStepRuns(run.id, target.id)).length + 1;
    await startStepTask(run, target, round, {
      message: buildReviewFixMessage({ reviewStepName: step.name, reviewRound: review?.round ?? 0, reviewSummary: review?.summary ?? null, overrideComment: comment ?? null }),
    });
    return requireWorkflowRun(runId);
  }

  /**
   * `POST /api/workflow-runs/:id/retry-step` — re-runs the current step. When its latest round ended
   * unfinished (failed, stopped, or still running with a pending question, which is stopped quietly
   * first), the new round continues that round's session with `RETRY_PROMPT`; otherwise, or when that
   * session can't be continued, it starts fresh with the full briefing. A testing setup's
   * implementation step retries under the approval its proposal already has; a proposal step retries read-only.
   */
  function retryWorkflowStep(runId: string): Promise<WorkflowRunRecord> {
    return withRunLock(runId, () => retryLocked(runId));
  }

  async function retryLocked(runId: string): Promise<WorkflowRunRecord> {
    const run = await requireWorkflowRun(runId);
    if ((run.status !== 'needs-attention' && run.status !== 'failed') || !run.currentStepId) {
      throw await runNotActionable(run, 'retry');
    }
    const step = findStep(run, run.currentStepId);
    if (!step) throw await runNotActionable(run, 'retry');
    await resolveAttentionNotification(run);
    // The agent never launched: redo the whole start-up rather than a step that has no worktree to run in.
    if (isStartupIncomplete(run.startup)) return restartStartup(run);
    const latest = await latestStepRun(run.id, step.id);
    // Stopped before the run is running again, so the old session's exit can't flag it for attention.
    if (latest) await stopLiveStepRound(latest);
    await workflowRunsDb.update(run.id, { status: 'running', updatedAt: new Date().toISOString() });
    const round = (await allStepRuns(run.id, step.id)).length + 1;
    const unfinished = latest?.status === 'failed' || latest?.status === 'stopped' || latest?.status === 'running';
    await startStepTask(run, step, round, unfinished ? { message: RETRY_PROMPT, resumeOnly: true, freshFallback: true } : { fresh: true });
    return requireWorkflowRun(runId);
  }

  /** `POST /api/workflow-runs/:id/stop` — serializes the stop with other run decisions. */
  function stopWorkflowRun(runId: string): Promise<WorkflowRunRecord> {
    return withRunLock(runId, () => stopLocked(runId));
  }

  /** Halts the run while keeping its worktree and session resumable; rejecting a testing setup uses the same path. */
  async function stopLocked(runId: string): Promise<WorkflowRunRecord> {
    const run = await requireWorkflowRun(runId);
    if (run.status === 'completed' || run.status === 'stopped') throw await runNotActionable(run, 'be stopped');
    await haltWorkflowRun(run);
    return requireWorkflowRun(runId);
  }

  /** Stops the current step's live session (recording its round 'stopped', so its exit settles quietly) and marks the run 'stopped'. */
  async function haltWorkflowRun(run: WorkflowRunRecord): Promise<void> {
    if (run.status === 'starting') { await haltStartingRun(run); return; }
    if (run.currentStepId) {
      const stepRun = await latestStepRun(run.id, run.currentStepId);
      if (stepRun) await stopLiveStepRound(stepRun);
    }
    await resolveAttentionNotification(run);
    const updated = await workflowRunsDb.update(run.id, { status: 'stopped', updatedAt: new Date().toISOString() });
    if (updated) { emit({ type: 'workflowRun', run: updated }); await syncPlanItemForRun(updated); }
    await advanceQueueIfIdle(run.projectId);
  }

  /** Stops a still-running round's live session and records the round 'stopped' first, so its exit settles quietly. */
  async function stopLiveStepRound(stepRun: StepRunRecord): Promise<void> {
    if (stepRun.status !== 'running' || !stepRun.taskId) return;
    stoppedTasks.add(stepRun.taskId);
    if (!terminalSessions.stop(stepRun.taskId)) stoppedTasks.delete(stepRun.taskId);
    const updatedStepRun = await stepRunsDb.update(stepRun.id, { status: 'stopped', completedAt: new Date().toISOString() });
    if (updatedStepRun) emit({ type: 'stepRun', stepRun: updatedStepRun });
  }

  /** Stops a run that is still setting up: marks it stopped at once (freeing its slot) and lets its start-up undo what it created — see `runStartup`. */
  async function haltStartingRun(run: WorkflowRunRecord): Promise<void> {
    const handle = startups.get(run.id);
    handle?.cancel();
    await resolveAttentionNotification(run);
    const updated = await workflowRunsDb.update(run.id, { status: 'stopped', updatedAt: new Date().toISOString() });
    if (updated) { emit({ type: 'workflowRun', run: updated }); await syncPlanItemForRun(updated); }
    if (!handle) await settleCancelledStartup(run.id);
    await advanceQueueIfIdle(run.projectId);
  }

  /**
   * `POST /api/workflow-runs/:id/resume` — continues a stopped run: its current step gets a new round
   * that resumes the stopped round's own CLI session (`--resume <sessionId>`) with a plain "continue"
   * message. Only the PlanItem's latest run, and only once the stopped session has actually exited.
   */
  async function resumeWorkflowRun(runId: string): Promise<WorkflowRunRecord> {
    const run = await requireWorkflowRun(runId);
    const step = run.currentStepId ? findStep(run, run.currentStepId) : undefined;
    const item = await getPlanItem(run.planItemId).catch(() => null);
    if (run.status !== 'stopped' || !step || item?.workflowRunId !== run.id) throw await runNotActionable(run, 'be resumed');
    // Stopped while still setting up: there is no session to continue, so set up again from the first step.
    if (isStartupIncomplete(run.startup)) return restartStartup(run);
    const prior = await latestStepRun(run.id, step.id);
    const priorTask = prior?.taskId ? await tasksDb.get(prior.taskId) : undefined;
    if (isLiveTask(priorTask, terminalSessions)) throw new TaskNotFollowableError(await taskName(priorTask));
    await withProjectLock(run.projectId, async () => {
      const project = await getProject(run.projectId);
      await claimConcurrencySlot(project, 'execute', terminalSessions);
      if (!run.worktreePath) await assertProjectFolderFree(project, terminalSessions);
      else await ensureRunWorktree(project, run);
      const round = (await allStepRuns(run.id, step.id)).length + 1;
      await startStepTask(run, step, round, { message: RESUME_PROMPT, resumeOnly: true });
    });
    return requireWorkflowRun(runId);
  }

  /** The choice shown before opening a completed editing step; a missing branch permits only a project-folder read-only session. */
  async function stepReopenOptions(taskId: string): Promise<{ choiceRequired: boolean; permissionsAvailable: boolean; reason?: string }> {
    const task = await requireTask(taskId);
    const name = await taskName(task);
    if (!task.workflowRunId) throw new StepInspectSessionError(name, 'is not a workflow step, so it has no step session to reopen');
    if (task.status === 'developing' || task.status === 'blocked') throw new StepInspectSessionError(name, 'is still running, so its session is already open');
    if (!task.sessionId) throw new TerminalSessionNotResumableError(name);
    if (conversationOwners.has(task.sessionId)) throw new StepInspectSessionError(name, 'already has a live CLI process on this conversation');
    const run = await requireWorkflowRun(task.workflowRunId);
    if (run.status === 'completed' && completedInspectOwners.has(run.id)) throw new StepInspectSessionError(name, 'already has a reopened session on this completed run');
    if (run.pendingInspectChanges || settlingInspectRuns.has(run.id)) throw new StepInspectSessionError(name, 'has changes awaiting a commit or discard decision');
    const editable = !isReadOnlySetup(task.sessionSetup ?? await resolveStepPermissions(task, task.manager));
    const choiceRequired = run.status === 'completed' && editable;
    if (!run.worktreePath || existsSync(run.worktreePath)) return { choiceRequired, permissionsAvailable: true };
    const project = await getProject(task.projectId);
    const root = projectAbsolutePath(project);
    if (!existsSync(root)) throw new StepInspectSessionError(name, `can't be reopened: project "${project.name}"'s folder no longer exists`);
    if (!run.branch || !(await withProjectGithub(project, 'look for the task branch', () => taskBranchExists(root, run.branch!)))) return {
      choiceRequired,
      permissionsAvailable: false,
      reason: `Branch "${run.branch ?? '(unknown)'}" is gone locally and on the remote. This session can open read-only in the project folder.`,
    };
    return { choiceRequired, permissionsAvailable: true };
  }

  /** Reopens a settled conversation without changing its Task, round or run status. */
  async function reopenStepSession(taskId: string, mode?: 'permissions' | 'read-only'): Promise<{ location: 'worktree' | 'recreated-worktree' | 'project'; mode: 'permissions' | 'read-only'; reason?: string }> {
    const task = await requireTask(taskId);
    if (!task.workflowRunId) throw new StepInspectSessionError(await taskName(task), 'is not a workflow step, so it has no step session to reopen');
    return withRunLock(task.workflowRunId, async () => {
      const name = await taskName(task);
      if (terminalSessions.has(taskId)) throw new StepInspectSessionError(name, 'already has a live CLI process');
      const options = await stepReopenOptions(taskId);
      const run = await requireWorkflowRun(task.workflowRunId!);
      if (options.choiceRequired && !mode) throw new StepInspectSessionError(name, 'needs a choice of with permissions or read-only before reopening');
      if (mode && mode !== 'permissions' && mode !== 'read-only') throw new StepInspectSessionError(name, 'has an invalid reopen mode');
      if (mode === 'permissions' && !options.permissionsAvailable) throw new StepInspectSessionError(name, options.reason ?? 'cannot reopen with permissions');
      const effectiveMode = options.choiceRequired ? mode! : (!options.permissionsAvailable || (task.sessionSetup && isReadOnlySetup(task.sessionSetup)) ? 'read-only' : 'permissions');
      const project = await getProject(task.projectId);
      const root = projectAbsolutePath(project);
      if (!existsSync(root)) throw new StepInspectSessionError(name, `can't be reopened: project "${project.name}"'s folder no longer exists`);
      let recreated = false;
      let location: 'worktree' | 'recreated-worktree' | 'project' = 'project';
      let cwd = root;
      if (run.worktreePath && existsSync(run.worktreePath)) {
        cwd = run.worktreePath;
        location = 'worktree';
        if (run.branch && await currentBranch(cwd) !== run.branch) throw new StepInspectSessionError(name, `worktree is no longer on task branch "${run.branch}"`);
      } else if (run.worktreePath && options.permissionsAvailable && run.branch) {
        const restored = await withProjectGithub(project, 'restore the task branch', () => restoreWorktreeForBranch(root, run.worktreePath!, run.branch!));
        if (!restored) throw new StepInspectSessionError(name, `can't recreate branch "${run.branch}"; reopen read-only in the project folder`);
        recreated = true;
        cwd = run.worktreePath;
        location = 'recreated-worktree';
        try { await ensureProjectCliHooks(cwd); }
        catch (error) { await removeRunWorktree(root, cwd); throw error; }
      }
      const executor = task.sessionExecutor ?? await getExecutor(task.executorId);
      if (!executor) throw new ExecutorNotFoundError();
      if (executor.kind !== 'claude-cli' && executor.kind !== 'codex-cli') throw new ExecutorNotSupportedError({ ...executor, label: task.executorId });
      const setup = task.sessionSetup ?? await (async () => {
        const template = (await getAgent(task.templateId)) ?? await getDefaultAgent();
        const permissions = await resolveStepPermissions(task, task.manager);
        const testing = testingToolsAllowed(task, permissions);
        const persona = await buildAppendSystemPrompt(template, task.skillIds, task.preloadSkillIds);
        return { ...permissions, testing, systemPrompt: testing ? `${persona}\n\n${TESTING_TOOL_INSTRUCTIONS}` : persona };
      })();
      const readOnly = effectiveMode === 'read-only';
      const mcpServers = [stepTaskMcpServer(taskId, readOnly || setup.readOnly), ...(!readOnly && setup.testing ? [testTaskMcpServer(taskId)] : [])];
      inspectSessions.add(taskId);
      inspectSessionModes.set(taskId, effectiveMode);
      if (!readOnly && setup.testing) inspectSessionTesting.add(taskId);
      if (run.status === 'completed') completedInspectOwners.set(run.id, taskId);
      let claimed = false;
      try {
        claimConversation(task.sessionId, taskId);
        claimed = true;
        terminalSessions.start({
        taskId,
        kind: executor.kind,
        bin: executor.bin,
        cwd,
        ...await sessionGithub(project, executor.env),
        prompt: '',
        systemPrompt: readOnly ? `${setup.systemPrompt.replace(TESTING_TOOL_INSTRUCTIONS, '').trim()}\n\nThis reopened session is read-only. Do not edit files or run tests.` : setup.systemPrompt,
        autonomy: task.autonomy,
        disallowedTools: readOnly && (run.status === 'completed' || setup.canRunCommands) ? [...PLAN_DISALLOWED_TOOLS, DELEGATION_TOOL] : setup.disallowedTools,
        readOnly: readOnly || setup.readOnly,
        canRunCommands: !readOnly && setup.canRunCommands,
        mcpServers,
        readOnlyDirs: sessionReadOnlyDirs(task),
        sessionId: task.sessionId,
        resume: true,
        reportHooks: false,
        endWhenDetached: true,
        onExit: () => {
          releaseConversation(task.sessionId, taskId);
          if (!inspectSessions.delete(taskId)) return;
          inspectSessionModes.delete(taskId);
          inspectSessionTesting.delete(taskId);
          if (completedInspectOwners.get(run.id) === taskId) completedInspectOwners.delete(run.id);
          stoppedTasks.delete(taskId);
          if (recreated && run.status === 'completed') {
            settlingInspectRuns.add(run.id);
            void settleReopenedWorktree(run.id, project, taskId, effectiveMode, cwd)
              .catch((error) => console.error(`Failed to settle reopened worktree for ${taskId}:`, error))
              .finally(() => settlingInspectRuns.delete(run.id));
          }
        },
      }); } catch (error) {
        if (claimed) releaseConversation(task.sessionId, taskId);
        inspectSessions.delete(taskId);
        inspectSessionModes.delete(taskId);
        inspectSessionTesting.delete(taskId);
        if (completedInspectOwners.get(run.id) === taskId) completedInspectOwners.delete(run.id);
        if (recreated) await removeRunWorktree(root, cwd);
        throw error;
      }
      return { location, mode: effectiveMode, ...(location === 'project' && options.reason ? { reason: options.reason } : {}) };
    });
  }

  async function settleReopenedWorktree(runId: string, project: ProjectRecord, taskId: string, mode: 'permissions' | 'read-only', worktreePath: string): Promise<void> {
    let hasChanges = false;
    let error: string | undefined;
    if (mode === 'permissions') {
      try { hasChanges = (await workingTreeChanges(worktreePath)).length > 0; }
      catch (cause) { hasChanges = true; error = `Could not inspect working copy: ${(cause as Error).message}`; }
    }
    if (hasChanges) {
      const updated = await workflowRunsDb.update(runId, { pendingInspectChanges: { taskId, worktreePath, state: 'pending' as const, hasChanges, error }, updatedAt: new Date().toISOString() });
      if (updated) emit({ type: 'workflowRun', run: updated });
      return;
    }
    try { await removeRunWorktree(projectAbsolutePath(project), worktreePath); }
    catch (cause) {
      const updated = await workflowRunsDb.update(runId, { pendingInspectChanges: { taskId, worktreePath, state: 'pending' as const, hasChanges: false, error: `Working copy cleanup failed: ${(cause as Error).message}` }, updatedAt: new Date().toISOString() });
      if (updated) emit({ type: 'workflowRun', run: updated });
    }
  }

  async function resolveStepInspectChanges(runId: string, decision: 'commit-push' | 'discard'): Promise<WorkflowRunRecord> {
    return withRunLock(runId, async () => {
      const run = await requireWorkflowRun(runId);
      const pending = run.pendingInspectChanges;
      if (!pending || !run.worktreePath || pending.worktreePath !== run.worktreePath) throw new StepInspectSessionError(undefined, 'has no reopened changes awaiting a decision');
      if (terminalSessions.has(pending.taskId)) throw new StepInspectSessionError(undefined, 'still has a live CLI process');
      const project = await getProject(run.projectId);
      if (!existsSync(pending.worktreePath) || (run.branch && await currentBranch(pending.worktreePath) !== run.branch)) {
        throw new StepInspectSessionError(undefined, `working copy is no longer on task branch "${run.branch ?? '(unknown)'}"; restore it before retrying`);
      }
      if (decision === 'commit-push' && !pending.hasChanges) throw new StepInspectSessionError(undefined, 'has no edits to commit; retry working copy cleanup instead');
      const branch = run.branch;
      if (decision === 'commit-push' && !branch) throw new StepInspectSessionError(undefined, 'has no task branch to commit to');
      const deciding = await workflowRunsDb.update(runId, { pendingInspectChanges: { ...pending, state: decision === 'commit-push' ? 'committing' as const : 'discarding' as const, error: undefined } });
      if (deciding) emit({ type: 'workflowRun', run: deciding });
      if (decision === 'commit-push') {
        try { await commitWork(project, pending.worktreePath, branch!, `Interim commit: ${branch}`); }
        catch (error) {
          const updated = await workflowRunsDb.update(runId, { pendingInspectChanges: { ...pending, state: 'pending', error: (error as Error).message } });
          if (updated) emit({ type: 'workflowRun', run: updated });
          throw error;
        }
      }
      try { await removeRunWorktree(projectAbsolutePath(project), pending.worktreePath); }
      catch (error) {
        const updated = await workflowRunsDb.update(runId, { pendingInspectChanges: { ...pending, state: 'pending', hasChanges: decision === 'discard' ? pending.hasChanges : false, error: `Working copy cleanup failed: ${(error as Error).message}` } });
        if (updated) emit({ type: 'workflowRun', run: updated });
        throw error;
      }
      const updated = await workflowRunsDb.update(runId, { pendingInspectChanges: null, updatedAt: new Date().toISOString() });
      if (!updated) throw new WorkflowRunNotFoundError();
      emit({ type: 'workflowRun', run: updated });
      return updated;
    });
  }

  /** `DELETE /api/tasks/:taskId/reopen-session` — ends a session `reopenStepSession` opened; its own exit callback does the cleanup. */
  async function closeStepSession(taskId: string): Promise<void> {
    const task = await requireTask(taskId);
    if (!inspectSessions.has(taskId)) throw new StepInspectSessionError(await taskName(task), 'has no reopened session to stop');
    terminalSessions.stop(taskId);
  }

  /** Recreates a run's worktree on its own branch when the directory is gone (e.g. removed by an older daemon's stop). */
  async function ensureRunWorktree(project: ProjectRecord, run: WorkflowRunRecord): Promise<void> {
    if (!run.worktreePath || !run.branch || existsSync(run.worktreePath)) return;
    await addWorktreeForBranch(projectAbsolutePath(project), run.worktreePath, run.branch, run.baseBranch ?? run.branch);
    await ensureProjectCliHooks(run.worktreePath);
  }

  /**
   * `PATCH /api/plan-items/:id {status: "done"}` — marks an item complete by hand. A run-backed item
   * is halted (any live session stopped), its uncommitted work committed and pushed on the run's
   * branch (in its worktree, else the Project folder), and the run marked completed without running
   * any remaining step or opening a PR. An item with no run is just set done.
   */
  async function completePlanItem(planItemId: string): Promise<PlanItemRecord> {
    const item = await getPlanItem(planItemId);
    const run = item.workflowRunId ? await workflowRunsDb.get(item.workflowRunId) : undefined;
    if (!run || run.status === 'completed') {
      if (await isPlanItemLive(item)) throw new PlanItemNotCompletableError(item);
      const completed = await completePlanItemRecord(planItemId);
      emit({ type: 'planItem', planItem: completed });
      await maybeAutoCompleteForItem(completed);
      return completed;
    }
    if (item.status === 'done') throw new PlanItemCompletedError(item);
    // A run whose agent never launched has no work to commit, and a start-up still in flight must undo its setup first.
    const neverLaunched = isStartupIncomplete(run.startup);
    if (run.status !== 'stopped') await haltWorkflowRun(run);
    if (neverLaunched) await whenStartupSettled(run.id);
    const project = await getProject(run.projectId);
    // A conflict run's own branch is run-local and never pushed; its work goes to the PR's branch only through `finishConflictRun`.
    if (project.repositoryUrl && run.branch && !run.prConflict && !neverLaunched) {
      await commitWork(project, taskWorkingDirectory(project, run), run.branch, `${refPrefix(item)}Complete: ${item.title}`);
    }
    const now = new Date().toISOString();
    const completed = await workflowRunsDb.update(run.id, {
      status: 'completed',
      currentStepId: null,
      completionReport: 'Marked complete by hand; any remaining workflow steps were not run.',
      completedAt: now,
      updatedAt: now,
    });
    if (completed) { emit({ type: 'workflowRun', run: completed }); await syncPlanItemForRun(completed); }
    await cleanupRunWorktree(run);
    await advanceQueueIfIdle(run.projectId);
    return getPlanItem(planItemId);
  }

  /** `DELETE /api/plan-items/:id` — halts the item's run and stops any other live session of it, removes the run's worktree (its branch is kept) and every run's saved step outputs, then deletes the item. */
  async function deletePlanItem(planItemId: string): Promise<void> {
    const item = await getPlanItem(planItemId);
    await rememberLegacyPlanningTasks(item);
    const run = item.workflowRunId ? await workflowRunsDb.get(item.workflowRunId) : undefined;
    if (run && run.status !== 'completed' && run.status !== 'stopped') await haltWorkflowRun(run);
    const liveTasks = (await Promise.all(item.taskIds.map((id) => tasksDb.get(id))))
      .filter((task): task is TaskRecord => isLiveTask(task, terminalSessions) && !stoppedTasks.has(task.id));
    for (const task of liveTasks) await stopTask(task.id);
    if (run) await cleanupRunWorktree(run);
    for (const itemRun of await workflowRunsDb.find((r) => r.planItemId === item.id || r.id === item.workflowRunId)) await removeRunOutputs(itemRun);
    await deletePlanItemRecord(planItemId);
    emit({ type: 'planItemDeleted', id: planItemId, projectId: item.projectId });
    await maybeAutoCompleteForItem(item);
    await advanceQueueIfIdle(item.projectId);
  }

  /**
   * Whether a PlanItem has work really in progress: a live session among its Tasks (`isLiveTask`),
   * or its WorkflowRun still running or waiting on a human. Never its stored status — a lost exit or
   * a late hook can leave that stale (see `reconcileStalePlanItems`).
   */
  async function isPlanItemLive(item: PlanItemRecord): Promise<boolean> {
    const run = item.workflowRunId ? await workflowRunsDb.get(item.workflowRunId) : undefined;
    if (run && UNSETTLED_RUN_STATUSES.includes(run.status)) return true;
    const tasks = await Promise.all(item.taskIds.map((id) => tasksDb.get(id)));
    return tasks.some((task) => isLiveTask(task, terminalSessions));
  }

  /** `PATCH /api/plan-items/:id {archived}` — archives or restores an item, refusing to archive one whose work is really still running (PlanItemHasActiveTaskError). */
  async function archivePlanItem(planItemId: string, archived: boolean): Promise<PlanItemRecord> {
    const item = await getPlanItem(planItemId);
    if (archived && await isPlanItemLive(item)) throw new PlanItemHasActiveTaskError(item, 'archiving');
    const updated = await archivePlanItemRecord(planItemId, archived);
    emit({ type: 'planItem', planItem: updated });
    if (archived) await maybeAutoCompleteForItem(updated);
    return updated;
  }

  /** A planning session may only edit/delete one of its Project's items that isn't really running right now. */
  async function assertPlanningItemIdle(projectId: string, itemId: string, action: 'deleting' | 'editing'): Promise<void> {
    const item = await getPlanItem(itemId);
    if (item.projectId === projectId && await isPlanItemLive(item)) throw new PlanItemHasActiveTaskError(item, action);
  }

  /** What a planning session may edit or delete: an idle task of its Project. A bug belongs to its report session and the person. */
  async function assertPlanningTask(projectId: string, itemId: string, action: 'deleting' | 'editing'): Promise<void> {
    await assertPlanningItemIdle(projectId, itemId, action);
    const item = await getPlanItem(itemId);
    if (item.projectId === projectId && isBug(item)) throw new BugNotPlanningTaskError(item);
  }

  /**
   * Startup self-heal for a PlanItem whose stored status says it's still in progress
   * ('developing'/'blocked') although nothing of it is: its WorkflowRun has already settled (e.g. a
   * late Stop hook once overwrote a completed run's 'done'), or its plain Tasks all have. The item is
   * re-derived from its run (`syncPlanItemForRun`) or from its latest Task (`syncPlanItem`) — so a
   * stuck item fixes itself on the next start, without anyone hand-editing data. Runs after
   * `resumeInterruptedTasks`, once every interrupted Task has been settled.
   */
  async function reconcileStalePlanItems(): Promise<void> {
    const stale = await planItemsDb.find((item) => item.status === 'developing' || item.status === 'blocked');
    for (const item of stale) {
      if (await isPlanItemLive(item)) continue;
      const run = item.workflowRunId ? await workflowRunsDb.get(item.workflowRunId) : undefined;
      if (run) {
        if (planItemStatusForRun(run) !== item.status) await syncPlanItemForRun(run);
        continue;
      }
      const latestTask = item.taskIds.length ? await tasksDb.get(item.taskIds.at(-1)!) : undefined;
      if (latestTask && latestTask.status !== item.status) await syncPlanItem(item.id, latestTask);
    }
  }

  /** Every WorkflowRun for a Project, newest first — `GET /api/projects/:id/workflow-runs`. */
  async function listWorkflowRunsForProject(projectId: string): Promise<WorkflowRunRecord[]> {
    const runs = await workflowRunsDb.find((r) => r.projectId === projectId);
    return runs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * A Project's testing setup as the Testing tab shows it: the newest setup PlanItem that is still
   * active (queued, running, awaiting approval, needing attention or failed), otherwise the newest
   * one if it completed, otherwise null — a stopped (rejected) setup leaves nothing behind.
   */
  async function getTestingSetup(projectId: string): Promise<(Omit<TestingSetupStartResult, 'existing'> & { active: boolean }) | null> {
    await getProject(projectId); // 404s if the project doesn't exist
    const items = (await listPlanItems(projectId)).filter((item) => item.testingSetup).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const active = items.find((item) => item.status !== 'done' && item.status !== 'stopped');
    const shown = active ?? (items[0]?.status === 'done' ? items[0] : undefined);
    if (!shown) return null;
    const run = shown.workflowRunId ? (await workflowRunsDb.get(shown.workflowRunId)) ?? null : null;
    const queueEntry = (await listPlanItemQueue(projectId)).find((entry) => entry.planItemId === shown.id) ?? null;
    return { planItem: shown, run, queueEntry, active: Boolean(active) };
  }

  /**
   * `POST /api/projects/:id/testing/setup` — "Set up / Reconfigure / Repair testing". Returns the
   * Project's active setup when there is one (a second click never creates a duplicate); otherwise
   * creates a setup PlanItem, titled from the config's state in the Project's checkout, and runs it
   * through the ordinary plan-item queue, so it starts now or waits its turn like any Open Task.
   */
  function startTestingSetup(projectId: string, options: { executorId?: string } = {}): Promise<TestingSetupStartResult> {
    return serializeOn(setupLocks, projectId, async () => {
      const project = await getProject(projectId);
      const current = await getTestingSetup(projectId);
      if (current?.active) {
        // A pending setup with neither a run nor a queue entry lost its place (its queued start
        // failed); put it back in the queue rather than leaving it stranded.
        if (current.planItem.status === 'pending' && !current.run && !current.queueEntry) {
          return { existing: true, ...(await enqueueSetup(current.planItem, options.executorId)) };
        }
        return { existing: true, planItem: current.planItem, run: current.run, queueEntry: current.queueEntry };
      }
      if (options.executorId && !(await getExecutor(options.executorId))) throw new ExecutorNotFoundError();

      const config = await loadTestingConfig(projectAbsolutePath(project));
      const mode = setupModeFor(config);
      const item = await createPlanItem({ projectId, title: SETUP_TITLES[mode], description: setupPlanItemDescription(config), testingSetup: { mode } });
      emit({ type: 'planItem', planItem: item });
      try {
        return { existing: false, ...(await enqueueSetup(item, options.executorId)) };
      } catch (error) {
        // Couldn't start or queue it: leave no orphaned item behind.
        await discardUnstartedPlanItem(item);
        throw error;
      }
    });
  }

  async function enqueueSetup(item: PlanItemRecord, executorId: string | undefined): Promise<Omit<TestingSetupStartResult, 'existing'>> {
    const result = await enqueuePlanItemExecution(item.id, { executorId });
    const planItem = await getPlanItem(item.id);
    if (!result.started) return { planItem, run: null, queueEntry: result.entry };
    const run = planItem.workflowRunId ? (await workflowRunsDb.get(planItem.workflowRunId)) ?? null : null;
    return { planItem, run, queueEntry: null };
  }

  async function discardUnstartedPlanItem(item: PlanItemRecord): Promise<void> {
    await deletePlanItemRecord(item.id).catch(() => undefined);
    emit({ type: 'planItemDeleted', id: item.id, projectId: item.projectId });
  }


  // ---- Conflict-resolution runs (the PR tab's Merge on a conflicting pull request) ----

  async function isConflictRunTask(task: Pick<TaskRecord, 'workflowRunId'>): Promise<boolean> {
    return Boolean(task.workflowRunId && (await workflowRunsDb.get(task.workflowRunId))?.prConflict);
  }

  /** The newest conflict-resolution run for a pull request, whatever its state — how a PR row finds its run again after a reload or a daemon restart. */
  async function latestConflictRun(projectId: string, number: number): Promise<WorkflowRunRecord | null> {
    const runs = await workflowRunsDb.find((run) => run.projectId === projectId && run.prConflict?.number === number);
    return runs.reduce<WorkflowRunRecord | null>((newest, run) => (!newest || run.createdAt > newest.createdAt ? run : newest), null);
  }

  /** Still working: running, merging, or paused on a question its live session asked. A run whose session ended without finishing is not. */
  async function isConflictRunActive(run: WorkflowRunRecord): Promise<boolean> {
    if (run.status === 'starting' || run.status === 'running' || run.status === 'completing') return true;
    if (run.status !== 'needs-attention' || !run.currentStepId) return false;
    return (await latestStepRun(run.id, run.currentStepId))?.status === 'running';
  }

  async function activeConflictRun(projectId: string, number: number): Promise<WorkflowRunRecord | null> {
    const run = await latestConflictRun(projectId, number);
    return run && await isConflictRunActive(run) ? run : null;
  }

  /** Clears away a failed or stopped conflict run before a fresh one replaces it: its worktree goes, and its card leaves the board (archived, not deleted, so its session stays readable). */
  async function retireConflictRun(run: WorkflowRunRecord): Promise<void> {
    if (run.status !== 'completed' && run.status !== 'stopped') await haltWorkflowRun(run);
    await cleanupRunWorktree(run);
    const item = await getPlanItem(run.planItemId).catch(() => null);
    if (!item || item.status === 'done' || item.archived) return;
    emit({ type: 'planItem', planItem: await archivePlanItemRecord(item.id, true) });
  }

  /**
   * Starts the conflict-resolution run for a pull request with the agent the person chose, or
   * returns the one already working on it (one run per pull request at a time). It starts at once,
   * beside whatever else is running: it has its own worktree and never joins the plan-item queue.
   */
  function startConflictRun(
    projectId: string,
    reading: PullRequestReading,
    executorId: string,
    autoMerge?: { planItemId: string; title: string },
  ): Promise<{ run: WorkflowRunRecord; existing: boolean }> {
    return serializeOn(conflictLocks, `${projectId}#${reading.number}`, async () => {
      const prior = await latestConflictRun(projectId, reading.number);
      if (prior && await isConflictRunActive(prior)) return { run: prior, existing: true };
      const executor = await getExecutor(executorId);
      if (!executor) throw new ExecutorNotFoundError();
      if (!isInteractiveCli(executor)) throw new ExecutorNotSupportedError(executor);
      if (prior) await retireConflictRun(prior);

      const prConflict: PullRequestConflictTarget = {
        number: reading.number,
        title: reading.title,
        headBranch: reading.headBranch,
        baseBranch: reading.baseBranch,
        pushRemote: reading.headRepositoryUrl ?? 'origin',
        ...(autoMerge ? { autoMergeItemId: autoMerge.planItemId } : {}),
      };
      const item = await createPlanItem({ projectId, title: autoMerge?.title ?? conflictRunTitle(prConflict), description: conflictPlanItemDescription(prConflict), prConflict });
      emit({ type: 'planItem', planItem: item });
      try {
        await startWorkflowRun(item, { executorId });
      } catch (error) {
        await discardUnstartedPlanItem(item);
        throw error;
      }
      const started = await latestConflictRun(projectId, reading.number);
      if (!started) throw new WorkflowRunNotFoundError();
      return { run: started, existing: false };
    });
  }

  /**
   * Reads the pull request again after the resolution was pushed. The provider recomputes
   * mergeability in the background, so for a moment it still reports the old head or "unknown":
   * wait for a reading of the pushed commit with a known answer, and after the last attempt take
   * whatever it says (an unknown state then counts as a blocker, never as clean).
   */
  async function recheckPullRequest(project: ProjectRecord, number: number, pushedSha: string): Promise<PullRequestReading> {
    let reading = await readPullRequest(project, number);
    for (let attempt = 1; attempt < pullRequestRecheck.attempts; attempt += 1) {
      const settled = reading.state !== 'open' || (reading.headSha === pushedSha && reading.mergeable !== 'unknown');
      if (settled) break;
      await new Promise((resolve) => setTimeout(resolve, pullRequestRecheck.delayMs));
      reading = await readPullRequest(project, number);
    }
    return reading;
  }

  /** Pushes the resolution to the PR's head branch (never forced), re-checks the PR and merges it when it is clean. */
  async function resolveAndMerge(run: WorkflowRunRecord, project: ProjectRecord): Promise<{ outcome: PullRequestConflictOutcome; detail: string }> {
    const pr = run.prConflict!;
    if (!run.worktreePath) return { outcome: 'failed', detail: 'The run has no working copy to push from.' };
    try {
      await withProjectGithub(project, 'push the conflict resolution', () => commitAndPushHeadTo(run.worktreePath!, pr.pushRemote, pr.headBranch, `Merge ${pr.baseBranch} into ${pr.headBranch} to resolve conflicts`));
    } catch (error) {
      return { outcome: 'failed', detail: `The resolution could not be pushed to "${pr.headBranch}": ${(error as Error).message}` };
    }
    const pushedSha = await git(run.worktreePath, ['rev-parse', 'HEAD']);
    const reading = await recheckPullRequest(project, pr.number, pushedSha);
    const state = classifyMergeState(reading);
    if (state.status === 'unmergeable') return { outcome: 'failed', detail: state.reason ?? 'The pull request can no longer be merged.' };
    if (state.status === 'conflicts') return { outcome: 'failed', detail: 'The pull request still conflicts with its base after the resolution was pushed.' };
    if (state.status === 'blocked') return { outcome: 'resolved', detail: `Conflicts resolved. Merging still needs your confirmation: ${state.blockers.join('; ')}.` };
    // A run started by a task's Auto-merge merges only while that toggle is still on.
    if (pr.autoMergeItemId && !(await planItemsDb.get(pr.autoMergeItemId))?.autoMerge?.enabled) {
      return { outcome: 'resolved', detail: 'Conflicts resolved. Auto-merge was turned off, so the pull request was not merged.' };
    }
    try {
      const merged = await mergePullRequest(project, reading);
      return { outcome: 'merged', detail: merged.branchWarning ?? merged.branchNote ?? `Merged, and the branch "${pr.headBranch}" was deleted.` };
    } catch (error) {
      return { outcome: 'failed', detail: `Conflicts were resolved, but the merge failed: ${(error as Error).message}` };
    }
  }

  /**
   * A conflict run's whole Complete stage, in place of `completeWorkflowRun` (no summary, no new
   * PR): see `resolveAndMerge`. Whatever happens the run settles, as completed (merged, or resolved
   * and waiting for the person to confirm other blockers) or failed with the reason, and its
   * worktree goes: a Retry from the PR tab starts a fresh run from the PR's then-current head.
   */
  async function finishConflictRun(run: WorkflowRunRecord, project: ProjectRecord): Promise<void> {
    const completing = await workflowRunsDb.update(run.id, { status: 'completing', currentStepId: null, updatedAt: new Date().toISOString() });
    if (completing) emit({ type: 'workflowRun', run: completing });
    const result = await resolveAndMerge(run, project)
      .catch((error): { outcome: PullRequestConflictOutcome; detail: string } => ({ outcome: 'failed', detail: (error as Error).message }));
    await settleConflictRun(run, result.outcome, result.detail);
  }

  async function settleConflictRun(run: WorkflowRunRecord, outcome: PullRequestConflictOutcome, detail: string): Promise<void> {
    const now = new Date().toISOString();
    const failed = outcome === 'failed';
    const settled = await workflowRunsDb.update(run.id, {
      status: failed ? 'failed' : 'completed',
      prConflict: { ...run.prConflict!, outcome, detail },
      completionReport: detail,
      attentionReason: failed ? detail : null,
      completedAt: failed ? null : now,
      updatedAt: now,
    });
    if (settled) { emit({ type: 'workflowRun', run: settled }); await syncPlanItemForRun(settled); }
    await cleanupRunWorktree(run);
    await advanceQueueIfIdle(run.projectId);
  }

  /** A conflict run the previous process left mid-merge can't finish any more: report it failed, so its PR row offers Retry instead of spinning. */
  async function recoverInterruptedConflictRuns(): Promise<void> {
    const interrupted = await workflowRunsDb.find((run) => Boolean(run.prConflict) && run.status === 'completing');
    for (const run of interrupted) await settleConflictRun(run, 'failed', 'The daemon restarted while the pull request was being merged.');
  }

  /**
   * The run plus every step's full round history, shaped for a frontend Stepper: one entry per
   * WorkflowStep with every round it's had so far.
   */
  async function getWorkflowRunDetail(runId: string) {
    const run = await requireWorkflowRun(runId);
    const earlierRuns = run.regression ? await earlierRunsOf(run) : [];
    const steps = await Promise.all(run.workflowSnapshot.steps.map(async (step) => ({
      step,
      rounds: await allStepRuns(run.id, step.id),
      // A regression run also lists the step's rounds from the bug's earlier runs, read-only, so round 1 stays reachable.
      ...(earlierRuns.length ? { earlierRounds: await earlierRoundsOf(earlierRuns, step.id) } : {}),
    })));
    const item = await planItemsDb.get(run.planItemId);
    return { run, steps, stepNotes: item?.stepNotes ?? {} };
  }

  /** The runs of the same item that started before `run`, oldest first. */
  async function earlierRunsOf(run: WorkflowRunRecord): Promise<WorkflowRunRecord[]> {
    return (await workflowRunsDb.find((candidate) => candidate.planItemId === run.planItemId && candidate.createdAt < run.createdAt))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** `stepId`'s rounds that ran in `earlierRuns`, each with the round number it was shown as then (its own run's offset plus its round). */
  async function earlierRoundsOf(earlierRuns: WorkflowRunRecord[], stepId: string): Promise<(StepRunRecord & { displayRound: number })[]> {
    const rounds: (StepRunRecord & { displayRound: number })[] = [];
    for (const earlier of earlierRuns) {
      for (const stepRun of await allStepRuns(earlier.id, stepId)) {
        if (stepRun.status !== 'skipped') rounds.push({ ...stepRun, displayRound: (earlier.regression?.roundOffsets[stepId] ?? 0) + stepRun.round });
      }
    }
    return rounds;
  }

  /** Reports a step Task orphaned by a daemon restart as `needs-attention` instead of trying to relaunch it — see `resumeInterruptedTasks`. */
  async function recoverOrphanedWorkflowStepTask(task: TaskRecord): Promise<void> {
    try {
      const updatedTask = await requireTaskUpdate(task.id, { status: 'failed', failureReason: 'The daemon restarted while this workflow step was running.' });
      const project = await getProject(updatedTask.projectId).catch(() => null);
      if (project) {
        const updatedProject = await removeActiveTask(project.id, updatedTask.id);
        emit({ type: 'project', project: updatedProject });
      }
      emit({ type: 'task', task: updatedTask });
      const run = task.workflowRunId ? await workflowRunsDb.get(task.workflowRunId) : undefined;
      if (!run) return;
      const step = task.workflowStepId ? findStep(run, task.workflowStepId) : undefined;
      const stepRun = await findRunningStepRun(task.id);
      if (stepRun) {
        const updatedStepRun = await stepRunsDb.update(stepRun.id, { status: 'stopped', completedAt: new Date().toISOString() });
        if (updatedStepRun) emit({ type: 'stepRun', stepRun: updatedStepRun });
      }
      if (run.status === 'running' || (stepRun && run.status === 'needs-attention')) {
        await setWorkflowRunNeedsAttention(run, `${step?.name ?? 'A'} step ended without completing (daemon restarted).`);
      }
    } catch (error) {
      console.error(`Failed to recover workflow step task ${task.id} after restart:`, error);
    }
  }

  /**
   * The end of the "Task ended without ever completing/skipping" path from `settleDone`/`settleStopped`/`settleFailed`:
   * always does the ordinary active-task/emit bookkeeping, then — only if that Task's StepRun is
   * still 'running' (complete_step/skip_step never got called for this attempt, and `stopWorkflowRun`
   * didn't already finalize it) — marks the StepRun failed/stopped and the run `needs-attention`,
   * per task 3.012's spec: however the session ends — its own exit (even a well-formed `'done'` turn
   * whose model never actually called the tool), a Stop, or a crash — not having called
   * `complete_step`/`skip_step` is always an incomplete attempt, never inferred success.
   */
  async function finalizeWorkflowStepTask(task: TaskRecord, project: ProjectRecord): Promise<void> {
    const updatedProject = await removeActiveTask(project.id, task.id);
    emit({ type: 'project', project: updatedProject });
    emit({ type: 'task', task });
    await advanceQueueIfIdle(project.id);
    const stepRun = await findRunningStepRun(task.id);
    if (!stepRun) return;
    const run = await workflowRunsDb.get(stepRun.runId);
    if (!run) return;
    const step = findStep(run, stepRun.stepId);
    const finalStatus: StepRunStatus = task.status === 'stopped' ? 'stopped' : 'failed';
    const updatedStepRun = await stepRunsDb.update(stepRun.id, { status: finalStatus, completedAt: new Date().toISOString() });
    if (updatedStepRun) emit({ type: 'stepRun', stepRun: updatedStepRun });
    // 'needs-attention' here can only be this same round's unanswered question (see
    // `syncStepQuestionOnRun`) — the session is gone now, so replace that with why it ended.
    if (run.status === 'running' || run.status === 'completing' || run.status === 'needs-attention') {
      await setWorkflowRunNeedsAttention(run, `${step?.name ?? 'A'} step ended without completing${task.failureReason ? `: ${task.failureReason}` : '.'}`);
    }
  }

  /**
   * A workflow step's interactive-CLI session ended — routes to the same settle* funnels an ordinary
   * terminal Task uses (each already branches on `task.workflowRunId` — see
   * `finalizeWorkflowStepTask`), just without the docs-and-retro/pause ambiguity an ordinary terminal
   * Task has: a step Task that exits cleanly and wasn't explicitly stopped is 'done', not merely
   * paused, since `complete_step`/`skip_step` (if ever called) already recorded the real outcome.
   *
   * Checked first, before `stopped`/`exitCode` at all: if `complete_step`/`skip_step` already
   * resolved this exact attempt (status 'done' or 'skipped' — never 'running'), the exit itself
   * carries no new information and is always settled 'done' — including when `endStepSession` is
   * what caused it (its resulting kill can surface as a nonzero code/signal, which must never be
   * misread as a failure), and including a genuine race where the CLI's own process happened to exit
   * around the same moment for an unrelated reason. A `stopWorkflowRun`/`stopTask`-initiated stop
   * already recorded its own StepRunRecord status ('stopped', not 'done'/'skipped') before ever
   * touching the session, so it still falls through to the `stopped` branch below correctly.
   */
  async function settleWorkflowStepTaskExit(task: TaskRecord, project: ProjectRecord, stopped: boolean, exitCode: number, sessionId: string): Promise<void> {
    const resolved = (await stepRunsDb.find((s) => s.taskId === task.id)).some((s) => s.status === 'done' || s.status === 'skipped');
    if (resolved) {
      await settleDone(task, project, { sessionId, status: 'done', message: 'Step session completed.', raw: { type: 'terminal.exit', exitCode } }, task.tokenUsage ?? ZERO_TOKEN_USAGE);
      return;
    }
    if (stopped) { await settleStopped(task, project, sessionId); return; }
    if (exitCode !== 0) { await settleFailed(task, project, `Interactive CLI exited with code ${exitCode}.`, sessionId); return; }
    await settleDone(task, project, { sessionId, status: 'done', message: 'Step session completed.', raw: { type: 'terminal.exit', exitCode } }, task.tokenUsage ?? ZERO_TOKEN_USAGE);
  }

  /**
   * The internal task-management API (`/api/agent-tasks`, reached through planTaskTool.ts's MCP
   * server). Only a running 'plan'-kind Task may call it, and only for its own Project, so a stale
   * or foreign task id can't touch work anywhere. Changes are serialized per Project, so
   * concurrent `create_task` calls can't pick the same task number.
   */
  async function requirePlanningSession(taskId: string): Promise<TaskRecord> {
    const task = await requireTask(taskId);
    if (task.kind !== 'plan' || task.planningPurpose || task.status !== 'developing') throw new TaskNotPlanningSessionError();
    return task;
  }

  /**
   * The Task behind a bug-filing call (`POST /api/agent-testing/bugs`). The tool is given to the
   * same sessions as the testing tools, but only one still doing its task may file: `developing`,
   * in its Project's `activeTaskIds`, allowed to edit code, and not a session reopened for inspection.
   */
  async function requireBugFilingSession(taskId: string): Promise<TaskRecord> {
    const task = await requireTask(taskId);
    const stepPermissions = task.workflowRunId ? await resolveStepPermissions(task, false) : null;
    const filing = !inspectSessions.has(taskId) && task.status === 'developing' && testingToolsAllowed(task, stepPermissions);
    if (!filing || !activeTaskIdsOf(await getProject(task.projectId)).includes(task.id)) throw new TaskNotBugFilingSessionError();
    return task;
  }

  /**
   * The Task behind a testing-tool call (`/api/agent-testing`). Only a Task that got the testing
   * tools (see `testingToolsAllowed`) and is still active may run tests. A live reopened step may
   * also run them when its original setup included testing and it reopened with permissions.
   */
  async function requireTestingSession(taskId: string): Promise<TaskRecord> {
    const task = await requireTask(taskId);
    if (inspectSessions.has(taskId)) {
      if (terminalSessions.has(taskId) && inspectSessionModes.get(taskId) === 'permissions' && inspectSessionTesting.has(taskId)) return task;
      throw new TaskNotTestingSessionError(taskId);
    }
    const stepPermissions = task.workflowRunId ? await resolveStepPermissions(task, false) : null;
    if (task.status !== 'developing' || !testingToolsAllowed(task, stepPermissions)) throw new TaskNotTestingSessionError(taskId);
    const project = await getProject(task.projectId);
    if (!activeTaskIdsOf(project).includes(task.id)) throw new TaskNotTestingSessionError(taskId);
    return task;
  }

  async function listPlanningTasks(taskId: string): Promise<PlanItemRecord[]> {
    return listPlanItems((await requirePlanningSession(taskId)).projectId);
  }

  async function createPlanningTask(taskId: string, draft: PlanningTaskDraft): Promise<PlanItemRecord> {
    return addPlanningTask(await requirePlanningSession(taskId), draft);
  }

  async function updatePlanningTask(taskId: string, itemId: string, patch: Partial<PlanningTaskDraft>): Promise<PlanItemRecord> {
    const task = await requirePlanningSession(taskId);
    return serializeOn(planningLocks, task.projectId, async () => {
      await assertPlanningTask(task.projectId, itemId, 'editing');
      const planItem = await editPlanningPlanItem(task.projectId, itemId, patch);
      emit({ type: 'planItem', planItem });
      return planItem;
    });
  }

  async function deletePlanningTask(taskId: string, itemId: string): Promise<void> {
    const task = await requirePlanningSession(taskId);
    await serializeOn(planningLocks, task.projectId, async () => {
      await assertPlanningTask(task.projectId, itemId, 'deleting');
      const item = await getPlanItem(itemId);
      await rememberLegacyPlanningTasks(item);
      await deletePlanningPlanItem(task.projectId, itemId);
      emit({ type: 'planItemDeleted', id: itemId, projectId: task.projectId });
      await maybeAutoCompletePlanningSessionUnlocked(item.projectId, item.planningRef?.session);
    });
  }

  /** The task tools of an Agent terminal session: the same Project-scoped changes a planning session makes, without a planning Task behind them (so the tasks carry no session number). */
  async function createProjectTask(projectId: string, draft: PlanningTaskDraft): Promise<PlanItemRecord> {
    return serializeOn(planningLocks, projectId, async () => {
      const planItem = await createPlanItem({ projectId, ...draft });
      emit({ type: 'planItem', planItem });
      return planItem;
    });
  }

  async function updateProjectTask(projectId: string, itemId: string, patch: Partial<PlanningTaskDraft>): Promise<PlanItemRecord> {
    return serializeOn(planningLocks, projectId, async () => {
      await assertPlanningTask(projectId, itemId, 'editing');
      const planItem = await editPlanningPlanItem(projectId, itemId, patch);
      emit({ type: 'planItem', planItem });
      return planItem;
    });
  }

  async function deleteProjectTask(projectId: string, itemId: string): Promise<void> {
    await serializeOn(planningLocks, projectId, async () => {
      await assertPlanningTask(projectId, itemId, 'deleting');
      await rememberLegacyPlanningTasks(await getPlanItem(itemId));
      await deletePlanningPlanItem(projectId, itemId);
      emit({ type: 'planItemDeleted', id: itemId, projectId });
    });
  }

  /** Adds one numbered ("<session>.<task>: ...", e.g. "3.002: ...") open task for a planning session, giving a session that predates numbering its number first. */
  function addPlanningTask(task: TaskRecord, draft: PlanningTaskDraft): Promise<PlanItemRecord> {
    return serializeOn(planningLocks, task.projectId, async () => {
      let session = (await requireTask(task.id)).planningSessionNumber;
      if (!session) {
        session = await nextPlanningSessionNumber(task.projectId);
        emit({ type: 'task', task: await requireTaskUpdate(task.id, { planningSessionNumber: session }) });
      }
      const planItem = await createPlanningPlanItem({ projectId: task.projectId, session, planningTaskId: task.id, ...draft });
      emit({ type: 'planItem', planItem });
      await recordSessionCreation(task);
      return planItem;
    });
  }

  /** Counts one more task or bug created by this session, on every Task of its conversation, and arms its automatic completion. */
  async function recordSessionCreation(session: TaskRecord): Promise<void> {
    const members = await sessionMembers(session);
    const count = Math.max(...members.map((member) => member.planningCreatedTaskCount ?? 0), 0) + 1;
    for (const member of members) {
      const updated = await tasksDb.update(member.id, { planningCreatedTaskCount: count, planningAutoCompleteArmed: true });
      if (updated) emit({ type: 'task', task: updated });
    }
  }

  const bugTracker = createBugTracker({
    emitPlanItem: (planItem) => emit({ type: 'planItem', planItem }),
    emitPlanItemDeleted: (id, projectId) => emit({ type: 'planItemDeleted', id, projectId }),
    requireTask,
    withPlanningLock: (projectId, fn) => serializeOn(planningLocks, projectId, fn),
    recordSessionCreation,
    autoCompleteSession: maybeAutoCompletePlanningSessionUnlocked,
    reopenBug,
  });

  /** Files a bug for the calling coding session's unrelated failing test, after checking the session may file one. */
  async function fileAgentBug(taskId: string, draft: Parameters<typeof bugTracker.fileAgentBug>[1]) {
    return bugTracker.fileAgentBug(await requireBugFilingSession(taskId), draft);
  }

  /** Starts a numbered plan-and-bugs session: a read-only planning-style session that files tasks, bugs and their dependencies. With no agent it is created without a CLI. */
  async function startPlanAndBugsSession(input: { projectId: string; description: string; executorId?: string; autonomy?: Autonomy }): Promise<TaskRecord> {
    return startTask({ ...input, kind: 'plan', planningPurpose: 'plan-and-bugs', deferCli: !input.executorId });
  }

  async function appendTurn(taskId: string, turn: TaskTurn): Promise<void> {
    const context = await taskContextsDb.get(taskId);
    if (!context) return;
    const safeTurn = { ...turn, content: redactSecrets(turn.content) };
    await taskContextsDb.update(taskId, { turns: [...context.turns, safeTurn] });
    emit({ type: 'log', taskId, turn: safeTurn });
  }

  async function logRawEvent(taskId: string, event: StreamJsonEvent): Promise<void> {
    await appendTurn(taskId, { role: 'raw-event', content: JSON.stringify(event), at: new Date().toISOString() });
  }

  async function requireTask(id: string): Promise<TaskRecord> {
    const task = await tasksDb.get(id);
    if (!task) throw new TaskNotFoundError();
    return task;
  }

  async function requireTaskUpdate(id: string, patch: Partial<Omit<TaskRecord, 'id'>>): Promise<TaskRecord> {
    const updated = await tasksDb.update(id, { ...patch, updatedAt: new Date().toISOString() });
    if (!updated) throw new TaskNotFoundError();
    return updated;
  }

  return {
    startTask,
    startPlanAndBugsSession,
    updateDeferredSessionDescription,
    launchDeferredSession,
    fileAgentBug,
    listBugReportTasks: bugTracker.listReportTasks,
    checkedSessionDependencies: bugTracker.checkedDependencies,
    createReportedBug: bugTracker.createReportedBug,
    updateReportedBug: bugTracker.updateReportedBug,
    deleteReportedBug: bugTracker.deleteReportedBug,
    createReportedTask: bugTracker.createReportedTask,
    updateReportedTask: bugTracker.updateReportedTask,
    deleteReportedTask: bugTracker.deleteReportedTask,
    setBugInfoStatus: bugTracker.setBugInfoStatus,
    reorderBugGroup: bugTracker.reorderBugGroup,
    reopenBugAsSession: bugTracker.reopenCompletedBug,
    reopenBug,
    answerTask,
    followUpTask,
    resumeTerminalTask,
    completeTerminalTask,
    interimCommitTask,
    stopTask,
    executePlanItem,
    hasFreeSlot,
    enqueuePlanItemExecution,
    advanceAllQueues,
    listPlanItemQueue,
    advanceQueueIfIdle,
    removeQueuedPlanItemExecution,
    reorderPlanItemQueue,
    completePlanItem,
    deletePlanItem,
    archivePlanItem,
    reconcileStalePlanItems,
    getTaskTranscript,
    getTask,
    listTasksForProject,
    reorderPlanningQueue,
    reorderPlanningGroup,
    retargetPrimaryTasks,
    listAllTasks,
    archiveSession,
    completePlanningSession,
    deleteSession,
    renameSession,
    handleTerminalHook,
    recordAwaitedTestRuns,
    dispose,
    listPlanningTasks,
    requireTestingSession,
    createPlanningTask,
    updatePlanningTask,
    deletePlanningTask,
    createProjectTask,
    updateProjectTask,
    deleteProjectTask,
    getTaskRuntime,
    onWorkerEvent,
    stopProjectTerminals: async (projectId: string) => {
      for (const task of await tasksDb.find((t) => t.projectId === projectId)) terminalSessions.stop(task.id);
    },
    resumeInterruptedTasks,
    whenStartupSettled,
    // Workflow run engine (task 3.012)
    listWorkflowRunsForProject,
    getWorkflowRunDetail,
    setStepNote,
    getWorkflowRun: requireWorkflowRun,
    completeStep,
    skipStep,
    reportProgress,
    stepDiffSummary,
    stepDiffFile,
    approveWorkflowRun,
    approveTestingSetup,
    startTestingSetup,
    getTestingSetup,
    requestChangesWorkflowRun,
    decideWorkflowRunLoop,
    retryWorkflowStep,
    resumeWorkflowRun,
    stopWorkflowRun,
    reopenStepSession,
    stepReopenOptions,
    resolveStepInspectChanges,
    closeStepSession,
    startConflictRun,
    activeConflictRun,
    latestConflictRun,
    publishEvent: emit,
  };
}

/** A Task's first line of description/result — the specific part of a `task.*` Notification's title (docs/milestones/milestone-5-notification-system.md: "Titles should be specific"). */
function firstLine(text: string): string {
  return text.split('\n')[0]!.trim().slice(0, 100);
}

function terminalRuntimeFromTask(task: TaskRecord): TerminalRuntimeStatus {
  if (task.status === 'done') return 'completed';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'stopped') return 'stopped';
  return 'disconnected';
}

/** A step's question as shown on its WorkflowRun — the CLI Notification hook's own message when it carries one, else the generic waiting reason. */
export function stepQuestionFromHook(event: Record<string, unknown>, fallback: string | null): string {
  const message = typeof event.message === 'string' ? event.message.trim() : '';
  return message || fallback || 'The step is waiting for your input.';
}

export function terminalRuntimeFromHook(event: Record<string, unknown>): { status: TerminalRuntimeStatus; reason: string | null } | null {
  const name = String(event.hook_event_name ?? '');
  const notificationType = String(event.notification_type ?? event.type ?? '');
  if (name === 'PermissionRequest') return { status: 'waiting_input', reason: 'Waiting for approval' };
  if (name === 'Notification') {
    if (notificationType === 'permission_prompt') return { status: 'waiting_input', reason: 'Waiting for approval' };
    if (notificationType === 'agent_needs_input') return { status: 'waiting_input', reason: 'Waiting for your input' };
    if (notificationType === 'idle_prompt') return { status: 'waiting_input', reason: 'Waiting for your next instruction' };
    return null;
  }
  if (name === 'Stop') return { status: 'waiting_input', reason: 'Waiting for your next instruction' };
  if (name === 'Interrupt') return { status: 'waiting_input', reason: 'Turn interrupted; waiting for your input' };
  if (name === 'StopFailure') return { status: 'failed', reason: String(event.error ?? event.error_type ?? 'CLI turn failed') };
  if (name === 'SessionEnd') return { status: 'completed', reason: null };
  if (['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(name)) {
    return { status: 'running', reason: null };
  }
  return null;
}

/**
 * Sum of every round's own `completedAt - createdAt`, for the rounds a step has already had before
 * the one `startStepTask` is about to start — the live timer's carry-forward total across a step's
 * rounds (task 5.003; mirrors `stageSpentMs`'s math in web/src/lib/workflowRunView.ts). Every round
 * passed in is already settled by the time a new one starts, so a missing `completedAt` can't occur
 * here in practice; it contributes nothing rather than throwing, just in case.
 */
export function priorRoundsMs(rounds: Pick<StepRunRecord, 'createdAt' | 'completedAt'>[]): number {
  return rounds.reduce((sum, round) => {
    if (!round.completedAt) return sum;
    return sum + Math.max(0, new Date(round.completedAt).getTime() - new Date(round.createdAt).getTime());
  }, 0);
}

/**
 * How many Tasks this Project may run at once. A Project with no linked
 * repository has no git repo at all — `git worktree` needs one — so there is
 * no way to isolate a second concurrent Task's working directory there, and
 * the strict one-Task-per-Project limit applies. A git-backed
 * Project can isolate every Task after its first in its own worktree, up to
 * MAX_CONCURRENT_TASKS_PER_PROJECT.
 */
function concurrencyCapFor(project: ProjectRecord): number {
  return project.repositoryUrl ? MAX_CONCURRENT_TASKS_PER_PROJECT : 1;
}

/**
 * Checks a new `kind` Task against its Project's concurrency cap and returns
 * how many active Tasks it would share the Project's files with — the count
 * `assignTaskWorkspace` needs. Only file-writing Tasks count: a 'plan'-kind
 * session never changes project files (PLAN_INSTRUCTIONS), so it can start
 * while other Tasks run, always reads the Project's own directory, and never
 * pushes a later coding Task into a worktree or into TaskConflictError.
 */
async function claimConcurrencySlot(project: ProjectRecord, kind: TaskKind, sessions: SessionRegistry): Promise<number> {
  assertWritable(project);
  if (kind === 'plan') return 0;
  const writingTasks = (await liveTasksOf(project, sessions)).filter((task) => task.kind !== 'plan');
  // A run still setting up holds its slot before it has a Task; once its Task is live it is counted there.
  const launchedRunIds = new Set(writingTasks.map((task) => task.workflowRunId));
  const startingRuns = await workflowRunsDb.find((run) => run.projectId === project.id && run.status === 'starting' && !run.prConflict && !launchedRunIds.has(run.id));
  const writingCount = writingTasks.length + startingRuns.length;
  const cap = concurrencyCapFor(project);
  if (writingCount >= cap) throw new TaskLimitReachedError(project, cap, await slotOccupants(writingTasks, startingRuns));
  return writingCount;
}

/** The Tasks (and runs still starting) holding a Project's slots, for the refusal's message. */
async function slotOccupants(tasks: TaskRecord[], startingRuns: WorkflowRunRecord[]): Promise<SlotOccupant[]> {
  const describe = async (planItemId: string | null, taskId: string | null, fallbackTitle: string, state: SlotOccupant['state']): Promise<SlotOccupant> => {
    const item = planItemId ? await planItemsDb.get(planItemId) : undefined;
    const ref = item?.planningRef;
    return {
      taskId,
      planItemId,
      number: ref ? `${ref.session}.${String(ref.task).padStart(3, '0')}` : null,
      title: item?.title.replace(/^\d+\.\d+:\s*/, '') ?? fallbackTitle,
      state,
    };
  };
  return Promise.all([
    ...tasks.map((task) => describe(task.planItemId, task.id, task.description.split('\n')[0]!.trim(), task.status === 'blocked' ? 'waiting_input' : task.runtimeStatus === 'starting' ? 'starting' : 'running')),
    ...startingRuns.map((run) => describe(run.planItemId, null, 'Starting', 'starting')),
  ]);
}

/**
 * Decides where a new Task's turn actually runs. A Project's first/only
 * concurrently active Task always uses the Project's own primary working
 * directory directly, on whatever branch is already checked out there — the
 * common single-Task case keeps zero worktree overhead, exactly like
 * pre-worktree v1 behavior. Once a Project already has another active Task,
 * the new one gets a fresh isolated `git worktree`, on a brand-new branch
 * (`task/<id>` — this Task's own id, guaranteeing no collision with any
 * other Task's branch) created off whatever the Project's own directory
 * currently has checked out. A Project with no linked repository never
 * reaches the worktree branch here: `concurrencyCapFor` caps it at 1, so
 * `activeCount` is always 0 by the time callers get here.
 */
async function assignTaskWorkspace(
  project: ProjectRecord,
  taskId: string,
  activeCount: number,
): Promise<{ branch: string | undefined; worktreePath: string | undefined }> {
  if (!project.repositoryUrl) return { branch: undefined, worktreePath: undefined };

  const projectDir = projectAbsolutePath(project);
  const baseBranch = await currentBranch(projectDir);
  if (activeCount === 0) return { branch: baseBranch, worktreePath: undefined };

  const branch = `task/${taskId}`;
  const worktreePath = projectWorktreePath(project, taskId);
  await addWorktree(projectDir, worktreePath, branch, baseBranch);
  await ensureProjectCliHooks(worktreePath);
  return { branch, worktreePath };
}

/**
 * Removes a settled Task's own worktree directory, if it had one — freeing
 * disk and avoiding an orphaned worktree entry, while deliberately leaving
 * the branch (and anything already pushed to it) in place for a human, or a
 * future roadmap item, to review and merge: worktree Tasks never auto-merge,
 * matching claude-squad/crystal's "isolated, reviewable work" model rather
 * than silent auto-integration. Best-effort: a failure here is a disk-space
 * nit, never a reason to change a Task's already-settled outcome.
 */
async function cleanupWorktree(project: ProjectRecord, task: TaskRecord): Promise<void> {
  if (!task.worktreePath) return;
  try {
    await removeWorktree(projectAbsolutePath(project), task.worktreePath);
  } catch (error) {
    console.error(`Failed to remove worktree for task ${task.id}: ${(error as Error).message}`);
  }
}

/**
 * Adds a Task to its Project's active-task set. Routed through
 * `patchProjectWith` (not a plain read-then-write) because several Tasks on
 * the *same* Project can now start/settle close together — see
 * `removeActiveTask`/`refreshProjectStatus` below for the same reasoning.
 */
async function addActiveTask(projectId: string, taskId: string): Promise<ProjectRecord> {
  return patchProjectWith(projectId, async (project) => {
    const activeTaskIds = [...activeTaskIdsOf(project), taskId];
    return {
      activeTaskIds,
      activeTaskId: taskId,
      taskCount: project.taskCount + 1,
      status: await computeAggregateStatus(activeTaskIds),
    };
  });
}

/**
 * Removes a Task from its Project's active-task set once it settles
 * (done/failed). `activeTaskId` — kept for UI built around "the" one active
 * Task per Project — becomes whichever other Task is now the most recently
 * started still-active one, or null if none remain.
 */
async function removeActiveTask(projectId: string, taskId: string): Promise<ProjectRecord> {
  return patchProjectWith(projectId, (project) => reconcileActiveTasks(activeTaskIdsOf(project).filter((id) => id !== taskId)));
}

/**
 * Recomputes a Project's aggregate `status` from the live statuses of its active-task set — used
 * when a member Task's own status changes (blocked/answered). Also drops any member that is no
 * longer actually active (settled, or deleted), so a Project whose Tasks have all left
 * developing/blocked always falls back to 'idle' rather than staying stuck on a stale id.
 */
async function refreshProjectStatus(projectId: string): Promise<ProjectRecord> {
  return patchProjectWith(projectId, (project) => reconcileActiveTasks(activeTaskIdsOf(project)));
}

async function reconcileActiveTasks(candidateIds: string[]): Promise<Pick<ProjectRecord, 'activeTaskIds' | 'activeTaskId' | 'status'>> {
  const tasks = await Promise.all(candidateIds.map((id) => tasksDb.get(id)));
  const activeTaskIds = candidateIds.filter((_, i) => isActiveTask(tasks[i]));
  return {
    activeTaskIds,
    activeTaskId: activeTaskIds.at(-1) ?? null,
    status: aggregateStatusOf(tasks),
  };
}

async function computeAggregateStatus(activeTaskIds: string[]): Promise<ProjectRecord['status']> {
  return aggregateStatusOf(await Promise.all(activeTaskIds.map((id) => tasksDb.get(id))));
}

/** A PlanItem's title for a user-facing message, or undefined when the item is gone (see `named`). */
async function planItemTitle(planItemId: string): Promise<string | undefined> {
  return (await getPlanItem(planItemId).catch(() => null))?.title;
}

/** A Task's human name for a user-facing message: the title of the PlanItem it runs, if any — never its id. */
async function taskName(task: Pick<TaskRecord, 'planItemId'>): Promise<string | undefined> {
  return task.planItemId ? planItemTitle(task.planItemId) : undefined;
}

async function runNotActionable(run: WorkflowRunRecord, action: string): Promise<WorkflowRunNotActionableError> {
  return new WorkflowRunNotActionableError(await planItemTitle(run.planItemId), action, run.status);
}

/**
 * A Project's own `status` is a single aggregate over however many Tasks are
 * currently active on it (see docs/architecture.md's amended "One task per
 * project in version 1") — 'blocked' wins over 'developing' since it's the
 * one that actually needs a human's attention, and 'idle' means none of them
 * are still developing/blocked.
 */
function aggregateStatusOf(tasks: (TaskRecord | undefined)[]): ProjectRecord['status'] {
  const active = tasks.filter(isActiveTask);
  if (!active.length) return 'idle';
  return active.some((t) => t.status === 'blocked' || t.runtimeStatus === 'waiting_input') ? 'blocked' : 'developing';
}

/** Sent into a stopped step's own resumed session by `resumeWorkflowRun`. */
const RESUME_PROMPT = 'Continue.';
/** Sent when Retry continues a step's unfinished session. */
const RETRY_PROMPT = 'Your previous attempt at this step was interrupted or failed before it finished. Continue.';

/** Adds one turn's usage onto a Task's running total. `b` is null when the turn's result carried no usage data (see extractTokenUsage) — added as a no-op rather than resetting the running total. */
function addTokenUsage(a: TokenUsage, b: TokenUsage | null): TokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    totalCostUsd: a.totalCostUsd + b.totalCostUsd,
  };
}

/**
 * Claude Code's own native sub-agent delegation tool. A manager-flagged
 * Task must never have this disallowed, regardless of `kind` — that's the
 * whole mechanism a Manager Template depends on (docs/architecture.md's
 * "Manager and sub-agent flow" section). Today only a 'plan'-kind Task sets
 * any `disallowedTools` at all (PLAN_DISALLOWED_TOOLS never includes this),
 * so this filter is currently a no-op in practice — it exists so a future
 * change to PLAN_DISALLOWED_TOOLS, or a new disallowed-tools source, can't
 * silently break delegation for a Manager Task without a test catching it.
 */
const DELEGATION_TOOL = 'Task';

/** The manager-guarantee filter: strips DELEGATION_TOOL out of a disallowed-tools list for a Manager Task, regardless of what denied `base` list a 'plan'-kind turn or a read-only workflow step would otherwise use — see resolveDisallowedTools/resolveStepPermissions. */
function filterForManager(base: string[], isManager: boolean): string[] | undefined {
  if (!isManager) return base;
  const filtered = base.filter((tool) => tool !== DELEGATION_TOOL);
  return filtered.length ? filtered : undefined;
}

/** The tool-permission half of the manager guarantee above — see runTerminalTask's `disallowedTools`. */
function resolveDisallowedTools(kind: TaskKind, isManager: boolean): string[] | undefined {
  const base = kind === 'plan' ? PLAN_DISALLOWED_TOOLS : undefined;
  return base ? filterForManager(base, isManager) : base;
}

/** Every coding session that may change code, and every read-only step that may run commands, gets the testing tools; planning sessions and other read-only steps don't. */
function testingToolsAllowed(task: TaskRecord, stepPermissions: { readOnly: boolean; canRunCommands?: boolean } | null): boolean {
  return task.kind === 'execute' && !(stepPermissions && isReadOnlySetup(stepPermissions));
}

/** A read-only step that may run commands still gets shell and testing tools; every other read-only step gets neither. */
function isReadOnlySetup(setup: { readOnly: boolean; canRunCommands?: boolean }): boolean {
  return setup.readOnly && !setup.canRunCommands;
}

/** A command-capable read-only step is denied only the file-editing tools; the shell stays available. */
const COMMAND_STEP_DISALLOWED_TOOLS = PLAN_DISALLOWED_TOOLS.filter((tool) => !['Bash', 'BashOutput', 'KillShell'].includes(tool));

/**
 * The session-scoped MCP servers a Task's CLI session gets: its own control API (planning, bug report or step), plus the testing tools when allowed.
 * Every session of a Building with an outgoing link also gets the capability tools; what each may call is decided per call, by the daemon.
 */
async function sessionMcpServers(task: TaskRecord, testing: boolean): Promise<McpServerLaunch[]> {
  const servers: McpServerLaunch[] = [];
  if (task.workflowRunId) servers.push(stepTaskMcpServer(task.id));
  else if (isPlanAndBugsSession(task)) servers.push(planAndBugsMcpServer(task.id));
  else if (task.kind === 'plan') servers.push(isBugReportSession(task) ? bugReportMcpServer(task.id) : planTaskMcpServer(task.id));
  if (testing) servers.push(testTaskMcpServer(task.id));
  if (!isBugReportSession(task) && await connections.hasOutgoingLinks(task.projectId)) servers.push(capabilityMcpServer(task.id));
  return servers;
}

/**
 * Whether a testing setup's proposal has been explicitly approved: its latest proposal round
 * carries an `approved` decision, which only `approveTestingSetup` records. A newer round (after
 * feedback or a loop back for a materially different change) starts without one.
 */
async function setupProposalApproved(runId: string): Promise<boolean> {
  const rounds = await stepRunsDb.find((s) => s.runId === runId && s.stepId === SETUP_PROPOSAL_STEP_ID);
  const latest = rounds.reduce<StepRunRecord | undefined>((newest, r) => (!newest || r.round > newest.round ? r : newest), undefined);
  return latest?.approval?.decision === 'approved';
}

/** Whether a step Task may change code: its step says so and, on a testing setup, the proposal is approved. */
export async function stepCanEditCode(task: TaskRecord): Promise<boolean> {
  const { run, step } = await snapshotStep(task);
  // A testing setup fails closed: a run or step that can't be resolved stays read-only.
  if (run?.testingSetup) return Boolean(step?.canEditCode) && await setupProposalApproved(run.id);
  return step?.canEditCode ?? true;
}

async function snapshotStep(task: TaskRecord) {
  const run = await workflowRunsDb.get(task.workflowRunId!);
  const step = task.workflowStepId ? run?.workflowSnapshot.steps.find((s) => s.id === task.workflowStepId) : undefined;
  return { run, step };
}

/**
 * A workflow step Task's permissions, mirroring 'plan'-kind's PLAN_DISALLOWED_TOOLS enforcement
 * (task 3.012's "enforced the same way as planning sessions today"): a step that may not edit code
 * gets the exact same tool denial/read-only sandbox a planning session gets. An ordinary step Task
 * with no resolvable WorkflowStep (shouldn't happen) fails open as editable, rather than silently
 * locking out a step engine bug's session with no way to fix itself; a testing setup fails closed
 * instead (see `stepCanEditCode`).
 */
async function resolveStepPermissions(task: TaskRecord, isManager: boolean): Promise<{ disallowedTools: string[] | undefined; readOnly: boolean; canRunCommands?: boolean }> {
  if (await stepCanEditCode(task)) return { disallowedTools: undefined, readOnly: false };
  // A testing setup's proposal step keeps its fail-closed read-only defense and never gets command access.
  const { run, step } = await snapshotStep(task);
  if (step?.canRunCommands === true && !run?.testingSetup) {
    return { disallowedTools: filterForManager(COMMAND_STEP_DISALLOWED_TOOLS, isManager), readOnly: true, canRunCommands: true };
  }
  return { disallowedTools: filterForManager(PLAN_DISALLOWED_TOOLS, isManager), readOnly: true };
}

/** Validates every chosen Skill exists and is enabled — the same "must exist and be enabled" rule `startTask` already applies to an explicit `templateId` — before a Task referencing it is ever persisted. A no-op for `undefined`/empty `skillIds`. */
async function assertSkillsUsable(skillIds: string[] | undefined): Promise<void> {
  if (!skillIds || skillIds.length === 0) return;
  const catalogSkills = new Map((await listSkills()).map((skill) => [skill.id, skill]));
  for (const skillId of skillIds) {
    const skill = catalogSkills.get(skillId);
    if (!skill) throw new SkillNotFoundError();
    if (!skill.enabled) throw new SkillDisabledError(skill);
  }
}

/**
 * Heading for an always-load skill's section. States up front that the skill
 * is already loaded, by its id and its real SKILL.md path. Catalog skills are
 * never installed into the Project's own `.claude/skills/` or
 * `.agents/skills/`, so an agent told to "use the <id> skill" otherwise checks
 * its installed skills, finds none, and reports the skill as missing.
 */
function skillSectionHeader(skill: Pick<SkillRecord, 'id' | 'name'>, absoluteDir: string): string {
  return [
    `## Skill: ${skill.name} (\`${skill.id}\`)`,
    '',
    `This skill is already loaded: its full SKILL.md follows. It is supplied by the runner, not installed in this project, so do not look for it among installed skills or report it as missing. Its SKILL.md is at ${path.join(absoluteDir, 'SKILL.md')}; resolve any relative path it references, such as \`references/...\`, against ${absoluteDir}.`,
  ].join('\n');
}

const ON_DEMAND_SKILLS_INTRO = [
  '## Available skills (read on demand)',
  '',
  'These skills are supplied by the runner, not installed in this project, so do not look for them among installed skills or report them missing.',
  'Before starting, check each description against the work. When one applies, Read that SKILL.md in full before acting, and follow it.',
  "Resolve any relative path a SKILL.md mentions, such as `references/...`, against that skill's directory, and read those files only when the SKILL.md says to.",
  "Do not read skills whose description doesn't apply.",
  'If you are asked for a summary (for example by `complete_step`), list which skills you read.',
].join('\n');

function skillDirPath(skill: Pick<SkillRecord, 'skillDir'>): string {
  return path.join(CATALOG_DIR, skill.skillDir);
}

function onDemandSkillEntry(skill: SkillRecord): string {
  const description = skill.description.trim() || '(no description)';
  return `- ${skill.name} (\`${skill.id}\`): ${description}\n  SKILL.md: ${path.join(skillDirPath(skill), 'SKILL.md')}`;
}

/** Absolute Catalog directories of the given skill ids, in id order (the layout `SkillRecord.skillDir` names). */
function skillDirsOf(skillIds: string[] | undefined): string[] {
  return [...new Set(skillIds ?? [])]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => path.join(CATALOG_DIR, 'skills', id));
}

/**
 * The Worker's full `--append-system-prompt` text: the Template's persona,
 * then each attached Skill in skill-id order (deterministic regardless of the
 * order `skillIds` happened to be stored in):
 * - ids in `preloadSkillIds` ("always load") get their full SKILL.md body under
 *   their own `## Skill: <name> (<id>)` heading (see `skillSectionHeader`);
 * - every other attached skill is listed in one `Available skills (read on
 *   demand)` index (name, id, description, absolute SKILL.md path) for the
 *   agent to Read when the description fits the work.
 * Skills were validated to exist and be enabled at Task-creation time
 * (`assertSkillsUsable`); one deleted from the Catalog since is silently
 * skipped rather than failing an already-running Task.
 *
 * Paths and relative references resolve against the Catalog on this machine,
 * never the Task's own cwd (a different Project's repository), computed fresh
 * from `CATALOG_DIR` so the same checkout works on any machine running this daemon.
 */
export async function buildAppendSystemPrompt(
  template: TemplateRecord,
  skillIds: string[] | undefined,
  preloadSkillIds?: string[],
): Promise<string> {
  const persona = await readAgentPersona(template);
  if (!skillIds || skillIds.length === 0) return persona;

  const catalogSkills = new Map((await listSkills()).map((skill) => [skill.id, skill]));
  const preload = new Set(preloadSkillIds ?? []);
  const attached = [...new Set(skillIds)]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((id) => catalogSkills.get(id) ?? []);

  const preloaded = await Promise.all(attached.filter((skill) => preload.has(skill.id))
    .map(async (skill) => `${skillSectionHeader(skill, skillDirPath(skill))}\n\n${await readSkillBody(skill)}`));
  const onDemand = attached.filter((skill) => !preload.has(skill.id)).map(onDemandSkillEntry);

  return [persona, ...preloaded, ...(onDemand.length ? [`${ON_DEMAND_SKILLS_INTRO}\n\n${onDemand.join('\n')}`] : [])].join('\n\n');
}

/** Runs `fn` after every earlier call chained on `key` has settled, whatever the outcome — never throws on contention. */
function serializeOn<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  locks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/** Whether this executor is a supported interactive-CLI kind — every valid ExecutorProfile.kind is one now, so this only ever returns false for a stale/hand-edited executors.json entry. */
function isInteractiveCli(executor: ExecutorProfile): boolean {
  return executor.kind === 'claude-cli' || executor.kind === 'codex-cli';
}

/** `planInstructions` overrides the static `PLAN_INSTRUCTIONS` for a 'plan'-kind Task — see `buildPlanningInstructions`, which folds in the Project's resolved Workflow's step list (task 3.012). */
function composeInteractivePrompt(prompt: string, kind: TaskKind, branch: string | undefined, planInstructions?: string): string {
  const instructions = kind === 'plan' ? (planInstructions ?? PLAN_INSTRUCTIONS) : undefined;
  return `${prompt}${instructions ? `\n\n${instructions}` : ''}${branch ? `\n\nWork on the checked-out branch ${branch}. Do not switch branches, commit, or push: the server commits and pushes your completed work automatically.` : ''}`;
}

/** The full planning prompt addendum for a Project's resolved Workflow — falls back to the static PLAN_INSTRUCTIONS if the Catalog has no usable Workflow at all. */
async function buildPlanningInstructions(project: ProjectRecord): Promise<string> {
  const workflow = await resolveWorkflowForProject(project).catch(() => null);
  return workflow ? buildPlanInstructions(workflow) : PLAN_INSTRUCTIONS;
}

export type WorkerManager = ReturnType<typeof createWorkerManager>;

/** The one instance the daemon actually runs against — see server.ts / api/router.ts / api/ws.ts. */
export const workerManager = createWorkerManager({ trackBackgroundTurn });
