import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { contentApi } from '../../lib/contentApi';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { mediaFacts, renameError, splitMediaName, ZOOM_ACTUAL, ZOOM_BUTTON_STEP, ZOOM_WHEEL_STEP, zoomBy, zoomFit } from '../../lib/contentVideo';
import type { MediaDto, Zoom } from '../../lib/contentVideo';

export interface MediaPreviewProps {
  media: MediaDto;
  otherNames: string[];
  readOnly: boolean;
  /** Opens with the name field in edit mode (the ⋯ menu's Rename). */
  renaming?: boolean;
  /** The server's answer to the last save (a 409 name taken), shown under the field. */
  saveError?: string | null;
  busy?: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * An image with the zoom toolbar (−/+ ×1.25, wheel ×1.1, Fit, 100%, clamped 10% to 800%). The zoom is its own unless `zoom` and
 * `onZoom` are passed, so a caller can keep it while the image changes (the Images tab's previous / next).
 */
export function ZoomableImage({ src, alt, width, zoom: controlled, onZoom }: { src: string; alt: string; width: number | null; zoom?: Zoom; onZoom?: (zoom: Zoom) => void }) {
  const [own, setOwn] = useState<Zoom>(zoomFit(1));
  const zoom = controlled ?? own;
  const setZoom = (next: Zoom | ((z: Zoom) => Zoom)) => { const value = typeof next === 'function' ? next(zoom) : next; if (onZoom) onZoom(value); else setOwn(value); };
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-1" role="toolbar" aria-label="Zoom">
        <Button type="button" size="sm" variant="outline" aria-label="Zoom out" onClick={() => setZoom((z) => zoomBy(z, 1 / ZOOM_BUTTON_STEP))}><Minus /></Button>
        <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom.scale * 100)}%</span>
        <Button type="button" size="sm" variant="outline" aria-label="Zoom in" onClick={() => setZoom((z) => zoomBy(z, ZOOM_BUTTON_STEP))}><Plus /></Button>
        <Button type="button" size="sm" variant={zoom.mode === 'fit' ? 'default' : 'outline'} aria-pressed={zoom.mode === 'fit'} onClick={() => setZoom(zoomFit(1))}>Fit</Button>
        <Button type="button" size="sm" variant={zoom.mode === 'actual' ? 'default' : 'outline'} aria-pressed={zoom.mode === 'actual'} onClick={() => setZoom(ZOOM_ACTUAL)}>100%</Button>
      </div>
      {/* A zoomed image scrolls both ways: the stage stops centring once it is wider than the box. */}
      <div className={zoom.mode === 'fit' ? 'grid max-h-[60vh] min-h-40 min-w-0 place-items-center overflow-auto rounded-md bg-muted' : 'block max-h-[60vh] min-h-40 min-w-0 overflow-auto rounded-md bg-muted'} onWheel={(e) => setZoom((z) => zoomBy(z, e.deltaY < 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP))}>
        <img
          src={src} alt={alt}
          className={zoom.mode === 'fit' ? 'max-h-[60vh] max-w-full object-contain' : 'max-w-none'}
          style={zoom.mode === 'fit' ? undefined : { width: width ? width * zoom.scale : undefined, transform: width ? undefined : `scale(${zoom.scale})` }}
        />
      </div>
    </div>
  );
}

const ImageView = ({ media }: { media: MediaDto }) => <ZoomableImage src={contentApi.assetUrl(media.fileUrl)} alt={media.name} width={media.width} />;

/** The name field: the base is editable, the extension is a fixed suffix, errors show as you type. */
export function RenameField({ media, otherNames, saveError, busy, onSave, onCancel }: { media: MediaDto; otherNames: string[]; saveError?: string | null; busy?: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const { base, ext } = splitMediaName(media.name);
  const [value, setValue] = useState(base);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const error = renameError(value, ext, otherNames);
  const unchanged = `${value.trim()}${ext}` === media.name;
  return (
    <form className="grid gap-1" onSubmit={(e) => { e.preventDefault(); if (!error && !unchanged) onSave(`${value.trim()}${ext}`); }}>
      <div className="flex items-center gap-1">
        <Input ref={field} aria-label="File name" value={value} aria-invalid={!!error} onChange={(e) => setValue(e.target.value)} />
        <span className="text-sm text-muted-foreground" aria-label="Extension">{ext}</span>
      </div>
      {(error ?? saveError) && <p role="alert" className="m-0 text-xs text-destructive">{error ?? saveError}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!!error || unchanged || busy}>Save</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** Everything in the popup under its title, kept apart so it renders without a dialog around it. */
export function MediaPreviewBody({ media, otherNames, readOnly, renaming = false, saveError, busy, onRename, onDelete, onClose }: MediaPreviewProps) {
  const [editing, setEditing] = useState(renaming && !readOnly);
  return (
    <div className="grid gap-3">
      {media.kind === 'image' && <ImageView media={media} />}
      {media.kind === 'video' && <video controls src={contentApi.assetUrl(media.fileUrl)} className="max-h-[60vh] w-full rounded-md bg-muted" />}
      {media.kind === 'audio' && (
        <div className="grid gap-1">
          <audio controls src={contentApi.assetUrl(media.fileUrl)} className="w-full" />
          {media.durationMs === null && <p className="m-0 text-xs text-muted-foreground">The length shows once the file is read.</p>}
        </div>
      )}
      {editing && <RenameField media={media} otherNames={otherNames} saveError={saveError} busy={busy} onSave={onRename} onCancel={() => setEditing(false)} />}
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="outline" className="text-destructive" disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={onDelete}>Delete…</Button>
        <div className="flex gap-2">
          {!editing && <Button type="button" variant="outline" disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={() => setEditing(true)}>Rename</Button>}
          <Button variant="outline" asChild><a href={contentApi.assetUrl(media.fileUrl)} download={media.name}>Download</a></Button>
          <Button type="button" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

/** A media file in a popup: zoomable image, playable video or audio, the name the agent sees (rename), and Delete. */
export function MediaPreviewDialog(props: MediaPreviewProps) {
  const { media, onClose } = props;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="break-all pr-6">{media.name}</DialogTitle>
          <DialogDescription>{mediaFacts(media)} · <code className="break-all">{media.path}</code></DialogDescription>
        </DialogHeader>
        <MediaPreviewBody {...props} />
      </DialogContent>
    </Dialog>
  );
}
