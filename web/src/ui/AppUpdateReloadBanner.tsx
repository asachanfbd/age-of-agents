import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store/worldStore';
import { reloadBannerVisible } from '../lib/appUpdate';
import { STATUS_FOOTER_HEIGHT } from '../lib/statusFooter';

/**
 * Persistent, dismissable banner telling this open tab that the build it's running differs from
 * what the daemon is now serving `__APP_BUILD_COMMIT__` (baked in by `vite.config.ts`) vs. the live
 * `AppUpdateStatus.currentCommit` — the one comparison that covers both a web-only rebuild (the
 * daemon never restarted, this tab just sees `currentCommit` move on the next poll/WS push) and a
 * server-path restart this tab has already reconnected from (see `AppReconnectBanner`).
 *
 * Deliberately not a toast: it must stay up until the owner reloads or dismisses it rather than
 * auto-expiring on its own after a fixed delay, the way the toast stack's notifications do —
 * reloading is the only thing that ever clears it for the build it names. See
 * `reloadBannerVisible` (which also suppresses this while `AppReconnectBanner` is showing, so the two
 * never render on top of each other — Code Review round 1, issue 3) for why dismissing one build's
 * banner doesn't suppress a later one.
 */
export function AppUpdateReloadBanner() {
  const servingCommit = useWorldStore((s) => s.appUpdate?.currentCommit ?? null);
  const dismissedCommit = useWorldStore((s) => s.appUpdateReloadDismissedCommit);
  const dismiss = useWorldStore((s) => s.dismissAppUpdateReloadBanner);
  const wsConnected = useWorldStore((s) => s.wsConnected);
  const lastKnownPhase = useWorldStore((s) => s.lastKnownAppUpdatePhase);

  const visible = reloadBannerVisible({
    ownBuildCommit: __APP_BUILD_COMMIT__,
    servingCommit,
    dismissedCommit,
    wsConnected,
    lastKnownPhase,
  });
  if (!visible) return null;

  return (
    <div
      role="status"
      style={{ bottom: STATUS_FOOTER_HEIGHT }}
      className="fixed inset-x-0 z-[160] flex items-center gap-3 border-t border-border bg-warning/15 px-4 py-2.5 text-xs text-foreground"
    >
      <Download className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">New version loaded</p>
        <p className="text-muted-foreground">Reload to use it — nothing on this page is lost until then.</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={dismiss}>Dismiss</Button>
        <Button type="button" size="sm" onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </div>
  );
}
