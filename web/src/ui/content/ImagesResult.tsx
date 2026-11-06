import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { contentApi } from '../../lib/contentApi';
import {
  altCopyText, altFor, altLines, EMPTY_IMAGES_TEXT, failedText, gallerySlots, imagesState, NO_ALT_TEXT, previewFacts, previewNav, previousImageRounds, queuedImagesText,
  renderingDetail, renderingText, shownRound, sizeLine, stepPreview, tileCaption,
} from '../../lib/contentImages';
import type { GallerySlot, ImageFileDto, ImageRoundDto } from '../../lib/contentImages';
import type { StudioViewDto } from '../../lib/contentStudio';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { zoomFit } from '../../lib/contentVideo';
import type { Zoom } from '../../lib/contentVideo';
import { RelativeTime } from '../design/RelativeTime';
import { ZoomableImage } from './MediaPreviewDialog';
import { CopyButton } from './StudioPaneView';

/** The image open in the preview: its round and its position among that round's images. */
export interface PreviewTarget { round: number; position: number }

const imagesOf = (view: StudioViewDto, round: number): ImageFileDto[] => view.images?.rounds.find((r) => r.round === round)?.images ?? [];

function Tile({ slot, onOpen }: { slot: GallerySlot; onOpen: () => void }) {
  const image = slot.image;
  const ratio = image ? `${image.width} / ${image.height}` : '4 / 5';
  return (
    <li className="grid min-w-0 gap-1" data-slot={slot.kind} data-index={slot.index}>
      <div className="relative overflow-hidden rounded-md border border-border bg-muted" style={{ aspectRatio: ratio }}>
        {image
          ? (
            <button type="button" className="block size-full cursor-zoom-in" aria-label={`Open image ${slot.index}`} onClick={onOpen}>
              <img src={contentApi.assetUrl(image.url)} alt={`Image ${slot.index}`} loading="lazy" className="size-full object-cover motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out" />
            </button>
          )
          : (
            <span className={cn('grid size-full place-items-center text-xs text-muted-foreground', slot.kind === 'rendering' && 'ring-2 ring-inset ring-primary', slot.kind === 'waiting' && 'bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,var(--border)_6px,var(--border)_7px)]')}>
              {slot.kind === 'rendering' ? 'Rendering…' : slot.kind === 'waiting' ? 'Waiting' : 'Not made'}
            </span>
          )}
        <span className="absolute right-1 top-1 rounded-full bg-card/90 px-1.5 text-[11px] font-medium tabular-nums" aria-hidden="true">{slot.index}</span>
      </div>
      {image && (
        <div className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{tileCaption(image)}</span>
          <a href={contentApi.assetUrl(image.downloadUrl)} aria-label={`Download image ${slot.index}`} title={`Download image ${slot.index}`}><Download className="size-3.5" /></a>
        </div>
      )}
    </li>
  );
}

export function AltText({ lines, count }: { lines: string[]; count: number }) {
  if (!count) return null;
  return (
    <div className="grid gap-1" aria-label="Alt text">
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-xs font-medium">Alt text</p>
        {lines.length > 0 && <CopyButton text={altCopyText(lines.slice(0, count))} label="Copy alt text" />}
      </div>
      <ol className="m-0 grid list-decimal gap-0.5 pl-5 text-xs">
        {Array.from({ length: count }, (_, i) => {
          const line = altFor(lines, i + 1);
          return <li key={i} className="[overflow-wrap:anywhere]">{line ?? <i className="text-muted-foreground">{NO_ALT_TEXT}</i>}</li>;
        })}
      </ol>
    </div>
  );
}

