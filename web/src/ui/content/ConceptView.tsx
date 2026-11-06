import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
import { conceptTabStates } from '../../lib/contentRules';
import type { AssetKind, ConceptTab } from '../../lib/contentRules';
import type { ConceptDto } from '../../lib/contentTypes';
import { CONCEPT_STATUS_VARIANT, conceptFactParts, conceptStatus, controlsDisabled, createdWord, READ_ONLY_TITLE } from '../../lib/contentView';
import { isPostTextTab } from '../../lib/contentPostTabs';
import { useContentStore } from '../../store/contentStore';
import { ErrorNote } from '../crm/shared';
import { formatExactTime } from '../../lib/sessionTiming';
import { RelativeTime } from '../design/RelativeTime';
import { DetailBackButton, DetailLabel, HeaderIconButton, TITLE_INDENT } from '../project-popup/DetailHeader';
import { ImportedBand, ImportedTab } from './ImportedConcept';
import { OverviewTab } from './OverviewTab';
import { PostTextTab } from './PostTextTab';
import { ImagesTab } from './ImagesTab';
import { ThumbnailTab } from './ThumbnailTab';
import { ImportedBadge } from './shared';
import type { StudioResultFormat } from './StudioPaneView';

/** A field that saves on blur when it changed (Enter too for a single line). */
function InlineText({ value, label, multiline, disabled, inputRef, onSave }: { value: string; label: string; multiline?: boolean; disabled: boolean; inputRef?: React.Ref<HTMLInputElement>; onSave: (next: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text !== value) onSave(text); };
  const common = { value: text, 'aria-label': label, disabled, title: disabled ? READ_ONLY_TITLE : undefined, onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setText(e.target.value), onBlur: commit };
  return multiline
    ? <Textarea rows={3} className="text-sm" {...common} />
    : <Input ref={inputRef} className="text-sm" onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} {...common} />;
}

/** Title and brief, on the title's column under the header. */
function BriefSection({ concept, disabled, onSave }: { concept: ConceptDto; disabled: boolean; onSave: BodyProps['onSave'] }) {
  const titleRef = useRef<HTMLInputElement>(null);
  return (
    <div id="concept-brief" className={`grid gap-3 pb-4 pr-4 sm:pr-6 ${TITLE_INDENT}`}>
      <section aria-label="Concept name" className="grid gap-1.5">
        <div className="flex h-6 items-center justify-between gap-2">
          <DetailLabel>Title</DetailLabel>
          <Button type="button" variant="secondary" size="sm" disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} onClick={() => titleRef.current?.focus()}><Pencil aria-hidden="true" /> Edit title</Button>
        </div>
        <InlineText inputRef={titleRef} value={concept.title} label="Concept title" disabled={disabled} onSave={(title) => onSave({ title })} />
      </section>
      <section aria-label="Concept brief section" className="grid gap-1.5">
        <DetailLabel>Brief</DetailLabel>
        <InlineText value={concept.brief} label="Concept brief" multiline disabled={disabled} onSave={(brief) => onSave({ brief })} />
      </section>
    </div>
  );
}

/** Back, the Concept's name, its status and a chevron that opens the title and brief; the facts line sits under the title. */
function ConceptHeader({ concept, timeZone, disabled, error, initialExpanded, band, onBack, onSave }: { concept: ConceptDto; timeZone: string; disabled: boolean; error: string | null; initialExpanded: boolean; band: ReactNode; onBack: () => void; onSave: BodyProps['onSave'] }) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const status = conceptStatus(concept);
  const parts = conceptFactParts(concept);
  return (
    <header className="shrink-0 border-b">
      <div className="flex flex-col gap-1 px-4 py-3 sm:px-6">
        <div className="flex items-start gap-2.5">
          <DetailBackButton onBack={onBack} label="Back to Concepts" />
          <h3 className="line-clamp-2 min-w-0 flex-1 break-words pt-1.5 text-sm font-semibold leading-snug">{concept.title}</h3>
          <div className="flex shrink-0 items-center gap-2">
            {concept.imported && <ImportedBadge />}
            <Badge variant={CONCEPT_STATUS_VARIANT[status]}>{status}</Badge>
            <TooltipProvider><HeaderIconButton label={expanded ? 'Hide Concept brief' : 'Show Concept brief'} icon={expanded ? ChevronUp : ChevronDown} expanded={expanded} onClick={() => setExpanded(!expanded)} /></TooltipProvider>
          </div>
        </div>
        <p className="truncate pl-10.5 text-xs text-muted-foreground" title={[status, `${createdWord(concept)} ${formatExactTime(concept.createdAt, timeZone)}`, ...parts].join(' · ')}>{status} · {createdWord(concept)} <RelativeTime at={concept.createdAt} timeZone={timeZone} /> · {parts.join(' · ')}</p>
        <ErrorNote message={error} />
        {band}
      </div>
      {expanded && <BriefSection concept={concept} disabled={disabled} onSave={onSave} />}
    </header>
  );
}

/** The Concept in place of the list: header, the declared tab bar with enable rules, and the open tab. */
export function ConceptView({ projectId, conceptId, ...rest }: Omit<BodyProps, 'concept' | 'missingByPost' | 'error' | 'onSave'> & { conceptId: string }) {
  const concept = useContentStore((s) => s.conceptsById[conceptId]);
  const missingByPost = useContentStore((s) => s.missingByPost);
  const loadConcept = useContentStore((s) => s.loadConcept);
  const patchConcept = useContentStore((s) => s.patchConcept);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void loadConcept(projectId, conceptId).then((r) => setError(r.ok ? null : r.error)); }, [projectId, conceptId, loadConcept]);
  const save = async (patch: { title?: string; brief?: string }) => { const r = await patchConcept(projectId, conceptId, patch); setError(r.ok ? null : r.error); if (r.ok) rest.onChanged(); };
  return <ConceptBody key={conceptId} projectId={projectId} concept={concept} missingByPost={missingByPost} error={error} onSave={save} {...rest} />;
}

