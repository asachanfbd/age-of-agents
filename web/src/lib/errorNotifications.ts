/**
 * Pure logic for app-error notifications: failures that aren't shown inside the form that caused
 * them. They live only in this browser tab (see `store/worldStore.ts`'s `errorNotificationsById`),
 * share the Notifications drawer with daemon notifications, and never reach the daemon.
 */
import type { NotificationSeverity, ServerNotification } from './serverApi';

/** The most error notifications kept; older ones drop off. */
export const MAX_ERROR_NOTIFICATIONS = 100;

export const GENERIC_ERROR_TITLE = 'Something went wrong';

/** A client-only notification shaped like a daemon one so the drawer's filters, badge and read state treat both alike. */
export interface ErrorNotification extends Omit<ServerNotification, 'kind' | 'subject'> {
  kind: 'app.error';
  subject: { type: 'error' };
  severity: Extract<NotificationSeverity, 'warning'>;
  /** How many times this error happened while it stayed unread. */
  count: number;
}

export type DrawerNotification = ServerNotification | ErrorNotification;

export function isErrorNotification(n: DrawerNotification): n is ErrorNotification {
  return n.kind === 'app.error';
}

/** A form or in-place panel that shows the failure of its own actions instead of notifying. */
export type ErrorScope = 'newProject' | 'commands' | 'quickLook' | 'agents' | 'catalog' | 'workflowRun' | 'testing' | 'testingDecision' | 'taskActions';

/** What failed and what it was about. */
export interface ErrorContext {
  /** Store action name; picks the scope and derives the title. */
  action?: string;
  projectId?: string | null;
  title?: string;
}

/** The slice of store state error routing reads and patches. */
export interface ErrorRoutingState {
  errorNotificationsById: Record<string, ErrorNotification>;
  errorNotificationSeq: number;
  /** How many mounted forms currently show each scope's errors. */
  openErrorScopes: Partial<Record<ErrorScope, number>>;
  formErrors: Partial<Record<ErrorScope, string>>;
}

/** "loadProjects" → "Couldn't load projects". */
export function errorTitleForAction(action: string | undefined): string {
  if (!action) return GENERIC_ERROR_TITLE;
  const words = action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return `Couldn't ${words}`;
}

/** A timestamp strictly after `latest`, so "newest first" never ties within one millisecond. */
function monotonicTimestamp(now: Date, latest: string | undefined): string {
  const iso = now.toISOString();
  if (latest === undefined || iso > latest) return iso;
  return new Date(new Date(latest).getTime() + 1).toISOString();
}

function latestUpdatedAt(byId: Record<string, ErrorNotification>): string | undefined {
  return Object.values(byId).reduce<string | undefined>((latest, n) => (latest === undefined || n.updatedAt > latest ? n.updatedAt : latest), undefined);
}

export interface AddedError {
  errorNotificationsById: Record<string, ErrorNotification>;
  errorNotificationSeq: number;
  /** True when a new entry was created (and so should toast); false when an unread repeat merged into an existing one. */
  created: boolean;
}

/**
 * Records one error. A repeat of an unread entry (same message and project) bumps its count and
 * moves it to the top without creating anything new; otherwise a new unread entry is added and the
 * oldest beyond `MAX_ERROR_NOTIFICATIONS` are dropped.
 */
export function addErrorNotification(
  state: Pick<ErrorRoutingState, 'errorNotificationsById' | 'errorNotificationSeq'>,
  message: string,
  context: ErrorContext,
  now: Date,
): AddedError {
  const projectId = context.projectId ?? null;
  const byId = state.errorNotificationsById;
  const updatedAt = monotonicTimestamp(now, latestUpdatedAt(byId));
  const existing = Object.values(byId).find((n) => n.readAt === null && n.description === message && n.projectId === projectId);
  if (existing) {
    return {
      errorNotificationsById: { ...byId, [existing.id]: { ...existing, count: existing.count + 1, updatedAt } },
      errorNotificationSeq: state.errorNotificationSeq,
      created: false,
    };
  }
  const seq = state.errorNotificationSeq + 1;
  const id = `app-error-${seq}`;
  const entry: ErrorNotification = {
    id,
    kind: 'app.error',
    severity: 'warning',
    subject: { type: 'error' },
    projectId,
    title: context.title ?? errorTitleForAction(context.action),
    description: message,
    readAt: null,
    resolvedAt: null,
    createdAt: updatedAt,
    updatedAt,
    count: 1,
  };
  const kept = Object.values({ ...byId, [id]: entry })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_ERROR_NOTIFICATIONS);
  return {
    errorNotificationsById: Object.fromEntries(kept.map((n) => [n.id, n])),
    errorNotificationSeq: seq,
    created: true,
  };
}

/**
 * Where a failure goes: into its scope's form when that form is open, otherwise into a
 * notification. Returns the state patch.
 */
export function routeError(
  state: ErrorRoutingState,
  message: string,
  context: ErrorContext,
  scope: ErrorScope | undefined,
  now: Date,
): Pick<ErrorRoutingState, 'formErrors'> | Pick<ErrorRoutingState, 'errorNotificationsById' | 'errorNotificationSeq'> {
  if (scope && (state.openErrorScopes[scope] ?? 0) > 0) {
    return { formErrors: { ...state.formErrors, [scope]: message } };
  }
  const { created: _created, ...patch } = addErrorNotification(state, message, context, now);
  return patch;
}

/** Marks the given error notifications read (or unread); unknown ids are ignored. */
export function setErrorNotificationsRead(
  byId: Record<string, ErrorNotification>,
  ids: readonly string[],
  read: boolean,
  now: Date,
): Record<string, ErrorNotification> {
  const next = { ...byId };
  for (const id of ids) {
    const n = next[id];
    if (n) next[id] = { ...n, readAt: read ? now.toISOString() : null };
  }
  return next;
}

/** Error notifications due a toast: unread and never toasted. A merged repeat keeps its id, so it never toasts again. */
export function errorNotificationsToToast(byId: Record<string, ErrorNotification>, toastedIds: ReadonlySet<string>): ErrorNotification[] {
  return Object.values(byId)
    .filter((n) => n.readAt === null && !toastedIds.has(n.id))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** The text of a thrown value, for routing. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
