import type { AttachedBuildingDto, TimelineEntryDto, WorkLogEntryDto } from './crmTypes';

export const WORK_LOG_EMPTY = 'No work updates yet. Updates appear here when tasks on this Building start or finish.';
export const ATTACH_HINT = 'Attaching a Building adds finished updates for tasks completed in the last 30 days.';
export const UNTITLED_TASK = 'Untitled task';
export const WORK_BADGES = { notRewritten: 'Not rewritten', backfilled: 'Backfilled' } as const;

const titleOf = (title: unknown): string => (typeof title === 'string' && title.trim() ? title : UNTITLED_TASK);

export function workHeading(phase: unknown, title: unknown): string {
  return `${phase === 'started' ? 'Started' : 'Finished'}: ${titleOf(title)}`;
}

/** Badges for one update: only a finished update can be "not rewritten", and a missing flag means rewritten. */
export function workBadges(entry: { phase?: unknown; rewritten?: unknown; backfilled?: unknown }): string[] {
  const out: string[] = [];
  if (entry.phase === 'finished' && entry.rewritten === false) out.push(WORK_BADGES.notRewritten);
  if (entry.backfilled === true) out.push(WORK_BADGES.backfilled);
  return out;
}

/** "Oct 22, 2026, 9:05 AM"; never "Invalid Date". */
export function workWhen(ms: number, timeZone?: string): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return 'No date';
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone });
}

export const workLogLabel = (b: Pick<AttachedBuildingDto, 'workLog' | 'workLogTotal'>): string => `Work log (${b.workLogTotal ?? b.workLog?.length ?? 0})`;

export interface WorkRow { id: number; heading: string; summary: string; badges: string[]; when: string }
const row = (e: WorkLogEntryDto, timeZone: string | undefined): WorkRow => ({ id: e.id, heading: workHeading(e.phase, e.taskTitle), summary: e.phase === 'finished' ? (e.summary ?? '') : '', badges: workBadges(e), when: workWhen(e.at, timeZone) });

/** A Building's work log rows, newest first whatever order the server sent. */
export function workLogRows(b: Pick<AttachedBuildingDto, 'workLog'>, timeZone?: string): WorkRow[] {
  return [...(b.workLog ?? [])].sort((x, y) => y.at - x.at || y.id - x.id).map((e) => row(e, timeZone));
}

/** The body of a Building-work timeline entry: heading, Building name, summary and badges, from the entry's own data. */
export function workTimelineView(e: Pick<TimelineEntryDto, 'data'>): { heading: string; buildingName: string; summary: string; badges: string[] } {
  const d = e.data;
  return {
    heading: workHeading(d.phase, d.taskTitle),
    buildingName: typeof d.buildingName === 'string' ? d.buildingName : '',
    summary: d.phase === 'finished' && typeof d.summary === 'string' ? d.summary : '',
    badges: workBadges(d),
  };
}
