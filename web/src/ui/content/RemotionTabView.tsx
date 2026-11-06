import type { ReactNode } from 'react';
import { ExternalLink, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { compositionUrl, STUDIO_TEXT, studioChip, studioHeaderControls, studioLogTail } from '../../lib/contentRemotion';
import type { RemotionStudioDto, StudioPaneState } from '../../lib/contentRemotion';
import { ErrorNote } from '../crm/shared';

export interface RemotionTabViewProps {
  view: RemotionStudioDto | null;
  pane: StudioPaneState;
  compositionId: string;
  /** The Remotion setup's percent while Studio waits for it, or null while unknown. */
  setupPercent: number | null;
  narrow: boolean;
  busy: boolean;
  error: string | null;
  onStart(): void;
  onStop(): void;
}

function Center({ children }: { children: ReactNode }) {
  return <div className="grid min-h-[20rem] place-content-center justify-items-center gap-3 p-4 text-center text-sm">{children}</div>;
}

function Bar({ percent }: { percent: number | null }) {
  return <div className="h-1.5 w-64 max-w-full overflow-hidden rounded bg-muted"><i className={cn('block h-full bg-primary', percent === null && 'w-1/3 opacity-60')} style={percent === null ? undefined : { width: `${percent}%` }} /></div>;
}

function Log({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return <pre aria-label="Studio log" className="m-0 max-h-56 w-full max-w-3xl overflow-auto whitespace-pre-wrap rounded-card border border-border bg-muted/40 p-2 text-left font-mono text-xs [overflow-wrap:anywhere]">{studioLogTail(lines).join('\n')}</pre>;
}

const Alert = ({ children }: { children: ReactNode }) => <p role="alert" className="m-0 max-w-3xl rounded-card border border-destructive/40 bg-destructive/10 p-2 text-left">{children}</p>;

/** The "Open in a new browser tab" button; disabled with a reason while Studio is not running. */
export function OpenInNewTab({ url, primary = false }: { url: string | null; primary?: boolean }) {
  return (
    <Button variant={primary ? 'default' : 'outline'} size={primary ? 'default' : 'sm'} asChild={!!url} disabled={!url} title={url ? undefined : STUDIO_TEXT.openDisabled}>
      {url ? <a href={url} target="_blank" rel="noopener">{STUDIO_TEXT.openNewTab}<ExternalLink /></a> : <span>{STUDIO_TEXT.openNewTab}<ExternalLink /></span>}
    </Button>
  );
}

export interface StudioBodyProps {
  view: RemotionStudioDto | null;
  pane: StudioPaneState;
  /** Studio opened at the composition, or null while it is not running. */
  url: string | null;
  compositionId: string;
  setupPercent: number | null;
  busy: boolean;
  /** Sizing of the embedded frame. */
  frameClass: string;
  /** Replaces the default "waiting for setup" title. */
  waitingLabel?: string;
  onStart(): void;
}

/** What Studio shows for its state: the embedded frame, or the card that explains why there is none. Shared by the Remotion tab and the Video tab's live preview. */
export function StudioBody({ view, pane, url, compositionId, setupPercent, busy, frameClass, waitingLabel = STUDIO_TEXT.waiting, onStart }: StudioBodyProps) {
  const log = view?.log ?? [];
  return (
    <>
      {(pane === 'running' || pane === 'ro-running') && (
        <iframe title={`Remotion Studio: ${compositionId}`} src={url!} className={cn('block w-full rounded-card border border-border bg-background', frameClass)} />
      )}
      {pane === 'loading' && <Center><p className="m-0 text-muted-foreground">Loading…</p></Center>}
      {pane === 'waiting' && (
        <Center>
          <p className="m-0 font-medium">{waitingLabel}</p>
          <Bar percent={setupPercent} />
          <p className="m-0 max-w-xl text-muted-foreground">{STUDIO_TEXT.waitingDetail}</p>
        </Center>
      )}
      {pane === 'starting' && (
        <Center>
          <p className="m-0 font-medium">{STUDIO_TEXT.starting}</p>
          <Bar percent={null} />
          <Log lines={log} />
        </Center>
      )}
      {pane === 'failed' && (
        <Center>
          <Alert>{view?.error}</Alert>
          <Log lines={log} />
          <Button type="button" disabled={busy} onClick={onStart}>Retry</Button>
        </Center>
      )}
      {pane === 'stopped' && (
        <Center>
          <p className="m-0 font-medium">{STUDIO_TEXT.stopped}</p>
          <p className="m-0 max-w-xl text-muted-foreground">{STUDIO_TEXT.stoppedDetail}</p>
          <Button type="button" disabled={busy} onClick={onStart}>Start Studio</Button>
        </Center>
      )}
      {pane === 'fallback' && (
        <Center>
          <p className="m-0 font-medium">{STUDIO_TEXT.fallback}</p>
          <p className="m-0 max-w-xl text-muted-foreground">{STUDIO_TEXT.fallbackDetail} It runs at <span className="font-mono [overflow-wrap:anywhere]">{url}</span>.</p>
          <OpenInNewTab url={url} primary />
        </Center>
      )}
      {pane === 'ro-refused' && <Center><Alert>{STUDIO_TEXT.readOnlyRefused}</Alert></Center>}
    </>
  );
}

/** The Remotion tab: Studio for the Building's shared project, opened at this Concept's composition, at the tab's full width. */
export function RemotionTabView({ view, pane, compositionId, setupPercent, narrow, busy, error, onStart, onStop }: RemotionTabViewProps) {
  const url = compositionUrl(view?.state === 'running' ? view.url : null, compositionId);
  const controls = studioHeaderControls(pane, url);
  return (
    <section className="grid min-w-0 gap-3" aria-label={STUDIO_TEXT.title}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="m-0 flex flex-wrap items-center gap-2 text-base font-semibold">{STUDIO_TEXT.title}<span role="status" className="rounded-control border border-input px-2 py-0.5 text-xs font-medium">{studioChip(view, pane)}</span></h2>
          <p className="m-0 text-xs text-muted-foreground">Composition <code>{compositionId}</code> · {STUDIO_TEXT.shared}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <OpenInNewTab url={url} />
          {controls.showStop && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onStop}><Square />Stop</Button>}
        </div>
      </header>
      {narrow && <p className="m-0 text-xs text-muted-foreground">{STUDIO_TEXT.narrow}</p>}
      {(pane === 'ro-running' || pane === 'ro-refused') && <p role="status" className="m-0 rounded-card border border-info/40 bg-info/10 p-2 text-sm">{STUDIO_TEXT.readOnly}</p>}
      <ErrorNote message={error} />
      <StudioBody view={view} pane={pane} url={url} compositionId={compositionId} setupPercent={setupPercent} busy={busy} frameClass="h-[calc(100vh-300px)] min-h-[32rem]" onStart={onStart} />
    </section>
  );
}
