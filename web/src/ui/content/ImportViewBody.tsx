import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IMPORT_EMPTY_HINTS, IMPORT_EMPTY_LEAD, IMPORT_FACTS, importCount, importedRowModel } from '../../lib/contentImport';
import type { ImportPaneModel, ImportSessionViewDto } from '../../lib/contentImport';
import { ErrorNote } from '../crm/shared';
import { DetailBackButton } from '../project-popup/DetailHeader';
import { ImportedBadge } from './shared';

function AgentBox({ box, busy, onAction }: { box: NonNullable<ImportPaneModel['box']>; busy: boolean; onAction: (action: 'start' | 'resume') => void }) {
  return (
    <div className="grid h-full min-h-64 place-content-center gap-3 rounded-card border border-dashed border-border p-6 text-center text-sm" aria-label="Agent">
      <p className="m-0 font-medium">{box.lead}</p>
      {box.sub && <p className="m-0 text-muted-foreground">{box.sub}</p>}
      {box.action && <div><Button disabled={busy} onClick={() => onAction(box.action!)}>{box.actionLabel}</Button></div>}
    </div>
  );
}

function SavedRows({ view, timeZone, onOpen }: { view: ImportSessionViewDto | undefined; timeZone: string; onOpen: (id: string) => void }) {
  if (!view?.saved.length) {
    return (
      <div className="text-sm text-muted-foreground">
        <p className="m-0"><strong>{IMPORT_EMPTY_LEAD}</strong> Each Concept the agent saves appears here. Useful things to give it:</p>
        <ul className="m-0 mt-1 list-disc pl-5">{IMPORT_EMPTY_HINTS.map((hint) => <li key={hint}>{hint}</li>)}</ul>
      </div>
    );
  }
  return (
    <ul className="m-0 grid list-none gap-2 p-0">{view.saved.map((concept) => {
      const row = importedRowModel(concept, timeZone);
      return (
        <li key={row.id}>
          <button type="button" className="grid w-full gap-1.5 rounded-card border border-border bg-card p-3 text-left text-foreground" onClick={() => onOpen(row.id)}>
            <span className="flex items-start justify-between gap-2"><span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{row.title}</span><ImportedBadge /></span>
            <span className="flex flex-wrap gap-1.5">{row.chips.map((chip) => <span key={chip} className="rounded-full border border-border px-2 py-0.5 text-xs">{chip}</span>)}</span>
            <span className="text-xs text-muted-foreground">{row.stats}</span>
          </button>
        </li>
      );
    })}</ul>
  );
}

export interface ImportViewBodyProps {
  view: ImportSessionViewDto | undefined; model: ImportPaneModel; timeZone: string; busy: boolean; error: string | null;
  renderTerminal: (sessionId: string) => ReactNode;
  onBack: () => void; onOpen: (conceptId: string) => void; onAction: (action: 'start' | 'resume' | 'new' | 'end') => void;
}

/** The import session in place of the list: the agent's terminal on the left, what it saved on the right. Free of the store so it renders on its own. */
export function ImportViewBody({ view, model, timeZone, busy, error, renderTerminal, onBack, onOpen, onAction }: ImportViewBodyProps) {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Import past concepts">
      <header className="shrink-0 border-b px-4 py-3 sm:px-6">
        <div className="flex items-start gap-2.5">
          <DetailBackButton onBack={onBack} label="Back to Concepts" />
          <h3 className="min-w-0 flex-1 pt-1.5 text-sm font-semibold leading-snug">Import past concepts</h3>
          <Badge variant={model.live ? 'success' : 'secondary'} className="shrink-0">{model.badge}</Badge>
        </div>
        <p className="m-0 pl-10.5 text-xs text-muted-foreground">{IMPORT_FACTS}</p>
        <ErrorNote message={error} />
      </header>
      <div className="grid min-h-0 flex-1 gap-4 p-4 sm:px-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-h-80 min-w-0">
          {model.showTerminal && view?.session
            ? <div className="flex h-full min-h-80 min-w-0 flex-col overflow-hidden rounded-card border border-border" aria-label="Agent terminal">{renderTerminal(view.session.id)}</div>
            : model.box && <AgentBox box={model.box} busy={busy} onAction={onAction} />}
        </div>
        <div className="grid min-w-0 content-start gap-2 overflow-y-auto" aria-label="Imported in this session">
          <h4 className="m-0 text-sm font-semibold">Imported in this session {importCount(view)}</h4>
          <SavedRows view={view} timeZone={timeZone} onOpen={onOpen} />
        </div>
      </div>
      {(model.foot || model.canEnd || model.canStartNew) && (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-3 sm:px-6">
          <p className="m-0 text-xs text-muted-foreground">{model.foot}</p>
          {model.canEnd && <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('end')}>End session</Button>}
          {model.canStartNew && <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('new')}>Start a new session</Button>}
        </footer>
      )}
    </section>
  );
}
