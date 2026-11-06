/**
 * Pure logic backing the Notifications drawer (`ui/NotificationCenter.tsx`), the topbar's unread
 * badge (`ui/TopBar.tsx`), the building dot's severity (`store/worldStore.ts`'s
 * `openNotificationsForProject`/`highestOpenSeverity`), and the toast stack's quick actions
 * (`ui/NotificationToasts.tsx`) — kept out of the components so it's testable without rendering
 * anything, same as `lib/projectStatus.ts`'s `summarizeProjectStatus`.
 */
import type { NotificationKind, NotificationSeverity, NotificationSubject, ServerNotification } from './serverApi';

/** Unread AND unresolved — the one state the building dot, the drawer's highlight, and "still needs you" checks all key off. */
export function isAttention(n: Pick<ServerNotification, 'readAt' | 'resolvedAt'>): boolean {
  return n.readAt === null && n.resolvedAt === null;
}

/** The topbar bell badge — every unread Notification, resolved ones included (reading is the user's own call; resolving is the system's). */
export function countUnreadNotifications(
  notificationsById: Record<string, Pick<ServerNotification, 'readAt'>>,
  errorNotificationsById: Record<string, Pick<ServerNotification, 'readAt'>> = {},
): number {
  return [...Object.values(notificationsById), ...Object.values(errorNotificationsById)].filter((n) => n.readAt === null).length;
}

/** A subject's dedupe identity — mirrors server/src/notifications/notificationService.ts's `subjectIdentityKey`, so `markSubjectRead`'s "is there already an unread one for this subject" check never drifts from the server's own notion of "the same subject". */
function subjectIdentityKey(subject: NotificationSubject): string {
  switch (subject.type) {
    case 'task': return `task:${subject.conversationId}`;
    case 'command': return `command:${subject.commandId}`;
    case 'project': return `project:${subject.projectId}`;
    case 'testRun': return `testRun:${subject.runId}`;
    case 'skill': return `skill:${subject.repo}`;
    case 'app': return 'app';
    case 'scheduledJob': return `scheduledJob:${subject.jobId}`;
    case 'autoMerge': return `autoMerge:${subject.planItemId}`;
  }
}

/** True when `a` and `b` name the same subject, regardless of kind. */
export function sameSubjectIdentity(a: NotificationSubject, b: NotificationSubject): boolean {
  return a.type === b.type && subjectIdentityKey(a) === subjectIdentityKey(b);
}

/** The generic server-side filter shape — shared by `GET /api/notifications` and `POST /api/notifications/read-all`. */
export interface NotificationApiFilter {
  resolved?: boolean;
  read?: boolean;
  severity?: NotificationSeverity;
  /** 'none' = the one project-less subject (a Catalog skill install). */
  projectId?: string | 'none';
}

/** Mirrors server/src/notifications/notificationService.ts's `matchesFilter` — used to apply an optimistic local patch for the same filter a mark-all-read request just sent the server. */
export function matchesNotificationFilter(n: Pick<ServerNotification, 'readAt' | 'resolvedAt' | 'severity' | 'projectId'>, filter: NotificationApiFilter): boolean {
  if (filter.resolved !== undefined && (n.resolvedAt !== null) !== filter.resolved) return false;
  if (filter.read !== undefined && (n.readAt !== null) !== filter.read) return false;
  if (filter.severity !== undefined && n.severity !== filter.severity) return false;
  if (filter.projectId !== undefined) {
    if (filter.projectId === 'none') { if (n.projectId !== null) return false; }
    else if (n.projectId !== filter.projectId) return false;
  }
  return true;
}

/**
 * The drawer's local filter state. `state` defaults to 'all' so opening the drawer shows everything
 * under whichever tab (Unread/Read) is selected, not a further-narrowed subset; `severity`/`project`
 * default to 'all' (no filter).
 */
export interface NotificationDrawerFilter {
  state: 'all' | 'active' | 'resolved';
  severity: NotificationSeverity | 'all';
  /** 'all' = every project plus the system-level category; 'none' = only the one project-less subject (a skill install); otherwise one specific project id. */
  project: 'all' | 'none' | string;
}

export const DEFAULT_NOTIFICATION_DRAWER_FILTER: NotificationDrawerFilter = { state: 'all', severity: 'all', project: 'all' };

/** Every Notification matching `filter`, newest-first by `updatedAt` — the drawer's row list, before either tab (Unread/Read) narrows it further. */
export function filterNotifications<T extends Pick<ServerNotification, 'resolvedAt' | 'severity' | 'projectId' | 'updatedAt'>>(
  notificationsById: Record<string, T>,
  filter: NotificationDrawerFilter,
): T[] {
  return Object.values(notificationsById)
    .filter((n) => filter.state === 'all' || (filter.state === 'active' ? n.resolvedAt === null : n.resolvedAt !== null))
    .filter((n) => filter.severity === 'all' || n.severity === filter.severity)
    .filter((n) => {
      if (filter.project === 'all') return true;
      if (filter.project === 'none') return n.projectId === null;
      return n.projectId === filter.project;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One quick action a drawer row or toast can offer — label plus which action it is (the caller executes it; see `store/worldStore.ts`'s `runNotificationQuickAction`). */
export type NotificationQuickAction =
  | { kind: 'reply'; label: 'Reply' }
  | { kind: 'retry'; label: 'Retry' }
  | { kind: 'run-again'; label: 'Run again' }
  | { kind: 'sync'; label: 'Sync' };

/**
 * The one quick action a Notification offers, or none — keyed by `kind` (see the Part 4 table in
 * docs/milestones/milestone-5-notification-system.md), and only ever offered while unresolved:
 * once resolved, there is nothing left to act on.
 */
export function quickActionFor(n: { kind: string; resolvedAt: string | null }): NotificationQuickAction | null {
  if (n.resolvedAt !== null) return null;
  const byKind: Partial<Record<NotificationKind, NotificationQuickAction>> = {
    'task.needs_input': { kind: 'reply', label: 'Reply' },
    'task.failed': { kind: 'retry', label: 'Retry' },
    'command.failed': { kind: 'run-again', label: 'Run again' },
    'git.out_of_sync': { kind: 'sync', label: 'Sync' },
    'git.auto_pull_failed': { kind: 'sync', label: 'Sync' },
  };
  return byKind[n.kind as NotificationKind] ?? null;
}
