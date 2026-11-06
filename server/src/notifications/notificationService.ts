import { randomUUID } from 'node:crypto';
import { notificationsDb } from '../db/collections.ts';
import { NOTIFICATION_RETENTION_MS, NOTIFICATION_SEVERITY_BY_KIND } from '../domain/types.ts';
import type { NotificationKind, NotificationRecord, NotificationSeverity, NotificationSubject } from '../domain/types.ts';

export class NotificationNotFoundError extends Error {
  constructor() {
    super('This notification no longer exists');
    this.name = 'NotificationNotFoundError';
  }
}

/**
 * Milestone 5's shared ingestion point (docs/milestones/milestone-5-notification-system.md,
 * "Ingestion: a shared primitive, not a new subsystem per producer"). Every
 * producer — workerManager.ts, commandRunner.ts, gitSyncPoller.ts,
 * catalogService.ts/skillInstall.ts, testRunner.ts, or POST /api/notifications for anything outside
 * the daemon process — calls `raiseNotification`/`resolveNotifications` instead of inventing its own
 * alerting. There used to be an LLM Notification Agent here that ran a full `claude -p` turn on every
 * Notification; it was removed (see the milestone doc) because that cost real usage and decided
 * nothing a plain rule couldn't — every producer here now raises/resolves deterministically instead.
 */
export type NotificationEvent = { type: 'notification'; notification: NotificationRecord };
type Listener = (event: NotificationEvent) => void;

const listeners = new Set<Listener>();

/** Structurally the same event-bus shape as gitSyncPoller.ts's onSyncEvent / commandRunner.ts's onCommandEvent — see api/ws.ts, which wires all of them onto the one `/ws` broadcast. */
export function onNotificationEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(notification: NotificationRecord): void {
  for (const listener of listeners) listener({ type: 'notification', notification });
}

/** A subject's dedupe identity: its `type` plus whichever field names the thing itself — never `taskId`/`runId`, which only ever point at the latest attempt (see NotificationSubject's doc comment). */
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

/** The denormalized `NotificationRecord.projectId` for a subject — null for the two project-less subjects (a Catalog skill install, or an app update). */
function subjectProjectId(subject: NotificationSubject): string | null {
  return subject.type === 'skill' || subject.type === 'app' ? null : subject.projectId;
}

function sameSubjectIdentity(a: NotificationSubject, b: NotificationSubject): boolean {
  return a.type === b.type && subjectIdentityKey(a) === subjectIdentityKey(b);
}

/** Kinds that are done once the person has read them. */
const RESOLVED_WHEN_READ = new Set<NotificationKind>(['task.completed', 'automerge.merged']);

export interface RaiseNotificationInput {
  kind: NotificationKind;
  subject: NotificationSubject;
  title: string;
  description: string;
}

/**
 * Upserts a Notification. If there's an unresolved Notification with the same kind + subject identity,
 * it's updated in place (title, description, subject, updatedAt) and re-unread (`readAt: null`,
 * since this is a fresh occurrence of the same condition) — a *resolved* record with that identity
 * never blocks this and a brand new one is inserted instead. Severity always comes from
 * `NOTIFICATION_SEVERITY_BY_KIND`, never a caller-supplied value. Emits through `onNotificationEvent`
 * either way.
 */
export async function raiseNotification(input: RaiseNotificationInput): Promise<NotificationRecord> {
  const now = new Date().toISOString();
  const existing = (await notificationsDb.find((n) =>
    n.kind === input.kind && n.resolvedAt === null && sameSubjectIdentity(n.subject, input.subject),
  ))[0];

  if (existing) {
    const updated = await notificationsDb.update(existing.id, {
      title: input.title,
      description: input.description,
      subject: input.subject,
      projectId: subjectProjectId(input.subject),
      readAt: null,
      updatedAt: now,
    });
    emit(updated!);
    return updated!;
  }

  const record: NotificationRecord = {
    id: randomUUID(),
    kind: input.kind,
    severity: NOTIFICATION_SEVERITY_BY_KIND[input.kind],
    subject: input.subject,
    projectId: subjectProjectId(input.subject),
    title: input.title,
    description: input.description,
    readAt: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await notificationsDb.insert(record);
  emit(inserted);
  return inserted;
}

/**
 * Resolves every unresolved Notification matching `subject`'s identity, optionally narrowed to
 * `kinds` (so, say, settling a Task failed can resolve just `task.needs_input` and leave a sibling
 * `task.failed` alone). Resolving also marks read. A no-op — no write, no emit — when nothing matches
 * or every match is already resolved.
 */
export async function resolveNotifications(subject: NotificationSubject, kinds?: NotificationKind[]): Promise<void> {
  const now = new Date().toISOString();
  const matches = await notificationsDb.find((n) =>
    n.resolvedAt === null && sameSubjectIdentity(n.subject, subject) && (!kinds || kinds.includes(n.kind)),
  );
  for (const n of matches) {
    const updated = await notificationsDb.update(n.id, { resolvedAt: now, readAt: n.readAt ?? now, updatedAt: now });
    if (updated) emit(updated);
  }
}

/**
 * Marks exactly the given ids read. An id already read, or one that doesn't exist, is a harmless
 * no-op. Reading an unresolved `task.completed` or `automerge.merged` also resolves it — reviewing a completion counts as
 * handling it (enforced here, not just at the route, so every caller gets it for free).
 */
export async function markNotificationsRead(ids: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const id of ids) {
    const current = await notificationsDb.get(id);
    if (!current) continue;
    const resolves = RESOLVED_WHEN_READ.has(current.kind) && current.resolvedAt === null;
    const updated = await notificationsDb.update(id, {
      readAt: current.readAt ?? now,
      ...(resolves ? { resolvedAt: now } : {}),
      updatedAt: now,
    });
    if (updated) emit(updated);
  }
}

