import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { FileDatabase } from './FileDatabase.ts';
import type { ImportSessionRecord } from '../content/importSessions.ts';
import type { StudioSessionRecord } from '../content/studioSessions.ts';
import type { AgentSessionCounterRecord, AgentSessionRecord } from '../terminal/agentSessions.ts';
import type { JobHistoryEntry, PollBaselineRecord, ScheduledJobRecord } from '../scheduler/types.ts';
import type { ActivityRecord, BuildingLinkRecord, CapabilityApprovalRecord, ChainDepthRecord, EventSubscriptionRecord, PendingEventRecord } from '../connections/types.ts';
import type { BuildingTypeConfigRecord, GithubIdentityRecord, CommandRunRecord, NotificationRecord, PlanItemQueueEntry, PlanItemRecord, ProjectCommandRecord, ProjectRecord, StepRunRecord, TaskContextRecord, TaskRecord, TestRunRecord, WorkflowRunRecord } from '../domain/types.ts';

export const projectsDb = new FileDatabase<ProjectRecord>(path.join(DATA_DIR, 'projects.json'));
/** Per `gh` account: the commit author name and email used instead of the defaults (`github/accounts.ts`). */
export const githubIdentitiesDb = new FileDatabase<GithubIdentityRecord>(path.join(DATA_DIR, 'github-identities.json'));
export const tasksDb = new FileDatabase<TaskRecord>(path.join(DATA_DIR, 'tasks.json'));
export const taskContextsDb = new FileDatabase<TaskContextRecord>(path.join(DATA_DIR, 'task-contexts.json'));
export const planItemsDb = new FileDatabase<PlanItemRecord>(path.join(DATA_DIR, 'plan-items.json'));
export const planItemQueueDb = new FileDatabase<PlanItemQueueEntry>(path.join(DATA_DIR, 'plan-item-queue.json'));
export const projectCommandsDb = new FileDatabase<ProjectCommandRecord>(path.join(DATA_DIR, 'project-commands.json'));
export const commandRunsDb = new FileDatabase<CommandRunRecord>(path.join(DATA_DIR, 'command-runs.json'));
export const notificationsDb = new FileDatabase<NotificationRecord>(path.join(DATA_DIR, 'notifications.json'));
export const testRunsDb = new FileDatabase<TestRunRecord>(path.join(DATA_DIR, 'test-runs.json'));
export const workflowRunsDb = new FileDatabase<WorkflowRunRecord>(path.join(DATA_DIR, 'workflow-runs.json'));
export const stepRunsDb = new FileDatabase<StepRunRecord>(path.join(DATA_DIR, 'step-runs.json'));
/** Per Building Type: which Catalog workflow fills each slot and which agent runs each step (`buildings/slotConfig.ts`). */
export const buildingTypeConfigsDb = new FileDatabase<BuildingTypeConfigRecord>(path.join(DATA_DIR, 'building-type-configs.json'));
/** The Building scheduler's jobs, each job's run history, and what each poll trigger last saw (`scheduler/scheduler.ts`). */
export const scheduledJobsDb = new FileDatabase<ScheduledJobRecord>(path.join(DATA_DIR, 'scheduled-jobs.json'));
export const jobHistoryDb = new FileDatabase<JobHistoryEntry>(path.join(DATA_DIR, 'scheduled-job-history.json'));
export const pollBaselinesDb = new FileDatabase<PollBaselineRecord>(path.join(DATA_DIR, 'scheduled-job-baselines.json'));
/** Cross-Building connections (`connections/service.ts`): links, event subscriptions, the event outbox, held write calls, chain depths and the Activity log. */
export const buildingLinksDb = new FileDatabase<BuildingLinkRecord>(path.join(DATA_DIR, 'building-links.json'));
export const eventSubscriptionsDb = new FileDatabase<EventSubscriptionRecord>(path.join(DATA_DIR, 'event-subscriptions.json'));
export const pendingEventsDb = new FileDatabase<PendingEventRecord>(path.join(DATA_DIR, 'pending-events.json'));
export const capabilityApprovalsDb = new FileDatabase<CapabilityApprovalRecord>(path.join(DATA_DIR, 'capability-approvals.json'));
export const chainDepthsDb = new FileDatabase<ChainDepthRecord>(path.join(DATA_DIR, 'chain-depths.json'));
export const activityLogDb = new FileDatabase<ActivityRecord>(path.join(DATA_DIR, 'activity-log.json'));

/** The one app-wide default coding agent, stored as a single record. */
export const defaultExecutorDb = new FileDatabase<{ id: 'default'; executorId: string; label: string }>(path.join(DATA_DIR, 'default-executor.json'));

/** Agent terminal sessions (`terminal/agentSessions.ts`) and, per Project, the last number handed out to one (never reused). */
export const agentSessionsDb = new FileDatabase<AgentSessionRecord>(path.join(DATA_DIR, 'agent-sessions.json'));
export const agentSessionCountersDb = new FileDatabase<AgentSessionCounterRecord>(path.join(DATA_DIR, 'agent-session-counters.json'));

/** Content Studio writing sessions, one record per round of an asset's agent pane (`content/studioSessions.ts`). */
export const studioSessionsDb = new FileDatabase<StudioSessionRecord>(path.join(DATA_DIR, 'studio-sessions.json'));
/** Content Studio import sessions, which have no Concept or asset (`content/importSessions.ts`). */
export const importSessionsDb = new FileDatabase<ImportSessionRecord>(path.join(DATA_DIR, 'import-sessions.json'));
