import { useRef, useState } from 'react';
import type { ComponentType, ReactNode, Ref } from 'react';
import { Bot, Bug, ChevronDown, ChevronRight, ChevronsLeft, GitMerge, GripVertical, Lightbulb } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AutoMergeChip } from './AutoMergeControl';
import { PrBadge, PrHint, PrOpenTag } from './TaskPrStatus';
import type { TaskPrView } from '../../lib/taskPullRequest';
import { WaitingBanner } from './DependenciesControl';
import { DependsOnPicker } from './DependsOnPicker';
import { dependencyChip, waitingView } from '../../lib/dependencies';
import type { WaitingData } from '../../types';
import { queuedBadge } from '../../lib/waitingList';
import type { QueuedPlace } from '../../lib/waitingList';
import type { AutoMergeData } from '../../types';
import type { Attention, CompletedRow, OpenTaskRow, PlanningGroup, StepCardProgress } from '../../lib/projectTasks';
import { boardKeyAction, cardFooterStartedLabel, cardProgressLine, cardStartedLabel, isCardClick } from '../../lib/taskBoard';
import { conversationExpanderLabel, nestedBugCount, planAndBugsExpanderLabel, planAndBugsStatusLabel, sessionTypeLabel } from '../../lib/bugs';
import type { BugCardInfo, BugReferenceGroup, RelatedLink } from '../../lib/bugs';
import { BugBadges, IntroducedByLine, RelatedLine } from './BugCardParts';
import { useNow } from '../../lib/useNow';
import type { CardDnd, ColumnDrop } from './useBoardDnd';

/** How often a Running card's live step timer ticks (task 5.003) — only while it actually has one; a card with no elapsed-time data (an old run record, or nothing running yet) ticks at `useNow`'s own default instead, since nothing on it needs to move every second. */
const LIVE_TIMER_TICK_MS = 1_000;

/** A Running card's progress line text (tasks 5.017 + 5.003), ticking every second while it carries a live elapsed time — a hook, not a plain call, so only cards that need the fast tick ever re-render that often. */
function useCardProgressLine(progress: StepCardProgress | null | undefined): string | null {
  const now = useNow(progress?.elapsed ? LIVE_TIMER_TICK_MS : undefined);
  return progress ? cardProgressLine(progress, now) : null;
}

/** Actions available from an open task's detail view. */
export interface OpenCardHandlers {
  /** Opens the card's detail — its WorkflowRun, its Task's session, or (never started) the task's own details. See `cardDetail`. */
  onOpen: (row: OpenTaskRow) => void;
  /** The project the cards belong to: the "Depends on…" picker reads its tasks. */
  projectId: string;
  onStart: (row: OpenTaskRow) => void;
  onPause: (row: OpenTaskRow) => void;
  onResume: (row: OpenTaskRow) => void;
  onEdit: (row: OpenTaskRow) => void;
  onDuplicate: (row: OpenTaskRow) => void;
  onComplete: (row: OpenTaskRow) => void;
  onInterimCommit: (row: OpenTaskRow) => void;
  onArchive: (row: OpenTaskRow) => void;
  onDelete: (row: OpenTaskRow) => void;
  /** Takes a task off the Project's waiting list (given its entry id); it goes back to unstarted. */
  onRemoveFromWaitingList: (entryId: string) => void;
  /** Opens the task a bug card's "Introduced by" link names. */
  onOpenTask: (taskId: string) => void;
}

/**
 * One column of the board: a header (icon, name, attention dot, count and any actions) over its
 * cards. `drop` makes the whole column a drag-and-drop target — see `useBoardDnd`.
 */
