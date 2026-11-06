import { useEffect, useState } from 'react';
import { startHeartbeat, studioPaneState } from '../../lib/contentRemotion';
import type { RemotionStudioDto, StudioPaneState } from '../../lib/contentRemotion';
import type { ContentResult } from '../../store/contentStore';
import { useContentStore } from '../../store/contentStore';

export interface RemotionStudioControl {
  view: RemotionStudioDto | null;
  pane: StudioPaneState;
  setupPercent: number | null;
  busy: boolean;
  error: string | null;
  start(): void;
  stop(): void;
}

/**
 * The Building's Remotion Studio for a mounted view: while `enabled`, it starts Studio (or reuses the running one) and, while the
 * page is visible, sends heartbeats so the daemon stops Studio once no view has needed it for its idle time. The Remotion tab and
 * the Video tab's live preview both use it.
 */
export function useRemotionStudio({ projectId, videoAssetId, readOnly, enabled = true }: { projectId: string; videoAssetId: string; readOnly: boolean; enabled?: boolean }): RemotionStudioControl {
  const view = useContentStore((s) => s.remotionByBuilding[projectId]) ?? null;
  const setup = useContentStore((s) => s.studioByAsset[videoAssetId]?.video?.setup) ?? null;
  const store = useContentStore.getState;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (enabled) void store().openRemotion(projectId).then((r) => setError(r.ok ? null : r.error));
  }, [enabled, projectId, store]);
  useEffect(() => {
    if (!enabled) return undefined;
    return startHeartbeat({
      send: () => store().heartbeatRemotion(projectId),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
      hidden: () => document.visibilityState === 'hidden',
      onVisibility: (fn) => { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn); },
    });
  }, [enabled, projectId, store]);

  const run = async (work: () => Promise<ContentResult>) => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    setError(result.ok ? null : result.error);
  };
  const pane = studioPaneState(view, { readOnly, needsInstall: !!setup && setup.status !== 'ready' });
  return {
    view, pane, setupPercent: setup?.percent ?? null, busy, error: pane === 'ro-refused' ? null : error,
    start: () => void run(() => store().startRemotion(projectId)),
    stop: () => void run(() => store().stopRemotion(projectId)),
  };
}