interface BodyProps {
  projectId: string; concept: ConceptDto | undefined; missingByPost: Record<string, AssetKind[]>; error: string | null; timeZone: string; readOnly: boolean;
  /** Draws the agent pane of an asset; passed in so this view stays free of the terminal. */
  renderStudio: (conceptId: string, assetId: string, format?: StudioResultFormat) => ReactNode;
  /** Draws the Video tab of the Concept's video asset. */
  renderVideo: (conceptId: string, assetId: string) => ReactNode;
  /** Draws the Images pane of one post's image set. */
  renderImages: (conceptId: string, assetId: string) => ReactNode;
  /** Draws the Thumbnail pane of the Concept's thumbnail asset. */
  renderThumbnail: (conceptId: string, assetId: string) => ReactNode;
  /** Draws the Remotion tab: Studio opened at the Concept's composition. */
  renderRemotion: (conceptId: string, videoAssetId: string, compositionId: string) => ReactNode;
  /** Opens the Writing style tab, where "Learn from this" leaves its proposal. */
  onOpenStyle?: () => void;
  /** Opens the brief section (tests; a Concept always opens collapsed). */
  initialExpanded?: boolean;
  tab: ConceptTab; onTab: (tab: ConceptTab) => void; onBack: () => void; onChanged: () => void; onSave: (patch: { title?: string; brief?: string }) => void;
}

/** The loaded Concept: header, tab bar and the open tab. Kept free of the store so it renders on its own. */
export function ConceptBody({ projectId, concept, missingByPost, error, timeZone, readOnly, renderStudio, renderVideo, renderImages, renderThumbnail, renderRemotion, onOpenStyle, initialExpanded = false, tab, onTab, onBack, onChanged, onSave }: BodyProps) {
  if (!concept) return <div className="grid gap-3 p-4 sm:p-6"><DetailBackButton onBack={onBack} label="Back to Concepts" /><ErrorNote message={error} /></div>;
  const script = concept.assets.find((a) => a.kind === 'script');
  const video = concept.assets.find((a) => a.kind === 'video');
  const tabs = conceptTabStates(concept.posts, { scriptFinalized: script?.state === 'finalized', compositionReady: !!concept.compositionId, imported: concept.imported });
  const open = tabs.find((t) => t.key === tab);
  const textTab = isPostTextTab(tab) && open?.enabled;
  const imagesTab = tab === 'images' && open?.enabled;
  const thumbnailTab = tab === 'thumbnail' && open?.enabled;
  const importedTab = concept.imported && tab !== 'overview' && open?.enabled;
  const videoTab = !concept.imported && tab === 'video' && !!video;
  // The agent tabs run edge to edge under a 1px line; the Video tab keeps its own padded layout. An imported Concept's tabs are read-only pages that scroll.
  const agentTab = !concept.imported && ((tab === 'script' && !!script) || textTab || imagesTab || thumbnailTab);
  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Concept">
      <ConceptHeader concept={concept} timeZone={timeZone} disabled={controlsDisabled(readOnly)} error={error} initialExpanded={initialExpanded} band={concept.imported && <ImportedBand projectId={projectId} conceptId={concept.id} readOnly={readOnly} onOpenStyle={onOpenStyle} onDeleted={onBack} />} onBack={onBack} onSave={onSave} />
      <Tabs value={tab} onValueChange={(next) => onTab(next as ConceptTab)} className="shrink-0 overflow-x-auto px-4 pt-4 sm:px-6">
        <TabsList aria-label="Concept sections">
          {tabs.map((t) => <TabsTrigger key={t.key} value={t.key} disabled={!t.enabled} title={t.reason ?? undefined} className="px-3">{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className={agentTab ? 'mt-3 flex min-h-64 min-w-0 flex-1 flex-col border-t border-border' : videoTab ? 'flex min-h-64 min-w-0 flex-1 flex-col p-4 sm:px-6' : 'min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:px-6'}>
        {tab === 'overview'
          ? <OverviewTab projectId={projectId} concept={concept} missingByPost={missingByPost} timeZone={timeZone} readOnly={readOnly} onChanged={onChanged} onOpenThumbnail={tabs.find((t) => t.key === 'thumbnail')?.enabled ? () => onTab('thumbnail') : undefined} />
          : importedTab
            ? <ImportedTab concept={concept} tab={tab} timeZone={timeZone} />
            : tab === 'script' && script
            ? renderStudio(concept.id, script.id)
            : tab === 'video' && video
              ? renderVideo(concept.id, video.id)
              : tab === 'remotion' && open?.enabled && video && concept.compositionId
                ? renderRemotion(concept.id, video.id, concept.compositionId)
                : textTab
                  ? <PostTextTab key={tab} tab={tab} concept={concept} timeZone={timeZone} renderStudio={renderStudio} onOverview={() => onTab('overview')} />
                  : thumbnailTab
                    ? <ThumbnailTab concept={concept} renderPane={renderThumbnail} onOverview={() => onTab('overview')} />
                    : imagesTab
                      ? <ImagesTab concept={concept} timeZone={timeZone} renderPane={renderImages} onOverview={() => onTab('overview')} />
                      : <p className="m-0 rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{open?.reason ?? 'Coming soon'}</p>}
      </div>
    </div>
  );
}
