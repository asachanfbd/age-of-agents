import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCheck, Download, FlaskConical, FolderKanban, GitMerge, Lightbulb, ListChecks, Sparkles, Terminal } from 'lucide-react';
import type { ComponentType } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useWorldStore } from '../store/worldStore';
import type { NotificationSeverity } from '../lib/serverApi';
import { isErrorNotification } from '../lib/errorNotifications';
import type { DrawerNotification } from '../lib/errorNotifications';
import {
  DEFAULT_NOTIFICATION_DRAWER_FILTER,
  countUnreadNotifications,
  filterNotifications,
  quickActionFor,
} from '../lib/notificationCenter';
import type { NotificationDrawerFilter } from '../lib/notificationCenter';
import { RelativeTime } from './design/RelativeTime';

const PAGE_SIZE = 10;

function severityBadgeVariant(severity: NotificationSeverity): 'secondary' | 'warning' | 'destructive' {
  if (severity === 'critical') return 'destructive';
  if (severity === 'warning') return 'warning';
  return 'secondary';
}

const PENDING_LABEL: Record<string, string> = { Reply: 'Replying…', Retry: 'Retrying…', 'Run again': 'Running…', Sync: 'Syncing…' };

/** Strips the kind-specific prefix a title was built with (see workerManager.ts/gitSyncPoller.ts/etc.), leaving just the specific part for the chip. */
function chipLabel(n: DrawerNotification): string {
  return n.title.replace(/^(Task completed: |Task failed: |Needs your input: |Command "|Skill install "|")/, '').replace(/" (failed|completed)$/, '');
}

/** The target chip's icon + label, by subject type — see docs/milestones/milestone-5-notification-system.md's Part 5. */
function targetChip(n: DrawerNotification, projectName: (id: string | null) => string): { icon: ComponentType<{ className?: string }>; label: string } {
  switch (n.subject.type) {
    case 'error':
      return { icon: AlertTriangle, label: 'Error' };
    case 'task':
      return { icon: /^Planning session #\d+ finished$/.test(n.title) ? Lightbulb : ListChecks, label: chipLabel(n) };
    case 'command':
      return { icon: Terminal, label: chipLabel(n) };
    case 'project':
      return { icon: FolderKanban, label: projectName(n.projectId) };
    case 'testRun':
      return { icon: FlaskConical, label: chipLabel(n) };
    case 'skill':
      return { icon: Sparkles, label: n.subject.repo };
    case 'app':
      return { icon: Download, label: n.kind === 'executor.default_switched' ? 'Default agent' : 'App update' };
    case 'scheduledJob':
      return { icon: CalendarClock, label: projectName(n.projectId) };
    case 'autoMerge':
      return { icon: GitMerge, label: projectName(n.projectId) };
  }
}

function NotificationRow({ notification, projectName, onOpen }: {
  notification: DrawerNotification;
  projectName: (id: string | null) => string;
  onOpen: (n: DrawerNotification) => void;
}) {
  const markNotificationsRead = useWorldStore((s) => s.markNotificationsRead);
  const markNotificationUnread = useWorldStore((s) => s.markNotificationUnread);
  const runNotificationQuickAction = useWorldStore((s) => s.runNotificationQuickAction);
  const [pending, setPending] = useState(false);
  const unread = notification.readAt === null;
  const chip = targetChip(notification, projectName);
  const Icon = chip.icon;
  const action = quickActionFor(notification);

  return (
    <li className={`flex flex-col gap-2 rounded-xl p-3 ${unread ? 'bg-accent/60' : 'bg-card/50'}`}>
      <button
        type="button"
        className="flex flex-col items-start gap-1.5 text-left"
        onClick={() => onOpen(notification)}
      >
        <div className="flex w-full items-start justify-between gap-2">
          <p className={`text-sm font-semibold ${unread ? 'text-foreground' : 'font-medium text-muted-foreground'}`}>{notification.title}</p>
          <button
            type="button"
            aria-label={unread ? 'Mark as read' : 'Mark as unread'}
            className="shrink-0 rounded p-1 hover:bg-accent"
            onClick={(event) => {
              event.stopPropagation();
              if (unread) void markNotificationsRead([notification.id]);
              else void markNotificationUnread(notification.id);
            }}
          >
            <span className={`block size-2.5 rounded-full ${unread ? 'bg-info' : 'ring-1 ring-inset ring-muted-foreground'}`} />
          </button>
        </div>
        {notification.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{notification.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={severityBadgeVariant(notification.severity)}>{notification.severity}</Badge>
          {notification.resolvedAt && <Badge variant="success">Resolved</Badge>}
          {isErrorNotification(notification) && notification.count > 1 && <Badge variant="secondary">×{notification.count}</Badge>}
          <span className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            <Icon className="size-3" aria-hidden="true" />
            {chip.label}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {projectName(notification.projectId)} · <RelativeTime at={notification.updatedAt} />
        </p>
      </button>
      {action && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={async (event) => {
              event.stopPropagation();
              setPending(true);
              await runNotificationQuickAction(notification);
              setPending(false);
            }}
          >
            {pending ? PENDING_LABEL[action.label] : action.label}
          </Button>
        </div>
      )}
    </li>
  );
}

const STATE_OPTIONS: { value: NotificationDrawerFilter['state']; label: string }[] = [
  { value: 'all', label: 'Any state' },
  { value: 'active', label: 'Active' },
  { value: 'resolved', label: 'Resolved' },
];

const SEVERITY_OPTIONS: { value: NotificationSeverity | 'all'; label: string }[] = [
  { value: 'all', label: 'Any severity' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

/**
 * The Notifications drawer — a right-side Sheet listing every Notification matching the local
 * filter under an Unread/Read tab (docs/milestones/milestone-5-notification-system.md). Replaces
 * the old status-based Notification Center dialog. Opened via the existing
 * `notificationCenterOpen`/`toggleNotificationCenter`/`closeNotificationCenter` API (the status footer's
 * bell). It stacks above the Project Workspace and Catalog popups, so it opens over them and closing it
 * returns to them unchanged.
 */
export function NotificationCenter() {
  const notificationCenterOpen = useWorldStore((s) => s.notificationCenterOpen);
  const closeNotificationCenter = useWorldStore((s) => s.closeNotificationCenter);
  const notificationsById = useWorldStore((s) => s.notificationsById);
  const projects = useWorldStore((s) => s.projects);
  const errorNotificationsById = useWorldStore((s) => s.errorNotificationsById);
  const openNotificationTarget = useWorldStore((s) => s.openNotificationTarget);
  const markAllNotificationsRead = useWorldStore((s) => s.markAllNotificationsRead);

  const [filter, setFilter] = useState<NotificationDrawerFilter>(DEFAULT_NOTIFICATION_DRAWER_FILTER);
  const [tab, setTab] = useState<'unread' | 'read'>('unread');
  const [page, setPage] = useState(1);
  /** Which tab a row belongs in, fixed the instant the drawer opens — see this component's own doc comment and the Part 5 spec: toggling a row's dot only flips its own indicator until the next open. */
  const tabSnapshotRef = useRef<Record<string, 'unread' | 'read'>>({});
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (notificationCenterOpen && !wasOpenRef.current) {
      tabSnapshotRef.current = Object.fromEntries(
        Object.values({ ...notificationsById, ...errorNotificationsById }).map((n) => [n.id, n.readAt === null ? 'unread' : 'read']),
      );
      setTab('unread');
      setPage(1);
    }
    wasOpenRef.current = notificationCenterOpen;
    // Only re-snapshot on the open transition — notificationsById changing while open must not reshuffle tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationCenterOpen]);

  if (!notificationCenterOpen) return null;

  const projectName = (projectId: string | null) => {
    if (projectId === null) return 'System';
    return projects.find((p) => p.id === projectId)?.name ?? 'Unknown project';
  };

  const allNotifications: Record<string, DrawerNotification> = { ...notificationsById, ...errorNotificationsById };
  const filtered = filterNotifications(allNotifications, filter);
  const unreadRows = filtered.filter((n) => (tabSnapshotRef.current[n.id] ?? (n.readAt === null ? 'unread' : 'read')) === 'unread');
  const readRows = filtered.filter((n) => (tabSnapshotRef.current[n.id] ?? (n.readAt === null ? 'unread' : 'read')) === 'read');
  const rows = tab === 'unread' ? unreadRows : readRows;
  const visible = rows.slice(0, page * PAGE_SIZE);
  const remaining = rows.length - visible.length;

  const unreadCount = countUnreadNotifications(notificationsById, errorNotificationsById);
  const markAllDisabled = !filtered.some((n) => n.readAt === null);

  function updateFilter(patch: Partial<NotificationDrawerFilter>) {
    setFilter((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  async function openRow(n: DrawerNotification) {
    await openNotificationTarget(n);
    closeNotificationCenter();
  }

  async function markAllVisible() {
    await markAllNotificationsRead({
      read: false,
      resolved: filter.state === 'all' ? undefined : filter.state === 'active' ? false : true,
      severity: filter.severity === 'all' ? undefined : filter.severity,
      projectId: filter.project === 'all' ? undefined : filter.project,
    });
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) closeNotificationCenter(); }}>
      <SheetContent
        side="right"
        className="glass flex w-[min(448px,calc(100%-2.5rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none"
        aria-describedby={undefined}
      >
        <SheetHeader className="flex-row items-start justify-between gap-2 space-y-0 border-b border-border px-4 py-3.5">
          <div>
            <SheetTitle>{unreadCount} unread notifications</SheetTitle>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={markAllDisabled} onClick={() => void markAllVisible()}>
            <CheckCheck aria-hidden="true" /> Mark all as read
          </Button>
        </SheetHeader>

        <div className="flex gap-1 rounded-control bg-muted p-1 mx-4 mt-3" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'unread'}
            className={`flex-1 rounded-control py-1.5 text-sm font-medium ${tab === 'unread' ? 'bg-card shadow-xs' : 'text-muted-foreground'}`}
            onClick={() => { setTab('unread'); setPage(1); }}
          >
            Unread <span className="text-xs">({unreadRows.length})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'read'}
            className={`flex-1 rounded-control py-1.5 text-sm font-medium ${tab === 'read' ? 'bg-card shadow-xs' : 'text-muted-foreground'}`}
            onClick={() => { setTab('read'); setPage(1); }}
          >
            Read <span className="text-xs">({readRows.length})</span>
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 px-4 py-3">
          <Select value={filter.state} onValueChange={(value) => updateFilter({ state: value as NotificationDrawerFilter['state'] })}>
            <SelectTrigger size="sm" aria-label="Filter by state"><SelectValue /></SelectTrigger>
            <SelectContent>{STATE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={filter.severity} onValueChange={(value) => updateFilter({ severity: value as NotificationSeverity | 'all' })}>
            <SelectTrigger size="sm" aria-label="Filter by severity"><SelectValue /></SelectTrigger>
            <SelectContent>{SEVERITY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={filter.project} onValueChange={(value) => updateFilter({ project: value })}>
            <SelectTrigger size="sm" aria-label="Filter by project"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              <SelectItem value="none">System</SelectItem>
              {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          {rows.length === 0 ? (
            <p className="py-10 text-center text-sm italic text-muted-foreground">
              {tab === 'read'
                ? 'Nothing here yet. Notifications you read will show up here.'
                : 'Nothing here. You’re all caught up.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((n) => <NotificationRow key={n.id} notification={n} projectName={projectName} onOpen={openRow} />)}
            </ul>
          )}

          {remaining > 0 && (
            <Button type="button" variant="outline" className="w-full" onClick={() => setPage((p) => p + 1)}>
              Load more ({remaining} of {rows.length} remaining)
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
