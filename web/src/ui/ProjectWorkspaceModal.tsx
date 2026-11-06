import { useMemo, useState } from 'react';
import { Activity, AlertCircle, FolderKanban, Lightbulb, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { isBuildingReadOnly, readOnlyNotice, workspaceFor } from '../lib/buildingTypes';
import { describeAttention, buildingVisualStatus } from '../lib/buildingVisualStatus';
import { isOutOfSync } from '../lib/gitSync';
import { repositoryLinkOf } from '../lib/gitProvider';
import { hasArchivedItems } from '../lib/projectTasks';
import { countProjectTasks } from '../lib/workspaceCounts';
import { isTaskTerminalTarget } from '../lib/terminalEscape';
import { workspaceTabs } from '../lib/pullRequests';
import { usePrPolling, usePrReading } from '../lib/usePullRequests';
import { useWorldStore } from '../store/worldStore';
import { notesTabs, tabOrTasks } from '../lib/workspaceLayout';
import type { WorkspaceTab } from '../lib/workspaceLayout';
import type { SettingsSection } from '../lib/settingsSections';
import type { BuildingStatus, ProjectData } from '../types';
import { NotesWorkspace } from './NotesWorkspace';
import { ContentStudioWorkspace } from './ContentStudioWorkspace';
import { CrmWorkspace } from './CrmWorkspace';
import { SeoWorkspace } from './SeoWorkspace';
import { ArchivedPanel } from './project-popup/ArchivedPanel';
import { BranchMenu } from './project-popup/BranchMenu';
import { CodePanel } from './project-popup/CodePanel';
import { CommandLogPopup } from './project-popup/commands/CommandLogPopup';
import { DocumentsPanel } from './project-popup/DocumentsPanel';
import { HeaderCommands } from './project-popup/HeaderCommands';
import { HeaderAgentSessions } from './project-popup/HeaderAgentSessions';
import { AgentTerminalView } from './project-popup/AgentTerminalView';
import { NO_AGENT_VIEW, afterAgentSessionDeleted, closeAgentView, openAgentView } from '../lib/agentSessions';
import { PrPanel } from './project-popup/PrPanel';
import { DEFAULT_TASK_PANEL_ARRANGEMENT, toggleTaskPanelArrangement } from '../lib/planningTaskPanel';
import type { TaskPanelArrangement, TaskPanelSwap } from '../lib/planningTaskPanel';
import { RepositoryLink } from './project-popup/RepositoryLink';
import { SettingsPanel } from './project-popup/SettingsPanel';
import { TasksPanel } from './project-popup/TasksPanel';
import { TestingPanel } from './project-popup/TestingPanel';
import { WorkspaceBody, WorkspaceTabBar } from './WorkspaceBody';
import { KpiRow, PageHeader } from './design/Header';

/**
 * The project workspace popup: a large, centered dialog for one project — a header (name, state,
 * commands, repository link, branch) over Tasks, Documents, Testing, Code, PR (when the Project has a repository) and Settings (which also holds Schedules, Connections and Activity), plus Archived
 * at the far right while the project has archived tasks. Distinct from the
 * small, 3D-anchored `BuildingDetailsPopup` (Home Base only); this is where planning and execution
 * happen. Opened via `openWorkspace`, not `selectBuilding`.
 */

const STATE_BADGES: Record<BuildingStatus, { label: string; variant: 'secondary' | 'success' | 'warning'; dot: string }> = {
  idle: { label: 'Idle', variant: 'secondary', dot: 'bg-muted-foreground' },
  developing: { label: 'In development', variant: 'success', dot: 'bg-success' },
  blocked: { label: 'Waiting for input', variant: 'warning', dot: 'bg-warning' },
};

/** Where the workspace popup remembers its dragged size for each browser-window size. */
const WORKSPACE_SIZE_STORAGE_KEY = 'agent-visual-os.popup-size.project-workspace';

export function ProjectWorkspaceModal() {
  const workspaceProjectId = useWorldStore((s) => s.workspaceProjectId);
  const openWorkspace = useWorldStore((s) => s.openWorkspace);
  if (!workspaceProjectId) return null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) openWorkspace(null); }}>
      <DialogContent
        hideClose
        sizeMemoryKey={WORKSPACE_SIZE_STORAGE_KEY}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (isTaskTerminalTarget(event.target)) event.preventDefault();
        }}
        className="flex h-[min(780px,var(--popup-max-height))] outline-none w-[min(1024px,96vw)] max-w-none flex-col canvas-warm gap-0 overflow-hidden rounded-card p-0"
      >
        {/* Keyed by project id so switching projects remounts this component's own local state
            (the command-log popup, the Testing→Tasks run link) — see web-interaction-conventions's
            "Form state". The tab/detail-view/settings-section state lives in the store instead
            (`workspaceTab`/`workspaceDetailTaskId`/`workspaceSettingsSection`), reset explicitly by
            `openWorkspace` rather than by this remount — see its own doc comment. */}
        <WorkspaceContent key={workspaceProjectId} projectId={workspaceProjectId} />
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceContent({ projectId }: { projectId: string }) {
  const project = useWorldStore((s) => s.projects.find((p) => p.id === projectId));
  const tasksById = useWorldStore((s) => s.tasksById);
  // Same inputs ProjectYard.tsx's label dot reads (lib/buildingVisualStatus.ts) — kept in sync
  // here so the attention banner below explains exactly what that dot is showing, not a
  // separately-derived reading that could drift from it.
  const lastTaskId = useWorldStore((s) => s.lastTaskIdByProject[projectId]);
  const latestTaskReviewed = useWorldStore((s) => (lastTaskId ? !!s.reviewedTaskIds[lastTaskId] : false));
  const reviewTask = useWorldStore((s) => s.reviewTask);
  const hasArchived = useWorldStore((s) => hasArchivedItems(s.planByProject[projectId]?.items ?? [], (s.taskIdsByProject[projectId] ?? []).map((id) => s.tasksById[id]).filter(Boolean)));
  // Lives in the store (`workspaceTab`), not local state, so `openNotificationTarget` can deep-link
  // into a non-default tab from outside this component's tree. `openWorkspace` resets it to 'tasks'
  // on every call — the reset that used to come from `key={workspaceProjectId}` remounting this
  // component (still kept below, for the rest of this component's genuinely-local state).
  const planItems = useWorldStore((s) => s.planByProject[projectId]?.items);
  const taskIds = useWorldStore((s) => s.taskIdsByProject[projectId]);
  const runs = useWorldStore((s) => s.workflowRunsByProject[projectId]);
  const queue = useWorldStore((s) => s.planItemQueueByProject[projectId]);
  const taskCounts = useMemo(() => countProjectTasks({ projectId, items: planItems, taskIds, runs, queue }, tasksById), [projectId, planItems, taskIds, runs, queue, tasksById]);
  const topTab = useWorldStore((s) => s.workspaceTab);
  const setTopTab = useWorldStore((s) => s.setWorkspaceTab);
  // The last archived task was unarchived or deleted while its tab was open: fall back to Tasks
  // (adjusting state during render, not in an effect — the tab it names no longer exists).
  if (topTab === 'archived' && !hasArchived) setTopTab('tasks');
  const prReading = usePrReading(projectId);
  usePrPolling(project);
  // The Git provider no longer recognises the repository: the PR tab is gone.
  if (topTab === 'pr' && project && !repositoryLinkOf(project)) setTopTab('tasks');
  // Which Settings section is open — lifted into the store (rather than owned by SettingsPanel) so
  // "Manage commands" below, and a `command.failed` Notification's deep link, can land on
  // Settings → Commands specifically, including when this tab is already open.
  const settingsSection = useWorldStore((s) => s.workspaceSettingsSection);
  const setSettingsSection = useWorldStore((s) => s.setWorkspaceSettingsSection);
  // Which command run's log popup is open, if any — purely ephemeral UI, so local state rather than
  // the store. The run keeps streaming in the background whether or not this is open.
  const [openCommandRunId, setOpenCommandRunId] = useState<string | null>(null);
  // The Agent terminal covering the tabs' body, if any. The session lives in the daemon, so closing the view never ends it.
  const [agentView, setAgentView] = useState(NO_AGENT_VIEW);
  // The WorkflowRun the Tasks tab should open on — set by the Testing tab's "Open task" link and a
  // Schedules history row's "Open run", cleared by any ordinary tab switch so a later visit to Tasks
  // starts on its usual list.
  const [tasksRunId, setTasksRunId] = useState<string | null>(null);
  const openRunInTasks = (runId: string) => { setTasksRunId(runId); setTopTab('tasks'); };
  // The planning session view's CLI/task-list width swap. Held here, not in the Tasks tab or the
  // session view, because both unmount on Back, opening a task and tab switches. This component
  // remounts on popup close and on a project switch, which is exactly when the choice resets.
  const [taskPanelArrangement, setTaskPanelArrangement] = useState<TaskPanelArrangement>(DEFAULT_TASK_PANEL_ARRANGEMENT);
  const taskPanelSwap: TaskPanelSwap = { arrangement: taskPanelArrangement, onToggle: () => setTaskPanelArrangement(toggleTaskPanelArrangement) };

  if (!project) return null;

  const kind = workspaceFor(project);
  if (kind === 'notes') {
    return (
      <NotesShell project={project} tab={topTab} onTab={(tab) => { setTasksRunId(null); setTopTab(tab); }} settingsSection={settingsSection} onSettingsSection={setSettingsSection}
        taskPanelSwap={taskPanelSwap} tasksRunId={tasksRunId} onOpenRun={openRunInTasks} />
    );
  }
  if (kind === 'seo') return <SeoShell project={project} />;
  if (kind === 'crm') return <CrmShell project={project} />;
  if (kind === 'content-studio') return <ContentStudioShell project={project} />;
  if (kind === 'unavailable') return <UnavailableShell project={project} />;

  const outOfSync = isOutOfSync(project.sync);
  const latestTask = lastTaskId ? tasksById[lastTaskId] : undefined;
  const visualStatus = buildingVisualStatus(project.status, latestTask, latestTaskReviewed, outOfSync);
  const attentionMessage = describeAttention(visualStatus, latestTaskReviewed ? undefined : latestTask, outOfSync, project.sync);
  const state = STATE_BADGES[project.status];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" aria-label={`${project.name} workspace`}>
      <div className="px-4 py-3.5 sm:px-6">
        <PageHeader
          size="md"
          titleAs={DialogTitle}
          lines={[project.name]}
          actions={(
            <>
              <HeaderCommands project={project} onRun={setOpenCommandRunId} onManage={() => { setTopTab('settings'); setSettingsSection('commands'); }} />
              <HeaderAgentSessions project={project} onOpen={(sessionId) => setAgentView(openAgentView(sessionId))} onDeleted={(sessionId) => setAgentView((view) => afterAgentSessionDeleted(view, sessionId))} />
              {project.repositoryUrl && (
                <>
                  <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
                  <RepositoryLink project={project} />
                  <BranchMenu project={project} onOpenCommandLog={setOpenCommandRunId} />
                </>
              )}
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close"><X aria-hidden="true" /></Button>
              </DialogClose>
            </>
          )}
        >
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Badge variant={state.variant}>
              <span className={`size-1.5 rounded-full ${state.dot}`} />
              {state.label}
            </Badge>
            <KpiRow items={[{ key: 'active', label: 'Running', value: taskCounts.active }, { key: 'blocked', label: 'Needs you', value: taskCounts.blocked }, { key: 'pending', label: 'Not started', value: taskCounts.pending }]} icons={{ active: <Activity />, blocked: <AlertCircle />, pending: <Lightbulb /> }} />
          </div>
        </PageHeader>
      </div>

      <ReadOnlyBanner project={project} />

      {attentionMessage && (
        <Alert variant="destructive" role="alert" className="flex shrink-0 items-center justify-between gap-3 rounded-none border-x-0 border-t-0 pr-3">
          <AlertDescription>{attentionMessage}</AlertDescription>
          {latestTask?.status === 'failed' && !latestTaskReviewed && (
            <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" onClick={() => reviewTask(latestTask.id)} aria-label="Dismiss task error" title="Dismiss">
              <X aria-hidden="true" />
            </Button>
          )}
        </Alert>
      )}

      {/* key={openCommandRunId} remounts the log when Re-run swaps in a new run id, so its local
          state (stopping/saving/rerunning) resets instead of carrying over from the previous run. */}
      {openCommandRunId && <CommandLogPopup key={openCommandRunId} runId={openCommandRunId} onClose={() => setOpenCommandRunId(null)} onRerun={setOpenCommandRunId} />}

      <WorkspaceTabBar tabs={workspaceTabs(project, { reading: prReading, hasArchived })} value={topTab} onChange={(tab) => { setTasksRunId(null); setAgentView(closeAgentView()); setTopTab(tab); }} />
      {agentView.openSessionId ? (
        <AgentTerminalView projectId={project.id} sessionId={agentView.openSessionId} onBack={() => setAgentView(closeAgentView())} />
      ) : (
      <WorkspaceBody project={project} tab={topTab} panels={{
        tasks: <TasksPanel project={project} initialRunId={tasksRunId} taskPanelSwap={taskPanelSwap} />,
        documents: <DocumentsPanel project={project} />,
        testing: <TestingPanel project={project} onOpenSetupTask={(runId) => { setTasksRunId(runId); setTopTab('tasks'); }} />,
        code: <CodePanel project={project} />,
        pr: <PrPanel project={project} />,
        archived: <ArchivedPanel project={project} />,
        settings: <SettingsPanel project={project} section={settingsSection} onSectionChange={setSettingsSection} onOpenCommandLog={setOpenCommandRunId} onOpenRun={openRunInTasks} />,
      } satisfies Record<WorkspaceTab, ReactNode>} />
      )}
    </div>
  );
}

