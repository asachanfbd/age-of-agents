import { useEffect, useState } from 'react';
import { Calendar, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { closeConcept, closeImport, CONTENT_TABS, initialContentState, openConcept, openImport, selectConceptTab, selectTab, setView } from '../lib/contentWorkspace';
import type { ContentTab } from '../lib/contentWorkspace';
import { useLoad } from './crm/crmHooks';
import { contentApi } from '../lib/contentApi';
import type { ProjectData } from '../types';
import { PageHeader } from './design/Header';
import { CalendarView } from './content/CalendarView';
import { ConceptList } from './content/ConceptList';
import { ConceptView } from './content/ConceptView';
import { ImportView } from './content/ImportView';
import { StudioPane } from './content/StudioPane';
import { VideoTab } from './content/VideoTab';
import { ImagesPane } from './content/ImagesPane';
import { ThumbnailPane } from './content/ThumbnailPane';
import { RemotionTab } from './content/RemotionTab';
import { KnowledgeTab } from './content/KnowledgeTab';
import { NewConceptDialog } from './content/NewConceptDialog';
import { SettingsTab } from './content/SettingsTab';
import { TargetsTab } from './content/TargetsTab';
import { InsightsTab } from './content/InsightsTab';
import { ProposalBadge, WritingStyleTab } from './content/WritingStyleTab';
import { useContentStore } from '../store/contentStore';

const TITLES: Record<ContentTab, readonly [string, string]> = { content: ['Content', 'Concepts'], knowledge: ['Business', 'Knowledge'], style: ['Writing', 'Style'], targets: ['Performance', 'Targets'], insights: ['Performance', 'Insights'], settings: ['Content Studio', 'Settings'] };

/** The Content Studio Building's popup body: four pill tabs; a Concept opens in place of the Content tab's list, with a back button. */
export function ContentStudioWorkspace({ project, readOnly }: { project: ProjectData; readOnly: boolean }) {
  const [state, setState] = useState(initialContentState);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  const settings = useLoad(() => contentApi.settings(project.id), [project.id, version]);
  const timeZone = settings.data?.timezone ?? 'UTC';
  const changed = () => setVersion((n) => n + 1);
  const pending = useContentStore((s) => s.proposalsByProject[project.id]?.length ?? 0);
  const loadProposals = useContentStore((s) => s.loadProposals);
  useEffect(() => { void loadProposals(project.id); }, [project.id, loadProposals]);
  const openFromStyle = (conceptId: string) => setState((s) => openConcept(selectTab(s, 'content'), conceptId));
  const openStyle = () => setState((s) => selectTab(s, 'style'));
  const meta = TITLES[state.tab];
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Content Studio workspace">
      <Tabs value={state.tab} onValueChange={(next) => setState((s) => selectTab(s, next as ContentTab))} className="shrink-0 overflow-x-auto px-4 py-3 sm:px-6">
        <TabsList>{CONTENT_TABS.map((t) => <TabsTrigger key={t.key} value={t.key} className="px-3 min-[960px]:px-4">{t.label}{t.key === 'style' && <ProposalBadge count={pending} />}</TabsTrigger>)}</TabsList>
      </Tabs>
      {state.tab === 'settings' ? <SettingsTab projectId={project.id} readOnly={readOnly} onSaved={changed} /> : (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {state.tab === 'content' && state.conceptId !== null ? (
            <ConceptView projectId={project.id} conceptId={state.conceptId} timeZone={timeZone} readOnly={readOnly} renderStudio={(conceptId, assetId, format) => <StudioPane key={assetId} projectId={project.id} conceptId={conceptId} assetId={assetId} readOnly={readOnly} format={format} onOpenStyle={openStyle} />} renderVideo={(conceptId, assetId) => <VideoTab projectId={project.id} conceptId={conceptId} assetId={assetId} readOnly={readOnly} />} renderImages={(conceptId, assetId) => <ImagesPane key={assetId} projectId={project.id} conceptId={conceptId} assetId={assetId} readOnly={readOnly} />} renderThumbnail={(conceptId, assetId) => <ThumbnailPane key={assetId} projectId={project.id} conceptId={conceptId} assetId={assetId} readOnly={readOnly} />} renderRemotion={(conceptId, videoAssetId, compositionId) => <RemotionTab projectId={project.id} conceptId={conceptId} videoAssetId={videoAssetId} compositionId={compositionId} readOnly={readOnly} />} onOpenStyle={openStyle} tab={state.conceptTab} onTab={(t) => setState((s) => selectConceptTab(s, t))} onBack={() => { setState(closeConcept); changed(); }} onChanged={changed} />
          ) : state.tab === 'content' && state.importing ? (
            <ImportView projectId={project.id} timeZone={timeZone} readOnly={readOnly} onBack={() => { setState(closeImport); changed(); }} onOpen={(id) => setState((s) => openConcept(s, id))} />
          ) : (
            <div key={state.tab} className="grid gap-5 p-4 animate-in fade-in-0 sm:p-6">
              <PageHeader lines={meta} actions={state.tab === 'content' ? (
                <div className="flex gap-1" role="group" aria-label="View">
                  <Button variant={state.view === 'list' ? 'default' : 'outline'} size="sm" aria-pressed={state.view === 'list'} onClick={() => setState((s) => setView(s, 'list'))}><List />List</Button>
                  <Button variant={state.view === 'calendar' ? 'default' : 'outline'} size="sm" aria-pressed={state.view === 'calendar'} onClick={() => setState((s) => setView(s, 'calendar'))}><Calendar />Calendar</Button>
                </div>
              ) : undefined} />
              {state.tab === 'content' && (state.view === 'list'
                ? <ConceptList projectId={project.id} timeZone={timeZone} readOnly={readOnly} version={version} onOpen={(id) => setState((s) => openConcept(s, id))} onNew={() => setCreating(true)} onImport={() => setState(openImport)} />
                : <CalendarView projectId={project.id} timeZone={timeZone} version={version} onOpen={(id) => setState((s) => openConcept(s, id))} />)}
              {state.tab === 'knowledge' && <KnowledgeTab projectId={project.id} readOnly={readOnly} />}
              {state.tab === 'targets' && <TargetsTab projectId={project.id} readOnly={readOnly} timeZone={timeZone} onOpenSettings={() => setState((s) => selectTab(s, 'settings'))} />}
              {state.tab === 'insights' && <InsightsTab projectId={project.id} readOnly={readOnly} timeZone={timeZone} />}
              {state.tab === 'style' && <WritingStyleTab projectId={project.id} readOnly={readOnly} onOpenConcept={openFromStyle} />}
            </div>
          )}
        </div>
      )}
      {creating && <NewConceptDialog projectId={project.id} timeZone={timeZone} onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); changed(); setState((s) => openConcept(s, id)); }} />}
    </div>
  );
}
