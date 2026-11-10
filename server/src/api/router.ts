import type { ConflictBody } from '../worker/taskConflicts.ts';
import { GitError, githubRepository } from '../projects/git.ts';
import { clearAccountFailure, reportAccountFailure } from '../github/accountNotifications.ts';
import { GithubAccountError } from '../github/context.ts';
import { IdentityValidationError, checkProjectAccount, detectAccounts, isValidLogin, listLogins, UnknownAccountError, withProjectGithub, resetIdentity, saveIdentity } from '../github/accounts.ts';
import { DEFAULT_GIT_PROVIDER, UnsupportedGitProviderError, gitProviderFor, isGitProviderId } from '../projects/gitProvider.ts';
import { Router } from 'express';
import { mountBuildingRoutes } from './buildingRoutes.ts';
import { mountSeoRoutes } from './seoRoutes.ts';
import { ContentInputError } from '../content/errors.ts';
import { contentGuards, mountContentRoutes } from './contentRoutes.ts';
import { mountCrmRoutes } from './crmRoutes.ts';
import { mountScheduleRoutes } from './scheduleRoutes.ts';
import { mountConnectionRoutes } from './connectionRoutes.ts';
import { connections as defaultConnections } from '../connections/index.ts';
import type { Connections } from '../connections/service.ts';
import { scheduler as defaultScheduler } from '../scheduler/index.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import { NoStorageError, getStore } from '../buildings/buildingStorage.ts';
import { StorageCrashError } from '../buildings/bulkClient.ts';
import { BuildingReadOnlyError, normalizeProject } from '../buildings/normalize.ts';
import { devTypesEnabled, getBuildingType } from '../buildings/registry.ts';
import { UnknownBuildingTypeError } from '../projects/projectService.ts';
import type { Request, Response, NextFunction } from 'express';
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  setAgentEnabled,
  uploadAgentFile,
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  setSkillEnabled,
  addSkillSupportFile,
  removeSkillSupportFile,
  uploadSkillZip,
  AgentNotFoundError,
  AgentAlreadyExistsError,
  InvalidAgentFileError,
  SkillNotFoundError,
  SkillAlreadyExistsError,
  InvalidSkillFileError,
  InvalidIdError,
  CatalogPathTraversalError,
  InvalidZipError,
  ZipSlipError,
} from '../catalog/catalogService.ts';
import { skillInstallRunner, InvalidRepoSlugError, SkillInstallNotFoundError } from '../catalog/skillInstall.ts';
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  WorkflowNotFoundError,
  WorkflowAlreadyExistsError,
  InvalidWorkflowError,
  NoWorkflowAvailableError,
  type WorkflowInput,
} from '../catalog/workflowService.ts';
import {
  createExecutor,
  ExecutorNotFoundError,
  getExecutor,
  LastExecutorError,
  listExecutors,
  removeExecutor,
  updateExecutor,
} from '../executors/executorService.ts';
import { getExecutorLimits } from '../executors/claudeUsage.ts';
import { defaultExecutor as defaultDefaultExecutor } from '../executors/defaultExecutorInstance.ts';
import { DefaultExecutorNotFoundError, DefaultExecutorUnavailableError, type DefaultExecutorService } from '../executors/defaultExecutor.ts';
import { analyticsService as defaultAnalyticsService, recordCliUsage as defaultRecordCliUsage } from '../analytics/index.ts';
import { AnalyticsAgentNotFoundError, AnalyticsRangeError, type AnalyticsService } from '../analytics/analyticsService.ts';
import { summarizeExecutorUsage } from '../executors/executorUsage.ts';
import { InvalidStepSelectionError } from '../worker/stepSelection.ts';
import {
  createProject,
  projectBranches,
  checkoutProjectBranch,
  deleteProject,
  listProjects,
  getProject,
  projectAbsolutePath,
  updateProjectPosition,
  InvalidPlotError,
  InvalidProjectNameError,
  renameProject,
  parseProjectName,
  PlotTakenError,
  setProjectAutoPull, setProjectGitProvider, setProjectGithubAccount, setProjectWorkflowId,
  startDocsBootstrapTask,
  ProjectNotFoundError,
  ProjectHasActiveTaskError,
} from '../projects/projectService.ts';
import { writeFile } from 'node:fs/promises';
import { blueprintPath, readBlueprint } from '../projects/blueprint.ts';
import { PLAN_DOC_KEYS, PLAN_DOC_TITLES, InvalidPlanDocKeyError, readAllPlanDocs, requirePlanDocKey, writePlanDoc } from '../projects/plan.ts';
import { listProjectDocuments, readPlanDocumentRaw, UnknownPlanDocumentError } from '../projects/documents.ts';
import { listProjectTree, readFileSafely, NotAFileError, PathTraversalError } from '../projects/fileTree.ts';
import { loadTestingConfig } from '../testing/config.ts';
import type { PlanningTaskDraft, PlanningTaskPatch } from '../projects/plan.ts';
import { mountAgentSessionRoutes } from './agentSessionRoutes.ts';
import { defaultExtractionDeps } from '../content/defaultExtractionDeps.ts';
import type { ExtractionDeps } from '../content/extractions.ts';
import { mountStudioRoutes } from './studioRoutes.ts';
import { insights as defaultInsights, type Insights } from '../content/insights.ts';
import { mountVideoRoutes } from './videoRoutes.ts';
import { mountImageRoutes } from './imageRoutes.ts';
import { mountThumbnailRoutes } from './thumbnailRoutes.ts';
import { mountRemotionStudioRoutes } from './remotionStudioRoutes.ts';
import { studioSessions as defaultStudioSessions, type StudioSessions } from '../content/studioSessions.ts';
import { agentSessions as defaultAgentSessions, type AgentSessions } from '../terminal/agentSessions.ts';
import { createLiveTerminalSessions, type LiveTerminalSessions } from '../terminal/liveTerminalSessions.ts';
import { terminalSessionManager } from '../terminal/terminalSessionManager.ts';
import { createAgentTesting, parseWaitSeconds } from '../testing/agentTesting.ts';
import {
  testRunner as defaultTestRunner,
  NoRunnableSuitesError,
  TestActionDisabledError,
  TestActionNotFoundError,
  TestingConfigUnavailableError,
  TestRunAlreadyActiveError,
  TestRunNotFoundError,
  TestRunNotQueuedError,
  TestRunNotRunningError,
  TestRunTaskError,
  type TestRunner,
} from '../testing/testRunner.ts';
import { createDocsEntry, listDocsTree, readDocsFile, writeDocsFile } from '../projects/docsFiles.ts';
import { createCodeEntry } from '../projects/codeFiles.ts';
import {
  GitPathRefusedError,
  NoRepositoryDiffError,
  NotAChangedFileError,
  RunOutsideProjectError,
  WorkingCopyRemovedError,
  publicRunLocation,
  quickLookCodeFile,
  quickLookCodeTree,
  quickLookDiff,
  quickLookDiffFile,
  quickLookDocsFile,
  quickLookDocsTree,
  resolveRunLocation,
} from '../projects/quickLook.ts';
import { EntryExistsError, InvalidEntryPathError } from '../projects/projectEntries.ts';
import type { EntryType } from '../projects/projectEntries.ts';
import {
  createPlanItem,
  getPlanItem,
  listPlanItems,
  reorderPlanItems,
  updatePlanItem,
  PlanItemCompletedError,
  PlanItemHasActiveTaskError,
  PlanItemNotCompletableError,
  PlanItemNotFoundError,
} from '../projects/planItemService.ts';
import { planItemTitler as defaultPlanItemTitler, provisionalTitle, TITLE_MAX_LENGTH, type PlanItemTitler } from '../projects/planItemTitler.ts';
import {
  workerManager,
  ExecutorNotSupportedError,
  ProjectFolderBusyError,
  BranchRequiresRepositoryError,
  TaskConflictError,
  TaskLimitReachedError,
  PlanItemQueueEntryNotFoundError,
  SessionStillRunningError,
  TaskNotBlockedError,
  TaskNotFollowableError,
  PlanningSessionArchivedError,
  TaskNotFoundError,
  TaskNotPausedError,
  TaskNotInterimCommittableError,
  TaskNotPlanningSessionError,
  SessionAlreadyStartedError,
  PlanningQueueConflictError,
  PlanningRequiresCliError,
  TaskNotTerminalError,
  TerminalSessionNotResumableError,
  StepInspectSessionError,
  StepNotSkippableError,
  TemplateDisabledError,
  SkillDisabledError,
  WorkflowRunNotFoundError,
  WorkflowRunNotActionableError,
  TaskNotWorkflowStepError,
  TaskNotTestingSessionError,
  TestingSetupApprovalError,
  TestingSetupStepRefusedError,
  stepCanEditCode,
} from '../worker/workerManager.ts';
import type { PlanningQueueEntryRef } from '../worker/workerManager.ts';
import { StepOutputRequiredError } from '../worker/requiredOutputs.ts';
import { parseStepOutputs } from './stepOutputs.ts';
import { BugGroupConflictError, TaskNotBugFilingSessionError, TaskNotBugReportSessionError } from '../worker/bugTracker.ts';
import {
  BUG_LIMITS, BugIntroducerNotStartedError, BugNotCompletedError, RegressionNotBugError, BugNotPlanningTaskError, BugStartedError, BugValidationError,
  ReportedItemKindError, ReportedTaskStartedError, parseAgentBug, parseBugReport, parseBugReportPatch, parseInfoStatus, parseRegressionBody, parseReportedTask, parseReportedTaskPatch,
} from '../projects/bugs.ts';
import {
  createCommand,
  deleteCommand,
  listCommands,
  updateCommand,
  CommandHighlightLimitError,
  CommandNotFoundError,
} from '../commands/commandService.ts';
import { commandRunner, CommandAlreadyRunningError, CommandRunNotFoundError } from '../commands/commandRunner.ts';
import { StepNoteValidationError } from '../projects/stepNotes.ts';
import { gitSyncPoller } from '../projects/gitSyncPoller.ts';
import { isAutoPullEnabled } from '../projects/autoPull.ts';
import { autoMerge as defaultAutoMerge } from '../projects/autoMergeInstance.ts';
import { pullRequestStates as defaultPullRequestStates } from '../projects/pullRequestStateInstance.ts';
import type { PullRequestStateService } from '../projects/pullRequestStateService.ts';
import { AutoMergeNotRetryableError, AutoMergeUnavailableError } from '../projects/autoMergeService.ts';
import type { AutoMergeService } from '../projects/autoMergeService.ts';
import { autoMergeIneligibleReason, parseAutoMergeToggle } from '../projects/autoMerge.ts';
import { dependencies as defaultDependencies } from '../projects/dependencyInstance.ts';
import type { DependencyService } from '../projects/dependencyService.ts';
import { DependencyConflictError, DependencyInvalidError, parseUiPlanningWaits } from '../projects/dependencies.ts';
import { GitProviderError, NoLinkedRepositoryError, pullRequestContext } from '../projects/pullRequestActions.ts';
import { PullRequestHeadGoneError, PullRequestNotFoundError } from '../projects/pullRequestMerge.ts';
import {
  ConflictAgentRequiredError, NoPullRequestCheckoutError, PreviousBranchGoneError, PullRequestBranchDivergedError, PullRequestBusyError,
  PullRequestNotMergeableError, PullRequestNotOpenError, createPullRequestService, type PullRequestService,
} from '../projects/pullRequestService.ts';
import { appUpdateService, AppUpdateAlreadyInProgressError, AppUpdateNotApplicableError } from '../appUpdate/appUpdateService.ts';
import {
  getNotification,
  listNotifications,
  markAllRead,
  markNotificationsRead,
  markNotificationUnread,
  markSubjectRead,
  raiseNotification,
  NotificationNotFoundError,
} from '../notifications/notificationService.ts';
import type { Autonomy, ProjectRecord, CommandRunStatus, TestRunStatus, ExecutorProfile, NotificationSeverity, NotificationSubject, WorkflowRunRecord, NotificationKind } from '../domain/types.ts';
import { NOTIFICATION_KINDS } from '../domain/types.ts';
import { validCliHookToken } from '../terminal/projectCliHooks.ts';
import { preloadSkillsProblem } from '../catalog/skillPreload.ts';

const COMMAND_RUN_STATUSES: CommandRunStatus[] = ['running', 'success', 'failed', 'stopped'];
const TEST_RUN_STATUSES: TestRunStatus[] = ['queued', 'running', 'passed', 'failed', 'error', 'stopped'];
const MAX_TEST_RUN_PAGE = 100;
const AUTONOMY_VALUES: Autonomy[] = ['auto', 'approval'];
const EXECUTOR_KINDS: ExecutorProfile['kind'][] = ['claude-cli', 'codex-cli'];
const NOTIFICATION_SEVERITIES: NotificationSeverity[] = ['info', 'warning', 'critical'];
const NOTIFICATION_SUBJECT_TYPES = ['task', 'command', 'project', 'testRun', 'skill', 'app', 'scheduledJob', 'autoMerge'] as const;

/**
 * Parses and validates a `NotificationSubject` from an untrusted request body — `POST
 * /api/notifications` (any outside caller) and `POST /api/notifications/read`'s `{subject}` form.
 * Returns null for anything malformed; the caller turns that into a 400.
 */
function parseNotificationSubject(value: unknown): NotificationSubject | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const type = body.type;
  if (typeof type !== 'string' || !NOTIFICATION_SUBJECT_TYPES.includes(type as typeof NOTIFICATION_SUBJECT_TYPES[number])) return null;
  const str = (key: string) => (typeof body[key] === 'string' && (body[key] as string).trim() ? (body[key] as string).trim() : null);
  if (type === 'task') {
    const projectId = str('projectId'); const conversationId = str('conversationId'); const taskId = str('taskId');
    return projectId && conversationId && taskId ? { type: 'task', projectId, conversationId, taskId } : null;
  }
  if (type === 'command') {
    const projectId = str('projectId'); const commandId = str('commandId'); const runId = str('runId');
    return projectId && commandId && runId ? { type: 'command', projectId, commandId, runId } : null;
  }
  if (type === 'project') {
    const projectId = str('projectId');
    return projectId ? { type: 'project', projectId } : null;
  }
  if (type === 'testRun') {
    const projectId = str('projectId'); const runId = str('runId');
    return projectId && runId ? { type: 'testRun', projectId, runId } : null;
  }
  if (type === 'skill') {
    const repo = str('repo');
    return repo ? { type: 'skill', repo } : null;
  }
  if (type === 'scheduledJob') {
    const projectId = str('projectId'); const jobId = str('jobId');
    return projectId && jobId ? { type: 'scheduledJob', projectId, jobId } : null;
  }
  if (type === 'autoMerge') {
    const projectId = str('projectId'); const planItemId = str('planItemId');
    return projectId && planItemId ? { type: 'autoMerge', projectId, planItemId } : null;
  }
  return { type: 'app' };
}