/** The large preview: zoom, previous and next (← / →, no wrap, the zoom mode kept), the image's alt text, Download PNG. */
export function ImagePreviewBody({ view, target, onTarget, onClose, noun = 'image' }: { view: StudioViewDto; target: PreviewTarget; onTarget: (t: PreviewTarget) => void; onClose: () => void; noun?: string }) {
  const images = imagesOf(view, target.round);
  const image = images[target.position - 1];
  const [zoom, setZoom] = useState<Zoom>(zoomFit(1));
  const nav = previewNav(target.position, images.length, noun);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = stepPreview(target.position, images.length, e.key);
      if (next !== target.position) onTarget({ ...target, position: next });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, images.length, onTarget]);
  if (!image) return null;
  const alt = altFor(altLines(view, target.round), image.index);
  const old = target.round < Math.max(view.asset.round, 1);
  return (
    <div className="grid min-w-0 gap-3">
      {old && <p role="status" className="m-0 text-xs text-muted-foreground">From round {target.round}. Read-only: earlier rounds are kept for reference.</p>}
      <div className="flex min-w-0 items-center gap-2">
        {!nav.single && <Button type="button" variant="outline" size="icon" aria-label={`Previous ${noun}`} disabled={!nav.hasPrevious} onClick={() => onTarget({ ...target, position: target.position - 1 })}><ChevronLeft /></Button>}
        <div className="min-w-0 flex-1"><ZoomableImage src={contentApi.assetUrl(image.url)} alt={alt ?? `${noun[0].toUpperCase()}${noun.slice(1)} ${image.index}`} width={image.width} zoom={zoom} onZoom={setZoom} /></div>
        {!nav.single && <Button type="button" variant="outline" size="icon" aria-label={`Next ${noun}`} disabled={!nav.hasNext} onClick={() => onTarget({ ...target, position: target.position + 1 })}><ChevronRight /></Button>}
      </div>
      {!nav.single && <p className="m-0 text-xs text-muted-foreground">{`Use ← and → to move between ${noun}s.`}</p>}
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-2"><p className="m-0 text-xs font-medium">Alt text</p>{alt && <CopyButton text={alt} />}</div>
        <p className="m-0 text-sm [overflow-wrap:anywhere]">{alt ?? <i className="text-muted-foreground">{NO_ALT_TEXT}</i>}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" asChild><a href={contentApi.assetUrl(image.downloadUrl)}><Download />Download PNG</a></Button>
        <Button type="button" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

export function ImagePreviewDialog(props: { view: StudioViewDto; target: PreviewTarget; onTarget: (t: PreviewTarget) => void; onClose: () => void; noun?: string }) {
  const images = imagesOf(props.view, props.target.round);
  const image = images[props.target.position - 1];
  if (!image) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>{previewNav(props.target.position, images.length, props.noun).title}</DialogTitle>
          <DialogDescription className="break-all">{previewFacts(image)}</DialogDescription>
        </DialogHeader>
        <ImagePreviewBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

export interface ImagesResultProps {
  view: StudioViewDto | null;
  readOnly: boolean;
  busy: boolean;
  onStop: (renderId: string) => void;
  onOpen: (target: PreviewTarget) => void;
  now?: number;
}

/** The right half of the Images pane: the current round's gallery with its render status, downloads and alt text. */
export function ImagesResult({ view, readOnly, busy, onStop, onOpen, now }: ImagesResultProps) {
  const state = imagesState(view);
  const round = view ? shownRound(view) : null;
  const call = round?.call ?? null;
  const slots = gallerySlots(round);
  const line = view ? sizeLine(view) : null;
  const done = slots.filter((s) => s.image);
  return (
    <section className="grid min-w-0 content-start gap-3" aria-label="Images" data-state={state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-medium">
          {state === 'finalized' && view ? <>Finalized <RelativeTime at={view.asset.finalizedAt ?? ''} now={now} /></> : view ? `Images · round ${Math.max(view.asset.round, 1)}` : 'Images'}
        </h3>
        {round?.zipUrl && <Button variant="outline" size="sm" asChild><a href={contentApi.assetUrl(round.zipUrl)}><Download />Download all (.zip)</a></Button>}
      </div>
      {line && <p className="m-0 text-xs text-muted-foreground" data-size-line>{line}</p>}
      {call && (call.status === 'running' || call.status === 'queued') && (
        <div role="status" className="grid gap-1.5 rounded-md border border-border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <b>{call.status === 'running' ? renderingText(call) : 'Image render is queued'}</b>
            <Button type="button" size="sm" variant="outline" disabled={readOnly || busy} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={() => onStop(call.id)}><Square />Stop</Button>
          </div>
          {call.status === 'running'
            ? <>
                <div className="h-1.5 w-full overflow-hidden rounded bg-muted"><i className="block h-full bg-primary" style={{ width: `${Math.round((call.done / call.total) * 100)}%` }} /></div>
                <span className="flex justify-between gap-2 text-muted-foreground"><span>{renderingDetail(call)}</span><RelativeTime at={call.createdAt} now={now} /></span>
              </>
            : <p className="m-0 text-muted-foreground">{queuedImagesText(call)}</p>}
        </div>
      )}
      {call && (call.status === 'failed' || call.status === 'stopped') && (
        <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs [overflow-wrap:anywhere]">{failedText(call)} The images that were made stay; the agent got this answer too.</p>
      )}
      {slots.length
        ? <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3 p-0" aria-label="Gallery">
            {slots.map((slot) => <Tile key={slot.index} slot={slot} onOpen={() => view && onOpen({ round: round!.round, position: done.findIndex((d) => d.index === slot.index) + 1 })} />)}
          </ul>
        : <p className="m-0 rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-result>{EMPTY_IMAGES_TEXT}</p>}
      {view && <AltText lines={altLines(view)} count={done.length} />}
    </section>
  );
}

/** Earlier rounds' images, collapsed, read-only (preview and download still work). */
export function PreviousImageRounds({ view, onOpen }: { view: StudioViewDto; onOpen: (target: PreviewTarget) => void }) {
  const rounds: ImageRoundDto[] = previousImageRounds(view);
  if (!rounds.length) return null;
  return (
    <details className="rounded-card border border-border p-3" aria-label="Previous rounds">
      <summary className="cursor-pointer text-sm font-medium">Previous rounds ({rounds.length})</summary>
      <div className="mt-3 grid gap-3">
        {rounds.map((r) => (
          <div key={r.round} className="grid gap-1" data-round={r.round}>
            <div className="flex items-center justify-between gap-2">
              <b className="text-sm">Round {r.round} · {r.images.length} {r.images.length === 1 ? 'image' : 'images'}</b>
              {r.zipUrl && <a className="text-xs underline" href={contentApi.assetUrl(r.zipUrl)}>Download all (.zip)</a>}
            </div>
            <ul className="m-0 flex list-none gap-2 overflow-x-auto p-0">
              {r.images.map((image, i) => (
                <li key={image.name} className="w-16 flex-none">
                  <button type="button" className="block w-full overflow-hidden rounded border border-border" style={{ aspectRatio: `${image.width} / ${image.height}` }} aria-label={`Open round ${r.round} image ${image.index}`} onClick={() => onOpen({ round: r.round, position: i + 1 })}>
                    <img src={contentApi.assetUrl(image.url)} alt={`Round ${r.round} image ${image.index}`} loading="lazy" className="size-full object-cover" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="m-0 text-xs text-muted-foreground">Read-only. Earlier rounds' still code is archived; later rounds do not use it.</p>
      </div>
    </details>
  );
}
