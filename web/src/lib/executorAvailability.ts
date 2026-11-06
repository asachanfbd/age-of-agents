import type { ExecutorProfile } from './serverApi';

type QuotaWindow = { usedPercentage: number; resetsAt: number | null } | null | undefined;

/** A window blocks its agent while it is fully used and its reset is unknown or still ahead. `now` is epoch seconds. */
function blocks(window: QuotaWindow, now: number): window is NonNullable<QuotaWindow> {
  return !!window && window.usedPercentage >= 100 && (window.resetsAt === null || window.resetsAt > now);
}

/**
 * An account cannot start a Task while any reported quota window is fully
 * consumed. A passed reset time makes that reading non-blocking even if the
 * next usage refresh has not arrived yet. Missing quota data is unknown, not
 * unavailable: API-key-backed executors may be runnable without quota data.
 */
export function isExecutorAvailable(executor: ExecutorProfile, now = Date.now() / 1000): boolean {
  return !blocks(executor.limits?.fiveHour, now) && !blocks(executor.limits?.sevenDay, now);
}

export function availableExecutors(executors: ExecutorProfile[], now = Date.now() / 1000): ExecutorProfile[] {
  return executors.filter((executor) => isExecutorAvailable(executor, now));
}

/**
 * Chooses the available account with the most quota remaining: lowest active
 * 5-hour usage, then lowest active 7-day usage. Missing or already-reset
 * windows count as unused, and ties preserve the configured executor order.
 */
export function mostRemainingExecutorId(executors: ExecutorProfile[], now = Date.now() / 1000): string {
  const score = (executor: ExecutorProfile): [number, number] => {
    const used = (window: QuotaWindow) => (!window || (window.resetsAt !== null && window.resetsAt <= now) ? 0 : window.usedPercentage);
    return [used(executor.limits?.fiveHour), used(executor.limits?.sevenDay)];
  };

  let best: ExecutorProfile | undefined;
  let bestScore: [number, number] | undefined;
  for (const executor of availableExecutors(executors, now)) {
    const candidate = score(executor);
    if (!bestScore || candidate[0] < bestScore[0] || (candidate[0] === bestScore[0] && candidate[1] < bestScore[1])) {
      best = executor;
      bestScore = candidate;
    }
  }
  return best?.id ?? '';
}

/** The id of the app-wide default coding agent, or '' when the daemon has none. */
export function defaultExecutorId(executors: ExecutorProfile[]): string {
  return executors.find((executor) => executor.isDefault)?.id ?? '';
}

/** The default when it is available, else the available agent with the most quota left, else ''. Every agent picker preselects through this. */
export function preselectedExecutorId(executors: ExecutorProfile[], now = Date.now() / 1000): string {
  const preferred = executors.find((executor) => executor.isDefault);
  return preferred && isExecutorAvailable(preferred, now) ? preferred.id : mostRemainingExecutorId(executors, now);
}

/**
 * What a picker selects: the person's own choice while it is still a configured, available agent,
 * otherwise the preselection. An untouched picker (`touchedId` empty) therefore follows the default live.
 */
export function resolveExecutorChoice(executors: ExecutorProfile[], touchedId: string, now = Date.now() / 1000): string {
  const touched = executors.find((executor) => executor.id === touchedId);
  return touched && isExecutorAvailable(touched, now) ? touched.id : preselectedExecutorId(executors, now);
}

/** The person's own pick, kept only while it is still a configured, available agent; otherwise cleared so it is not restored later. */
export function retainedChoice(executors: ExecutorProfile[], touchedId: string, now = Date.now() / 1000): string {
  return resolveExecutorChoice(executors, touchedId, now) === touchedId ? touchedId : '';
}

/** Why an agent cannot be chosen, with its reset time, or null when it can. Names the window that resets later when both are used up. */
export function unavailableReason(executor: ExecutorProfile, now = Date.now() / 1000): string | null {
  const blocking = ([['5-hour', executor.limits?.fiveHour], ['7-day', executor.limits?.sevenDay]] as const)
    .filter((entry): entry is readonly ['5-hour' | '7-day', NonNullable<QuotaWindow>] => blocks(entry[1], now));
  if (blocking.length === 0) return null;
  const [name, window] = blocking.reduce((later, next) => (later[1].resetsAt === null ? later : next[1].resetsAt === null || next[1].resetsAt > later[1].resetsAt ? next : later));
  const reset = window.resetsAt === null
    ? 'its reset time is unknown'
    : `resets ${new Date(window.resetsAt * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} IST`;
  return `${executor.label} is out of quota (${name} limit) and ${reset}`;
}

export interface ExecutorOption {
  executor: ExecutorProfile;
  isDefault: boolean;
  disabled: boolean;
  /** Why it is disabled; null when it can be chosen. */
  reason: string | null;
}

/** The picker's entries in configured order: unavailable agents stay listed, disabled, with their reset time. */
export function executorOptions(executors: ExecutorProfile[], now = Date.now() / 1000): ExecutorOption[] {
  return executors.map((executor) => {
    const reason = unavailableReason(executor, now);
    return { executor, isDefault: executor.isDefault === true, disabled: reason !== null, reason };
  });
}

export interface DefaultDotModel {
  /** Accessible name of the dot. */
  label: string;
  selected: boolean;
  disabled: boolean;
  /** The dot's tooltip: why it is disabled, else what selecting it does. */
  tooltip: string;
}

/** The footer dot that makes an agent the default: filled for the default, disabled (with the reason) for an agent out of quota. */
export function defaultDotModel(executor: ExecutorProfile, now = Date.now() / 1000): DefaultDotModel {
  const reason = unavailableReason(executor, now);
  const selected = executor.isDefault === true;
  return {
    label: `Make ${executor.label} the default coding agent`,
    selected,
    disabled: reason !== null && !selected,
    tooltip: selected ? `${executor.label} is the default coding agent` : reason ?? `Make ${executor.label} the default for new sessions`,
  };
}

/** The Agent analytics header's "Default for new sessions" control for the agent being viewed. */
export type AnalyticsDefaultControl =
  | { kind: 'current' }
  | { kind: 'action' }
  | { kind: 'disabled'; reason: string };

export function analyticsDefaultControl(agent: { id: string; retired: boolean }, executors: ExecutorProfile[], now = Date.now() / 1000): AnalyticsDefaultControl {
  if (agent.retired) return { kind: 'disabled', reason: 'This agent was removed, so it cannot be the default' };
  const executor = executors.find((candidate) => candidate.id === agent.id);
  if (!executor) return { kind: 'disabled', reason: 'This agent is no longer configured' };
  if (executor.isDefault) return { kind: 'current' };
  const reason = unavailableReason(executor, now);
  return reason ? { kind: 'disabled', reason } : { kind: 'action' };
}
