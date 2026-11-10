import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { Activity, CalendarClock, CircleDot, Database, GitBranch, Link2, Settings2, Terminal, Workflow as WorkflowIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ExecutorProfile, WorkflowRecord, WorkflowStep } from '../../lib/serverApi';
import { GIT_PROVIDERS, gitProviderOf } from '../../lib/gitProvider';
import { isAutoPullOn } from '../../lib/gitSync';
import { SOFTWARE_TYPE_ID } from '../../lib/buildingTypes';
import { effectiveSection, settingsSectionsFor } from '../../lib/settingsSections';
import type { SettingsSection } from '../../lib/settingsSections';
import { enabledWorkflows, loopBackLabel, stageAgentLabel, stageExecutorLabel, workflowBadge } from '../../lib/workflowSettings';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';
import { GeneralSettings } from './GeneralSettings';
import { GithubAccountCard } from './GithubAccountCard';
import { CommandsPanel } from './commands/CommandsPanel';
import { StorageSettings } from './StorageSettings';
import { ActivityPanel } from '../connections/ActivityPanel';
import { ConnectionsPanel } from '../connections/ConnectionsPanel';
import { SchedulesPanel } from '../schedules/SchedulesPanel';

const SECTIONS: Record<SettingsSection, { label: string; icon: ComponentType }> = {
  general: { label: 'General', icon: Settings2 },
  workflow: { label: 'Workflow', icon: WorkflowIcon },
  git: { label: 'Git provider', icon: GitBranch },
  commands: { label: 'Commands', icon: Terminal },
  schedules: { label: 'Schedules', icon: CalendarClock },
  // Named for what it is — the links between Buildings — so it isn't confused with a Building's external-service connections.
  connections: { label: 'Building links', icon: Link2 },
  activity: { label: 'Activity', icon: Activity },
  storage: { label: 'Storage', icon: Database },
};

/**
 * The Settings tab: a left sidebar (General / Workflow / Git provider / Commands / Schedules / Connections / Activity / Storage, same
 * shape as `TasksPanel`'s Open/Planning/Completed sidebar) and the selected section's content on the right. Every section
 * panel fills the content area itself and guards its own read-only state; none is drawn inside the read-only fieldset. `section` is controlled by the
 * parent (`ProjectWorkspaceModal`'s `WorkspaceContent`) rather than owned locally, so
 * `HeaderCommands`' "Manage commands" can land here on the Commands section specifically even when
 * this tab is already open.
 */
