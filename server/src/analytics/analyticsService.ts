import type { ExecutorProfile, StepRunRecord, StepRunStatus } from '../domain/types.ts';
import type { UsageFailureReason } from '../executors/usagePoller.ts';
import { activeDurationMs, isActiveDuring, overlapsRange, workingSpan } from './activity.ts';
import { COMPLETE_STAGE } from './activityRecorder.ts';
import type { AnalyticsHistory, HistoryStatus } from './analyticsHistory.ts';
import { totalTokens } from './cliUsage.ts';
import { configuredAgent, type QuotaSampler, type RefreshOutcome } from './quotaSampler.ts';
import {
  buildWindowSeries, currentCapacity, findDrops, isUnbroken, mergeDrops, observedDecrease, sliceSeries,
  type CurrentCapacity, type ObservedDecrease, type SeriesDrop, type WindowSeries,
} from './quotaSeries.ts';
import { compareRound, comparisonGroup, COMPARISON_METRICS, type ComparisonMetric, type MetricComparison, type RoundSample } from './stepComparison.ts';
import {
  QUOTA_WINDOWS, RETENTION_MS,
  type ActivityKind, type ActivityRecord, type ActivitySegment, type AgentLink, type QuotaFailure, type QuotaReading, type QuotaWindowKey, type TokenCounts,
} from './types.ts';

export class AnalyticsAgentNotFoundError extends Error {
  constructor() {
    super('This coding agent has no analytics: it is not configured and has no retained history');
    this.name = 'AnalyticsAgentNotFoundError';
  }
}

export class AnalyticsRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsRangeError';
  }
}

/** The day view shows one local day; a day is 23 to 25 hours long across a daylight-saving change. */
const MAX_RANGE_MS = 25 * 60 * 60_000;
const RETIRED_PREFIX = 'retired-';

export interface AgentSummary {
  /** The profile's id, or `retired-<link id>` for a removed profile's retained history. */
  id: string;
  label: string;
  kind: ExecutorProfile['kind'];
  retired: boolean;
  retiredAt: number | null;
  /** Other configured profiles on the same provider account. They show the same readings: it is one capacity, not several. */
  sharedWith: string[];
}

/** Where selecting an activity leads. Null when the work it belonged to no longer exists. */
export type ActivityTarget =
  | { kind: 'run'; projectId: string; runId: string; stepId: string; round: number | null }
  | { kind: 'task'; projectId: string; taskId: string }
  | { kind: 'item'; projectId: string; planItemId: string };

/** An observed decrease plus how many other tracked sessions were working on the account at the same time. A shared decrease is never divided. */
export type DecreaseView = ObservedDecrease & { sharedWith: number };

export interface ActivityView {
  id: string;
  kind: ActivityKind;
  agentLabel: string;
  projectName: string | null;
  /** "Deleted task" once the work is gone. */
  label: string;
  deleted: boolean;
  workflow: { name: string; stepName: string; round: number | null } | null;
  /** The real start and end, even when the requested range shows only part of the session. */
  startedAt: number;
  endedAt: number | null;
  approximate: boolean;
  segments: ActivitySegment[];
  activeMs: number;
  decrease: Record<QuotaWindowKey, DecreaseView>;
  target: ActivityTarget | null;
}

export interface CheckStatus {
  lastSuccessAt: number | null;
  /** Set while the most recent check failed; the last successful reading is still the one shown. */
  lastFailure: { at: number; reason: UsageFailureReason } | null;
  /** When a manual Refresh may next contact the provider; null when it may now. */
  nextEligibleAt: number | null;
}

