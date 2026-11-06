import { randomUUID } from 'node:crypto';
import type { ExecutorProfile, StepRunRecord, TaskRecord, TokenUsage, WorkflowRunRecord } from '../domain/types.ts';
import { accountIdentity, type AccountProfile } from './accountIdentity.ts';
import { applyActivityState, closeUnobserved, taskActivityState } from './activity.ts';
import type { AnalyticsHistory } from './analyticsHistory.ts';
import { addTokens, NO_TOKENS, totalTokens, usageIncrement, type CliUsageReader } from './cliUsage.ts';
import type { ActivityRecord, ActivityWorkflow, TokenCounts } from './types.ts';

/** The id and name the built-in Complete stage is recorded under. It is never a comparable workflow step. */
export const COMPLETE_STAGE = { id: 'complete', name: 'Complete' } as const;
/** When the Task's own record says its state last changed, if it says. */
function statusChangedAt(task: TaskRecord): number | null {
  const at = task.runtimeStatusChangedAt ? Date.parse(task.runtimeStatusChangedAt) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** The latest state change already recorded for a session. */
function lastChangeAt(record: ActivityRecord): number {
  const last = record.segments.at(-1);
  return last ? last.end ?? last.start : record.startedAt;
}

/** What the recorder reads to name a session. Each returns nothing when the record is gone. */
export interface ActivityLookups {
  executor(id: string): Promise<ExecutorProfile | undefined>;
  projectName(id: string): Promise<string | null>;
  planItemTitle(id: string): Promise<string | null>;
  workflowRun(id: string): Promise<WorkflowRunRecord | undefined>;
}

/** What a background turn is for, and what it belongs to. */
export interface BackgroundTurnContext {
  purpose: string;
  projectId?: string | null;
  planItemId?: string | null;
  /** Set for the Complete stage, so the turn shows under its run. */
  workflowRun?: WorkflowRunRecord;
}

/** Runs one headless turn on `executor`, recording it as app background work. Tracking never changes or fails the turn. A turn that timed out resolves null. */
export type BackgroundTurnTracker = <T extends { usage?: TokenUsage | null } | null>(executor: ExecutorProfile, context: BackgroundTurnContext, run: () => Promise<T>) => Promise<T>;

export const untrackedTurn: BackgroundTurnTracker = (_executor, _context, run) => run();

/** A Task's CLI session: `sessionKey` is the CLI's own id for it, `sessionFile` is where the CLI reports its usage. */
export interface CliSession {
  taskId: string;
  kind: ExecutorProfile['kind'];
  sessionKey: string;
  sessionFile: string;
}

/** The events the recorder acts on; anything else is ignored. */
export type RecordedEvent = { type: 'task'; task: TaskRecord } | { type: 'stepRun'; stepRun: StepRunRecord } | { type: string };

function workflowOf(run: WorkflowRunRecord, stepId: string): ActivityWorkflow {
  const stepName = stepId === COMPLETE_STAGE.id ? COMPLETE_STAGE.name : run.workflowSnapshot.steps.find((step) => step.id === stepId)?.name ?? stepId;
  return { id: run.workflowId, name: run.workflowSnapshot.name, runId: run.id, stepId, stepName, round: null, status: null };
}

function tokenCounts(usage: TokenUsage): TokenCounts {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens };
}

/**
 * Turns Task and step-round state changes into activity history: one record per session, split into
 * working and waiting segments at the moments the changes happened. Runs in the daemon, so it records
 * whether or not a browser is open.
 */
export class ActivityRecorder {
  private history: AnalyticsHistory;
  private lookups: ActivityLookups;
  private now: () => number;
  private readUsage: CliUsageReader;
  private queue: Promise<unknown> = Promise.resolve();
  /** Each live Task's CLI session file, as its hooks last reported it, so usage can be read once more when the session ends. */
  private cliSessions = new Map<string, CliSession>();