export function SettingsPanel({
  project,
  section,
  onSectionChange,
  onOpenCommandLog,
  onOpenRun,
}: {
  project: ProjectData;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onOpenCommandLog: (runId: string) => void;
  /** Opens a Schedules history row's run on the Tasks tab. */
  onOpenRun: (runId: string) => void;
}) {
  // Sections follow the Building's type: Storage only where the type keeps bulk data, Git/Workflow/Commands only for repository types.
  const type = useWorldStore((s) => s.buildingTypes.find((t) => t.id === (project.typeId ?? SOFTWARE_TYPE_ID)));
  const offered = settingsSectionsFor(type);
  const current = effectiveSection(section, offered);
  return (
    <section className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b bg-muted/30 p-3 md:w-60 md:border-r md:border-b-0">
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Settings sections">
          {offered.map((key) => {
            const { label, icon: Icon } = SECTIONS[key];
            const active = key === current;
            return (
              <Button
                key={key}
                type="button"
                variant="ghost"
                className={`w-full justify-start ${active ? 'bg-accent font-semibold' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => onSectionChange(key)}
              >
                <Icon />
                <span>{label}</span>
              </Button>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {current === 'general' && <GeneralSettings project={project} />}
        {current === 'workflow' && <WorkflowSection project={project} />}
        {current === 'git' && <GitProviderSection project={project} />}
        {current === 'commands' && <CommandsPanel project={project} onOpenCommandLog={onOpenCommandLog} />}
        {current === 'schedules' && <SchedulesPanel project={project} onOpenRun={onOpenRun} />}
        {current === 'connections' && <ConnectionsPanel project={project} />}
        {current === 'activity' && <ActivityPanel project={project} />}
        {current === 'storage' && <StorageSettings key={project.id} project={project} />}
      </div>
    </section>
  );
}

/** Which Git provider hosts the Project's repository. GitHub is the only one built so far; the list is driven by `GIT_PROVIDERS`, so a new provider shows up here once it is registered. */
function GitProviderSection({ project }: { project: ProjectData }) {
  const setProjectGitProvider = useWorldStore((s) => s.setProjectGitProvider);
  const current = gitProviderOf(project);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <h3 className="text-base font-semibold tracking-tight">Git provider</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">Where this project's repository is hosted. It decides the repository link and the pull requests in the PR tab.</p>
      <ul className="mt-5 space-y-2" aria-label="Git providers">
        {GIT_PROVIDERS.map((provider) => (
          <li key={provider.id} className="flex items-center justify-between gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
            <span className="text-sm font-medium">{provider.label}</span>
            {provider.id === current
              ? <Badge variant="secondary">Current</Badge>
              : <Button type="button" variant="outline" size="sm" onClick={() => void setProjectGitProvider(project.id, provider.id)}>Use {provider.label}</Button>}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-muted-foreground">More providers can be added later.</p>
      <GithubAccountCard project={project} />
      {project.repositoryUrl && <AutoPullToggle project={project} />}
    </div>
  );
}

/** Per-Project switch for the daemon's automatic fast-forward of the checked-out branch (server/src/projects/autoPull.ts). */
function AutoPullToggle({ project }: { project: ProjectData }) {
  const setProjectAutoPull = useWorldStore((s) => s.setProjectAutoPull);
  const on = isAutoPullOn(project);
  return (
    <label className="mt-8 flex items-start justify-between gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <span>
        <span className="block text-sm font-medium">Auto-pull upstream changes</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">Fast-forward the checked-out branch when origin has new commits, as long as nothing is running in the main folder and you have no uncommitted changes.</span>
      </span>
      <input type="checkbox" role="switch" className="mt-1 size-4" checked={on} onChange={(event) => void setProjectAutoPull(project.id, event.target.checked)} />
    </label>
  );
}

/** Workflow selection only — editing a Workflow's steps happens in the Catalog's Workflows tab, reached from here via "Manage workflows" (`openCatalog`). */
function WorkflowSection({ project }: { project: ProjectData }) {
  const catalogWorkflows = useWorldStore((s) => s.catalogWorkflows);
  const executors = useWorldStore((s) => s.executors);
  const fetchCatalog = useWorldStore((s) => s.fetchCatalog);
  const setProjectWorkflow = useWorldStore((s) => s.setProjectWorkflow);
  const openCatalog = useWorldStore((s) => s.openCatalog);
  const [loaded, setLoaded] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // catalogWorkflows isn't guaranteed to be loaded by the time this tab opens — nothing else in the
  // workspace touches it (only `openCatalog` does today). Always refetch on mount, same as
  // `CommandsPanel`'s `loadActiveCommandRuns`; cheap, and keeps this in sync with edits made in the
  // Catalog in another tab.
  useEffect(() => { void fetchCatalog().then(() => setLoaded(true)); }, [fetchCatalog]);

  const workflows = enabledWorkflows(catalogWorkflows);

  async function use(workflowId: string) {
    setPendingId(workflowId);
    await setProjectWorkflow(project.id, workflowId);
    setPendingId(null);
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold tracking-tight">Workflow</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">Applies to tasks started after this change.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={openCatalog}>Manage workflows</Button>
      </div>

      {workflows.length === 0 ? (
        <p className="mt-5 text-sm italic text-muted-foreground">{loaded ? 'No workflows defined yet.' : 'Loading…'}</p>
      ) : (
        <ul className="mt-5 space-y-4">
          {workflows.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              badge={workflowBadge(project, workflow)}
              executors={executors}
              pending={pendingId === workflow.id}
              onUse={() => void use(workflow.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkflowCard({
  workflow,
  badge,
  executors,
  pending,
  onUse,
}: {
  workflow: WorkflowRecord;
  badge: 'current' | 'default' | null;
  executors: ExecutorProfile[];
  pending: boolean;
  onUse: () => void;
}) {
  const isCurrent = badge === 'current';
  return (
    <li className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold">{workflow.name}</h4>
            {badge && <Badge variant={isCurrent ? 'success' : 'secondary'}>{isCurrent ? 'Current' : 'Default'}</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{workflow.description}</p>
        </div>
        {!isCurrent && (
          <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={pending} onClick={onUse}>
            {pending ? 'Applying…' : 'Use this workflow'}
          </Button>
        )}
      </div>

      <ol className="mt-3 space-y-2">
        {workflow.steps.map((step) => (
          <StageRow key={step.id} step={step} steps={workflow.steps} executors={executors} />
        ))}
        <li className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <CircleDot className="size-3.5 shrink-0" aria-hidden="true" />
          Complete — commit, push and raise a PR
        </li>
      </ol>
    </li>
  );
}

/** One configured `WorkflowStep`'s row: its agent, edit/approval/executor badges and loop-back note. */
function StageRow({ step, steps, executors }: { step: WorkflowStep; steps: WorkflowStep[]; executors: ExecutorProfile[] }) {
  const executorLabel = stageExecutorLabel(step, executors);
  const loop = loopBackLabel(step, steps);
  return (
    <li className="rounded-lg border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{step.name}</span>
        <span className="text-muted-foreground">
          — {step.agent?.avatar && <span aria-hidden="true">{step.agent.avatar} </span>}
          {stageAgentLabel(step)}
        </span>
        <Badge variant={step.canEditCode ? 'warning' : 'secondary'}>{step.canEditCode ? 'Edits code' : 'Read-only'}</Badge>
        {step.canRunCommands && !step.canEditCode && <Badge variant="outline">Runs commands</Badge>}
        {step.canUseBrowser && <Badge variant="outline">Uses browser</Badge>}
        {step.requiresApproval && <Badge variant="secondary">Needs approval</Badge>}
        {executorLabel && <Badge variant="outline">{executorLabel}</Badge>}
      </div>
      {loop && <p className="mt-1 text-xs text-muted-foreground">{loop}</p>}
    </li>
  );
}
