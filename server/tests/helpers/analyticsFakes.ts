import type { ExecutorProfile, StepRunRecord, TaskRecord, WorkflowRunRecord } from '../../src/domain/types.ts';
import { ZERO_TOKEN_USAGE } from '../../src/domain/types.ts';
import type { ExecutorLimits } from '../../src/executors/executorLimits.ts';
import { UsagePoller, UsageReadError } from '../../src/executors/usagePoller.ts';
import { ActivityRecorder, type ActivityLookups } from '../../src/analytics/activityRecorder.ts';
import { AnalyticsHistory, type HistoryStorage } from '../../src/analytics/analyticsHistory.ts';
import { AnalyticsService, type LegacyRound, type RecordLookups } from '../../src/analytics/analyticsService.ts';
import type { CliUsageReader } from '../../src/analytics/cliUsage.ts';
import { QuotaSampler } from '../../src/analytics/quotaSampler.ts';
import type { QuotaReading, TokenCounts } from '../../src/analytics/types.ts';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** 2026-10-07T00:00:00Z: a fixed start for every injected clock. */
export const T0 = Date.UTC(2026, 9, 7);

export interface FakeClock { now: () => number; set(at: number): void; advance(ms: number): void }

export function fakeClock(start = T0): FakeClock {
  let current = start;
  return { now: () => current, set: (at) => { current = at; }, advance: (ms) => { current += ms; } };
}

/** History storage held in memory. `failWrites`/`failReads` make it throw; `files` is what a restarted daemon would read. */
export function memoryStorage(files = new Map<string, string>()): HistoryStorage & { files: Map<string, string>; failWrites: boolean | string; failReads: boolean; writes: number } {
  const storage = {
    files,
    /** True fails every write; a file name fails writes of that file only. */
    failWrites: false as boolean | string,
    failReads: false,
    writes: 0,
    async read(name: string) {
      if (storage.failReads) throw new Error('disk unreadable');
      return files.get(name) ?? null;
    },
    async write(name: string, text: string) {
      if (storage.failWrites === true || storage.failWrites === name) throw new Error('disk full');
      storage.writes += 1;
      files.set(name, text);
    },
  };
  return storage;
}