export function BoardColumnView({
  label,
  icon: Icon,
  attention,
  count,
  actions,
  drop,
  children,
  planning = false,
  lower,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  attention: Attention;
  count: number;
  actions?: ReactNode;
  drop: ColumnDrop;
  children: ReactNode;
  planning?: boolean;
  /** A second row under the cards, of equal height; each row scrolls on its own. */
  lower?: { label: string; count: number; children: ReactNode };
}) {
  const attentionLabel = attention === 'input' ? 'Waiting for your input' : 'Something failed';
  return (
    <section
      aria-label={`${label} column`}
      data-drop-target={drop.active || undefined}
      className={`@container flex min-h-0 flex-col rounded-xl border data-[drop-target=true]:border-primary data-[drop-target=true]:bg-accent/30 ${planning ? 'border-info/30 bg-info/10' : 'bg-muted/30'}`}
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h4 className="min-w-0 truncate text-sm font-semibold" title={label}>{label}</h4>
        <span className="text-xs text-muted-foreground">{count}</span>
        {attention && (
          <span
            className={`size-2 rounded-full ${attention === 'input' ? 'bg-warning' : 'bg-destructive'}`}
            title={attentionLabel}
            role="img"
            aria-label={attentionLabel}
          />
        )}
        <span className="ml-auto flex items-center gap-1">{actions}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>
      {lower && (
        <section aria-label={lower.label} className="flex min-h-0 flex-1 flex-col border-t">
          <header className="flex h-9 shrink-0 items-center gap-2 px-3">
            <GitMerge className="size-4 text-muted-foreground" aria-hidden="true" />
            <h5 className="text-sm font-semibold">{lower.label}</h5>
            <span className="text-xs text-muted-foreground">{lower.count}</span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{lower.children}</div>
        </section>
      )}
    </section>
  );
}

/**
 * Completed, collapsed to a narrow strip at the board's right edge (task 5.018): its icon, name, card
 * count and attention dot, same as the full header shows — the whole strip is the expand control, so
 * there's one focusable element, not a nested button. `buttonRef` lets the panel return focus to it when
 * the column collapses again.
 */
export function CollapsedColumnStrip({
  label,
  icon: Icon,
  count,
  attention,
  onExpand,
  buttonRef,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  count: number;
  attention: Attention;
  onExpand: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const attentionLabel = attention === 'input' ? 'Waiting for your input' : 'Something failed';
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      aria-label={`Expand ${label}`}
      title={`Expand ${label}`}
      className="flex w-[3.75rem] shrink-0 flex-col items-center gap-2 rounded-xl border bg-muted/30 py-3 text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="text-xs font-semibold [writing-mode:vertical-rl]">{label}</span>
      <span className="text-xs text-muted-foreground">{count}</span>
      {attention && (
        <span
          className={`size-2 rounded-full ${attention === 'input' ? 'bg-warning' : 'bg-destructive'}`}
          title={attentionLabel}
          role="img"
          aria-label={attentionLabel}
        />
      )}
      <span className="flex-1" />
      <ChevronsLeft className="size-4" aria-hidden="true" />
    </button>
  );
}

/**
 * A board card: the title and a footer with the coding agent and when execution started. Clicking the
 * card (or Enter/Space while it's focused) opens its detail — every card
 * has one. On the board the whole card is the drag source (`dnd`; the Archived tab passes none); a press
 * that moves isn't a click (`isCardClick`).
 * Deliberately no hover styling — the card is a static surface; only its controls react.
 */