/** Decodes a base64 request-body field into a Buffer — the upload convention this router uses throughout the Catalog routes (see the guardrail note by the Catalog section below for why). */
function decodeBase64(value: unknown): Buffer {
  return Buffer.from(typeof value === 'string' ? value : '', 'base64');
}

/** After a branch or PR action finished, re-reads the Project's sync state so a pending automatic pull happens (and the indicator follows the new branch) without waiting for the next poll. */
function reevaluateSync(projectId: string): void {
  void getProject(projectId).then((project) => gitSyncPoller.refreshOne(project)).catch(() => { /* The next poll covers it. */ });
}

/** Wraps an async handler so a rejected promise reaches Express's error middleware instead of hanging the request. */
function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

/** Express 5 types a route param as possibly an array (wildcard routes) or undefined; ours are always plain string segments. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') throw new Error(`Expected route param "${name}" to be a string`);
  return value;
}

/** Attaches a Project's last-known git-sync reading (see gitSyncPoller.ts) to its wire representation — null until the poller's first tick, or for a Project with no repository. Computed on read rather than stored on ProjectRecord since it's an ephemeral, cheaply-recomputed reading, not persisted state. */
function withSync(project: ProjectRecord) {
  return { ...normalizeProject(project), gitProvider: project.gitProvider ?? DEFAULT_GIT_PROVIDER, githubAccount: project.githubAccount ?? null, autoPullEnabled: isAutoPullEnabled(project), sync: gitSyncPoller.get(project.id) };
}

export interface ApiRouterOptions {
  /** The Project's Agent terminal sessions — injectable so tests use a fake terminal host. */
  agentSessions?: AgentSessions;
  /** The live PTYs the status footer lists — injectable so tests resolve against their own host. */
  liveTerminalSessions?: LiveTerminalSessions;
  /** The Content Studio writing sessions — injectable so tests use a fake terminal host. */
  studioSessions?: StudioSessions;
  /** The agent behind "Fill from text or screenshots"; tests inject a fake. */
  extraction?: ExtractionDeps;
  insights?: Insights;
  /** Names Tasks created from a description alone — injectable so tests never spawn a real CLI. */
  planItemTitler?: PlanItemTitler;
  /** Runs Test Actions — injectable so tests never spawn a real test command. */
  testRunner?: TestRunner;
  /** The Analytics view's data and the CLI usage hook — injectable so tests use their own history, clock and fake readings. */
  analytics?: { service: AnalyticsService; recordCliUsage: typeof defaultRecordCliUsage };
  /** The PR tab's actions — injectable so tests drive conflict-resolution runs through their own worker manager and fake terminal sessions. */
  pullRequests?: PullRequestService;
  /** The tasks' Auto-merge — injectable so tests drive it with their own fake provider and conflict runs. */
  autoMerge?: AutoMergeService;
  pullRequestStates?: PullRequestStateService;
  /** Dependent tasks — injectable so tests drive them with their own fake git and clock. */
  dependencies?: DependencyService;
  /** The Building scheduler — injectable so tests run it on their own clock and never start a real run. */
  scheduler?: Scheduler;
  /** Links, capability calls and events between Buildings — injectable so tests use their own clock, limits and fake job starts. */
  connections?: Connections;
  /** The app-wide default coding agent — injectable so tests use their own agents, quota and store. */
  defaultExecutor?: DefaultExecutorService;
}

/** The CLI hook events that end a turn or a session: the points at which a session's reported usage is final for that turn. */
const USAGE_HOOK_EVENTS = ['Stop', 'StopFailure', 'SessionEnd'];

/** Reads an optional non-negative integer query param; `null` when present but invalid. */
function queryInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** An optional `taskId` in a test-run request body: present means an agent run in that Task's cwd. */
function optionalTaskId(body: unknown): { ok: true; taskId?: string } | { ok: false } {
  const { taskId } = (body ?? {}) as { taskId?: unknown };
  if (taskId === undefined || taskId === null) return { ok: true };
  return typeof taskId === 'string' && taskId.trim() ? { ok: true, taskId: taskId.trim() } : { ok: false };
}

/** Why a `POST /plan-items/:id/execute` body is invalid (a 400), or null when it's fine — see that route. */
async function startOptionsError({ executorId, workflowId, createBranch, skippedStepIds, autoMerge }: { executorId: unknown; workflowId: unknown; createBranch: unknown; skippedStepIds: unknown; autoMerge: unknown }): Promise<string | null> {
  if (executorId !== undefined && (typeof executorId !== 'string' || !(await getExecutor(executorId)))) return 'executorId must name a configured executor';
  if (workflowId !== undefined && (typeof workflowId !== 'string' || !(await getWorkflow(workflowId))?.enabled)) return 'workflowId must name an enabled Catalog workflow';
  if (createBranch !== undefined && typeof createBranch !== 'boolean') return 'createBranch must be a boolean';
  if (autoMerge !== undefined && typeof autoMerge !== 'boolean') return 'autoMerge must be a boolean';
  if (skippedStepIds !== undefined && (!Array.isArray(skippedStepIds) || !skippedStepIds.every((id) => typeof id === 'string' && id.trim()))) {
    return 'skippedStepIds must be an array of step ids';
  }
  return null;
}

/** A required, non-blank `?path=` query value, answering 400 itself and returning null when it's missing. */
function requiredPathQuery(req: Request, res: Response): string | null {
  const requested = req.query.path;
  if (typeof requested === 'string' && requested.trim()) return requested;
  res.status(400).json({ error: 'path is required' });
  return null;
}

/** An optional `workflowRunId` in a command-run body: present means run in that WorkflowRun's working copy. */
function optionalWorkflowRunId(body: unknown): { ok: true; workflowRunId?: string } | { ok: false } {
  const { workflowRunId } = (body ?? {}) as { workflowRunId?: unknown };
  if (workflowRunId === undefined || workflowRunId === null) return { ok: true };
  return typeof workflowRunId === 'string' && workflowRunId.trim() ? { ok: true, workflowRunId: workflowRunId.trim() } : { ok: false };
}

/** Validates a create-entry body (`{ path, type }`), answering 400 itself and returning null when it's malformed. */
function readEntryType(body: unknown, res: Response): EntryType | null {
  const { path: entryPath, type } = (body ?? {}) as { path?: unknown; type?: unknown };
  if (typeof entryPath !== 'string' || !entryPath.trim() || (type !== 'file' && type !== 'folder')) {
    res.status(400).json({ error: 'path and type ("file" or "folder") are required' });
    return null;
  }
  return type;
}

