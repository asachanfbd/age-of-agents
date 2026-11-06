import type { ExecutorProfile } from '../domain/types.ts';
import type { ExecutorLimits } from './executorLimits.ts';

export const USAGE_REFRESH_MS = 5 * 60_000;
/** A manual Refresh may re-check sooner than the schedule, but never more often than this, and never inside a failure backoff. */
export const MANUAL_REFRESH_MIN_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/**
 * How much earlier than a full interval a scheduled check is let through. The caller's timer fires one
 * interval after its previous tick began, and reaches the poller a little sooner or later each time;
 * without this slack a tick arriving a moment early would be skipped and the real cadence would double.
 */
export const SCHEDULE_TOLERANCE_MS = 30_000;

/** Why a quota check produced no reading. `no-access` means the account or CLI could not be used at all. */
export type UsageFailureReason = 'no-access' | 'provider-error';

export class UsageReadError extends Error {
  reason: UsageFailureReason;
  retryAfterMs: number;
  /** Whether repeated failures of this kind lengthen the wait before the next check. */
  backsOff: boolean;
  constructor(reason: UsageFailureReason, retryAfterMs = 0, backsOff = reason !== 'no-access') {
    super(reason === 'no-access' ? 'Account usage is not accessible' : 'Account usage request failed');
    this.name = 'UsageReadError';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
    this.backsOff = backsOff;
  }
}

/** One provider's way of reading an account's quota. `accountKey` identifies the account: profiles with the same key share one reading. */
export interface UsageSource {
  kind: ExecutorProfile['kind'];
  accountKey(executor: ExecutorProfile): string;
  read(executor: ExecutorProfile): Promise<ExecutorLimits>;
}

export interface UsagePollStatus {
  /** The last failed check, cleared by the next successful one. */
  lastFailure: { at: number; reason: UsageFailureReason } | null;
  /** When the scheduled poll may next contact the provider. */
  nextAttemptAt: number;
  /** When a manual Refresh may next contact the provider. */
  nextManualAt: number;
}

interface PollState extends UsagePollStatus {
  limits: ExecutorLimits | null;
  failures: number;
  inFlight?: Promise<void>;
}

/**
 * Polls one provider's quota per account: concurrent requests for one account share a call, a failed
 * check keeps the last good reading and backs off from ten minutes up to an hour, and a longer
 * provider `Retry-After` is honoured.
 */
export class UsagePoller {
  private states = new Map<string, PollState>();
  private source: UsageSource;
  private now: () => number;

  constructor(source: UsageSource, now: () => number = Date.now) {
    this.source = source;
    this.now = now;
  }

  get(executor: ExecutorProfile): ExecutorLimits | null {
    return this.states.get(this.source.accountKey(executor))?.limits ?? null;
  }

  status(executor: ExecutorProfile): UsagePollStatus | null {
    const state = this.states.get(this.source.accountKey(executor));
    return state ? { lastFailure: state.lastFailure, nextAttemptAt: state.nextAttemptAt, nextManualAt: state.nextManualAt } : null;
  }

  async refresh(executors: ExecutorProfile[], options: { manual?: boolean } = {}): Promise<void> {
    await Promise.all(executors.filter((executor) => executor.kind === this.source.kind).map((executor) => this.refreshOne(executor, options.manual === true)));
  }

  private async refreshOne(executor: ExecutorProfile, manual: boolean): Promise<void> {
    const key = this.source.accountKey(executor);
    let state = this.states.get(key);
    if (!state) { state = { limits: null, failures: 0, lastFailure: null, nextAttemptAt: 0, nextManualAt: 0 }; this.states.set(key, state); }
    if (state.inFlight) return state.inFlight;
    if (this.now() < (manual ? state.nextManualAt : state.nextAttemptAt)) return;
    const current = state;
    current.inFlight = this.poll(executor, current);
    try { await current.inFlight; } finally { current.inFlight = undefined; }
  }

  private async poll(executor: ExecutorProfile, state: PollState): Promise<void> {
    const startedAt = this.now();
    try {
      state.limits = await this.source.read(executor);
      state.failures = 0;
      state.lastFailure = null;
      this.schedule(state, startedAt, USAGE_REFRESH_MS, MANUAL_REFRESH_MIN_MS);
    } catch (error) {
      // Never log the error: request libraries can include authorization headers in it.
      const reason = error instanceof UsageReadError ? error.reason : 'provider-error';
      state.lastFailure = { at: this.now(), reason };
      if (error instanceof UsageReadError && !error.backsOff) { this.schedule(state, startedAt, USAGE_REFRESH_MS, MANUAL_REFRESH_MIN_MS); return; }
      state.failures += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, USAGE_REFRESH_MS * 2 ** Math.min(state.failures, 4));
      const retryAfterMs = error instanceof UsageReadError ? error.retryAfterMs : 0;
      this.schedule(state, startedAt, backoff, Math.max(backoff, retryAfterMs), retryAfterMs);
    }
  }

  /**
   * Sets when the next checks may run. The scheduled one is counted from when this check started, less
   * the tolerance, so a timer on the same interval is never a moment too early; the time the provider
   * took to answer does not push it back. A provider's `Retry-After` is counted from now and never shortened.
   */
  private schedule(state: PollState, startedAt: number, scheduledMs: number, manualMs: number, retryAfterMs = 0): void {
    const now = this.now();
    state.nextAttemptAt = Math.max(startedAt + scheduledMs - SCHEDULE_TOLERANCE_MS, now + retryAfterMs);
    state.nextManualAt = now + manualMs;
  }
}
