import type { ExecutorLimits } from './serverApi';

type LimitWindow = ExecutorLimits['fiveHour'];

/** At or below these many percent remaining a bar turns orange / red (both inclusive). */
export const LIMIT_ORANGE_AT = 30;
export const LIMIT_RED_AT = 10;

export type LimitLevel = 'green' | 'orange' | 'red' | 'unknown';

export interface LimitBar {
  /** Percent of the limit still available, 0..100; null when unknown. */
  remaining: number | null;
  level: LimitLevel;
}

const UNKNOWN: LimitBar = { remaining: null, level: 'unknown' };

/**
 * One quota window as a bar: fill is what is left (100 minus the percent used, clamped). Unknown when
 * the window is not reported, its percent is not a number, or its reset time has already passed
 * (a reset time equal to `now` counts as passed).
 */
export function limitBar(window: LimitWindow | undefined, now: number): LimitBar {
  if (!window || typeof window.usedPercentage !== 'number' || !Number.isFinite(window.usedPercentage)) return UNKNOWN;
  const { resetsAt } = window;
  if (resetsAt != null && (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= now)) return UNKNOWN;
  const remaining = Math.min(100, Math.max(0, 100 - window.usedPercentage));
  const level = remaining <= LIMIT_RED_AT ? 'red' : remaining <= LIMIT_ORANGE_AT ? 'orange' : 'green';
  return { remaining, level };
}

const spoken = (bar: LimitBar) => (bar.remaining === null ? 'unknown' : `${Math.round(bar.remaining)}% remaining`);

/** The agent item's accessible name: the bars are decorative, so both limits are spelled out here. */
export function agentBarsLabel(name: string, fiveHour: LimitBar, sevenDay: LimitBar): string {
  return `${name}. 5-hour limit ${spoken(fiveHour)}. 7-day limit ${spoken(sevenDay)}. Opens analytics`;
}