/** Sets `readAt` back to null. A no-op (no emit) for an unknown id — mirrors `markNotificationsRead`'s own tolerance. Never touches `resolvedAt`: unread-but-resolved is a valid, reachable state. */
export async function markNotificationUnread(id: string): Promise<void> {
  const updated = await notificationsDb.update(id, { readAt: null, updatedAt: new Date().toISOString() });
  if (updated) emit(updated);
}

/** Marks every Notification matching `subject`'s identity (any kind) read — same task.completed-resolves-on-read rule as `markNotificationsRead`. A no-op when nothing matches. */
export async function markSubjectRead(subject: NotificationSubject): Promise<void> {
  const matches = await notificationsDb.find((n) => sameSubjectIdentity(n.subject, subject));
  await markNotificationsRead(matches.map((n) => n.id));
}

export interface NotificationFilter {
  resolved?: boolean;
  read?: boolean;
  severity?: NotificationSeverity;
  /** 'none' = the one project-less subject (a Catalog skill install); omitted = every project. */
  projectId?: string | 'none';
}

function matchesFilter(n: NotificationRecord, filter: NotificationFilter): boolean {
  if (filter.resolved !== undefined && (n.resolvedAt !== null) !== filter.resolved) return false;
  if (filter.read !== undefined && (n.readAt !== null) !== filter.read) return false;
  if (filter.severity !== undefined && n.severity !== filter.severity) return false;
  if (filter.projectId !== undefined) {
    if (filter.projectId === 'none') { if (n.projectId !== null) return false; }
    else if (n.projectId !== filter.projectId) return false;
  }
  return true;
}

/** "Mark all as read" — marks read only what matches `filter` (the drawer's current filters), leaving everything else untouched. An empty/omitted filter marks everything read. */
export async function markAllRead(filter: NotificationFilter = {}): Promise<void> {
  const matches = await notificationsDb.find((n) => matchesFilter(n, filter));
  await markNotificationsRead(matches.map((n) => n.id));
}

/** Newest first by `updatedAt` — not `createdAt`, so a dedupe-updated old record sorts as if new. */
export async function listNotifications(filter: NotificationFilter = {}): Promise<NotificationRecord[]> {
  const all = await notificationsDb.find((n) => matchesFilter(n, filter));
  return all.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getNotification(id: string): Promise<NotificationRecord> {
  const notification = await notificationsDb.get(id);
  if (!notification) throw new NotificationNotFoundError();
  return notification;
}

/**
 * Deletes every Notification that's both read AND resolved with `resolvedAt` older than
 * `NOTIFICATION_RETENTION_MS` — the only two states left unresolved-forever (a resolved-but-unread,
 * or a read-but-unresolved, Notification is kept regardless of age). Also wipes any pre-this-task
 * legacy record with no `kind` at all on sight, rather than migrating it: there is no way to recover
 * a kind/subject that was never recorded. Called once at daemon start and hourly — see
 * `startNotificationPruning`.
 */
export async function pruneNotifications(now: number = Date.now()): Promise<void> {
  const all = await notificationsDb.all();
  for (const n of all) {
    if (!n.kind) { await notificationsDb.delete(n.id); continue; }
    if (n.readAt !== null && n.resolvedAt !== null && now - Date.parse(n.resolvedAt) > NOTIFICATION_RETENTION_MS) {
      await notificationsDb.delete(n.id);
    }
  }
}

/** One pruning pass immediately, then hourly — unref'd so it never keeps the process alive on its own, same pattern as `executors/claudeUsage.ts`'s `startClaudeUsagePolling`. Returns a disposer for `server.on('close', ...)`. */
export function startNotificationPruning(intervalMs = 60 * 60_000): () => void {
  const tick = () => { void pruneNotifications().catch((error) => console.error('Notification pruning failed:', error)); };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
