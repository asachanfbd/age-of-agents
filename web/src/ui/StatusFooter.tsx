import { useMemo, useReducer } from 'react';
import { Bell } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorldStore } from '../store/worldStore';
import { sortExecutorsByUsage } from '../lib/executorUsage';
import { countUnreadNotifications } from '../lib/notificationCenter';
import { summarizeProjectStatus } from '../lib/projectStatus';
import { summarizeWorkspaceCounts } from '../lib/workspaceCounts';
import { buildRunningGroups, countRunningRows, runningCommandsLabel } from '../lib/runningCommands';
import { footerPopoverReducer } from '../lib/footerPopoverState';
import { APP_UPDATE_TONE_DOT_CLASS, describeAppUpdateFooterLabel } from '../lib/appUpdate';
import { prsTriggerLabel } from '../lib/footerPullRequests';
import { useFooterPrPolling, useFooterPrSummary } from '../lib/useFooterPullRequests';
import { AppUpdatePopover } from './AppUpdatePopover';
import { ExecutorFooterItem } from './ExecutorFooterItem';
import { FooterCountPopover } from './FooterCountPopover';
import { CommandsListPopover, ProjectListPopover } from './FooterListPopovers';
import { PullRequestsListPopover } from './FooterPullRequestsPopover';
import { PlanningSessionsCount } from './PlanningSessionsPopover';
import { TasksCountPopover } from './TasksPopover';

/**
 * One count: an optional status dot and the number. The word that names it ("working", "pending") is read
 * out but not drawn, except where `showLabel` keeps it visible from `sm` up; the tooltip always carries the
 * full wording.
 */
