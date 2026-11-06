import { useEffect, useRef, useState } from 'react';
import { blockedReasonOf, READ_ONLY_NO_SESSION } from '../../lib/contentStudio';
import { singleFlight, thumbnailReopenBlock } from '../../lib/contentThumbnail';
import { controlsDisabled } from '../../lib/contentView';
import { useContentStore } from '../../store/contentStore';
import { TaskTerminal } from '../TaskTerminal';
import type { StudioAction } from './StudioPaneView';
import { ThumbnailPaneView } from './ThumbnailTab';

/** The Concept's thumbnail pane wired to the daemon: opens it (starting the first round when needed), its actions, Finalize with the pick, and Stop. */
export function ThumbnailPane({ projectId, conceptId, assetId, readOnly }: { projectId: string; conceptId: string; assetId: string; readOnly: boolean }) {
  const view = useContentStore((s) => s.studioByAsset[assetId]) ?? null;
  const refused = useContentStore((s) => s.studioBlocked[assetId]) ?? null;
  const blockedReopen = useContentStore((s) => { const c = s.conceptsById[conceptId]; return c ? thumbnailReopenBlock(c, assetId) : null; });
  const openStudio = useContentStore((s) => s.openStudio);
  const studioAction = useContentStore((s) => s.studioAction);
  const stopThumbnailRender = useContentStore((s) => s.stopThumbnailRender);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => { void openStudio(projectId, conceptId, assetId, !readOnly).then((r) => setError(r.ok ? null : r.error)); }, [projectId, conceptId, assetId, readOnly, openStudio]);
  const flight = useRef(singleFlight());
  const run = async (work: () => Promise<{ ok: boolean; error?: string }>) => {
    const result = await flight.current(async () => {
      setBusy(true);
      try { return await work(); } finally { setBusy(false); }
    });
    if (!result) return;
    setError(result.ok ? null : result.error ?? null);
    if (result.ok) setConfirmOpen(false);
  };
  const idle = readOnly && view !== null && view.asset.state !== 'finalized' && !view.session;
  return (
    <ThumbnailPaneView
      view={view} blocked={idle ? READ_ONLY_NO_SESSION : blockedReasonOf(view, refused)} readOnly={controlsDisabled(readOnly)} error={error} busy={busy} confirmOpen={confirmOpen}
      onAction={(a: StudioAction) => void run(() => studioAction(projectId, conceptId, assetId, a))}
      onFinalize={(file) => void run(() => studioAction(projectId, conceptId, assetId, 'finalize', { file }))}
      onAskNewSession={() => setConfirmOpen(true)} onCancelNewSession={() => setConfirmOpen(false)}
      reopenBlocked={blockedReopen}
      onStop={(rid) => void run(() => stopThumbnailRender(projectId, conceptId, assetId, rid))}
      renderTerminal={(sessionId) => <TaskTerminal key={sessionId} taskId={sessionId} />}
    />
  );
}