export function createApiRouter({
  planItemTitler = defaultPlanItemTitler,
  testRunner = defaultTestRunner,
  analytics = { service: defaultAnalyticsService, recordCliUsage: defaultRecordCliUsage },
  pullRequests = createPullRequestService(workerManager),
  autoMerge = defaultAutoMerge,
  pullRequestStates = defaultPullRequestStates,
  dependencies = defaultDependencies,
  scheduler = defaultScheduler,
  connections = defaultConnections,
  defaultExecutor = defaultDefaultExecutor,
  agentSessions = defaultAgentSessions,
  studioSessions = defaultStudioSessions,
  liveTerminalSessions = createLiveTerminalSessions(terminalSessionManager),
  extraction = defaultExtractionDeps,
  insights = defaultInsights,
}: ApiRouterOptions = {}): Router {
  const router = Router();
  const agentTesting = createAgentTesting(testRunner, workerManager.recordAwaitedTestRuns);

  router.get('/health', (_req, res) => res.json({ ok: true }));
  router.get('/terminal-sessions', route(async (_req, res) => { res.json(await liveTerminalSessions.list()); }));
  mountBuildingRoutes(router, route, param);
  mountSeoRoutes(router, route, param, scheduler);
  mountCrmRoutes(router, route, param);
  mountContentRoutes(router, route, param, studioSessions, extraction, insights, (project) => workerManager.publishEvent({ type: 'project', project }));
  mountStudioRoutes(router, route, contentGuards(param), studioSessions, authorizeCliToken);
  mountVideoRoutes(router, route, contentGuards(param), studioSessions, authorizeCliToken);
  mountImageRoutes(router, route, contentGuards(param), studioSessions, authorizeCliToken);
  mountThumbnailRoutes(router, route, contentGuards(param), studioSessions, authorizeCliToken);
  mountRemotionStudioRoutes(router, route, contentGuards(param));
  mountScheduleRoutes(router, route, param, scheduler);
  mountConnectionRoutes(router, route, param, connections, { authorize: authorizeCliToken, stepCanEditCode });
  mountAgentSessionRoutes(router, route, param, agentSessions, authorizeCliToken);

  // ---- Catalog: agents (Templates) and skills, backed by this repo's own root-level catalog/ ----
  // Uploads (an agent's raw .md, a skill's zip, a skill support file) travel as base64 inside the
  // JSON body — this is a local, single-user daemon with no multipart middleware anywhere else in
  // this router, so that's the simplest consistent option (see server/package.json — no multer/busboy).

  router.get('/catalog/agents', route(async (_req, res) => {
    res.json(await listAgents());
  }));

  router.post('/catalog/agents', route(async (req, res) => {
    const { id, name, description, body, avatar, manager, defaultAutonomy, enabled } = req.body as {
      id?: string; name?: string; description?: string; body?: string; avatar?: string;
      manager?: boolean; defaultAutonomy?: Autonomy; enabled?: boolean;
    };
    if (!id || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
    if (!name || !name.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    if (!description || !description.trim()) { res.status(400).json({ error: 'description is required' }); return; }
    if (defaultAutonomy !== undefined && !AUTONOMY_VALUES.includes(defaultAutonomy)) {
      res.status(400).json({ error: `defaultAutonomy must be one of ${AUTONOMY_VALUES.join(', ')}` }); return;
    }
    res.status(201).json(await createAgent({ id: id.trim(), name, description, body, avatar, manager, defaultAutonomy, enabled }));
  }));

  router.post('/catalog/agents/upload', route(async (req, res) => {
    const { id, contentBase64, name, avatar, manager, defaultAutonomy, enabled } = req.body as {
      id?: string; contentBase64?: string; name?: string; avatar?: string;
      manager?: boolean; defaultAutonomy?: Autonomy; enabled?: boolean;
    };
    if (!id || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
    if (!contentBase64) { res.status(400).json({ error: 'contentBase64 is required' }); return; }
    res.status(201).json(await uploadAgentFile({
      id: id.trim(), content: decodeBase64(contentBase64).toString('utf-8'), name, avatar, manager, defaultAutonomy, enabled,
    }));
  }));

  router.get('/catalog/agents/:id', route(async (req, res) => {
    const agent = await getAgent(param(req, 'id'));
    if (!agent) throw new AgentNotFoundError();
    res.json(agent);
  }));

  router.put('/catalog/agents/:id', route(async (req, res) => {
    const { name, description, body, avatar, manager, defaultAutonomy } = req.body as {
      name?: string; description?: string; body?: string; avatar?: string; manager?: boolean; defaultAutonomy?: Autonomy;
    };
    if (defaultAutonomy !== undefined && !AUTONOMY_VALUES.includes(defaultAutonomy)) {
      res.status(400).json({ error: `defaultAutonomy must be one of ${AUTONOMY_VALUES.join(', ')}` }); return;
    }
    res.json(await updateAgent(param(req, 'id'), { name, description, body, avatar, manager, defaultAutonomy }));
  }));

  router.delete('/catalog/agents/:id', route(async (req, res) => {
    await deleteAgent(param(req, 'id'));
    res.status(204).end();
  }));

  router.post('/catalog/agents/:id/enable', route(async (req, res) => {
    res.json(await setAgentEnabled(param(req, 'id'), true));
  }));

  router.post('/catalog/agents/:id/disable', route(async (req, res) => {
    res.json(await setAgentEnabled(param(req, 'id'), false));
  }));

  router.get('/catalog/skills', route(async (_req, res) => {
    res.json(await listSkills());
  }));

  router.post('/catalog/skills', route(async (req, res) => {
    const { id, name, description, body, avatar, triggers, enabled } = req.body as {
      id?: string; name?: string; description?: string; body?: string; avatar?: string; triggers?: string[]; enabled?: boolean;
    };
    if (!id || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
    if (!name || !name.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    if (!description || !description.trim()) { res.status(400).json({ error: 'description is required' }); return; }
    res.status(201).json(await createSkill({ id: id.trim(), name, description, body, avatar, triggers, enabled }));
  }));

  router.post('/catalog/skills/upload', route(async (req, res) => {
    const { id, contentBase64, name, avatar, triggers, enabled } = req.body as {
      id?: string; contentBase64?: string; name?: string; avatar?: string; triggers?: string[]; enabled?: boolean;
    };
    if (!id || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
    if (!contentBase64) { res.status(400).json({ error: 'contentBase64 is required' }); return; }
    res.status(201).json(await uploadSkillZip({ id: id.trim(), zipBuffer: decodeBase64(contentBase64), name, avatar, triggers, enabled }));
  }));

  // Kicks off `npx skills add <owner/repo>` as a real subprocess — see catalog/skillInstall.ts. Its
  // running/log/settled events broadcast over the same /ws channel as everything else (api/ws.ts).
  router.post('/catalog/skills/install', route(async (req, res) => {
    const { repo } = req.body as { repo?: string };
    if (!repo || !repo.trim()) { res.status(400).json({ error: 'repo is required' }); return; }
    res.status(201).json(skillInstallRunner.install(repo.trim()));
  }));

  router.get('/catalog/skills/install/:runId', route(async (req, res) => {
    res.json(skillInstallRunner.getRun(param(req, 'runId')));
  }));

  router.get('/catalog/skills/:id', route(async (req, res) => {
    const skill = await getSkill(param(req, 'id'));
    if (!skill) throw new SkillNotFoundError();
    res.json(skill);
  }));

  router.put('/catalog/skills/:id', route(async (req, res) => {
    const { name, description, body, avatar, triggers } = req.body as {
      name?: string; description?: string; body?: string; avatar?: string; triggers?: string[];
    };
    res.json(await updateSkill(param(req, 'id'), { name, description, body, avatar, triggers }));
  }));

  router.delete('/catalog/skills/:id', route(async (req, res) => {
    await deleteSkill(param(req, 'id'));
    res.status(204).end();
  }));

  router.post('/catalog/skills/:id/enable', route(async (req, res) => {
    res.json(await setSkillEnabled(param(req, 'id'), true));
  }));

  router.post('/catalog/skills/:id/disable', route(async (req, res) => {
    res.json(await setSkillEnabled(param(req, 'id'), false));
  }));

  router.post('/catalog/skills/:id/files', route(async (req, res) => {
    const { name, contentBase64 } = req.body as { name?: string; contentBase64?: string };
    if (!name || !name.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    if (!contentBase64) { res.status(400).json({ error: 'contentBase64 is required' }); return; }
    res.status(201).json(await addSkillSupportFile(param(req, 'id'), name.trim(), decodeBase64(contentBase64)));
  }));

  router.delete('/catalog/skills/:id/files/:name', route(async (req, res) => {
    res.json(await removeSkillSupportFile(param(req, 'id'), param(req, 'name')));
  }));

  // ---- Catalog: Workflows (task 3.012) — an ordered list of Steps a Project's Tasks run through ----

  /** Resolves each step's `agentId` to {id, name, avatar} from the agents Catalog, so a "Workflow section" card renders without an extra round trip per step. */
  async function withResolvedAgents(workflow: Awaited<ReturnType<typeof getWorkflow>>) {
    if (!workflow) return workflow;
    const agentsById = new Map((await listAgents()).map((agent) => [agent.id, agent]));
    const resolveAgent = (agentId: string) => {
      const agent = agentsById.get(agentId);
      return agent ? { id: agent.id, name: agent.name, avatar: agent.avatar } : { id: agentId, name: agentId, avatar: undefined };
    };
    return {
      ...workflow,
      steps: workflow.steps.map((step) => ({ ...step, agent: resolveAgent(step.agentId) })),
    };
  }

  router.get('/catalog/workflows', route(async (_req, res) => {
    res.json(await Promise.all((await listWorkflows()).map(withResolvedAgents)));
  }));

  router.post('/catalog/workflows', route(async (req, res) => {
    const { id, name, description, enabled, branchType, steps } = req.body as Partial<WorkflowInput>;
    if (!id || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
    if (!name || !name.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    if (!description || !description.trim()) { res.status(400).json({ error: 'description is required' }); return; }
    if (!Array.isArray(steps)) { res.status(400).json({ error: 'steps must be an array' }); return; }
    const created = await createWorkflow({ id: id.trim(), name, description, enabled, branchType, steps });
    res.status(201).json(await withResolvedAgents(created));
  }));

  router.get('/catalog/workflows/:id', route(async (req, res) => {
    const workflow = await getWorkflow(param(req, 'id'));
    if (!workflow) throw new WorkflowNotFoundError();
    res.json(await withResolvedAgents(workflow));
  }));

  router.put('/catalog/workflows/:id', route(async (req, res) => {
    const { name, description, enabled, branchType, steps } = req.body as Partial<WorkflowInput>;
    const updated = await updateWorkflow(param(req, 'id'), { name, description, enabled, branchType, steps });
    res.json(await withResolvedAgents(updated));
  }));

  router.delete('/catalog/workflows/:id', route(async (req, res) => {
    await deleteWorkflow(param(req, 'id'));
    res.status(204).end();
  }));

  router.get('/executors', route(async (_req, res) => {
    // Attaches each executor's rolled-up token usage — the real data behind the footer's
    // "most used agent" sort (docs/roadmap.md's footer-improvements bundle) — computed fresh from
    // every persisted Task rather than cached, matching listExecutors' own "always read fresh" policy.
    const [executors, tasks] = await Promise.all([listExecutors(), workerManager.listAllTasks()]);
    const withLimits = await Promise.all(summarizeExecutorUsage(executors, tasks).map(async (executor) => ({
      ...executor, limits: await getExecutorLimits(executor),
    })));
    // A fresh list read is a fresh quota reading: the default may need to switch before it is reported.
    await defaultExecutor.recheck();
    const defaultId = await defaultExecutor.current();
    res.json(withLimits.map((executor) => ({ ...executor, isDefault: executor.id === defaultId })));
  }));

  router.put('/executors/default', route(async (req, res) => {
    const { executorId } = (req.body ?? {}) as { executorId?: unknown };
    if (typeof executorId !== 'string' || !executorId) { res.status(400).json({ error: 'executorId must be a non-empty string' }); return; }
    res.json({ defaultExecutorId: await defaultExecutor.setDefault(executorId) });
  }));

  // ---- Settings panel: add/edit/remove the coding agents (server/executors.json) ----

  router.post('/executors', route(async (req, res) => {
    const { label, kind, bin, env } = req.body as { label?: string; kind?: string; bin?: string; env?: Record<string, string> };
    if (!label || !label.trim()) { res.status(400).json({ error: 'label is required' }); return; }
    if (!bin || !bin.trim()) { res.status(400).json({ error: 'bin is required' }); return; }
    if (!EXECUTOR_KINDS.includes(kind as ExecutorProfile['kind'])) { res.status(400).json({ error: `kind must be one of: ${EXECUTOR_KINDS.join(', ')}` }); return; }
    const created = await createExecutor({ label, kind: kind as ExecutorProfile['kind'], bin, env });
    await defaultExecutor.recheck();
    res.status(201).json(created);
  }));

  router.patch('/executors/:id', route(async (req, res) => {
    const { label, kind, bin, env } = req.body as { label?: string; kind?: string; bin?: string; env?: Record<string, string> };
    if (kind !== undefined && !EXECUTOR_KINDS.includes(kind as ExecutorProfile['kind'])) {
      res.status(400).json({ error: `kind must be one of: ${EXECUTOR_KINDS.join(', ')}` }); return;
    }
    const updated = await updateExecutor(param(req, 'id'), { label, kind: kind as ExecutorProfile['kind'] | undefined, bin, env });
    await defaultExecutor.recheck();
    res.json(updated);
  }));

  router.delete('/executors/:id', route(async (req, res) => {
    await removeExecutor(param(req, 'id'));
    await defaultExecutor.recheck();
    res.status(204).end();
  }));

  // ---- Agent analytics: quota history, activity and step comparison (docs/agent-analytics.md) ----
  // Reads only: quota observations are added by the daemon's sampler and by the refresh route, never by a GET.

  router.get('/analytics/agents', route(async (_req, res) => {
    res.json(await analytics.service.listAgents());
  }));

  // ?from=&to= are epoch milliseconds bounding one day as the browser's own timezone cuts it.
  router.get('/analytics/agents/:id', route(async (req, res) => {
    res.json(await analytics.service.getDay(param(req, 'id'), Number(req.query.from), Number(req.query.to)));
  }));

  router.get('/analytics/agents/:id/steps', route(async (req, res) => {
    res.json(await analytics.service.getSteps(param(req, 'id')));
  }));

  // Always 200 for a known agent: a check the provider's throttling or backoff does not allow yet
  // answers `not-eligible` with the time another check may run, and the last reading is kept.
  router.post('/analytics/agents/:id/refresh', route(async (req, res) => {
    const outcome = await analytics.service.refresh(param(req, 'id'));
    void defaultExecutor.recheck().catch(() => undefined);
    res.json(outcome);
  }));

  router.get('/projects', route(async (_req, res) => {
    res.json((await listProjects()).map(withSync));
  }));

  router.post('/projects', route(async (req, res) => {
    const { position, typeId } = req.body as { position?: [number, number]; typeId?: unknown };
    const type = typeId === undefined ? getBuildingType('software') : typeof typeId === 'string' ? getBuildingType(typeId) : undefined;
    if (!type || (type.devOnly && !devTypesEnabled())) {
      res.status(400).json({ error: `Unknown Building type "${String(typeId)}"`, field: 'typeId' });
      return;
    }
    const input = type.validateCreate(req.body);
    if (!input.ok) {
      res.status(400).json({ error: input.error, field: input.field });
      return;
    }
    const project = await createProject({ name: input.value.name, position: position ?? null, repositoryUrl: input.value.repositoryUrl as string | undefined, typeId: type.id });
    // A type with bulk storage gets its isolated database file now, so it exists from the Building's first day.
    if (type.storage) await getStore(project);
    await type.onCreated?.(project.id, input.value);
    await scheduler.seedDefaults(project.id);
    if (type.repository) {
      // The start only accepts the run; its start-up continues in the background, so this does not wait for the agent.
      // A failed start leaves the setup item on the board, not started, for the owner to retry.
      await startDocsBootstrapTask(project, { createPlanItem, enqueuePlanItemExecution: workerManager.enqueuePlanItemExecution }).catch((error) =>
        console.error(`Failed to start docs-bootstrap task for project ${project.id}:`, error));
    }
    res.status(201).json(normalizeProject(project));
  }));

  router.get('/projects/:id/branches', route(async (req, res) => {
    res.json(await projectBranches(param(req, 'id')));
  }));
  router.get('/projects/:id/open-pull-requests', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const provider = gitProviderFor(project.gitProvider);
    const repository = project.repositoryUrl && provider.repositoryLink(project.repositoryUrl);
    if (!repository) { res.status(400).json({ error: 'This project has no linked repository for its Git provider' }); return; }
    try {
      const open = await withProjectGithub(project, 'count open pull requests', () => provider.listOpenPullRequests(projectAbsolutePath(project), repository.slug));
      await clearAccountFailure(project);
      res.json({ ...open, checkedAt: new Date().toISOString() });
    } catch (error) {
      const failure = provider.describeFailure(error);
      if (error instanceof GithubAccountError) await reportAccountFailure(project, failure).catch(() => undefined);
      res.json({ count: null, pullRequests: [], truncated: false, checkedAt: new Date().toISOString(), error: failure });
    }
  }));
  // ---- PR tab actions: merge state, merge, check out and return — see projects/pullRequestService.ts ----

  router.get('/projects/:id/pull-requests/:number/merge-state', route(async (req, res) => {
    const number = pullRequestNumber(req, res);
    if (number === null) return;
    const project = await getProject(param(req, 'id'));
    pullRequestContext(project);
    const checkedAt = new Date().toISOString();
    try {
      res.json({ number, checkedAt, mergeState: await pullRequests.mergeState(project.id, number) });
    } catch (error) {
      // An unreadable merge state is one row's problem: answered like the list's own failure, so the row can show it with a Retry.
      if (!(error instanceof GitProviderError)) throw error;
      res.json({ number, checkedAt, mergeState: null, error: error.message });
    }
  }));

  router.post('/projects/:id/pull-requests/:number/merge', route(async (req, res) => {
    const number = pullRequestNumber(req, res);
    if (number === null) return;
    const { confirmBlockers, executorId } = req.body as { confirmBlockers?: unknown; executorId?: unknown };
    if ((confirmBlockers !== undefined && typeof confirmBlockers !== 'boolean') || (executorId !== undefined && typeof executorId !== 'string')) {
      res.status(400).json({ error: 'confirmBlockers must be a boolean and executorId a string' }); return;
    }
    const merged = await pullRequests.merge(param(req, 'id'), number, { confirmBlockers, executorId });
    reevaluateSync(param(req, 'id'));
    if (merged.outcome === 'merged') {
      void autoMerge.pullRequestMerged(param(req, 'id'), number).catch(() => undefined);
      void pullRequestStates.refreshProject(param(req, 'id')).catch(() => undefined);
    }
    res.json(merged);
  }));

  router.post('/projects/:id/pull-requests/:number/checkout', route(async (req, res) => {
    const number = pullRequestNumber(req, res);
    if (number === null) return;
    const checkedOut = await pullRequests.checkout(param(req, 'id'), number);
    reevaluateSync(checkedOut.id);
    res.json(withSync(checkedOut));
  }));

  router.post('/projects/:id/pull-requests/return', route(async (req, res) => {
    const { branch } = req.body as { branch?: unknown };
    if (branch !== undefined && typeof branch !== 'string') { res.status(400).json({ error: 'branch must be a string' }); return; }
    try {
      const returned = await pullRequests.returnFromCheckout(param(req, 'id'), branch);
      reevaluateSync(returned.id);
      res.json(withSync(returned));
    } catch (error) {
      if (!(error instanceof PreviousBranchGoneError)) throw error;
      res.status(409).json({ error: error.message, defaultBranch: error.defaultBranch });
    }
  }));

  router.post('/projects/:id/branches', route(async (req, res) => {
    const { branch, create } = req.body;
    if (typeof branch !== 'string' || !branch || (create !== undefined && typeof create !== 'boolean')) {
      res.status(400).json({ error: 'branch is required and create must be a boolean' }); return;
    }
    const result = await checkoutProjectBranch(param(req, 'id'), branch, create === true, (from, to) => workerManager.retargetPrimaryTasks(param(req, 'id'), from, to));
    reevaluateSync(param(req, 'id'));
    res.json(result);
  }));

  router.get('/projects/:id', route(async (req, res) => {
    res.json(withSync(await getProject(param(req, 'id'))));
  }));

  // The sync icon's click action (BranchSyncIndicator): runs a real, trackable CommandRun (the
  // same log popup/live output as any user-defined Project Command) that fetches and
  // fast-forwards the checked-out branch up to its remote — see commandRunner.ts's runProjectSync.
  router.post('/projects/:id/sync', route(async (req, res) => {
    res.status(201).json(await commandRunner.runProjectSync(param(req, 'id')));
  }));

  router.patch('/projects/:id', route(async (req, res) => {
    const { position, name } = req.body as { position?: unknown; name?: unknown };
    if (position === undefined && name === undefined) {
      res.status(400).json({ error: 'name or position is required' });
      return;
    }
    const id = param(req, 'id');
    let updated = await getProject(id);
    // The name is checked before the position moves, and the position before the name is saved, so a refused request changes nothing.
    if (name !== undefined) parseProjectName(name);
    if (position !== undefined) updated = await updateProjectPosition(id, position);
    if (name !== undefined) updated = await renameProject(id, name);
    if (name !== undefined) workerManager.publishEvent({ type: 'project', project: updated });
    res.json(updated);
  }));

  /** Sets (or, with `workflowId: null`, resets to the Catalog default) which Workflow a Project's Tasks run through — see ProjectRecord.workflowId. */
  router.patch('/projects/:id/workflow', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { workflowId } = req.body as { workflowId?: string | null };
    if (workflowId !== null && typeof workflowId !== 'string') {
      res.status(400).json({ error: 'workflowId must be a string or null' });
      return;
    }
    if (workflowId !== null && !(await getWorkflow(workflowId))) throw new WorkflowNotFoundError();
    res.json(withSync(await setProjectWorkflowId(project.id, workflowId)));
  }));

  router.patch('/projects/:id/git-provider', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { gitProvider } = req.body as { gitProvider?: unknown };
    if (!isGitProviderId(gitProvider)) { res.status(400).json({ error: new UnsupportedGitProviderError(gitProvider).message }); return; }
    res.json(withSync(await setProjectGitProvider(project.id, gitProvider)));
  }));

  // ---- GitHub accounts (from the machine's `gh`) and the per-project account — see github/accounts.ts ----

  router.get('/github/accounts', route(async (_req, res) => {
    res.json(await detectAccounts(await listProjects()));
  }));

  router.put('/github/accounts/:login/identity', route(async (req, res) => {
    const login = param(req, 'login');
    if (!isValidLogin(login)) { res.status(400).json({ error: 'That is not a valid GitHub username.' }); return; }
    await saveIdentity(login, req.body as { name?: unknown; email?: unknown });
    res.json(await detectAccounts(await listProjects()));
  }));

  router.delete('/github/accounts/:login/identity', route(async (req, res) => {
    const login = param(req, 'login');
    if (!isValidLogin(login)) { res.status(400).json({ error: 'That is not a valid GitHub username.' }); return; }
    await resetIdentity(login);
    res.json(await detectAccounts(await listProjects()));
  }));

  router.patch('/projects/:id/github-account', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { githubAccount } = req.body as { githubAccount?: unknown };
    if (githubAccount === null) { res.json(withSync(await setProjectGithubAccount(project.id, null))); return; }
    if (!isValidLogin(githubAccount)) { res.status(400).json({ error: 'Choose a GitHub account from the detected list, or null for the machine default.' }); return; }
    if (!project.repositoryUrl || !githubRepository(project.repositoryUrl)) { res.status(400).json({ error: 'A GitHub account can only be chosen for a project linked to a github.com repository.' }); return; }
    const known = (await listLogins()).find((entry) => entry.login.toLowerCase() === githubAccount.toLowerCase());
    if (!known) { res.status(400).json({ error: `GitHub account ${githubAccount} was not found in the GitHub CLI. Add it with \`gh auth login -h github.com\` and refresh.` }); return; }
    res.json(withSync(await setProjectGithubAccount(project.id, known.login)));
  }));

  router.post('/projects/:id/github-account/check', route(async (req, res) => {
    res.json(await checkProjectAccount(await getProject(param(req, 'id'))));
  }));

  /** Turns the automatic fast-forward of the checked-out branch on or off — see projects/autoPull.ts. Only a Project with a linked repository has the setting. */
  router.patch('/projects/:id/auto-pull', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { autoPullEnabled } = req.body as { autoPullEnabled?: unknown };
    if (typeof autoPullEnabled !== 'boolean') { res.status(400).json({ error: 'autoPullEnabled must be a boolean' }); return; }
    if (!project.repositoryUrl) { res.status(400).json({ error: 'This project has no linked repository' }); return; }
    const updated = await setProjectAutoPull(project.id, autoPullEnabled);
    void gitSyncPoller.refreshOne(updated);
    res.json(withSync(updated));
  }));

  router.delete('/projects/:id', route(async (req, res) => {
    const id = param(req, 'id');
    // A running test is stopped (and every run record/file removed) before the Project's folder goes.
    await deleteProject(id, {
      beforeRemove: async () => {
        await testRunner.discardProjectRuns(id);
        await commandRunner.stopProjectRuns(id);
        await agentSessions.stopAllForProject(id);
        await workerManager.stopProjectTerminals(id);
      },
    });
    await scheduler.removeBuilding(id);
    await connections.removeBuilding(id);
    workerManager.publishEvent({ type: 'projectDeleted', projectId: id });
    res.status(204).end();
  }));

  router.get('/projects/:id/blueprint', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const content = await readBlueprint(projectAbsolutePath(project), project.name);
    res.type('text/markdown').send(content);
  }));

  router.put('/projects/:id/blueprint', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    if (typeof req.body.content !== 'string') { res.status(400).json({ error: 'content must be a string' }); return; }
    await writeFile(blueprintPath(projectAbsolutePath(project)), req.body.content, 'utf-8');
    res.json({ content: req.body.content });
  }));

  // ---- Documents tab: the real file tree of the project's already-managed docs (docs/roadmap.md's Project Popover Redesign) ----

  router.get('/projects/:id/documents', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    res.json(await listProjectDocuments(projectAbsolutePath(project)));
  }));

  /** Read-only view of a plan-dir file that isn't one of the known PlanDocKeys — see documents.ts's readPlanDocumentRaw. */
  router.get('/projects/:id/documents/plan/:name', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const content = await readPlanDocumentRaw(projectAbsolutePath(project), param(req, 'name'));
    res.type('text/markdown').send(content);
  }));

  // ---- Code tab: whole-project file-tree explorer — read-only apart from creating new files and folders (docs/roadmap.md's Project Popover Redesign) ----

  router.get('/projects/:id/code/tree', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    res.json(await listProjectTree(projectAbsolutePath(project)));
  }));

  router.post('/projects/:id/code/entries', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const type = readEntryType(req.body, res);
    if (!type) return;
    res.status(201).json({ path: await createCodeEntry(projectAbsolutePath(project), req.body.path, type), type });
  }));

  router.get('/projects/:id/code/file', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const requestedPath = req.query.path;
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    try {
      const result = await readFileSafely(projectAbsolutePath(project), requestedPath);
      res.json({ path: requestedPath, ...result });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `No file at "${requestedPath}"` });
        return;
      }
      throw error;
    }
  }));

  // ---- Testing tab: the Project's testing contract (docs/architecture.md's "Project testing contract") ----

  /** Always 200 for a known Project: `absent`, `valid` or `invalid` (with every issue) — read fresh from disk each time. */
  router.get('/projects/:id/testing/config', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    res.json(await loadTestingConfig(projectAbsolutePath(project)));
  }));

  // ---- Testing setup (task 2.005): an approval-gated setup Task — see testing/setup.ts ----

  /** The Project's active testing setup (or its latest completed one), or null. */
  router.get('/projects/:id/testing/setup', route(async (req, res) => {
    res.json(await workerManager.getTestingSetup(param(req, 'id')));
  }));

  /** Starts a setup, or returns the one already active or queued (200, `existing: true`) instead of a duplicate. */
  router.post('/projects/:id/testing/setup', route(async (req, res) => {
    const { executorId } = req.body as { executorId?: unknown };
    if (executorId !== undefined && (typeof executorId !== 'string' || !executorId)) {
      res.status(400).json({ error: 'executorId must be a non-empty string' });
      return;
    }
    const result = await workerManager.startTestingSetup(param(req, 'id'), { executorId: executorId as string | undefined });
    res.status(result.existing ? 200 : 201).json(result);
  }));

  /** The run behind a testing-setup action — 404 for an unknown run, 409 for a run that isn't a testing setup. */
  async function requireSetupRun(runId: string) {
    const { run } = await workerManager.getWorkflowRunDetail(runId);
    if (!run.testingSetup) throw new TestingSetupApprovalError(`Workflow run "${runId}" is not a testing setup.`);
    return run;
  }

  /** The only action that approves a setup proposal, and so the only one that unlocks writes. `proposalRound` must be the round shown to the person. */
  router.post('/testing-setup/:runId/approve', route(async (req, res) => {
    const { proposalRound, comment } = req.body as { proposalRound?: unknown; comment?: unknown };
    if (!Number.isInteger(proposalRound) || (proposalRound as number) < 1) {
      res.status(400).json({ error: 'proposalRound must be the positive round number of the proposal being approved' });
      return;
    }
    const runId = param(req, 'runId');
    await requireSetupRun(runId);
    res.json(await workerManager.approveTestingSetup(runId, proposalRound as number, typeof comment === 'string' && comment.trim() ? comment.trim() : undefined));
  }));

  /** Feedback on a proposal: a new, still read-only proposal round. */
  router.post('/testing-setup/:runId/revise', route(async (req, res) => {
    const { comment } = req.body as { comment?: unknown };
    if (typeof comment !== 'string' || !comment.trim()) { res.status(400).json({ error: 'comment is required' }); return; }
    const runId = param(req, 'runId');
    await requireSetupRun(runId);
    res.json(await workerManager.requestChangesWorkflowRun(runId, comment.trim()));
  }));

  /** Rejects (or cancels) a setup: stops it with the project unchanged. */
  router.post('/testing-setup/:runId/reject', route(async (req, res) => {
    const runId = param(req, 'runId');
    await requireSetupRun(runId);
    res.json(await workerManager.stopWorkflowRun(runId));
  }));

  // ---- Test Runs: executing configured Test Actions (see testing/testRunner.ts) ----

  /** The config state plus every suite/action's latest result and the Project's run queue. */
  router.get('/projects/:id/testing', route(async (req, res) => {
    res.json(await testRunner.getOverview(param(req, 'id')));
  }));

  /** Newest first. `?suiteId=`/`?actionId=`/`?status=`/`?failureUnopened=true` narrow it; `?limit=` (1-100, default 25) and `?offset=` page it. */
  router.get('/projects/:id/test-runs', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { suiteId, actionId, status, failureUnopened } = req.query as Record<string, unknown>;
    const limit = queryInt(req.query.limit, 25);
    const offset = queryInt(req.query.offset, 0);
    if (limit === null || limit < 1 || limit > MAX_TEST_RUN_PAGE) { res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_TEST_RUN_PAGE}` }); return; }
    if (offset === null) { res.status(400).json({ error: 'offset must be a non-negative whole number' }); return; }
    if (status !== undefined && !TEST_RUN_STATUSES.includes(status as TestRunStatus)) {
      res.status(400).json({ error: `status must be one of ${TEST_RUN_STATUSES.join(', ')}` });
      return;
    }
    if ((suiteId !== undefined && typeof suiteId !== 'string') || (actionId !== undefined && typeof actionId !== 'string')) {
      res.status(400).json({ error: 'suiteId and actionId must be single strings' });
      return;
    }
    if (failureUnopened !== undefined && failureUnopened !== 'true') { res.status(400).json({ error: 'failureUnopened must be "true"' }); return; }
    res.json(await testRunner.listTestRuns(project.id, { suiteId, actionId, status: status as TestRunStatus | undefined, failureUnopened: failureUnopened === 'true', limit, offset }));
  }));

  /** Queues one action. `taskId` (optional) makes it an agent run in that Task's own working tree. */
  router.post('/projects/:id/test-runs', route(async (req, res) => {
    const { suiteId, actionId } = (req.body ?? {}) as { suiteId?: unknown; actionId?: unknown };
    const task = optionalTaskId(req.body);
    if (typeof suiteId !== 'string' || !suiteId || typeof actionId !== 'string' || !actionId) {
      res.status(400).json({ error: 'suiteId and actionId are required' });
      return;
    }
    if (!task.ok) { res.status(400).json({ error: 'taskId must be a non-empty string' }); return; }
    res.status(201).json(await testRunner.enqueueAction(param(req, 'id'), suiteId, actionId, { taskId: task.taskId }));
  }));

  /** "Run all": every enabled suite's primary action, in config order, as one batch. */
  router.post('/projects/:id/test-runs/run-all', route(async (req, res) => {
    const task = optionalTaskId(req.body);
    if (!task.ok) { res.status(400).json({ error: 'taskId must be a non-empty string' }); return; }
    res.status(201).json(await testRunner.enqueueRunAll(param(req, 'id'), { taskId: task.taskId }));
  }));

  router.get('/test-runs/:runId', route(async (req, res) => {
    res.json(await testRunner.getTestRun(param(req, 'runId')));
  }));

  /** Someone opened this run: its unopened failure (if any) is cleared — see `TestRunRecord.failureUnopened`. */
  router.post('/test-runs/:runId/opened', route(async (req, res) => {
    res.json(await testRunner.markTestRunOpened(param(req, 'runId')));
  }));

  router.post('/test-runs/:runId/stop', route(async (req, res) => {
    res.json(await testRunner.stopTestRun(param(req, 'runId')));
  }));

  /** Removes a queued (not yet started) run. */
  router.delete('/test-runs/:runId', route(async (req, res) => {
    await testRunner.removeQueuedRun(param(req, 'runId'));
    res.status(204).end();
  }));

  /**
   * A coding session's testing tools — see terminal/testTaskTool.ts. Every call names its Task with
   * `?taskId=` and carries the CLI hook token; the Project, working tree and command all come from
   * that Task and its config, never from the request. `waitSeconds` (default/max in
   * testing/agentTesting.ts) bounds how long a call blocks for runs to settle.
   */
  async function testingSession(req: Request, res: Response) {
    if (!authorizeCliToken(req, res)) return null;
    const { taskId } = req.query;
    if (typeof taskId !== 'string' || !taskId) { res.status(400).json({ error: 'taskId is required' }); return null; }
    // An Agent terminal session runs tests in its Project's own folder; every other caller is a Task.
    const agentProjectId = await agentSessions.projectIdOf(taskId);
    return agentProjectId ? { projectId: agentProjectId } : workerManager.requireTestingSession(taskId);
  }

  function waitSeconds(value: unknown, res: Response): number | null {
    const seconds = parseWaitSeconds(value);
    if (seconds === null) res.status(400).json({ error: 'waitSeconds must be a number' });
    return seconds;
  }

  router.get('/agent-testing/actions', route(async (req, res) => {
    const task = await testingSession(req, res);
    if (task) res.json(await agentTesting.listActions(task));
  }));

  router.post('/agent-testing/runs', route(async (req, res) => {
    const task = await testingSession(req, res);
    if (!task) return;
    const { suiteId, actionId } = (req.body ?? {}) as { suiteId?: unknown; actionId?: unknown };
    if (typeof suiteId !== 'string' || !suiteId || typeof actionId !== 'string' || !actionId) {
      res.status(400).json({ error: 'suiteId and actionId are required — call list_test_actions to see them' });
      return;
    }
    const wait = waitSeconds(req.body?.waitSeconds, res);
    if (wait !== null) res.status(201).json(await agentTesting.runAction(task, suiteId, actionId, wait));
  }));

  router.post('/agent-testing/run-all', route(async (req, res) => {
    const task = await testingSession(req, res);
    if (!task) return;
    const wait = waitSeconds(req.body?.waitSeconds, res);
    if (wait !== null) res.status(201).json(await agentTesting.runAll(task, wait));
  }));

  router.get('/agent-testing/runs/:runId', route(async (req, res) => {
    const task = await testingSession(req, res);
    if (!task) return;
    const wait = waitSeconds(req.query.waitSeconds, res);
    if (wait !== null) res.json(await agentTesting.getRun(task, param(req, 'runId'), wait));
  }));

  // A coding session's one bug tool: file a bug for a failing test unrelated to its task. Create only —
  // there is no read, update or delete here. 201 with `existing: false` for a new bug, 200 with
  // `existing: true` when an open bug already stands for the same suite, action and case.
  router.post('/agent-testing/bugs', route(async (req, res) => {
    if (!authorizeCliToken(req, res)) return;
    const { taskId } = req.query;
    if (typeof taskId !== 'string' || !taskId) { res.status(400).json({ error: 'taskId is required' }); return; }
    if (await agentSessions.projectIdOf(taskId)) { res.status(409).json({ error: 'Bugs cannot be filed from an Agent terminal session yet' }); return; }
    const result = await workerManager.fileAgentBug(taskId, parseAgentBug(req.body));
    res.status(result.existing ? 200 : 201).json(result);
  }));

  // ---- Project plan: the Full-fledged Project Popover's tab content (docs/roadmap.md) ----

  // ---- Documents tab: the whole editable `.docs/` folder ----

  router.get('/projects/:id/docs/tree', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    res.json(await listDocsTree(projectAbsolutePath(project)));
  }));

  router.get('/projects/:id/docs/file', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const filePath = req.query.path;
    if (typeof filePath !== 'string' || !filePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    res.json(await readDocsFile(projectAbsolutePath(project), filePath));
  }));

  router.put('/projects/:id/docs/file', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { path: filePath, content } = req.body as { path?: string; content?: string };
    if (typeof filePath !== 'string' || !filePath || typeof content !== 'string') {
      res.status(400).json({ error: 'path and content are required' });
      return;
    }
    await writeDocsFile(projectAbsolutePath(project), filePath, content);
    res.json({ path: filePath, content });
  }));

  router.post('/projects/:id/docs/entries', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const type = readEntryType(req.body, res);
    if (!type) return;
    res.status(201).json({ path: await createDocsEntry(projectAbsolutePath(project), req.body.path, type), type });
  }));

  router.get('/projects/:id/plan', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const [docsByKey, items] = await Promise.all([
      readAllPlanDocs(projectAbsolutePath(project)),
      listPlanItems(project.id),
    ]);
    const docs = PLAN_DOC_KEYS.map((key) => ({ key, title: PLAN_DOC_TITLES[key], content: docsByKey[key] }));
    res.json({ docs, items });
  }));

  router.put('/projects/:id/plan/docs/:key', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const key = requirePlanDocKey(param(req, 'key'));
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    await writePlanDoc(projectAbsolutePath(project), key, content);
    res.json({ key, title: PLAN_DOC_TITLES[key], content });
  }));

  router.post('/projects/:id/plan-items', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { title, description } = req.body as { title?: string; description?: string };
    const trimmedTitle = title?.trim() ?? '';
    const trimmedDescription = description?.trim() ?? '';
    if (!trimmedTitle && !trimmedDescription) {
      res.status(400).json({ error: 'title or description is required' });
      return;
    }
    // Description only: save it under a placeholder title now, and let a background agent name it.
    const item = await createPlanItem({ projectId: project.id, title: trimmedTitle || provisionalTitle(trimmedDescription), description: trimmedDescription });
    if (!trimmedTitle) planItemTitler.requestTitle(item);
    res.status(201).json(item);
  }));

  router.patch('/plan-items/:id', route(async (req, res) => {
    const { title, description, order, status, archived, infoStatus } = req.body as {
      title?: string;
      description?: string;
      order?: number;
      status?: string;
      archived?: unknown;
      /** A bug's advisory flag, changeable only while the bug has not started. The item's `type` is never changeable. */
      infoStatus?: unknown;
    };
    // The only status a caller may set is "done" (mark complete: stops, commits and completes its run
    // without running any remaining step — see workerManager.completePlanItem). Every other transition
    // belongs to a Task's own lifecycle.
    if (status !== undefined && status !== 'done') {
      res.status(400).json({ error: 'status can only be set to "done"' });
      return;
    }
    if (archived !== undefined && typeof archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean' });
      return;
    }
    const id = param(req, 'id');
    const patch: Parameters<typeof updatePlanItem>[1] = {};
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    if (order !== undefined) patch.order = order;
    const nextInfoStatus = infoStatus === undefined ? undefined : parseInfoStatus(infoStatus);
    // First, so a refused Info status change (a task, or a bug that has started) leaves the title and description alone too.
    let item = nextInfoStatus ? await workerManager.setBugInfoStatus(id, nextInfoStatus) : undefined;
    if (Object.keys(patch).length > 0) item = await updatePlanItem(id, patch);
    if (status === 'done') item = await workerManager.completePlanItem(id);
    if (archived !== undefined) item = await workerManager.archivePlanItem(id, archived);
    res.json(item ?? (await getPlanItem(id)));
  }));

  // ---- A task's Auto-merge: merges its own pull request after completion — see projects/autoMergeService.ts ----

  router.put('/projects/:id/plan-items/:itemId/auto-merge', route(async (req, res) => {
    const enabled = parseAutoMergeToggle(req.body);
    if (enabled === null) { res.status(400).json({ error: 'The body must be { "enabled": true | false }' }); return; }
    res.json(await autoMerge.setEnabled(param(req, 'id'), param(req, 'itemId'), enabled));
  }));

  /** Refuses (409, with Auto-merge's own reason) a start that asks for Auto-merge on a task that could never have a pull request of its own. */
  async function assertAutoMergeAllowed(projectId: string, wanted: boolean | undefined, createBranch: boolean | undefined): Promise<void> {
    if (wanted !== true) return;
    const reason = autoMergeIneligibleReason(await getProject(projectId), createBranch === false ? { branch: undefined, baseBranch: undefined } : null);
    if (reason) throw new AutoMergeUnavailableError(reason);
  }

  /** Saves a start's Auto-merge choice the same way the task details toggle does; absent leaves it as it was. */
  async function applyStartAutoMerge(projectId: string, itemId: string, wanted: boolean | undefined): Promise<void> {
    if (wanted !== undefined) await autoMerge.setEnabled(projectId, itemId, wanted, { atStart: true });
  }

  router.post('/projects/:id/plan-items/:itemId/auto-merge/retry', route(async (req, res) => {
    res.json(await autoMerge.retry(param(req, 'id'), param(req, 'itemId')));
  }));

  // ---- Dependent tasks: a task starts by itself once its parents' work is in the checked-out branch — see projects/dependencyService.ts ----

  router.put('/projects/:id/plan-items/:itemId/dependencies', route(async (req, res) => {
    res.json(await dependencies.setDependencies(param(req, 'id'), param(req, 'itemId'), (req.body as { dependsOn?: unknown } | undefined)?.dependsOn));
  }));

  router.get('/projects/:id/plan-items/:itemId/dependencies', route(async (req, res) => {
    res.json(await dependencies.statusOf(param(req, 'id'), param(req, 'itemId')));
  }));

  // Start on a dependent task. Body: the same start options as /plan-items/:id/execute.
  // 201 { started: true, run } when every parent is satisfied now; 202 { started: false, item } when the task waits for them,
  // or 202 { started: false, entry, item } when they are satisfied but the Project is at its task limit (the task joins the waiting list).
  // Optional uiPlanningWaitsForParent (boolean) is saved on the task only when the start is accepted.
  router.post('/projects/:id/plan-items/:itemId/start-when-ready', route(async (req, res) => {
    const { executorId, workflowId, createBranch, skippedStepIds, autoMerge: withAutoMerge, uiPlanningWaitsForParent } = (req.body ?? {}) as {
      executorId?: unknown; workflowId?: unknown; createBranch?: unknown; skippedStepIds?: unknown; autoMerge?: unknown; uiPlanningWaitsForParent?: unknown;
    };
    const error = await startOptionsError({ executorId, workflowId, createBranch, skippedStepIds, autoMerge: withAutoMerge })
      ?? (uiPlanningWaitsForParent !== undefined && parseUiPlanningWaits(uiPlanningWaitsForParent) === null ? 'uiPlanningWaitsForParent must be true or false' : null);
    if (error) { res.status(400).json({ error }); return; }
    await assertAutoMergeAllowed(param(req, 'id'), withAutoMerge as boolean | undefined, createBranch as boolean | undefined);
    const result = await dependencies.startWhenReady(param(req, 'id'), param(req, 'itemId'), {
      ...(executorId !== undefined ? { executorId: executorId as string } : {}),
      ...(workflowId !== undefined ? { workflowId: workflowId as string } : {}),
      ...(createBranch !== undefined ? { createBranch: createBranch as boolean } : {}),
      ...(skippedStepIds !== undefined ? { skippedStepIds: skippedStepIds as string[] } : {}),
    }, uiPlanningWaitsForParent as boolean | undefined);
    // Saved only now that the start was accepted (started, or waiting for its parents).
    await applyStartAutoMerge(param(req, 'id'), param(req, 'itemId'), withAutoMerge as boolean | undefined);
    res.status(result.started ? 201 : 202).json(result.started ? result : { ...result, item: await getPlanItem(param(req, 'itemId')) });
  }));

  // "UI planning waits for parent". Body { uiPlanningWaitsForParent: boolean }; 400 for anything else, 409 once UI Planning
  // has started, for a task with no parents, or one archived, merged or started normally. 200 with the task.
  router.put('/projects/:id/plan-items/:itemId/ui-planning-waits', route(async (req, res) => {
    res.json(await dependencies.setUiPlanningWaits(param(req, 'id'), param(req, 'itemId'), (req.body as { uiPlanningWaitsForParent?: unknown } | undefined)?.uiPlanningWaitsForParent));
  }));

  router.post('/projects/:id/plan-items/:itemId/cancel-waiting', route(async (req, res) => {
    res.json(await dependencies.cancelWaiting(param(req, 'id'), param(req, 'itemId')));
  }));

  // "Chain tasks": every ready task of a planning session depends on the previous one; optionally all get Auto-merge.
  router.post('/projects/:id/planning-groups/:session/chain', route(async (req, res) => {
    const session = Number(param(req, 'session'));
    const { autoMerge: withAutoMerge } = (req.body ?? {}) as { autoMerge?: unknown };
    if (!Number.isInteger(session) || session < 1 || (withAutoMerge !== undefined && typeof withAutoMerge !== 'boolean')) {
      res.status(400).json({ error: 'The session must be a positive whole number and autoMerge a boolean' });
      return;
    }
    res.json(await dependencies.chainGroup(param(req, 'id'), session, withAutoMerge === true));
  }));

  // Drag-and-drop reordering within a board column: the listed items take the given sequence; everything else keeps its place.
  router.put('/projects/:id/plan-items/order', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { ids } = req.body as { ids?: unknown };
    if (!isDistinctIdList(ids)) {
      res.status(400).json({ error: 'ids must be an array of distinct plan item ids' });
      return;
    }
    res.json(await reorderPlanItems(project.id, ids));
  }));

  router.put('/projects/:id/planning-queue/order', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { entries } = req.body as { entries?: unknown };
    if (!Array.isArray(entries) || !entries.every(isPlanningQueueEntry)) {
      res.status(400).json({ error: 'entries must contain planning session, task or introducing-task (reference) ids' });
      return;
    }
    await workerManager.reorderPlanningQueue(project.id, entries);
    res.status(204).end();
  }));

  // Reorders the ready bugs grouped under one introducing task; `:introducerId` is that task's id.
  router.put('/projects/:id/planning-queue/bugs/:introducerId/order', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { ids } = req.body as { ids?: unknown };
    if (!isDistinctIdList(ids)) {
      res.status(400).json({ error: 'ids must be an array of distinct plan item ids' });
      return;
    }
    await workerManager.reorderBugGroup(project.id, param(req, 'introducerId'), ids);
    res.status(204).end();
  }));

  // Reorders one planning group's ready tasks; `:sessionId` is any Task of that planning conversation.
  router.put('/projects/:id/planning-queue/sessions/:sessionId/order', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { ids } = req.body as { ids?: unknown };
    if (!isDistinctIdList(ids)) {
      res.status(400).json({ error: 'ids must be an array of distinct plan item ids' });
      return;
    }
    await workerManager.reorderPlanningGroup(project.id, param(req, 'sessionId'), ids);
    res.status(204).end();
  }));

  // Stops any live session of the item and removes its run's worktree (the branch stays) before deleting it.
  router.delete('/plan-items/:id', route(async (req, res) => {
    await workerManager.deletePlanItem(param(req, 'id'));
    res.status(204).end();
  }));

  // Starts a New item — the only way it leaves New. Body (all optional):
  //   executorId: string   — the run's coding agent (400 if unknown)
  //   workflowId: string   — the Catalog Workflow to run (400 if unknown or disabled); default: the Project's
  //   createBranch: boolean — true: its own worktree on a new `task/…` branch; false: the Project's own folder
  //                          and checked-out branch (409 while another task works there). Default: true when
  //                          the Project has a repository, else false (true without one is a 400).
  //   skippedStepIds: string[] — steps of that workflow to leave out of this run (400 for an unknown id, for
  //                          skipping every step, or for skipping a step while one that depends on it runs)
  // 201 with the new WorkflowRun, accepted after only the fast local checks: it is `starting` while its
  // worktree, hooks and agent are set up in the background (see `run.startup`), then `running`.
  // 202 { started: false, entry } when the Project is at its task limit: the start waits in line with these options
  // and begins by itself when a slot frees (see GET /projects/:id/plan-item-queue).
  router.post('/plan-items/:id/execute', route(async (req, res) => {
    const { executorId, workflowId, createBranch, skippedStepIds, autoMerge: withAutoMerge } = req.body as { executorId?: unknown; workflowId?: unknown; createBranch?: unknown; skippedStepIds?: unknown; autoMerge?: unknown };
    const error = await startOptionsError({ executorId, workflowId, createBranch, skippedStepIds, autoMerge: withAutoMerge });
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const item = await getPlanItem(param(req, 'id'));
    if (item.dependsOn?.length || item.waiting) {
      res.status(409).json({ error: 'This task depends on other tasks: start it with start-when-ready.' });
      return;
    }
    await assertAutoMergeAllowed(item.projectId, withAutoMerge as boolean | undefined, createBranch as boolean | undefined);
    const result = await workerManager.enqueuePlanItemExecution(param(req, 'id'), {
      executorId: executorId as string | undefined,
      workflowId: workflowId as string | undefined,
      createBranch: createBranch as boolean | undefined,
      skippedStepIds: skippedStepIds as string[] | undefined,
    });
    await applyStartAutoMerge(item.projectId, item.id, withAutoMerge as boolean | undefined);
    if (result.started) res.status(201).json(result.run);
    else res.status(202).json(result);
  }));

  // The Project's waiting list: starts accepted while it was at its task limit, in the order they will start.
  router.get('/projects/:id/plan-item-queue', route(async (req, res) => {
    await getProject(param(req, 'id')); // 404s if the project doesn't exist
    res.json(await workerManager.listPlanItemQueue(param(req, 'id')));
  }));

  // Takes a task off the waiting list; it goes back to unstarted. 404 when the entry already started or was removed.
  router.delete('/plan-item-queue/:entryId', route(async (req, res) => {
    await workerManager.removeQueuedPlanItemExecution(param(req, 'entryId'));
    res.status(204).end();
  }));

  // Saves the note for one step of a task, appended to the end of that step's input the next time it starts.
  // Body: { note: string | null } (empty or null clears it). 400 for a bad step id, a step outside the task's workflow,
  // a missing or non-text note, or one over the length limit; 404 for an unknown task. 200 with the task.
  router.put('/plan-items/:id/step-notes/:stepId', route(async (req, res) => {
    const body = (req.body ?? {}) as { note?: unknown };
    if (!('note' in body)) throw new StepNoteValidationError('note is required');
    res.json(await workerManager.setStepNote(param(req, 'id'), param(req, 'stepId'), body.note));
  }));

  // Reports a regression on a completed bug and starts its round 2 at once. Body: { reason } (400 when blank,
  // not text or over 20,000 characters). 201 with { item, run, workflowNote }; 404 for an unknown bug; 409 for a
  // task, a bug that is not completed (including one already reopened) or a start the Project refuses.
  router.post('/plan-items/:id/regression', route(async (req, res) => {
    const reason = parseRegressionBody(req.body);
    res.status(201).json(await workerManager.reopenBug(param(req, 'id'), { reason, reporter: { kind: 'person' } }));
  }));

  // ---- Workflow runs (task 3.012): one run per executed PlanItem, its Steps' full round history, and its approval/loop/stop actions ----

  router.get('/projects/:id/workflow-runs', route(async (req, res) => {
    await getProject(param(req, 'id')); // 404s if the project doesn't exist
    res.json(await workerManager.listWorkflowRunsForProject(param(req, 'id')));
  }));

  router.get('/workflow-runs/:id', route(async (req, res) => {
    res.json(await workerManager.getWorkflowRunDetail(param(req, 'id')));
  }));

  router.post('/workflow-runs/:id/approve', route(async (req, res) => {
    const { comment } = req.body as { comment?: string };
    res.json(await workerManager.approveWorkflowRun(param(req, 'id'), typeof comment === 'string' ? comment : undefined));
  }));

  router.post('/workflow-runs/:id/request-changes', route(async (req, res) => {
    const { comment } = req.body as { comment?: string };
    if (!comment || !comment.trim()) { res.status(400).json({ error: 'comment is required' }); return; }
    res.json(await workerManager.requestChangesWorkflowRun(param(req, 'id'), comment.trim()));
  }));

  router.post('/workflow-runs/:id/loop', route(async (req, res) => {
    const { action, comment } = req.body as { action?: string; comment?: string };
    if (action !== 'another-round' && action !== 'continue') {
      res.status(400).json({ error: 'action must be "another-round" or "continue"' });
      return;
    }
    res.json(await workerManager.decideWorkflowRunLoop(param(req, 'id'), action, typeof comment === 'string' ? comment : undefined));
  }));

  router.post('/workflow-runs/:id/retry-step', route(async (req, res) => {
    res.json(await workerManager.retryWorkflowStep(param(req, 'id')));
  }));

  // Halts the run (status "stopped", its PlanItem "blocked"), keeping its worktree and session for /resume.
  router.post('/workflow-runs/:id/stop', route(async (req, res) => {
    res.json(await workerManager.stopWorkflowRun(param(req, 'id')));
  }));

  // Resumes a stopped run's current step in its own CLI session with a "continue" message; 409 unless the run is "stopped".
  router.post('/workflow-runs/:id/resume', route(async (req, res) => {
    res.json(await workerManager.resumeWorkflowRun(param(req, 'id')));
  }));

  // ---- Quick look (task 5.008): live, read-only views of a WorkflowRun's working copy ----

  /** The run and its Project, the pair every Quick look read resolves its directory from. */
  async function quickLookTarget(req: Request) {
    const run = await workerManager.getWorkflowRun(param(req, 'id'));
    return { run, project: await getProject(run.projectId) };
  }

  /** Answers 404 for a file that doesn't exist, the same as the Code tab's reader. */
  async function sendFileRead(res: Response, requestedPath: string, read: () => Promise<unknown>): Promise<void> {
    try {
      res.json({ path: requestedPath, ...(await read() as object) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      res.status(404).json({ error: `No file at "${requestedPath}"` });
    }
  }

  router.get('/workflow-runs/:id/quick-look', route(async (req, res) => {
    const { run, project } = await quickLookTarget(req);
    res.json(publicRunLocation(await resolveRunLocation(run, project)));
  }));

  router.get('/workflow-runs/:id/quick-look/code/tree', route(async (req, res) => {
    const { run, project } = await quickLookTarget(req);
    res.json(await quickLookCodeTree(run, project));
  }));

  router.get('/workflow-runs/:id/quick-look/code/file', route(async (req, res) => {
    const requestedPath = requiredPathQuery(req, res);
    if (!requestedPath) return;
    const { run, project } = await quickLookTarget(req);
    await sendFileRead(res, requestedPath, () => quickLookCodeFile(run, project, requestedPath));
  }));

  router.get('/workflow-runs/:id/quick-look/docs/tree', route(async (req, res) => {
    const { run, project } = await quickLookTarget(req);
    res.json(await quickLookDocsTree(run, project));
  }));

  router.get('/workflow-runs/:id/quick-look/docs/file', route(async (req, res) => {
    const requestedPath = requiredPathQuery(req, res);
    if (!requestedPath) return;
    const { run, project } = await quickLookTarget(req);
    await sendFileRead(res, requestedPath, () => quickLookDocsFile(run, project, requestedPath));
  }));

  router.get('/workflow-runs/:id/quick-look/diff', route(async (req, res) => {
    const { run, project } = await quickLookTarget(req);
    res.json(await quickLookDiff(run, project));
  }));

  router.get('/workflow-runs/:id/quick-look/diff/file', route(async (req, res) => {
    const requestedPath = requiredPathQuery(req, res);
    if (!requestedPath) return;
    const { run, project } = await quickLookTarget(req);
    res.json(await quickLookDiffFile(run, project, requestedPath));
  }));

  /**
   * A WorkflowRun step session's own internal API — reached through terminal/stepTaskTool.ts's MCP
   * server (bin/step-task-mcp.mjs), the same pattern as `/api/agent-tasks` for a planning session.
   * Every call names its step Task with `?taskId=` and is authenticated with the daemon's CLI hook
   * token, so only a session the daemon itself launched can call it, and only for its own step.
   */
  function workflowStepTaskId(req: Request, res: Response): string | null {
    if (!authorizeCliToken(req, res)) return null;
    const { taskId } = req.query;
    if (typeof taskId === 'string' && taskId) return taskId;
    res.status(400).json({ error: 'taskId is required' });
    return null;
  }

  router.post('/workflow-steps/complete', route(async (req, res) => {
    const taskId = workflowStepTaskId(req, res);
    if (!taskId) return;
    const { summary, outputs, verdict, planningGap } = req.body as { summary?: unknown; outputs?: unknown; verdict?: unknown; planningGap?: unknown };
    if (typeof summary !== 'string' || !summary.trim()) { res.status(400).json({ error: 'summary is required' }); return; }
    if (verdict !== undefined && verdict !== 'pass' && verdict !== 'issues') { res.status(400).json({ error: 'verdict must be "pass" or "issues"' }); return; }
    if (planningGap !== undefined && planningGap !== null && typeof planningGap !== 'string') { res.status(400).json({ error: 'planningGap must be a string' }); return; }
    const parsedOutputs = parseStepOutputs(outputs);
    if ('error' in parsedOutputs) { res.status(400).json({ error: parsedOutputs.error }); return; }
    res.status(201).json(await workerManager.completeStep(taskId, {
      summary: summary.trim(),
      outputs: parsedOutputs.outputs,
      verdict: verdict as 'pass' | 'issues' | undefined,
      planningGap: planningGap ?? undefined,
    }));
  }));

  router.post('/workflow-steps/skip', route(async (req, res) => {
    const taskId = workflowStepTaskId(req, res);
    if (!taskId) return;
    const { reason } = req.body as { reason?: unknown };
    if (typeof reason !== 'string' || !reason.trim()) { res.status(400).json({ error: 'reason is required' }); return; }
    res.status(201).json(await workerManager.skipStep(taskId, { reason: reason.trim() }));
  }));

  /** Caps on `report_progress`'s input (task 5.017) so a runaway agent can't flood the live view — also declared in bin/step-task-mcp.mjs's tool schema, which a well-behaved client sees before ever calling this route. */
  const PROGRESS_LIMITS = { checklistItems: 20, itemText: 200, note: 200, currentActivity: 200, estimate: 60 };

  const PROGRESS_ITEM_STATES = ['pending', 'in-progress', 'done', 'skipped'] as const;

  /** Validates one `report_progress` checklist item, returning its error message or null. */
  function progressItemError(item: unknown, index: number): string | null {
    if (typeof item !== 'object' || item === null) return `checklist[${index}] must be an object`;
    const { text, state, note, short } = item as { text?: unknown; state?: unknown; note?: unknown; short?: unknown };
    if (typeof text !== 'string' || !text.trim()) return `checklist[${index}].text is required`;
    if (text.length > PROGRESS_LIMITS.itemText) return `checklist[${index}].text must be at most ${PROGRESS_LIMITS.itemText} characters`;
    if (typeof state !== 'string' || !PROGRESS_ITEM_STATES.includes(state as typeof PROGRESS_ITEM_STATES[number])) return `checklist[${index}].state must be one of ${PROGRESS_ITEM_STATES.join(', ')}`;
    if (note !== undefined && note !== null && typeof note !== 'string') return `checklist[${index}].note must be a string`;
    if (typeof note === 'string' && note.length > PROGRESS_LIMITS.note) return `checklist[${index}].note must be at most ${PROGRESS_LIMITS.note} characters`;
    // Never refused for length: the daemon trims it (worker/stepProgress.ts's trimShortLabel).
    if (short !== undefined && short !== null && typeof short !== 'string') return `checklist[${index}].short must be a string`;
    return null;
  }

  router.post('/workflow-steps/progress', route(async (req, res) => {
    const taskId = workflowStepTaskId(req, res);
    if (!taskId) return;
    const { checklist, currentActivity, estimate } = req.body as { checklist?: unknown; currentActivity?: unknown; estimate?: unknown };
    if (checklist === undefined && currentActivity === undefined && estimate === undefined) {
      res.status(400).json({ error: 'at least one of checklist, currentActivity or estimate is required' });
      return;
    }
    if (checklist !== undefined) {
      if (!Array.isArray(checklist)) { res.status(400).json({ error: 'checklist must be an array' }); return; }
      if (checklist.length > PROGRESS_LIMITS.checklistItems) { res.status(400).json({ error: `checklist must have at most ${PROGRESS_LIMITS.checklistItems} items` }); return; }
      for (const [index, item] of checklist.entries()) {
        const error = progressItemError(item, index);
        if (error) { res.status(400).json({ error }); return; }
      }
    }
    if (currentActivity !== undefined && currentActivity !== null) {
      if (typeof currentActivity !== 'string') { res.status(400).json({ error: 'currentActivity must be a string' }); return; }
      if (currentActivity.length > PROGRESS_LIMITS.currentActivity) { res.status(400).json({ error: `currentActivity must be at most ${PROGRESS_LIMITS.currentActivity} characters` }); return; }
    }
    if (estimate !== undefined && estimate !== null) {
      if (typeof estimate !== 'string') { res.status(400).json({ error: 'estimate must be a string' }); return; }
      if (estimate.length > PROGRESS_LIMITS.estimate) { res.status(400).json({ error: `estimate must be at most ${PROGRESS_LIMITS.estimate} characters` }); return; }
    }
    res.status(201).json(await workerManager.reportProgress(taskId, {
      checklist: (checklist as { text: string; state: 'pending' | 'in-progress' | 'done' | 'skipped'; note?: string | null; short?: string | null }[] | undefined)?.map((item) => ({ text: item.text.trim(), state: item.state, note: item.note?.trim() || null, short: item.short ?? null })),
      currentActivity: currentActivity as string | null | undefined,
      estimate: estimate as string | null | undefined,
    }));
  }));

  router.get('/workflow-steps/diff-summary', route(async (req, res) => {
    const taskId = workflowStepTaskId(req, res);
    if (!taskId) return;
    res.json({ summary: await workerManager.stepDiffSummary(taskId) });
  }));

  router.get('/workflow-steps/diff-file', route(async (req, res) => {
    const taskId = workflowStepTaskId(req, res);
    if (!taskId) return;
    const { path: filePath } = req.query as { path?: string };
    if (!filePath) { res.status(400).json({ error: 'path is required' }); return; }
    res.json({ diff: await workerManager.stepDiffFile(taskId, filePath) });
  }));

  // ---- Project Commands: user-defined shell commands, run from the project's root (docs/architecture.md's "Project Commands" decision) ----

  router.get('/projects/:id/commands', route(async (req, res) => {
    await getProject(param(req, 'id')); // 404s if the project doesn't exist
    res.json(await listCommands(param(req, 'id')));
  }));

  router.post('/projects/:id/commands', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { name, command, highlighted } = req.body as { name?: string; command?: string; highlighted?: boolean };
    if (!name || !name.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    if (!command || !command.trim()) { res.status(400).json({ error: 'command is required' }); return; }
    if (highlighted !== undefined && typeof highlighted !== 'boolean') { res.status(400).json({ error: 'highlighted must be a boolean' }); return; }
    res.status(201).json(await createCommand({ projectId: project.id, name: name.trim(), command: command.trim(), highlighted }));
  }));

  router.patch('/commands/:id', route(async (req, res) => {
    const { name, command, highlighted } = req.body as { name?: string; command?: string; highlighted?: boolean };
    if (highlighted !== undefined && typeof highlighted !== 'boolean') { res.status(400).json({ error: 'highlighted must be a boolean' }); return; }
    const patch: Parameters<typeof updateCommand>[1] = {};
    if (name !== undefined) patch.name = name;
    if (command !== undefined) patch.command = command;
    if (highlighted !== undefined) patch.highlighted = highlighted;
    res.json(await updateCommand(param(req, 'id'), patch));
  }));

  router.delete('/commands/:id', route(async (req, res) => {
    await deleteCommand(param(req, 'id'));
    res.status(204).end();
  }));

  /** The WorkflowRun a command-run body names, or undefined for the Project's own folder; answers 400 itself for a malformed id. */
  async function commandWorkflowRun(req: Request, res: Response): Promise<{ ok: true; run?: WorkflowRunRecord } | { ok: false }> {
    const parsed = optionalWorkflowRunId(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: 'workflowRunId must be a workflow run id' });
      return { ok: false };
    }
    return { ok: true, run: parsed.workflowRunId ? await workerManager.getWorkflowRun(parsed.workflowRunId) : undefined };
  }

  /** `{ workflowRunId }` runs it in that WorkflowRun's working copy instead of the Project's folder (a Quick look). */
  router.post('/commands/:id/run', route(async (req, res) => {
    const target = await commandWorkflowRun(req, res);
    if (!target.ok) return;
    res.status(201).json(await commandRunner.runCommand(param(req, 'id'), { workflowRun: target.run }));
  }));

  /** "Run a custom command and see the output right away" (docs/architecture.md's "Project Commands" decision) — a one-off shell command, never persisted as a ProjectCommand. See commandRunner.ts's runAdHocCommand. */
  router.post('/projects/:id/commands/run-adhoc', route(async (req, res) => {
    const project = await getProject(param(req, 'id'));
    const { command } = req.body as { command?: string };
    if (!command || !command.trim()) { res.status(400).json({ error: 'command is required' }); return; }
    const target = await commandWorkflowRun(req, res);
    if (!target.ok) return;
    res.status(201).json(await commandRunner.runAdHocCommand(project.id, command.trim(), { workflowRun: target.run }));
  }));

  /** `?status=running` narrows this to just currently-running runs — see commandRunner.ts's listCommandRuns doc comment for why; `?failureUnopened=true` to failed runs whose log nobody has opened yet. */
  router.get('/projects/:id/command-runs', route(async (req, res) => {
    await getProject(param(req, 'id')); // 404s if the project doesn't exist
    const { status, failureUnopened } = req.query as { status?: string; failureUnopened?: string };
    if (status !== undefined && !COMMAND_RUN_STATUSES.includes(status as CommandRunStatus)) {
      res.status(400).json({ error: `status must be one of ${COMMAND_RUN_STATUSES.join(', ')}` });
      return;
    }
    if (failureUnopened !== undefined && failureUnopened !== 'true') { res.status(400).json({ error: 'failureUnopened must be "true"' }); return; }
    res.json(await commandRunner.listCommandRuns(param(req, 'id'), status as CommandRunStatus | undefined, { failureUnopened: failureUnopened === 'true' }));
  }));

  router.get('/command-runs/:runId', route(async (req, res) => {
    res.json(await commandRunner.getCommandRun(param(req, 'runId')));
  }));

  /** Someone opened this run's log: its unopened failure (if any) is cleared — see `CommandRunRecord.failureUnopened`. */
  router.post('/command-runs/:runId/opened', route(async (req, res) => {
    res.json(await commandRunner.markCommandRunOpened(param(req, 'runId')));
  }));

  router.post('/command-runs/:runId/stop', route(async (req, res) => {
    res.json(await commandRunner.stopCommandRun(param(req, 'runId')));
  }));

  // ---- App update (task 7.001: idle-aware app updates) — see appUpdate/appUpdateService.ts ----

  router.get('/app-update', route(async (_req, res) => {
    res.json(await appUpdateService.getStatus());
  }));

  /** Always allowed — even in dev mode, even while held/updating — it only ever refreshes detection fields; `phase` is untouched. */
  router.post('/app-update/check', route(async (_req, res) => {
    res.json(await appUpdateService.checkNow());
  }));

  /** 201 on success (now updating, or now held); the error-mapping table below turns AppUpdateAlreadyInProgressError into 409 and AppUpdateNotApplicableError into 400. "Retry" after a failure is just this same route called again — no separate retry endpoint. */
  router.post('/app-update/apply', route(async (_req, res) => {
    res.status(201).json(appUpdateService.apply());
  }));

  /** Always 200 — a no-op returning the unchanged status when nothing is held (decided: not 409). */
  router.post('/app-update/cancel', route(async (_req, res) => {
    res.json(appUpdateService.cancel());
  }));

  // ---- Notifications (docs/milestones/milestone-5-notification-system.md) ----

  /** `?resolved=`/`?read=`/`?severity=`/`?projectId=` narrow the listing — the Notifications drawer's source data. Query-string booleans are the literal strings "true"/"false"; anything else (including omitted) means "no filter". `projectId=none` means one of the two project-less subjects (a skill install, or an app update). */
  router.get('/notifications', route(async (req, res) => {
    const { resolved, read, severity, projectId } = req.query as { resolved?: string; read?: string; severity?: string; projectId?: string };
    if (severity !== undefined && !NOTIFICATION_SEVERITIES.includes(severity as NotificationSeverity)) {
      res.status(400).json({ error: `severity must be one of ${NOTIFICATION_SEVERITIES.join(', ')}` }); return;
    }
    res.json(await listNotifications({
      resolved: resolved === 'true' ? true : resolved === 'false' ? false : undefined,
      read: read === 'true' ? true : read === 'false' ? false : undefined,
      severity: severity as NotificationSeverity | undefined,
      projectId,
    }));
  }));

  /** No auth, consistent with this app's local-only stance — for anything outside the daemon process itself (a future scheduled job, an external script) to report in, same as every existing producer's own direct `raiseNotification` call. */
  router.post('/notifications', route(async (req, res) => {
    const { kind, subject, title, description } = req.body as { kind?: string; subject?: unknown; title?: string; description?: string };
    if (!kind || !NOTIFICATION_KINDS.includes(kind as NotificationKind)) {
      res.status(400).json({ error: `kind must be one of ${NOTIFICATION_KINDS.join(', ')}` }); return;
    }
    const parsedSubject = parseNotificationSubject(subject);
    if (!parsedSubject) { res.status(400).json({ error: 'subject must be a valid NotificationSubject' }); return; }
    if (!title || !title.trim()) { res.status(400).json({ error: 'title is required' }); return; }
    if (!description || !description.trim()) { res.status(400).json({ error: 'description is required' }); return; }
    res.status(201).json(await raiseNotification({ kind: kind as NotificationKind, subject: parsedSubject, title: title.trim(), description: description.trim() }));
  }));

  /** `{ids}` marks exactly those ids read (an unknown id among them is ignored, not an error); `{subject}` marks every Notification matching that subject's identity read. Exactly one of the two is required. */
  router.post('/notifications/read', route(async (req, res) => {
    const { ids, subject } = req.body as { ids?: unknown; subject?: unknown };
    if (Array.isArray(ids)) {
      if (!ids.every((id) => typeof id === 'string')) { res.status(400).json({ error: 'ids must be an array of strings' }); return; }
      await markNotificationsRead(ids);
      res.status(204).end();
      return;
    }
    if (subject !== undefined) {
      const parsedSubject = parseNotificationSubject(subject);
      if (!parsedSubject) { res.status(400).json({ error: 'subject must be a valid NotificationSubject' }); return; }
      await markSubjectRead(parsedSubject);
      res.status(204).end();
      return;
    }
    res.status(400).json({ error: 'either ids or subject is required' });
  }));

  /** 404s for an unknown id (checked explicitly — the service's own `markNotificationUnread` is a forgiving no-op for internal callers, see its doc comment). */
  router.post('/notifications/:id/unread', route(async (req, res) => {
    await getNotification(param(req, 'id'));
    await markNotificationUnread(param(req, 'id'));
    res.status(204).end();
  }));

  /** Marks read only what matches the given filter (the drawer's current filters) — an empty/omitted body marks everything read. */
  router.post('/notifications/read-all', route(async (req, res) => {
    const { resolved, read, severity, projectId } = (req.body ?? {}) as { resolved?: boolean; read?: boolean; severity?: string; projectId?: string };
    if (severity !== undefined && !NOTIFICATION_SEVERITIES.includes(severity as NotificationSeverity)) {
      res.status(400).json({ error: `severity must be one of ${NOTIFICATION_SEVERITIES.join(', ')}` }); return;
    }
    await markAllRead({ resolved, read, severity: severity as NotificationSeverity | undefined, projectId });
    res.status(204).end();
  }));

  router.post('/projects/:id/chat', route(async (req, res) => {
    const { message, skipPlanning, executorId, autonomy } = req.body as { message?: string; skipPlanning?: boolean; executorId?: string; autonomy?: 'auto' | 'approval' };
    if (!message || !message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const task = await workerManager.startTask({
      projectId: param(req, 'id'),
      description: message.trim(),
      executorId,
      autonomy,
      kind: skipPlanning ? 'execute' : 'plan',
      ...(skipPlanning ? {} : { planningPurpose: 'plan-and-bugs' as const }),
    });
    if (task.kind === 'plan') planItemTitler.requestSessionTitle(task);
    res.status(201).json(task);
  }));

  // Starts a numbered plan-and-bugs session: an interactive, read-only CLI session that files tasks, bugs and their dependencies.
  // Without `executorId` (no coding agent available) the session is created with no CLI; its
  // description stays editable and `POST /tasks/:taskId/start-session` starts it later.
  router.post('/projects/:id/plan-and-bugs', route(async (req, res) => {
    const { description, executorId, autonomy } = req.body as { description?: unknown; executorId?: unknown; autonomy?: 'auto' | 'approval' };
    const text = sessionDescription(description, res);
    if (text === null) return;
    const task = await workerManager.startPlanAndBugsSession({
      projectId: param(req, 'id'),
      description: text,
      ...(typeof executorId === 'string' && executorId ? { executorId } : {}),
      autonomy,
    });
    if (!task.cliNotStarted) planItemTitler.requestSessionTitle(task);
    res.status(201).json(task);
  }));

  router.patch('/tasks/:taskId/description', route(async (req, res) => {
    const text = sessionDescription((req.body as { description?: unknown }).description, res);
    if (text !== null) res.json(await workerManager.updateDeferredSessionDescription(param(req, 'taskId'), text));
  }));

  router.post('/tasks/:taskId/start-session', route(async (req, res) => {
    const { executorId, autonomy } = req.body as { executorId?: unknown; autonomy?: 'auto' | 'approval' };
    if (typeof executorId !== 'string' || !executorId) { res.status(400).json({ error: 'executorId is required' }); return; }
    const task = await workerManager.launchDeferredSession(param(req, 'taskId'), { executorId, autonomy });
    planItemTitler.requestSessionTitle(task);
    res.status(201).json(task);
  }));

  router.get('/projects/:id/tasks', route(async (req, res) => {
    await getProject(param(req, 'id')); // 404s if the project doesn't exist
    res.json(await workerManager.listTasksForProject(param(req, 'id')));
  }));

  router.post('/projects/:id/tasks', route(async (req, res) => {
    const { description, templateId, skillIds, preloadSkillIds, executorId, autonomy } = req.body as {
      description?: string;
      templateId?: string;
      skillIds?: string[];
      preloadSkillIds?: string[];
      executorId?: string;
      autonomy?: 'auto' | 'approval';
    };
    if (!description || !description.trim()) {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (skillIds !== undefined && (!Array.isArray(skillIds) || skillIds.some((id) => typeof id !== 'string'))) {
      res.status(400).json({ error: 'skillIds must be an array of strings' });
      return;
    }
    const preloadProblem = preloadSkillsProblem(skillIds, preloadSkillIds);
    if (preloadProblem) {
      res.status(400).json({ error: preloadProblem });
      return;
    }
    const task = await workerManager.startTask({
      projectId: param(req, 'id'),
      description: description.trim(),
      templateId,
      skillIds,
      preloadSkillIds,
      executorId,
      autonomy,
    });
    res.status(201).json(task);
  }));

  router.get('/tasks/:taskId', route(async (req, res) => {
    res.json(await workerManager.getTask(param(req, 'taskId')));
  }));

  router.get('/tasks/:taskId/runtime', route(async (req, res) => {
    res.json(await workerManager.getTaskRuntime(param(req, 'taskId')));
  }));

  router.post('/cli-hooks', route(async (req, res) => {
    if (!authorizeCliToken(req, res)) return;
    const { taskId, event } = req.body as { taskId?: unknown; event?: unknown };
    if (typeof taskId !== 'string' || !event || typeof event !== 'object' || Array.isArray(event)) {
      res.status(400).json({ error: 'taskId and event are required' });
      return;
    }
    const hook = event as Record<string, unknown>;
    await workerManager.handleTerminalHook(taskId, hook);
    const { cliKind } = req.body as { cliKind?: unknown };
    if ((cliKind === 'claude-cli' || cliKind === 'codex-cli') && typeof hook.transcript_path === 'string') {
      const sessionKey = typeof hook.session_id === 'string' ? hook.session_id : hook.transcript_path;
      analytics.recordCliUsage({ taskId, kind: cliKind, sessionKey, sessionFile: hook.transcript_path }, USAGE_HOOK_EVENTS.includes(String(hook.hook_event_name)));
      void defaultExecutor.recheck().catch(() => undefined);
    }
    res.status(204).end();
  }));

  /**
   * The internal task-management API for planning sessions — see terminal/planTaskTool.ts. Every
   * call names its planning session with `?taskId=`, and only touches that session's own Project.
   */
  function planningTaskId(req: Request, res: Response): string | null {
    if (!authorizeCliToken(req, res)) return null;
    const { taskId } = req.query;
    if (typeof taskId === 'string' && taskId) return taskId;
    res.status(400).json({ error: 'taskId is required' });
    return null;
  }

  /** The task tools work on the caller's Project: through an Agent terminal session, or through the planning Task behind the call. */
  async function taskTools(sessionOrTaskId: string) {
    const agentProjectId = await agentSessions.projectIdOf(sessionOrTaskId);
    if (!agentProjectId) {
      return {
        list: () => workerManager.listPlanningTasks(sessionOrTaskId),
        create: (draft: PlanningTaskDraft) => workerManager.createPlanningTask(sessionOrTaskId, draft),
        update: (itemId: string, patch: PlanningTaskPatch) => workerManager.updatePlanningTask(sessionOrTaskId, itemId, patch),
        remove: (itemId: string) => workerManager.deletePlanningTask(sessionOrTaskId, itemId),
      };
    }
    return {
      list: () => listPlanItems(agentProjectId),
      create: (draft: PlanningTaskDraft) => workerManager.createProjectTask(agentProjectId, draft),
      update: (itemId: string, patch: PlanningTaskPatch) => workerManager.updateProjectTask(agentProjectId, itemId, patch),
      remove: (itemId: string) => workerManager.deleteProjectTask(agentProjectId, itemId),
    };
  }

  router.get('/agent-tasks', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (taskId) res.json(await (await taskTools(taskId)).list());
  }));

  router.post('/agent-tasks', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (!taskId) return;
    const { title, description } = req.body as { title?: unknown; description?: unknown };
    if (typeof title !== 'string' || !title.trim() || typeof description !== 'string') {
      res.status(400).json({ error: 'a non-empty title and a description are required' });
      return;
    }
    res.status(201).json(await (await taskTools(taskId)).create({ title: title.trim(), description: description.trim() }));
  }));

  router.patch('/agent-tasks/:itemId', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (!taskId) return;
    const { title, description, uiPlanningWaitsForParent } = req.body as { title?: unknown; description?: unknown; uiPlanningWaitsForParent?: unknown };
    const titleOk = title === undefined || (typeof title === 'string' && !!title.trim());
    const descriptionOk = description === undefined || typeof description === 'string';
    const waitsOk = uiPlanningWaitsForParent === undefined || parseUiPlanningWaits(uiPlanningWaitsForParent) !== null;
    if (!titleOk || !descriptionOk || !waitsOk || (title === undefined && description === undefined && uiPlanningWaitsForParent === undefined)) {
      res.status(400).json({ error: 'give a non-empty title, a description and/or uiPlanningWaitsForParent (true or false) to change' });
      return;
    }
    res.json(await (await taskTools(taskId)).update(param(req, 'itemId'), {
      ...(typeof title === 'string' ? { title: title.trim() } : {}),
      ...(typeof description === 'string' ? { description: description.trim() } : {}),
      ...(typeof uiPlanningWaitsForParent === 'boolean' ? { uiPlanningWaitsForParent } : {}),
    }));
  }));

  router.delete('/agent-tasks/:itemId', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (!taskId) return;
    await (await taskTools(taskId)).remove(param(req, 'itemId'));
    res.status(204).end();
  }));

  // The bug-filing API for bug report sessions — see terminal/bugReportTool.ts. Every call names its
  // session with `?taskId=`: only a running bug report session may use it, in its own Project, and it
  // may only change bugs it filed that have not started.
  router.get('/agent-bugs', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (taskId) res.json(await workerManager.listBugReportTasks(taskId));
  }));

  router.post('/agent-bugs', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (taskId) res.status(201).json(await workerManager.createReportedBug(taskId, parseBugReport(req.body)));
  }));

  router.patch('/agent-bugs/:itemId', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (taskId) res.json(await workerManager.updateReportedBug(taskId, param(req, 'itemId'), parseBugReportPatch(req.body)));
  }));

  router.delete('/agent-bugs/:itemId', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (!taskId) return;
    await workerManager.deleteReportedBug(taskId, param(req, 'itemId'));
    res.status(204).end();
  }));

  // A plan-and-bugs session sets the parents of a task or bug it filed that has not started (see terminal/bugReportTool.ts).
  router.put('/agent-bugs/:itemId/dependencies', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (!taskId) return;
    const body = (req.body ?? {}) as { dependsOn?: unknown; uiPlanningWaitsForParent?: unknown };
    // Optional "UI planning waits for parent", saved with the parents in one write; omitted keeps the stored value.
    if (body.uiPlanningWaitsForParent !== undefined && parseUiPlanningWaits(body.uiPlanningWaitsForParent) === null) {
      res.status(400).json({ error: 'uiPlanningWaitsForParent must be true or false' });
      return;
    }
    const { projectId, dependsOn } = await workerManager.checkedSessionDependencies(taskId, param(req, 'itemId'), body.dependsOn);
    res.json(await dependencies.setDependencies(projectId, param(req, 'itemId'), dependsOn, { requireEligibleParents: true, uiPlanningWaitsForParent: body.uiPlanningWaitsForParent }));
  }));

  // A report session reopens a completed bug of its Project as round 2 and starts it at once.
  router.post('/agent-bugs/:itemId/reopen', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (!taskId) return;
    const result = await workerManager.reopenBugAsSession(taskId, param(req, 'itemId'), parseRegressionBody(req.body));
    res.status(201).json(result);
  }));

  // The task half of the same API: a report session files tasks (never started) for work that is
  // new capability or improvement rather than a defect, and may change or withdraw its own until they start.
  router.post('/agent-bugs/tasks', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (!taskId) return;
    const draft = parseReportedTask(req.body);
    const item = await workerManager.createReportedTask(taskId, draft);
    if (!draft.title) planItemTitler.requestTitle(item);
    res.status(201).json(item);
  }));

  router.patch('/agent-bugs/tasks/:itemId', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (taskId) res.json(await workerManager.updateReportedTask(taskId, param(req, 'itemId'), parseReportedTaskPatch(req.body)));
  }));

  router.delete('/agent-bugs/tasks/:itemId', route(async (req, res) => {
    const taskId = planningTaskId(req, res);
    if (!taskId) return;
    await workerManager.deleteReportedTask(taskId, param(req, 'itemId'));
    res.status(204).end();
  }));

  router.get('/tasks/:taskId/transcript', route(async (req, res) => {
    const context = await workerManager.getTaskTranscript(param(req, 'taskId'));
    if (!context) {
      res.status(404).json({ error: `No transcript for task "${param(req, 'taskId')}"` });
      return;
    }
    res.json(context);
  }));

  router.post('/tasks/:taskId/answer', route(async (req, res) => {
    const { answer } = req.body as { answer?: string };
    if (!answer || !answer.trim()) {
      res.status(400).json({ error: 'answer is required' });
      return;
    }
    res.json(await workerManager.answerTask(param(req, 'taskId'), answer.trim()));
  }));

  router.post('/tasks/:taskId/followup', route(async (req, res) => {
    const { instruction } = req.body as { instruction?: string };
    if (!instruction || !instruction.trim()) {
      res.status(400).json({ error: 'instruction is required' });
      return;
    }
    res.status(201).json(await workerManager.followUpTask(param(req, 'taskId'), instruction.trim()));
  }));

  router.post('/tasks/:taskId/resume', route(async (req, res) => {
    res.status(201).json(await workerManager.resumeTerminalTask(param(req, 'taskId')));
  }));

  router.get('/tasks/:taskId/reopen-session/options', route(async (req, res) => {
    res.json(await workerManager.stepReopenOptions(param(req, 'taskId')));
  }));

  // Reopens a settled workflow step's CLI conversation without changing its run status.
  router.post('/tasks/:taskId/reopen-session', route(async (req, res) => {
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== undefined && mode !== 'permissions' && mode !== 'read-only') { res.status(400).json({ error: 'mode must be permissions or read-only' }); return; }
    res.status(201).json(await workerManager.reopenStepSession(param(req, 'taskId'), mode as 'permissions' | 'read-only' | undefined));
  }));

  router.post('/workflow-runs/:id/reopen-changes', route(async (req, res) => {
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (decision !== 'commit-push' && decision !== 'discard') { res.status(400).json({ error: 'decision must be commit-push or discard' }); return; }
    res.json(await workerManager.resolveStepInspectChanges(param(req, 'id'), decision));
  }));

  // Stops a session reopened above.
  router.delete('/tasks/:taskId/reopen-session', route(async (req, res) => {
    await workerManager.closeStepSession(param(req, 'taskId'));
    res.status(204).end();
  }));

  router.post('/tasks/:taskId/complete', route(async (req, res) => {
    res.status(201).json(await workerManager.completeTerminalTask(param(req, 'taskId')));
  }));

  router.post('/tasks/:taskId/interim-commit', route(async (req, res) => {
    res.json(await workerManager.interimCommitTask(param(req, 'taskId')));
  }));

  router.patch('/tasks/:taskId/archive', route(async (req, res) => {
    if (typeof req.body.archived !== 'boolean') { res.status(400).json({ error: 'archived must be a boolean' }); return; }
    await workerManager.archiveSession(param(req, 'taskId'), req.body.archived);
    res.status(204).end();
  }));

  router.post('/tasks/:taskId/planning-complete', route(async (req, res) => {
    await workerManager.completePlanningSession(param(req, 'taskId'));
    res.status(204).end();
  }));

  router.patch('/tasks/:taskId/title', route(async (req, res) => {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    if (title.length > TITLE_MAX_LENGTH) { res.status(400).json({ error: `title must be at most ${TITLE_MAX_LENGTH} characters` }); return; }
    await workerManager.renameSession(param(req, 'taskId'), title);
    res.status(204).end();
  }));

  router.delete('/tasks/:taskId/session', route(async (req, res) => {
    await workerManager.deleteSession(param(req, 'taskId'));
    res.status(204).end();
  }));

  router.post('/tasks/:taskId/stop' , route(async (req, res) => {
    res.json(await workerManager.stopTask(param(req, 'taskId')));
  }));

  router.use(errorHandler);
  return router;
}

/** A pull request number from the path: a positive integer, or a 400 (answered here) for anything else, before any `git` or `gh` runs. */
function isDistinctIdList(ids: unknown): ids is string[] {
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string') && new Set(ids).size === ids.length;
}

const PLANNING_QUEUE_ENTRY_KINDS = ['session', 'task', 'reference'];

function isPlanningQueueEntry(entry: unknown): entry is PlanningQueueEntryRef {
  const { kind, id } = (entry && typeof entry === 'object' ? entry : {}) as { kind?: unknown; id?: unknown };
  return PLANNING_QUEUE_ENTRY_KINDS.includes(kind as string) && typeof id === 'string';
}

/** A bug report session's description, trimmed: required and within the bug description limit. Answers 400 and returns null otherwise. */
function sessionDescription(value: unknown, res: Response): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) { res.status(400).json({ error: 'description is required' }); return null; }
  if (text.length > BUG_LIMITS.description) {
    res.status(400).json({ error: `description must be at most ${BUG_LIMITS.description.toLocaleString('en-US')} characters` });
    return null;
  }
  return text;
}

function pullRequestNumber(req: Request, res: Response): number | null {
  const raw = param(req, 'number');
  if (/^[1-9]\d{0,9}$/.test(raw)) return Number(raw);
  res.status(400).json({ error: 'The pull request number must be a positive whole number' });
  return null;
}

const STATUS_BY_ERROR = new Map<Function, number>([
  [GitError, 409],
  [GithubAccountError, 409],
  [IdentityValidationError, 400],
  [UnknownAccountError, 400],
  [UnknownBuildingTypeError, 400],
  [BuildingReadOnlyError, 409],
  [NoStorageError, 404],
  [StorageCrashError, 503],
  [ProjectNotFoundError, 404],
  [InvalidPlotError, 400],
  [InvalidProjectNameError, 400],
  [PlotTakenError, 409],
  [TaskNotFoundError, 404],
  [ExecutorNotFoundError, 404],
  [DefaultExecutorNotFoundError, 404],
  [DefaultExecutorUnavailableError, 409],
  [AnalyticsAgentNotFoundError, 404],
  [AnalyticsRangeError, 400],
  [PlanItemNotFoundError, 404],
  [AutoMergeUnavailableError, 409],
  [AutoMergeNotRetryableError, 409],
  [DependencyInvalidError, 400],
  [DependencyConflictError, 409],
  [ProjectFolderBusyError, 409],
  [BranchRequiresRepositoryError, 400],
  [ProjectHasActiveTaskError, 409],
  [TaskConflictError, 409],
  [TaskLimitReachedError, 409],
  [PlanItemQueueEntryNotFoundError, 404],
  [SessionStillRunningError, 409],
  [TaskNotBlockedError, 409],
  [TaskNotFollowableError, 409],
  [PlanningSessionArchivedError, 409],
  [TaskNotPausedError, 409],
  [TaskNotInterimCommittableError, 409],
  [TaskNotTerminalError, 409],
  [TaskNotPlanningSessionError, 409],
  [PlanningQueueConflictError, 409],
  [BugGroupConflictError, 409],
  [BugValidationError, 400],
  [StepNoteValidationError, 400],
  [BugIntroducerNotStartedError, 400],
  [BugStartedError, 409],
  [BugNotCompletedError, 409],
  [RegressionNotBugError, 409],
  [ReportedTaskStartedError, 409],
  [ReportedItemKindError, 409],
  [BugNotPlanningTaskError, 409],
  [TaskNotBugReportSessionError, 409],
  [TaskNotBugFilingSessionError, 409],
  [SessionAlreadyStartedError, 409],
  [TaskNotTestingSessionError, 409],
  [TerminalSessionNotResumableError, 409],
  [StepInspectSessionError, 409],
  [PlanItemCompletedError, 409],
  [PlanItemHasActiveTaskError, 409],
  [PlanItemNotCompletableError, 409],
  [EntryExistsError, 409],
  [InvalidEntryPathError, 400],
  [LastExecutorError, 409],
  [ExecutorNotSupportedError, 422],
  [PlanningRequiresCliError, 422],
  [TemplateDisabledError, 422],
  [SkillDisabledError, 422],
  [InvalidPlanDocKeyError, 400],
  [UnknownPlanDocumentError, 404],
  [PathTraversalError, 400],
  [NotAFileError, 400],
  [CommandNotFoundError, 404],
  [CommandHighlightLimitError, 400],
  [CommandAlreadyRunningError, 409],
  [CommandRunNotFoundError, 404],
  [WorkingCopyRemovedError, 410],
  [RunOutsideProjectError, 400],
  [GitPathRefusedError, 400],
  [NoRepositoryDiffError, 409],
  [NotAChangedFileError, 404],
  [AgentNotFoundError, 404],
  [AgentAlreadyExistsError, 409],
  [InvalidAgentFileError, 400],
  [SkillNotFoundError, 404],
  [SkillAlreadyExistsError, 409],
  [InvalidSkillFileError, 400],
  [InvalidIdError, 400],
  [CatalogPathTraversalError, 400],
  [InvalidZipError, 400],
  [ZipSlipError, 400],
  [InvalidRepoSlugError, 400],
  [SkillInstallNotFoundError, 404],
  [NotificationNotFoundError, 404],
  [WorkflowNotFoundError, 404],
  [WorkflowAlreadyExistsError, 409],
  [InvalidWorkflowError, 400],
  [InvalidStepSelectionError, 400],
  [NoWorkflowAvailableError, 409],
  [WorkflowRunNotFoundError, 404],
  [WorkflowRunNotActionableError, 409],
  [TaskNotWorkflowStepError, 401],
  [TestingSetupApprovalError, 409],
  [TestingSetupStepRefusedError, 422],
  [StepOutputRequiredError, 422],
  [TestRunNotFoundError, 404],
  [TestActionNotFoundError, 404],
  [TestRunTaskError, 404],
  [TestingConfigUnavailableError, 409],
  [TestActionDisabledError, 409],
  [TestRunAlreadyActiveError, 409],
  [NoRunnableSuitesError, 409],
  [TestRunNotQueuedError, 409],
  [TestRunNotRunningError, 409],
  [AppUpdateAlreadyInProgressError, 409],
  [AppUpdateNotApplicableError, 400],
  [NoLinkedRepositoryError, 400],
  [GitProviderError, 502],
  [PullRequestNotFoundError, 404],
  [PullRequestHeadGoneError, 409],
  [PullRequestBusyError, 409],
  [PullRequestNotMergeableError, 409],
  [PullRequestNotOpenError, 409],
  [PullRequestBranchDivergedError, 409],
  [NoPullRequestCheckoutError, 409],
  [ConflictAgentRequiredError, 400],
  [StepNotSkippableError, 422],
]);

/** Requests from a CLI session the daemon launched carry its per-daemon token; anything else is refused with a 401. */
function authorizeCliToken(req: Request, res: Response): boolean {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (validCliHookToken(token)) return true;
  res.status(401).json({ error: 'Invalid CLI hook token' });
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  const status = STATUS_BY_ERROR.get(err.constructor) ?? (err as { status?: number }).status ?? 500;
  if (status === 500) console.error(err);
  const { code, details } = err as Partial<ConflictBody>;
  const field = err instanceof ContentInputError || err instanceof InvalidProjectNameError ? err.field : undefined;
  res.status(status).json({ error: err.message, ...(code ? { code, details } : {}), ...(field ? { field } : {}) });
}