export interface AgentDayView {
  agent: AgentSummary;
  now: number;
  range: { from: number; to: number };
  /** The oldest moment history can cover: the start of collection, or the retention limit. */
  earliestAt: number;
  current: Record<QuotaWindowKey, CurrentCapacity>;
  check: CheckStatus;
  series: Record<QuotaWindowKey, WindowSeries>;
  activities: ActivityView[];
  /** Falls in remaining capacity while no tracked session was working on the account, each one uninterrupted stretch. */
  unattributed: (SeriesDrop & { window: QuotaWindowKey })[];
  history: HistoryStatus;
}

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
  /** `ms` is null when the record cannot support a duration. `approximate`: working and waiting time could not be told apart. */
  duration: { ms: number | null; live: boolean; approximate: boolean };
  /** Null when the CLI gave no usage evidence. `partial`: the round failed or was stopped, so this is what was confirmed, not a final total. */
  tokens: { counts: TokenCounts; total: number; partial: boolean } | null;
  decrease: Record<QuotaWindowKey, DecreaseView>;
  comparison: Record<ComparisonMetric, MetricComparison>;
  highUsage: ComparisonMetric[];
  target: ActivityTarget | null;
}

/** A step round recorded before activity collection began: only its start and finish times are known. */
export interface LegacyRound {
  stepRun: StepRunRecord;
  executorId: string;
  account: string | null;
  projectId: string;
  projectName: string | null;
  planItemId: string;
  label: string | null;
  workflowId: string;
  workflowName: string;
  stepName: string;
}

/** Whether the records an activity points at still exist. */
export interface RecordLookups {
  projectExists(id: string): Promise<boolean>;
  taskExists(id: string): Promise<boolean>;
  planItemExists(id: string): Promise<boolean>;
  runExists(id: string): Promise<boolean>;
}

export interface AnalyticsServiceDeps {
  history: AnalyticsHistory;
  sampler: QuotaSampler;
  listExecutors: () => Promise<ExecutorProfile[]>;
  records: RecordLookups;
  /** Rounds on `executorId` created at or after `since`. */
  legacyRounds: (executorId: string, since: number) => Promise<LegacyRound[]>;
  now?: () => number;
}

const DELETED_LABEL = 'Deleted task';
const UNKNOWN_DECREASE: Record<QuotaWindowKey, DecreaseView> = {
  fiveHour: { available: false, reason: 'missing-boundary-reading', sharedWith: 0 },
  sevenDay: { available: false, reason: 'missing-boundary-reading', sharedWith: 0 },
};
const DECREASE_METRIC: Record<QuotaWindowKey, ComparisonMetric> = { fiveHour: 'fiveHourDecrease', sevenDay: 'sevenDayDecrease' };

function roundStatus(status: StepRunStatus | null, live: boolean): RoundStatus {
  switch (status) {
    case 'done': case 'awaiting-approval': case 'changes-requested': return 'completed';
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    case 'running': return live ? 'running' : 'stopped';
    // The round's own record was never seen, so only the session's state is known.
    default: return live ? 'running' : 'stopped';
  }
}

function agentSummary(link: AgentLink, links: AgentLink[]): AgentSummary {
  const retired = link.retiredAt !== null;
  return {
    id: retired ? `${RETIRED_PREFIX}${link.id}` : link.executorId,
    label: link.label,
    kind: link.kind,
    retired,
    retiredAt: link.retiredAt,
    sharedWith: retired ? [] : links.filter((other) => other.id !== link.id && other.retiredAt === null && other.account === link.account).map((other) => other.label),
  };
}

/** An account's whole retained history, analysed once per request. */
interface AccountHistory {
  readings: QuotaReading[];
  failures: QuotaFailure[];
  series: Record<QuotaWindowKey, WindowSeries>;
  activities: ActivityRecord[];
}

/** Builds the Analytics view's answers from stored history. Reading never adds a quota observation. */
export class AnalyticsService {
  private deps: AnalyticsServiceDeps;
  private now: () => number;

