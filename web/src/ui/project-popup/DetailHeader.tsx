import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Archive, ArchiveRestore, ArrowLeft, Bug, ChevronDown, ChevronUp, CircleCheck, Copy, GitCommitHorizontal, Pencil, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CopyButton } from '../CopyButton';
import { MarkdownDocument } from '../MarkdownDocument';
import { archiveBlockedReason, latestItemTask, planItemActions, planItemSpentMs, workerLabel } from '../../lib/projectTasks';
import {
  BUG_BADGE_LABEL, INFO_STATUS_LABELS, bugDetailRows, canChangeInfoStatus, canReportRegression, isBugItem, regressionDateLabel, regressionReporterLabel, regressionsNewestFirst,
} from '../../lib/bugs';
import type { BugInfoStatus } from '../../lib/bugs';
import type { WorkflowRunRecord } from '../../lib/serverApi';
import { runControl, runTimingParts, taskItemInfo } from '../../lib/taskBoard';
import { useNow } from '../../lib/useNow';
import { useWorldStore } from '../../store/worldStore';
import type { PlanItemData, TaskData } from '../../types';
import { hasAutoMerge } from '../../lib/autoMerge';
import { detailStatus } from '../../lib/taskPullRequest';
import { AutoMergePanel, AutoMergeSwitch, AutoMergeUnavailable } from './AutoMergeControl';
import { DependsOnSection } from './DependenciesControl';
import { ConfirmDialog, ReportRegressionDialog } from './TaskDialogs';
import { TaskEditForm } from './TaskEditForm';
import type { TaskActions } from './useTaskActions';

/** How often the header's "time spent" re-reads the clock — it's shown to the minute. */
const SPENT_TICK_MS = 15_000;

const EMPTY_TASKS: TaskData[] = [];

/** Editing the task in place: the section's Edit button (`onEdit`) swaps the description for the board's `TaskEditForm` while `editing`. */
export interface DetailEditing {
  editing: boolean;
  onEdit: () => void;
  onSave: (patch: { title: string; description: string }) => void;
  onCancel: () => void;
}

/** Lines the expanded section up with the title: the header's side padding plus the Back button (2rem) and the gap after it (0.625rem) — `pl-10.5` inside the padded rows. */
export const TITLE_INDENT = 'pl-14.5 sm:pl-16.5';

/**
 * The header every Tasks-tab task detail shares (a WorkflowRun's, a not-started task's). Top row: Back,
 * the title, the status badge, Stop/Resume (`runControl`), a Start icon while the task can be started
 * (`onStart`), and the chevron that expands the rarely-needed rest (`DetailMore`, collapsed by default).
 * Second row: planning provenance when present, start/end, time spent and the coding agent.
 * The Tasks tab's action alerts (`alerts`) sit right under it. With `fill` (a task with nothing
 * run yet, so nothing below the header) it starts expanded and the description takes the view's remaining height.
 */
