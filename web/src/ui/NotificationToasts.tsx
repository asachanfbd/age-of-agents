import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useWorldStore } from '../store/worldStore';
import { errorNotificationsToToast } from '../lib/errorNotifications';
import type { DrawerNotification } from '../lib/errorNotifications';
import { quickActionFor } from '../lib/notificationCenter';
import { TOAST_AUTO_DISMISS_MS, shouldPersistToast, notificationsToToast } from '../lib/notificationToasts';

/**
 * Bridges live server Notifications into the shared shadcn/Sonner toaster. Every notification
 * toasts once it arrives (or recurs — see `notificationsToToast`); existing ones are baselined
 * silently on first load. A shown toast closes itself the moment its Notification is read or
 * resolved, from any source (the drawer, a quick action, mark-read-on-view, a server auto-resolve).
 */
export function NotificationToasts() {
  const notificationsById = useWorldStore((s) => s.notificationsById);
  const notificationsLoaded = useWorldStore((s) => s.notificationsLoaded);
  const openNotificationTarget = useWorldStore((s) => s.openNotificationTarget);
  const runNotificationQuickAction = useWorldStore((s) => s.runNotificationQuickAction);
  /** The `updatedAt` this id was last toasted at — not a seen-set, so a recurrence can be told apart from a first arrival. */
  const lastToastedRef = useRef<Map<string, string>>(new Map());
  const baselinedRef = useRef(false);
  /** Ids with a toast currently on screen — polled each render to close one whose Notification left "unread and unresolved". */
  const shownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!notificationsLoaded) return;
    if (!baselinedRef.current) {
      baselinedRef.current = true;
      for (const n of Object.values(notificationsById)) lastToastedRef.current.set(n.id, n.updatedAt);
      return;
    }

    for (const id of shownRef.current) {
      const n = notificationsById[id];
      if (!n || n.readAt !== null || n.resolvedAt !== null) {
        toast.dismiss(id);
        shownRef.current.delete(id);
      }
    }

    for (const n of notificationsToToast(notificationsById, lastToastedRef.current)) {
      lastToastedRef.current.set(n.id, n.updatedAt);
      shownRef.current.add(n.id);
      showNotificationToast(n, openNotificationTarget, runNotificationQuickAction);
    }
  }, [notificationsById, notificationsLoaded, openNotificationTarget, runNotificationQuickAction]);

  useErrorNotificationToasts(openNotificationTarget, runNotificationQuickAction);

  return null;
}

/**
 * Toasts each new error notification once, in the same stack. A repeat that merged into an unread
 * entry keeps its id, so it doesn't toast again; reading the entry closes its toast.
 */
function useErrorNotificationToasts(
  openNotificationTarget: (n: DrawerNotification) => Promise<void>,
  runNotificationQuickAction: (n: DrawerNotification) => Promise<void>,
): void {
  const errorNotificationsById = useWorldStore((s) => s.errorNotificationsById);
  const toastedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const id of toastedRef.current) {
      if (errorNotificationsById[id]?.readAt !== null) toast.dismiss(id);
    }
    for (const n of errorNotificationsToToast(errorNotificationsById, toastedRef.current)) {
      toastedRef.current.add(n.id);
      showNotificationToast(n, openNotificationTarget, runNotificationQuickAction);
    }
  }, [errorNotificationsById, openNotificationTarget, runNotificationQuickAction]);
}

function showNotificationToast(
  notification: DrawerNotification,
  openNotificationTarget: (n: DrawerNotification) => Promise<void>,
  runNotificationQuickAction: (n: DrawerNotification) => Promise<void>,
): void {
  const quickAction = quickActionFor(notification);
  // The toast's action is the quick action when there is one, otherwise "Open" — same two-tier
  // choice the drawer's row buttons make. Sonner has no plain "click anywhere on this toast" hook
  // in this version, so only the action button (not the toast body) opens the target.
  const onClick = () => void (quickAction ? runNotificationQuickAction(notification) : openNotificationTarget(notification));
  const options = {
    id: notification.id,
    description: notification.description || undefined,
    duration: shouldPersistToast(notification.severity) ? Infinity : TOAST_AUTO_DISMISS_MS,
    closeButton: notification.severity === 'critical',
    closeButtonAriaLabel: `Close notification: ${notification.title}`,
    action: { label: quickAction?.label ?? 'Open', onClick },
  };
  if (notification.severity === 'critical') toast.error(notification.title, options);
  else if (notification.severity === 'warning') toast.warning(notification.title, options);
  else toast.info(notification.title, options);
}
