import type { PlanItemQueueEntry } from './serverApi';

/**
 * A Project's waiting list: starts accepted while it was at its task limit, shown on the board as
 * "Waiting for a free slot · #n". Pure so the wording and numbering are testable without a component.
 */

/** A queued task's place in line, by entry order (position, then when Start was pressed); 1 is next. */
export interface QueuedPlace {
  entryId: string;
  position: number;
}

/** The entries in the order they will start. */
export function sortedQueue(entries: readonly PlanItemQueueEntry[]): PlanItemQueueEntry[] {
  return entries.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.createdAt.localeCompare(b.createdAt));
}

/** Each queued task's place in line, keyed by plan item id; numbering restarts at 1 whenever the list changes. */
export function queuePlaces(entries: readonly PlanItemQueueEntry[] | undefined): Map<string, QueuedPlace> {
  return new Map(sortedQueue(entries ?? []).map((entry, index) => [entry.planItemId, { entryId: entry.id, position: index + 1 }]));
}

/** English ordinal: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st … */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

export const queuedBadge = (position: number): string => `Waiting for a free slot · #${position}`;

export const queuedNotice = (title: string, position: number): string => `${title} is waiting for a free slot (${ordinal(position)} in line)`;

/** How many writing tasks a Project runs at once: six with a linked repository, one without (the daemon's `concurrencyCapFor`). */
export const slotCap = (hasRepository: boolean): number => (hasRepository ? 6 : 1);

/** The toast after a start was accepted: set only when the task joined the waiting list, null when it started at once. */
export function queuedNoticeFor(title: string, entries: readonly PlanItemQueueEntry[] | undefined, planItemId: string): string | null {
  const place = queuePlaces(entries).get(planItemId);
  return place ? queuedNotice(title, place.position) : null;
}

/** The line under the dialog's Start button; null while the Project still has a free slot. */
export function fullProjectNote(inUse: number, cap: number): string | null {
  if (inUse < cap) return null;
  return `All ${cap} ${cap === 1 ? 'slot is' : 'slots are'} in use; this task will wait in line and start on its own.`;
}