export const claudeA: ExecutorProfile = { id: 'claude-a', label: 'Claude A', kind: 'claude-cli', bin: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/analytics-account-a' } };
/** A second profile on the same provider account as `claudeA`. */
export const claudeA2: ExecutorProfile = { ...claudeA, id: 'claude-a-2', label: 'Claude A (second profile)' };
export const claudeB: ExecutorProfile = { id: 'claude-b', label: 'Claude B', kind: 'claude-cli', bin: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/analytics-account-b' } };
export const codex: ExecutorProfile = { id: 'codex', label: 'Codex', kind: 'codex-cli', bin: 'codex', env: { CODEX_HOME: '/tmp/analytics-codex' } };

/** A provider reading in the pollers' own shape (seconds). `null` leaves that window unreported. */
export function limits(atMs: number, fiveHourUsed: number | null, sevenDayUsed: number | null, resets: { fiveHour?: number | null; sevenDay?: number | null } = {}): ExecutorLimits {
  const window = (used: number | null, resetsAtMs: number | null | undefined) => used === null ? null : { usedPercentage: used, resetsAt: resetsAtMs == null ? null : resetsAtMs / 1000 };
  return { observedAt: atMs / 1000, fiveHour: window(fiveHourUsed, resets.fiveHour), sevenDay: window(sevenDayUsed, resets.sevenDay) };
}

/** A stored reading. Reset times default far enough ahead that nothing resets by accident. */
export function reading(at: number, fiveHourUsed: number | null, sevenDayUsed: number | null = 10, resets: { fiveHour?: number | null; sevenDay?: number | null } = {}): QuotaReading {
  const window = (used: number | null, resetsAt: number | null) => used === null ? null : { usedPercentage: used, resetsAt };
  return {
    at,
    fiveHour: window(fiveHourUsed, resets.fiveHour === undefined ? T0 + 30 * DAY : resets.fiveHour),
    sevenDay: window(sevenDayUsed, resets.sevenDay === undefined ? T0 + 60 * DAY : resets.sevenDay),
  };
}

/**
 * A fake provider behind the real poller, so backoff and manual-refresh rules are the production
 * ones. `next` is what the provider answers: a reading, or an error to throw.
 */
export function fakeProvider(kind: ExecutorProfile['kind'], clock: FakeClock, accountKey: (executor: ExecutorProfile) => string = (executor) => JSON.stringify(executor.env)) {
  const provider = {
    calls: 0,
    /** How long the provider takes to answer, on the injected clock. */
    readMs: 0,
    next: null as ExecutorLimits | Error | null,
    /** Which profiles have an account the provider knows; the rest get "no account access". */
    accepts: (_executor: ExecutorProfile): boolean => true,
    poller: null as unknown as UsagePoller,
  };
  provider.poller = new UsagePoller({
    kind,
    accountKey,
    async read(executor) {
      if (!provider.accepts(executor)) throw new UsageReadError('no-access');
      provider.calls += 1;
      await Promise.resolve();
      clock.advance(provider.readMs);
      if (provider.next instanceof Error) throw provider.next;
      if (!provider.next) throw new UsageReadError('provider-error');
      return provider.next;
    },
  }, clock.now);
  return provider;
}

const T = new Date(T0).toISOString();

export function taskRecord(patch: Partial<TaskRecord> & Pick<TaskRecord, 'id'>): TaskRecord {
  return {
    projectId: 'project-1', templateId: 'template', executorId: claudeA.id, executionMode: 'terminal', description: 'SECRET-PROMPT-TEXT do the thing',
    status: 'developing', autonomy: 'auto', manager: false, kind: 'execute', planItemId: null, sessionId: null,
    runtimeStatus: 'starting', runtimeWaitingReason: null, runtimeStatusChangedAt: T, blockedQuestion: null, failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE, createdAt: T, updatedAt: T, completedAt: null, ...patch,
  };
}

/** The Task as it reads once its runtime state changed at `at`. */
export function taskAt(task: TaskRecord, at: number, patch: Partial<TaskRecord>): TaskRecord {
  return { ...task, ...patch, runtimeStatusChangedAt: new Date(at).toISOString() };
}

export function workflowRun(patch: Partial<WorkflowRunRecord> & Pick<WorkflowRunRecord, 'id'>): WorkflowRunRecord {
  const step = (id: string, name: string) => ({ id, name, agentId: 'agent', instructions: '', canEditCode: true, requiresApproval: false });
  return {
    projectId: 'project-1', planItemId: 'item-1', workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'Software Development', description: '', enabled: true, steps: [step('development', 'Development'), step('code-review', 'Code Review')] },
    status: 'running', currentStepId: 'development', executorId: claudeA.id, prUrl: null, completionReport: null, attentionReason: null,
    loopRoundAllowance: 0, createdAt: T, updatedAt: T, completedAt: null, ...patch,
  };
}

export function stepRun(patch: Partial<StepRunRecord> & Pick<StepRunRecord, 'id' | 'runId' | 'taskId'>): StepRunRecord {
  return { stepId: 'development', round: 1, status: 'running', summary: null, outputs: [], verdict: null, skippedReason: null, approval: null, createdAt: T, completedAt: null, ...patch };
}

/** The records the recorder and service look up, as plain maps a test can add to and delete from. */
export function fakeWorld(executors: ExecutorProfile[] = [claudeA]) {
  const state = {
    executors,
    projects: new Map<string, string>([['project-1', 'Age of Agents']]),
    planItems: new Map<string, string>([['item-1', '8.001: Analytics']]),
    tasks: new Set<string>(),
    runs: new Map<string, WorkflowRunRecord>(),
    legacy: [] as LegacyRound[],
  };
  const lookups: ActivityLookups = {
    executor: async (id) => state.executors.find((executor) => executor.id === id),
    projectName: async (id) => state.projects.get(id) ?? null,
    planItemTitle: async (id) => state.planItems.get(id) ?? null,
    workflowRun: async (id) => state.runs.get(id),
  };
  const records: RecordLookups = {
    projectExists: async (id) => state.projects.has(id),
    taskExists: async (id) => state.tasks.has(id),
    planItemExists: async (id) => state.planItems.has(id),
    runExists: async (id) => state.runs.has(id),
  };
  return Object.assign(state, { lookups, records });
}

/** History, recorder, sampler and service wired together on one injected clock, with fake providers and no real CLI or account. */
export function analyticsHarness(options: { executors?: ExecutorProfile[]; storage?: ReturnType<typeof memoryStorage>; clock?: FakeClock } = {}) {
  const clock = options.clock ?? fakeClock();
  const storage = options.storage ?? memoryStorage();
  const world = fakeWorld(options.executors ?? [claudeA]);
  const history = new AnalyticsHistory({ storage, now: clock.now });
  const claude = fakeProvider('claude-cli', clock);
  const codexProvider = fakeProvider('codex-cli', clock);
  const usage = new Map<string, TokenCounts | null>();
  const readUsage: CliUsageReader = async (_kind, file) => {
    const counts = usage.get(file);
    return counts ? { usage: counts, conversation: null } : null;
  };
  const recorder = new ActivityRecorder({ history, lookups: world.lookups, readUsage, now: clock.now });
  /** Extra readings by profile id, standing in for the Claude status-line cache. */
  const cached = new Map<string, ExecutorLimits>();
  const sampler = new QuotaSampler({
    history,
    listExecutors: async () => world.executors,
    pollers: { 'claude-cli': claude.poller, 'codex-cli': codexProvider.poller },
    readLimits: async (executor) => {
      const polled = (executor.kind === 'codex-cli' ? codexProvider : claude).poller.get(executor);
      const extra = cached.get(executor.id) ?? null;
      return extra && (!polled || extra.observedAt > polled.observedAt) ? extra : polled;
    },
    now: clock.now,
    afterTick: () => recorder.heartbeat(),
  });
  const service = new AnalyticsService({ history, sampler, listExecutors: async () => world.executors, records: world.records, legacyRounds: async (executorId, since) => world.legacy.filter((round) => round.executorId === executorId && Date.parse(round.stepRun.createdAt) >= since), now: clock.now });
  return { clock, storage, world, history, claude, codex: codexProvider, usage, cached, recorder, sampler, service };
}

export type AnalyticsHarness = ReturnType<typeof analyticsHarness>;

export const tokens = (inputTokens: number, outputTokens = 0, cacheCreationInputTokens = 0, cacheReadInputTokens = 0): TokenCounts =>
  ({ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens });
