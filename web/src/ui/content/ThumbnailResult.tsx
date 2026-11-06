import { Download, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { contentApi } from '../../lib/contentApi';
import { altLines, failedText, gallerySlots, queuedImagesText, renderingDetail, shownRound } from '../../lib/contentImages';
import type { GallerySlot, ImageFileDto } from '../../lib/contentImages';
import type { StudioViewDto } from '../../lib/contentStudio';
import {
  EMPTY_THUMBNAILS_TEXT, renderingThumbnailText, sizeCaption, thumbnailAsImages, thumbnailSizeLine, thumbnailState, THUMBNAIL_FAILED_NOTE, tileRatio,
} from '../../lib/contentThumbnail';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { RelativeTime } from '../design/RelativeTime';
import { AltText } from './ImagesResult';
import type { PreviewTarget } from './ImagesResult';

interface TileProps { slot: GallerySlot; chosen: boolean; final?: boolean; onChoose?: () => void; onOpen: () => void }

/** One variant: open the preview, its size, Download, and the "Use this one" choice (radio-like) kept apart from the open target. */
function Tile({ slot, chosen, final = false, onChoose, onOpen }: TileProps) {
  const file: ImageFileDto | null = slot.image;
  return (
    <li className="grid min-w-0 gap-1.5" data-slot={slot.kind} data-index={slot.index}>
      <div className={cn('relative overflow-hidden rounded-md border bg-muted', chosen ? 'border-primary ring-2 ring-primary' : 'border-border')} style={{ aspectRatio: file ? tileRatio(file) : '16 / 9' }}>
        {file
          ? (
            <button type="button" className="block size-full cursor-zoom-in" aria-label={`Open thumbnail ${slot.index}`} onClick={onOpen}>
              <img src={contentApi.assetUrl(file.url)} alt={`Thumbnail ${slot.index}`} loading="lazy" className="size-full object-cover motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out" />
            </button>
          )
          : (
            <span className={cn('grid size-full place-items-center text-xs text-muted-foreground', slot.kind === 'rendering' && 'ring-2 ring-inset ring-primary', slot.kind === 'waiting' && 'bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,var(--border)_6px,var(--border)_7px)]')}>
              {slot.kind === 'rendering' ? 'Rendering…' : slot.kind === 'waiting' ? 'Waiting' : 'Not made'}
            </span>
          )}
        <span className="absolute right-1 top-1 rounded-full bg-card/90 px-1.5 text-[11px] font-medium tabular-nums" aria-hidden="true">{slot.index}</span>
      </div>
      {file && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{sizeCaption(file)}</span>
          <a className="inline-flex items-center gap-1 underline" href={contentApi.assetUrl(file.downloadUrl)} aria-label={`Download thumbnail ${slot.index}`}><Download className="size-3.5" />Download</a>
        </div>
      )}
      {file && (final
        ? <p className="m-0 text-xs font-medium text-primary" data-final>Final choice</p>
        : <button type="button" role="radio" aria-checked={chosen} disabled={!onChoose} onClick={onChoose} className={cn('rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-60', chosen ? 'border-primary bg-primary/10 text-primary' : 'border-border')}>{chosen ? 'Final choice' : 'Use this one'}</button>)}
    </li>
  );
}

export interface ThumbnailResultProps {
  view: StudioViewDto | null;
  /** The picked file name (see `effectiveChoice`). */
  chosen: string | null;
  onChoose: (name: string) => void;
  readOnly: boolean;
  busy: boolean;
  onStop: (renderId: string) => void;
  onOpen: (target: PreviewTarget) => void;
  now?: number;
}

/** The right half of the Thumbnail pane: the round's variants at their real aspect ratio, render status, choice and alt text; the final one once finalized. */
export function ThumbnailResult({ view, chosen, onChoose, readOnly, busy, onStop, onOpen, now }: ThumbnailResultProps) {
  const state = thumbnailState(view);
  const adapted = thumbnailAsImages(view);
  const round = adapted ? shownRound(adapted) : null;
  const call = round?.call ?? null;
  const slots = gallerySlots(round);
  const done = slots.filter((s) => s.image);
  const final = view?.thumbnail?.final ?? null;
  const finalSlot = final && done.find((s) => s.image!.name === final.name);
  const line = view && !final ? thumbnailSizeLine(view) : null;
  const positionOf = (slot: GallerySlot) => done.findIndex((d) => d.index === slot.index) + 1;
  return (
    <section className="grid min-w-0 content-start gap-3" aria-label="Thumbnails" data-state={state}>
      <h3 className="m-0 text-sm font-medium">
        {state === 'finalized' && view ? <>Finalized <RelativeTime at={view.asset.finalizedAt ?? ''} now={now} /></> : view ? `Thumbnails · round ${Math.max(view.asset.round, 1)}` : 'Thumbnails'}
      </h3>
      {line && <p className="m-0 text-xs text-muted-foreground" data-size-line>{line}</p>}
      {call && (call.status === 'running' || call.status === 'queued') && (
        <div role="status" className="grid gap-1.5 rounded-md border border-border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <b>{call.status === 'running' ? renderingThumbnailText(call) : 'Thumbnail render is queued'}</b>
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
        <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs [overflow-wrap:anywhere]">{failedText(call, 'thumbnail')} {THUMBNAIL_FAILED_NOTE}</p>
      )}
      {final
        ? (finalSlot
          ? <ul className="m-0 grid max-w-3xl list-none gap-3 p-0" aria-label="Final thumbnail"><Tile slot={finalSlot} chosen final onOpen={() => onOpen({ round: final.round, position: positionOf(finalSlot) })} /></ul>
          : <p className="m-0 rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-result>{EMPTY_THUMBNAILS_TEXT}</p>)
        : slots.length
          ? <ul role="radiogroup" aria-label="Choose the final thumbnail" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-0">
              {slots.map((slot) => <Tile key={slot.index} slot={slot} chosen={slot.image?.name === chosen} onChoose={readOnly || !slot.image ? undefined : () => onChoose(slot.image!.name)} onOpen={() => onOpen({ round: round!.round, position: positionOf(slot) })} />)}
            </ul>
          : <p className="m-0 rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-result>{EMPTY_THUMBNAILS_TEXT}</p>}
      {adapted && <AltText lines={altLines(adapted)} count={done.length} />}
    </section>
  );
}
