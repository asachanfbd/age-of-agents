import { localDay } from './zoned.ts';
import type { CrmSettings } from './settings.ts';

export type SendVerdict = { ok: true } | { ok: false; reason: 'daily cap' | 'gap'; retryAt?: number };

/** Whether an email may go out now, given the instants of emails already sent. The day is the calendar date in the Building timezone. */
export function canSendEmail(now: number, sentAt: number[], settings: CrmSettings): SendVerdict {
  const today = localDay(now, settings.timezone);
  const todayCount = sentAt.filter((t) => localDay(t, settings.timezone) === today).length;
  if (todayCount >= settings.email.dailyCap) return { ok: false, reason: 'daily cap' };
  const last = sentAt.reduce((m, t) => Math.max(m, t), -Infinity);
  const wait = last + settings.email.gapSeconds * 1000;
  if (now < wait) return { ok: false, reason: 'gap', retryAt: wait };
  return { ok: true };
}