  constructor(options: { history: AnalyticsHistory; lookups: ActivityLookups; readUsage: CliUsageReader; now?: () => number }) {
    this.history = options.history;
    this.lookups = options.lookups;
    this.readUsage = options.readUsage;
    this.now = options.now ?? Date.now;
  }

  /** Records are updated one event at a time, in the order the events were emitted. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    // A failed update must not stop later events from being recorded.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every event handed over so far has been recorded. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  handle(event: RecordedEvent): void {
    // Read now: the queue may reach this event later than it happened.
    const receivedAt = this.now();
    if (event.type === 'task' && 'task' in event) void this.enqueue(() => this.recordTask(event.task, receivedAt)).catch(() => undefined);
    else if (event.type === 'stepRun' && 'stepRun' in event) void this.enqueue(() => this.recordStepRun(event.stepRun)).catch(() => undefined);
  }

  private async account(profile: AccountProfile | undefined, executorId: string): Promise<{ account: string; agentLabel: string }> {
    const configured = await this.lookups.executor(executorId);
    const source = profile ?? configured;
    // An executor that is no longer configured still gets its own bucket rather than joining another account's.
    return { account: source ? accountIdentity(source) : `unknown-${executorId}`, agentLabel: configured?.label ?? executorId };
  }

  private async labelFor(task: TaskRecord): Promise<string> {
    if (task.kind === 'plan') return task.title ?? (task.planningSessionNumber ? `Planning session #${task.planningSessionNumber}` : 'Planning session');
    return (task.planItemId ? await this.lookups.planItemTitle(task.planItemId) : null) ?? 'Coding task';
  }

  private async newTaskRecord(task: TaskRecord, at: number, approximate: boolean): Promise<ActivityRecord> {
    const run = task.workflowRunId ? await this.lookups.workflowRun(task.workflowRunId) : undefined;
    return {
      id: task.id,
      ...await this.account(task.sessionExecutor, task.executorId),
      executorId: task.executorId,
      kind: task.kind === 'plan' ? 'planning' : 'coding',
      projectId: task.projectId,
      projectName: await this.lookups.projectName(task.projectId),
      taskId: task.id,
      planItemId: task.planItemId,
      label: await this.labelFor(task),
      workflow: run && task.workflowStepId ? workflowOf(run, task.workflowStepId) : null,
      segments: [],
      startedAt: at,
      endedAt: at,
      lastSeenAt: at,
      approximate,
      tokens: null,
    };
  }

  private async recordTask(task: TaskRecord, now: number): Promise<void> {
    const state = taskActivityState(task);
    const existing = await this.history.activity(task.id);
    // A Task first seen after it ended was never observed working, so there is nothing to show for it.
    if (!existing && state === 'ended') return;
    const changedAt = statusChangedAt(task);
    let record: ActivityRecord;
    let at: number;
    if (existing) {
      record = existing;
      // Not every state change moves the Task's own timestamp; one that left it behind happened now.
      at = changedAt !== null && changedAt > lastChangeAt(existing) ? changedAt : now;
    } else {
      // Every session starts in `starting`. One first seen further along began unobserved: it is shown from now, marked approximate.
      const startObserved = task.status === 'developing' && (task.runtimeStatus ?? 'starting') === 'starting';
      at = startObserved ? changedAt ?? now : now;
      record = await this.newTaskRecord(task, at, !startObserved);
    }
    // A planning session is named a little after it starts.
    const label = task.kind === 'plan' && task.title ? task.title : record.label;
    await this.history.putActivities([{ ...applyActivityState(record, state, at), label }]);
    // A session can be closed before its last turn's hook arrives, so read its usage once more now.
    const session = this.cliSessions.get(task.id);
    if (state === 'ended' && session) {
      this.cliSessions.delete(task.id);
      await this.assignCliUsage(session);
    }
  }

  private async recordStepRun(stepRun: StepRunRecord): Promise<void> {
    if (!stepRun.taskId) return;
    const record = await this.history.activity(stepRun.taskId);
    if (!record?.workflow) return;
    await this.history.putActivities([{ ...record, workflow: { ...record.workflow, round: stepRun.round, status: stepRun.status } }]);
  }

  /**
   * Called once at startup, before any Task is settled: a session still open in history lost its CLI
   * with the previous daemon, so it is closed at the last moment its state was known.
   */
  recoverInterrupted(): Promise<void> {
    return this.enqueue(async () => {
      const open = await this.history.activities((record) => record.endedAt === null);
      await this.history.putActivities(open.map(closeUnobserved));
    });
  }

