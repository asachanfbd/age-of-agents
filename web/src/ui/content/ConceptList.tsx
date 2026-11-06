import { useEffect, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { PLATFORMS, PLATFORM_LABELS, POST_STATUSES } from '../../lib/contentRules';
import type { Platform, PostStatus } from '../../lib/contentRules';
import type { ConceptDto, ConceptPageDto } from '../../lib/contentTypes';
import { conceptViews, formatCount, postActions } from '../../lib/contentStats';
import { controlsDisabled, emptyFilters, LIST_SORT_LABELS, READ_ONLY_TITLE, STATUS_LABELS } from '../../lib/contentView';
import type { ListFilters, ListSort } from '../../lib/contentView';
import type { PostDto } from '../../lib/contentTypes';
import { IMPORTED_FILTER_LABELS, IMPORTED_FILTERS, importButtonLabel, importButtonTitle, importSessionRunning, listEmptyKind } from '../../lib/contentImport';
import type { ImportedFilter } from '../../lib/contentImport';
import { PublishDialog } from './PublishDialog';
import { useContentStore } from '../../store/contentStore';
import { ErrorNote } from '../crm/shared';
import { ImportedBadge, PostChip } from './shared';
import { ConceptResultBadges, PlatformSummary, ResultFilter } from './ResultViews';

/** One Concept row: title, its posts as chips and the asset progress. */
export function ConceptRow({ concept, timeZone, now, showViews, readOnly = false, onOpen, onPublish }: { concept: ConceptDto; timeZone: string; now?: number; showViews?: boolean; readOnly?: boolean; onOpen: (id: string) => void; onPublish?: (concept: ConceptDto, post: PostDto) => void }) {
  const { finalized, needed } = concept.progress;
  return (
    <li className="rounded-card border border-border bg-card p-3.5">
      <button type="button" className="grid w-full gap-2 border-0 bg-transparent p-0 text-left text-foreground" onClick={() => onOpen(concept.id)}>
        <span className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-start gap-2 text-base font-semibold"><span className="min-w-0 [overflow-wrap:anywhere]">{concept.title}</span>{concept.imported && <ImportedBadge />}</span>
          <span className="text-xs text-muted-foreground">{showViews && <span className="mr-3 tabular-nums">Views {formatCount(conceptViews(concept))}</span>}{concept.imported ? null : needed ? `${finalized} of ${needed} assets finalized` : 'No assets needed yet'}</span>
        </span>
        <span className="flex flex-wrap gap-1.5">
          {concept.posts.length ? concept.posts.map((p) => <PostChip key={p.id} post={p} timeZone={timeZone} now={now} />) : <span className="text-xs text-muted-foreground">No posts yet</span>}
        </span>
        <ConceptResultBadges posts={concept.posts} />
      </button>
      {onPublish && concept.posts.some((p) => postActions(p.status).publish) && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Publish">
          {concept.posts.filter((p) => postActions(p.status).publish).map((p) => <Button key={p.id} size="sm" disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={() => onPublish(concept, p)}>Publish {PLATFORM_LABELS[p.platform]} {p.format}</Button>)}
        </div>
      )}
    </li>
  );
}

/** The list body for a loaded page; the loading, empty and error states are part of it. */
export function ConceptRows({ page, loading, error, timeZone, now, showViews, readOnly, imported = '', onOpen, onNew, onImport, onPublish }: { page: ConceptPageDto | null; loading: boolean; error: string | null; timeZone: string; now?: number; showViews?: boolean; readOnly?: boolean; imported?: ImportedFilter; onOpen: (id: string) => void; onNew: () => void; onImport?: () => void; onPublish?: (concept: ConceptDto, post: PostDto) => void }) {
  if (error) return <ErrorNote message={error} />;
  if (!page) return <p className="m-0 text-sm text-muted-foreground">{loading ? 'Loading concepts…' : ''}</p>;
  if (!page.rows.length && listEmptyKind(imported) === 'imported') return <p className="m-0 text-sm text-muted-foreground">No imported concepts yet. <button type="button" className="underline" disabled={readOnly} title={importButtonTitle(!!readOnly)} onClick={onImport}>Import past concept</button> to give the agents examples of your earlier work.</p>;
  if (!page.rows.length) return <p className="m-0 text-sm text-muted-foreground">No concepts match. <button type="button" className="underline" onClick={onNew}>Create one with New</button>.</p>;
  return <ul className="m-0 grid list-none gap-2.5 p-0">{page.rows.map((c) => <ConceptRow key={c.id} concept={c} timeZone={timeZone} now={now} showViews={showViews} readOnly={readOnly} onOpen={onOpen} onPublish={onPublish} />)}</ul>;
}