function StatusCount({ value, label, showLabel = false, fullLabel, dot, muted = false }: {
  value: number;
  label: string;
  showLabel?: boolean;
  fullLabel: string;
  dot?: string;
  muted?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground" title={`${value} ${fullLabel}`}>
      {dot && <i aria-hidden="true" className={`inline-block h-[5px] w-[5px] rounded-full ${dot}`} />}
      <strong className={`font-semibold tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>{value}</strong>
      <span className={showLabel ? 'max-sm:sr-only' : 'sr-only'}>{label}</span>
    </span>
  );
}

/** A group of counts under a visible heading, divided from the group before it. */
function CountGroup({ ariaLabel, heading, children }: { ariaLabel: string; heading: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-none flex-col justify-center gap-0.5 border-l border-border pl-3.5 first:border-l-0 first:pl-0 max-sm:pl-2.5">
      <span aria-hidden="true" className="text-[9px] font-bold uppercase leading-[11px] tracking-[0.12em] text-muted-foreground">{heading}</span>
      <div className="flex items-center gap-2.5 max-sm:gap-2">{children}</div>
    </div>
  );
}

function AgentUsage() {
  const executors = useWorldStore((s) => s.executors);
  const openAnalytics = useWorldStore((s) => s.openAnalytics);
  const sortedExecutors = sortExecutorsByUsage(executors);

  if (sortedExecutors.length === 0) {
    return <button type="button" onClick={() => openAnalytics(null)} className="flex-none whitespace-nowrap rounded-sm px-1 text-[11px] italic text-muted-foreground">No coding agents configured</button>;
  }
  return (
    <div className="flex flex-none items-stretch gap-0" role="radiogroup" aria-label="Default coding agent">
      {sortedExecutors.map((executor, index) => (
        <div
          className={`flex flex-none items-center whitespace-nowrap pr-4 ${index < sortedExecutors.length - 1 ? 'mr-4 border-r border-border' : ''}`}
          key={executor.id}
        >
          <ExecutorFooterItem executor={executor} />
        </div>
      ))}
    </div>
  );
}

function WorkspaceCountsSection() {
  const projects = useWorldStore((s) => s.projects);
  const planByProject = useWorldStore((s) => s.planByProject);
  const taskIdsByProject = useWorldStore((s) => s.taskIdsByProject);
  const workflowRunsByProject = useWorldStore((s) => s.workflowRunsByProject);
  const tasksById = useWorldStore((s) => s.tasksById);
  const commandRunsById = useWorldStore((s) => s.commandRunsById);
  const testRunsById = useWorldStore((s) => s.testRunsById);
  const seoJobsById = useWorldStore((s) => s.seoJobsById);
  const contentJobsById = useWorldStore((s) => s.contentJobsById);
  const [popover, dispatch] = useReducer(footerPopoverReducer, null);
  const running = useMemo(
    () => countRunningRows(buildRunningGroups({ projects, commandRunsById, testRunsById, seoJobsById, contentJobsById })),
    [projects, commandRunsById, testRunsById, seoJobsById, contentJobsById],
  );
  const prs = useFooterPrSummary();
  const projectStatus = summarizeProjectStatus(projects);
  const liveTerminalSessions = useWorldStore((s) => s.liveTerminalSessions);
  const { tasks } = useMemo(
    () => summarizeWorkspaceCounts({ projects, planByProject, taskIdsByProject, workflowRunsByProject, tasksById }),
    [projects, planByProject, taskIdsByProject, workflowRunsByProject, tasksById],
  );

  return (
    <div className="ml-auto flex flex-none items-center gap-3.5 pl-5 max-sm:gap-2.5 max-sm:pl-3">
      <CountGroup ariaLabel="Projects" heading="Projects">
        <StatusCount value={projectStatus.total} label="projects" fullLabel="projects" />
        <FooterCountPopover id="projects-working" label={`${projectStatus.working} projects working`} state={popover} dispatch={dispatch} trigger={<StatusCount value={projectStatus.working} label="working" fullLabel="projects working" dot="bg-warning" />}>
          {(close) => <ProjectListPopover kind="working" onDone={close} />}
        </FooterCountPopover>
        <FooterCountPopover id="projects-blocked" label={`${projectStatus.blocked} projects blocked`} state={popover} dispatch={dispatch} trigger={<StatusCount value={projectStatus.blocked} label="blocked" fullLabel="projects blocked" dot="bg-destructive" />}>
          {(close) => <ProjectListPopover kind="blocked" onDone={close} />}
        </FooterCountPopover>
      </CountGroup>
      <CountGroup ariaLabel="Tasks across all projects" heading="Tasks">
        <TasksCountPopover
          state={popover}
          dispatch={dispatch}
          triggers={[
            { kind: 'active', label: `${tasks.active} active tasks`, node: <StatusCount value={tasks.active} label="active" fullLabel="active tasks" dot="bg-warning" /> },
            { kind: 'blocked', label: `${tasks.blocked} blocked tasks`, node: <StatusCount value={tasks.blocked} label="blocked" fullLabel="blocked tasks" dot="bg-destructive" /> },
            { kind: 'pending', label: `${tasks.pending} pending tasks`, node: <StatusCount value={tasks.pending} label="pending" showLabel fullLabel="pending tasks" dot="bg-muted-foreground" /> },
          ]}
        />
      </CountGroup>
      <CountGroup ariaLabel="Live sessions across all projects" heading="Sessions">
        <PlanningSessionsCount value={liveTerminalSessions.length} />
      </CountGroup>
      <CountGroup ariaLabel="Running commands across all projects" heading="Commands">
        <FooterCountPopover id="commands-running" label={runningCommandsLabel(running)} state={popover} dispatch={dispatch} trigger={<StatusCount value={running} label="running" fullLabel="running commands" dot={running > 0 ? 'bg-warning' : 'bg-muted-foreground/40'} muted={running === 0} />}>
          {(close) => <CommandsListPopover onDone={close} />}
        </FooterCountPopover>
      </CountGroup>
      {prs.visible && (
        <CountGroup ariaLabel="Open pull requests across all projects" heading="PRs">
          <FooterCountPopover id="pull-requests-open" label={prsTriggerLabel(prs)} state={popover} dispatch={dispatch} trigger={<PullRequestsCount total={prs.total} unavailable={prs.unavailable} />}>
            {(close) => <PullRequestsListPopover summary={prs} onDone={close} />}
          </FooterCountPopover>
        </CountGroup>
      )}
    </div>
  );
}

/** The PRs number; projects whose reading is unavailable add a static "!" marker (never counted as zero). */
function PullRequestsCount({ total, unavailable }: { total: number; unavailable: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <StatusCount value={total} label="open" fullLabel="open pull requests" dot={total > 0 ? 'bg-warning' : 'bg-muted-foreground/40'} muted={total === 0} />
      {unavailable > 0 && (
        <span aria-hidden="true" title={`${unavailable} unavailable`} className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-warning px-0.5 text-[9px] font-bold leading-none text-warning-foreground">!</span>
      )}
    </span>
  );
}

/**
 * The app-update footer item (task 7.001) — a status footer pattern of its own, not a `CountGroup`:
 * one item, no number-vs-label split, since its text already carries any count ("Update available
 * (3)"). Always rendered once the first status has loaded; never hidden for "up to date", so
 * "Check now" always has an entry point (see `lib/appUpdate.ts`'s doc comment). Reuses
 * `FooterCountPopover` verbatim for the hover/pin/Esc/outside-click shell — only the content
 * (`AppUpdatePopover`) is new.
 */
function AppUpdateSection() {
  const appUpdate = useWorldStore((s) => s.appUpdate);
  const [popover, dispatch] = useReducer(footerPopoverReducer, null);
  if (!appUpdate) return null;
  const { text, tone } = describeAppUpdateFooterLabel(appUpdate);
  return (
    <div className="ml-3.5 flex flex-none items-center border-l border-border pl-3.5 max-sm:ml-2.5 max-sm:pl-2.5">
      <FooterCountPopover id="app-update" label={text} state={popover} dispatch={dispatch} trigger={
        <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold text-foreground" title={text}>
          <i aria-hidden="true" className={`inline-block h-[7px] w-[7px] rounded-full ${APP_UPDATE_TONE_DOT_CLASS[tone]}`} />
          {text}
        </span>
      }>
        {() => <AppUpdatePopover status={appUpdate} />}
      </FooterCountPopover>
    </div>
  );
}

/** Toggles the Notifications drawer, over whatever popup is open; pressed while the drawer is open. */
function NotificationBell() {
  const notificationsById = useWorldStore((s) => s.notificationsById);
  const errorNotificationsById = useWorldStore((s) => s.errorNotificationsById);
  const notificationCenterOpen = useWorldStore((s) => s.notificationCenterOpen);
  const toggleNotificationCenter = useWorldStore((s) => s.toggleNotificationCenter);
  const unreadNotificationCount = countUnreadNotifications(notificationsById, errorNotificationsById);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="relative grid w-[52px] flex-none place-items-center border-l border-border text-foreground transition-colors hover:bg-accent aria-pressed:bg-primary/10 aria-pressed:shadow-[inset_0_2px_0_var(--color-primary)] max-sm:w-[46px]"
          onClick={toggleNotificationCenter}
          aria-pressed={notificationCenterOpen}
          aria-label={unreadNotificationCount > 0 ? `Open notifications (${unreadNotificationCount} unread)` : 'Open notifications'}
        >
          <Bell className="size-4" />
          {unreadNotificationCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute right-1.5 top-0.5 h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none"
            >
              {unreadNotificationCount}
            </Badge>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">Notifications</TooltipContent>
    </Tooltip>
  );
}

/**
 * The fixed full-width status footer: coding agents' usage, workspace-wide counts, and the notifications
 * bell. It sits above every popup's scrim and stays clickable while one is open — modal popups ignore
 * outside clicks that land on it (see `isStatusFooterTarget`) — and popups are sized to stop above it.
 * Agents and counts share one row that scrolls sideways when it doesn't fit; the bell stays pinned right.
 */
export function StatusFooter() {
  useFooterPrPolling();
  return (
    <>
      <footer
        data-status-footer
        aria-label="Workspace status"
        className="pointer-events-auto fixed inset-x-0 bottom-0 z-[160] flex h-[var(--status-footer-height)] items-stretch glass rounded-none border-x-0 border-b-0"
      >
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-4 py-[5px] [scrollbar-width:none] max-sm:px-3">
          <AgentUsage />
          <WorkspaceCountsSection />
          <AppUpdateSection />
        </div>
        <NotificationBell />
      </footer>
    </>
  );
}
