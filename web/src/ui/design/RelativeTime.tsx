import { useSyncExternalStore } from 'react';
import { currentMinute, subscribeMinute } from '../../lib/minuteTicker';
import { formatExactTime, formatRelativeTime } from '../../lib/sessionTiming';

/**
 * A point in time as a relative label ("in 5m", "yesterday") with the exact local date and time on
 * hover. It inherits the surrounding text style and stays current through the shared minute
 * ticker; `now` pins the clock (tests). Renders nothing for an unreadable instant.
 */
export function RelativeTime({ at, timeZone, now }: { at: number | string; timeZone?: string; now?: number }) {
  const tick = useSyncExternalStore(subscribeMinute, currentMinute, currentMinute);
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time dateTime={date.toISOString()} title={formatExactTime(date.getTime(), timeZone)} className="decoration-dotted underline-offset-2 hover:underline">
      {formatRelativeTime(date.getTime(), new Date(now ?? tick), timeZone)}
    </time>
  );
}