export function DetailHeader({
  item,
  run,
  status: reportedStatus,
  actions,
  alerts,
  links,
  editing,
  onStart,
  fill = false,
  onBack,
}: {
  /** Undefined only while the project's plan hasn't loaded yet. */
  item: PlanItemData | undefined;
  run: WorkflowRunRecord | null;
  status: { label: string; variant: BadgeProps['variant'] };
  actions: TaskActions;
  alerts: ReactNode;
  /** The run's branch/PR, shown in the expanded section. */
  links?: ReactNode;
  /** Given only while the task can be edited — offers Edit in the expanded section. */
  editing?: DetailEditing;
  /** Given only while the task can be started — opens the start dialog. */
  onStart?: () => void;
  /** Start expanded, with the header filling its container's height — for a view with nothing under it. */
  fill?: boolean;
  onBack: () => void;
}) {
  const tasksById = useWorldStore((s) => s.tasksById);
  const executors = useWorldStore((s) => s.executors);
  const now = useNow(SPENT_TICK_MS);
  const [expanded, setExpanded] = useState(fill);
  const open = expanded || !!editing?.editing;

  const status = detailStatus(reportedStatus, item, run?.status === 'completed' || item?.status === 'done');
  const info = item ? taskItemInfo(item, tasksById) : null;
  const tasks = item ? item.taskIds.map((id) => tasksById[id]).filter((task): task is TaskData => !!task) : EMPTY_TASKS;
  // A not-started task (no run yet) shows no agent — it isn't chosen until the Start task dialog. A waiting
  // dependent task was already started, so it shows the agent picked then.
  const waitingExecutorId = item?.waiting?.options.executorId;
  const facts = run ? [...(info?.number ? [info.number] : []), ...(item?.planningRef || item?.planningTaskId ? [info!.provenance] : []), ...runTimingParts(run, item ? planItemSpentMs(item, tasksById, now) : 0), workerLabel(executors, item?.executorId ?? run?.executorId ?? null)] : [...(info?.meta ?? []), ...(waitingExecutorId ? [workerLabel(executors, waitingExecutorId)] : [])];

  const filling = fill && open;

  return (
    <header className={filling ? 'flex min-h-0 flex-1 flex-col' : 'shrink-0 border-b'}>
      <div className="flex flex-col gap-1 px-4 py-3 sm:px-6">
        <div className="flex items-start gap-2.5">
          <DetailBackButton onBack={onBack} />
          <h3 className="min-w-0 flex-1 pt-1.5 text-sm font-semibold leading-snug">{info?.name ?? 'Loading…'}</h3>
          <div className="flex shrink-0 items-center gap-2">
            {item && isBugItem(item) && <Badge variant="soft-destructive"><Bug aria-hidden="true" /> {BUG_BADGE_LABEL}</Badge>}
            <Badge variant={status.variant}>{status.label}</Badge>
            {hasAutoMerge(item) && <AutoMergeSwitch item={item} run={run} />}
            {run && <RunControlButton runId={run.id} control={runControl(run, tasks)} actions={actions} />}
            {onStart && <HeaderIconButton label="Start task" icon={Play} onClick={onStart} />}
            <HeaderIconButton label={open ? 'Hide task details' : 'Show task details'} icon={open ? ChevronUp : ChevronDown} expanded={open} onClick={() => setExpanded(!open)} />
          </div>
        </div>
        <p className="truncate pl-10.5 text-xs text-muted-foreground">{facts.join(' · ')}</p>
        {hasAutoMerge(item) && <AutoMergeUnavailable item={item} run={run} />}
        {hasAutoMerge(item) && <AutoMergePanel item={item} />}
      </div>
      {item && <div className="px-4 pb-3 pl-14.5 sm:px-6 sm:pl-16.5 empty:hidden"><DependsOnSection item={item} /></div>}
      {open && item && (
        <DetailMore item={item} fill={filling} sessionId={latestItemTask(item, tasksById)?.sessionId ?? null} links={links} editing={editing} actions={actions} onBack={onBack} />
      )}
      <div className="empty:hidden">{alerts}</div>
    </header>
  );
}

