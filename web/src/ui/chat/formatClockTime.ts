/** Shared clock-time formatting for a turn/event's `at` timestamp — falls back to the raw string on a bad date rather than showing "Invalid Date". */
export function formatClockTime(iso: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], options);
}
