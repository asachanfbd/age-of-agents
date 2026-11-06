import { useRef } from 'react';
import { Film, Image as ImageIcon, MoreHorizontal, Music, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { contentApi } from '../../lib/contentApi';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { dropText, droppedFiles, formatDuration, MEDIA_ACCEPT, mediaDropHandlers, mediaFooter, orderMedia, uploadProgressText } from '../../lib/contentVideo';
import type { MediaDto, MediaKind, UploadRow } from '../../lib/contentVideo';

const KIND_ICON: Record<MediaKind, typeof Film> = { video: Film, image: ImageIcon, audio: Music };

export interface MediaColumnProps {
  media: MediaDto[];
  uploads: UploadRow[];
  readOnly: boolean;
  /** How many files are dragged over the media column, or null when none. */
  dragCount: number | null;
  onDragCount: (count: number | null) => void;
  onFiles: (files: File[]) => void;
  onOpen: (media: MediaDto, rename?: boolean) => void;
  onDelete: (media: MediaDto) => void;
  onCancelUpload: (key: string) => void;
}

function Thumb({ media }: { media: MediaDto }) {
  const Icon = KIND_ICON[media.kind];
  const duration = formatDuration(media.durationMs);
  return (
    <div className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-md bg-muted shadow-[inset_0_0_0_1px_var(--border)]">
      {media.thumbnailUrl
        ? <img src={contentApi.assetUrl(media.thumbnailUrl)} alt="" loading="lazy" className="size-full object-cover" />
        : <Icon aria-hidden className="size-5 text-muted-foreground" />}
      {duration && <span className="absolute bottom-1 right-1 rounded bg-foreground/70 px-1 text-[10px] tabular-nums text-background">{duration}</span>}
    </div>
  );
}

/** The left column: drop zone and file picker, uploads in flight, then the Concept's media newest first. Open at every state of the tab. */
export function MediaColumn({ media, uploads, readOnly, dragCount, onDragCount, onFiles, onOpen, onDelete, onCancelUpload }: MediaColumnProps) {
  const picker = useRef<HTMLInputElement>(null);
  const files = orderMedia(media);
  const over = !readOnly && dragCount !== null;
  const take = (list: FileList | null) => { const picked = droppedFiles(list, readOnly); if (picked.length) onFiles(picked); };
  return (
    <aside
      className={cn('flex min-h-0 min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-2', over && 'border-primary bg-primary/10')}
      aria-label="Media"
      data-over={over || undefined}
      {...mediaDropHandlers({ readOnly, onDragCount, onFiles })}
    >
      <div
        aria-label="Drop zone"
        data-over={over || undefined}
        className={cn('grid place-items-center gap-1.5 rounded-md border border-dashed border-border p-2 text-center text-xs text-muted-foreground', over && 'border-primary bg-primary/10 text-foreground')}
      >
        <Upload aria-hidden className="size-4" />
        <span>{readOnly ? 'Read-only' : over ? <b>{dropText(dragCount)}</b> : 'Drop files here'}</span>
        <Button type="button" size="sm" variant="outline" disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={() => picker.current?.click()}>Add files</Button>
        <input ref={picker} type="file" multiple accept={MEDIA_ACCEPT} className="hidden" aria-label="Choose media files" onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      </div>
      <ul className="m-0 grid min-h-0 flex-1 list-none content-start gap-2 overflow-y-auto p-0" aria-label="Media files">
        {uploads.map((u) => u.status === 'error' ? (
          <li key={u.key} role="alert" className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-1.5 text-xs">
            <b className="line-clamp-2 break-all" title={u.name}>{u.name}</b>
            <span>{u.error}</span>
            <button type="button" className="justify-self-start text-primary underline" onClick={() => onCancelUpload(u.key)}>Dismiss</button>
          </li>
        ) : (
          <li key={u.key} aria-label={`Uploading ${u.name}`} className="grid gap-1 text-xs">
            <span className="line-clamp-2 break-all" title={u.name}>{u.name}</span>
            <div className="h-1 overflow-hidden rounded bg-muted"><i className="block h-full bg-primary" style={{ width: `${u.size ? Math.floor((u.loaded / u.size) * 100) : 0}%` }} /></div>
            <span className="text-muted-foreground">{uploadProgressText(u)}</span>
            <button type="button" className="justify-self-start text-primary underline" onClick={() => onCancelUpload(u.key)}>Cancel</button>
          </li>
        ))}
        {!files.length && !uploads.length && <li className="text-xs text-muted-foreground">No media yet. Drop clips, photos, logos or music here. The agent sees them too.</li>}
        {files.map((m) => (
          <li key={m.id} className="group relative grid gap-1" title={m.name}>
            <button type="button" className="grid gap-1 text-left text-xs" aria-label={`${m.name}${m.durationMs !== null ? `, ${formatDuration(m.durationMs)}` : ''}`} onClick={() => onOpen(m)}>
              <Thumb media={m} />
              <span className="line-clamp-2 break-all">{m.name}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`Actions for ${m.name}`} className="absolute right-1 top-1 rounded bg-background/80 p-0.5"><MoreHorizontal className="size-3.5" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onOpen(m)}>Preview</DropdownMenuItem>
                <DropdownMenuItem disabled={readOnly} onSelect={() => onOpen(m, true)}>Rename…</DropdownMenuItem>
                <DropdownMenuItem disabled={readOnly} className="text-destructive" onSelect={() => onDelete(m)}>Delete…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[11px] text-muted-foreground">{mediaFooter(media)}</p>
    </aside>
  );
}
