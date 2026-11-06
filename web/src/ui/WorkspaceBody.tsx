import { Archive, Code, FileText, FlaskConical, GitPullRequest, ListChecks, Settings } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isBuildingReadOnly } from '../lib/buildingTypes';
import { panelPlacement } from '../lib/workspaceLayout';
import type { WorkspaceTab, WorkspaceTabSpec } from '../lib/workspaceLayout';
import type { ProjectData } from '../types';

/** Exhaustive over `WorkspaceTab`: a tab added to `lib/workspaceLayout.ts` without an icon fails the type check. */
const TAB_ICONS: Record<WorkspaceTab, ComponentType> = {
  tasks: ListChecks,
  documents: FileText,
  testing: FlaskConical,
  code: Code,
  pr: GitPullRequest,
  settings: Settings,
  archived: Archive,
};

/** The tab bar every workspace shell draws from its own list of `WorkspaceTabSpec`s. */
export function WorkspaceTabBar({ tabs, value, onChange }: { tabs: WorkspaceTabSpec[]; value: WorkspaceTab; onChange: (tab: WorkspaceTab) => void }) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as WorkspaceTab)} className="shrink-0 overflow-x-auto px-4 py-3 sm:px-6">
      <TabsList>
        {tabs.map(({ key, label, ariaLabel }) => {
          const Icon = TAB_ICONS[key];
          return <TabsTrigger key={key} value={key} aria-label={ariaLabel}><Icon />{label}</TabsTrigger>;
        })}
      </TabsList>
    </Tabs>
  );
}

/**
 * The selected tab's panel under the tab bar. Placement comes from the tab's declaration: a self-guarded panel is drawn
 * bare, any other inside the read-only fieldset, and a tab with no panel draws nothing — never an empty fieldset.
 */
export function WorkspaceBody({ project, tab, panels }: { project: ProjectData; tab: WorkspaceTab; panels: Partial<Record<WorkspaceTab, ReactNode>> }) {
  const panel = panels[tab];
  const placement = panelPlacement(tab, Boolean(panel));
  if (placement === 'none') return null;
  if (placement === 'bare') return <>{panel}</>;
  return <ReadOnlyFieldset project={project}>{panel}</ReadOnlyFieldset>;
}

/** Turns every button and input inside into a disabled one while the Building is read-only, so a change is never attempted just to be refused with a 409. Tabs and scrolling stay outside it. */
function ReadOnlyFieldset({ project, children }: { project: ProjectData; children: ReactNode }) {
  return <fieldset disabled={isBuildingReadOnly(project)} className="m-0 flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0">{children}</fieldset>;
}
