import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { isWorkingCopyRemoved, liveNote, runLocationLabel } from '../../../lib/quickLook';
import type { QuickLookView } from '../../../lib/quickLook';
import { serverApi } from '../../../lib/serverApi';
import type { RunLocation, WorkflowRunRecord } from '../../../lib/serverApi';
import { CodeBrowser } from '../CodeBrowser';
import { DocsBrowser } from '../DocsBrowser';
import { LocationChip } from '../LocationChip';
import { DiffView } from './DiffView';
import { SourceStrip, WorkingCopyRemoved } from './QuickLookParts';

type LocationLoad = { location: RunLocation } | { error: string } | null;

/**
 * A step's Quick look view (task 5.008): the run's working copy as it is now, read-only — the Code
 * tab's browser, the Documents tab's browser or the branch diff. It reads the run's location first:
 * a removed working copy shows the removed state (Diff still reads the kept branch). Refresh
 * remounts the view so everything is read again. Reloads when the run's status changes, since
 * completing a run removes its worktree.
 */
export function QuickLookPane({ run, view, roundNumber }: { run: WorkflowRunRecord; view: QuickLookView; roundNumber: number }) {
  const [refreshKey, setRefreshKey] = useState(0);
  // Every read is tagged with what it was read for, so a new status or a Refresh shows Loading
  // until its own answer arrives, without resetting state inside the effect.
  const loadKey = `${run.id}:${run.status}:${refreshKey}`;
  const [loaded, setLoaded] = useState<{ key: string; result: NonNullable<LocationLoad> } | null>(null);
  const [removedKey, setRemovedKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    serverApi.getQuickLookLocation(run.id)
      .then((location) => { if (active) setLoaded({ key: loadKey, result: { location } }); })
      .catch((error: unknown) => { if (active) setLoaded({ key: loadKey, result: { error: (error as Error).message } }); });
    return () => { active = false; };
  }, [run.id, loadKey]);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  /** A read answered 410: the working copy went away after the location was read. */
  const onReadError = useCallback((error: unknown) => { if (isWorkingCopyRemoved(error)) setRemovedKey(loadKey); }, [loadKey]);

  const load: LocationLoad = loaded?.key === loadKey ? loaded.result : null;
  const removed = removedKey === loadKey;
  if (!load) return <PaneMessage>Loading…</PaneMessage>;
  if ('error' in load) return <PaneMessage alert>{load.error}</PaneMessage>;
  const { location } = load;

  if (view === 'diff') return <DiffView key={refreshKey} runId={run.id} roundNumber={roundNumber} onRefresh={refresh} />;
  if (location.kind === 'removed' || removed) return <WorkingCopyRemoved branch={location.branch ?? run.branch ?? null} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SourceStrip onRefresh={refresh} note={liveNote(location, roundNumber)}>
        <LocationChip kind={location.kind === 'worktree' ? 'task' : 'folder'} label={location.kind === 'worktree' && location.branch ? `${runLocationLabel(location)} · ${location.branch}` : runLocationLabel(location)} />
      </SourceStrip>
      {view === 'code'
        ? <QuickLookCode key={refreshKey} runId={run.id} rootLabel={location.branch ?? 'Project folder'} onTreeError={onReadError} />
        : <QuickLookDocs key={refreshKey} runId={run.id} onTreeError={onReadError} />}
    </div>
  );
}

function QuickLookCode({ runId, rootLabel, onTreeError }: { runId: string; rootLabel: string; onTreeError: (error: unknown) => void }) {
  const listTree = useCallback(() => serverApi.listQuickLookCodeTree(runId), [runId]);
  const readFile = useCallback((path: string) => serverApi.getQuickLookCodeFile(runId, path), [runId]);
  return <CodeBrowser rootLabel={rootLabel} scopeKey={`quick-look:${runId}`} listTree={listTree} readFile={readFile} onTreeError={onTreeError} />;
}

function QuickLookDocs({ runId, onTreeError }: { runId: string; onTreeError: (error: unknown) => void }) {
  const listTree = useCallback(() => serverApi.getQuickLookDocsTree(runId), [runId]);
  const readFile = useCallback((path: string) => serverApi.getQuickLookDocsFile(runId, path), [runId]);
  return <DocsBrowser listTree={listTree} readFile={readFile} onTreeError={onTreeError} />;
}

function PaneMessage({ children, alert }: { children: ReactNode; alert?: boolean }) {
  return <p role={alert ? 'alert' : undefined} className={`p-4 pt-12 text-sm sm:p-6 sm:pt-12 ${alert ? 'font-medium text-destructive' : 'italic text-muted-foreground'}`}>{children}</p>;
}
