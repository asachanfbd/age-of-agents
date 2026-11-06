import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, Lock, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { contentApi } from '../../lib/contentApi';
import type { StudioViewDto } from '../../lib/contentStudio';
import { NO_AGENT_HINT } from '../../lib/contentStudio';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { compositionUrl } from '../../lib/contentRemotion';
import type { RemotionStudioControl } from './useRemotionStudio';
import {
  activeRender, canFinalize, confirmHint, deleteMediaText, DISCARD_KEEPS, discardText, discardTitle, etaText, FINALIZE_IDLE_HINT, finalizeHint, finalRenderAlert, formatBytes, formatDuration,
  playableRender, previousRoundRenders, queuedText, renderProgressText, roundRenderRows, SCRIPT_CHANGED_TEXT, tabColumnsClass, tickCount, videoPaneState,
} from '../../lib/contentVideo';
import type { ChecklistDto, ChecklistItemDto, MediaDto, RenderDto, UploadRow, VideoPaneState } from '../../lib/contentVideo';
import { RelativeTime } from '../design/RelativeTime';
import { ErrorNote } from '../crm/shared';
import { MediaColumn } from './MediaColumn';
import { MediaPreviewDialog } from './MediaPreviewDialog';
import { OpenInNewTab, StudioBody } from './RemotionTabView';

export interface VideoTabActions {
  onStart(): void;
  onResume(): void;
  onDiscard(): void;
  onFinalize(): void;
  onReopen(): void;
  onTick(itemId: string, ticked: boolean): void;
  onLink(itemId: string, mediaIds: string[]): void;
  onConfirm(): void;
  onStopRender(renderId: string): void;
  onFiles(files: File[]): void;
  onCancelUpload(key: string): void;
  onRenameMedia(mediaId: string, name: string): void;
  onDeleteMedia(mediaId: string): void;
}

export interface VideoTabViewProps extends VideoTabActions {
  view: StudioViewDto | null;
  readOnly: boolean;
  uploads: UploadRow[];
  busy: boolean;
  error: string | null;
  /** The last rename's refusal (a 409), shown in the preview popup. */
  renameError?: string | null;
  dragCount: number | null;
  onDragCount(count: number | null): void;
  /** The Building's Remotion Studio, shown as the live preview after Confirm. */
  studio: RemotionStudioControl;
  renderTerminal(sessionId: string): ReactNode;
  /** Pins the clock (tests). */
  now?: number;
  /** Opens a dialog from the start (tests render each one). */
  initialDialog?: Dialogs;
}

type Dialogs = { kind: 'discard' } | { kind: 'confirmed' } | { kind: 'preview'; mediaId: string; rename: boolean } | { kind: 'delete'; mediaId: string } | null;

const hintFor = (readOnly: boolean, enabledHint?: string | null) => (readOnly ? READ_ONLY_TITLE : enabledHint ?? undefined);