export function TaskCard({
  title,
  agent,
  started,
  attention,
  onOpen,
  dnd,
  status,
  autoMerge,
  pr,
  prOwner,
  waiting,
  queued,
  onRemoveFromWaitingList,
  dependsOnLabels,
  dependsOnPicker,
  planning = false,
  dragHandle = false,
  typeLabel,
  typeIcon,
  nested = false,
  progressLine,
  bug,
  related,
  onOpenTask,
}: {
  title: string;
  /** Null for a not-started task — its agent isn't chosen yet, so the footer shows only when it started. */
  agent: string | null;
  started: string;
  attention: Attention;
  onOpen: () => void;
  dnd?: CardDnd;
  status?: string | null;
  /** The task's Auto-merge, shown as a small chip beside the completion state while the toggle is on. */
  autoMerge?: AutoMergeData;
  /** The task's own pull request (tag, badge, hint), for a task without Auto-merge. */
  pr?: TaskPrView;
  /** Given for a card whose "PR #N open" tag is live (it opens the PR tab and offers Auto-merge). */
  prOwner?: { projectId: string; itemId: string };
  /** Set while the task waits for its parent tasks: shown as a Waiting or Blocked banner. */
  waiting?: WaitingData;
  /** Set while the task waits in line for a free slot at the Project's task limit: shown as a badge line with its place. */
  queued?: QueuedPlace;
  /** Offered on a queued card: takes the task off the waiting list. */
  onRemoveFromWaitingList?: () => void;
  /** The parents' names for the "Depends on …" chip. */
  dependsOnLabels?: string[];
  /** The "Depends on…" picker; given only for a task whose dependencies can be edited. */
  dependsOnPicker?: ReactNode;
  planning?: boolean;
  dragHandle?: boolean;
  typeLabel?: string;
  /** The type badge's icon, when it is neither Planning's nor a conflict run's. */
  typeIcon?: ComponentType<{ 'aria-hidden'?: boolean | 'true' }>;
  nested?: boolean;
  /** The Running column's "N/M · ~estimate" line (task 5.017) — only ever passed for a Running card; omitted everywhere else. */
  progressLine?: string | null;
  /** A bug's badges, Info status and introducing task, shown wherever the card appears. */
  bug?: BugCardInfo;
  /** The links to the bug or task this one was filed with in a bug report session. */
  related?: RelatedLink[];
  /** Opens the task a bug's "Introduced by" link names. */
  onOpenTask?: (taskId: string) => void;
}) {
  const TypeIcon = typeIcon ?? (planning ? Lightbulb : GitMerge);
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  return (
    <article
      data-card
      data-nested={nested || undefined}
      draggable={!dragHandle && dnd?.draggable}
      onDragStart={!dragHandle ? dnd?.onDragStart : undefined}
      onDragEnd={dnd?.onDragEnd}
      data-attention={attention ?? undefined}
      data-drop={dnd?.dropPosition ?? undefined}
      data-dragging={dnd?.dragging || undefined}
      data-link-target={dnd?.linkTarget || undefined}
      onDragEnter={dnd?.onLinkOver}
      onDragOver={dnd?.onLinkOver}
      onDragLeave={dnd?.onLinkLeave}
      onDrop={dnd?.onLinkDrop}
      className={`relative rounded-lg border text-card-foreground data-[attention=failed]:border-destructive/50 data-[attention=input]:border-warning/60 data-[dragging=true]:opacity-40 data-[link-target=true]:ring-2 data-[link-target=true]:ring-primary data-[drop=before]:before:absolute data-[drop=before]:before:inset-x-0 data-[drop=before]:before:-top-[5px] data-[drop=before]:before:h-0.5 data-[drop=before]:before:rounded-full data-[drop=before]:before:bg-primary data-[drop=after]:after:absolute data-[drop=after]:after:inset-x-0 data-[drop=after]:after:-bottom-[5px] data-[drop=after]:after:h-0.5 data-[drop=after]:after:rounded-full data-[drop=after]:after:bg-primary ${planning ? 'border-info/30 bg-info/10' : 'bg-card'}`}
    >
      {dragHandle && dnd && (
        <Button type="button" variant="ghost" size="icon-sm" draggable={dnd.draggable} onDragStart={dnd.onDragStart} onDragEnd={dnd.onDragEnd} onKeyDown={dnd.onKeyDown} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" className="absolute top-1.5 left-1 cursor-grab" aria-label={`Reorder ${typeLabel === 'Planning' || !typeLabel ? 'planning session' : `${typeLabel.toLowerCase()} session`} "${title}"`} title="Drag, or press Alt+Up/Down Arrow to reorder">
          <GripVertical aria-hidden="true" />
        </Button>
      )}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open "${title}"`}
        className={`cursor-pointer rounded-lg p-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${dragHandle ? 'pl-10' : ''}`}
        onPointerDown={(event) => { pressedAt.current = { x: event.clientX, y: event.clientY }; }}
        onClick={(event) => {
          const opens = isCardClick(pressedAt.current, { x: event.clientX, y: event.clientY });
          pressedAt.current = null;
          if (opens) onOpen();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const action = boardKeyAction('card', event);
          if (action === 'open') {
            event.preventDefault();
            onOpen();
          } else if (!dragHandle) dnd?.onKeyDown(event);
        }}
        aria-keyshortcuts={!dragHandle && dnd?.draggable ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight' : undefined}
      >
        <div className="flex items-start justify-between gap-2"><div>{typeLabel && <Badge variant="secondary" className="mb-1"><TypeIcon aria-hidden="true" /> {typeLabel}</Badge>}{bug && <BugBadges bug={bug} />}<p className="line-clamp-2 text-sm leading-5 font-medium break-words" title={title}>{title}</p></div><div className="flex shrink-0 flex-col items-end gap-1">{status && <Badge variant={status === 'Needs you' ? 'warning' : status === 'Failed' || status === 'Blocked' ? 'soft-destructive' : status === 'Waiting' ? 'secondary' : 'success'}>{status}</Badge>}<AutoMergeChip autoMerge={autoMerge} /><PrBadge pr={pr} /></div></div>
        {pr?.tag && prOwner && <PrOpenTag pr={pr} projectId={prOwner.projectId} itemId={prOwner.itemId} />}
        <PrHint pr={pr} />
        {progressLine && <p className="mt-1.5 truncate text-xs font-medium">{progressLine}</p>}
        {dependencyChip(dependsOnLabels) && <p className="mt-1.5 line-clamp-2 text-xs break-words text-muted-foreground" data-depends-chip title={dependencyChip(dependsOnLabels)!}>{dependencyChip(dependsOnLabels)}</p>}
        {waiting && !queued && <WaitingBanner waiting={waitingView(waiting)!} />}
        {queued && <p className="mt-1.5 truncate text-xs font-medium text-muted-foreground" data-queued-banner title={queuedBadge(queued.position)}>{queuedBadge(queued.position)}</p>}
        <p className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {agent && (
            <>
              <Bot className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{agent}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="shrink-0">{started}</span>
          {bug?.footer && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{bug.footer}</span>
            </>
          )}
        </p>
      </div>
      {dependsOnPicker}
      {queued && onRemoveFromWaitingList && (
        <div className="px-3 pb-3">
          <Button type="button" variant="outline" size="sm" onClick={onRemoveFromWaitingList}>Remove from waiting list</Button>
        </div>
      )}
      {/* Nested beneath its reference card, a bug's introducing task is already named there. */}
      {bug?.introducedBy && !nested && <IntroducedByLine link={bug.introducedBy} onOpenTask={onOpenTask} />}
      {related?.map((link) => <RelatedLine key={`${link.prefix}:${link.itemId ?? link.text}`} link={link} onOpenItem={onOpenTask} />)}
    </article>
  );
}

/** A Planning / Running / Needs-you card for an open task. */
export function OpenTaskCard({
  row,
  agent,
  now,
  handlers,
  dnd,
  nested = false,
}: {
  row: OpenTaskRow;
  /** Null for a task that hasn't been started — its agent isn't chosen until the Start task dialog. */
  agent: string | null;
  now: Date;
  handlers: OpenCardHandlers;
  /** Left out where the card can't be dragged (the "Pending only" view). */
  dnd?: CardDnd;
  nested?: boolean;
}) {
  const progressLine = useCardProgressLine(row.progress);
  return (
    <TaskCard
      title={row.title}
      agent={agent}
      started={cardFooterStartedLabel(row, now)}
      attention={row.attention}
      dnd={dnd}
      nested={nested}
      onOpen={() => handlers.onOpen(row)}
      autoMerge={row.autoMerge}
      pr={row.pr}
      prOwner={{ projectId: handlers.projectId, itemId: row.id }}
      waiting={row.waiting}
      queued={row.queued}
      onRemoveFromWaitingList={row.queued ? () => handlers.onRemoveFromWaitingList(row.queued!.entryId) : undefined}
      dependsOnLabels={row.dependsOnLabels}
      dependsOnPicker={row.canEdit && !row.archived ? <DependsOnPicker projectId={handlers.projectId} itemId={row.id} /> : undefined}
      status={row.queued ? null : row.waiting ? waitingView(row.waiting)!.badge : row.state === 'todo' ? null : row.state === 'executing' ? 'Running' : row.state === 'blocked' ? 'Needs you' : row.state === 'failed' ? 'Failed' : row.state === 'stopped' || row.state === 'paused' ? 'Stopped' : null}
      progressLine={progressLine}
      typeLabel={row.typeLabel}
      bug={row.bug}
      related={row.related}
      onOpenTask={handlers.onOpenTask}
    />
  );
}

/** Actions available from a completed or archived task's detail view. */
export interface CompletedCardHandlers {
  onOpen: (row: CompletedRow) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenTask?: (taskId: string) => void;
}

/**
 * A Completed card: opens its session (or, for one marked done by hand, its details); a finished plan
 * item can be archived or deleted from its detail. Archived lists the same undraggable card.
 */
export function CompletedTaskCard({
  row,
  agent,
  now,
  dnd,
  ...handlers
}: CompletedCardHandlers & {
  row: CompletedRow;
  agent: string;
  now: Date;
  dnd?: CardDnd;
}) {
  return (
    <TaskCard
      title={row.title}
      agent={agent}
      started={cardStartedLabel(row.metrics, now)}
      attention={row.attention}
      dnd={dnd}
      onOpen={() => handlers.onOpen(row)}
      status={row.statusBadge}
      autoMerge={row.autoMerge}
      pr={row.pr}
      typeLabel={row.typeLabel}
      bug={row.bug}
      onOpenTask={handlers.onOpenTask}
    />
  );
}

/** The Plan & bugs type badge's icon: the planning lightbulb beside the bug. */
function PlanAndBugsIcon(_props: { 'aria-hidden'?: boolean | 'true' }) {
  return <><Lightbulb aria-hidden="true" /><Bug aria-hidden="true" /></>;
}

/**
 * A planning conversation's card, its ready tasks and, after them, the reference cards of tasks it
 * created that have ready bugs. Collapsed, it hides all of them; the expander still counts the bugs.
 * A Plan & bugs session uses the same card with its own label, status words and counts: its tasks
 * nest beneath it, and the expander counts every ready bug it filed.
 */
export function PlanningSessionCard({ row, agent, now, dnd, onOpen, onChain, renderTask, renderReference }: { row: PlanningGroup; onChain?: () => void; agent: string | null; now: Date; dnd: CardDnd; onOpen: () => void; renderTask: (task: OpenTaskRow) => ReactNode; renderReference: (group: BugReferenceGroup<OpenTaskRow>) => ReactNode }) {
  const [expanded, setExpanded] = useState(row.live !== 'idle');
  const planAndBugs = row.kind === 'plan-and-bugs';
  const history = [
    row.startedCount ? `${row.startedCount} started` : '',
    row.completedCount ? `${row.completedCount} completed` : '',
    row.archivedCount ? `${row.archivedCount} archived` : '',
    row.removedCount ? `${row.removedCount} removed` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div>
      <TaskCard title={row.title} agent={agent} started={cardStartedLabel(planAndBugs && row.cliNotStarted ? null : row.metrics, now)} attention={row.attention} dnd={dnd} onOpen={onOpen} planning dragHandle typeLabel={sessionTypeLabel(row.kind)} typeIcon={planAndBugs ? PlanAndBugsIcon : undefined} status={planAndBugs ? planAndBugsStatusLabel(row) : row.live === 'running' ? 'Planning' : row.live === 'blocked' ? 'Needs you' : null} />
      <Button type="button" variant="ghost" size="sm" className="mt-1 w-full justify-start text-xs text-info-foreground" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />} <Lightbulb aria-hidden="true" /> {planAndBugs ? planAndBugsExpanderLabel(row.readyTaskCount ?? 0, row.readyBugCount ?? 0, row.createdTaskCount) : conversationExpanderLabel(row.ready.length, nestedBugCount(row.references))}
      </Button>
      {expanded && <div data-group-list={row.id} className="ml-4 space-y-2 border-l-2 border-info/30 pl-2">{row.ready.map(renderTask)}{row.references?.map(renderReference)}{onChain && row.ready.length > 1 && <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={onChain} title={planAndBugs ? 'Links the session\'s tasks only; its bugs are left alone' : undefined}>Chain tasks{planAndBugs && ' (tasks only)'}</Button>}{history && <p className="rounded-md bg-info/10 px-2 py-1 text-xs text-info-foreground">{history}</p>}</div>}
    </div>
  );
}
