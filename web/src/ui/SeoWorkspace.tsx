import { useEffect, useState } from 'react';
import { FileText, Globe, KeyRound, Link2, ListChecks, Map as MapIcon, Network, Tags, TrendingDown, TrendingUp } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { seoKpisForTab } from '../lib/seoKpis';
import type { SeoKpiData } from '../lib/seoKpis';
import { SEO_SETTINGS_SECTIONS, SEO_TABS } from '../lib/seoWorkspace';
import type { SeoSettingsSection, SeoTab } from '../lib/seoWorkspace';
import { useSeoStore } from '../store/seoStore';
import { useSeoBacklinksStore } from '../store/seoBacklinksStore';
import { useSeoKeywordsStore } from '../store/seoKeywordsStore';
import { KpiRow, PageHeader, Section } from './design/Header';
import { useWorldStore } from '../store/worldStore';
import type { ProjectData } from '../types';
import { SeoBacklinks } from './SeoBacklinks';
import { SeoConnections } from './SeoConnections';
import { SeoData } from './SeoData';
import { SeoInternalLinks } from './SeoInternalLinks';
import { SeoKeywords } from './SeoKeywords';
import { SeoPages } from './SeoPages';
import { SeoReports } from './SeoReports';
import { SeoSitemaps } from './SeoSitemaps';
import { SeoTasks } from './SeoTasks';

function SettingsArea({ project, section, onSection }: { project: ProjectData; section: SeoSettingsSection; onSection: (s: SeoSettingsSection) => void }) {
  return (
    <div className="flex min-h-0 flex-1" aria-label="SEO settings">
      <nav className="w-44 shrink-0 border-r p-3" aria-label="Settings sections">
        {SEO_SETTINGS_SECTIONS.map((s) => (
          <button key={s.key} type="button" aria-current={s.key === section ? 'page' : undefined} onClick={() => onSection(s.key)}
            className={`mb-1 block w-full rounded-md px-3 py-1.5 text-left text-sm ${s.key === section ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'}`}>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Section title={SEO_SETTINGS_SECTIONS.find((s) => s.key === section)?.label}>
          {section === 'connections' ? <SeoConnections project={project} /> : <SeoData project={project} />}
        </Section>
      </div>
    </div>
  );
}

const KPI_ICONS = { keywords: <KeyRound />, clusters: <Tags />, pendingSuggestions: <ListChecks />, pages: <FileText />, sitemaps: <MapIcon />, urls: <Globe />, backlinks: <Link2 />, referringDomains: <Network />, newBacklinks: <TrendingUp />, lostBacklinks: <TrendingDown /> };

/** The numbers the SEO tabs have already loaded into their stores, for the KPI row; a slice not read yet stays null. */
function useSeoKpiData(projectId: string): SeoKpiData {
  const clusters = useSeoKeywordsStore((s) => s.clustersByProject[projectId]);
  const pages = useSeoStore((s) => s.pagesByProject[projectId]);
  const sitemaps = useSeoStore((s) => s.sitemapsByProject[projectId]);
  const urls = useSeoStore((s) => s.urlsByProject[projectId]);
  const overview = useSeoBacklinksStore((s) => s.overviewByProject[projectId]);
  return {
    keywords: clusters?.totals?.keywords ?? null, clusters: clusters?.totals?.clusters ?? null, pendingSuggestions: clusters?.totals?.pendingSuggestions ?? null,
    pages: pages?.total ?? null, sitemaps: sitemaps?.sitemaps?.length ?? null, urls: urls?.total ?? null,
    backlinks: overview?.summary?.total ?? null, referringDomains: overview?.summary?.referringDomains ?? null, newBacklinks: overview?.summary?.newInPeriod ?? null, lostBacklinks: overview?.summary?.lostInPeriod ?? null,
  };
}

/** The SEO Building's popup body: eight tabs from one declaration. */
export function SeoWorkspace({ project }: { project: ProjectData }) {
  const [tab, setTab] = useState<SeoTab>('keywords');
  const [section, setSection] = useState<SeoSettingsSection>('connections');
  const [linkedPage, setLinkedPage] = useState<string | null>(null);
  const openInternalLinks = (url: string | null) => { setLinkedPage(url); setTab('internal-links'); };
  const syncOnOpen = useSeoStore((s) => s.syncOnOpen);
  useEffect(() => { void syncOnOpen(project.id); }, [project.id, syncOnOpen]);
  const tabRequest = useWorldStore((s) => s.seoTabRequest);
  const clearTabRequest = useWorldStore((s) => s.clearSeoTabRequest);
  useEffect(() => {
    if (!tabRequest || tabRequest.projectId !== project.id) return;
    setTab(tabRequest.tab);
    clearTabRequest();
  }, [tabRequest, project.id, clearTabRequest]);

  const kpiData = useSeoKpiData(project.id);
  const items = seoKpisForTab(tab, kpiData);
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="SEO workspace">
      <Tabs value={tab} onValueChange={(next) => setTab(next as SeoTab)} className="shrink-0 overflow-x-auto px-4 py-3 sm:px-6">
        <TabsList>
          {SEO_TABS.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="shrink-0 px-4 pb-3 sm:px-6"><PageHeader size="md" lines={[SEO_TABS.find((t) => t.key === tab)!.label]}><KpiRow items={items} icons={KPI_ICONS} /></PageHeader></div>
      {tab === 'settings' ? <SettingsArea project={project} section={section} onSection={setSection} />
        : tab === 'keywords' ? <SeoKeywords project={project} />
          : tab === 'pages' ? <SeoPages project={project} onOpenInternalLinks={openInternalLinks} />
          : tab === 'sitemaps' ? <SeoSitemaps project={project} />
            : tab === 'backlinks' ? <SeoBacklinks project={project} />
            : tab === 'tasks' ? <SeoTasks project={project} />
            : tab === 'internal-links' ? <SeoInternalLinks project={project} selectedUrl={linkedPage} onSelectUrl={setLinkedPage} onOpenPages={() => setTab('pages')} />
            : <SeoReports project={project} onOpenSettings={() => { setTab('settings'); setSection('connections'); }} />}
    </div>
  );
}
