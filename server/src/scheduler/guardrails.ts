import type { ExecutorLimits } from '../executors/executorLimits.ts';
import type { WorkflowStep } from '../domain/types.ts';
import { localDay } from './cron.ts';
import { GOING_OUTCOMES, PENDING_OUTCOMES } from './types.ts';
import type { EntryOutcome, JobHistoryEntry, JobSettings, MissedPolicy, OverlapRule, ScheduledJobRecord } from './types.ts';

/** The scheduler's guardrail decisions, as pure functions over what the engine has read. */

export const HISTORY_LIMIT = 200;

export type OverlapDecision = { action: 'start' } | { action: 'queue' } | { action: 'skip'; reason: string };

/**
 * What a start does when the job already has a run going or a start waiting. `queued` counts starts waiting for the
 * previous run or for a free slot; under `skip` and `queue` a job never has more than one of those.
 */
export function decideOverlap(rule: OverlapRule, state: { going: number; queued: number }): OverlapDecision {
  if (rule === 'parallel' || (state.going === 0 && state.queued === 0)) return { action: 'start' };
  if (state.queued > 0) return { action: 'skip', reason: 'A run is already waiting to start' };
  return rule === 'skip' ? { action: 'skip', reason: 'The previous run is still going' } : { action: 'queue' };
}

/** Runs the job started on the local calendar day of `now`. Skipped, failed-check and not-yet-started entries have no run. */
export function runsOnDay(entries: readonly Pick<JobHistoryEntry, 'runStartedAt'>[], now: number, timezone: string): number {
  const today = localDay(now, timezone);
  return entries.filter((entry) => entry.runStartedAt !== null && localDay(Date.parse(entry.runStartedAt), timezone) === today).length;
}

/** Why the daily limit stops a start, or null when it does not. */
export function dailyLimitReason(maxRunsPerDay: number | null, runsToday: number): string | null {
  if (maxRunsPerDay === null || runsToday < maxRunsPerDay) return null;
  return `Daily limit of ${maxRunsPerDay} run${maxRunsPerDay === 1 ? '' : 's'} reached`;
}

export type UsageDecision =
  | { action: 'start' }
  | { action: 'defer'; until: number; reason: string }
  | { action: 'skip'; reason: string };

/**
 * The usage gate: a start waits while the agent's 5-hour or weekly usage is above the job's limit. It is deferred to
 * the reset of every window that is over; with no known reset time it is skipped. A reading whose reset has already
 * passed is out of date and does not hold a start back.
 */
export function decideUsage(job: Pick<JobSettings, 'maxFiveHourPercent' | 'maxWeeklyPercent'>, limits: ExecutorLimits | null, now: number): UsageDecision {
  if (!limits) return { action: 'start' };
  const windows = [
    { label: '5-hour', limit: job.maxFiveHourPercent, reading: limits.fiveHour },
    { label: 'Weekly', limit: job.maxWeeklyPercent, reading: limits.sevenDay },
  ];
  const over = windows.flatMap(({ label, limit, reading }) => {
    if (limit === null || !reading || reading.usedPercentage <= limit) return [];
    // `resetsAt` is in seconds, as the CLI reports it.
    const resetsAt = reading.resetsAt === null ? null : reading.resetsAt * 1000;
    if (resetsAt !== null && resetsAt <= now) return [];
    return [{ resetsAt, text: `${label} usage is at ${reading.usedPercentage}% (limit ${limit}%)` }];
  });
  if (!over.length) return { action: 'start' };
  const reason = over.map((window) => window.text).join('; ');
  const resets = over.map((window) => window.resetsAt);
  if (resets.some((reset) => reset === null)) return { action: 'skip', reason: `${reason}, and the reset time is not known` };
  return { action: 'defer', until: Math.max(...(resets as number[])), reason };
}

/** How a finished run changes the job's failure count. A run a person stopped is not a failure. */
export function failureCountAfter(count: number, outcome: EntryOutcome): number {
  if (outcome === 'failed') return count + 1;
  if (outcome === 'succeeded') return 0;
  return count;
}

export function reachedFailureThreshold(count: number, threshold: number): boolean {
  return count >= threshold;
}

export type MissedDecision = { action: 'none' } | { action: 'record-skip' } | { action: 'catch-up' };

/** What a cron job does about slots that passed while the daemon was off. A poll job never catches up. */
export function decideMissed(policy: MissedPolicy | null, missedSlot: number | null): MissedDecision {
  if (policy === null || missedSlot === null) return { action: 'none' };
  return policy === 'once' ? { action: 'catch-up' } : { action: 'record-skip' };
}

/** Starts that are due together run in this order: when they were due, then the job's age, then its id. */
export function compareDueStarts(
  a: { dueAt: string; job: Pick<ScheduledJobRecord, 'createdAt' | 'id'> },
  b: { dueAt: string; job: Pick<ScheduledJobRecord, 'createdAt' | 'id'> },
): number {
  return a.dueAt.localeCompare(b.dueAt) || a.job.createdAt.localeCompare(b.job.createdAt) || a.job.id.localeCompare(b.job.id);
}

/**
 * Where a "needs approval" run pauses: the index of the step to mark as an approval step, or null when the workflow
 * already pauses there. A run waits before its last step, which means after the step before it; a one-step workflow
 * waits after its only step. An approval step pauses only after it has run, so a last step that is one does not
 * count as a pause before it.
 */
export function approvalGateIndex(steps: readonly Pick<WorkflowStep, 'requiresApproval'>[]): number | null {
  if (!steps.length) return null;
  const index = Math.max(0, steps.length - 2);
  return steps[index]!.requiresApproval ? null : index;
}

/** The workflow's steps with the approval gate applied. */
export function withApprovalGate<T extends Pick<WorkflowStep, 'requiresApproval'>>(steps: readonly T[]): T[] {
  const index = approvalGateIndex(steps);
  return steps.map((step, i) => (i === index ? { ...step, requiresApproval: true } : step));
}

const isOpen = (outcome: EntryOutcome): boolean => GOING_OUTCOMES.includes(outcome) || PENDING_OUTCOMES.includes(outcome);

/**
 * The ids of the entries to drop so a job keeps at most `limit`. An entry whose start has not finished is never
 * dropped, so the oldest finished ones make room for it.
 */
export function entriesToPrune(entries: readonly Pick<JobHistoryEntry, 'id' | 'seq' | 'outcome'>[], limit = HISTORY_LIMIT): string[] {
  const finished = entries.filter((entry) => !isOpen(entry.outcome)).sort((a, b) => b.seq - a.seq);
  return finished.slice(Math.max(0, limit - (entries.length - finished.length))).map((entry) => entry.id);
}

/** A run's duration; null until it finishes, and never negative when the clock stepped back in between. */
export function durationMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}