export function ListFiltersBar({ filters, onChange }: { filters: ListFilters; onChange: (next: ListFilters) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter concepts">
      <Input className="w-56" value={filters.search} placeholder="Search title and brief" aria-label="Search concepts" onChange={(e) => onChange({ ...filters, search: e.target.value })} />
      <NativeSelect aria-label="Post status" value={filters.status} onChange={(e) => onChange({ ...filters, status: e.target.value as '' | PostStatus })}>
        <option value="">Any status</option>
        {POST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
      </NativeSelect>
      <NativeSelect aria-label="Platform" value={filters.platform} onChange={(e) => onChange({ ...filters, platform: e.target.value as '' | Platform })}>
        <option value="">Any platform</option>
        {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
      </NativeSelect>
      <ResultFilter value={filters.result} onChange={(result) => onChange({ ...filters, result })} />
      <NativeSelect aria-label="Imported" value={filters.imported} onChange={(e) => onChange({ ...filters, imported: e.target.value as ImportedFilter })}>
        {IMPORTED_FILTERS.map((f) => <option key={f} value={f}>{IMPORTED_FILTER_LABELS[f]}</option>)}
      </NativeSelect>
      <NativeSelect aria-label="Sort" value={filters.sort} onChange={(e) => onChange({ ...filters, sort: e.target.value as ListSort })}>
        {(Object.keys(LIST_SORT_LABELS) as ListSort[]).map((k) => <option key={k} value={k}>{LIST_SORT_LABELS[k]}</option>)}
      </NativeSelect>
      <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={filters.archived} onChange={(e) => onChange({ ...filters, archived: e.target.checked })} />Archived</label>
    </div>
  );
}

/** Opens the import session's view; while a session is live it reads Continue import. */
export function ImportButton({ running, readOnly, onClick }: { running: boolean; readOnly: boolean; onClick: () => void }) {
  return (
    <Button variant="outline" onClick={onClick} disabled={controlsDisabled(readOnly)} title={importButtonTitle(readOnly)}>
      {running ? <span aria-hidden="true" data-live-dot className="size-2 rounded-full bg-success" /> : <Download />}{importButtonLabel(running)}
    </Button>
  );
}

export function ConceptList({ projectId, timeZone, readOnly, version, onOpen, onNew, onImport }: { projectId: string; timeZone: string; readOnly: boolean; version: number; onOpen: (id: string) => void; onNew: () => void; onImport: () => void }) {
  const [filters, setFilters] = useState(emptyFilters);
  const view = useContentStore((s) => s.listByProject[projectId]);
  const loadList = useContentStore((s) => s.loadList);
  const openImport = useContentStore((s) => s.openImport);
  const importing = useContentStore((s) => importSessionRunning(s.importByProject[projectId]));
  const [offset, setOffset] = useState(0);
  const [publishing, setPublishing] = useState<{ concept: ConceptDto; post: PostDto } | null>(null);
  useEffect(() => { setOffset(0); }, [filters]);
  useEffect(() => { void openImport(projectId, false); }, [projectId, openImport]);
  useEffect(() => { void loadList(projectId, filters, offset); }, [projectId, filters, offset, version, loadList]);
  const page = view?.page ?? null;
  return (
    <section className="grid gap-4" aria-label="Concepts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListFiltersBar filters={filters} onChange={setFilters} />
        <div className="flex flex-wrap items-center gap-2">
          <ImportButton running={importing} readOnly={readOnly} onClick={onImport} />
          <Button onClick={onNew} disabled={controlsDisabled(readOnly)} title={readOnly ? READ_ONLY_TITLE : undefined}><Plus />New</Button>
        </div>
      </div>
      <PlatformSummary summary={page?.summary} />
      <ConceptRows page={page} loading={view?.loading ?? true} error={view?.error ?? null} timeZone={timeZone} showViews={filters.sort === 'views'} readOnly={readOnly} imported={filters.imported} onOpen={onOpen} onNew={onNew} onImport={onImport} onPublish={(concept, post) => setPublishing({ concept, post })} />
      {publishing && <PublishDialog projectId={projectId} concept={publishing.concept} post={publishing.post} mode="publish" timeZone={timeZone} readOnly={readOnly} onDone={() => { setPublishing(null); void loadList(projectId, filters, offset); }} onCancel={() => setPublishing(null)} />}
      {page && page.total > page.limit && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page.limit))}>Previous</Button>
          <span>{offset + 1} to {offset + page.rows.length} of {page.total}</span>
          <Button variant="outline" size="sm" disabled={!page.hasMore} onClick={() => setOffset(offset + page.limit)}>Next</Button>
        </div>
      )}
    </section>
  );
}
