import { CITY_POSITION, nearestFreePlot } from '../scene/townLayout';
import { canDrop, plotOfSlot, repairPositions, type SlotRef } from '../lib/townGroups';
import { create } from 'zustand';
import { isUsageLimitEvent } from '../lib/agentActivity';
import { ApiError, serverApi } from '../lib/serverApi';
import { resolveCardDetail } from '../lib/footerPopovers';
import { mergeRunningLoad, mergeUnopenedLoad, omitKey } from '../lib/runningCommands';
import type { CardDetail } from '../lib/taskBoard';
import { dayRange, startOfLocalDay, type RefreshPhase } from '../lib/agentAnalytics';
import { sortedQueue } from '../lib/waitingList';
import type { ActivityTarget, LiveTerminalSession, PlanItemQueueEntry, AgentDayView, AgentStepsView, AnalyticsAgent, ContentJobDto, SeoJobDto } from '../lib/serverApi';
import type { SeoTab } from '../lib/seoWorkspace';
import { readViewMode, writeViewMode, type ViewMode } from '../lib/viewModePreference';
import { readReviewedTaskIds, writeReviewedTaskIds } from '../lib/reviewedTasks';
import type {
  AppUpdatePhase,
  AppUpdateStatus,
  Autonomy,
  CatalogAgent,
  CatalogSkill,
  CommandInput,
  CommandRun,
  CreateCatalogAgentInput,
  CreateCatalogSkillInput,
  ExecutePlanItemOptions,
  ExecutorInput,
  ExecutorProfile,
  PlanItem,
  NotificationSeverity,
  NotificationSubject,
  PlanItemDraft,
  PlanItemPatch,
  ProjectCommand,
  ProjectSyncState,
  ServerNotification,
  ServerProject,
  ServerTask,
  SkillInstallRun,
  TaskTurn,
  TestingSetupStartResult,
  TestRun,
  TestRunDetail,
  UpdateCatalogAgentInput,
  UpdateCatalogSkillInput,
  UpdateWorkflowInput,
  UploadCatalogAgentInput,
  UploadCatalogSkillInput,
  WorkerEvent,
  WorkflowInput,
  WorkflowRecord,
  WorkflowRunDetail,
  WorkflowRunRecord,
} from '../lib/serverApi';
import { isAttention, matchesNotificationFilter, quickActionFor, sameSubjectIdentity } from '../lib/notificationCenter';
import type { NotificationApiFilter } from '../lib/notificationCenter';
import { addErrorNotification, errorMessage, routeError, setErrorNotificationsRead } from '../lib/errorNotifications';
import type { DrawerNotification, ErrorContext, ErrorNotification, ErrorScope } from '../lib/errorNotifications';
import type { AutoMergeData, PlanItemData, ProjectData, TaskData } from '../types';
import { createErrorFor } from '../lib/buildingTypes';
import type { ServerBuildingType } from '../lib/buildingTypes';
import { readBugAttributes, readRelatedBug } from '../lib/bugs';
import { startsWhenReady } from '../lib/dependencies';
import type { BugInfoStatus } from '../lib/bugs';
import { gitProviderOf } from '../lib/gitProvider';
import type { AccountCheck, GithubAccountsResult } from '../lib/githubAccounts';
import type { GitProviderId } from '../lib/gitProvider';
import { EMPTY_PR_ACTIONS, applyMergeStateResponse, mergeNotice, mergeStatesToLoad, without } from '../lib/pullRequestActions';
import type { MergeRequestOptions, MergeResponse, MergeStateResponse, PrActionState } from '../lib/pullRequestActions';
import { prReadings } from '../lib/pullRequestReadings';
import type { PullRequest } from '../lib/pullRequests';
import type { SettingsSection } from '../lib/settingsSections';
import { normalizeWorkspaceTab } from '../lib/workspaceLayout';
import type { WorkspaceTab } from '../lib/workspaceLayout';
import { createConnectionsSlice } from './connectionsStore';
import type { ConnectionsState } from './connectionsStore';
import { createSchedulesSlice, mergeScheduleEvent } from './schedulesStore';
import { createAgentSessionsSlice, mergeAgentSessionStoreEvent } from './agentSessionsStore';
import type { AgentSessionsState } from './agentSessionsStore';
import type { SchedulesState } from './schedulesStore';
import { useContentStore } from './contentStore';

export type { WorkspaceTab };

/**
 * `sync` defaults to whatever the caller already knew (`previousSync`) when
 * the incoming ServerProject doesn't carry one — true for every 'project'
 * WorkerEvent, which comes from workerManager.ts and never attaches a sync
 * reading (only the REST GET /api/projects[/:id] responses and 'projectSync'
 * WorkerEvents do). Without that fallback, an ordinary status change (a Task
 * starting, say) would silently blank out the last-known sync reading.
 */
function toProjectData(project: ServerProject, position: [number, number], previousSync: ProjectSyncState | null = null): ProjectData {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    repositoryUrl: project.repositoryUrl,
    position,
    status: project.status,
    activeTaskId: project.activeTaskId,
    taskCount: project.taskCount,
    sync: project.sync !== undefined ? project.sync : previousSync,
    workflowId: project.workflowId,
    autoPullEnabled: project.autoPullEnabled,
    gitProvider: project.gitProvider,
    githubAccount: project.githubAccount ?? null,
    prCheckout: project.prCheckout ?? null,
    typeId: project.typeId,
    typeVersion: project.typeVersion,
    typeUnavailable: project.typeUnavailable ?? false,
    readOnly: project.readOnly ?? false,
    readOnlyReason: project.readOnlyReason ?? null,
  };
}

function toTaskData(task: ServerTask): TaskData {
  return {
    id: task.id,
    projectId: task.projectId,
    executorId: task.executorId,
    executionMode: task.executionMode ?? 'structured',
    branch: task.branch,
    worktreePath: task.worktreePath,
    description: task.description,
    status: task.status,
    autonomy: task.autonomy,
    kind: task.kind,
    conversationId: task.conversationId,
    archived: task.archived,
    sessionId: task.sessionId,
    runtimeStatus: task.runtimeStatus,
    runtimeWaitingReason: task.runtimeWaitingReason,
    runtimeStatusChangedAt: task.runtimeStatusChangedAt,
    planItemId: task.planItemId,
    planningSessionNumber: task.planningSessionNumber,
    planningQueueOrder: task.planningQueueOrder,
    planningCompletedAt: task.planningCompletedAt,
    planningCreatedTaskCount: task.planningCreatedTaskCount,
    planningAutoCompleteArmed: task.planningAutoCompleteArmed,
    ...(task.planningPurpose ? { planningPurpose: task.planningPurpose } : {}),
    ...(task.cliNotStarted ? { cliNotStarted: true } : {}),
    title: task.title,
    blockedQuestion: task.blockedQuestion,
    failureReason: task.failureReason,
    tokenUsage: task.tokenUsage,
    workflowRunId: task.workflowRunId,
    workflowStepId: task.workflowStepId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  };
}

/** Adds a start the daemon put on its Project's waiting list; a live 'planItemQueue' event may already have listed it. */
function queueEntryJoined(set: (partial: Partial<WorldState> | ((state: WorldState) => Partial<WorldState>)) => void, entry: PlanItemQueueEntry): void {
  set((state) => {
    const held = state.planItemQueueByProject[entry.projectId] ?? [];
    if (held.some((existing) => existing.id === entry.id)) return {};
    return { planItemQueueByProject: { ...state.planItemQueueByProject, [entry.projectId]: sortedQueue([...held, entry]) } };
  });
}

/** Puts a plan item the daemon returned into the project's loaded plan. */
function reconcileSavedItem(set: (partial: Partial<WorldState> | ((state: WorldState) => Partial<WorldState>)) => void, projectId: string, saved: PlanItem): void {
  set((state) => {
    const plan = state.planByProject[projectId];
    return plan ? { planByProject: { ...state.planByProject, [projectId]: { ...plan, items: reconcilePlanItem(plan.items, toPlanItemData(saved)) } } } : {};
  });
}

/** What the toggle shows before the daemon answers: the stored record flipped, or a fresh "on, waiting" one. */
export function autoMergeSwitched(previous: AutoMergeData | undefined, enabled: boolean): AutoMergeData {
  const now = new Date().toISOString();
  return previous ? { ...previous, enabled } : { enabled, state: 'waiting', reasons: [], warnings: [], prNumber: null, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: now };
}

