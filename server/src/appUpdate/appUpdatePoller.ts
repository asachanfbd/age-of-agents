/**
 * Task 7.001: keeps the single `app.update_available` Notification in sync with the latest
 * `AppUpdateStatus`, and drives the recurring check — structurally parallel to
 * `projects/gitSyncPoller.ts`'s `syncOutOfSyncNotification`/`startGitSyncPolling`, just for the
 * app's own checkout instead of a registered Project (one Notification total, not one per Project,
 * so there's no per-id loop here — just the one fixed `{ type: 'app' }` subject).
 *
 * `syncAppUpdateNotification` is called from `appUpdateService.ts`'s `checkNow` itself (not just
 * wrapped around the recurring tick here), so the manual "Check now" action gets the exact same
 * notification sync the periodic poll does — see checkNow's own doc comment.
 */
import { listNotifications, raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { APP_UPDATE_REFRESH_MS } from '../config.ts';
import type { AppUpdateStatus, NotificationSubject } from '../domain/types.ts';

const APP_SUBJECT: NotificationSubject = { type: 'app' };

/**
 * Raises (or refreshes in place) the one `app.update_available` Notification while `status.availability
 * === 'available'`, resolves it once that's no longer true, and does neither on a failed check — a
 * `checkError` means this particular attempt learned nothing new, so whatever Notification state was
 * already there (open or not) is simply left alone rather than being closed out on a transient blip.
 */
export async function syncAppUpdateNotification(status: AppUpdateStatus): Promise<void> {
  if (status.checkError) return;

  if (status.availability !== 'available') {
    await resolveNotifications(APP_SUBJECT, ['app.update_available']);
    return;
  }

  const title = `${status.behindBy} commit(s) behind origin/${status.branch}`;
  const description = status.incomingCommits[0]
    ? `Latest: ${status.incomingCommits[0].subject}`
    : `An update is available on origin/${status.branch}.`;

  const existing = (await listNotifications({ resolved: false, projectId: 'none' }))
    .find((n) => n.kind === 'app.update_available');
  if (existing && existing.title === title && existing.description === description) return;

  await raiseNotification({ kind: 'app.update_available', subject: APP_SUBJECT, title, description });
}

/**
 * Starts the recurring check: an immediate one, then one every `intervalMs` — matches
 * `gitSyncPoller.ts`'s `startGitSyncPolling`. `unref()`'d so it never keeps the process alive on its
 * own; returns a disposer for `server.on('close', ...)`.
 */
export function startAppUpdatePolling(service: { checkNow(): Promise<AppUpdateStatus> }, intervalMs = APP_UPDATE_REFRESH_MS): () => void {
  const tick = async () => {
    try { await service.checkNow(); } catch { /* Retry on the next tick. */ }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