function ReadOnlyBanner({ project }: { project: ProjectData }) {
  const notice = readOnlyNotice(project);
  if (!isBuildingReadOnly(project) || !notice) return null;
  return (
    <Alert role="status" className="shrink-0 rounded-none border-x-0 border-t-0">
      <AlertDescription>{notice}</AlertDescription>
    </Alert>
  );
}

function ShellHeader({ project }: { project: ProjectData }) {
  return (
    <header className="flex items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary">
          <FolderKanban className="size-4" aria-hidden="true" />
        </div>
        <DialogTitle className="truncate text-xl font-semibold tracking-tight">{project.name}</DialogTitle>
      </div>
      <DialogClose asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close"><X aria-hidden="true" /></Button>
      </DialogClose>
    </header>
  );
}

/**
 * The Notes workspace: Tasks (the platform's Tasks board, runs and Planning sessions, which every type gets), the type's own
 * Notes screen and Settings (which holds the generic Schedules, Connections and Activity). The Notes screen reuses the store's
 * 'documents' tab key (the tab union is shared with Software); a notification that deep-links to a Task lands on Tasks. No Git
 * wording: the Tasks board hides branch and pull-request controls for a Building with no repository.
 */
function NotesShell({ project, tab, onTab, settingsSection, onSettingsSection, taskPanelSwap, tasksRunId, onOpenRun }: {
  project: ProjectData;
  tab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  settingsSection: SettingsSection;
  onSettingsSection: (section: SettingsSection) => void;
  taskPanelSwap: TaskPanelSwap;
  tasksRunId: string | null;
  onOpenRun: (runId: string) => void;
}) {
  const tabs = notesTabs();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" aria-label={`${project.name} workspace`}>
      <ShellHeader project={project} />
      <ReadOnlyBanner project={project} />
      <WorkspaceTabBar tabs={tabs} value={tabOrTasks(tab, tabs)} onChange={onTab} />
      <WorkspaceBody project={project} tab={tabOrTasks(tab, tabs)} panels={{
        tasks: <TasksPanel project={project} initialRunId={tasksRunId} taskPanelSwap={taskPanelSwap} />,
        documents: <NotesWorkspace project={project} />,
        settings: <SettingsPanel project={project} section={settingsSection} onSectionChange={onSettingsSection} onOpenCommandLog={() => undefined} onOpenRun={onOpenRun} />,
      }} />
    </div>
  );
}

