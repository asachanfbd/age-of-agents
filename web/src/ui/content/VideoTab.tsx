import { useEffect, useState } from 'react';
import { videoPaneState } from '../../lib/contentVideo';
import { controlsDisabled } from '../../lib/contentView';
import type { ContentResult } from '../../store/contentStore';
import { useContentStore } from '../../store/contentStore';
import { TaskTerminal } from '../TaskTerminal';
import { useRemotionStudio } from './useRemotionStudio';
import { VideoTabView } from './VideoTabView';

const NO_UPLOADS: never[] = [];

/** The Video tab of a Concept wired to the daemon (with Remotion Studio as its live preview). It never starts a session by opening: finalizing the script does, or Start. */
export function VideoTab({ projectId, conceptId, assetId, readOnly }: { projectId: string; conceptId: string; assetId: string; readOnly: boolean }) {
  const view = useContentStore((s) => s.studioByAsset[assetId]) ?? null;
  const uploads = useContentStore((s) => s.uploadsByConcept[conceptId]) ?? NO_UPLOADS;
  const store = useContentStore.getState;
  const openStudio = useContentStore((s) => s.openStudio);
  const [error, setError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragCount, setDragCount] = useState<number | null>(null);
  useEffect(() => { void openStudio(projectId, conceptId, assetId, false).then((r) => setError(r.ok ? null : r.error)); }, [projectId, conceptId, assetId, openStudio]);
  const run = async (work: () => Promise<ContentResult>) => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    setError(result.ok ? null : result.error);
    return result;
  };
  const studio = (action: 'session/new-round' | 'session/resume' | 'finalize' | 'reopen') => () => void run(() => store().studioAction(projectId, conceptId, assetId, action));
  const ro = controlsDisabled(readOnly);
  // Studio is the preview after Confirm: it starts when that pane shows and gets heartbeats while it stays.
  const studioControl = useRemotionStudio({ projectId, videoAssetId: assetId, readOnly: ro, enabled: videoPaneState(view) === 'preview' });
  return (
    <VideoTabView
      view={view} readOnly={ro} uploads={uploads} busy={busy} error={error} renameError={renameError} dragCount={dragCount} onDragCount={setDragCount} studio={studioControl}
      renderTerminal={(sessionId) => <TaskTerminal key={sessionId} taskId={sessionId} />}
      onStart={() => void run(() => store().startVideo(projectId, conceptId, assetId))}
      onResume={studio('session/resume')} onDiscard={studio('session/new-round')} onFinalize={studio('finalize')} onReopen={studio('reopen')}
      onTick={(itemId, ticked) => void run(() => store().patchChecklistItem(projectId, conceptId, assetId, itemId, { ticked }))}
      onLink={(itemId, mediaIds) => void run(() => store().patchChecklistItem(projectId, conceptId, assetId, itemId, { mediaIds }))}
      onConfirm={() => void run(() => store().confirmAssets(projectId, conceptId, assetId))}
      onStopRender={(rid) => void run(() => store().stopRender(projectId, conceptId, assetId, rid))}
      onFiles={(files) => store().uploadMedia(projectId, conceptId, assetId, files)}
      onCancelUpload={(key) => store().cancelUpload(conceptId, key)}
      onRenameMedia={(mid, name) => void run(async () => {
        const result = await store().renameMedia(projectId, conceptId, assetId, mid, name);
        setRenameError(result.ok ? null : result.error);
        return result.ok || result.status === 409 ? { ok: true } : result;
      })}
      onDeleteMedia={(mid) => void run(() => store().deleteMedia(projectId, conceptId, assetId, mid))}
    />
  );
}
