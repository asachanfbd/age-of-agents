import type { ExecutorProfile, NotificationSubject } from '../domain/types.ts';
import type { ExecutorLimits, LimitWindow } from './executorLimits.ts';

export type DefaultChangeReason = 'manual' | 'exhausted' | 'removed' | 'initial';

export interface DefaultChangedEvent {
  type: 'executors.default_changed';
  defaultExecutorId: string;
  previousExecutorId: string | null;
  reason: DefaultChangeReason;
}

export class DefaultExecutorNotFoundError extends Error {
  constructor() {
    super('This executor is not configured');
    this.name = 'DefaultExecutorNotFoundError';
  }
}

export class DefaultExecutorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefaultExecutorUnavailableError';
  }
}

type WindowName = '5-hour' | '7-day';

/** A window that is at 100% and whose reset is unknown or still ahead blocks the agent. `resetsAt` is epoch seconds. */
function isBlocking(window: LimitWindow | null | undefined, now: number): boolean {
  return !!window && window.usedPercentage >= 100 && (window.resetsAt === null || window.resetsAt * 1000 > now);
}

/** The usage a window counts for when ranking: a missing or already-reset window is unused. */
function activeUsage(window: LimitWindow | null | undefined, now: number): number {
  if (!window) return 0;
  if (window.resetsAt !== null && window.resetsAt * 1000 <= now) return 0;
  return window.usedPercentage;
}

export function isAvailable(limits: ExecutorLimits | null | undefined, now: number): boolean {
  return !isBlocking(limits?.fiveHour, now) && !isBlocking(limits?.sevenDay, now);
}

/** Which blocking window to name and when it resets (null when unknown): the one that resets later when both block. */
export function exhaustion(limits: ExecutorLimits | null | undefined, now: number): { window: WindowName; resetsAt: number | null } | null {
  const blocking: { window: WindowName; resetsAt: number | null }[] = [];
  if (isBlocking(limits?.fiveHour, now)) blocking.push({ window: '5-hour', resetsAt: limits!.fiveHour!.resetsAt });
  if (isBlocking(limits?.sevenDay, now)) blocking.push({ window: '7-day', resetsAt: limits!.sevenDay!.resetsAt });
  if (blocking.length === 0) return null;
  // An unknown reset is treated as the latest one.
  return blocking.reduce((later, next) => (later.resetsAt === null ? later : next.resetsAt === null || next.resetsAt > later.resetsAt ? next : later));
}

export interface AgentReading {
  executor: ExecutorProfile;
  limits: ExecutorLimits | null;
}

/** Lowest active 5-hour usage, then lowest active 7-day usage, ties in configured order. Null when none is available. */
export function pickMostQuotaLeft(readings: AgentReading[], now: number): ExecutorProfile | null {
  const available = readings.filter(({ limits }) => isAvailable(limits, now));
  const score = ({ limits }: AgentReading) => [activeUsage(limits?.fiveHour, now), activeUsage(limits?.sevenDay, now)] as const;
  let best: AgentReading | undefined;
  for (const candidate of available) {
    if (!best) { best = candidate; continue; }
    const [a5, a7] = score(candidate);
    const [b5, b7] = score(best);
    if (a5 < b5 || (a5 === b5 && a7 < b7)) best = candidate;
  }
  return best?.executor ?? null;
}

