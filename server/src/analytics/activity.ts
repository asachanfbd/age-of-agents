import type { TaskRecord } from '../domain/types.ts';
import type { ActivityRecord, ActivitySegment } from './types.ts';

/** `active`: the agent is working. `waiting`: the session is open but waiting for a person. `ended`: no live work. */
export type ActivityState = 'active' | 'waiting' | 'ended';

/**
 * What a Task's stored state says its agent is doing. Only a developing Task whose CLI is starting or
 * running counts as active work; a question, an approval prompt or an idle prompt is waiting; a
 * stopped, failed, paused or finished Task has ended.
 */
export function taskActivityState(task: Pick<TaskRecord, 'status' | 'runtimeStatus'>): ActivityState {
  if (task.status === 'blocked') return 'waiting';
  if (task.status !== 'developing') return 'ended';
  switch (task.runtimeStatus) {
    case 'waiting_input': return 'waiting';
    case 'completed': case 'failed': case 'stopped': case 'disconnected': return 'ended';
    default: return 'active';
  }
}

function openSegment(record: ActivityRecord): ActivitySegment | undefined {
  const last = record.segments.at(-1);
  return last && last.end === null ? last : undefined;
}

/**
 * Moves a session to `state` at time `at`, closing the running segment and opening the next one.
 * Repeating the current state changes nothing but the last-seen time. A session that had ended and
 * becomes active again continues the same record.
 */
export function applyActivityState(record: ActivityRecord, state: ActivityState, at: number): ActivityRecord {
  const next: ActivityRecord = { ...record, segments: record.segments.map((segment) => ({ ...segment })), lastSeenAt: Math.max(record.lastSeenAt, at) };
  const open = openSegment(next);
  const current: ActivityState = open ? open.state : 'ended';
  if (current === state) return next;
  const moment = Math.max(at, open?.start ?? next.segments.at(-1)?.end ?? next.startedAt);
  if (open) open.end = moment;
  if (state === 'ended') {
    next.endedAt = moment;
  } else {
    next.segments.push({ state, start: moment, end: null });
    next.endedAt = null;
  }
  return next;
}

/** Closes a session whose end was never observed at the last moment its state was known, and marks it approximate. */
export function closeUnobserved(record: ActivityRecord): ActivityRecord {
  if (record.endedAt !== null) return record;
  const closed = applyActivityState(record, 'ended', record.lastSeenAt);
  return { ...closed, approximate: true };
}

/** Time the agent actually worked: active segments only, a running one counted up to `now`. */
export function activeDurationMs(record: Pick<ActivityRecord, 'segments'>, now: number): number {
  return record.segments.reduce((sum, segment) => segment.state === 'active' ? sum + Math.max(0, (segment.end ?? now) - segment.start) : sum, 0);
}

/**
 * From the first moment the agent worked to the last, waits in between included. Null while the
 * session is live or when it never worked.
 */
export function workingSpan(record: Pick<ActivityRecord, 'segments' | 'endedAt'>): { start: number; end: number } | null {
  const working = record.segments.filter((segment) => segment.state === 'active');
  const end = working.at(-1)?.end;
  return record.endedAt === null || !working.length || end == null ? null : { start: working[0]!.start, end };
}

/** Whether the agent was working at any moment in `[from, to]`. */
export function isActiveDuring(record: Pick<ActivityRecord, 'segments'>, from: number, to: number, now: number): boolean {
  return record.segments.some((segment) => segment.state === 'active' && segment.start <= to && (segment.end ?? now) >= from);
}

/** Whether any part of the session, working or waiting, falls in `[from, to]`. */
export function overlapsRange(record: Pick<ActivityRecord, 'startedAt' | 'endedAt'>, from: number, to: number, now: number): boolean {
  return record.startedAt <= to && (record.endedAt ?? now) >= from;
}
