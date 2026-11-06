import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PLATFORM_LABELS } from '../../lib/contentRules';
import { contentApi } from '../../lib/contentApi';
import { checkPublishForm, LIVE_URL_MAX } from '../../lib/contentStats';
import type { ConceptDto, PostDto, PostMediaDto } from '../../lib/contentTypes';
import { isVideoPost, THUMBNAIL_NOT_FINALIZED_HINT } from '../../lib/contentThumbnail';
import { formatLabel } from '../../lib/contentView';
import { instantToLocalText, localTextToInstant } from '../../lib/contentZone';
import { useContentStore } from '../../store/contentStore';
import { ErrorNote } from '../crm/shared';
import { copyToClipboard } from './StudioPaneView';
import { PlatformIcon } from './shared';

export interface PublishFormProps {
  post: PostDto;
  /** An imported post never needs a thumbnail, so the dialog does not ask for one. */
  imported?: boolean;
  /** The dialog's title block; the dialog supplies Radix's title and description, a bare render gets plain text. */
  heading?: ReactNode;
  /** `publish` marks a finalized post as published; `edit` changes a published post's URL and time. */
  mode: 'publish' | 'edit';
  media: PostMediaDto | null;
  /** Opens the Concept's Thumbnail tab (closing the dialog); left out, the hint has no link. */
  onOpenThumbnail?: () => void;
  urls: { image: (index: number) => string; zip: string; video: string; thumbnail: string };
  timeZone: string;
  url: string;
  at: string;
  errors: Record<string, string>;
  error: string | null;
  pending: boolean;
  readOnly: boolean;
  onUrl: (value: string) => void;
  onAt: (value: string) => void;
  onCopy: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

const MISSING = 'File missing';
const titleOf = (mode: PublishFormProps['mode']) => (mode === 'publish' ? 'Publish' : 'Edit publish details');
const describe = (post: PostDto) => <><PlatformIcon platform={post.platform} />{PLATFORM_LABELS[post.platform]} · {formatLabel(post.format)}</>;
const PlainHeading = ({ post, mode }: Pick<PublishFormProps, 'post' | 'mode'>) => <header className="grid gap-1.5"><h2 className="m-0 text-lg font-semibold">{titleOf(mode)}</h2><p className="m-0 flex items-center gap-1.5 text-sm text-muted-foreground">{describe(post)}</p></header>;

/** One downloadable file (the video, the thumbnail): its name, then Download, or "File missing" when it is gone. */
function FileSection({ label, file, href }: { label: string; file: { name: string; missing: boolean }; href: string }) {
  return (
    <section className="grid gap-1.5" aria-label={label}>
      <h4 className="m-0 text-sm font-medium">{label}</h4>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">{file.name}</span>
        {file.missing ? <span className="text-xs text-destructive">{MISSING}</span> : <a className="inline-flex items-center gap-1 underline" href={href} download aria-label={`Download ${file.name}`}><Download className="size-3.5" />Download</a>}
      </div>
    </section>
  );
}

/** Everything needed to post by hand: the text with Copy, the media (images, video, thumbnail) to download, the platform and format, and the URL and time to record. */
export function PublishForm({ onOpenThumbnail, imported = false, post, heading, mode, media, urls, timeZone, url, at, errors, error, pending, readOnly, onUrl, onAt, onCopy, onSubmit, onCancel }: PublishFormProps) {
  const publishing = mode === 'publish';
  const images = media?.images ?? null;
  return (
    <form className="grid gap-4" aria-label={publishing ? 'Publish post' : 'Edit publish details'} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      {heading ?? <PlainHeading post={post} mode={mode} />}
      {publishing && (
        <div className="grid max-h-[40vh] gap-4 overflow-y-auto pr-1">
          {media?.text != null && (
            <section className="grid gap-1.5" aria-label="Text">
              <div className="flex items-center justify-between gap-2"><h4 className="m-0 text-sm font-medium">Text</h4><Button type="button" size="sm" variant="outline" onClick={() => onCopy(media.text!)}>Copy</Button></div>
              <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-card border border-border p-3 font-sans text-sm" data-text>{media.text}</pre>
            </section>
          )}
          {images && (
            <section className="grid gap-1.5" aria-label="Images">
              <div className="flex items-center justify-between gap-2">
                <h4 className="m-0 text-sm font-medium">Images</h4>
                <Button asChild type="button" size="sm" variant="outline"><a href={urls.zip} download>Download all (zip)</a></Button>
              </div>
              <ul className="m-0 grid list-none gap-1.5 p-0">
                {images.map((i) => (
                  <li key={i.index} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{i.name}</span>
                    {i.missing ? <span className="text-xs text-destructive">{MISSING}</span> : <a className="inline-flex items-center gap-1 underline" href={urls.image(i.index)} download aria-label={`Download ${i.name}`}><Download className="size-3.5" />Download</a>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {media?.video && <FileSection label="Video" file={media.video} href={urls.video} />}
          {media?.thumbnail && <FileSection label="Thumbnail" file={media.thumbnail} href={urls.thumbnail} />}
          {media && !media.thumbnail && isVideoPost(post) && !imported && <p className="m-0 text-xs text-muted-foreground" data-thumbnail-hint>{THUMBNAIL_NOT_FINALIZED_HINT}{onOpenThumbnail && <> <button type="button" className="underline underline-offset-2" onClick={onOpenThumbnail}>Open the Thumbnail tab</button></>}</p>}
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="publish-url">Live post URL <span className="text-muted-foreground">(optional, up to {LIVE_URL_MAX.toLocaleString('en-US')} characters)</span></Label>
        <Input id="publish-url" type="url" value={url} aria-invalid={errors.liveUrl ? true : undefined} disabled={readOnly} onChange={(e) => onUrl(e.target.value)} />
        {errors.liveUrl && <p role="alert" className="m-0 text-xs text-destructive">{errors.liveUrl}</p>}
        <Label htmlFor="publish-at">Published at <span className="text-muted-foreground">(in {timeZone})</span></Label>
        <Input id="publish-at" type="datetime-local" value={at} aria-invalid={errors.publishedAt ? true : undefined} disabled={readOnly} onChange={(e) => onAt(e.target.value)} />
        {errors.publishedAt && <p role="alert" className="m-0 text-xs text-destructive">{errors.publishedAt}</p>}
      </div>
      <ErrorNote message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" disabled={pending || readOnly}>{pending ? 'Saving…' : publishing ? 'Mark as published' : 'Save'}</Button>
      </DialogFooter>
    </form>
  );
}

/** The Publish dialog of one post: loads what the post hands over and records the publish. */
export function PublishDialog({ projectId, concept, post, mode, timeZone, readOnly, onDone, onCancel, onOpenThumbnail }: { projectId: string; concept: ConceptDto; post: PostDto; mode: 'publish' | 'edit'; timeZone: string; readOnly: boolean; onDone: () => void; onCancel: () => void; onOpenThumbnail?: () => void }) {
  const media = useContentStore((s) => s.mediaByPost[post.id]) ?? null;
  const { loadMedia, publishPost, editPublish } = useContentStore.getState();
  const [url, setUrl] = useState(post.liveUrl ?? '');
  const [at, setAt] = useState(() => instantToLocalText(mode === 'edit' && post.publishedAt ? post.publishedAt : Date.now(), timeZone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { if (mode === 'publish') void loadMedia(projectId, concept.id, post.id).then((r) => setError(r.ok ? null : r.error)); }, [mode, projectId, concept.id, post.id, loadMedia]);
  const submit = async () => {
    const publishedAt = localTextToInstant(at, timeZone);
    const check = checkPublishForm(url, publishedAt, Date.now());
    setErrors(check.errors);
    if (!check.ok) return;
    setPending(true);
    const body = { liveUrl: url.trim() || null, publishedAt: publishedAt! };
    const result = await (mode === 'publish' ? publishPost : editPublish)(projectId, concept.id, post.id, body);
    setPending(false);
    if (result.ok) { onDone(); return; }
    setError(result.error);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent className="sm:max-w-[640px]">
        <PublishForm
          post={post} mode={mode}
          heading={<DialogHeader><DialogTitle>{titleOf(mode)}</DialogTitle><DialogDescription className="flex items-center gap-1.5">{describe(post)}</DialogDescription></DialogHeader>} media={media} timeZone={timeZone} url={url} at={at} errors={errors} error={error} pending={pending} readOnly={readOnly}
          urls={{ image: (i) => contentApi.imageUrl(projectId, concept.id, post.id, i), zip: contentApi.imagesZipUrl(projectId, concept.id, post.id), video: contentApi.videoUrl(projectId, concept.id, post.id), thumbnail: contentApi.thumbnailUrl(projectId, concept.id, post.id) }}
          onUrl={setUrl} onAt={setAt} onCopy={(text) => void copyToClipboard(text)} onSubmit={() => void submit()} onCancel={onCancel} onOpenThumbnail={onOpenThumbnail} imported={concept.imported}
        />
      </DialogContent>
    </Dialog>
  );
}