function Center({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="grid min-h-[16rem] place-content-center gap-3 p-4 text-center text-sm" aria-label={label}>{children}</div>;
}

function Bar({ percent }: { percent: number | null }) {
  return <div className="h-1.5 w-full overflow-hidden rounded bg-muted"><i className={cn('block h-full bg-primary', percent === null && 'w-1/3 opacity-60')} style={percent === null ? undefined : { width: `${percent}%` }} /></div>;
}

/** The agent column: the CLI while a session runs, otherwise why not and what to press. */
function AgentColumn({ state, view, readOnly, busy, actions, renderTerminal }: { state: VideoPaneState; view: StudioViewDto | null; readOnly: boolean; busy: boolean; actions: VideoTabActions; renderTerminal: (id: string) => ReactNode }) {
  const video = view?.video;
  if (view?.session && view.session.state === 'running') {
    return <section className="flex min-h-64 min-w-0 flex-col overflow-hidden rounded-card border border-border min-[960px]:min-h-0" aria-label="Agent terminal">{renderTerminal(view.session.id)}</section>;
  }
  return (
    <section className="min-h-0 min-w-0 overflow-y-auto rounded-card border border-dashed border-border" aria-label="Agent">
      {state === 'setup' && (
        <Center>
          <p className="m-0 font-medium">Setting up Remotion…</p>
          <div className="mx-auto w-64"><Bar percent={video?.setup.percent ?? null} /></div>
          <p className="m-0 text-muted-foreground">Installing the video project's packages. This happens once per Building and is also listed in the status footer. The agent starts when it finishes.</p>
        </Center>
      )}
      {state === 'setupfail' && (
        <Center>
          <p role="alert" className="m-0 rounded-card border border-destructive/40 bg-destructive/10 p-2 text-left">{video?.setup.error}</p>
          <p className="m-0 text-muted-foreground">Check the internet connection, then try again.</p>
          <div><Button type="button" disabled={readOnly || busy} title={hintFor(readOnly)} onClick={actions.onStart}>Retry setup</Button></div>
        </Center>
      )}
      {state === 'blocked' && (
        <Center>
          <p className="m-0 font-medium">{video?.blockedReason}</p>
          <p className="m-0 text-muted-foreground">{NO_AGENT_HINT}</p>
          <div><Button type="button" disabled={readOnly || busy} title={hintFor(readOnly)} onClick={actions.onStart}>Start</Button></div>
        </Center>
      )}
      {(state === 'starting' || state === 'loading') && (
        <Center>
          <p className="m-0 text-muted-foreground">{readOnly ? 'This Building is read-only, so no session is started.' : state === 'loading' ? 'Loading…' : 'No video session yet.'}</p>
          {state === 'starting' && <div><Button type="button" disabled={readOnly || busy} title={hintFor(readOnly)} onClick={actions.onStart}>Start</Button></div>}
        </Center>
      )}
      {view?.session?.state === 'ended' && (
        <Center>
          <p className="m-0 font-medium">Session ended</p>
          <p className="m-0 text-muted-foreground">The agent exited. Resume picks up the same conversation.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" disabled={readOnly || busy} title={hintFor(readOnly)} onClick={actions.onResume}>Resume</Button>
            <DiscardButton readOnly={readOnly} busy={busy} onClick={actions.onDiscard} />
          </div>
        </Center>
      )}
    </section>
  );
}

function DiscardButton({ readOnly, busy, onClick }: { readOnly: boolean; busy: boolean; onClick: () => void }) {
  return <Button type="button" variant="outline" disabled={readOnly || busy} title={hintFor(readOnly)} onClick={onClick}>Discard the session, start a new session</Button>;
}

/** The "Link files" popover of one checklist item. */
function LinkFiles({ item, media, disabled, onLink }: { item: ChecklistItemDto; media: MediaDto[]; disabled: boolean; onLink: (ids: string[]) => void }) {
  const [chosen, setChosen] = useState<string[]>(item.mediaIds);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setChosen(item.mediaIds); }}>
      <PopoverTrigger asChild><button type="button" disabled={disabled} className="text-xs text-primary underline disabled:opacity-50">{item.mediaIds.length ? 'Change files' : 'Link files'}</button></PopoverTrigger>
      <PopoverContent className="grid w-64 gap-1" aria-label="Link media">
        <b className="text-xs">Link files to "{item.label}"</b>
        {!media.length && <p className="m-0 text-xs text-muted-foreground">No media yet.</p>}
        {media.map((m) => (
          <label key={m.id} className="flex min-w-0 items-center gap-2 text-xs" title={m.name}>
            <Checkbox checked={chosen.includes(m.id)} onCheckedChange={(on) => setChosen((c) => (on ? [...c, m.id] : c.filter((x) => x !== m.id)))} />
            <span className="min-w-0 truncate">{m.name}</span>
          </label>
        ))}
        <Button type="button" size="sm" onClick={() => { onLink(chosen); setOpen(false); }}>Done</Button>
      </PopoverContent>
    </Popover>
  );
}

const nameOf = (media: MediaDto[], id: string) => media.find((m) => m.id === id)?.name;