/** The SEO Building: its own eight tabs (see lib/seoWorkspace.ts) instead of the platform's workspace tabs. */
function SeoShell({ project }: { project: ProjectData }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" aria-label={`${project.name} workspace`}>
      <ShellHeader project={project} />
      <ReadOnlyBanner project={project} />
      <SeoWorkspace project={project} />
    </div>
  );
}

/** The CRM Building: its own nine tabs (see lib/crmWorkspace.ts) instead of the platform's workspace tabs. */
function CrmShell({ project }: { project: ProjectData }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" aria-label={`${project.name} workspace`}>
      <ShellHeader project={project} />
      <ReadOnlyBanner project={project} />
      <CrmWorkspace project={project} readOnly={isBuildingReadOnly(project)} />
    </div>
  );
}

/** The Content Studio Building: its own four tabs (see lib/contentWorkspace.ts) instead of the platform's workspace tabs. */
function ContentStudioShell({ project }: { project: ProjectData }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" aria-label={`${project.name} workspace`}>
      <ShellHeader project={project} />
      <ReadOnlyBanner project={project} />
      <ContentStudioWorkspace project={project} readOnly={isBuildingReadOnly(project)} />
    </div>
  );
}

/** A Building whose type is gone or unknown to this app: a read-only shell. */
function UnavailableShell({ project }: { project: ProjectData }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" aria-label={`${project.name} workspace`}>
      <ShellHeader project={project} />
      <ReadOnlyBanner project={project} />
      <div className="flex-1 overflow-y-auto p-6">
        <h3 className="text-base font-semibold tracking-tight">This Building's type is unavailable</h3>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">Its data is kept as it was and can be read, but nothing can be changed until the type is available again.</p>
      </div>
    </div>
  );
}
