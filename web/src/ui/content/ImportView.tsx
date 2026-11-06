import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { importedToast, importPaneModel, newlyImported } from '../../lib/contentImport';
import { useContentStore } from '../../store/contentStore';
import { TaskTerminal } from '../TaskTerminal';
import { ImportViewBody } from './ImportViewBody';

/** Opens the import session (starting one when none exists) and raises a toast for each Concept it saves. */
export function ImportView({ projectId, timeZone, readOnly, onBack, onOpen }: { projectId: string; timeZone: string; readOnly: boolean; onBack: () => void; onOpen: (conceptId: string) => void }) {
  const view = useContentStore((s) => s.importByProject[projectId]);
  const openImport = useContentStore((s) => s.openImport);
  const importAction = useContentStore((s) => s.importAction);
  const [starting, setStarting] = useState(!readOnly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => { void openImport(projectId, !readOnly).then((r) => { setStarting(false); setError(r.ok ? null : r.error); }); }, [projectId, readOnly, openImport]);
  useEffect(() => {
    if (!view) return;
    for (const concept of newlyImported(seen.current, view.saved)) toast(importedToast(concept.title));
    seen.current = new Set(view.saved.map((c) => c.id));
  }, [view]);
  const run = async (action: 'start' | 'resume' | 'new' | 'end') => {
    setBusy(true);
    const result = await importAction(projectId, action);
    setBusy(false);
    setError(result.ok ? null : result.error);
  };
  return <ImportViewBody view={view} model={importPaneModel(view, readOnly, starting)} timeZone={timeZone} busy={busy} error={error} renderTerminal={(sessionId) => <TaskTerminal key={sessionId} taskId={sessionId} />} onBack={onBack} onOpen={onOpen} onAction={(a) => void run(a)} />;
}