/** A top-row icon action with a tooltip naming it. */
export function HeaderIconButton({ label, icon: Icon, expanded, onClick }: { label: string; icon: ComponentType; /** Set for the toggle that shows `DetailMore`. */ expanded?: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={expanded === undefined ? undefined : 'task-detail-more'}
          onClick={onClick}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Stop while a CLI of the run is live, Resume once it's stopped — failures (e.g. a 409) land in the header's alerts. */
function RunControlButton({ runId, control, actions }: { runId: string; control: ReturnType<typeof runControl>; actions: TaskActions }) {
  const [busy, setBusy] = useState(false);
  if (!control) return null;
  const stop = control === 'stop';
  async function act() {
    setBusy(true);
    await (stop ? actions.stopRun(runId) : actions.resumeRun(runId));
    setBusy(false);
  }
  return (
    <Button type="button" variant={stop ? 'destructive' : 'default'} size="sm" disabled={busy} onClick={() => void act()}>
      {stop ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
      {stop ? (busy ? 'Stopping…' : 'Stop') : (busy ? 'Resuming…' : 'Resume')}
    </Button>
  );
}

/**
 * The header's expanded section, on the title's column and separated by whitespace, not boxes: plain
 * label/value rows (session id, branch), the task description (copy on its label's row, in the one
 * tinted scroll box), then Edit and the rarely-used item actions in one row under a divider.
 */
function DetailMore({
  item,
  fill,
  sessionId,
  links,
  editing,
  actions,
  onBack,
}: {
  item: PlanItemData;
  /** Grow the description box to the remaining height instead of capping it. */
  fill: boolean;
  sessionId: string | null;
  links?: ReactNode;
  editing?: DetailEditing;
  actions: TaskActions;
  onBack: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reporting, setReporting] = useState(false);
  const { canComplete, canDelete } = planItemActions(item);
  const archiveReason = archiveBlockedReason(item);
  const latest = latestItemTask(item, useWorldStore.getState().tasksById);

  return (
    <div id="task-detail-more" className={fill ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      <div className={`flex flex-col gap-3 pb-4 pr-4 sm:pr-6 ${TITLE_INDENT} ${fill ? 'min-h-0 flex-1' : ''}`}>
        {sessionId && (
          <DetailRow label="Session ID">
            <code className="min-w-0 truncate font-mono text-xs select-text">{sessionId}</code>
            <CopyButton text={sessionId} label="Copy session ID" className="size-6" />
          </DetailRow>
        )}
        {links && <DetailRow label="Branch">{links}</DetailRow>}
        {isBugItem(item) && <BugDetails item={item} actions={actions} />}
        <section aria-label="Task description" className={`flex flex-col gap-1.5 ${fill ? 'min-h-0 flex-1' : ''}`}>
          <div className="flex h-6 items-center justify-between gap-2">
            <DetailLabel>Task description</DetailLabel>
            {!editing?.editing && <CopyButton text={item.description} label="Copy task description" className="size-6" disabled={!item.description.trim()} />}
          </div>
          {editing?.editing ? (
            <TaskEditForm title={item.title} description={item.description} onSave={editing.onSave} onCancel={editing.onCancel} />
          ) : (
            <div className={`overflow-y-auto rounded-md ${fill ? 'min-h-0 flex-1' : 'max-h-64'} bg-muted/50 px-3 py-2`}>
              <TaskSpecification description={item.description} />
            </div>
          )}
        </section>
      </div>
      <Separator />
      <div className={`flex flex-wrap items-center gap-2 py-3 pr-4 sm:pr-6 ${TITLE_INDENT}`}>
        {editing && !editing.editing && (
          <Button type="button" variant="secondary" size="sm" onClick={editing.onEdit}>
            <Pencil aria-hidden="true" /> Edit
          </Button>
        )}
        <Button type="button" variant="secondary" size="sm" onClick={() => void actions.duplicate({ title: item.title, description: item.description })}>
          <Copy aria-hidden="true" /> Duplicate
        </Button>
        {latest && (latest.status === 'developing' || latest.status === 'blocked') && latest.branch && (
          <Button type="button" variant="secondary" size="sm" onClick={() => void actions.interimCommit({ latestTaskId: latest.id })}>
            <GitCommitHorizontal aria-hidden="true" /> Interim commit
          </Button>
        )}
        {item.archived ? (
          <Button type="button" variant="secondary" size="sm" title="Put this task back on the board" onClick={() => void actions.unarchive(item.id).then((ok) => ok && onBack())}>
            <ArchiveRestore aria-hidden="true" /> Unarchive
          </Button>
        ) : (
          <Button type="button" variant="secondary" size="sm" disabled={!!archiveReason} title={archiveReason ?? 'Hide this task from the board'} onClick={() => void actions.archive(item.id).then((ok) => ok && onBack())}>
            <Archive aria-hidden="true" /> Archive
          </Button>
        )}
        {canComplete && (
          <Button type="button" variant="secondary" size="sm" title="Commit its changes and mark it done without running the remaining steps" onClick={() => void actions.complete([{ id: item.id, completesViaSession: false, latestTaskId: null }])}>
            <CircleCheck aria-hidden="true" /> Mark complete
          </Button>
        )}
        {canReportRegression(item) && (
          <Button type="button" variant="secondary" size="sm" title="The fix did not work: run every step again as the next round" onClick={() => setReporting(true)}>
            <RotateCcw aria-hidden="true" /> Report regression
          </Button>
        )}
        {archiveReason && <p className="text-xs text-muted-foreground">{archiveReason}</p>}
        {canDelete && (
          <Button type="button" variant="destructive" size="sm" className="ml-auto" onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden="true" /> Delete
          </Button>
        )}
      </div>
      {reporting && (
        <ReportRegressionDialog
          archived={!!item.archived}
          onCancel={() => setReporting(false)}
          onSubmit={async (reason) => {
            try {
              await actions.reportRegression(item.id, reason);
              setReporting(false);
              return '';
            } catch (failure) {
              return (failure as Error).message;
            }
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this task?"
          description="This can't be undone. Anything still running for it is stopped first."
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void actions.deleteItems([item.id]).then((ok) => ok && onBack());
          }}
        />
      )}
    </div>
  );
}

const INFO_STATUS_ORDER: BugInfoStatus[] = ['enough', 'needs-more-info'];

/**
 * A bug's attributes in the expanded section: severity, Info status, Introduced by, Suspected
 * location and, on an agent-found bug, Found while working on. While the bug has not started, the
 * Info status row is a two-button switch the person can flip; afterwards it is plain text.
 */
function BugDetails({ item, actions }: { item: PlanItemData; actions: TaskActions }) {
  const editable = canChangeInfoStatus(item);
  return (
    <>
      {bugDetailRows(item).map((row) => (
        <DetailRow key={row.label} label={row.label}>
          {row.label === 'Info status' && editable ? (
            <span role="group" aria-label="Info status" className="inline-flex overflow-hidden rounded-md border">
              {INFO_STATUS_ORDER.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={item.bug?.infoStatus === value}
                  onClick={() => void actions.setInfoStatus(item.id, value)}
                  className="px-2 py-0.5 text-xs aria-pressed:bg-secondary aria-pressed:font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  {INFO_STATUS_LABELS[value]}
                </button>
              ))}
            </span>
          ) : (
            <span className="min-w-0 truncate text-sm select-text" title={row.text}>{row.text}</span>
          )}
        </DetailRow>
      ))}
      <BugRegressions item={item} />
    </>
  );
}

/** The regressions reported on a bug, newest first: the reason, the date and who reported it. Append-only, so there is nothing to edit or remove; a bug with none shows no section. */
function BugRegressions({ item }: { item: PlanItemData }) {
  const regressions = regressionsNewestFirst(item);
  if (regressions.length === 0) return null;
  return (
    <section aria-label="Regressions" className="flex flex-col gap-1.5">
      <DetailLabel>Regressions</DetailLabel>
      <ul className="flex flex-col gap-2">
        {regressions.map((regression) => (
          <li key={`${regression.reportedAt}-${regression.reason}`} className="rounded-md bg-muted/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">{regressionDateLabel(regression.reportedAt)} · {regressionReporterLabel(regression.reporter)}</p>
            <p className="text-sm break-words whitespace-pre-wrap select-text">{regression.reason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The expanded section's small muted uppercase label. */
export function DetailLabel({ children }: { children: ReactNode }) {
  return <h4 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{children}</h4>;
}

/** A plain one-line label/value row of the expanded section — no box around it. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="grid min-h-6 grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
      <DetailLabel>{label}</DetailLabel>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </section>
  );
}

/** A task's description — for a planned task a full feature specification — rendered as markdown. */
export function TaskSpecification({ description }: { description: string }) {
  return description.trim() ? <MarkdownDocument content={description} className="doc-content" /> : <p className="text-sm italic text-muted-foreground">No description.</p>;
}

export function DetailBackButton({ onBack, label = 'Back to tasks' }: { onBack: () => void; label?: string }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label={label} title="Back">
      <ArrowLeft aria-hidden="true" />
    </Button>
  );
}
