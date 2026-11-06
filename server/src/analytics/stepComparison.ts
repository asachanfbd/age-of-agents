import { RETENTION_MS } from './types.ts';

/** A metric needs this many earlier comparable rounds before a round can be judged against their median. */
export const MIN_BASELINE_SAMPLES = 5;
/** A completed round is "High usage" for a metric at this multiple of the median, inclusive. */
export const HIGH_USAGE_MULTIPLE = 2;

export type ComparisonMetric = 'activeDuration' | 'tokens' | 'fiveHourDecrease' | 'sevenDayDecrease';
export const COMPARISON_METRICS: readonly ComparisonMetric[] = ['activeDuration', 'tokens', 'fiveHourDecrease', 'sevenDayDecrease'];

/**
 * One WorkflowRun step round as the comparison sees it. A metric is null when it is unknown or must
 * not be compared: no CLI usage evidence, a duration that cannot separate working from waiting, or a
 * quota decrease that spans a reset or a gap or is shared with another session.
 */
export interface RoundSample {
  id: string;
  /** Rounds compare only inside one group: same Workflow, same step name, same coding agent. */
  group: string;
  /** Only a completed round is judged or used as a baseline. */
  completed: boolean;
  /** When the round finished; null while it runs. */
  finishedAt: number | null;
  metrics: Record<ComparisonMetric, number | null>;
}

/** The comparison group key. A renamed step, another Workflow or another agent gives a different key. */
export function comparisonGroup(workflowId: string, stepName: string, agent: string): string {
  return JSON.stringify([workflowId, stepName, agent]);
}

/** The middle value, or the mean of the two middle values; null for no values. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface MetricComparison {
  value: number | null;
  /** The median of the earlier comparable rounds where this metric is known; null when there are none. */
  median: number | null;
  /** How many earlier rounds the median is drawn from. */
  samples: number;
  /** False below the minimum sample count: the median is shown but not used to judge. */
  enoughHistory: boolean;
  highUsage: boolean;
}

/**
 * Compares one round with the completed rounds of its group that finished before it, within
 * retention. The round itself is never part of its own baseline, and each metric uses only the
 * rounds where that metric is known. A running round gets a baseline but no "High usage" marker.
 */
export function compareRound(sample: RoundSample, all: RoundSample[], now: number): Record<ComparisonMetric, MetricComparison> {
  const before = sample.finishedAt ?? Infinity;
  const prior = all.filter((other) => other.id !== sample.id && other.group === sample.group && other.completed
    && other.finishedAt !== null && other.finishedAt < before && other.finishedAt >= now - RETENTION_MS);
  const compare = (metric: ComparisonMetric): MetricComparison => {
    const known = prior.map((other) => other.metrics[metric]).filter((value): value is number => value !== null);
    const middle = median(known);
    const value = sample.metrics[metric];
    const enoughHistory = known.length >= MIN_BASELINE_SAMPLES;
    const highUsage = sample.completed && enoughHistory && value !== null && middle !== null && middle > 0 && value >= HIGH_USAGE_MULTIPLE * middle;
    return { value, median: middle, samples: known.length, enoughHistory, highUsage };
  };
  return Object.fromEntries(COMPARISON_METRICS.map((metric) => [metric, compare(metric)])) as Record<ComparisonMetric, MetricComparison>;
}
