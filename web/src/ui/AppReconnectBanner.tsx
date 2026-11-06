import { RefreshCw } from 'lucide-react';
import { useWorldStore } from '../store/worldStore';
import { reconnectBannerVisible } from '../lib/appUpdate';
import { STATUS_FOOTER_HEIGHT } from '../lib/statusFooter';

/**
 * Persistent banner shown only while the `/ws` connection is down and this tab's last known
 * `AppUpdateStatus.phase` before disconnecting was `'updating'` — a server-path restart, which
 * reconnects (and resolves) on its own, as opposed to a real connectivity problem. See
 * `reconnectBannerVisible`. Once reconnected, `currentCommit` having moved is exactly what makes
 * `AppUpdateReloadBanner` show instead — there's no separate "reload now" step wired here.
 *
 * Deliberately has no opinion on any other UI in the tab: it doesn't disable buttons or forms
 * elsewhere (out of scope for task 7.001 — a global "pause everything while disconnected"
 * mechanism isn't part of this banner), and its own visibility depends on nothing but the two
 * store fields above, so anything the owner is in the middle of typing elsewhere on the page is
 * unaffected by this component mounting or unmounting.
 */
export function AppReconnectBanner() {
  const wsConnected = useWorldStore((s) => s.wsConnected);
  const lastKnownPhase = useWorldStore((s) => s.lastKnownAppUpdatePhase);

  if (!reconnectBannerVisible({ wsConnected, lastKnownPhase })) return null;

  return (
    <div
      role="status"
      style={{ bottom: STATUS_FOOTER_HEIGHT }}
      className="fixed inset-x-0 z-[160] flex items-center gap-3 border-t border-border bg-warning/15 px-4 py-2.5 text-xs text-foreground"
    >
      <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Applying a server update…</p>
        <p className="text-muted-foreground">Reconnecting automatically — this can take a few minutes. Nothing you typed here is lost.</p>
      </div>
    </div>
  );
}