  constructor(deps: AnalyticsServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private async links(): Promise<{ links: AgentLink[]; executors: ExecutorProfile[] }> {
    const executors = await this.deps.listExecutors();
    return { executors, links: await this.deps.history.syncAgents(executors.map(configuredAgent)) };
  }

  /** Every configured agent, then each removed one whose history is still retained. */
  async listAgents(): Promise<{ agents: AgentSummary[]; collectionStartedAt: number | null; history: HistoryStatus }> {
    const { links } = await this.links();
    const agents = links.map((link) => agentSummary(link, links)).sort((a, b) => Number(a.retired) - Number(b.retired));
    return { agents, collectionStartedAt: await this.deps.history.startedAt(), history: await this.deps.history.status() };
  }

  private async resolve(agentId: string): Promise<{ link: AgentLink; links: AgentLink[]; executor: ExecutorProfile | undefined }> {
    const { links, executors } = await this.links();
    const link = links.find((candidate) => agentSummary(candidate, links).id === agentId);
    if (!link) throw new AnalyticsAgentNotFoundError();
    return { link, links, executor: link.retiredAt === null ? executors.find((executor) => executor.id === link.executorId) : undefined };
  }

  /** A retired agent's history stops when it was retired, even if another profile still uses the account. */
  private async accountHistory(link: AgentLink): Promise<AccountHistory> {
    const until = link.retiredAt ?? Infinity;
    const [readings, failures, activities] = await Promise.all([
      this.deps.history.readingsFor(link.account, -Infinity, until),
      this.deps.history.failuresFor(link.account, -Infinity, until),
      this.deps.history.activities((record) => record.account === link.account && record.startedAt <= until),
    ]);
    return {
      readings, failures, activities,
      series: { fiveHour: buildWindowSeries(readings, failures, 'fiveHour'), sevenDay: buildWindowSeries(readings, failures, 'sevenDay') },
    };
  }

  private decreaseFor(record: ActivityRecord, account: AccountHistory, now: number): Record<QuotaWindowKey, DecreaseView> {
    const view = (window: QuotaWindowKey): DecreaseView => {
      // Measured around the agent's working time: a wait before it began or after it last worked is not the session's.
      const span = workingSpan(record);
      const decrease = observedDecrease(account.series[window], span?.start ?? record.startedAt, span ? span.end : record.endedAt);
      // Overlap is judged across the readings the decrease was measured between, since that is the period it covers.
      const [from, to] = decrease.available ? [decrease.from, decrease.to] : [record.startedAt, record.endedAt ?? now];
      const sharedWith = account.activities.filter((other) => other.id !== record.id && isActiveDuring(other, from, to, now)).length;
      return { ...decrease, sharedWith };
    };
    return { fiveHour: view('fiveHour'), sevenDay: view('sevenDay') };
  }

  private async targetFor(record: Pick<ActivityRecord, 'kind' | 'projectId' | 'taskId' | 'planItemId' | 'workflow'>): Promise<{ deleted: boolean; target: ActivityTarget | null }> {
    const { records } = this.deps;
    const { projectId, taskId, planItemId, workflow } = record;
    // A plan item owns its coding and background work; a planning session is its own Task.
    const deleted = planItemId ? !await records.planItemExists(planItemId) : taskId ? !await records.taskExists(taskId) : false;
    if (deleted || !projectId || !await records.projectExists(projectId)) return { deleted, target: null };
    if (workflow && await records.runExists(workflow.runId)) return { deleted, target: { kind: 'run', projectId, runId: workflow.runId, stepId: workflow.stepId, round: workflow.round } };
    if (taskId && await records.taskExists(taskId)) return { deleted, target: { kind: 'task', projectId, taskId } };
    if (planItemId) return { deleted, target: { kind: 'item', projectId, planItemId } };
    return { deleted, target: null };
  }

  private async activityView(record: ActivityRecord, account: AccountHistory, now: number): Promise<ActivityView> {
    const { deleted, target } = await this.targetFor(record);
    return {
      id: record.id,
      kind: record.kind,
      agentLabel: record.agentLabel,
      projectName: record.projectName,
      label: deleted ? DELETED_LABEL : record.label,
      deleted,
      workflow: record.workflow ? { name: record.workflow.name, stepName: record.workflow.stepName, round: record.workflow.round } : null,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      approximate: record.approximate,
      segments: record.segments,
      activeMs: activeDurationMs(record, now),
      decrease: this.decreaseFor(record, account, now),
      target,
    };
  }

  private assertRange(from: number, to: number, now: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new AnalyticsRangeError('from and to must be times in milliseconds');
    if (to <= from || to - from > MAX_RANGE_MS) throw new AnalyticsRangeError('The range must be one day');
    if (to < now - RETENTION_MS) throw new AnalyticsRangeError('That day is older than the 90 days of history kept');
    if (from > now) throw new AnalyticsRangeError('That day has not happened yet');
  }

  private check(account: AccountHistory, executor: ExecutorProfile | undefined, now: number): CheckStatus {
    const latest = account.readings.at(-1);
    const failure = account.failures.at(-1);
    const nextEligibleAt = executor ? this.deps.sampler.status(executor)?.nextManualAt ?? null : null;
    return {
      lastSuccessAt: latest?.at ?? null,
      lastFailure: failure && failure.at > (latest?.at ?? -Infinity) ? failure : null,
      nextEligibleAt: nextEligibleAt !== null && nextEligibleAt > now ? nextEligibleAt : null,
    };
  }

  /** One agent's capacity, readings and activity for the range `[from, to]`. */
  async getDay(agentId: string, from: number, to: number): Promise<AgentDayView> {
    const now = this.now();
    this.assertRange(from, to, now);
    const { link, links, executor } = await this.resolve(agentId);
    const account = await this.accountHistory(link);
    const check = this.check(account, executor, now);
    const current = (window: QuotaWindowKey) => currentCapacity(account.readings.at(-1), window, now, check.lastFailure?.at ?? null);
    const visible = account.activities.filter((record) => overlapsRange(record, from, to, now)).sort((a, b) => a.startedAt - b.startedAt);
    const tracked = (start: number, end: number) => account.activities.some((record) => isActiveDuring(record, start, end, now));
    // One stretch runs until tracked work, a gap or a reset interrupts it; level readings in between do not split it.
    const unattributed = QUOTA_WINDOWS.flatMap((window) => mergeDrops(
      findDrops(sliceSeries(account.series[window], from, to)).filter((drop) => !tracked(drop.from, drop.to)),
      (start, end) => isUnbroken(account.series[window], start, end) && !tracked(start, end),
    ).map((drop) => ({ ...drop, window })));
    return {
      agent: agentSummary(link, links),
      now,
      range: { from, to },
      earliestAt: Math.max(now - RETENTION_MS, await this.deps.history.startedAt() ?? now),
      current: { fiveHour: current('fiveHour'), sevenDay: current('sevenDay') },
      check,
      series: { fiveHour: sliceSeries(account.series.fiveHour, from, to), sevenDay: sliceSeries(account.series.sevenDay, from, to) },
      activities: await Promise.all(visible.map((record) => this.activityView(record, account, now))),
      unattributed,
      history: await this.deps.history.status(),
    };
  }

  /** A manual Refresh, then the provider's answer in terms of the agent's check status. A retired agent has nothing to refresh. */
  async refresh(agentId: string): Promise<RefreshOutcome & { check: CheckStatus; history: HistoryStatus }> {
    const { link, executor } = await this.resolve(agentId);
    if (!executor) throw new AnalyticsAgentNotFoundError();
    const outcome = await this.deps.sampler.refresh(executor);
    const account = await this.accountHistory(link);
    return { ...outcome, check: this.check(account, executor, this.now()), history: await this.deps.history.status() };
  }

  /** Every comparable WorkflowRun step round this agent ran, newest first, each judged against the earlier rounds of its group. */
  async getSteps(agentId: string): Promise<{ agent: AgentSummary; now: number; rows: StepRoundRow[] }> {
    const now = this.now();
    const { link, links } = await this.resolve(agentId);
    const account = await this.accountHistory(link);
    const recorded = account.activities.filter((record) => record.kind === 'coding' && record.executorId === link.executorId
      && record.workflow && record.workflow.stepId !== COMPLETE_STAGE.id && record.workflow.status !== 'skipped');
    const rows = [
      ...await Promise.all(recorded.map((record) => this.recordedRow(record, account, link, now))),
      ...await this.legacyRows(link, new Set(account.activities.map((record) => record.id)), now),
    ];
    const samples = rows.map((row) => row.sample);
    return {
      agent: agentSummary(link, links),
      now,
      rows: rows.map(({ row, sample }) => {
        const comparison = compareRound(sample, samples, now);
        return { ...row, comparison, highUsage: COMPARISON_METRICS.filter((metric) => comparison[metric].highUsage) };
      }).sort((a, b) => b.startedAt - a.startedAt),
    };
  }

  private async recordedRow(record: ActivityRecord, account: AccountHistory, link: AgentLink, now: number): Promise<{ row: Omit<StepRoundRow, 'comparison' | 'highUsage'>; sample: RoundSample }> {
    const workflow = record.workflow!;
    const live = record.endedAt === null;
    const status = roundStatus(workflow.status, live);
    const completed = status === 'completed';
    const durationMs = activeDurationMs(record, now);
    const decrease = this.decreaseFor(record, account, now);
    const comparable = (window: QuotaWindowKey): number | null => {
      const view = decrease[window];
      return view.available && view.sharedWith === 0 ? view.points : null;
    };
    const { deleted, target } = await this.targetFor(record);
    return {
      row: {
        id: record.id,
        projectName: record.projectName,
        label: deleted ? DELETED_LABEL : record.label,
        deleted,
        workflowName: workflow.name,
        stepName: workflow.stepName,
        round: workflow.round,
        status,
        startedAt: record.startedAt,
        finishedAt: record.endedAt,
        duration: { ms: durationMs, live, approximate: record.approximate },
        tokens: record.tokens ? { counts: record.tokens, total: totalTokens(record.tokens), partial: !completed && !live } : null,
        decrease,
        target,
      },
      sample: {
        id: record.id,
        group: comparisonGroup(workflow.id, workflow.stepName, link.id),
        completed,
        finishedAt: record.endedAt,
        metrics: {
          activeDuration: record.approximate ? null : durationMs,
          tokens: record.tokens ? totalTokens(record.tokens) : null,
          [DECREASE_METRIC.fiveHour]: comparable('fiveHour'),
          [DECREASE_METRIC.sevenDay]: comparable('sevenDay'),
        } as Record<ComparisonMetric, number | null>,
      },
    };
  }

  /**
   * Rounds from before collection began. Their records hold only a start and a finish, which cannot
   * separate working from waiting, so the duration is approximate and nothing about them feeds a median.
   */
  private async legacyRows(link: AgentLink, recordedIds: Set<string>, now: number): Promise<{ row: Omit<StepRoundRow, 'comparison' | 'highUsage'>; sample: RoundSample }[]> {
    const legacy = (await this.deps.legacyRounds(link.executorId, now - RETENTION_MS)).filter(({ stepRun, account }) => stepRun.taskId !== null && !recordedIds.has(stepRun.taskId)
      && (account === null || account === link.account) && stepRun.status !== 'skipped' && stepRun.status !== 'running');
    return Promise.all(legacy.map(async (round) => {
      const { stepRun } = round;
      const startedAt = Date.parse(stepRun.createdAt);
      const finishedAt = stepRun.completedAt ? Date.parse(stepRun.completedAt) : null;
      const { deleted, target } = await this.targetFor({
        kind: 'coding', projectId: round.projectId, taskId: stepRun.taskId, planItemId: round.planItemId,
        workflow: { id: round.workflowId, name: round.workflowName, runId: stepRun.runId, stepId: stepRun.stepId, stepName: round.stepName, round: stepRun.round, status: stepRun.status },
      });
      return {
        row: {
          id: stepRun.id,
          projectName: round.projectName,
          label: deleted ? DELETED_LABEL : round.label ?? 'Coding task',
          deleted,
          workflowName: round.workflowName,
          stepName: round.stepName,
          round: stepRun.round,
          status: roundStatus(stepRun.status, false),
          startedAt,
          finishedAt,
          duration: { ms: finishedAt === null ? null : Math.max(0, finishedAt - startedAt), live: false, approximate: true },
          tokens: null,
          decrease: UNKNOWN_DECREASE,
          target,
        },
        sample: {
          id: stepRun.id,
          group: comparisonGroup(round.workflowId, round.stepName, link.id),
          // Never a baseline: none of its metrics is trustworthy enough to compare.
          completed: false,
          finishedAt,
          metrics: { activeDuration: null, tokens: null, fiveHourDecrease: null, sevenDayDecrease: null },
        },
      };
    }));
  }
}
