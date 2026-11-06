import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConceptTab } from '../../lib/contentRules';
import type { ConceptDto } from '../../lib/contentTypes';
import { IMPORTED_BAND, IMPORTED_BAND_MORE, IMPORTED_DELETE_CONFIRM, importedTabContent, importedTabPosts, LEARN_LINK, learnModel } from '../../lib/contentImport';
import type { LearnModel } from '../../lib/contentImport';
import { isPostTextTab, selectedPostId } from '../../lib/contentPostTabs';
import { controlsDisabled, READ_ONLY_TITLE } from '../../lib/contentView';
import { useContentStore } from '../../store/contentStore';
import { ErrorNote } from '../crm/shared';
import { PostSwitcher } from './PostTextTab';

/** Delete and import again is the only way to correct imported text, so the Concept's band offers it, behind a confirm step. */
export function DeleteConceptView({ confirming, busy, error, readOnly, onAsk, onCancel, onConfirm }: { confirming: boolean; busy: boolean; error: string | null; readOnly: boolean; onAsk: () => void; onCancel: () => void; onConfirm: () => void }) {
  const disabled = controlsDisabled(readOnly);
  return (
    <div className="grid justify-items-end gap-1">
      {confirming
        ? <span className="flex flex-wrap items-center justify-end gap-1.5 text-xs" role="alertdialog" aria-label="Confirm delete">{IMPORTED_DELETE_CONFIRM}
            <Button size="sm" variant="destructive" disabled={disabled || busy} onClick={onConfirm}>Delete</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>Keep</Button></span>
        : <Button size="sm" variant="outline" disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} onClick={onAsk}>Delete Concept</Button>}
      <ErrorNote message={error} />
    </div>
  );
}

function DeleteConcept({ projectId, conceptId, readOnly, onDeleted }: { projectId: string; conceptId: string; readOnly: boolean; onDeleted?: () => void }) {
  const deleteConcept = useContentStore((s) => s.deleteConcept);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    const result = await deleteConcept(projectId, conceptId);
    setBusy(false);
    if (result.ok) onDeleted?.(); else setError(result.error);
  };
  return <DeleteConceptView confirming={confirming} busy={busy} error={error} readOnly={readOnly} onAsk={() => setConfirming(true)} onCancel={() => { setConfirming(false); setError(null); }} onConfirm={() => void confirm()} />;
}

/** The band under an imported Concept's header: what it is, and "Learn from this" with its state. */
export function ImportedBandView({ model, onLearn, onOpenStyle, deleteAction }: { model: LearnModel; onLearn: () => void; onOpenStyle?: () => void; deleteAction?: ReactNode }) {
  const { line } = model;
  return (
    <div role="region" aria-label="Imported content" className="mt-2 flex flex-wrap items-start justify-between gap-3 rounded-card border border-info/40 bg-info/10 p-3 text-sm">
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="m-0"><strong>{IMPORTED_BAND}</strong> {IMPORTED_BAND_MORE}</p>
        {line && (
          <p role={line.alert ? 'alert' : 'status'} className={line.alert ? 'm-0 text-xs text-destructive' : 'm-0 text-xs text-muted-foreground'}>
            {line.text}{line.link && <> <button type="button" className="underline underline-offset-2" onClick={onOpenStyle}>{LEARN_LINK}</button></>}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-start justify-end gap-2">
        <Button size="sm" variant="outline" disabled={model.disabled} title={model.title} onClick={onLearn}>{model.button}</Button>
        {deleteAction}
      </div>
    </div>
  );
}

export function ImportedBand({ projectId, conceptId, readOnly, onOpenStyle, onDeleted }: { projectId: string; conceptId: string; readOnly: boolean; onOpenStyle?: () => void; onDeleted?: () => void }) {
  const learn = useContentStore((s) => s.learnByConcept[conceptId]);
  const loadLearn = useContentStore((s) => s.loadLearn);
  const startLearn = useContentStore((s) => s.startLearn);
  useEffect(() => { void loadLearn(projectId, conceptId); }, [projectId, conceptId, loadLearn]);
  return <ImportedBandView model={learnModel(learn?.status ?? null, learn?.refusal ?? null, readOnly)} onLearn={() => void startLearn(projectId, conceptId)} onOpenStyle={onOpenStyle} deleteAction={<DeleteConcept projectId={projectId} conceptId={conceptId} readOnly={readOnly} onDeleted={onDeleted} />} />;
}

/** A tab of an imported Concept: the read-only note, and what was imported, in place of any agent session. */
export function ImportedTab({ concept, tab, timeZone, now }: { concept: ConceptDto; tab: ConceptTab; timeZone: string; now?: number }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const posts = importedTabPosts(concept, tab);
  const selectedId = selectedPostId(posts, chosen);
  const content = importedTabContent(concept, tab, posts.find((p) => p.id === selectedId) ?? null);
  return (
    <div className="grid gap-3">
      {isPostTextTab(tab) && <PostSwitcher tab={tab} posts={posts} selectedId={selectedId} timeZone={timeZone} onSelect={setChosen} now={now} />}
      <div role="note" className="flex items-start gap-2 rounded-card border border-border bg-muted/40 p-3 text-sm">
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="grid min-w-0 gap-1">
          <span>{content.note}</span>
          {content.elsewhere.map((line) => <span key={line} className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{line}</span>)}
          {content.empty && <span className="text-xs text-muted-foreground">{content.empty}</span>}
        </div>
      </div>
      {content.text !== null && <pre aria-label="Imported text, read-only" className="m-0 whitespace-pre-wrap rounded-card border border-border p-3 font-sans text-sm [overflow-wrap:anywhere]">{content.text}</pre>}
    </div>
  );
}