  /** Notes that every open session is still being tracked, so a later restart closes it no earlier than now. */
  heartbeat(): Promise<void> {
    return this.enqueue(async () => {
      const now = this.now();
      const open = await this.history.activities((record) => record.endedAt === null);
      await this.history.putActivities(open.map((record) => ({ ...record, lastSeenAt: Math.max(record.lastSeenAt, now) })));
    });
  }

  /**
   * Notes where a Task's CLI keeps its session file and, when `turnEnded`, reads the usage reported
   * there and assigns what is new to that Task's round.
   */
  recordCliUsage(session: CliSession, turnEnded: boolean): Promise<void> {
    return this.enqueue(async () => {
      const record = await this.history.activity(session.taskId);
      if (record && record.endedAt === null) this.cliSessions.set(session.taskId, session);
      if (turnEnded) await this.assignCliUsage(session);
    });
  }

  private async assignCliUsage(session: CliSession): Promise<void> {
    const report = await this.readUsage(session.kind, session.sessionFile);
    if (!report) return;
    const record = await this.history.activity(session.taskId);
    if (!record) return;
    // Rounds that resume one conversation share its running total, whatever session id the CLI gives each.
    const conversation = report.conversation ?? session.sessionKey;
    const increment = usageIncrement(await this.history.sessionUsage(conversation), report.usage);
    // Nothing new since the last report: the round keeps what it has, or stays without evidence.
    if (totalTokens(increment) === 0) return;
    await this.history.assignSessionUsage(conversation, report.usage, { ...record, tokens: addTokens(record.tokens ?? NO_TOKENS, increment) });
  }

  trackBackground: BackgroundTurnTracker = async (executor, context, run) => {
    const id = await this.startBackground(executor, context).catch(() => null);
    try {
      const result = await run();
      if (id) await this.endBackground(id, result?.usage ?? null).catch(() => undefined);
      return result;
    } catch (error) {
      if (id) await this.endBackground(id, null).catch(() => undefined);
      throw error;
    }
  };

  private startBackground(executor: ExecutorProfile, context: BackgroundTurnContext): Promise<string> {
    return this.enqueue(async () => {
      const at = this.now();
      const projectId = context.projectId ?? context.workflowRun?.projectId ?? null;
      const planItemId = context.planItemId ?? context.workflowRun?.planItemId ?? null;
      const record: ActivityRecord = {
        id: `background-${randomUUID()}`,
        account: accountIdentity(executor),
        executorId: executor.id,
        agentLabel: executor.label,
        kind: 'background',
        projectId,
        projectName: projectId ? await this.lookups.projectName(projectId) : null,
        taskId: null,
        planItemId,
        label: context.purpose,
        workflow: context.workflowRun ? workflowOf(context.workflowRun, COMPLETE_STAGE.id) : null,
        segments: [{ state: 'active', start: at, end: null }],
        startedAt: at,
        endedAt: null,
        lastSeenAt: at,
        approximate: false,
        tokens: null,
      };
      await this.history.putActivities([record]);
      return record.id;
    });
  }

  private endBackground(id: string, usage: TokenUsage | null): Promise<void> {
    return this.enqueue(async () => {
      const record = await this.history.activity(id);
      if (!record) return;
      await this.history.putActivities([{ ...applyActivityState(record, 'ended', this.now()), tokens: usage ? tokenCounts(usage) : null }]);
    });
  }
}
