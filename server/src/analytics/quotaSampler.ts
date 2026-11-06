import type { ExecutorProfile } from '../domain/types.ts';
import type { ExecutorLimits } from '../executors/executorLimits.ts';
import { USAGE_REFRESH_MS, type UsageFailureReason, type UsagePoller, type UsagePollStatus } from '../executors/usagePoller.ts';
import { accountIdentity } from './accountIdentity.ts';
import { toQuotaReading, type AnalyticsHistory, type ConfiguredAgent } from './analyticsHistory.ts';

type QuotaPoller = Pick<UsagePoller, 'refresh' | 'status'>;

export interface QuotaSamplerDeps {
  history: AnalyticsHistory;
  listExecutors: () => Promise<ExecutorProfile[]>;
  /** One poller per provider; each ignores the other provider's profiles. */
  pollers: Partial<Record<ExecutorProfile['kind'], QuotaPoller>>;
  /** The freshest reading known for a profile, whichever source observed it. */
  readLimits: (executor: ExecutorProfile) => Promise<ExecutorLimits | null>;
  now?: () => number;
  /** Extra housekeeping after each scheduled sample. */
  afterTick?: () => Promise<void>;
}

/** What a manual Refresh did. `not-eligible` means the provider was not contacted because of throttling or backoff. */
export interface RefreshOutcome {
  result: 'refreshed' | 'not-eligible' | 'failed';
  failureReason: UsageFailureReason | null;
  /** When another manual check may contact the provider. */
  nextEligibleAt: number | null;
}

export function configuredAgent(executor: ExecutorProfile): ConfiguredAgent {
  return { executorId: executor.id, label: executor.label, kind: executor.kind, account: accountIdentity(executor) };
}

/**
 * Samples every configured account's quota into history about every five minutes, in the daemon, so
 * history grows with no browser open. It stores what the pollers observed, keyed by account and
 * observation time: profiles sharing an account, repeated reads and backoff periods add no duplicates.
 */
export class QuotaSampler {
  private deps: QuotaSamplerDeps;
  private now: () => number;

  constructor(deps: QuotaSamplerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Samples now, then on every interval. Returns the function that stops it. */
  start(): () => void {
    const sample = () => { void this.tick().catch(() => { /* Sample again on the next interval. */ }); };
    sample();
    const timer = setInterval(sample, USAGE_REFRESH_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  async tick(): Promise<void> {
    const executors = await this.deps.listExecutors();
    await this.deps.history.syncAgents(executors.map(configuredAgent));
    await Promise.all(Object.values(this.deps.pollers).map((poller) => poller.refresh(executors)));
    await this.capture(executors);
    await this.deps.afterTick?.();
  }

  status(executor: ExecutorProfile): UsagePollStatus | null {
    return this.deps.pollers[executor.kind]?.status(executor) ?? null;
  }

  /** A manual Refresh: contacts the provider only when it is eligible, and stores whatever was observed. */
  async refresh(executor: ExecutorProfile): Promise<RefreshOutcome> {
    const startedAt = this.now();
    const before = this.status(executor);
    const eligible = !before || startedAt >= before.nextManualAt;
    await this.deps.pollers[executor.kind]?.refresh([executor], { manual: true });
    await this.capture([executor]);
    const after = this.status(executor);
    const failure = eligible && after?.lastFailure && after.lastFailure.at >= startedAt ? after.lastFailure : null;
    return {
      result: !eligible ? 'not-eligible' : failure ? 'failed' : 'refreshed',
      failureReason: failure?.reason ?? null,
      nextEligibleAt: after?.nextManualAt ?? null,
    };
  }

  /** Stores each account's latest observation and latest failed check. Both are deduplicated by the history. */
  private async capture(executors: ExecutorProfile[]): Promise<void> {
    const collectionStartedAt = await this.deps.history.startedAt();
    const seen = new Set<string>();
    for (const executor of executors) {
      const account = accountIdentity(executor);
      if (seen.has(account)) continue;
      seen.add(account);
      const limits = await this.deps.readLimits(executor);
      const reading = limits ? toQuotaReading(limits) : null;
      // An observation from before collection began is not part of this history.
      if (reading && collectionStartedAt !== null && reading.at >= collectionStartedAt) await this.deps.history.recordReading(account, reading);
      const failure = this.status(executor)?.lastFailure;
      if (failure) await this.deps.history.recordFailure(account, failure);
    }
  }
}
