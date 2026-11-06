import { addLocalDays } from './zoned.ts';
import type { CrmSettings } from './settings.ts';

/**
 * Due time of followup `step` (1-based): step 1 follows the reachout by gapDays[0]; every later step follows the
 * previous one by gapDays[1]. Both counted from the actual sent time, in whole days in the Building timezone.
 */
export function followupDue(sentAtPrev: number, step: number, settings: CrmSettings): number {
  const gap = step <= 1 ? settings.cadence.gapDays[0] : settings.cadence.gapDays[1];
  return addLocalDays(sentAtPrev, gap, settings.timezone);
}

/**
 * The chain "ends" when the last followup has been sent and the last gap has passed without a reply
 * (with zero followups: the first gap after the reachout). Returns that instant.
 */
export function chainEnd(lastSentAt: number, settings: CrmSettings): number {
  const gap = settings.cadence.followups === 0 ? settings.cadence.gapDays[0] : settings.cadence.gapDays[1];
  return addLocalDays(lastSentAt, gap, settings.timezone);
}

export const resurfaceAt = (chainEndedAt: number, settings: CrmSettings): number | null =>
  settings.cadence.resurfaceDays === 0 ? null : addLocalDays(chainEndedAt, settings.cadence.resurfaceDays, settings.timezone);

/** Whether another followup follows step `sentStep` (0 = the reachout). */
export const hasNextStep = (sentStep: number, settings: CrmSettings): boolean => sentStep < settings.cadence.followups;

/** What a failed manual item does: back to the list after the retry delay, or to the catch-up after the last try. */
export function retryOutcome(triesUsed: number, failedAt: number, settings: CrmSettings): { to: 'retry'; at: number } | { to: 'catch_up' } {
  return triesUsed >= settings.cadence.retryTries ? { to: 'catch_up' } : { to: 'retry', at: failedAt + settings.cadence.retryHours * 3_600_000 };
}
