import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  confirmNewSessionText, currentDraft, draftHeading, EMPTY_DRAFT_TEXT, FINALIZED_HEADING, NO_AGENT_HINT, paneButtons, paneMode, previousRounds, REOPEN_TITLE, shownText,
} from '../../lib/contentStudio';
import type { PaneMode, StudioViewDto } from '../../lib/contentStudio';
import { canRunRetro, RETRO_KINDS, retroStatusLine, RUN_RETRO_TITLE } from '../../lib/contentRetro';
import type { AssetKind } from '../../lib/contentRules';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { cn } from '@/lib/utils';
import { RelativeTime } from '../design/RelativeTime';
import { ErrorNote } from '../crm/shared';
import { NO_SESSION_TITLE, sentHint } from '../../lib/scriptComments';
import { CommentableDraft } from './DraftComments';
import type { LineComments } from './DraftComments';

export type StudioAction = 'session/start' | 'session/new-round' | 'session/resume' | 'finalize' | 'reopen';

/** Copies text and says so in a toast; a refused clipboard (no permission, insecure page) is reported instead of ignored. */
export async function copyToClipboard(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard): Promise<boolean> {
  try {
    if (!clipboard) throw new Error('No clipboard');
    await clipboard.writeText(text);
    toast.success('Copied to the clipboard');
    return true;
  } catch {
    toast.error('Could not copy. Select the text and copy it by hand.');
    return false;
  }
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return <Button type="button" variant="outline" size="sm" onClick={() => void copyToClipboard(text)}><Copy aria-hidden="true" />{label}</Button>;
}

/** How a tab shows its text in the result pane; the Script tab uses the plain text and Copy. */
export interface StudioResultFormat {
  copyLabel: (text: string) => string;
  copyText: (text: string) => string;
  /** Controls beside Copy (the blog's Rendered / Raw toggle). */
  controls?: ReactNode;
  body: (text: string) => ReactNode;
  /** Under the actions once the asset is finalized. */
  finalizedNote?: ReactNode;
}

const PLAIN_RESULT: StudioResultFormat = {
  copyLabel: () => 'Copy',
  copyText: (text) => text,
  body: (text) => <pre className="m-0 whitespace-pre-wrap font-sans text-sm [overflow-wrap:anywhere]" data-result>{text}</pre>,
};

function Stamp({ at, now }: { at: string; now?: number }) {
  return <RelativeTime at={at} now={now} />;
}

/** The body of the "Start a new session" confirmation. */
export function NewSessionConfirmBody({ round }: { round: number }) {
  return <p className="m-0 text-sm">{confirmNewSessionText(round)}</p>;
}

