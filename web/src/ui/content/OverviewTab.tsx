import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { FORMATS_BY_PLATFORM, PLATFORMS, PLATFORM_LABELS } from '../../lib/contentRules';
import type { AssetKind, Platform } from '../../lib/contentRules';
import type { ConceptDto, PostDto } from '../../lib/contentTypes';
import { postActions } from '../../lib/contentStats';
import { assetLabel, controlsDisabled, formatLabel, missingMessage, READ_ONLY_TITLE } from '../../lib/contentView';
import { IMPORTED_HINT } from '../../lib/contentImport';
import { instantToLocalText, localTextToInstant } from '../../lib/contentZone';
import { useContentStore } from '../../store/contentStore';
import { ErrorNote } from '../crm/shared';
import { PublishDialog } from './PublishDialog';
import { conceptAssets } from '../../lib/contentThumbnail';
import { AssetStateLabel, PlatformIcon, StatusChip } from './shared';
import { StatsSection } from './StatsSection';
import { StatsSummaryLine } from './StatsView';
import { RelativeTime } from '../design/RelativeTime';
import { PostResultView } from './ResultViews';

/** A published post's link and published time, and the latest numbers with their change. */
export function PublishedInfo({ post, timeZone, now }: { post: PostDto; timeZone: string; now?: number }) {
  if (post.status !== 'published' || !post.publishedAt) return null;
  return (
    <div className="mt-1 grid gap-1 text-xs" aria-label="Published">
      <span className="flex flex-wrap items-center gap-x-2">
        <span className="text-muted-foreground">Published <RelativeTime at={post.publishedAt} timeZone={timeZone} now={now} /></span>
        {post.liveUrl && /^https?:\/\//i.test(post.liveUrl) && <a href={post.liveUrl} target="_blank" rel="noopener noreferrer" title={post.liveUrl} className="min-w-0 max-w-[28ch] truncate underline [overflow-wrap:anywhere]">{post.liveUrl}</a>}
      </span>
      <StatsSummaryLine platform={post.platform} stats={post.stats} timeZone={timeZone} now={now} />
      {post.result && <PostResultView platform={post.platform} result={post.result} timeZone={timeZone} now={now} />}
    </div>
  );
}

function PostRow({ projectId, concept, post, missing, timeZone, readOnly, onChanged, onOpenThumbnail }: { projectId: string; concept: ConceptDto; post: PostDto; missing: AssetKind[] | undefined; timeZone: string; readOnly: boolean; onChanged: () => void; onOpenThumbnail?: () => void }) {
  const { patchPost, deletePost, finalizePost, unfinalizePost, unpublishPost } = useContentStore.getState();
  const conceptId = concept.id;
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'publish' | 'edit' | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const can = postActions(post.status, concept.imported);
  const shownMissing = concept.imported ? undefined : missing;
  const disabled = controlsDisabled(readOnly);
  const run = async (work: () => Promise<{ ok: boolean; error?: string }>) => { const r = await work(); setError(r.ok ? null : (r.error ?? null)); if (r.ok) onChanged(); };
  return (
    <>
    <tr className="border-t border-border align-top">
      <td className="py-2 pr-3"><span className="inline-flex items-center gap-1.5"><PlatformIcon platform={post.platform} />{PLATFORM_LABELS[post.platform]}</span></td>
      <td className="py-2 pr-3">{formatLabel(post.format)}</td>
      <td className="py-2 pr-3">
        <Input type="datetime-local" aria-label={`${PLATFORM_LABELS[post.platform]} ${formatLabel(post.format)} date and time`} disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined}
          defaultValue={instantToLocalText(post.scheduledAt, timeZone)} key={post.scheduledAt}
          onBlur={(e) => { const at = localTextToInstant(e.target.value, timeZone); if (at && at !== post.scheduledAt) void run(() => patchPost(projectId, conceptId, post.id, at)); }} />
      </td>
      <td className="py-2 pr-3"><StatusChip status={post.status} /><PublishedInfo post={post} timeZone={timeZone} />{post.note && <p className="m-0 mt-1 text-xs text-muted-foreground">{post.note}</p>}</td>
      <td className="py-2 pr-3">
        <ul className="m-0 grid list-none gap-1 p-0">{post.needs.map((a) => <li key={a.id} className="flex items-center gap-2 text-xs"><span>{assetLabel(a.kind, post.platform)}</span><AssetStateLabel state={a.state} /></li>)}{post.externalAssets && <li className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Elsewhere: {post.externalAssets}</li>}</ul>
      </td>
      <td className="py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {can.finalize && <Button size="sm" disabled={disabled} onClick={() => run(() => finalizePost(projectId, conceptId, post.id))}>Finalize post</Button>}
          {can.publish && <Button size="sm" disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} onClick={() => setDialog('publish')}>Publish</Button>}
          {can.unfinalize && <Button size="sm" variant="outline" disabled={disabled} onClick={() => run(() => unfinalizePost(projectId, conceptId, post.id))}>Back to draft</Button>}
          {can.editPublish && <Button size="sm" variant="outline" disabled={disabled} onClick={() => setDialog('edit')}>Edit publish details</Button>}
          {can.addStats && <Button size="sm" variant="outline" aria-expanded={statsOpen} onClick={() => setStatsOpen(!statsOpen)}>Stats</Button>}
          {can.unpublish && (confirmUnpublish
            ? <span className="flex items-center gap-1" role="alertdialog" aria-label="Confirm unpublish">Unpublish?
                <Button size="sm" variant="destructive" disabled={disabled} onClick={() => run(async () => { const r = await unpublishPost(projectId, conceptId, post.id); setConfirmUnpublish(false); return r; })}>Unpublish</Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmUnpublish(false)}>Keep</Button></span>
            : <Button size="sm" variant="outline" disabled={disabled} onClick={() => setConfirmUnpublish(true)}>Unpublish</Button>)}
          <Button size="sm" variant="ghost" aria-label="Delete post" disabled={disabled || !can.delete} onClick={() => run(() => deletePost(projectId, conceptId, post.id))}><Trash2 /></Button>
        </div>
        {shownMissing && <p role="alert" className="m-0 mt-1 text-xs text-destructive">{missingMessage(shownMissing, post.platform)}</p>}
        {error && !shownMissing && <p role="alert" className="m-0 mt-1 text-xs text-destructive">{error}</p>}
        {dialog && <PublishDialog projectId={projectId} concept={concept} post={post} mode={dialog} timeZone={timeZone} readOnly={readOnly} onOpenThumbnail={onOpenThumbnail && (() => { setDialog(null); onOpenThumbnail(); })} onDone={() => { setDialog(null); onChanged(); }} onCancel={() => setDialog(null)} />}
      </td>
    </tr>
    {statsOpen && can.addStats && <tr className="bg-muted/30"><td colSpan={6} className="p-3"><StatsSection projectId={projectId} concept={concept} post={post} timeZone={timeZone} readOnly={readOnly} /></td></tr>}
    </>
  );
}

