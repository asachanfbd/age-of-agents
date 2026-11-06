/**
 * Pure logic backing the toast stack (`ui/NotificationToasts.tsx`) — timing, persistence, and
 * which Notifications are due a toast right now — kept out of the component so it's testable
 * without rendering anything, same as `lib/notificationCenter.ts`.
 */
import type { ServerNotification, NotificationSeverity } from './serverApi';

/** How long an info/warning toast stays up before auto-dismissing itself. Irrelevant for `critical` — see `shouldPersistToast`. */
export const TOAST_AUTO_DISMISS_MS = 6000;

/** True only for `critical`, which persists with a close button instead of auto-dismissing. */
export function shouldPersistToast(severity: NotificationSeverity): boolean {
  return severity === 'critical';
}

/**
 * Notifications due a toast right now: unread AND unresolved, and either never toasted
 * (`lastToastedUpdatedAt` has no entry for its id — a brand-new arrival) or toasted before but with
 * a newer `updatedAt` since (a *recurrence* — the same id went back to unread, or its content
 * changed, while still unresolved). The caller tracks `lastToastedUpdatedAt` per id — seeded with
 * every notification already present on first load, so nothing toasts for history, only for what
 * actually changes afterward — rather than a plain seen-set, which can't tell "toasted once, stayed
 * read" apart from "toasted once, came back".
 *
 * A read notification is never toasted here even if its content just changed (e.g. the git-sync
 * poller refreshing a behind-by count on one the user already read): `readAt` staying non-null
 * means nothing changed that the user hasn't already seen.
 */
export function notificationsToToast(
  notificationsById: Record<string, ServerNotification>,
  lastToastedUpdatedAt: ReadonlyMap<string, string>,
): ServerNotification[] {
  return Object.values(notificationsById).filter((n) => {
    if (n.readAt !== null || n.resolvedAt !== null) return false;
    const last = lastToastedUpdatedAt.get(n.id);
    return last === undefined || n.updatedAt > last;
  });
}

/** Sonner's own marker on every toast element; the one source for the helper below and the pointer-events rule in `index.css`. */
export const TOAST_ATTRIBUTE = 'data-sonner-toast';

/**
 * Whether a modal's outside-interaction event started on a toast. Modals call `preventDefault()` for these,
 * so acting on a toast neither closes the dialog beneath it nor pulls focus out of it.
 */
export function isToastTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return !!element?.closest?.(`[${TOAST_ATTRIBUTE}]`);
}