function PreviousRounds({ view, now }: { view: StudioViewDto; now?: number }) {
  const rounds = previousRounds(view);
  if (!rounds.length) return null;
  return (
    <details className="rounded-card border border-border p-3" aria-label="Previous rounds">
      <summary className="cursor-pointer text-sm font-medium">Previous rounds ({rounds.length})</summary>
      <ul className="m-0 mt-3 grid list-none gap-3 p-0">
        {rounds.map((r) => (
          <li key={r.round} className="grid gap-1 text-sm" data-round={r.round}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">Round {r.round} · <span className="font-normal text-muted-foreground"><Stamp at={r.startedAt} now={now} /></span></span>
              {r.draft && <CopyButton text={r.draft.text} />}
            </div>
            <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-card bg-muted p-2 font-sans text-sm">{r.draft ? r.draft.text : 'No draft in this round.'}</pre>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The one line between the agent and the result: under the agent when stacked, beside it from 1024px. */
const PANE_DIVIDER = 'min-h-0 border-b border-border lg:border-b-0 lg:border-r';

function LeftPane({ mode, view, blocked, readOnly, onAction, renderTerminal, starting }: {
  mode: PaneMode; view: StudioViewDto | null; blocked: string | null; readOnly: boolean; onAction: (a: StudioAction) => void; renderTerminal: (sessionId: string) => ReactNode; starting?: ReactNode;
}) {
  const buttons = paneButtons(mode, false, readOnly);
  const hint = (state: string) => (state === 'disabled' && readOnly ? READ_ONLY_TITLE : undefined);
  if (mode === 'working' && view?.session) return <div className={cn('flex min-w-0 flex-col overflow-hidden', PANE_DIVIDER)} aria-label="Agent terminal">{renderTerminal(view.session.id)}</div>;
  return (
    <div className={cn('grid min-w-0 place-content-center gap-3 overflow-y-auto p-6 text-center text-sm', PANE_DIVIDER)} aria-label="Agent">
      {mode === 'blocked' && (
        <>
          <p className="m-0 font-medium [overflow-wrap:anywhere]">{blocked}</p>
          <p className="m-0 text-muted-foreground">{NO_AGENT_HINT}</p>
          <div><Button type="button" disabled={buttons.start !== 'enabled'} title={hint(buttons.start)} onClick={() => onAction('session/start')}>Start</Button></div>
        </>
      )}
      {mode === 'loading' && <p className="m-0 text-muted-foreground">Loading…</p>}
      {mode === 'starting' && (starting ?? <p className="m-0 text-muted-foreground">Starting the agent…</p>)}
      {mode === 'ended' && (
        <>
          <p className="m-0 font-medium">Session ended</p>
          <div className="flex justify-center gap-2">
            <Button type="button" disabled={buttons.resume !== 'enabled'} title={hint(buttons.resume)} onClick={() => onAction('session/resume')}>Resume</Button>
          </div>
        </>
      )}
    </div>
  );
}

export interface StudioPaneViewProps {
  view: StudioViewDto | null;
  blocked: string | null;
  readOnly: boolean;
  error: string | null;
  busy: boolean;
  confirmOpen: boolean;
  onAction: (a: StudioAction) => void;
  onAskNewSession: () => void;
  onCancelNewSession: () => void;
  renderTerminal: (sessionId: string) => ReactNode;
  /** The asset's kind: Run retro is offered on a finalized script, post text or article. */
  assetKind: AssetKind;
  retroError: string | null;
  onRunRetro: () => void;
  /** Opens the Writing style tab, where the proposal and the history are. */
  onOpenStyle: () => void;
  /** How the result is drawn; plain text when left out. */
  format?: StudioResultFormat;
  /** Why Reopen is not allowed (a published post uses the asset), or null. */
  reopenBlocked?: string | null;
  /** Replaces the text result on the right (the Images tab's gallery). */
  result?: ReactNode;
  /** With a custom result: why Finalize is disabled, or null when it may be pressed. Shown under the action bar and as the button's title. */
  finalizeHint?: string | null;
  /** Replaces the text Previous rounds list. */
  previous?: ReactNode;
  /** The left pane while the session is starting (the Remotion setup). */
  starting?: ReactNode;
  /** Line comments on the plain draft (the Script tab); left out, the draft is drawn by `format`. */
  comments?: LineComments;
  /** Offers Start a new session on a finalized asset too (the Thumbnail tab); the Images tab leaves it hidden. */
  newSessionWhenFinalized?: boolean;
  /** On the left of the result pane's footer, before the actions (the Script tab's word count, length and speed). */
  stats?: ReactNode;
  /** Pins the clock (tests). */
  now?: number;
}

/** The finalized text's last retro, read out politely to screen readers when it changes. */
export function RetroStatus({ view, onOpenStyle, now }: { view: StudioViewDto; onOpenStyle: () => void; now?: number }) {
  const line = retroStatusLine(view.retro);
  return (
    <div role="status" aria-live="polite" className={cn('min-h-5 text-sm', line?.failed && 'text-destructive')} aria-label="Retro status">
      {line && view.retro && (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {view.retro.status === 'running' && <span aria-hidden="true" className="size-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent motion-reduce:animate-none" />}
          <span className="font-medium [overflow-wrap:anywhere]">{line.lead}</span>
          {line.detail && <span className="text-muted-foreground">{line.detail}</span>}
          {view.retro.status !== 'running' && <span className="text-muted-foreground"><RelativeTime at={view.retro.at} now={now} /></span>}
          {line.link && <button type="button" className="underline underline-offset-2" onClick={onOpenStyle}>{line.link === 'proposals' ? 'Review in Writing style' : 'See Writing style history'}</button>}
        </span>
      )}
    </div>
  );
}

/**
 * The pane drawn from its view, edge to edge: the agent on the left and the result on the right, split by one 1px line.
 * The result pane pins its heading and its footer (stats and actions) and scrolls only its body. Free of the store so it renders on its own.
 */
export function StudioPaneView({
  view, blocked, readOnly, error, busy, confirmOpen, onAction, onAskNewSession, onCancelNewSession, renderTerminal, assetKind, retroError, onRunRetro, onOpenStyle,
  format = PLAIN_RESULT, reopenBlocked = null, newSessionWhenFinalized = false, now, result, finalizeHint, previous, starting, comments, stats,
}: StudioPaneViewProps) {
  const mode = paneMode(view, blocked);
  const text = view ? shownText(view) : null;
  const custom = result !== undefined;
  const buttons = paneButtons(mode, custom ? finalizeHint === null : text !== null, readOnly);
  const hint = (state: string) => (state === 'disabled' && readOnly ? READ_ONLY_TITLE : undefined);
  const draft = view ? currentDraft(view) : null;
  const finalized = mode === 'finalized' && view;
  const retroRunning = view?.retro?.status === 'running';
  const commenting = comments && !finalized && comments.block !== 'hidden' && text !== null ? comments : null;
  const commentHint = commenting && (commenting.block === NO_SESSION_TITLE ? NO_SESSION_TITLE : sentHint(commenting.state));
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Agent pane" data-mode={mode}>
      {view?.skillWarning && <p role="status" className="m-0 shrink-0 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm sm:px-6">{view.skillWarning}</p>}
      <div className={cn('grid min-h-0 flex-1 overflow-y-auto lg:overflow-hidden', finalized ? 'grid-cols-1 grid-rows-[minmax(0,1fr)]' : 'grid-rows-[minmax(12rem,2fr)_minmax(16rem,3fr)] lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]')}>
        {!finalized && <LeftPane mode={mode} view={view} blocked={blocked} readOnly={readOnly} onAction={onAction} renderTerminal={renderTerminal} starting={starting} />}
        <div className="flex min-h-0 min-w-0 flex-col bg-card" aria-label="Result column">
          {!custom && (
            <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-3 sm:px-6" aria-label="Result heading">
              <h3 className="m-0 text-sm font-medium">
                {finalized ? <>{FINALIZED_HEADING} <Stamp at={view.asset.finalizedAt ?? view.rounds.at(-1)?.startedAt ?? ''} now={now} /></>
                  : draft && view ? <>{draftHeading(view.asset.round)} <Stamp at={draft.savedAt} now={now} /></> : 'Result'}
              </h3>
              {text !== null && buttons.copy === 'enabled' && <div className="flex flex-wrap items-center gap-2">{format.controls}<CopyButton text={format.copyText(text)} label={format.copyLabel(text)} /></div>}
            </div>
          )}
          <div className={cn('grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 pb-4 sm:px-6', custom && 'pt-3')} aria-label="Result body">
            {custom ? result : <div className="grid min-w-0 content-start gap-2" aria-label="Result">
              {commentHint && <p role="status" className="m-0 text-xs text-muted-foreground" data-comment-hint>{commentHint}</p>}
              {commenting && text !== null ? <CommentableDraft text={text} comments={commenting} now={now} />
                : text !== null
                ? format.body(text)
                : <p className="m-0 py-6 text-center text-sm text-muted-foreground" data-result>{EMPTY_DRAFT_TEXT}</p>}
            </div>}
            {finalized && format.finalizedNote}
            {previous !== undefined ? previous : view && <PreviousRounds view={view} now={now} />}
          </div>
          <div className="grid shrink-0 gap-2 border-t border-border px-4 py-3 sm:px-6" aria-label="Pane footer">
            <ErrorNote message={error} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {stats}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2" aria-label="Pane actions">
                {buttons.finalize !== 'hidden' && <Button type="button" disabled={buttons.finalize !== 'enabled' || busy} title={(custom ? finalizeHint : null) ?? hint(buttons.finalize)} onClick={() => onAction('finalize')}>Finalize</Button>}
                {buttons.newSession !== 'hidden' && <Button type="button" variant="outline" disabled={buttons.newSession !== 'enabled' || busy} title={hint(buttons.newSession)} onClick={onAskNewSession}>Start a new session</Button>}
                {finalized && newSessionWhenFinalized && <Button type="button" variant="outline" disabled={readOnly || busy || reopenBlocked !== null} title={readOnly ? READ_ONLY_TITLE : (reopenBlocked ?? undefined)} onClick={onAskNewSession}>Start a new session</Button>}
                {buttons.reopen !== 'hidden' && <Button type="button" variant="outline" disabled={buttons.reopen !== 'enabled' || busy || reopenBlocked !== null} title={readOnly ? READ_ONLY_TITLE : (reopenBlocked ?? REOPEN_TITLE)} onClick={() => onAction('reopen')}>Reopen</Button>}
                {finalized && RETRO_KINDS.includes(assetKind) && (
                  <Button type="button" variant="outline" disabled={!canRunRetro(assetKind, view.asset.state, readOnly, view.retro)} title={readOnly ? READ_ONLY_TITLE : retroRunning ? 'A retro is running for this text' : RUN_RETRO_TITLE} onClick={onRunRetro}>Run retro</Button>
                )}
              </div>
            </div>
            {custom && !finalized && finalizeHint && <p className="m-0 text-xs text-muted-foreground" data-finalize-hint>{finalizeHint}</p>}
            {finalized && <ErrorNote message={retroError} />}
            {finalized && <RetroStatus view={view} onOpenStyle={onOpenStyle} now={now} />}
          </div>
        </div>
      </div>
      {confirmOpen && view && (
        <Dialog open onOpenChange={(open) => { if (!open) onCancelNewSession(); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Start a new session</DialogTitle>
              <DialogDescription><NewSessionConfirmBody round={view.asset.round} /></DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancelNewSession}>Cancel</Button>
              <Button type="button" disabled={busy} onClick={() => onAction('session/new-round')}>Start a new session</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
