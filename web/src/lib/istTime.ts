/**
 * Pure, framework-free helpers for India Standard Time (IST = UTC+5:30,
 * which never observes daylight saving).
 *
 * No React, no store, no side effects — just `Date`/UTC arithmetic, so this
 * reads correctly regardless of the host machine's own local timezone.
 * Shared by the 3D scene's real-time day-night lighting cycle and (later) a
 * digital clock UI — keep this small and easy to import from anywhere.
 */

/** IST is a fixed UTC+5:30 offset, expressed in minutes. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface ISTTime {
  /** 0-23 */
  hours: number;
  /** 0-59 */
  minutes: number;
  /** 0-59 */
  seconds: number;
  /** 0-999 */
  milliseconds: number;
}

/** Milliseconds since IST midnight for the given instant, wrapped to one day. */
function getISTMillisecondsSinceMidnight(date: Date): number {
  const utcMsSinceMidnight =
    date.getUTCHours() * MS_PER_HOUR +
    date.getUTCMinutes() * MS_PER_MINUTE +
    date.getUTCSeconds() * 1000 +
    date.getUTCMilliseconds();
  return (utcMsSinceMidnight + IST_OFFSET_MINUTES * MS_PER_MINUTE) % MS_PER_DAY;
}

/**
 * Returns the wall-clock time in IST for the given instant (default: now).
 */
export function getISTTime(date: Date = new Date()): ISTTime {
  const istMs = getISTMillisecondsSinceMidnight(date);
  return {
    hours: Math.floor(istMs / MS_PER_HOUR) % 24,
    minutes: Math.floor(istMs / MS_PER_MINUTE) % 60,
    seconds: Math.floor(istMs / 1000) % 60,
    milliseconds: istMs % 1000,
  };
}

/**
 * Returns how far through the IST day the given instant (default: now) is,
 * as a fraction from 0 (IST midnight) to just under 1 (just before the next
 * IST midnight).
 */
export function getISTTimeOfDayFraction(date: Date = new Date()): number {
  return getISTMillisecondsSinceMidnight(date) / MS_PER_DAY;
}

/** IST wall-clock time for the given instant (default: now) as a 12-hour string, e.g. "03:07:09 PM". */
export function formatISTClock(date: Date = new Date()): string {
  const { hours, minutes, seconds } = getISTTime(date);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const period = hours < 12 ? 'AM' : 'PM';
  return `${pad(hours % 12 || 12)}:${pad(minutes)}:${pad(seconds)} ${period}`;
}