function AddPost({ projectId, conceptId, timeZone, disabled, onChanged }: { projectId: string; conceptId: string; timeZone: string; disabled: boolean; onChanged: () => void }) {
  const createPost = useContentStore((s) => s.createPost);
  const [platform, setPlatform] = useState<Platform>('linkedin');
  const [format, setFormat] = useState<string>(FORMATS_BY_PLATFORM.linkedin[0]!);
  const [at, setAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const scheduledAt = localTextToInstant(at, timeZone);
    if (!scheduledAt) { setError('Pick a date and time'); return; }
    const r = await createPost(projectId, conceptId, { platform, format, scheduledAt });
    setError(r.ok ? null : r.error);
    if (r.ok) onChanged();
  };
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Add post">
      <NativeSelect aria-label="Platform" value={platform} disabled={disabled} onChange={(e) => { const p = e.target.value as Platform; setPlatform(p); setFormat(FORMATS_BY_PLATFORM[p][0]!); }}>
        {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
      </NativeSelect>
      <NativeSelect aria-label="Format" value={format} disabled={disabled} onChange={(e) => setFormat(e.target.value)}>
        {FORMATS_BY_PLATFORM[platform].map((f) => <option key={f} value={f}>{formatLabel(f)}</option>)}
      </NativeSelect>
      <Input className="w-52" type="datetime-local" aria-label="New post date and time" value={at} disabled={disabled} onChange={(e) => setAt(e.target.value)} />
      <Button variant="outline" disabled={disabled} onClick={add}>Add post</Button>
      <ErrorNote message={error} />
    </div>
  );
}

/** The posts table with finalize and delete, add post, and the Concept-level assets (script, video). */
export function OverviewTab({ projectId, concept, missingByPost, timeZone, readOnly, onChanged, onOpenThumbnail }: { projectId: string; concept: ConceptDto; missingByPost: Record<string, AssetKind[]>; timeZone: string; readOnly: boolean; onChanged: () => void; onOpenThumbnail?: () => void }) {
  const disabled = controlsDisabled(readOnly);
  return (
    <div className="grid gap-5">
      <section className="grid gap-2" aria-label="Posts">
        <h3 className="m-0 text-base font-semibold">Posts <span className="text-sm font-normal text-muted-foreground">(times in {timeZone})</span></h3>
        {concept.posts.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead><tr className="text-xs text-muted-foreground"><th className="pb-1 pr-3 font-medium">Platform</th><th className="pb-1 pr-3 font-medium">Format</th><th className="pb-1 pr-3 font-medium">Date and time</th><th className="pb-1 pr-3 font-medium">Status</th><th className="pb-1 pr-3 font-medium">Needs</th><th className="pb-1 font-medium"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{concept.posts.map((p) => <PostRow key={p.id} projectId={projectId} concept={concept} post={p} missing={missingByPost[p.id]} timeZone={timeZone} readOnly={readOnly} onChanged={onChanged} onOpenThumbnail={onOpenThumbnail} />)}</tbody>
            </table>
          </div>
        ) : <p className="m-0 text-sm text-muted-foreground">{concept.imported ? 'No posts left.' : 'No posts yet. Add one below.'}</p>}
        {concept.imported
          ? <p className="m-0 text-xs text-muted-foreground">{IMPORTED_HINT}</p>
          : <AddPost projectId={projectId} conceptId={concept.id} timeZone={timeZone} disabled={disabled} onChanged={onChanged} />}
      </section>
      <section className="grid gap-2" aria-label="Concept assets">
        <h3 className="m-0 text-base font-semibold">Concept assets</h3>
        <ul className="m-0 grid list-none gap-1.5 p-0">{conceptAssets(concept).map((a) => (
          <li key={a.id} className="flex items-center gap-3 text-sm">
            {a.kind === 'thumbnail' && onOpenThumbnail ? <button type="button" className="w-16 text-left underline underline-offset-2" onClick={onOpenThumbnail}>{assetLabel(a.kind)}</button> : <span className="w-16">{assetLabel(a.kind)}</span>}
            {concept.imported && a.state !== 'finalized' ? <span className="text-xs text-muted-foreground">Not imported</span> : <AssetStateLabel state={a.state} />}
          </li>
        ))}</ul>
      </section>
    </div>
  );
}
