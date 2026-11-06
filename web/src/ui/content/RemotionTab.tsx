import { useEffect, useState } from 'react';
import { isNarrow } from '../../lib/contentRemotion';
import { useContentStore } from '../../store/contentStore';
import { RemotionTabView } from './RemotionTabView';
import { useRemotionStudio } from './useRemotionStudio';

const windowWidth = () => (typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth);

/**
 * The Remotion tab wired to the daemon. Opening it starts Studio (or reuses the Building's running one); while the page is
 * visible it sends heartbeats, so the daemon stops Studio once no Remotion tab has been open for its idle time.
 */
export function RemotionTab({ projectId, conceptId, videoAssetId, compositionId, readOnly }: { projectId: string; conceptId: string; videoAssetId: string; compositionId: string; readOnly: boolean }) {
  const studio = useRemotionStudio({ projectId, videoAssetId, readOnly });
  const [width, setWidth] = useState(windowWidth);

  // The Video tab's setup view tells whether the project still needs its install (the waiting bar, the read-only refusal).
  useEffect(() => { void useContentStore.getState().openStudio(projectId, conceptId, videoAssetId, false); }, [projectId, conceptId, videoAssetId]);
  useEffect(() => {
    const onResize = () => setWidth(windowWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <RemotionTabView
      view={studio.view} pane={studio.pane} compositionId={compositionId} setupPercent={studio.setupPercent} narrow={isNarrow(width)} busy={studio.busy} error={studio.error}
      onStart={studio.start} onStop={studio.stop}
    />
  );
}