function ChecklistPanel({ list, media, readOnly, busy, actions }: { list: ChecklistDto; media: MediaDto[]; readOnly: boolean; busy: boolean; actions: VideoTabActions }) {
  const ready = list.items.length > 0 && list.items.every((i) => i.ticked);
  return (
    <div className="grid gap-3" aria-label="Checklist">
      <div className="flex items-baseline justify-between gap-2"><h3 className="m-0 text-sm font-medium">Assets the agent needs</h3><span className="text-xs text-muted-foreground">{tickCount(list)}</span></div>
      <p className="m-0 text-xs text-muted-foreground">Tick an item when its file is in the media column, or when it isn't needed. Link files so the agent knows which is which (optional).</p>
      <ul className="m-0 grid list-none gap-2 p-0">
        {list.items.map((item) => (
          <li key={item.id} data-ticked={item.ticked} className="flex gap-2 rounded-md border border-border p-2">
            <Checkbox id={`ci-${item.id}`} checked={item.ticked} disabled={readOnly || busy} title={hintFor(readOnly)} onCheckedChange={(on) => actions.onTick(item.id, on === true)} />
            <div className="grid min-w-0 gap-1">
              <label htmlFor={`ci-${item.id}`} className="text-sm font-medium">{item.label}</label>
              {item.detail && <p className="m-0 text-xs text-muted-foreground">{item.detail}</p>}
              <div className="flex flex-wrap items-center gap-1">
                {item.mediaIds.map((id) => <span key={id} className="max-w-40 truncate rounded-full border border-border px-2 text-[11px]" title={nameOf(media, id)}>{nameOf(media, id)}</span>)}
                <LinkFiles item={item} media={media} disabled={readOnly || busy} onLink={(ids) => actions.onLink(item.id, ids)} />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="grid gap-1">
        <Button type="button" disabled={!ready || readOnly || busy} title={hintFor(readOnly)} onClick={actions.onConfirm}>Confirm assets</Button>
        <p className="m-0 text-xs text-muted-foreground">{confirmHint(list)}</p>
      </div>
    </div>
  );
}

/** The confirmed checklist, read-only. */
export function ConfirmedChecklist({ list, media }: { list: ChecklistDto; media: MediaDto[] }) {
  return (
    <ul className="m-0 grid list-none gap-2 p-0" aria-label="Confirmed checklist">
      {list.items.map((item) => (
        <li key={item.id} className="grid text-sm">
          <span className="font-medium">✓ {item.label}</span>
          <span className="text-xs text-muted-foreground">{item.mediaIds.length ? item.mediaIds.map((id) => nameOf(media, id)).filter(Boolean).join(', ') : 'No file linked'}</span>
        </li>
      ))}
    </ul>
  );
}

function RenderRows({ rows, playingId, onPlay, now }: { rows: { render: RenderDto; badge: string | null }[]; playingId: string | null; onPlay: (id: string) => void; now?: number }) {
  return (
    <ul className="m-0 grid list-none gap-1 p-0" aria-label="Renders">
      {rows.map(({ render, badge }) => (
        <li key={render.id} data-current={render.id === playingId || undefined} className="flex items-center gap-2 text-xs">
          {render.fileUrl
            ? <button type="button" aria-label={`Play round ${render.round} render ${render.k}`} onClick={() => onPlay(render.id)}><Play className="size-3.5" /></button>
            : <span className="size-3.5" />}
          <span className="min-w-0 flex-1">
            Render {render.k} {badge && <span className="rounded-full border border-border px-1.5 text-[10px]">{badge}</span>}{' '}
            <small className="text-muted-foreground">· {render.status === 'done' ? formatDuration(render.durationMs) || 'done' : render.status} · <RelativeTime at={render.finishedAt ?? render.createdAt} now={now} /></small>
          </span>
          {render.fileUrl && <a href={contentApi.assetUrl(`${render.fileUrl}?download=1`)} aria-label={`Download round ${render.round} render ${render.k}`}><Download className="size-3.5" /></a>}
        </li>
      ))}
    </ul>
  );
}

function Player({ render }: { render: RenderDto | null }) {
  if (!render?.fileUrl) return null;
  // Native controls carry their own fullscreen; there is no separate button.
  return <video key={render.id} controls preload="metadata" src={contentApi.assetUrl(render.fileUrl)} aria-label="Video player" className="max-h-[64vh] w-full rounded-md bg-muted" />;
}

/** The finalized video: the player, its facts, Download and Reopen. */
function FinalizedPanel({ view, readOnly, busy, actions, playingId, onPlay, now }: { view: StudioViewDto; readOnly: boolean; busy: boolean; actions: VideoTabActions; playingId: string | null; onPlay: (id: string) => void; now?: number }) {
  const rows = roundRenderRows(view);
  const playable = playableRender(view);
  const playing = view.video!.renders.find((r) => r.id === playingId && r.fileUrl) ?? playable;
  return (
    <div className="grid gap-3" aria-label="Video preview">
      <h3 className="m-0 text-sm font-medium">Finalized <RelativeTime at={view.asset.finalizedAt ?? ''} now={now} /></h3>
      <Player render={playing ?? null} />
      {playing && <p className="m-0 text-xs"><b>Render {playing.k}</b> · {formatDuration(playing.durationMs) || 'length unknown'}{playing.size ? ` · ${formatBytes(playing.size)}` : ''}</p>}
      <div className="flex flex-wrap gap-2">
        {playing?.fileUrl && <Button variant="outline" asChild><a href={contentApi.assetUrl(`${playing.fileUrl}?download=1`)}><Download />Download</a></Button>}
        <Button type="button" variant="outline" disabled={readOnly || busy} title={hintFor(readOnly)} onClick={actions.onReopen}>Reopen</Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground">Reopen starts a new round with this round's composition code and the confirmed checklist already ticked.</p>
      {rows.length > 0 && <div className="grid gap-1"><p className="m-0 text-xs font-medium">Renders</p><RenderRows rows={rows} playingId={playing?.id ?? null} onPlay={onPlay} now={now} /></div>}
    </div>
  );
}

/** The final render's progress box: percent and time left while it runs, or why it waits, with Stop. */
function RenderProgress({ render, readOnly, busy, onStop }: { render: RenderDto; readOnly: boolean; busy: boolean; onStop: () => void }) {
  // Progress samples of the running render, for the time-left estimate.
  const [samples, setSamples] = useState<{ id: string; at: number; percent: number }[]>([]);
  const runningId = render.status === 'running' ? render.id : null;
  const runningPercent = render.status === 'running' ? render.percent : null;
  useEffect(() => {
    if (runningId === null || runningPercent === null) return;
    setSamples((s) => [...s.filter((x) => x.id === runningId), { id: runningId, at: Date.now(), percent: runningPercent }].slice(-10));
  }, [runningId, runningPercent]);
  const eta = etaText(samples.filter((x) => x.id === runningId));
  return (
    <div role="status" className="grid gap-1.5 rounded-md border border-border p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <b>{render.status === 'running' ? 'Rendering final video' : 'Final render is waiting'}</b>
        <Button type="button" size="sm" variant="outline" disabled={readOnly || busy} title={hintFor(readOnly)} onClick={onStop}><Square />Stop</Button>
      </div>
      {render.status === 'running'
        ? <><Bar percent={render.percent} /><span className="flex justify-between gap-2 text-muted-foreground"><span>{renderProgressText(render)}</span>{eta && <span>{eta}</span>}</span></>
        : <p className="m-0 text-muted-foreground [overflow-wrap:anywhere]">{queuedText(render)}</p>}
    </div>
  );
}

/** After Confirm: the live Remotion Studio preview of the Concept's composition, and Finalize, which renders the final MP4. */
function PreviewPanel({ view, studio, readOnly, busy, actions, onShowConfirmed }: { view: StudioViewDto; studio: RemotionStudioControl; readOnly: boolean; busy: boolean; actions: VideoTabActions; onShowConfirmed: () => void }) {
  const video = view.video!;
  const active = activeRender(view);
  const alert = finalRenderAlert(view);
  const hint = finalizeHint(view);
  const url = compositionUrl(studio.view?.state === 'running' ? studio.view.url : null, video.compositionId);
  return (
    <div className="grid gap-3" aria-label="Video preview">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-sm font-medium">Round {view.asset.round} · Live preview</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline" onClick={onShowConfirmed}><Lock className="size-3" />Assets confirmed · {video.checklist.items.length} {video.checklist.items.length === 1 ? 'item' : 'items'}</button>
          <OpenInNewTab url={url} />
        </div>
      </div>
      {alert && <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs [overflow-wrap:anywhere]">{alert}</p>}
      {active && <RenderProgress render={active} readOnly={readOnly} busy={busy} onStop={() => actions.onStopRender(active.id)} />}
      <ErrorNote message={studio.error} />
      <StudioBody view={studio.view} pane={studio.pane} url={url} compositionId={video.compositionId} setupPercent={studio.setupPercent} busy={studio.busy} waitingLabel="Setting up Remotion…" frameClass="h-[calc(100vh-420px)] min-h-[20rem]" onStart={studio.start} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canFinalize(view, readOnly) || busy} title={hintFor(readOnly, hint)} onClick={actions.onFinalize}>Finalize</Button>
        <DiscardButton readOnly={readOnly} busy={busy} onClick={actions.onDiscard} />
      </div>
      <p className="m-0 text-xs text-muted-foreground">{hint ?? FINALIZE_IDLE_HINT}</p>
    </div>
  );
}

/** The checklist or the preview, with earlier rounds' renders scrolling under it. */
function RightPane(props: { state: VideoPaneState; view: StudioViewDto | null; studio: RemotionStudioControl; readOnly: boolean; busy: boolean; actions: VideoTabActions; playingId: string | null; onPlay: (id: string) => void; onShowConfirmed: () => void; now?: number }) {
  const { state, view, studio, readOnly, busy, actions, playingId, onPlay, now } = props;
  const video = view?.video;
  let body: ReactNode;
  if (!view || !video || ['loading', 'setup', 'setupfail', 'blocked', 'starting'].includes(state)) body = <Center><p className="m-0 text-muted-foreground">The agent's asset checklist shows here once the session starts.</p></Center>;
  else if (state === 'waiting' || (state === 'ended' && !video.checklist.items.length)) body = <Center><p className="m-0 font-medium">Waiting for the agent's checklist</p><p className="m-0 text-muted-foreground">The agent lists the media it needs before it builds anything. You can drop files into the media column already.</p></Center>;
  else if (state === 'checklist' || state === 'ready' || state === 'ended') body = <ChecklistPanel list={video.checklist} media={video.media} readOnly={readOnly} busy={busy} actions={actions} />;
  else if (state === 'finalized') body = <FinalizedPanel view={view} readOnly={readOnly} busy={busy} actions={actions} playingId={playingId} onPlay={onPlay} now={now} />;
  else body = <PreviewPanel view={view} studio={studio} readOnly={readOnly} busy={busy} actions={actions} onShowConfirmed={props.onShowConfirmed} />;
  const previous = view ? previousRoundRenders(view) : [];
  return (
    <section className="grid min-h-0 min-w-0 content-start gap-3 overflow-y-auto rounded-card border border-border bg-card p-3" aria-label="Video">
      {body}
      {previous.length > 0 && (
        <details className="rounded-card border border-border p-3" aria-label="Previous rounds">
          <summary className="cursor-pointer text-sm font-medium">Previous rounds ({previous.length})</summary>
          <div className="mt-3 grid gap-3">
            {previous.map((r) => <div key={r.round} className="grid gap-1"><b className="text-sm">Round {r.round}</b><RenderRows rows={r.renders.map((render) => ({ render, badge: null }))} playingId={playingId} onPlay={onPlay} now={now} /></div>)}
            <p className="m-0 text-xs text-muted-foreground">Read-only. Earlier rounds' code is archived; it is not used by later rounds.</p>
          </div>
        </details>
      )}
    </section>
  );
}

/** The Video tab drawn from its view: media column, agent, and the checklist or the preview. Free of the store so each state renders on its own. */
export function VideoTabView(props: VideoTabViewProps) {
  const { view, readOnly, uploads, busy, error, renameError, dragCount, onDragCount, studio, renderTerminal, now, initialDialog = null } = props;
  const [dialog, setDialog] = useState<Dialogs>(initialDialog);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const state = videoPaneState(view);
  const video = view?.video;
  const media = video?.media ?? [];
  const finalized = state === 'finalized';
  const shown = dialog && (dialog.kind === 'preview' || dialog.kind === 'delete') ? media.find((m) => m.id === dialog.mediaId) : undefined;
  const linkedLabels = shown ? (video?.checklist.items ?? []).filter((i) => i.mediaIds.includes(shown.id)).map((i) => i.label) : [];
  // Every Discard button in the tab asks first; only the dialog's own button discards.
  const actions: VideoTabActions = { ...props, onDiscard: () => setDialog({ kind: 'discard' }) };
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label="Video tab" data-state={state}>
      {video?.scriptChanged && !finalized && <p role="status" className="m-0 rounded-card border border-warning/40 bg-warning/10 p-2 text-sm">{SCRIPT_CHANGED_TEXT}</p>}
      {readOnly && <p role="status" className="m-0 rounded-card border border-info/40 bg-info/10 p-2 text-sm">This Building is read-only. You can watch and play renders, but nothing can be uploaded, ticked, rendered or finalized.</p>}
      <ErrorNote message={error} />
      {/* One row capped to the remaining height, so each column scrolls inside itself; stacked below 960px the grid scrolls. */}
      <div className={cn('grid min-h-0 flex-1 gap-3 overflow-y-auto min-[960px]:grid-rows-[minmax(0,1fr)] min-[960px]:overflow-hidden', tabColumnsClass(state))}>
        <MediaColumn
          media={media} uploads={uploads} readOnly={readOnly} dragCount={dragCount} onDragCount={onDragCount} onFiles={props.onFiles}
          onOpen={(m, rename) => setDialog({ kind: 'preview', mediaId: m.id, rename: !!rename })} onDelete={(m) => setDialog({ kind: 'delete', mediaId: m.id })} onCancelUpload={props.onCancelUpload}
        />
        {!finalized && <AgentColumn state={state} view={view} readOnly={readOnly} busy={busy} actions={actions} renderTerminal={renderTerminal} />}
        <RightPane state={state} view={view} studio={studio} readOnly={readOnly} busy={busy} actions={actions} playingId={playingId} onPlay={setPlayingId} onShowConfirmed={() => setDialog({ kind: 'confirmed' })} now={now} />
      </div>
      {dialog?.kind === 'discard' && view && (
        <Dialog open onOpenChange={(open) => { if (!open) setDialog(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>{discardTitle}</DialogTitle><DialogDescription>{discardText(view.asset.round)}</DialogDescription></DialogHeader>
            <p className="m-0 text-sm text-muted-foreground">{DISCARD_KEEPS}</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
              <Button type="button" disabled={busy} onClick={() => { props.onDiscard(); setDialog(null); }}>Discard and start round {view.asset.round + 1}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {dialog?.kind === 'confirmed' && video && (
        <Dialog open onOpenChange={(open) => { if (!open) setDialog(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Confirmed checklist · round {video.checklist.round}</DialogTitle><DialogDescription>Locked when you confirmed it.</DialogDescription></DialogHeader>
            <ConfirmedChecklist list={video.checklist} media={media} />
            <DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(null)}>Close</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {dialog?.kind === 'preview' && shown && (
        <MediaPreviewDialog
          media={shown} otherNames={media.filter((m) => m.id !== shown.id).map((m) => m.name)} readOnly={readOnly} renaming={dialog.rename} saveError={renameError} busy={busy}
          onRename={(name) => props.onRenameMedia(shown.id, name)} onDelete={() => setDialog({ kind: 'delete', mediaId: shown.id })} onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && shown && (
        <Dialog open onOpenChange={(open) => { if (!open) setDialog(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Delete this file?</DialogTitle><DialogDescription>{deleteMediaText(shown.name, linkedLabels)}</DialogDescription></DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => { props.onDeleteMedia(shown.id); setDialog(null); }}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