function toPlanItemData(item: PlanItem): PlanItemData {
  const relatedBug = readRelatedBug(item.relatedBug);
  return {
    id: item.id,
    projectId: item.projectId,
    title: item.title,
    description: item.description,
    status: item.status,
    ...(item.type === 'bug' ? { type: 'bug' as const, bug: readBugAttributes(item.bug) } : {}),
    ...(relatedBug ? { relatedBug } : {}),
    ...(item.reportSessionNumber ? { reportSessionNumber: item.reportSessionNumber } : {}),
    order: item.order,
    planningQueueOrder: item.planningQueueOrder,
    planningGroupOrder: item.planningGroupOrder,
    taskIds: item.taskIds,
    executorId: item.executorId ?? null,
    planningTaskId: item.planningTaskId,
    planningRef: item.planningRef,
    workflowRunId: item.workflowRunId,
    ...(item.testingSetup ? { testingSetup: item.testingSetup } : {}),
    ...(item.prConflict ? { prConflict: item.prConflict } : {}),
    ...(item.autoMerge ? { autoMerge: item.autoMerge } : {}),
    ...(item.pullRequest ? { pullRequest: item.pullRequest } : {}),
    ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
    ...(item.waiting ? { waiting: item.waiting } : {}),
    ...(item.uiPlanningWaitsForParent !== undefined ? { uiPlanningWaitsForParent: item.uiPlanningWaitsForParent } : {}),
    archived: item.archived,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** One project's Tasks-breakdown items, as tracked client-side — see `loadPlan`. */
export interface ProjectPlanState {
  items: PlanItemData[];
}

type PlanLiveEvent = Extract<WorkerEvent, { type: 'planItem' | 'planItemDeleted' }>;
type TaskLiveEvent = Extract<WorkerEvent, { type: 'task' | 'taskDeleted' }>;

/**
 * Pure merge of one live WorkerEvent into the relevant slice of state —
 * pulled out of connectLiveUpdates so it's testable without a real
 * WebSocket. An unknown project id is appended (another client/tab could
 * have created it); a known one is updated in place.
 *
 * `lastTaskIdByProject` is tracked separately from a project's own
 * `activeTaskId` (which the server clears back to null the moment a Task
 * finishes, succeeds or fails) specifically so the UI can still show *how*
 * the most recent Task ended — e.g. a failure — even once the project has
 * gone back to 'idle' and looks, at the project level alone, like nothing
 * happened.
 */
/**
 * A running job is stored; an ended one is removed and remembered as settled, so a progress event or a snapshot that arrives late
 * cannot bring its row back.
 */
function mergeJob<J extends { id: string; status: string }>(jobs: Record<string, J>, settled: Record<string, true>, job: J): { jobs: Record<string, J>; settled: Record<string, true> } | null {
  if (job.status === 'running') return settled[job.id] ? null : { jobs: { ...jobs, [job.id]: job }, settled };
  return { jobs: omitKey(jobs, job.id), settled: { ...settled, [job.id]: true } };
}

export function mergeSeoJobEvent(jobs: Record<string, SeoJobDto>, settled: Record<string, true>, job: SeoJobDto): Partial<WorldState> {
  const next = mergeJob(jobs, settled, job);
  return next ? { seoJobsById: next.jobs, settledSeoJobIds: next.settled } : {};
}

/** The same rule for Content Studio jobs (Remotion setup, video renders). */
export function mergeContentJobEvent(jobs: Record<string, ContentJobDto>, settled: Record<string, true>, job: ContentJobDto): Partial<WorldState> {
  const next = mergeJob(jobs, settled, job);
  return next ? { contentJobsById: next.jobs, settledContentJobIds: next.settled } : {};
}

type ProjectScopedState = Pick<WorldState, 'projects' | 'tasksById' | 'taskIdsByProject' | 'lastTaskIdByProject' | 'planByProject' | 'notificationsById' | 'workflowRunsByProject' | 'commandRunIdsByProject' | 'selectedId' | 'workspaceProjectId'> & Partial<Pick<WorldState, 'planItemQueueByProject' | 'schedulesByProject' | 'agentSessionsByProject' | 'taskLiveChangesByProject'>>;

const withoutKey = <T,>(record: Record<string, T> | undefined, key: string): Record<string, T> | undefined => {
  if (!record || !(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/** Drops a deleted Project and everything the store holds for it, and closes its popups. Used by the delete action and by the `projectDeleted` event, which can arrive in either order. */
export function removeProjectFromState(state: ProjectScopedState, projectId: string): Partial<WorldState> {
  const taskIds = new Set(state.taskIdsByProject[projectId] ?? []);
  const tasksById = Object.fromEntries(Object.entries(state.tasksById).filter(([id, task]) => !taskIds.has(id) && task.projectId !== projectId));
  const notificationsById = Object.fromEntries(Object.entries(state.notificationsById).filter(([, n]) => n.projectId !== projectId));
  return {
    projects: state.projects.filter((p) => p.id !== projectId),
    tasksById,
    notificationsById,
    taskIdsByProject: withoutKey(state.taskIdsByProject, projectId),
    lastTaskIdByProject: withoutKey(state.lastTaskIdByProject, projectId),
    planByProject: withoutKey(state.planByProject, projectId),
    workflowRunsByProject: withoutKey(state.workflowRunsByProject, projectId),
    commandRunIdsByProject: withoutKey(state.commandRunIdsByProject, projectId),
    planItemQueueByProject: withoutKey(state.planItemQueueByProject, projectId),
    schedulesByProject: withoutKey(state.schedulesByProject, projectId),
    agentSessionsByProject: withoutKey(state.agentSessionsByProject, projectId),
    taskLiveChangesByProject: withoutKey(state.taskLiveChangesByProject, projectId),
    selectedId: state.selectedId === projectId ? null : state.selectedId,
    workspaceProjectId: state.workspaceProjectId === projectId ? null : state.workspaceProjectId,
  } as Partial<WorldState>;
}

export function mergeWorkerEvent(
  state: Pick<WorldState, 'projects' | 'tasksById' | 'taskIdsByProject' | 'lastTaskIdByProject' | 'transcriptsByTask' | 'planByProject' | 'commandRunsById' | 'commandRunIdsByProject' | 'catalogInstallRuns' | 'notificationsById' | 'workflowRunsByProject' | 'workflowRunDetails' | 'testRunsById' | 'testRunDetailsById' | 'testRunLogsById' | 'errorNotificationsById' | 'errorNotificationSeq'> & Partial<Pick<WorldState, 'planLiveRevisionByProject' | 'planLiveChangesByProject' | 'taskLiveRevisionByProject' | 'taskLiveChangesByProject' | 'schedulesByProject' | 'scheduleHistoryByJob' | 'agentSessionsByProject' | 'executors' | 'seoJobsById' | 'settledSeoJobIds' | 'contentJobsById' | 'settledContentJobIds' | 'planItemQueueByProject' | 'liveTerminalSessions'>> & Partial<Pick<WorldState, 'selectedId' | 'workspaceProjectId'>>,
  event: WorkerEvent,
): Partial<WorldState> {
  if (event.type === 'projectDeleted') {
    if (!state.projects.some((p) => p.id === event.projectId)) return {};
    return removeProjectFromState({ selectedId: null, workspaceProjectId: null, ...state }, event.projectId);
  }
  if (event.type === 'planningCompletionError') {
    const { created: _created, ...patch } = addErrorNotification(
      state,
      `Could not complete planning session ${event.session}: ${event.message}`,
      { projectId: event.projectId, title: 'Planning session failed' },
      new Date(),
    );
    return patch;
  }
  if (event.type === 'notification') {
    return { notificationsById: { ...state.notificationsById, [event.notification.id]: event.notification } };
  }
  if (event.type === 'terminalSessions') return { liveTerminalSessions: event.sessions };
  if (event.type === 'appUpdate') {
    return { appUpdate: event.status, lastKnownAppUpdatePhase: event.status.phase };
  }
  if (event.type === 'executors.default_changed') {
    return { executors: applyDefaultExecutor(state.executors ?? [], event.defaultExecutorId) };
  }
  if (event.type === 'schedules' || event.type === 'scheduleEntry') return mergeScheduleEvent(state, event);
  if (event.type === 'agentSession' || event.type === 'agentSessionDeleted') return mergeAgentSessionStoreEvent(state, event);
  // A Content Studio pane or Remotion Studio change belongs to the content store (see connectLiveUpdates), not to this one.
  if (event.type === 'studioAsset' || event.type === 'contentRetro' || event.type === 'contentImportSession' || event.type === 'remotionStudio') return {};
  if (event.type === 'seoJob') return mergeSeoJobEvent(state.seoJobsById ?? {}, state.settledSeoJobIds ?? {}, event.job);
  if (event.type === 'contentJob') return mergeContentJobEvent(state.contentJobsById ?? {}, state.settledContentJobIds ?? {}, event.job);
  if (event.type === 'testRun') {
    const existingDetail = state.testRunDetailsById[event.run.id];
    return {
      testRunsById: { ...state.testRunsById, [event.run.id]: event.run },
      // Patches the detail view's status/summary/diagnostics live, without discarding its already-fetched log/result (only a fresh loadTestRunDetail call replaces those).
      ...(existingDetail ? { testRunDetailsById: { ...state.testRunDetailsById, [event.run.id]: { ...existingDetail, ...event.run } } } : {}),
    };
  }
  if (event.type === 'testRunRemoved') {
    if (!state.testRunsById[event.runId] && !state.testRunDetailsById[event.runId] && !(event.runId in state.testRunLogsById)) return {};
    const { [event.runId]: _removedRun, ...testRunsById } = state.testRunsById;
    const { [event.runId]: _removedDetail, ...testRunDetailsById } = state.testRunDetailsById;
    const { [event.runId]: _removedLog, ...testRunLogsById } = state.testRunLogsById;
    return { testRunsById, testRunDetailsById, testRunLogsById };
  }
  if (event.type === 'testRunLog') {
    // A chunk for a run this session never fetched detail for (e.g. a WS reconnect gap) has nothing to append to — the next loadTestRunDetail call picks up the full output fresh.
    if (!(event.runId in state.testRunLogsById)) return {};
    return { testRunLogsById: { ...state.testRunLogsById, [event.runId]: state.testRunLogsById[event.runId] + event.chunk } };
  }
  if (event.type === 'skillInstall') {
    return { catalogInstallRuns: { ...state.catalogInstallRuns, [event.run.id]: event.run } };
  }
  if (event.type === 'skillInstallLog') {
    const run = state.catalogInstallRuns[event.runId];
    // A log chunk for a run this session never saw start (e.g. a WS reconnect gap) has nothing to
    // append to — the next getCatalogSkillInstallRun call picks up the full output fresh.
    if (!run) return {};
    return { catalogInstallRuns: { ...state.catalogInstallRuns, [event.runId]: { ...run, output: run.output + event.chunk } } };
  }
  if (event.type === 'commandRun') {
    const isNew = !state.commandRunsById[event.run.id];
    return {
      commandRunsById: { ...state.commandRunsById, [event.run.id]: event.run },
      // Only prepend if this project's history was ever loaded (loadCommandRuns) — otherwise
      // there's no list to keep consistent, and the next loadCommandRuns() call fetches it fresh.
      commandRunIdsByProject: isNew && state.commandRunIdsByProject[event.run.projectId]
        ? { ...state.commandRunIdsByProject, [event.run.projectId]: [event.run.id, ...state.commandRunIdsByProject[event.run.projectId]!] }
        : state.commandRunIdsByProject,
    };
  }
  if (event.type === 'commandRunLog') {
    const run = state.commandRunsById[event.runId];
    // A log chunk for a run this session never saw start (e.g. a WS reconnect gap) has nothing to
    // append to — the next getCommandRun/loadCommandRuns call picks up the full output fresh.
    if (!run) return {};
    return { commandRunsById: { ...state.commandRunsById, [event.runId]: { ...run, output: run.output + event.chunk } } };
  }
  if (event.type === 'project') {
    const existing = state.projects.find((p) => p.id === event.project.id);
    if (existing) {
      return {
        projects: state.projects.map((p) =>
          p.id === event.project.id ? toProjectData(event.project, event.project.position ?? p.position, existing.sync) : p,
        ),
      };
    }
    const occupied = state.projects.map((p) => ({ x: p.position[0], z: p.position[1] }));
    const position = event.project.position ?? nearestFreePlot(...CITY_POSITION, occupied) ?? CITY_POSITION;
    return {
      projects: [...state.projects, toProjectData(event.project, position)],
      // A project created elsewhere starts with no plan items, so live planItem events can land on it.
      planByProject: state.planByProject[event.project.id] ? state.planByProject : { ...state.planByProject, [event.project.id]: { items: [] } },
    };
  }
  if (event.type === 'projectSync') {
    return { projects: state.projects.map((p) => (p.id === event.sync.projectId ? { ...p, sync: event.sync } : p)) };
  }
  if (event.type === 'task') {
    const currentIds = state.taskIdsByProject[event.task.projectId];
    const revision = (state.taskLiveRevisionByProject?.[event.task.projectId] ?? 0) + 1;
    const task = toTaskData(event.task);
    const tasksById = { ...state.tasksById, [event.task.id]: task };
    const ids = currentIds && !currentIds.includes(event.task.id)
      ? [...currentIds, event.task.id].filter((id) => tasksById[id]).sort((a, b) => (tasksById[b]!.createdAt ?? '').localeCompare(tasksById[a]!.createdAt ?? '') || b.localeCompare(a))
      : currentIds;
    return {
      tasksById,
      taskLiveRevisionByProject: { ...state.taskLiveRevisionByProject, [event.task.projectId]: revision },
      taskLiveChangesByProject: {
        ...state.taskLiveChangesByProject,
        [event.task.projectId]: { ...state.taskLiveChangesByProject?.[event.task.projectId], [event.task.id]: { revision, event } },
      },
      taskIdsByProject: ids !== currentIds
        ? { ...state.taskIdsByProject, [event.task.projectId]: ids! }
        : state.taskIdsByProject,
      lastTaskIdByProject: { ...state.lastTaskIdByProject, [event.task.projectId]: ids?.[0] ?? event.task.id },
    };
  }
  if (event.type === 'taskDeleted') {
    const revision = (state.taskLiveRevisionByProject?.[event.projectId] ?? 0) + 1;
    const { [event.id]: _deleted, ...tasksById } = state.tasksById;
    const remainingIds = (state.taskIdsByProject[event.projectId] ?? []).filter((id) => id !== event.id);
    const { [event.projectId]: _last, ...otherLastTaskIds } = state.lastTaskIdByProject;
    return {
      tasksById,
      taskLiveRevisionByProject: { ...state.taskLiveRevisionByProject, [event.projectId]: revision },
      taskLiveChangesByProject: {
        ...state.taskLiveChangesByProject,
        [event.projectId]: { ...state.taskLiveChangesByProject?.[event.projectId], [event.id]: { revision, event } },
      },
      taskIdsByProject: {
        ...state.taskIdsByProject,
        [event.projectId]: remainingIds,
      },
      lastTaskIdByProject: remainingIds[0]
        ? { ...state.lastTaskIdByProject, [event.projectId]: remainingIds[0] }
        : otherLastTaskIds,
    };
  }
  if (event.type === 'planItem' || event.type === 'planItemDeleted') {
    const projectId = event.type === 'planItem' ? event.planItem.projectId : event.projectId;
    const revision = (state.planLiveRevisionByProject?.[projectId] ?? 0) + 1;
    const itemId = event.type === 'planItem' ? event.planItem.id : event.id;
    const livePatch = {
      planLiveRevisionByProject: { ...state.planLiveRevisionByProject, [projectId]: revision },
      planLiveChangesByProject: {
        ...state.planLiveChangesByProject,
        [projectId]: { ...state.planLiveChangesByProject?.[projectId], [itemId]: { revision, event } },
      },
    };
    const plan = state.planByProject[projectId];
    // Remember the event even before the initial GET resolves, so an older response cannot erase it.
    if (!plan) return livePatch;
    const items =
      event.type === 'planItemDeleted'
        ? plan.items.filter((i) => i.id !== event.id)
        : reconcilePlanItem(plan.items, toPlanItemData(event.planItem));
    return { ...livePatch, planByProject: { ...state.planByProject, [projectId]: { ...plan, items } } };
  }
  if (event.type === 'planItemQueue') {
    // The event carries the Project's whole list, so the latest one replaces whatever was held.
    return { planItemQueueByProject: { ...state.planItemQueueByProject, [event.projectId]: event.entries } };
  }
  if (event.type === 'workflowRun') {
    const { run } = event;
    const existingRuns = state.workflowRunsByProject[run.projectId] ?? [];
    const runs = existingRuns.some((r) => r.id === run.id)
      ? existingRuns.map((r) => (r.id === run.id ? run : r))
      : [run, ...existingRuns];
    const detail = state.workflowRunDetails[run.id];
    return {
      workflowRunsByProject: { ...state.workflowRunsByProject, [run.projectId]: runs },
      // Only patch the detail view if it's currently loaded — mergeWorkerEvent never fetches on its
      // own; loadWorkflowRunDetail is what fills workflowRunDetails in the first place.
      ...(detail ? { workflowRunDetails: { ...state.workflowRunDetails, [run.id]: { ...detail, run } } } : {}),
    };
  }
  if (event.type === 'workflowRunDeleted') {
    const { [event.runId]: _deleted, ...workflowRunDetails } = state.workflowRunDetails;
    return {
      workflowRunsByProject: {
        ...state.workflowRunsByProject,
        [event.projectId]: (state.workflowRunsByProject[event.projectId] ?? []).filter((run) => run.id !== event.runId),
      },
      workflowRunDetails,
    };
  }
  if (event.type === 'stepRun') {
    const { stepRun } = event;
    const detail = state.workflowRunDetails[stepRun.runId];
    // That run's detail isn't currently loaded — nothing local to patch; the next
    // loadWorkflowRunDetail() call fetches the current state fresh.
    if (!detail) return {};
    const steps = detail.steps.map((entry) => {
      if (entry.step.id !== stepRun.stepId) return entry;
      const rounds = entry.rounds.some((r) => r.id === stepRun.id)
        ? entry.rounds.map((r) => (r.id === stepRun.id ? stepRun : r))
        : [...entry.rounds, stepRun];
      return { ...entry, rounds };
    });
    return { workflowRunDetails: { ...state.workflowRunDetails, [stepRun.runId]: { ...detail, steps } } };
  }
  // 'log' — one more turn in a Task's transcript, the source for TaskDetailsView's chat-style view
  // in ProjectWorkspaceModal.tsx (docs/roadmap.md's "wave-and-popover-into-chat flow"). Appended
  // live even if loadTranscript was never called for this task, so a brand-new Task's first turns
  // aren't lost.
  return {
    transcriptsByTask: {
      ...state.transcriptsByTask,
      [event.taskId]: [...(state.transcriptsByTask[event.taskId] ?? []), event.turn],
    },
  };
}

/**
 * True for a live 'log' WorkerEvent carrying a fresh usage-limit reading (a raw-event turn matching
 * `isUsageLimitEvent`). Pulled out of `connectLiveUpdates` the same way `mergeWorkerEvent` is, so it's
 * testable without a real WebSocket. `connectLiveUpdates` uses it to trigger an immediate
 * `loadExecutors()` the moment a running Task reports fresh limits, instead of waiting for the
 * footer's 30s poll (App.tsx) — the server already computes the real ExecutorLimits (GET
 * /api/executors), so this only decides *when* to re-fetch, not how to parse the reading itself.
 */
export function isUsageLimitLogEvent(event: WorkerEvent): boolean {
  return event.type === 'log' && event.turn.role === 'raw-event' && isUsageLimitEvent(event.turn.content);
}

/**
 * True for a live 'skillInstall' WorkerEvent reporting a settled, successful install run. Pulled out
 * as a pure function, like `isUsageLimitLogEvent`, so `connectLiveUpdates` can trigger an immediate
 * `fetchCatalog()` refresh the moment `npx skills add` finishes — the newly-installed skill's
 * catalog-index entry only exists once `syncCatalogIndex` re-runs server-side (see
 * skillInstall.ts's `settle`), so this is the frontend's cue that catalogSkills is now stale.
 */
export function isSkillInstallSuccessEvent(event: WorkerEvent): boolean {
  return event.type === 'skillInstall' && event.run.status === 'success';
}

/**
 * The currently-running run for a given commandId, if any — undefined both when the command has
 * never run this session and once its last-known run has settled. Powers the "background process
 * still going" indicator (the header button's/row's glowing dot, and routing a click on an
 * already-running command to reopen its popup instead of starting a second run) — see
 * `loadActiveCommandRuns` for how a run gets into `commandRunsById` in the first place. Pulled out
 * as a pure function, like `mergeWorkerEvent`, so it's testable without a store.
 */
export function findRunningRun(commandRunsById: Record<string, CommandRun>, commandId: string): CommandRun | undefined {
  return Object.values(commandRunsById).find((run) => run.commandId === commandId && run.status === 'running');
}

/** Ascending urgency — shared by every consumer that needs "which of these Notifications matters most" (the building dot, toasts, the drawer's sort) so severity ranking never drifts between them. */
const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Every unread-AND-unresolved Notification for one Project, or every project-less system one when `projectId` is null. Shared source of truth for the building dot and toasts — the bell badge counts unread regardless of resolved state instead (see `countUnreadNotifications`). */
export function openNotificationsForProject(notificationsById: Record<string, ServerNotification>, projectId: string | null): ServerNotification[] {
  return Object.values(notificationsById).filter((n) => n.projectId === projectId && isAttention(n));
}

/** The single most urgent unread-and-unresolved severity for a Project, or null if it has none — what the building dot's color and the hover popover's tone both key off. */
export function highestOpenSeverity(notificationsById: Record<string, ServerNotification>, projectId: string): NotificationSeverity | null {
  const open = openNotificationsForProject(notificationsById, projectId);
  if (open.length === 0) return null;
  return open.reduce<NotificationSeverity>((worst, n) => (SEVERITY_RANK[n.severity] > SEVERITY_RANK[worst] ? n.severity : worst), open[0]!.severity);
}

/** Updates a known PlanItem in place or appends a new one, keeping the list sorted by `order`. */
function reconcilePlanItem(items: PlanItemData[], item: PlanItemData): PlanItemData[] {
  const next = items.some((i) => i.id === item.id) ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item];
  return next.slice().sort((a, b) => a.order - b.order);
}

/** Mirrors the daemon's `reorderPlanItems`: the listed items take the order slots they hold between them, in the given sequence. */
export function reorderLocally(items: PlanItemData[], ids: string[]): PlanItemData[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const moved = ids.flatMap((id) => byId.get(id) ?? []);
  const slots = moved.map((item) => item.order).sort((a, b) => a - b);
  const orderById = new Map(moved.map((item, index) => [item.id, slots[index]!]));
  return items
    .map((item) => (orderById.has(item.id) ? { ...item, order: orderById.get(item.id)! } : item))
    .sort((a, b) => a.order - b.order);
}

export interface WorldState extends SchedulesState, ConnectionsState, AgentSessionsState {
  projects: ProjectData[];
  /** Every Task ever seen this session, keyed by id — a project's current one is `tasksById[activeTaskId]`. */
  tasksById: Record<string, TaskData>;
  /** Most recent Task id per project id, kept even after the project itself returns to 'idle' — see mergeWorkerEvent. */
  lastTaskIdByProject: Record<string, string>;
  /** Settled task ids whose result/error has been acknowledged — persisted per browser in localStorage (lib/reviewedTasks.ts). */
  reviewedTaskIds: Record<string, true>;
  /** Every Task's transcript turns seen this session, keyed by task id — the chat-style view's source data. */
  transcriptsByTask: Record<string, TaskTurn[]>;
  /** Every project's task-card data for the unified board, keyed by project id — see `loadPlan`. */
  planByProject: Record<string, ProjectPlanState>;
  /** Latest live item change per id, replayed over GETs that began before the event arrived. */
  planLiveChangesByProject: Record<string, Record<string, { revision: number; event: PlanLiveEvent }>>;
  planLiveRevisionByProject: Record<string, number>;
  /** Task events received during a list request, including deletion tombstones. */
  taskLiveChangesByProject: Record<string, Record<string, { revision: number; event: TaskLiveEvent }>>;
  taskLiveRevisionByProject: Record<string, number>;
  /** Each Project's waiting list (starts accepted at the task limit), in start order. Loaded by `loadPlanItemQueue`, kept live by `mergeWorkerEvent`'s 'planItemQueue' case. */
  planItemQueueByProject: Record<string, PlanItemQueueEntry[]>;
  /** Every WorkflowRun seen for a project this session, newest first, keyed by project id — see `loadWorkflowRunsForProject`. Kept live by `mergeWorkerEvent`'s 'workflowRun' case. */
  workflowRunsByProject: Record<string, WorkflowRunRecord[]>;
  /** A WorkflowRun's full step/round detail (the run detail view's source data), keyed by run id — see `loadWorkflowRunDetail`. Kept live by `mergeWorkerEvent`'s 'workflowRun'/'stepRun' cases, but only once a given run's detail has been loaded here (never fetched eagerly on an event). */
  workflowRunDetails: Record<string, WorkflowRunDetail>;
  /** Every Test Run seen over the live feed this session, keyed by id — the Testing tab refreshes its overview when one of its Project's runs changes. */
  testRunsById: Record<string, TestRun>;
  /** Running SEO jobs (crawl, sitemap fetch, inspection, keyword runs), keyed by job id — kept live by the 'seoJob' event and reloaded from the daemon on connect, so the footer needs no SEO tab open. */
  seoJobsById: Record<string, SeoJobDto>;
  /** Ids of SEO jobs whose end event was seen, so a late snapshot cannot list them again. */
  settledSeoJobIds: Record<string, true>;
  /** Running Content Studio jobs (Remotion setup, video renders), kept like `seoJobsById`. */
  contentJobsById: Record<string, ContentJobDto>;
  settledContentJobIds: Record<string, true>;
  /** The SEO tab the open SEO Building should switch to next, set by `openSeoFromFooter` and cleared by the workspace once applied. A fresh object per request, so repeating one re-applies it. */
  seoTabRequest: { projectId: string; tab: SeoTab } | null;
  /** A Test Run's full detail (log + normalized result) — the run drawer's source data, keyed by run id. Only populated once `loadTestRunDetail` has fetched it; kept live afterwards by `mergeWorkerEvent`'s 'testRun' case (status/summary fields only — the log and `result` only change on a fresh fetch). */
  testRunDetailsById: Record<string, TestRunDetail>;
  /** A Test Run's live output, keyed by run id — seeded from `loadTestRunDetail`'s fetch, then streamed onto by `mergeWorkerEvent`'s 'testRunLog' case. A chunk for a run this session hasn't fetched detail for yet is dropped (nothing to append to; the next `loadTestRunDetail` picks up the full output fresh), the same convention as `commandRunLog`/`skillInstallLog`. */
  testRunLogsById: Record<string, string>;
  /** The Agent Analytics view (`ui/analytics/`): its own state, so opening or closing it never touches the Project workspace underneath. */
  analytics: AnalyticsState;
  /** Which project's Full-fledged Project Popover is open, if any — a project id, or null. Distinct from `selectedId` (the small anchored popup). */
  workspaceProjectId: string | null;
  /** The open workspace's top-level tab — moved out of `ProjectWorkspaceModal`'s local state so `openNotificationTarget` can deep-link into it. Reset to its default by `openWorkspace` on every call (opening a project, switching to a different one, or closing), the same "clean state on project switch" `key={workspaceProjectId}` used to give by remounting. */
  workspaceTab: WorkspaceTab;
  /** The open workspace's Tasks tab detail (a task's session), if any — moved out of `useTaskSessionDetail`'s local state for the same reason as `workspaceTab`. */
  workspaceDetailTaskId: string | null;
  /** A card detail (or the plain board, `detail: null`) the Tasks board should show next, set by `openWorkspaceCardDetail` and cleared by the board once applied. A fresh object per request, so repeating one re-applies it. */
  workspaceCardDetailRequest: { detail: CardDetail | null } | null;
  /** The Tasks board's transient filter: 'pending' shows only pending tasks (opened from a yard's crate stack). Cleared by `openWorkspace` on every call and by any tab switch, so it is never remembered. */
  workspaceTasksFilter: 'pending' | null;
  /** A Test Run's detail drawer (or, with `runId: null`, just the Testing tab) the Testing tab should show next, set by `openTestRunFromFooter` and cleared by the tab once applied. */
  workspaceTestRunRequest: { runId: string | null } | null;
  /** The pull request the PR tab should bring into view next, set by `openPullRequestFromFooter` and cleared by the tab once applied. A fresh object per request, so repeating one re-applies it. */
  prHighlightRequest: { projectId: string; number: number | null } | null;
  /** The command run whose log popup the status footer (or a command-completed notification) opened over whatever is on screen; null when none. */
  footerCommandLogRunId: string | null;
  /** The open workspace's Settings tab section — moved out of `ProjectWorkspaceModal`'s local state for the same reason as `workspaceTab`, so a `command.failed` Notification can land on Settings → Commands specifically. */
  workspaceSettingsSection: SettingsSection;
  /** Whether the overview is the 3D village or the lightweight project cards — a per-browser preference, persisted in localStorage only. */
  viewMode: ViewMode;
  /** Whether the Catalog modal (Templates/Skills, opened from City Center) is open. Mutually exclusive with `workspaceProjectId` — opening one closes the other (see `openCatalog`/`openWorkspace`). */
  catalogOpen: boolean;
  /** Every Task ever run for a project, most-recent-first by id — the workspace's task-history list. Populated by `loadProjectTasks`. */
  taskIdsByProject: Record<string, string[]>;
  /** Every configured way to run a Task (Claude accounts, Codex placeholder) — see GET /api/executors. */
  executors: ExecutorProfile[];
  /** Every project's defined commands, keyed by project id — see `loadCommands`. */
  commandsByProject: Record<string, ProjectCommand[]>;
  /** Every command run seen this session, keyed by run id — kept live by `mergeWorkerEvent`'s 'commandRun'/'commandRunLog' cases, the log popup's source data. */
  commandRunsById: Record<string, CommandRun>;
  /** A project's run history, most-recent-first by id — populated by `loadCommandRuns`. */
  commandRunIdsByProject: Record<string, string[]>;
  /** Every Catalog agent (Template), fetched by `fetchCatalog`. */
  catalogAgents: CatalogAgent[];
  /** Every Catalog skill, fetched by `fetchCatalog`. */
  catalogSkills: CatalogSkill[];
  /** Every Catalog Workflow, fetched by `fetchCatalog` — see server/src/domain/types.ts's WorkflowRecord. */
  catalogWorkflows: WorkflowRecord[];
  /** Every skill-install run ('npx skills add <repo>') seen this session, keyed by run id — mirroring `commandRunsById`'s role for CommandRuns. */
  catalogInstallRuns: Record<string, SkillInstallRun>;
  /** Every Notification seen this session, keyed by id — the building dot's, toast stack's, and drawer's shared source data (docs/milestones/milestone-5-notification-system.md). Kept live by `mergeWorkerEvent`'s 'notification' case; use `openNotificationsForProject`/`highestOpenSeverity` to read it rather than filtering inline. */
  notificationsById: Record<string, ServerNotification>;
  /** True once the initial GET /api/notifications has resolved (success or failure) — see `loadNotifications`. */
  notificationsLoaded: boolean;
  /** Whether the Notifications drawer is open (see `toggleNotificationCenter`/`closeNotificationCenter`). */
  notificationCenterOpen: boolean;
  /** The daemon's current app-update reading (task 7.001) — null until the first `loadAppUpdate()` resolves. Kept live by `mergeWorkerEvent`'s 'appUpdate' case. */
  appUpdate: AppUpdateStatus | null;
  /** Every live terminal session, replaced wholesale by each `terminalSessions` snapshot (sent on connect, so a reconnect refreshes it). */
  liveTerminalSessions: LiveTerminalSession[];
  /** Whether the live `/ws` connection is currently up — flipped by `connectLiveUpdates`'s `onReconnect`/`onDisconnect` callbacks. Starts `true`: the first connection attempt is assumed to succeed, and `onDisconnect` corrects it the moment that's wrong. Drives the reconnect banner (`lib/appUpdate.ts`'s `reconnectBannerVisible`) alongside `lastKnownAppUpdatePhase`. */
  wsConnected: boolean;
  /** `appUpdate.phase` as of the last time it was set — read when `wsConnected` flips to false, so the reconnect banner knows whether the disconnect happened mid-update. */
  lastKnownAppUpdatePhase: AppUpdatePhase | null;
  /** The `currentCommit` the reload banner was last dismissed for, or null — see `lib/appUpdate.ts`'s `nextReloadBannerVisibility`. A later, distinct `currentCommit` re-shows the banner even though this one was dismissed. */
  appUpdateReloadDismissedCommit: string | null;
  /** A project id, or null (nothing selected). City Center no longer uses this — see `catalogOpen`/`openCatalog`. */
  selectedId: string | null;
  /** Id of the building currently being dragged, if any. Drives camera-control lockout. */
  draggingId: string | null;
  controlsEnabled: boolean;
  /** True once the initial GET /api/projects has resolved (success or failure). */
  loaded: boolean;
  /** The most recent failed server call's message, if any — surfaced in the HUD. */
  /** App errors not shown inside a form: kept in this tab only (never sent to the daemon), listed in the Notifications drawer next to daemon ones. See `lib/errorNotifications.ts`. */
  errorNotificationsById: Record<string, ErrorNotification>;
  /** Counter behind error notification ids. */
  errorNotificationSeq: number;
  /** How many mounted forms currently show each scope's errors (see `useErrorScope`); a failure outside an open scope becomes a notification. */
  openErrorScopes: Partial<Record<ErrorScope, number>>;
  /** The latest failure of each open scope's own actions. */
  formErrors: Partial<Record<ErrorScope, string>>;
  /** Registers a form as showing `scope`'s errors and clears any stale one; call the returned function when it closes. */
  openErrorScope: (scope: ErrorScope) => () => void;

  /** Fetches every registered Project from the daemon. Call once on app start. */
  loadProjects: () => Promise<void>;
  /** Fetches the configured executors. Call once on app start. */
  loadExecutors: () => Promise<void>;
  /** Makes an agent the app-wide default for new sessions. Resolves to null on success or the failure message; a caller without its own error display passes `notify` to raise a notification instead. */
  setDefaultExecutor: (executorId: string, options?: { notify?: boolean }) => Promise<string | null>;
  /** Settings panel: adds a new coding agent. Resolves true on success, false (a failure goes to the action's form or a notification) on failure. */
  addExecutor: (input: ExecutorInput) => Promise<boolean>;
  /** Settings panel: edits an existing coding agent's fields in place, keeping its id. */
  updateExecutor: (id: string, patch: Partial<ExecutorInput>) => Promise<boolean>;
  /** Settings panel: removes a configured coding agent. */
  deleteExecutor: (id: string) => Promise<boolean>;
  /** Subscribes to the daemon's live WorkerEvent feed. Returns an unsubscribe function. */
  connectLiveUpdates: () => () => void;
  /** Fetches a Task's full turn history — call when opening a chat view so history predating this tab's connection isn't missing. */
  loadTranscript: (taskId: string) => Promise<void>;
  addProject: (name: string, repositoryUrl?: string, typeId?: string, siteUrl?: string, timezone?: string) => Promise<boolean>;
  /** The Building Types the daemon offers for a new Building (Software first). */
  buildingTypes: ServerBuildingType[];
  loadBuildingTypes: () => Promise<void>;
  /** The input the last failed create named (e.g. "name"), so the dialog can show the message beside it; null for a dialog-level failure. */
  newBuildingField: string | null;
  moveProject: (id: string, x: number, z: number) => void;
  /** The 2D view's move: puts the project on exactly this empty slot, optimistically; resolves false (and reverts) when refused locally or by the server. */
  moveProjectToSlot: (id: string, slot: SlotRef) => Promise<boolean>;
  /** The sync icon's click action — starts a real CommandRun (git fetch + fast-forward) and returns it so the caller can open the log popup, same as runCommand. See lib/serverApi.ts's syncProjectBranch. */
  syncProjectBranch: (id: string) => Promise<CommandRun | undefined>;
  /** Sets (or, with `workflowId: null`, resets to the Catalog default) which Workflow a Project's Tasks run through. Resolves true on success, false (a failure goes to the action's form or a notification) on failure. */
  setProjectWorkflow: (projectId: string, workflowId: string | null) => Promise<boolean>;
  /** Sets which Git provider hosts a Project's repository. Resolves true on success, false (the failure goes to a notification) on failure. */
  setProjectGitProvider: (projectId: string, gitProvider: GitProviderId) => Promise<boolean>;
  /** Changes only the Project's display name (the folder keeps its name). Rejects with the server's message so the form can show it inline. */
  renameProject: (projectId: string, name: string) => Promise<void>;
  /** Deletes the Project and its folder and data, drops it from the yard and closes its popup. Rejects with the server's reason (e.g. a running task) and changes nothing. */
  deleteProject: (projectId: string) => Promise<void>;
  /** The accounts the machine's `gh` knows (global Settings → GitHub accounts and the project's selector); null until first loaded. Never holds a token. */
  githubAccounts: GithubAccountsResult | null;
  githubAccountsLoading: boolean;
  /** Re-detects the accounts: on opening the settings, on Refresh and on Re-check. */
  loadGithubAccounts: () => Promise<void>;
  saveGithubIdentity: (login: string, identity: { name: string; email: string }) => Promise<boolean>;
  resetGithubIdentity: (login: string) => Promise<boolean>;
  /** The open global Settings panel's tab, or null while it is closed. */
  settingsSection: GlobalSettingsSection | null;
  /** Opens the global Settings panel on a tab (Coding agents by default), or switches the open panel to it. */
  openSettings: (section?: GlobalSettingsSection) => void;
  closeSettings: () => void;
  /** Whether the app-wide Google OAuth client (Settings > Google (SEO)) is saved; null until first loaded. Its values never reach the browser. */
  googleOAuthClientSaved: boolean | null;
  loadGoogleOAuthClient: () => Promise<void>;
  /** Saves (or replaces) the client. Resolves to null on success or the failure message, leaving the saved state as it was. */
  saveGoogleOAuthClient: (clientId: string, clientSecret: string) => Promise<string | null>;
  /** Removes the client. Resolves to null on success or the failure message. */
  removeGoogleOAuthClient: () => Promise<string | null>;
  /** Picks the project's GitHub account (null = machine default) and, for an account, re-checks its access. */
  setProjectGithubAccount: (projectId: string, githubAccount: string | null) => Promise<boolean>;
  githubAccountChecks: Record<string, AccountCheck | 'checking'>;
  checkProjectGithubAccount: (projectId: string) => Promise<void>;
  /** Turns the automatic pull of the Project's checked-out branch on or off; applied at once and rolled back if the daemon refuses. */
  setProjectAutoPull: (projectId: string, autoPullEnabled: boolean) => Promise<boolean>;
  /** The PR tab's per-Project action state: each row's merge state, what is in flight, row errors and the merge notice. See lib/pullRequestActions.ts. */
  prActionsByProject: Record<string, PrActionState>;
  /** Reads the merge state of the listed pull requests that are new or changed (all of them with `force`). One row's failed read stays on that row. */
  loadPrMergeStates: (projectId: string, pullRequests: PullRequest[], force?: boolean) => Promise<void>;
  /**
   * The Merge click and its dialogs' confirmations. Resolves the daemon's answer (merged, blockers to
   * confirm, or the conflict-resolution run), or null when it failed: the failure is put on the row.
   */
  mergePullRequest: (projectId: string, pr: PullRequest, options?: MergeRequestOptions) => Promise<MergeResponse | null>;
  /** Check out: switches the Project's folder to the PR's branch. A refusal or failure is put on the row. */
  checkoutPullRequest: (projectId: string, pr: PullRequest) => Promise<boolean>;
  /** Return: back to the branch from before the checkout, or to `branch` when the offered default branch was chosen. */
  returnFromPullRequest: (projectId: string, branch?: string) => Promise<boolean>;
  dismissPrNotice: (projectId: string) => void;
  selectBuilding: (id: string | null) => void;
  setDragging: (id: string | null) => void;
  setControlsEnabled: (enabled: boolean) => void;
  startTask: (id: string, description: string, executorId?: string, autonomy?: Autonomy) => Promise<void>;
  /** Acknowledges a settled Task so its completion/error notice no longer demands attention. */
  reviewTask: (taskId: string) => void;
  stopTask: (taskId: string) => Promise<boolean>;
  /** Fetches every Task ever run for a project — the workspace's task-history list. */
  loadProjectTasks: (projectId: string) => Promise<void>;

  /** Opens/closes the Full-fledged Project Popover for a project (null closes it), loading its plan on open. Also resets `workspaceTab`/`workspaceDetailTaskId`/`workspaceSettingsSection` to their defaults on every call — `openNotificationTarget` overrides them right after, for a deep link into a non-default tab. */
  openWorkspace: (projectId: string | null) => void;
  /** Opens a project's Tasks tab from the status footer — on the board, or on one card's details (falling back to the board when that record is gone) — replacing any other popup and closing the Notifications drawer. */
  openWorkspaceCardDetail: (projectId: string, detail: CardDetail | null) => void;
  /** Opens a project's Tasks tab with the "Pending only" filter on (a click on its yard's crate stack). */
  openWorkspacePendingTasks: (projectId: string) => void;
  setWorkspaceTasksFilter: (filter: 'pending' | null) => void;
  clearWorkspaceCardDetailRequest: () => void;
  clearWorkspaceTestRunRequest: () => void;
  /** Opens a command run's live log popup on top of whatever is open, without opening or switching a project popup; replaces any log opened this way before. */
  openFooterCommandLog: (runId: string) => Promise<void>;
  closeFooterCommandLog: () => void;
  /** Opens a project's Testing tab with one run's detail drawer (just the tab when the run is gone), replacing any other popup and closing the Catalog and the Notifications drawer. */
  openTestRunFromFooter: (projectId: string, runId: string) => Promise<void>;
  /** Opens the project's workspace on its PR tab and asks it to highlight that pull request (`null` just opens the tab). A project that no longer exists is ignored. */
  openPullRequestFromFooter: (projectId: string, number: number | null) => void;
  /** Opens an SEO Building on `tab` from the footer; an unknown Building is ignored. */
  openSeoFromFooter: (projectId: string, tab: SeoTab) => void;
  clearSeoTabRequest: () => void;
  /** Stops a Building's running Internal links crawl from the footer; the row leaves when the daemon's end event arrives. */
  stopSeoCrawlFromFooter: (projectId: string) => Promise<void>;
  /** Replaces the stored running SEO jobs with the daemon's list (a job that ended while disconnected drops out). */
  loadSeoJobs: () => Promise<void>;
  loadContentJobs: () => Promise<void>;
  /** Stops a video render from the footer; the row leaves when the daemon's end event arrives. */
  stopRenderFromFooter: (projectId: string, conceptId: string, renderId: string) => Promise<void>;
  stopImageRenderFromFooter: (projectId: string, assetId: string, renderId: string) => Promise<void>;
  stopThumbnailRenderFromFooter: (projectId: string, assetId: string, renderId: string) => Promise<void>;
  stopInsightsFromFooter: (projectId: string) => Promise<void>;
  stopStudioFromFooter: (projectId: string) => Promise<void>;
  clearPrHighlightRequest: () => void;
  /** Lists a project's running command runs and executing test runs into the store, and settles ones that ended while this tab was not listening. Runs at startup and reconnect, so the footer's Commands count never waits on a project popup. */
  loadRunningRuns: (projectId: string) => Promise<void>;
  /** Lists a project's failed command and test runs nobody has opened yet (the 3D village's red machines) into the store. Runs at startup and reconnect. */
  loadUnopenedFailures: (projectId: string) => Promise<void>;
  /** Records that a failed command run's log was opened, clearing its red machine everywhere; a no-op for a run with no unopened failure. A refusal is reported and the machine stays red. */
  markCommandRunOpened: (runId: string) => Promise<void>;
  /** The same as `markCommandRunOpened`, for a test run. */
  markTestRunOpened: (runId: string) => Promise<void>;
  /** A command machine's click in the 3D village: the project's Settings › Commands, with that run's log open on top (just the section when the run is gone). */
  openCommandRunFromVillage: (projectId: string, runId: string) => Promise<void>;
  /**
   * Opens a planning session from the status footer's popover: its project's popup (replacing any other
   * popup or the Catalog) on Tasks with the session's details, as its Planning board card would, and closes
   * the Notifications drawer so the session is visible. A session gone by the time of the click leaves the
   * Tasks board showing without details.
   */
  openPlanningSession: (projectId: string, taskId: string) => void;
  /** Opens Agent Analytics on one agent (or on whichever is listed first, given null) showing today, and loads it. */
  openAnalytics: (agentId: string | null) => void;
  closeAnalytics: () => void;
  setAnalyticsAgent: (agentId: string) => void;
  /** Shows another local day, given that day's midnight. */
  setAnalyticsDay: (dayStart: number) => void;
  /** Reloads the agent list, the day shown and the step comparison. A failure keeps what was loaded and sets `analytics.error`. */
  loadAnalytics: () => Promise<void>;
  /** Asks the daemon for a fresh provider check, then reloads. */
  refreshAnalytics: () => Promise<void>;
  /** Closes Analytics and opens the work an activity or round belongs to, at its step round where it has one. */
  openAnalyticsTarget: (target: ActivityTarget) => void;
  /** Opens a workspace tab. A value that used to be a tab and is now a Settings section (schedules, connections, activity) opens Settings at that section; an unknown value opens Tasks. */
  setWorkspaceTab: (tab: WorkspaceTab | string) => void;
  setWorkspaceDetailTaskId: (taskId: string | null) => void;
  setWorkspaceSettingsSection: (section: SettingsSection) => void;
  /** Switches the overview between the 3D village and the project cards, remembering the choice for the next page load. */
  setViewMode: (mode: ViewMode) => void;
  /** Opens the Catalog modal (Templates/Skills — City Center), fetching its content and closing the Project workspace if one was open. Mirrors `openWorkspace`'s "open this, close that" shape. */
  openCatalog: () => void;
  /** Closes the Catalog modal. */
  closeCatalog: () => void;
  /** Fetches a project's Tasks breakdown. Runs for every project on `loadProjects`, and again when opening its workspace. */
  loadPlan: (projectId: string) => Promise<void>;
  /** Resolves to the new item's id, or undefined if the request failed (a failure goes to the action's form or a notification). */
  createPlanItem: (projectId: string, draft: PlanItemDraft) => Promise<string | undefined>;
  /** Resolves true on success, false (a failure goes to the action's form or a notification) on failure. */
  updatePlanItem: (projectId: string, itemId: string, patch: PlanItemPatch) => Promise<boolean>;
  /**
   * Reorders one Tasks-board column after a drop: `itemIds` in this sequence. Applied locally straight
   * away so the drop doesn't snap back, then replaced by the daemon's list; reloaded from the daemon if it fails.
   */
  reorderPlanItems: (projectId: string, itemIds: string[]) => Promise<boolean>;
  /** Switches a task's Auto-merge on or off: applied at once, put back (with the daemon's reason as an error) when refused. Resolves true on success. */
  setAutoMerge: (projectId: string, itemId: string, enabled: boolean) => Promise<boolean>;
  /** Retries a failed auto-merge. Resolves true on success. */
  retryAutoMerge: (projectId: string, itemId: string) => Promise<boolean>;
  /** Replaces a ready task's parents; false (with the daemon's reason reported) when refused. */
  setDependencies: (projectId: string, itemId: string, dependsOn: string[]) => Promise<boolean>;
  /** Saves "UI planning waits for parent"; false when refused (the switch shows the failure inline, so no error is reported). */
  setUiPlanningWaits: (projectId: string, itemId: string, value: boolean) => Promise<boolean>;
  /** Takes a waiting task back to plain ready. */
  cancelWaiting: (projectId: string, itemId: string) => Promise<boolean>;
  /** The "Chain tasks" shortcut for a planning session. */
  chainPlanningGroup: (projectId: string, session: number, autoMerge: boolean) => Promise<boolean>;
  /** Resolves true on success, false (a failure goes to the action's form or a notification) on failure. */
  deletePlanItem: (projectId: string, itemId: string) => Promise<boolean>;
  /**
   * Starts one Tasks-breakdown item's Workflow and resolves to the new run's id — the run is still
   * 'starting' (see `WorkflowRunRecord.startup`) while its worktree and agent are set up. Unlike most
   * actions it throws the daemon's message instead of reporting it, so the start dialog can show
   * why it was refused (bad options, task limit reached, project folder busy).
   */
  executePlanItem: (itemId: string, options: ExecutePlanItemOptions) => Promise<string>;
  /** Loads a Project's waiting list; a failed load leaves what the store already holds. */
  loadPlanItemQueue: (projectId: string) => Promise<void>;
  /** Takes a queued task off its Project's waiting list; it goes back to unstarted. */
  removeFromWaitingList: (projectId: string, entryId: string) => Promise<boolean>;
  /**
   * Reports a regression on a completed bug and starts its round 2. Resolves to the daemon's note
   * about a workflow that had to be replaced ('' when none); like `executePlanItem` it throws the
   * daemon's reason, so the dialog can show it and stay open.
   */
  reportRegression: (projectId: string, itemId: string, reason: string) => Promise<string>;
  /** Starts a task that has dependencies: its run id now, or '' when it waits for its parents (it stays in Planning). */
  startWhenReady: (projectId: string, itemId: string, options: ExecutePlanItemOptions) => Promise<string>;
  /**
   * The Start dialog's start: `startWhenReady` when the stored plan item has parents (or is waiting
   * for them), else `executePlanItem`. Decided from the store, not the caller, so every Start entry
   * point takes the route the daemon accepts.
   */
  startPlanItem: (projectId: string, itemId: string, options: ExecutePlanItemOptions) => Promise<string>;
  /**
   * Starts a plan-and-bugs session and resolves to its Task id. Without `executorId` the session is
   * created with no CLI. Like `executePlanItem`, this and the four bug actions below reject with the
   * daemon's reason, so the dialog or view that called them can show it in place.
   */
  startPlanAndBugsSession: (projectId: string, description: string, executorId?: string, autonomy?: Autonomy) => Promise<string>;
  /** Saves a not-started session's description. */
  updateSessionDescription: (taskId: string, description: string) => Promise<void>;
  /** Starts the CLI of a session created without one. */
  startDeferredSession: (taskId: string, executorId: string) => Promise<void>;
  /** Flips a not-started bug's Info status. */
  setBugInfoStatus: (projectId: string, itemId: string, infoStatus: BugInfoStatus) => Promise<void>;
  /** Saves the order of the ready bugs under one introducing task: applied locally at once, and put back as it was if the daemon refuses. */
  reorderBugGroup: (projectId: string, introducerId: string, ids: string[]) => Promise<void>;

  // ---- Project Commands: user-defined shell commands, run from the project's root (Commands tab) ----

  /** Fetches a project's defined commands — call when opening its workspace or its Commands tab. */
  loadCommands: (projectId: string) => Promise<void>;
  createCommand: (projectId: string, input: CommandInput) => Promise<boolean>;
  updateCommand: (projectId: string, commandId: string, patch: Partial<CommandInput> & { highlighted?: boolean }) => Promise<boolean>;
  deleteCommand: (projectId: string, commandId: string) => Promise<boolean>;
  /** Starts a command running and returns the new run (or undefined on failure) so the caller can open the log popup on it immediately; `workflowRunId` runs it in that WorkflowRun's working copy — mirrors `mergeTaskResponse`'s "optimistic, return what you started". */
  runCommand: (commandId: string, workflowRunId?: string) => Promise<CommandRun | undefined>;
  /** "Run a custom command and see the output right away" — a one-off, never-saved command (RunCustomCommandDialog). Same run/return contract as `runCommand`. */
  runAdHocCommand: (projectId: string, command: string, workflowRunId?: string) => Promise<CommandRun | undefined>;
  stopCommandRun: (runId: string) => Promise<void>;
  /** Fetches a project's command-run history — call when opening Commands → History. */
  loadCommandRuns: (projectId: string) => Promise<void>;
  /**
   * Fetches just a project's *currently-running* runs (a background `npm run dev` left going, a
   * sync, an ad hoc run) and merges them into `commandRunsById` — call once when the workspace opens
   * so the header/Manage rows know what's still running without waiting for a WS event that may
   * never come (the run may have started in a previous session). Deliberately doesn't touch
   * `commandRunIdsByProject` — that field is the *full* History list's cache; this only ever fetches
   * a subset of it, so overwriting it here would corrupt History's own cache.
   */
  loadActiveCommandRuns: (projectId: string) => Promise<void>;

  // ---- Notifications (docs/milestones/milestone-5-notification-system.md) ----

  /** Fetches every Notification from the daemon. Call once on app start, same as `loadProjects` — live updates then arrive over `/ws` via `mergeWorkerEvent`. */
  loadNotifications: () => Promise<void>;
  /** Marks exactly the given ids read. A no-op when `ids` is empty. */
  markNotificationsRead: (ids: string[]) => Promise<void>;
  /** Marks every Notification matching this subject's identity (any kind) read — only calls the server when at least one matching one is actually unread. */
  markSubjectRead: (subject: NotificationSubject) => Promise<void>;
  markNotificationUnread: (id: string) => Promise<void>;
  /** "Mark all as read" — marks read only what matches `filter` (the drawer's current filters). */
  markAllNotificationsRead: (filter: NotificationApiFilter) => Promise<void>;
  /** Marks a project's unread `command.failed` Notifications read — call when its Commands tab is shown. A no-op when none are unread. */
  markProjectCommandFailuresRead: (projectId: string) => Promise<void>;
  /**
   * Deep-links to what a Notification is about, always marking it read first:
   * task → the workspace's Tasks tab, detail open on `subject.taskId` (needs_input's "Reply" quick
   * action is the same action — the terminal auto-focuses on mount); command → Settings → Commands;
   * project → the workspace; skill → the Catalog.
   */
  openNotificationTarget: (n: DrawerNotification) => Promise<void>;
  /** Runs a Notification's quick action (see `lib/notificationCenter.ts`'s `quickActionFor`), then marks it read on success. Reports the failure and leaves it unread on failure, so the user can retry. */
  runNotificationQuickAction: (n: DrawerNotification) => Promise<void>;
  /** Opens or closes the Notifications drawer (the status footer bell's click action), leaving any open popup as it is. */
  toggleNotificationCenter: () => void;
  /** Closes the Notifications drawer. */
  closeNotificationCenter: () => void;

  // ---- App update (task 7.001) ----

  /** Fetches the daemon's current app-update reading. Call once on app start, same as `loadProjects` — live updates then arrive over `/ws` via `mergeWorkerEvent`. */
  loadAppUpdate: () => Promise<void>;
  /** Forces an immediate re-check (the popover's "Check now"). */
  checkAppUpdateNow: () => Promise<void>;
  /** Starts a web-only update, or moves a server-touching one to "waiting for idle". Also what "Retry" calls after a failed apply. */
  applyAppUpdate: () => Promise<void>;
  /** Cancels a held (waiting-for-idle) update. */
  cancelAppUpdate: () => Promise<void>;
  /** Dismisses the reload banner for the build currently being served — see `appUpdateReloadDismissedCommit`. */
  dismissAppUpdateReloadBanner: () => void;

  // ---- Catalog: Templates (agents) and Skills, backed by the daemon's repo-root catalog/ folder ----

  /** Fetches every Catalog agent and skill. Call once when opening the Catalog UI. */
  fetchCatalog: () => Promise<void>;
  createCatalogAgent: (input: CreateCatalogAgentInput) => Promise<boolean>;
  updateCatalogAgent: (id: string, patch: UpdateCatalogAgentInput) => Promise<boolean>;
  deleteCatalogAgent: (id: string) => Promise<boolean>;
  toggleCatalogAgentEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  uploadCatalogAgentFile: (input: UploadCatalogAgentInput) => Promise<boolean>;
  createCatalogSkill: (input: CreateCatalogSkillInput) => Promise<boolean>;
  updateCatalogSkill: (id: string, patch: UpdateCatalogSkillInput) => Promise<boolean>;
  deleteCatalogSkill: (id: string) => Promise<boolean>;
  toggleCatalogSkillEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  uploadCatalogSkillZip: (input: UploadCatalogSkillInput) => Promise<boolean>;
  addCatalogSkillFile: (id: string, name: string, file: Blob) => Promise<boolean>;
  removeCatalogSkillFile: (id: string, name: string) => Promise<boolean>;
  /**
   * Starts a `npx skills add <repo>` run and returns it (or undefined on failure) so the caller can
   * show its progress right away — mirrors `runCommand`'s "optimistic, return what you started".
   * Live output/status then arrive over WS as 'skillInstall'/'skillInstallLog' events, folded in by
   * `mergeWorkerEvent`; a successful settle also triggers a `fetchCatalog()` refresh (see
   * `isSkillInstallSuccessEvent` in `connectLiveUpdates`) so the newly-installed skill shows up.
   */
  startCatalogSkillInstall: (repo: string) => Promise<SkillInstallRun | undefined>;

  createCatalogWorkflow: (input: WorkflowInput) => Promise<boolean>;
  updateCatalogWorkflow: (id: string, patch: UpdateWorkflowInput) => Promise<boolean>;
  deleteCatalogWorkflow: (id: string) => Promise<boolean>;

  // ---- Workflow runs (task 3.012): one run per executed PlanItem, its Steps' full round history, and its approval/loop/stop actions ----

  /** Fetches every WorkflowRun for a project, newest first — call when opening its Tasks tab / run history. */
  loadWorkflowRunsForProject: (projectId: string) => Promise<void>;
  /** Fetches one WorkflowRun's full step/round detail — call when opening its run detail view. */
  loadWorkflowRunDetail: (runId: string) => Promise<void>;
  /** Approves the run's current `awaiting-approval` step, advancing it to the next one. Resolves true on success, false (a failure goes to the action's form or a notification) on failure. */
  approveWorkflowRun: (runId: string, comment?: string) => Promise<boolean>;
  /** Sends the current step back for changes with a required comment. */
  requestChangesWorkflowRun: (runId: string, comment: string) => Promise<boolean>;
  /** Resolves a loop-exhausted `needs-attention` run: another round, or continue past the loop. */
  decideWorkflowRunLoop: (runId: string, action: 'another-round' | 'continue', comment?: string) => Promise<boolean>;
  /** Retries a `needs-attention`/`failed` run's current step from scratch. */
  retryWorkflowStep: (runId: string) => Promise<boolean>;
  /** Stops a running WorkflowRun (status `stopped`, its item `blocked`), keeping its session for `resumeWorkflowRun`. */
  stopWorkflowRun: (runId: string) => Promise<boolean>;
  // ---- Testing setup (task 2.005) ----

  /** Starts a Project's testing setup, or returns the one already active. Resolves null (a failure goes to the action's form or a notification) on failure. */
  startTestingSetup: (projectId: string) => Promise<TestingSetupStartResult | null>;
  /** Approves the exact setup proposal round shown — the only action that lets the setup change the project. */
  approveTestingSetup: (runId: string, proposalRound: number, comment?: string) => Promise<boolean>;
  /** Sends feedback on a setup proposal: the agent revises it, still read-only. */
  reviseTestingSetup: (runId: string, comment: string) => Promise<boolean>;
  /** Rejects a setup: it stops with the project unchanged. */
  rejectTestingSetup: (runId: string) => Promise<boolean>;
  /** Fetches one Test Run's full detail (log + normalized result) into `testRunDetailsById`/`testRunLogsById` — call when opening its run drawer, and again once it settles to pick up its final result (live status in between comes over `/ws`, not polling). Resolves null (a failure goes to the action's form or a notification) on failure. */
  loadTestRunDetail: (runId: string) => Promise<TestRunDetail | null>;
  /** Resumes a `stopped` WorkflowRun's current step in its own session. */
  resumeWorkflowRun: (runId: string) => Promise<boolean>;
}

/**
 * Folds a Task returned by an action's own HTTP response (start/follow-up/answer) into the store.
 * The live WS feed travels over a separate connection and often lands first — for a terminal Task
 * the server even emits its settle events before responding — so a response that isn't newer than
 * what the store already holds is stale and is dropped entirely rather than clobbering the newer
 * state (e.g. flipping a Project back to 'developing' after "Mark completed" already settled it).
 * Otherwise the Task is recorded, and its Project optimistically mirrors it the same way the
 * server's own 'project' WorkerEvent will shortly confirm: 'developing' only while the Task itself
 * still is. `started` marks a response that created the Task, which also bumps the Project's count
 * and makes it the Project's latest Task.
 */
/**
 * True when `incoming` is not newer than `existing` by `updatedAt` — the guard against a fetch or
 * action response landing after (and being older than) a WS event that already advanced the same
 * record. Shared by `mergeTaskResponse` and the two bulk-list fetches further down
 * (`loadProjectTasks`, `loadWorkflowRunsForProject`): a slow/out-of-order GET is exposed to the exact
 * same race the WS feed already is, and blindly replacing the store's copy would regress it — which,
 * for a Task/WorkflowRun that's already settled, can make it look like it settles a *second* time
 * once a later event/fetch brings it back to the correct status (see `lib/taskSounds.ts`, which
 * trusts a status transition it observes in the store to mean the real thing happened again).
 */
function isStale(existing: { updatedAt: string } | undefined, incoming: { updatedAt: string }): boolean {
  return existing !== undefined && existing.updatedAt >= incoming.updatedAt;
}

function mergeTaskResponse(
  set: (fn: (state: WorldState) => Partial<WorldState>) => void,
  task: ServerTask,
  started: boolean,
): void {
  set((state) => {
    const known = state.tasksById[task.id];
    if (isStale(known, task)) return {};
    const developing = task.status === 'developing';
    return {
      tasksById: { ...state.tasksById, [task.id]: toTaskData(task) },
      ...(started ? { lastTaskIdByProject: { ...state.lastTaskIdByProject, [task.projectId]: task.id } } : {}),
      projects: state.projects.map((p) =>
        p.id !== task.projectId ? p : {
          ...p,
          ...(developing ? { status: 'developing' as const, activeTaskId: task.id } : {}),
          ...(started ? { taskCount: p.taskCount + 1 } : {}),
        },
      ),
    };
  });
}

/**
 * Folds a freshly-started CommandRun into `commandRunsById`/`commandRunIdsByProject` — shared by
 * `runCommand`, `syncProjectBranch`, and `runAdHocCommand`, which all just start a run and need the
 * same "show up live, and in history too if it's already loaded" bookkeeping (mirrors
 * `mergeTaskResponse`'s equivalent role for a just-started Task).
 */
function mergeRunStart(set: (fn: (state: WorldState) => Partial<WorldState>) => void, run: CommandRun): void {
  set((state) => ({
    commandRunsById: { ...state.commandRunsById, [run.id]: run },
    commandRunIdsByProject: state.commandRunIdsByProject[run.projectId]
      ? { ...state.commandRunIdsByProject, [run.projectId]: [run.id, ...state.commandRunIdsByProject[run.projectId]!] }
      : state.commandRunIdsByProject,
  }));
}

function patchPrActions(set: StoreSet, projectId: string, fn: (actions: PrActionState) => Partial<PrActionState>): void {
  set((state) => {
    const actions = state.prActionsByProject[projectId] ?? EMPTY_PR_ACTIONS;
    return { prActionsByProject: { ...state.prActionsByProject, [projectId]: { ...actions, ...fn(actions) } } };
  });
}

/** Folds a Project the daemon just answered with into the store, keeping its plot. */
function applyServerProject(set: StoreSet, project: ServerProject): void {
  set((state) => ({ projects: state.projects.map((p) => (p.id === project.id ? toProjectData(project, p.position, p.sync) : p)) }));
}

/** Reads one Project again (its branch's sync reading included). A failure leaves the store as it is: the daemon's own live events catch up. */
async function refreshProject(set: StoreSet, projectId: string): Promise<void> {
  try { applyServerProject(set, await serverApi.getProject(projectId)); } catch { /* Not worth an error: nothing the person asked for failed. */ }
}

/**
 * Folds a WorkflowRunRecord returned by an approve/request-changes/loop/retry/stop action's own HTTP
 * response into `workflowRunsByProject` (replacing the matching run, or prepending it if this is the
 * first this session has seen for its project) and, if that run's detail is currently loaded, into
 * `workflowRunDetails[run.id].run` too — the same "apply the server's returned record back into local
 * state" shape `mergeTaskResponse`/`mergeRunStart` use, and the same replace-or-prepend logic
 * `mergeWorkerEvent`'s 'workflowRun' case applies to a live push of the same record.
 */
function applyWorkflowRunUpdate(set: StoreSet, run: WorkflowRunRecord): void {
  set((state) => {
    const existing = state.workflowRunsByProject[run.projectId] ?? [];
    const runs = existing.some((r) => r.id === run.id) ? existing.map((r) => (r.id === run.id ? run : r)) : [run, ...existing];
    const detail = state.workflowRunDetails[run.id];
    return {
      workflowRunsByProject: { ...state.workflowRunsByProject, [run.projectId]: runs },
      ...(detail ? { workflowRunDetails: { ...state.workflowRunDetails, [run.id]: { ...detail, run } } } : {}),
    };
  });
}

/**
 * Which form shows each action's failure. An action not listed here has no in-place display, so its
 * failure is always a notification; a listed one's failure goes to its scope while a form showing
 * that scope is open (see `openErrorScope`), and becomes a notification once the form has closed.
 */
export interface AnalyticsState {
  open: boolean;
  /** The agent shown; null until the list is loaded, and while no agent is configured. */
  agentId: string | null;
  /** Local midnight of the day shown. */
  dayStart: number;
  /** Null until first loaded. */
  agents: AnalyticsAgent[] | null;
  day: AgentDayView | null;
  steps: AgentStepsView | null;
  loading: boolean;
  /** Why the last load or refresh failed. Whatever was loaded before stays on screen. */
  error: string | null;
  refreshPhase: RefreshPhase;
}

const CLOSED_ANALYTICS: AnalyticsState = { open: false, agentId: null, dayStart: 0, agents: null, day: null, steps: null, loading: false, error: null, refreshPhase: 'idle' };

const ACTION_SCOPE: Record<string, ErrorScope> = {
  addProject: 'newProject',
  addExecutor: 'agents',
  updateExecutor: 'agents',
  deleteExecutor: 'agents',
  createCommand: 'commands',
  updateCommand: 'commands',
  runCommand: 'quickLook',
  runAdHocCommand: 'quickLook',
  createCatalogAgent: 'catalog',
  updateCatalogAgent: 'catalog',
  deleteCatalogAgent: 'catalog',
  toggleCatalogAgentEnabled: 'catalog',
  uploadCatalogAgentFile: 'catalog',
  createCatalogSkill: 'catalog',
  updateCatalogSkill: 'catalog',
  deleteCatalogSkill: 'catalog',
  toggleCatalogSkillEnabled: 'catalog',
  uploadCatalogSkillZip: 'catalog',
  addCatalogSkillFile: 'catalog',
  removeCatalogSkillFile: 'catalog',
  startCatalogSkillInstall: 'catalog',
  createCatalogWorkflow: 'catalog',
  updateCatalogWorkflow: 'catalog',
  deleteCatalogWorkflow: 'catalog',
  approveWorkflowRun: 'workflowRun',
  requestChangesWorkflowRun: 'workflowRun',
  decideWorkflowRunLoop: 'workflowRun',
  retryWorkflowStep: 'workflowRun',
  stopWorkflowRun: 'workflowRun',
  resumeWorkflowRun: 'workflowRun',
  startTestingSetup: 'testing',
  approveTestingSetup: 'testingDecision',
  reviseTestingSetup: 'testingDecision',
  rejectTestingSetup: 'testingDecision',
  stopTask: 'taskActions',
  createPlanItem: 'taskActions',
  updatePlanItem: 'taskActions',
  reorderPlanItems: 'taskActions',
  deletePlanItem: 'taskActions',
  setAutoMerge: 'taskActions',
  retryAutoMerge: 'taskActions',
  setDependencies: 'taskActions',
  setUiPlanningWaits: 'taskActions',
  cancelWaiting: 'taskActions',
  removeFromWaitingList: 'taskActions',
  chainPlanningGroup: 'taskActions',
};

/** Marks `defaultId` as the one default agent; an id that is not (yet) in the list leaves no default until the next list read. */
export function applyDefaultExecutor(executors: ExecutorProfile[], defaultId: string): ExecutorProfile[] {
  return executors.map((executor) => (executor.isDefault === (executor.id === defaultId) ? executor : { ...executor, isDefault: executor.id === defaultId }));
}

/** The tabs of the global Settings panel. */
export type GlobalSettingsSection = 'agents' | 'preferences' | 'github' | 'google-seo';

type StoreSet = (patch: Partial<WorldState> | ((state: WorldState) => Partial<WorldState>)) => void;

/** Sends a failed action's message to its open form, or else to a notification. */
export function reportError(set: StoreSet, get: () => WorldState, error: unknown, context: ErrorContext & { action: string }): void {
  set(routeError(get(), errorMessage(error), context, ACTION_SCOPE[context.action], new Date()));
}

/** Per-project state for 2D slot moves: saves go out one at a time, and a failure restores the last position the server confirmed. */
const pendingMoves = new Map<string, number>();
const moveQueues = new Map<string, Promise<unknown>>();
const confirmedPositions = new Map<string, [number, number]>();

/** Runs whose "opened" call is in flight, so opening the same log twice makes one call. */
const markingOpened = new Set<string>();

/** Persists a legacy-position repair. The local view already shows the repaired place, so a rejection only notifies. */
function saveRepairedPosition(set: StoreSet, get: () => WorldState, id: string, position: [number, number]): void {
  serverApi.updateProjectPosition(id, position).catch((error) => reportError(set, get, error, { action: 'repairProjectPosition', projectId: id }));
}

/** Wraps every scoped action so a retry starts with its scope's previous failure cleared. */
function clearingScopeOnCall(set: StoreSet, state: WorldState): WorldState {
  const wrapped: Record<string, unknown> = { ...state };
  for (const [action, scope] of Object.entries(ACTION_SCOPE)) {
    const original = (state as unknown as Record<string, (...args: unknown[]) => unknown>)[action];
    if (!original) continue;
    wrapped[action] = (...args: unknown[]) => {
      set((current) => (current.formErrors[scope] === undefined ? {} : { formErrors: { ...current.formErrors, [scope]: undefined } }));
      return original(...args);
    };
  }
  return wrapped as unknown as WorldState;
}

/** Runs one WorkflowRun action against the daemon and folds the returned run in. Resolves true on success, false (a failure goes to the action's form or a notification) on failure. */
async function callWorkflowRun(set: StoreSet, get: () => WorldState, action: string, call: () => Promise<WorkflowRunRecord>): Promise<boolean> {
  try {
    applyWorkflowRunUpdate(set, await call());
    return true;
  } catch (error) {
    reportError(set, get, error, { action });
    return false;
  }
}

export const useWorldStore = create<WorldState>((set, get) => clearingScopeOnCall(set, {
  ...createSchedulesSlice(set, get),
  ...createAgentSessionsSlice(set),
  ...createConnectionsSlice(set, get),
  projects: [],
  tasksById: {},
  lastTaskIdByProject: {},
  reviewedTaskIds: readReviewedTaskIds(),
  transcriptsByTask: {},
  planByProject: {},
  planLiveChangesByProject: {},
  planLiveRevisionByProject: {},
  taskLiveChangesByProject: {},
  taskLiveRevisionByProject: {},
  workspaceProjectId: null,
  analytics: CLOSED_ANALYTICS,
  workspaceTab: 'tasks',
  prHighlightRequest: null,
  workspaceDetailTaskId: null,
  workspaceCardDetailRequest: null,
  workspaceTasksFilter: null,
  workspaceTestRunRequest: null,
  footerCommandLogRunId: null,
  workspaceSettingsSection: 'general',
  viewMode: readViewMode(),
  catalogOpen: false,
  taskIdsByProject: {},
  executors: [],
  commandsByProject: {},
  commandRunsById: {},
  commandRunIdsByProject: {},
  catalogAgents: [],
  catalogSkills: [],
  catalogWorkflows: [],
  planItemQueueByProject: {},
  workflowRunsByProject: {},
  prActionsByProject: {},
  githubAccounts: null,
  githubAccountsLoading: false,
  settingsSection: null,
  googleOAuthClientSaved: null,
  githubAccountChecks: {},
  workflowRunDetails: {},
  testRunsById: {},
  seoJobsById: {},
  settledSeoJobIds: {},
  contentJobsById: {},
  settledContentJobIds: {},
  seoTabRequest: null,
  testRunDetailsById: {},
  testRunLogsById: {},
  catalogInstallRuns: {},
  notificationsById: {},
  notificationsLoaded: false,
  notificationCenterOpen: false,
  appUpdate: null,
  liveTerminalSessions: [],
  wsConnected: true,
  lastKnownAppUpdatePhase: null,
  appUpdateReloadDismissedCommit: null,
  selectedId: null,
  draggingId: null,
  controlsEnabled: true,
  loaded: false,
  errorNotificationsById: {},
  errorNotificationSeq: 0,
  openErrorScopes: {},
  formErrors: {},

  openErrorScope: (scope) => {
    set((state) => ({ openErrorScopes: { ...state.openErrorScopes, [scope]: (state.openErrorScopes[scope] ?? 0) + 1 }, formErrors: { ...state.formErrors, [scope]: undefined } }));
    return () => set((state) => ({ openErrorScopes: { ...state.openErrorScopes, [scope]: Math.max(0, (state.openErrorScopes[scope] ?? 0) - 1) } }));
  },

  loadProjects: async () => {
    try {
      const serverProjects = await serverApi.listProjects();
      const repairs = repairPositions(serverProjects);
      const repaired = new Map(repairs.map((r) => [r.id, r.position]));
      const projects = serverProjects.map((project) => {
        const position = repaired.get(project.id) ?? project.position ?? CITY_POSITION;
        return toProjectData(project, position);
      });
      for (const { id, position } of repairs) saveRepairedPosition(set, get, id, position);
      set({ projects, loaded: true });
      void get().loadBuildingTypes();
      void get().loadSeoJobs();
      void get().loadContentJobs();
      // Building labels show each project's task progress and the status footer totals every board, so
      // fetch each project's plan, tasks and runs up front — live events then keep them current (see
      // mergeWorkerEvent). This also reconciles every board after a reconnect.
      for (const project of projects) {
        void get().loadPlan(project.id);
        void get().loadProjectTasks(project.id);
        void get().loadWorkflowRunsForProject(project.id);
        void get().loadRunningRuns(project.id);
        void get().loadUnopenedFailures(project.id);
      }
    } catch (error) {
      set({ loaded: true });
      reportError(set, get, error, { action: 'loadProjects' });
    }
  },

  loadExecutors: async () => {
    try {
      const executors = await serverApi.listExecutors();
      set({ executors });
    } catch (error) {
      reportError(set, get, error, { action: 'loadExecutors' });
    }
  },

  setDefaultExecutor: async (executorId, options) => {
    try {
      const { defaultExecutorId } = await serverApi.setDefaultExecutor(executorId);
      set((state) => ({ executors: applyDefaultExecutor(state.executors, defaultExecutorId) }));
      return null;
    } catch (error) {
      if (options?.notify) reportError(set, get, error, { action: 'setDefaultExecutor' });
      return errorMessage(error);
    }
  },

  addExecutor: async (input) => {
    try {
      const created = await serverApi.createExecutor(input);
      // POST returns the bare configured row — no Task has run for it yet, so its usage starts at zero.
      set((state) => ({ executors: [...state.executors, { ...created, usage: { totalTokens: 0, taskCount: 0 } }] }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'addExecutor' });
      return false;
    }
  },

  updateExecutor: async (id, patch) => {
    try {
      const updated = await serverApi.updateExecutor(id, patch);
      set((state) => ({ executors: state.executors.map((e) => (e.id === id ? { ...e, ...updated } : e)) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'updateExecutor' });
      return false;
    }
  },

  deleteExecutor: async (id) => {
    try {
      await serverApi.deleteExecutor(id);
      set((state) => ({ executors: state.executors.filter((e) => e.id !== id) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'deleteExecutor' });
      return false;
    }
  },

  connectLiveUpdates: () => serverApi.connectLiveUpdates(
    (event) => {
      set((state) => mergeWorkerEvent(state, event));
      if (event.type === 'studioAsset' || event.type === 'contentRetro' || event.type === 'contentImportSession') useContentStore.getState().applyStudioEvent(event);
      if (event.type === 'remotionStudio') useContentStore.getState().applyRemotionEvent(event);
      // Fire-and-forget: refresh in the background so the footer's usage strip updates the moment a
      // running Task reports fresh limits, rather than waiting up to 30s for App.tsx's next poll.
      if (isUsageLimitLogEvent(event)) void get().loadExecutors();
      // Same idea for a settled successful skill install — the new skill only shows up in
      // catalogSkills once this refetches, since the WS event itself only carries the install run.
      if (isSkillInstallSuccessEvent(event)) void get().fetchCatalog();
    },
    // loadProjects reloads every project's plan, tasks and runs too, recovering events missed while
    // disconnected (planning-tool edits, session deletion, run progress) on every board, open or not.
    // checkAppUpdateNow does the same for a tab that disconnected through a server-path restart —
    // it picks up the final AppUpdateStatus promptly rather than waiting for the next poll.
    () => {
      set({ wsConnected: true });
      void get().loadProjects();
      void get().loadNotifications();
      void get().checkAppUpdateNow();
    },
    () => set({ wsConnected: false }),
  ),

  loadTranscript: async (taskId) => {
    try {
      const context = await serverApi.getTaskTranscript(taskId);
      set((state) => {
        const live = state.transcriptsByTask[taskId];
        // A concurrent live 'log' event can race ahead of this fetch (see mergeWorkerEvent) — the
        // fetched list is only ever stale, never wrong, so prefer whichever is longer rather than
        // letting a slow response regress turns already appended live.
        if (live && live.length > context.turns.length) return {};
        return { transcriptsByTask: { ...state.transcriptsByTask, [taskId]: context.turns } };
      });
    } catch (error) {
      // A task with no transcript yet is an empty session, not a failure.
      if (error instanceof ApiError && error.status === 404 && get().tasksById[taskId]) {
        set((state) => (state.transcriptsByTask[taskId] ? {} : { transcriptsByTask: { ...state.transcriptsByTask, [taskId]: [] } }));
        return;
      }
      reportError(set, get, error, { action: 'loadTranscript' });
    }
  },

  buildingTypes: [],
  newBuildingField: null,

  loadBuildingTypes: async () => {
    try {
      set({ buildingTypes: await serverApi.listBuildingTypes() });
    } catch (error) {
      reportError(set, get, error, { action: 'loadBuildingTypes' });
    }
  },

  addProject: async (name, repositoryUrl, typeId, siteUrl, timezone) => {
    set({ newBuildingField: null });
    const { projects } = get();
    const position = nearestFreePlot(...CITY_POSITION, projects.map((p) => ({ x: p.position[0], z: p.position[1] })));
    if (!position) return false;
    try {
      const created = await serverApi.createProject(name, position, repositoryUrl, typeId, siteUrl, timezone);
      set((state) => ({
        projects: [...state.projects, toProjectData(created, created.position ?? position)],
        planByProject: { ...state.planByProject, [created.id]: { items: [] } },
        selectedId: created.id,
      }));
      return true;
    } catch (error) {
      set({ newBuildingField: createErrorFor(error).field });
      reportError(set, get, error, { action: 'addProject' });
      return false;
    }
  },

  moveProjectToSlot: async (id, slot) => {
    const { projects } = get();
    const project = projects.find((p) => p.id === id);
    const asPositioned = projects.map((p) => ({ id: p.id, position: p.position }));
    if (!project || !canDrop(asPositioned, id, slot)) return false;
    const target = plotOfSlot(slot);
    // With no move in flight the current position is the one the server holds; otherwise keep the
    // last confirmed one, so a rejected move never restores another move's unconfirmed target.
    if (!pendingMoves.has(id)) confirmedPositions.set(id, project.position);
    pendingMoves.set(id, (pendingMoves.get(id) ?? 0) + 1);
    set({ projects: projects.map((p) => (p.id === id ? { ...p, position: target } : p)) });
    const previousSave = moveQueues.get(id) ?? Promise.resolve();
    const save = previousSave.catch(() => undefined).then(() => serverApi.updateProjectPosition(id, target));
    moveQueues.set(id, save.catch(() => undefined));
    try {
      await save;
      confirmedPositions.set(id, target);
      return true;
    } catch (error) {
      const confirmed = confirmedPositions.get(id) ?? project.position;
      // Only undo our own optimistic move; a newer move or live update for this project stays.
      set((state) => ({ projects: state.projects.map((p) => (p.id === id && p.position[0] === target[0] && p.position[1] === target[1] ? { ...p, position: confirmed } : p)) }));
      reportError(set, get, error, { action: 'moveProjectToSlot', projectId: id });
      return false;
    } finally {
      const left = (pendingMoves.get(id) ?? 1) - 1;
      if (left === 0) { pendingMoves.delete(id); moveQueues.delete(id); confirmedPositions.delete(id); } else pendingMoves.set(id, left);
    }
  },

  moveProject: (id, x, z) => {
    const state = get();
    const occupied = state.projects.filter((p) => p.id !== id).map((p) => ({ x: p.position[0], z: p.position[1] }));
    const position = nearestFreePlot(x, z, occupied);
    if (!position) return;
    set({ projects: state.projects.map((p) => (p.id === id ? { ...p, position } : p)) });
    // Fire-and-forget: the move already reads back correctly locally; a failed persist just
    // means the position reverts to the server's last-known one on the next reload.
    serverApi.updateProjectPosition(id, position).catch((error) => reportError(set, get, error, { action: 'moveProject', projectId: id }));
  },

  syncProjectBranch: async (id) => {
    try {
      const run = await serverApi.syncProjectBranch(id);
      mergeRunStart(set, run);
      return run;
    } catch (error) {
      reportError(set, get, error, { action: 'syncProjectBranch', projectId: id });
      return undefined;
    }
  },

  setProjectWorkflow: async (projectId, workflowId) => {
    try {
      const updated = await serverApi.setProjectWorkflow(projectId, workflowId);
      set((state) => ({
        projects: state.projects.map((p) => (p.id === projectId ? toProjectData(updated, p.position, p.sync) : p)),
      }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'setProjectWorkflow', projectId });
      return false;
    }
  },


  loadPrMergeStates: async (projectId, pullRequests, force = false) => {
    const patch = (fn: (actions: PrActionState) => Partial<PrActionState>) => patchPrActions(set, projectId, fn);
    const listed = new Set(pullRequests.map((pr) => pr.number));
    const numbers = mergeStatesToLoad(pullRequests, get().prActionsByProject[projectId]?.mergeStates ?? {}, force);
    const keys = new Map(pullRequests.map((pr) => [pr.number, pr.updatedAt]));
    patch((actions) => {
      const kept = Object.fromEntries(Object.entries(actions.mergeStates).filter(([number]) => listed.has(Number(number))));
      for (const number of numbers) kept[number] = { key: keys.get(number)!, loading: true, state: kept[number]?.state ?? null, error: null };
      return { mergeStates: kept };
    });
    await Promise.all(numbers.map(async (number) => {
      const response = await serverApi.pullRequestMergeState(projectId, number)
        .catch((error): MergeStateResponse => ({ number, checkedAt: '', mergeState: null, error: errorMessage(error) }));
      patch((actions) => ({ mergeStates: { ...actions.mergeStates, [number]: applyMergeStateResponse(keys.get(number)!, response) } }));
    }));
  },

  mergePullRequest: async (projectId, pr, options = {}) => {
    const patch = (fn: (actions: PrActionState) => Partial<PrActionState>) => patchPrActions(set, projectId, fn);
    patch((actions) => ({
      busy: { ...actions.busy, [pr.number]: 'merging' },
      held: { ...actions.held, [pr.number]: pr },
      rowErrors: without(actions.rowErrors, pr.number),
    }));
    const release = () => patch((actions) => ({ busy: without(actions.busy, pr.number), held: without(actions.held, pr.number) }));
    try {
      const response = await serverApi.mergePullRequest(projectId, pr.number, options);
      if (response.outcome === 'resolving') {
        applyWorkflowRunUpdate(set, response.run);
        void get().loadPlan(projectId);
        void get().loadProjectTasks(projectId);
      }
      if (response.outcome === 'merged') patch(() => ({ notice: mergeNotice(pr, response) }));
      release();
      if (response.outcome === 'merged') {
        const project = get().projects.find((p) => p.id === projectId);
        await Promise.all([
          prReadings.fetch(projectId, { provider: gitProviderOf(project ?? {}), force: true }),
          refreshProject(set, projectId),
        ]);
      } else {
        // The daemon read the PR afresh for this click, so what the row shows may be out of date.
        void get().loadPrMergeStates(projectId, [pr], true);
      }
      return response;
    } catch (error) {
      patch((actions) => ({ rowErrors: { ...actions.rowErrors, [pr.number]: { message: errorMessage(error), retry: 'merge' } } }));
      release();
      void get().loadPrMergeStates(projectId, [pr], true);
      return null;
    }
  },

  checkoutPullRequest: async (projectId, pr) => {
    const patch = (fn: (actions: PrActionState) => Partial<PrActionState>) => patchPrActions(set, projectId, fn);
    patch((actions) => ({ busy: { ...actions.busy, [pr.number]: 'checking-out' }, rowErrors: without(actions.rowErrors, pr.number), returnError: null }));
    try {
      applyServerProject(set, await serverApi.checkoutPullRequest(projectId, pr.number));
      void get().loadPlan(projectId);
      return true;
    } catch (error) {
      patch((actions) => ({ rowErrors: { ...actions.rowErrors, [pr.number]: { message: errorMessage(error), retry: 'checkout' } } }));
      return false;
    } finally {
      patch((actions) => ({ busy: without(actions.busy, pr.number) }));
    }
  },

  returnFromPullRequest: async (projectId, branch) => {
    const patch = (fn: (actions: PrActionState) => Partial<PrActionState>) => patchPrActions(set, projectId, fn);
    patch(() => ({ returning: true }));
    try {
      applyServerProject(set, await serverApi.returnFromPullRequest(projectId, branch));
      patch(() => ({ returnError: null }));
      void get().loadPlan(projectId);
      return true;
    } catch (error) {
      const offered = error instanceof ApiError && typeof error.details.defaultBranch === 'string' ? error.details.defaultBranch : null;
      patch(() => ({ returnError: { message: errorMessage(error), defaultBranch: offered } }));
      return false;
    } finally {
      patch(() => ({ returning: false }));
    }
  },

  dismissPrNotice: (projectId) => patchPrActions(set, projectId, () => ({ notice: null })),

  setProjectGitProvider: async (projectId, gitProvider) => {
    try {
      const updated = await serverApi.setProjectGitProvider(projectId, gitProvider);
      set((state) => ({
        projects: state.projects.map((p) => (p.id === projectId ? toProjectData(updated, p.position, p.sync) : p)),
      }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'setProjectGitProvider', projectId });
      return false;
    }
  },

  renameProject: async (projectId, name) => {
    const updated = await serverApi.renameProject(projectId, name);
    set((state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? toProjectData(updated, p.position, p.sync) : p)),
    }));
  },

  deleteProject: async (projectId) => {
    await serverApi.deleteProject(projectId);
    set((state) => removeProjectFromState(state, projectId));
  },

  loadGithubAccounts: async () => {
    set({ githubAccountsLoading: true });
    try {
      set({ githubAccounts: await serverApi.githubAccounts() });
    } catch (error) {
      reportError(set, get, error, { action: 'loadGithubAccounts' });
    } finally {
      set({ githubAccountsLoading: false });
    }
  },

  openSettings: (section = 'agents') => set({ settingsSection: section }),
  closeSettings: () => set({ settingsSection: null }),

  loadGoogleOAuthClient: async () => {
    try {
      set({ googleOAuthClientSaved: (await serverApi.googleOAuthClient()).saved });
    } catch (error) {
      reportError(set, get, error, { action: 'loadGoogleOAuthClient' });
    }
  },

  saveGoogleOAuthClient: async (clientId, clientSecret) => {
    try {
      await serverApi.saveGoogleOAuthClient(clientId.trim(), clientSecret.trim());
      await get().loadGoogleOAuthClient();
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  },

  removeGoogleOAuthClient: async () => {
    try {
      await serverApi.removeGoogleOAuthClient();
      set({ googleOAuthClientSaved: false });
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  },

  saveGithubIdentity: async (login, identity) => {
    try {
      set({ githubAccounts: await serverApi.saveGithubIdentity(login, identity) });
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'saveGithubIdentity' });
      return false;
    }
  },

  resetGithubIdentity: async (login) => {
    try {
      set({ githubAccounts: await serverApi.resetGithubIdentity(login) });
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'resetGithubIdentity' });
      return false;
    }
  },

  checkProjectGithubAccount: async (projectId) => {
    set((state) => ({ githubAccountChecks: { ...state.githubAccountChecks, [projectId]: 'checking' } }));
    try {
      const check = await serverApi.checkProjectGithubAccount(projectId);
      set((state) => ({ githubAccountChecks: { ...state.githubAccountChecks, [projectId]: check } }));
    } catch (error) {
      set((state) => { const { [projectId]: _dropped, ...rest } = state.githubAccountChecks; return { githubAccountChecks: rest }; });
      reportError(set, get, error, { action: 'checkProjectGithubAccount', projectId });
    }
  },

  setProjectGithubAccount: async (projectId, githubAccount) => {
    try {
      const updated = await serverApi.setProjectGithubAccount(projectId, githubAccount);
      set((state) => ({
        projects: state.projects.map((p) => (p.id === projectId ? toProjectData(updated, p.position, p.sync) : p)),
        githubAccountChecks: Object.fromEntries(Object.entries(state.githubAccountChecks).filter(([id]) => id !== projectId)),
      }));
      if (githubAccount) void get().checkProjectGithubAccount(projectId);
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'setProjectGithubAccount', projectId });
      return false;
    }
  },

  setProjectAutoPull: async (projectId, autoPullEnabled) => {
    const previous = get().projects.find((p) => p.id === projectId)?.autoPullEnabled;
    const apply = (value: boolean | undefined) => set((state) => ({ projects: state.projects.map((p) => (p.id === projectId ? { ...p, autoPullEnabled: value } : p)) }));
    apply(autoPullEnabled);
    try {
      const updated = await serverApi.setProjectAutoPull(projectId, autoPullEnabled);
      set((state) => ({ projects: state.projects.map((p) => (p.id === projectId ? toProjectData(updated, p.position, p.sync) : p)) }));
      return true;
    } catch (error) {
      apply(previous);
      reportError(set, get, error, { action: 'setProjectAutoPull', projectId });
      return false;
    }
  },

  selectBuilding: (id) => set({ selectedId: id }),
  setDragging: (id) => set({ draggingId: id }),
  setControlsEnabled: (enabled) => set({ controlsEnabled: enabled }),

  startTask: async (id, description, executorId, autonomy) => {
    try {
      const task = await serverApi.startTask(id, description, executorId, autonomy);
      mergeTaskResponse(set, task, true);
    } catch (error) {
      reportError(set, get, error, { action: 'startTask', projectId: id });
    }
  },

  reviewTask: (taskId) => set((state) => ({
    reviewedTaskIds: { ...state.reviewedTaskIds, [taskId]: true },
  })),

  stopTask: async (taskId) => {
    try {
      const task = await serverApi.stopTask(taskId);
      set((state) => ({ tasksById: { ...state.tasksById, [task.id]: toTaskData(task) } }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'stopTask', projectId: get().tasksById[taskId]?.projectId });
      return false;
    }
  },

  setViewMode: (mode) => {
    writeViewMode(mode);
    set({ viewMode: mode });
  },

  openWorkspace: (projectId) => {
    set((state) => {
      const latestTaskId = projectId ? state.lastTaskIdByProject[projectId] : undefined;
      const latestTask = latestTaskId ? state.tasksById[latestTaskId] : undefined;
      return {
        workspaceProjectId: projectId,
        // Opening (or closing) the Project workspace always closes the Catalog modal too — the two
        // are mutually exclusive full-screen surfaces, same as openCatalog closes this one.
        catalogOpen: false,
        // Reset to a clean tab/detail/settings-section state on every call — this used to happen
        // via `key={workspaceProjectId}` remounting ProjectWorkspaceModal's content; now that this
        // state lives in the store (so `openNotificationTarget` can deep-link into it from outside
        // that component), it needs an explicit reset here instead. `openNotificationTarget`
        // overrides these right after calling this, for a deep link into a non-default tab.
        workspaceTab: 'tasks',
        workspaceDetailTaskId: null,
        // An unapplied footer request must not outlive the popup it was made for.
        workspaceCardDetailRequest: null,
        workspaceTasksFilter: null,
        workspaceTestRunRequest: null,
        prHighlightRequest: null,
        workspaceSettingsSection: 'general',
        reviewedTaskIds: latestTaskId && latestTask?.status === 'done'
          ? { ...state.reviewedTaskIds, [latestTaskId]: true }
          : state.reviewedTaskIds,
      };
    });
    if (projectId) {
      void get().loadPlan(projectId);
      void get().loadProjectTasks(projectId);
    }
  },

  openWorkspaceCardDetail: (projectId, detail) => {
    get().openWorkspace(projectId);
    set({ notificationCenterOpen: false, workspaceCardDetailRequest: { detail: resolveCardDetail(detail, projectId, get()) } });
  },
  openWorkspacePendingTasks: (projectId) => {
    get().openWorkspace(projectId);
    set({ notificationCenterOpen: false, workspaceTasksFilter: 'pending' });
  },
  setWorkspaceTasksFilter: (filter) => set({ workspaceTasksFilter: filter }),
  clearWorkspaceCardDetailRequest: () => set({ workspaceCardDetailRequest: null }),
  clearWorkspaceTestRunRequest: () => set({ workspaceTestRunRequest: null }),
  openFooterCommandLog: async (runId) => {
    try {
      // Read fresh: a run that just finished shows its finished result, and one the store never saw gets its output.
      const run = await serverApi.getCommandRun(runId);
      set((state) => ({ commandRunsById: { ...state.commandRunsById, [run.id]: run }, footerCommandLogRunId: run.id }));
    } catch (error) {
      reportError(set, get, error, { action: 'openFooterCommandLog' });
    }
  },
  closeFooterCommandLog: () => set({ footerCommandLogRunId: null }),
  openTestRunFromFooter: async (projectId, runId) => {
    let exists = true;
    try { await serverApi.getTestRun(runId); } catch { exists = false; }
    if (exists) void get().markTestRunOpened(runId);
    get().openWorkspace(projectId);
    set({ notificationCenterOpen: false, workspaceTab: 'testing', workspaceTestRunRequest: { runId: exists ? runId : null } });
  },
  openPullRequestFromFooter: (projectId, number) => {
    if (!get().projects.some((project) => project.id === projectId)) return;
    get().openWorkspace(projectId);
    set({ notificationCenterOpen: false, workspaceTab: 'pr', prHighlightRequest: { projectId, number } });
  },
  clearPrHighlightRequest: () => set({ prHighlightRequest: null }),
  openSeoFromFooter: (projectId, tab) => {
    if (!get().projects.some((project) => project.id === projectId)) return;
    get().openWorkspace(projectId);
    set({ notificationCenterOpen: false, seoTabRequest: { projectId, tab } });
  },
  clearSeoTabRequest: () => set({ seoTabRequest: null }),
  stopSeoCrawlFromFooter: async (projectId) => {
    try { await serverApi.seoStopCrawl(projectId); } catch (error) { reportError(set, get, error, { action: 'stopSeoCrawlFromFooter', projectId }); }
  },
  loadSeoJobs: async () => {
    try {
      const { jobs } = await serverApi.seoRunningJobs();
      set((state) => ({ seoJobsById: Object.fromEntries(jobs.filter((job) => !state.settledSeoJobIds[job.id]).map((job) => [job.id, job])) }));
    } catch (error) {
      reportError(set, get, error, { action: 'loadSeoJobs' });
    }
  },
  loadContentJobs: async () => {
    try {
      const { jobs } = await serverApi.contentRunningJobs();
      set((state) => ({ contentJobsById: Object.fromEntries(jobs.filter((job) => !state.settledContentJobIds[job.id]).map((job) => [job.id, job])) }));
    } catch (error) {
      reportError(set, get, error, { action: 'loadContentJobs' });
    }
  },
  stopRenderFromFooter: async (projectId, conceptId, renderId) => {
    try { await serverApi.contentStopRender(projectId, conceptId, renderId); } catch (error) { reportError(set, get, error, { action: 'stopRenderFromFooter', projectId }); }
  },
  stopImageRenderFromFooter: async (projectId, assetId, renderId) => {
    try { await serverApi.contentStopImageRender(projectId, assetId, renderId); } catch (error) { reportError(set, get, error, { action: 'stopImageRenderFromFooter', projectId }); }
  },
  stopThumbnailRenderFromFooter: async (projectId, assetId, renderId) => {
    try { await serverApi.contentStopThumbnailRender(projectId, assetId, renderId); } catch (error) { reportError(set, get, error, { action: 'stopThumbnailRenderFromFooter', projectId }); }
  },
  stopInsightsFromFooter: async (projectId) => {
    try { await serverApi.contentStopInsights(projectId); } catch (error) { reportError(set, get, error, { action: 'stopInsightsFromFooter', projectId }); }
  },
  stopStudioFromFooter: async (projectId) => {
    try { await serverApi.contentStopStudio(projectId); } catch (error) { reportError(set, get, error, { action: 'stopStudioFromFooter', projectId }); }
  },
  loadRunningRuns: async (projectId) => {
    try {
      const [commandRuns, runningTests, queuedTests] = await Promise.all([
        serverApi.listCommandRuns(projectId, 'running'),
        serverApi.listTestRuns(projectId, 100, 'running'),
        serverApi.listTestRuns(projectId, 100, 'queued'),
      ]);
      const commands = mergeRunningLoad(get().commandRunsById, commandRuns, projectId);
      const tests = mergeRunningLoad(get().testRunsById, [...runningTests.runs, ...queuedTests.runs], projectId);
      set({ commandRunsById: commands.merged, testRunsById: tests.merged });
      await Promise.all([
        ...commands.staleIds.map((id) => serverApi.getCommandRun(id).then(
          (run) => set((state) => ({ commandRunsById: { ...state.commandRunsById, [id]: run } })),
          () => set((state) => ({ commandRunsById: omitKey(state.commandRunsById, id) })),
        )),
        ...tests.staleIds.map((id) => serverApi.getTestRun(id).then(
          (run) => set((state) => ({ testRunsById: { ...state.testRunsById, [id]: run } })),
          () => set((state) => ({ testRunsById: omitKey(state.testRunsById, id) })),
        )),
      ]);
    } catch (error) {
      reportError(set, get, error, { action: 'loadRunningRuns', projectId });
    }
  },
  loadUnopenedFailures: async (projectId) => {
    try {
      const [commandRuns, testPage] = await Promise.all([
        serverApi.listUnopenedCommandFailures(projectId),
        serverApi.listUnopenedTestFailures(projectId),
      ]);
      set((state) => ({
        commandRunsById: mergeUnopenedLoad(state.commandRunsById, commandRuns),
        testRunsById: mergeUnopenedLoad(state.testRunsById, testPage.runs),
      }));
    } catch (error) {
      reportError(set, get, error, { action: 'loadUnopenedFailures', projectId });
    }
  },
  markCommandRunOpened: async (runId) => {
    if (!get().commandRunsById[runId]?.failureUnopened || markingOpened.has(runId)) return;
    markingOpened.add(runId);
    try {
      const run = await serverApi.markCommandRunOpened(runId);
      set((state) => ({ commandRunsById: { ...state.commandRunsById, [run.id]: run } }));
    } catch (error) {
      reportError(set, get, error, { action: 'markCommandRunOpened' });
    } finally {
      markingOpened.delete(runId);
    }
  },
  markTestRunOpened: async (runId) => {
    if (!get().testRunsById[runId]?.failureUnopened || markingOpened.has(runId)) return;
    markingOpened.add(runId);
    try {
      const run = await serverApi.markTestRunOpened(runId);
      set((state) => ({ testRunsById: { ...state.testRunsById, [run.id]: run } }));
    } catch (error) {
      reportError(set, get, error, { action: 'markTestRunOpened' });
    } finally {
      markingOpened.delete(runId);
    }
  },
  openCommandRunFromVillage: async (projectId, runId) => {
    if (!get().projects.some((project) => project.id === projectId)) return;
    get().openWorkspace(projectId);
    set({ notificationCenterOpen: false, workspaceTab: 'settings', workspaceSettingsSection: 'commands' });
    try {
      const run = await serverApi.getCommandRun(runId);
      set((state) => ({ commandRunsById: { ...state.commandRunsById, [run.id]: run }, footerCommandLogRunId: run.id }));
    } catch {
      // The run is gone: Settings › Commands alone is the answer.
    }
  },
  openPlanningSession: (projectId, taskId) => {
    get().openWorkspace(projectId);
    set((state) => ({ workspaceTab: 'tasks', workspaceDetailTaskId: state.tasksById[taskId] ? taskId : null, notificationCenterOpen: false }));
  },

  openAnalytics: (agentId) => {
    set({ analytics: { ...CLOSED_ANALYTICS, open: true, agentId, dayStart: startOfLocalDay(Date.now()), agents: get().analytics.agents } });
    void get().loadAnalytics();
  },
  closeAnalytics: () => set((state) => ({ analytics: { ...state.analytics, open: false } })),
  setAnalyticsAgent: (agentId) => {
    set((state) => ({ analytics: { ...state.analytics, agentId, day: null, steps: null, refreshPhase: 'idle' } }));
    void get().loadAnalytics();
  },
  setAnalyticsDay: (dayStart) => {
    set((state) => ({ analytics: { ...state.analytics, dayStart } }));
    void get().loadAnalytics();
  },
  loadAnalytics: async () => {
    const patch = (next: Partial<AnalyticsState>) => set((state) => ({ analytics: { ...state.analytics, ...next } }));
    patch({ loading: true });
    try {
      const { agents } = await serverApi.listAnalyticsAgents();
      const requested = get().analytics.agentId;
      const agentId = agents.some((agent) => agent.id === requested) ? requested : agents[0]?.id ?? null;
      const { dayStart } = get().analytics;
      const { from, to } = dayRange(dayStart);
      const [day, steps] = agentId ? await Promise.all([serverApi.getAnalyticsDay(agentId, from, to), serverApi.getAnalyticsSteps(agentId)]) : [null, null];
      // A newer selection made while this was loading wins; its own load is already on the way.
      const current = get().analytics;
      if (current.dayStart !== dayStart || (current.agentId !== requested && current.agentId !== agentId)) return;
      patch({ agents, agentId, day, steps, loading: false, error: null });
    } catch (error) {
      patch({ loading: false, error: errorMessage(error) });
    }
  },
  refreshAnalytics: async () => {
    const { agentId } = get().analytics;
    if (!agentId) return;
    const patch = (next: Partial<AnalyticsState>) => set((state) => ({ analytics: { ...state.analytics, ...next } }));
    patch({ refreshPhase: 'refreshing' });
    try {
      const { result } = await serverApi.refreshAnalytics(agentId);
      await get().loadAnalytics();
      patch({ refreshPhase: result });
    } catch (error) {
      patch({ refreshPhase: 'idle', error: errorMessage(error) });
    }
  },
  openAnalyticsTarget: (target) => {
    get().closeAnalytics();
    const detail: CardDetail = target.kind === 'run' ? { kind: 'run', id: target.runId, focus: { stepId: target.stepId, round: target.round } }
      : target.kind === 'task' ? { kind: 'task', id: target.taskId }
      : { kind: 'item', id: target.planItemId };
    get().openWorkspaceCardDetail(target.projectId, detail);
  },

  setWorkspaceTab: (value) => {
    const { tab, section } = normalizeWorkspaceTab(value);
    set(section ? { workspaceTab: tab, workspaceSettingsSection: section, workspaceTasksFilter: null } : { workspaceTab: tab, workspaceTasksFilter: null });
  },
  setWorkspaceDetailTaskId: (taskId) => set({ workspaceDetailTaskId: taskId }),
  setWorkspaceSettingsSection: (section) => set({ workspaceSettingsSection: section }),

  openCatalog: () => {
    set({ catalogOpen: true, workspaceProjectId: null });
    void get().fetchCatalog();
  },

  closeCatalog: () => set({ catalogOpen: false }),

  loadProjectTasks: async (projectId) => {
    const requestedAtRevision = get().taskLiveRevisionByProject[projectId] ?? 0;
    const knownAtRequest = new Set(Object.values(get().tasksById).filter((task) => task.projectId === projectId).map((task) => task.id));
    try {
      const tasks = await serverApi.listTasksForProject(projectId);
      set((state) => {
        const changes = state.taskLiveChangesByProject[projectId] ?? {};
        const fresh = new Map(tasks.map((task) => [task.id,
          state.tasksById[task.id]?.updatedAt > task.updatedAt ? state.tasksById[task.id]! : toTaskData(task),
        ]));
        for (const change of Object.values(changes).filter((change) => change.revision > requestedAtRevision).sort((a, b) => a.revision - b.revision)) {
          if (change.event.type === 'taskDeleted') fresh.delete(change.event.id);
          else fresh.set(change.event.task.id, toTaskData(change.event.task));
        }
        // A local start response can also arrive during the GET, without a WebSocket event yet.
        for (const task of Object.values(state.tasksById)) {
          if (task.projectId === projectId && !knownAtRequest.has(task.id) && !fresh.has(task.id) && changes[task.id]?.event.type !== 'taskDeleted') fresh.set(task.id, task);
        }
        const tasksById = {
          ...Object.fromEntries(Object.entries(state.tasksById).filter(([, task]) => task.projectId !== projectId)),
          ...Object.fromEntries(fresh),
        };
        const ids = [...fresh.keys()]
          .sort((a, b) => tasksById[b]!.createdAt.localeCompare(tasksById[a]!.createdAt) || b.localeCompare(a));
        const { [projectId]: _previousLast, ...otherLastTaskIds } = state.lastTaskIdByProject;
        return {
          tasksById,
          taskIdsByProject: { ...state.taskIdsByProject, [projectId]: ids },
          lastTaskIdByProject: ids[0]
            ? { ...otherLastTaskIds, [projectId]: ids[0] }
            : otherLastTaskIds,
          reviewedTaskIds: state.workspaceProjectId === projectId && ids[0] && tasksById[ids[0]]?.status === 'done'
            ? { ...state.reviewedTaskIds, [ids[0]]: true }
            : state.reviewedTaskIds,
        };
      });
    } catch (error) {
      reportError(set, get, error, { action: 'loadProjectTasks', projectId });
    }
  },

  loadPlan: async (projectId) => {
    const requestedAtRevision = get().planLiveRevisionByProject[projectId] ?? 0;
    try {
      const plan = await serverApi.getPlan(projectId);
      set((state) => {
        let items = plan.items.map(toPlanItemData);
        const changes = Object.values(state.planLiveChangesByProject[projectId] ?? {})
          .filter((change) => change.revision > requestedAtRevision)
          .sort((a, b) => a.revision - b.revision);
        for (const { event } of changes) {
          items = event.type === 'planItemDeleted'
            ? items.filter((item) => item.id !== event.id)
            : reconcilePlanItem(items, toPlanItemData(event.planItem));
        }
        return { planByProject: { ...state.planByProject, [projectId]: { items } } };
      });
    } catch (error) {
      reportError(set, get, error, { action: 'loadPlan', projectId });
    }
  },

  createPlanItem: async (projectId, draft) => {
    try {
      const item = await serverApi.createPlanItem(projectId, draft);
      set((state) => {
        const plan = state.planByProject[projectId];
        if (!plan) return {};
        return {
          // A generated-title 'planItem' WS event can land before this response; keep that newer copy.
          planByProject: { ...state.planByProject, [projectId]: { ...plan, items: plan.items.some((existing) => existing.id === item.id) ? plan.items : [...plan.items, toPlanItemData(item)] } },
        };
      });
      return item.id;
    } catch (error) {
      reportError(set, get, error, { action: 'createPlanItem', projectId });
      return undefined;
    }
  },

  updatePlanItem: async (projectId, itemId, patch) => {
    try {
      const item = await serverApi.updatePlanItem(itemId, patch);
      set((state) => {
        const plan = state.planByProject[projectId];
        if (!plan) return {};
        return {
          planByProject: { ...state.planByProject, [projectId]: { ...plan, items: reconcilePlanItem(plan.items, toPlanItemData(item)) } },
        };
      });
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'updatePlanItem', projectId });
      return false;
    }
  },

  setAutoMerge: async (projectId, itemId, enabled) => {
    const replaceItem = (change: (item: PlanItemData) => PlanItemData) => set((state) => {
      const plan = state.planByProject[projectId];
      return plan ? { planByProject: { ...state.planByProject, [projectId]: { ...plan, items: plan.items.map((item) => (item.id === itemId ? change(item) : item)) } } } : {};
    });
    const previous = get().planByProject[projectId]?.items.find((item) => item.id === itemId)?.autoMerge;
    replaceItem((item) => ({ ...item, autoMerge: autoMergeSwitched(previous, enabled) }));
    try {
      const saved = toPlanItemData(await serverApi.setAutoMerge(projectId, itemId, enabled));
      replaceItem((item) => ({ ...item, autoMerge: saved.autoMerge }));
      return true;
    } catch (error) {
      replaceItem((item) => ({ ...item, autoMerge: previous }));
      reportError(set, get, error, { action: 'setAutoMerge', projectId });
      return false;
    }
  },

  retryAutoMerge: async (projectId, itemId) => {
    try {
      const item = await serverApi.retryAutoMerge(projectId, itemId);
      set((state) => {
        const plan = state.planByProject[projectId];
        return plan ? { planByProject: { ...state.planByProject, [projectId]: { ...plan, items: reconcilePlanItem(plan.items, toPlanItemData(item)) } } } : {};
      });
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'retryAutoMerge', projectId });
      return false;
    }
  },

  setDependencies: async (projectId, itemId, dependsOn) => {
    try {
      reconcileSavedItem(set, projectId, await serverApi.setDependencies(projectId, itemId, dependsOn));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'setDependencies', projectId });
      return false;
    }
  },

  setUiPlanningWaits: async (projectId, itemId, value) => {
    try {
      reconcileSavedItem(set, projectId, await serverApi.setUiPlanningWaits(projectId, itemId, value));
      return true;
    } catch {
      return false;
    }
  },

  loadPlanItemQueue: async (projectId) => {
    try {
      const entries = await serverApi.listPlanItemQueue(projectId);
      set((state) => ({ planItemQueueByProject: { ...state.planItemQueueByProject, [projectId]: entries } }));
    } catch {
      // The list also arrives with every 'planItemQueue' event, so a failed read only delays it.
    }
  },

  removeFromWaitingList: async (projectId, entryId) => {
    try {
      await serverApi.removeFromWaitingList(entryId);
      set((state) => ({ planItemQueueByProject: { ...state.planItemQueueByProject, [projectId]: (state.planItemQueueByProject[projectId] ?? []).filter((entry) => entry.id !== entryId) } }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'removeFromWaitingList', projectId });
      return false;
    }
  },

  cancelWaiting: async (projectId, itemId) => {
    try {
      reconcileSavedItem(set, projectId, await serverApi.cancelWaiting(projectId, itemId));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'cancelWaiting', projectId });
      return false;
    }
  },

  chainPlanningGroup: async (projectId, session, autoMerge) => {
    try {
      for (const item of await serverApi.chainPlanningGroup(projectId, session, autoMerge)) reconcileSavedItem(set, projectId, item);
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'chainPlanningGroup', projectId });
      return false;
    }
  },

  reorderPlanItems: async (projectId, itemIds) => {
    const setItems = (items: PlanItemData[]) =>
      set((state) => {
        const plan = state.planByProject[projectId];
        return plan ? { planByProject: { ...state.planByProject, [projectId]: { ...plan, items } } } : {};
      });
    const plan = get().planByProject[projectId];
    if (plan) setItems(reorderLocally(plan.items, itemIds));
    try {
      setItems((await serverApi.reorderPlanItems(projectId, itemIds)).map(toPlanItemData));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'reorderPlanItems', projectId });
      await get().loadPlan(projectId);
      return false;
    }
  },

  deletePlanItem: async (projectId, itemId) => {
    try {
      await serverApi.deletePlanItem(itemId);
      set((state) => {
        const plan = state.planByProject[projectId];
        if (!plan) return {};
        return {
          planByProject: { ...state.planByProject, [projectId]: { ...plan, items: plan.items.filter((i) => i.id !== itemId) } },
        };
      });
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'deletePlanItem', projectId });
      return false;
    }
  },

  executePlanItem: async (itemId, options) => {
    const result = await serverApi.executePlanItem(itemId, options);
    if (!('run' in result)) { queueEntryJoined(set, result.entry); return ''; }
    const { run } = result;
    // A live event may already have moved the run on (it starts setting up as soon as it is accepted).
    const known = get().workflowRunsByProject[run.projectId]?.find((entry) => entry.id === run.id);
    if (!isStale(known, run)) applyWorkflowRunUpdate(set, run);
    return run.id;
  },

  reportRegression: async (projectId, itemId, reason) => {
    const { item, run, workflowNote } = await serverApi.reportRegression(itemId, reason);
    reconcileSavedItem(set, projectId, item);
    const known = get().workflowRunsByProject[run.projectId]?.find((entry) => entry.id === run.id);
    if (!isStale(known, run)) applyWorkflowRunUpdate(set, run);
    return workflowNote ?? '';
  },

  startWhenReady: async (projectId, itemId, options) => {
    const result = await serverApi.startWhenReady(projectId, itemId, options);
    if (!('run' in result)) {
      reconcileSavedItem(set, projectId, result.item);
      if (result.entry) queueEntryJoined(set, result.entry);
      return '';
    }
    applyWorkflowRunUpdate(set, result.run);
    return result.run.id;
  },

  startPlanItem: (projectId, itemId, options) => {
    const item = get().planByProject[projectId]?.items.find((entry) => entry.id === itemId);
    return startsWhenReady(item) ? get().startWhenReady(projectId, itemId, options) : get().executePlanItem(itemId, options);
  },

  startPlanAndBugsSession: async (projectId, description, executorId, autonomy) => {
    const task = await serverApi.startPlanAndBugsSession(projectId, description, executorId, autonomy);
    mergeTaskResponse(set, task, true);
    return task.id;
  },

  updateSessionDescription: async (taskId, description) => {
    mergeTaskResponse(set, await serverApi.updateSessionDescription(taskId, description), false);
  },

  startDeferredSession: async (taskId, executorId) => {
    mergeTaskResponse(set, await serverApi.startDeferredSession(taskId, executorId), false);
  },

  setBugInfoStatus: async (projectId, itemId, infoStatus) => {
    const item = toPlanItemData(await serverApi.setBugInfoStatus(itemId, infoStatus));
    set((state) => {
      const plan = state.planByProject[projectId];
      return plan ? { planByProject: { ...state.planByProject, [projectId]: { ...plan, items: reconcilePlanItem(plan.items, item) } } } : {};
    });
  },

  reorderBugGroup: async (projectId, introducerId, ids) => {
    const setItems = (items: PlanItemData[]) =>
      set((state) => {
        const plan = state.planByProject[projectId];
        return plan ? { planByProject: { ...state.planByProject, [projectId]: { ...plan, items } } } : {};
      });
    const prior = get().planByProject[projectId]?.items;
    if (prior) setItems(prior.map((item) => (item.bug && ids.includes(item.id) ? { ...item, bug: { ...item.bug, groupOrder: ids.indexOf(item.id) } } : item)));
    try {
      await serverApi.reorderBugGroup(projectId, introducerId, ids);
    } catch (error) {
      if (prior) setItems(prior);
      throw error;
    }
  },

  // ---- Project Commands: user-defined shell commands, run from the project's root (Commands tab) ----

  loadCommands: async (projectId) => {
    try {
      const commands = await serverApi.listCommands(projectId);
      set((state) => ({ commandsByProject: { ...state.commandsByProject, [projectId]: commands } }));
    } catch (error) {
      reportError(set, get, error, { action: 'loadCommands', projectId });
    }
  },

  createCommand: async (projectId, input) => {
    try {
      const command = await serverApi.createCommand(projectId, input);
      set((state) => ({
        commandsByProject: { ...state.commandsByProject, [projectId]: [...(state.commandsByProject[projectId] ?? []), command] },
      }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'createCommand', projectId });
      return false;
    }
  },

  updateCommand: async (projectId, commandId, patch) => {
    try {
      const updated = await serverApi.updateCommand(commandId, patch);
      set((state) => ({
        commandsByProject: {
          ...state.commandsByProject,
          [projectId]: (state.commandsByProject[projectId] ?? []).map((c) => (c.id === commandId ? updated : c)),
        },
      }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'updateCommand', projectId });
      return false;
    }
  },

  deleteCommand: async (projectId, commandId) => {
    try {
      await serverApi.deleteCommand(commandId);
      set((state) => ({
        commandsByProject: { ...state.commandsByProject, [projectId]: (state.commandsByProject[projectId] ?? []).filter((c) => c.id !== commandId) },
      }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'deleteCommand', projectId });
      return false;
    }
  },

  runCommand: async (commandId, workflowRunId) => {
    try {
      const run = await serverApi.runCommand(commandId, workflowRunId);
      mergeRunStart(set, run);
      return run;
    } catch (error) {
      reportError(set, get, error, { action: 'runCommand' });
      return undefined;
    }
  },

  runAdHocCommand: async (projectId, command, workflowRunId) => {
    try {
      const run = await serverApi.runAdHocCommand(projectId, command, workflowRunId);
      mergeRunStart(set, run);
      return run;
    } catch (error) {
      reportError(set, get, error, { action: 'runAdHocCommand', projectId });
      return undefined;
    }
  },

  stopCommandRun: async (runId) => {
    try {
      const run = await serverApi.stopCommandRun(runId);
      set((state) => ({ commandRunsById: { ...state.commandRunsById, [run.id]: run } }));
    } catch (error) {
      reportError(set, get, error, { action: 'stopCommandRun' });
    }
  },

  loadCommandRuns: async (projectId) => {
    try {
      const runs = await serverApi.listCommandRuns(projectId);
      set((state) => ({
        commandRunsById: { ...state.commandRunsById, ...Object.fromEntries(runs.map((r) => [r.id, r])) },
        commandRunIdsByProject: { ...state.commandRunIdsByProject, [projectId]: runs.map((r) => r.id) },
      }));
    } catch (error) {
      reportError(set, get, error, { action: 'loadCommandRuns', projectId });
    }
  },

  loadActiveCommandRuns: async (projectId) => {
    try {
      const runs = await serverApi.listCommandRuns(projectId, 'running');
      set((state) => ({
        commandRunsById: { ...state.commandRunsById, ...Object.fromEntries(runs.map((r) => [r.id, r])) },
      }));
    } catch (error) {
      reportError(set, get, error, { action: 'loadActiveCommandRuns', projectId });
    }
  },

  loadNotifications: async () => {
    try {
      const notifications = await serverApi.listNotifications();
      set({ notificationsById: Object.fromEntries(notifications.map((n) => [n.id, n])), notificationsLoaded: true });
    } catch (error) {
      set({ notificationsLoaded: true });
      reportError(set, get, error, { action: 'loadNotifications' });
    }
  },

  markNotificationsRead: async (ids) => {
    if (ids.length === 0) return;
    const errorIds = ids.filter((id) => id in get().errorNotificationsById);
    if (errorIds.length > 0) set((state) => ({ errorNotificationsById: setErrorNotificationsRead(state.errorNotificationsById, errorIds, true, new Date()) }));
    ids = ids.filter((id) => !errorIds.includes(id));
    if (ids.length === 0) return;
    try {
      await serverApi.markNotificationsRead(ids);
      const now = new Date().toISOString();
      set((state) => ({
        notificationsById: Object.fromEntries(Object.entries(state.notificationsById).map(([id, n]) => [
          id,
          ids.includes(id)
            ? { ...n, readAt: n.readAt ?? now, resolvedAt: (n.kind === 'task.completed' || n.kind === 'automerge.merged') && n.resolvedAt === null ? now : n.resolvedAt }
            : n,
        ])),
      }));
    } catch (error) {
      reportError(set, get, error, { action: 'markNotificationsRead' });
    }
  },

  markSubjectRead: async (subject) => {
    const hasUnread = Object.values(get().notificationsById).some((n) => sameSubjectIdentity(n.subject, subject) && n.readAt === null);
    if (!hasUnread) return;
    const ids = Object.values(get().notificationsById).filter((n) => sameSubjectIdentity(n.subject, subject)).map((n) => n.id);
    await get().markNotificationsRead(ids);
  },

  markNotificationUnread: async (id) => {
    if (id in get().errorNotificationsById) {
      set((state) => ({ errorNotificationsById: setErrorNotificationsRead(state.errorNotificationsById, [id], false, new Date()) }));
      return;
    }
    try {
      await serverApi.markNotificationUnread(id);
      set((state) => (state.notificationsById[id]
        ? { notificationsById: { ...state.notificationsById, [id]: { ...state.notificationsById[id], readAt: null } } }
        : {}));
    } catch (error) {
      reportError(set, get, error, { action: 'markNotificationUnread' });
    }
  },

  markAllNotificationsRead: async (filter) => {
    const errorIds = Object.values(get().errorNotificationsById).filter((n) => matchesNotificationFilter(n, filter)).map((n) => n.id);
    if (errorIds.length > 0) set((state) => ({ errorNotificationsById: setErrorNotificationsRead(state.errorNotificationsById, errorIds, true, new Date()) }));
    if (!Object.values(get().notificationsById).some((n) => matchesNotificationFilter(n, filter))) return;
    try {
      await serverApi.markAllNotificationsRead(filter);
      const now = new Date().toISOString();
      set((state) => ({
        notificationsById: Object.fromEntries(Object.entries(state.notificationsById).map(([id, n]) => [
          id,
          matchesNotificationFilter(n, filter)
            ? { ...n, readAt: n.readAt ?? now, resolvedAt: (n.kind === 'task.completed' || n.kind === 'automerge.merged') && n.resolvedAt === null ? now : n.resolvedAt }
            : n,
        ])),
      }));
    } catch (error) {
      reportError(set, get, error, { action: 'markAllNotificationsRead' });
    }
  },

  markProjectCommandFailuresRead: async (projectId) => {
    const ids = Object.values(get().notificationsById)
      .filter((n) => n.kind === 'command.failed' && n.projectId === projectId && n.readAt === null)
      .map((n) => n.id);
    await get().markNotificationsRead(ids);
  },

  openNotificationTarget: async (n) => {
    const subject = n.subject;
    if (subject.type === 'error') {
      if (n.projectId) get().openWorkspace(n.projectId);
      await get().markNotificationsRead([n.id]);
      return;
    }
    if (subject.type === 'task') {
      get().openWorkspace(subject.projectId);
      set({ workspaceTab: 'tasks', workspaceDetailTaskId: subject.taskId });
    } else if (subject.type === 'command' && n.kind === 'command.completed') {
      await get().openFooterCommandLog(subject.runId);
    } else if (subject.type === 'command') {
      get().openWorkspace(subject.projectId);
      set({ workspaceTab: 'settings', workspaceSettingsSection: 'commands' });
    } else if (subject.type === 'testRun') {
      await get().openTestRunFromFooter(subject.projectId, subject.runId);
    } else if (subject.type === 'project' || subject.type === 'autoMerge') {
      get().openWorkspace(subject.projectId);
    } else if (subject.type === 'skill') {
      get().openCatalog();
    } else if (subject.type === 'scheduledJob') {
      get().openWorkspace(subject.projectId);
      get().setWorkspaceTab('schedules');
    }
    // subject.type === 'app': nothing to navigate to — the status footer's app-update item/popover
    // (always visible, see AppUpdateSection) is already the live view of this.
    await get().markNotificationsRead([n.id]);
  },

  runNotificationQuickAction: async (n) => {
    const action = quickActionFor(n);
    if (!action) return;
    if (action.kind === 'reply') {
      await get().openNotificationTarget(n);
      return;
    }
    try {
      if (action.kind === 'retry') {
        const subject = n.subject as Extract<NotificationSubject, { type: 'task' }>;
        const task = get().tasksById[subject.taskId];
        if (task?.executionMode === 'terminal') {
          await serverApi.resumeTerminalTask(subject.taskId);
        } else {
          await serverApi.followUpTask(subject.taskId, `Retry the task. The previous attempt failed: ${n.description}`);
        }
      } else if (action.kind === 'run-again') {
        // `runCommand`/`syncProjectBranch` below report failure by resolving undefined and setting
        // report the failure themselves, rather than throwing — checked explicitly so a failed run never
        // still marks this Notification read.
        const subject = n.subject as Extract<NotificationSubject, { type: 'command' }>;
        if (!(await get().runCommand(subject.commandId))) return;
      } else {
        const subject = n.subject as Extract<NotificationSubject, { type: 'project' }>;
        if (!(await get().syncProjectBranch(subject.projectId))) return;
      }
      await get().markNotificationsRead([n.id]);
    } catch (error) {
      reportError(set, get, error, { action: 'runNotificationQuickAction' });
    }
  },

  toggleNotificationCenter: () => set((state) => ({ notificationCenterOpen: !state.notificationCenterOpen })),
  closeNotificationCenter: () => set({ notificationCenterOpen: false }),

  // ---- App update (task 7.001) ----

  loadAppUpdate: async () => {
    try {
      const status = await serverApi.getAppUpdate();
      set({ appUpdate: status, lastKnownAppUpdatePhase: status.phase });
    } catch (error) {
      reportError(set, get, error, { action: 'loadAppUpdate' });
    }
  },

  checkAppUpdateNow: async () => {
    try {
      const status = await serverApi.checkAppUpdateNow();
      set({ appUpdate: status, lastKnownAppUpdatePhase: status.phase });
    } catch (error) {
      reportError(set, get, error, { action: 'checkAppUpdateNow' });
    }
  },

  applyAppUpdate: async () => {
    try {
      const status = await serverApi.applyAppUpdate();
      set({ appUpdate: status, lastKnownAppUpdatePhase: status.phase });
    } catch (error) {
      reportError(set, get, error, { action: 'applyAppUpdate' });
    }
  },

  cancelAppUpdate: async () => {
    try {
      const status = await serverApi.cancelAppUpdate();
      set({ appUpdate: status, lastKnownAppUpdatePhase: status.phase });
    } catch (error) {
      reportError(set, get, error, { action: 'cancelAppUpdate' });
    }
  },

  dismissAppUpdateReloadBanner: () => set((state) => ({ appUpdateReloadDismissedCommit: state.appUpdate?.currentCommit ?? null })),

  // ---- Catalog: Templates (agents) and Skills, backed by the daemon's repo-root catalog/ folder ----

  fetchCatalog: async () => {
    try {
      const [catalogAgents, catalogSkills, catalogWorkflows] = await Promise.all([
        serverApi.listCatalogAgents(),
        serverApi.listCatalogSkills(),
        serverApi.listCatalogWorkflows(),
      ]);
      set({ catalogAgents, catalogSkills, catalogWorkflows });
    } catch (error) {
      reportError(set, get, error, { action: 'fetchCatalog' });
    }
  },

  createCatalogAgent: async (input) => {
    try {
      const agent = await serverApi.createCatalogAgent(input);
      set((state) => ({ catalogAgents: [...state.catalogAgents, agent] }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'createCatalogAgent' });
      return false;
    }
  },

  updateCatalogAgent: async (id, patch) => {
    try {
      const agent = await serverApi.updateCatalogAgent(id, patch);
      set((state) => ({ catalogAgents: state.catalogAgents.map((a) => (a.id === id ? agent : a)) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'updateCatalogAgent' });
      return false;
    }
  },

  deleteCatalogAgent: async (id) => {
    try {
      await serverApi.deleteCatalogAgent(id);
      set((state) => ({ catalogAgents: state.catalogAgents.filter((a) => a.id !== id) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'deleteCatalogAgent' });
      return false;
    }
  },

  toggleCatalogAgentEnabled: async (id, enabled) => {
    try {
      const agent = await serverApi.setCatalogAgentEnabled(id, enabled);
      set((state) => ({ catalogAgents: state.catalogAgents.map((a) => (a.id === id ? agent : a)) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'toggleCatalogAgentEnabled' });
      return false;
    }
  },

  uploadCatalogAgentFile: async (input) => {
    try {
      const agent = await serverApi.uploadCatalogAgentFile(input);
      set((state) => ({ catalogAgents: [...state.catalogAgents, agent] }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'uploadCatalogAgentFile' });
      return false;
    }
  },

  createCatalogSkill: async (input) => {
    try {
      const skill = await serverApi.createCatalogSkill(input);
      set((state) => ({ catalogSkills: [...state.catalogSkills, skill] }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'createCatalogSkill' });
      return false;
    }
  },

  updateCatalogSkill: async (id, patch) => {
    try {
      const skill = await serverApi.updateCatalogSkill(id, patch);
      set((state) => ({ catalogSkills: state.catalogSkills.map((s) => (s.id === id ? skill : s)) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'updateCatalogSkill' });
      return false;
    }
  },

  deleteCatalogSkill: async (id) => {
    try {
      await serverApi.deleteCatalogSkill(id);
      set((state) => ({ catalogSkills: state.catalogSkills.filter((s) => s.id !== id) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'deleteCatalogSkill' });
      return false;
    }
  },

  toggleCatalogSkillEnabled: async (id, enabled) => {
    try {
      const skill = await serverApi.setCatalogSkillEnabled(id, enabled);
      set((state) => ({ catalogSkills: state.catalogSkills.map((s) => (s.id === id ? skill : s)) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'toggleCatalogSkillEnabled' });
      return false;
    }
  },

  uploadCatalogSkillZip: async (input) => {
    try {
      const skill = await serverApi.uploadCatalogSkillZip(input);
      set((state) => ({ catalogSkills: [...state.catalogSkills, skill] }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'uploadCatalogSkillZip' });
      return false;
    }
  },

  addCatalogSkillFile: async (id, name, file) => {
    try {
      const skill = await serverApi.addCatalogSkillFile(id, name, file);
      set((state) => ({ catalogSkills: state.catalogSkills.map((s) => (s.id === id ? skill : s)) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'addCatalogSkillFile' });
      return false;
    }
  },

  removeCatalogSkillFile: async (id, name) => {
    try {
      const skill = await serverApi.removeCatalogSkillFile(id, name);
      set((state) => ({ catalogSkills: state.catalogSkills.map((s) => (s.id === id ? skill : s)) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'removeCatalogSkillFile' });
      return false;
    }
  },

  startCatalogSkillInstall: async (repo) => {
    try {
      const run = await serverApi.installCatalogSkill(repo);
      set((state) => ({ catalogInstallRuns: { ...state.catalogInstallRuns, [run.id]: run } }));
      return run;
    } catch (error) {
      reportError(set, get, error, { action: 'startCatalogSkillInstall' });
      return undefined;
    }
  },

  // ---- Catalog: Workflows (task 3.012) ----

  createCatalogWorkflow: async (input) => {
    try {
      const workflow = await serverApi.createCatalogWorkflow(input);
      set((state) => ({ catalogWorkflows: [...state.catalogWorkflows, workflow] }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'createCatalogWorkflow' });
      return false;
    }
  },

  updateCatalogWorkflow: async (id, patch) => {
    try {
      const workflow = await serverApi.updateCatalogWorkflow(id, patch);
      set((state) => ({ catalogWorkflows: state.catalogWorkflows.map((w) => (w.id === id ? workflow : w)) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'updateCatalogWorkflow' });
      return false;
    }
  },

  deleteCatalogWorkflow: async (id) => {
    try {
      await serverApi.deleteCatalogWorkflow(id);
      set((state) => ({ catalogWorkflows: state.catalogWorkflows.filter((w) => w.id !== id) }));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'deleteCatalogWorkflow' });
      return false;
    }
  },

  // ---- Workflow runs (task 3.012) ----

  loadWorkflowRunsForProject: async (projectId) => {
    try {
      const runs = await serverApi.listWorkflowRunsForProject(projectId);
      set((state) => {
        const existingById = new Map((state.workflowRunsByProject[projectId] ?? []).map((r) => [r.id, r]));
        // Same staleness guard as `loadProjectTasks` — a slow GET can't be allowed to regress a run
        // the store already has fresher (see `isStale`).
        const merged = runs.map((run) => {
          const existing = existingById.get(run.id);
          return isStale(existing, run) ? existing! : run;
        });
        return { workflowRunsByProject: { ...state.workflowRunsByProject, [projectId]: merged } };
      });
    } catch (error) {
      reportError(set, get, error, { action: 'loadWorkflowRunsForProject', projectId });
    }
  },

  loadWorkflowRunDetail: async (runId) => {
    try {
      const detail = await serverApi.getWorkflowRunDetail(runId);
      set((state) => ({ workflowRunDetails: { ...state.workflowRunDetails, [runId]: detail } }));
    } catch (error) {
      reportError(set, get, error, { action: 'loadWorkflowRunDetail' });
    }
  },

  startTestingSetup: async (projectId) => {
    try {
      const result = await serverApi.startTestingSetup(projectId);
      if (result.run) applyWorkflowRunUpdate(set, result.run);
      return result;
    } catch (error) {
      reportError(set, get, error, { action: 'startTestingSetup', projectId });
      return null;
    }
  },

  approveTestingSetup: async (runId, proposalRound, comment) => {
    try {
      applyWorkflowRunUpdate(set, await serverApi.approveTestingSetup(runId, proposalRound, comment));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'approveTestingSetup' });
      return false;
    }
  },

  reviseTestingSetup: async (runId, comment) => {
    try {
      applyWorkflowRunUpdate(set, await serverApi.reviseTestingSetup(runId, comment));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'reviseTestingSetup' });
      return false;
    }
  },

  rejectTestingSetup: async (runId) => {
    try {
      applyWorkflowRunUpdate(set, await serverApi.rejectTestingSetup(runId));
      return true;
    } catch (error) {
      reportError(set, get, error, { action: 'rejectTestingSetup' });
      return false;
    }
  },

  loadTestRunDetail: async (runId) => {
    try {
      const detail = await serverApi.getTestRun(runId);
      set((state) => ({
        testRunDetailsById: { ...state.testRunDetailsById, [runId]: detail },
        testRunLogsById: { ...state.testRunLogsById, [runId]: detail.output },
      }));
      return detail;
    } catch (error) {
      reportError(set, get, error, { action: 'loadTestRunDetail' });
      return null;
    }
  },

  approveWorkflowRun: (runId, comment) => callWorkflowRun(set, get, 'approveWorkflowRun', () => serverApi.approveWorkflowRun(runId, comment)),
  requestChangesWorkflowRun: (runId, comment) => callWorkflowRun(set, get, 'requestChangesWorkflowRun', () => serverApi.requestChangesWorkflowRun(runId, comment)),
  decideWorkflowRunLoop: (runId, action, comment) => callWorkflowRun(set, get, 'decideWorkflowRunLoop', () => serverApi.decideWorkflowRunLoop(runId, action, comment)),
  retryWorkflowStep: (runId) => callWorkflowRun(set, get, 'retryWorkflowStep', () => serverApi.retryWorkflowStep(runId)),
  stopWorkflowRun: (runId) => callWorkflowRun(set, get, 'stopWorkflowRun', () => serverApi.stopWorkflowRun(runId)),
  resumeWorkflowRun: (runId) => callWorkflowRun(set, get, 'resumeWorkflowRun', () => serverApi.resumeWorkflowRun(runId)),
}));

// One place persists every acknowledgement, whichever action made it (reviewTask, openWorkspace, loadProjectTasks).
useWorldStore.subscribe((state, previous) => {
  if (state.reviewedTaskIds !== previous.reviewedTaskIds) writeReviewedTaskIds(state.reviewedTaskIds);
});
