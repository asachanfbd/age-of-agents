import { useEffect, useState } from 'react';
import { blockedReasonOf, READ_ONLY_NO_SESSION } from '../../lib/contentStudio';
import { reopenBlockReason } from '../../lib/contentStats';
import { controlsDisabled } from '../../lib/contentView';
import { useContentStore } from '../../store/contentStore';
import { TaskTerminal } from '../TaskTerminal';
import { ImagesPaneView } from './ImagesTab';
import type { StudioAction } from './StudioPaneView';

/** One post's image-set pane wired to the daemon: opens it (starting the first round when needed), its actions and Stop. */
export function ImagesPane({ projectId, conceptId, assetId, readOnly }: { projectId: string; conceptId: string; assetId: string; readOnly: boolean }) {
  const view = useContentStore((s) => s.studioByAsset[assetId]) ?? null;
  const refused = useContentStore((s) => s.studioBlocked[assetId]) ?? null;
  const blockedReopen = useContentStore((s) => { const c = s.conceptsById[conceptId]; return c ? reopenBlockReason(c, { id: assetId }) : null; });
  const openStudio = useContentStore((s) => s.openStudio);
  const studioAction = useContentStore((s) => s.studioAction);
  const stopImageRender = useContentStore((s) => s.stopImageRender);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => { void openStudio(projectId, conceptId, assetId, !readOnly).then((r) => setError(r.ok ? null : r.error)); }, [projectId, conceptId, assetId, readOnly, openStudio]);
  const run = async (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    setError(result.ok ? null : result.error ?? null);
    if (result.ok) setConfirmOpen(false);
  };
  const idle = readOnly && view !== null && view.asset.state !== 'finalized' && !view.session;
  return (
    <ImagesPaneView
      view={view} blocked={idle ? READ_ONLY_NO_SESSION : blockedReasonOf(view, refused)} readOnly={controlsDisabled(readOnly)} error={error} busy={busy} confirmOpen={confirmOpen}
      onAction={(a: StudioAction) => void run(() => studioAction(projectId, conceptId, assetId, a))} onAskNewSession={() => setConfirmOpen(true)} onCancelNewSession={() => setConfirmOpen(false)}
      reopenBlocked={blockedReopen}
      onStop={(rid) => void run(() => stopImageRender(projectId, conceptId, assetId, rid))}
      renderTerminal={(sessionId) => <TaskTerminal key={sessionId} taskId={sessionId} />}
    />
  );
}