function formatReset(resetsAt: number | null): string {
  return resetsAt === null ? 'at an unknown time' : new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Why an unavailable agent cannot be chosen, with its reset time. */
export function unavailableReason(label: string, limits: ExecutorLimits | null | undefined, now: number): string {
  const found = exhaustion(limits, now);
  const reset = found?.resetsAt ?? null;
  return `${label} is out of quota (${found?.window ?? '5-hour'} limit) and ${reset === null ? 'its reset time is unknown' : `resets ${formatReset(reset)}`}`;
}

interface StoredDefault { id: 'default'; executorId: string; label: string }

export interface DefaultExecutorStore {
  get(): Promise<StoredDefault | undefined>;
  set(value: { executorId: string; label: string }): Promise<void>;
  clear(): Promise<void>;
}

export interface DefaultExecutorDeps {
  listExecutors: () => Promise<ExecutorProfile[]>;
  readLimits: (executor: ExecutorProfile) => Promise<ExecutorLimits | null>;
  store: DefaultExecutorStore;
  raise: (input: { kind: 'executor.default_switched'; subject: NotificationSubject; title: string; description: string }) => Promise<unknown>;
  resolve: (subject: NotificationSubject, kinds: ['executor.default_switched']) => Promise<void>;
  now?: () => number;
}

const APP_SUBJECT: NotificationSubject = { type: 'app' };

/**
 * Owns the one app-wide default coding agent. Every change runs through a single queue, so two
 * quota readings arriving together, or a manual choice landing during a re-check, never interleave.
 */
export class DefaultExecutorService {
  private deps: DefaultExecutorDeps;
  private listeners = new Set<(event: DefaultChangedEvent) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: DefaultExecutorDeps) {
    this.deps = deps;
  }

  onEvent(listener: (event: DefaultChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The stored default's id, or null. */
  async current(): Promise<string | null> {
    return (await this.deps.store.get())?.executorId ?? null;
  }

  /** Applies the sticky/first-pick/removed rules against the current agents and quota. Safe to call at any time. */
  recheck(): Promise<void> {
    return this.enqueue(() => this.evaluate());
  }

  /** Sets the default by hand. Refuses unknown (404) and out-of-quota (409) agents; the current default is a no-op. */
  setDefault(executorId: string): Promise<string> {
    return this.enqueue(async () => {
      const executors = await this.deps.listExecutors();
      const target = executors.find((e) => e.id === executorId);
      if (!target) throw new DefaultExecutorNotFoundError();
      const limits = await this.safeLimits(target);
      const now = this.now();
      if (!isAvailable(limits, now)) throw new DefaultExecutorUnavailableError(unavailableReason(target.label, limits, now));
      const stored = await this.deps.store.get();
      if (stored?.executorId === target.id) return target.id;
      await this.deps.store.set({ executorId: target.id, label: target.label });
      await this.deps.resolve(APP_SUBJECT, ['executor.default_switched']);
      this.emit({ type: 'executors.default_changed', defaultExecutorId: target.id, previousExecutorId: stored?.executorId ?? null, reason: 'manual' });
      return target.id;
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A failed read counts as missing data, which counts as available. */
  private async safeLimits(executor: ExecutorProfile): Promise<ExecutorLimits | null> {
    try { return await this.deps.readLimits(executor); } catch { return null; }
  }

  private async evaluate(): Promise<void> {
    const executors = await this.deps.listExecutors();
    const readings = await Promise.all(executors.map(async (executor) => ({ executor, limits: await this.safeLimits(executor) })));
    const now = this.now();
    const stored = await this.deps.store.get();
    const best = pickMostQuotaLeft(readings, now);

    if (!stored) {
      if (best) await this.switchTo(best, null, 'initial', null);
      return;
    }
    const current = readings.find(({ executor }) => executor.id === stored.executorId);
    if (!current) {
      if (best) await this.switchTo(best, stored, 'removed', null);
      else await this.deps.store.clear();
      return;
    }
    if (current.executor.label !== stored.label) await this.deps.store.set({ executorId: stored.executorId, label: current.executor.label });
    if (!isAvailable(current.limits, now) && best) await this.switchTo(best, { ...stored, label: current.executor.label }, 'exhausted', current.limits);
  }

  private async switchTo(next: ExecutorProfile, previous: StoredDefault | null, reason: DefaultChangeReason, oldLimits: ExecutorLimits | null): Promise<void> {
    await this.deps.store.set({ executorId: next.id, label: next.label });
    if (previous && (reason === 'exhausted' || reason === 'removed')) {
      await this.deps.raise({
        kind: 'executor.default_switched',
        subject: APP_SUBJECT,
        title: 'Default coding agent changed',
        description: reason === 'removed'
          ? `${previous.label} was removed. New sessions now use ${next.label}.`
          : this.exhaustedDescription(previous.label, next.label, oldLimits),
      });
    }
    this.emit({ type: 'executors.default_changed', defaultExecutorId: next.id, previousExecutorId: previous?.executorId ?? null, reason });
  }

  private exhaustedDescription(oldLabel: string, newLabel: string, limits: ExecutorLimits | null): string {
    const found = exhaustion(limits, this.now());
    const reset = found?.resetsAt == null ? 'at an unknown time' : formatReset(found.resetsAt);
    return `${oldLabel} has used its ${found?.window ?? '5-hour'} limit (resets ${reset}). New sessions now use ${newLabel}.`;
  }

  private emit(event: DefaultChangedEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
