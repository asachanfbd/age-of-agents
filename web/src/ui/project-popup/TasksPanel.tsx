import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Activity, AlertCircle, Archive, Bug, ChevronsRight, CircleCheck, Lightbulb, Plus, X } from 'lucide-react';
import type { BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { buildArchivedRows, buildCompletedRows, buildPlanningQueue, planningQueueOrderEntries, queueCardId, worstAttention, workerLabel } from '../../lib/projectTasks';
import { bugGroupIntroducerId, bugGroupKey, bugSlotWorkflowId, isBugItem, isGroupExpanded, startInfoWarning, startWorkflowChoice } from '../../lib/bugs';
import type { BugReferenceGroup } from '../../lib/bugs';
import type { Attention, CompletedRow, OpenTaskRow } from '../../lib/projectTasks';
import { detailBackTarget, planningRowDetail } from '../../lib/planningTaskPanel';
import { BOARD_COLUMNS, canCollapse, cardDetail, findCard, pendingOnlyView } from '../../lib/taskBoard';
import type { BoardColumn, BoardDrop, CardDetail } from '../../lib/taskBoard';
import { buildTaskGroups, findWorkflowRun, needsYouSeverity } from '../../lib/workflowTaskGroups';
import { enabledWorkflows, initialStartWorkflowId } from '../../lib/workflowSettings';
import { plural } from '../../lib/text';
import { useNow } from '../../lib/useNow';
import { useWorldStore } from '../../store/worldStore';
import { serverApi } from '../../lib/serverApi';
import type { WorkflowRunRecord } from '../../lib/serverApi';
import type { PlanItemData, ProjectData } from '../../types';
import { ChainTasksDialog, ConfirmDialog, StartTaskDialog } from './TaskDialogs';
import { dependencyForest, planLinkDrop, startConfirm } from '../../lib/dependencies';
import { hasEarlyStep } from '../../lib/earlyUiPlanning';
import { BugWorkflowIdContext } from './UiPlanningWaitsSwitch';
import type { DependencyNode, StartConfirmParent } from '../../lib/dependencies';
import { BulkStartDialog, StartPendingButton } from './BulkStartDialog';
import { buildBulkRows } from '../../lib/bulkStart';
import { BoardColumnView, CollapsedColumnStrip, CompletedTaskCard, OpenTaskCard, PlanningSessionCard } from './TaskBoard';
import type { OpenCardHandlers } from './TaskBoard';
import { TaskDetailsView } from './TaskDetailsView';
import type { TaskPanelSwap } from '../../lib/planningTaskPanel';
import { TaskEditForm } from './TaskEditForm';
import { TaskItemDetailsView } from './TaskItemDetailsView';
import { TaskPromptDialog } from './TaskPrompt';
import { PlanAndBugsPromptDialog } from './PlanAndBugsPrompt';
import { BugGroupView, BugReportSessionCard } from './BugCards';
import { ActionAlerts, EmptyState } from './TaskListParts';
import { useBoardDnd } from './useBoardDnd';
import type { ColumnDrop } from './useBoardDnd';
import { useCardDetail } from './useCardDetail';
import { useTaskActions } from './useTaskActions';
import { WorkflowRunView } from './WorkflowRunView';

/** Each column's header, empty-state line, and the status badge a card in it shows in its task details (`TaskItemDetailsView`). */
/** The lower row of the Needs you column: finished Auto-merge tasks whose pull request isn't merged yet. */
const PR_NOT_MERGED = { label: 'PR not merged yet', empty: 'Finished tasks wait here until their pull request is merged.' };

const COLUMNS: Record<BoardColumn, { label: string; icon: ComponentType<{ className?: string }>; empty: string; status: { label: string; variant: BadgeProps['variant'] } }> = {
  planning: { label: 'Planning', icon: Lightbulb, empty: 'Start a plan or add a task.', status: { label: 'Not started', variant: 'secondary' } },
  running: { label: 'Running', icon: Activity, empty: 'Drag a Planning task here to start it.', status: { label: 'Running', variant: 'success' } },
  needsYou: { label: 'Needs you', icon: AlertCircle, empty: 'Runs waiting on your approval, needing attention, that failed, or whose Auto-merge needs you will show up here.', status: { label: 'Needs you', variant: 'warning' } },
  done: { label: 'Completed', icon: CircleCheck, empty: 'Finished work will show up here.', status: { label: 'Completed', variant: 'success' } },
};

/** Stable references, so the memoized row builders below aren't recomputed every render while nothing has loaded yet. */
const EMPTY_ITEMS: PlanItemData[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_RUNS: WorkflowRunRecord[] = [];
/** The "Pending only" view's column takes no drops: a task starts from its details there. */
const NO_DROP: ColumnDrop = { active: false, onDragEnter: () => undefined, onDragOver: () => undefined, onDragLeave: () => undefined, onDrop: () => undefined };

type Dialog =
  | { kind: 'add' }
  | { kind: 'plan-and-bugs' }
  | { kind: 'delete'; id: string }
  | { kind: 'archiveAll'; ids: string[] }
  | { kind: 'start'; row: Pick<OpenTaskRow, 'id' | 'title'> }
  | { kind: 'chain'; session: number; titles: string[] }
  | { kind: 'bulk-start' };

/**
 * The Tasks tab unifies planning and execution in Planning / Running / Needs you / Completed.
 * Planning-session groups and standalone tasks share one reorderable top-level queue; nested tasks
 * reorder only within their own group, or are dragged to Running. `initialRunId` opens a run directly when linked from Testing.
 */
export function TasksPanel({ project, initialRunId = null, taskPanelSwap }: { project: ProjectData; initialRunId?: string | null; taskPanelSwap: TaskPanelSwap }) {
  const plan = useWorldStore((s) => s.planByProject[project.id]);
  const tasksById = useWorldStore((s) => s.tasksById);
  const taskIds = useWorldStore((s) => s.taskIdsByProject[project.id]);
  const executors = useWorldStore((s) => s.executors);
  const workflowRunsByProject = useWorldStore((s) => s.workflowRunsByProject);
  const queue = useWorldStore((s) => s.planItemQueueByProject[project.id]);
  const loadPlanItemQueue = useWorldStore((s) => s.loadPlanItemQueue);
  const catalogWorkflows = useWorldStore((s) => s.catalogWorkflows);
  const loadPlan = useWorldStore((s) => s.loadPlan);
  const setDependencies = useWorldStore((s) => s.setDependencies);
  const loadProjectTasks = useWorldStore((s) => s.loadProjectTasks);
  const loadWorkflowRunsForProject = useWorldStore((s) => s.loadWorkflowRunsForProject);
  const fetchCatalog = useWorldStore((s) => s.fetchCatalog);
  const cardDetailRequest = useWorldStore((s) => s.workspaceCardDetailRequest);
  const clearCardDetailRequest = useWorldStore((s) => s.clearWorkspaceCardDetailRequest);
  const tasksFilter = useWorldStore((s) => s.workspaceTasksFilter);
  const setTasksFilter = useWorldStore((s) => s.setWorkspaceTasksFilter);
  const nowMs = useNow();
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const chainPlanningGroup = useWorldStore((s) => s.chainPlanningGroup);
  /** The unsatisfied parents the Start dialog asks to wait for; null while they load (the dialog opens once known). */
  const [startParents, setStartParents] = useState<StartConfirmParent[] | null>(null);
  const startingItemId = dialog?.kind === 'start' ? dialog.row.id : null;
  useEffect(() => {
    setStartParents(null);
    if (!startingItemId) return;
    const item = (useWorldStore.getState().planByProject[project.id]?.items ?? []).find((entry) => entry.id === startingItemId);
    if (!item?.dependsOn?.length) { setStartParents([]); return; }
    let current = true;
    // A failed lookup falls back to a plain start; the daemon decides whether the task runs or waits.
    serverApi.dependencyStatus(project.id, startingItemId).then((parents) => { if (current) setStartParents(startConfirm(parents)); }, () => { if (current) setStartParents([]); });
    return () => { current = false; };
  }, [startingItemId, project.id]);
  /** The planning session whose task panel opened the detail now showing; that detail's back control returns to it. */
  const [originSessionId, setOriginSessionId] = useState<string | null>(null);
  /** Bug groups the person opened or closed by hand, by introducing task id. Held here, so a toggle lasts for as long as the board is mounted, whatever the task's state does. */
  const [groupToggles, setGroupToggles] = useState<Record<string, boolean>>({});
  /** The "Fix a bug" slot's workflow for this Building Type, which a bug's Start task dialog preselects. */
  const [bugWorkflowId, setBugWorkflowId] = useState(() => bugSlotWorkflowId(undefined));
  const reorderBugGroup = useWorldStore((s) => s.reorderBugGroup);

  /**
   * Completed starts collapsed every time the board mounts (a fresh popup open, a reload, or switching
   * tabs away and back) — plain component state, nothing persisted. Expanding it survives going into a
   * card's details and back, since that only swaps the JSX below without remounting this component.
   */
  const [completedCollapsed, setCompletedCollapsed] = useState(true);
  const stripRef = useRef<HTMLButtonElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const skipFocusMove = useRef(true);
  useEffect(() => {
    if (skipFocusMove.current) { skipFocusMove.current = false; return; }
    (completedCollapsed ? stripRef : collapseButtonRef).current?.focus();
  }, [completedCollapsed]);

  useEffect(() => {
    if (!plan) void loadPlan(project.id);
    void loadProjectTasks(project.id);
    void loadWorkflowRunsForProject(project.id);
    void loadPlanItemQueue(project.id);
    // The start dialog offers the Catalog's workflows, which nothing else in the workspace loads.
    void fetchCatalog();
    // Left at the built-in Bug Fix when the type's configuration cannot be read.
    void serverApi.getBuildingTypeConfig(project.typeId ?? 'software').then(({ slots }) => setBugWorkflowId(bugSlotWorkflowId(slots))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const items = plan?.items ?? EMPTY_ITEMS;
  const ids = taskIds ?? EMPTY_IDS;
  const runsForProject = workflowRunsByProject[project.id] ?? EMPTY_RUNS;
  const detailState = useCardDetail(ids, initialRunId);
  /** `detailItemId` is a card opened with nothing run yet. Its view follows the card: once started from its details, it shows the new run. */
  const { runId: detailRunId, runFocus, taskId: activeTaskId, historyIds, itemId: detailItemId } = detailState;
  const actions = useTaskActions(project, openTaskDetail);

  const groups = useMemo(
    () => buildTaskGroups({ items, tasksById, workflowRunsByProject, projectId: project.id, showArchived: false, now: nowMs, queue }),
    [items, tasksById, workflowRunsByProject, project.id, nowMs, queue],
  );
  // Tasks waiting for their parents or for a free slot stay in the Running column (the card badge says which).
  const boardRunning = useMemo(() => [...groups.running, ...groups.waiting], [groups.running, groups.waiting]);
  const completedRows = useMemo(
    () => buildCompletedRows({ items, taskIds: ids, tasksById, workflowRuns: runsForProject, now: nowMs }),
    [items, ids, tasksById, runsForProject, nowMs],
  );
  const planningQueue = useMemo(() => buildPlanningQueue({ items, taskIds: ids, tasksById, now: nowMs, openRows: groups.open }), [items, ids, tasksById, nowMs, groups.open]);
  // A reference card holds its place in the top-level order but is locked: it is never dragged or moved by key.
  const planningTopCards = planningQueue.map((entry) => entry.kind === 'task' ? entry.task : ({ id: queueCardId(entry), primary: undefined, locked: entry.kind === 'reference' }));
  const bugGroups = planningQueue.flatMap((entry) => entry.kind === 'reference' ? [entry.reference] : entry.kind === 'session' ? entry.session.references ?? [] : []);
  const nestedPlanningCards = [
    ...planningQueue.flatMap((entry) => entry.kind === 'session' ? entry.session.ready.map((row) => ({ ...row, group: entry.id })) : []),
    ...bugGroups.flatMap((group) => group.bugs.map((row) => ({ ...row, group: bugGroupKey(group.id) }))),
  ];
  const planningCards = [...planningTopCards, ...nestedPlanningCards];
  const columns = { planning: planningCards, running: boardRunning, needsYou: groups.needsYou, done: completedRows };
  // The "Pending only" filter (opened from the 3D yard's crate stack): the same pending tasks the stack's badge counts.
  const pendingOnly = tasksFilter === 'pending'
    ? pendingOnlyView(planningQueue, { running: boardRunning.length, needsYou: groups.needsYou.length + groups.prNotMerged.length, done: completedRows.length })
    : null;

  const attention: Record<BoardColumn, Attention> = {
    planning: worstAttention(groups.open),
    running: null,
    needsYou: worstAttention(groups.needsYou.map((row) => ({ attention: needsYouSeverity(row, findWorkflowRun(row, runsForProject)) }))),
    done: worstAttention(completedRows),
  };
  const loading = plan === undefined || taskIds === undefined;
  const workflows = enabledWorkflows(catalogWorkflows);
  /** What a Start preselects its workflow from, for the single Start task dialog and the bulk start alike. */
  const workflowDefaults = {
    projectDefaultId: initialStartWorkflowId(project, workflows), enabledIds: workflows.map((workflow) => workflow.id), bugWorkflowId,
    earlyStepWorkflowIds: workflows.filter((workflow) => hasEarlyStep(workflow.steps)).map((workflow) => workflow.id),
  };
  /** The Planning column's startable cards, in display order, for "Start pending tasks". */
  const bulkRows = buildBulkRows(planningQueue, items, workflowDefaults);
  /** Writing tasks holding a slot right now; at the Project's cap a start waits in line. */
  const slotsInUse = groups.running.length + groups.needsYou.filter((card) => card.attention === 'input').length;

  /** A reorder saves the mixed Planning queue or one group's tasks; a ready task dropped on Running waits for its start options. */
  function onBoardDrop(drop: BoardDrop<(typeof columns)[BoardColumn][number]>) {
    // A waiting task starts by itself; cancel waiting first to start it by hand.
    if (drop.kind === 'start' && (drop.card as OpenTaskRow).waiting) return;
    if (drop.kind === 'reorderGroup') {
      const introducerId = bugGroupIntroducerId(drop.group);
      const saved = introducerId ? reorderBugGroup(project.id, introducerId, drop.ids) : serverApi.reorderPlanningGroup(project.id, drop.group, drop.ids);
      void saved.catch((error) => actions.reportError(error));
    } else if (drop.kind === 'reorder') {
      const entries = planningQueueOrderEntries(planningQueue, drop.ids);
      if (entries) {
        void serverApi.reorderPlanningQueue(project.id, entries).catch((error) => actions.reportError(error));
      } else {
        void actions.reorder(drop.ids);
      }
    } else setDialog({ kind: 'start', row: drop.card as OpenTaskRow });
  }
  const dnd = useBoardDnd(columns, onBoardDrop, {
    canLink: (parentId, childId) => planLinkDrop(parentId, childId, items, project.repositoryUrl) !== null,
    onLink: (parentId, childId) => {
      const link = planLinkDrop(parentId, childId, items, project.repositoryUrl);
      if (link) void setDependencies(project.id, link.itemId, link.dependsOn);
    },
  });

  /** Shows one detail view in place of whichever was showing — or, given null, the board. */
  function showDetail(next: CardDetail | null, fromSessionId: string | null = null) {
    detailState.show(next);
    setEditingId(null);
    setOriginSessionId(fromSessionId);
  }

  /** Back from a detail: to the planning session it was opened from, else the board (`detailBackTarget`). */
  function backFromDetail() {
    showDetail(detailBackTarget(originSessionId, tasksById));
  }

  // A status-footer click asks for a card's details (or the plain board); apply it once, then clear it so remounting the tab doesn't replay it.
  useEffect(() => {
    if (!cardDetailRequest) return;
    showDetail(cardDetailRequest.detail);
    clearCardDetailRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardDetailRequest]);

  function openTaskDetail(taskId: string) {
    showDetail({ kind: 'task', id: taskId });
  }

  /** Opens any card's detail — its WorkflowRun, its Task's session, or its own details (`cardDetail`). */
  function openCard(row: OpenTaskRow | CompletedRow) {
    showDetail(cardDetail(row));
  }

  /** Opens a task named by a reference card or a bug's "Introduced by" link: its normal detail view, whose Back returns to the board. */
  function openTaskById(itemId: string) {
    const detail = planningRowDetail(items, tasksById, itemId);
    if (detail) showDetail(detail);
  }

  /** Opens a task or session named by a refusal message: its board card when it has one, else its session. */
  function openConflictTask({ planItemId, taskId }: { planItemId: string | null; taskId: string | null }) {
    if (planItemId) openTaskById(planItemId);
    else if (taskId) openTaskDetail(taskId);
  }

  function deleteOne(id: string) {
    setDialog({ kind: 'delete', id });
  }

  function saveEdit(id: string, patch: { title: string; description: string }) {
    setEditingId(null);
    void actions.edit(id, patch);
  }

  const handlers: OpenCardHandlers = {
    onOpen: openCard,
    projectId: project.id,
    onStart: (row) => setDialog({ kind: 'start', row }),
    onPause: (row) => void actions.pause(row),
    onResume: (row) => void actions.resume(row),
    onEdit: (row) => setEditingId(row.id),
    onDuplicate: (row) => void actions.duplicate(row),
    onComplete: (row) => void actions.complete([row]),
    onInterimCommit: (row) => void actions.interimCommit(row),
    onArchive: (row) => void actions.archive(row.id),
    onDelete: (row) => deleteOne(row.id),
    onRemoveFromWaitingList: (entryId) => void actions.removeFromWaitingList(entryId),
    onOpenTask: openTaskById,
  };

  const completedHandlers = { onOpen: openCard, onOpenTask: openTaskById, onArchive: (id: string) => void actions.archive(id), onUnarchive: (id: string) => void actions.unarchive(id), onDelete: deleteOne };

  /** The outcome of the last card/detail action, shown over the board and under a detail's header. */
  const alerts = <ActionAlerts error={actions.error} conflict={actions.conflict} onOpenTask={openConflictTask} notice={actions.notice} onDismissNotice={actions.clearNotice} />;

  /** The card opened by `detailItemId`, with its plan item; null once it's gone (deleted), which shows the board again. */
  const detailColumns = { planning: groups.open, running: boardRunning, needsYou: [...groups.needsYou, ...groups.prNotMerged], done: completedRows };
  const openedCard = detailItemId ? findCard<OpenTaskRow | CompletedRow>(detailColumns, detailItemId) ?? archivedDoneCard(detailItemId) : null;
  const openedItemData = detailItemId ? items.find((item) => item.id === detailItemId) : undefined;
  const openedItem = openedCard && openedItemData ? { ...openedCard, item: openedItemData } : null;

  /** An archived, completed task is on no column, but a planning session's task panel still lists and opens it. */
  function archivedDoneCard(itemId: string): { column: BoardColumn; card: CompletedRow } | null {
    const archivedDone = items.filter((item) => item.id === itemId && item.archived && item.status === 'done');
    const [card] = buildArchivedRows({ items: archivedDone, tasksById, workflowRuns: runsForProject, now: nowMs });
    return card ? { column: 'done', card } : null;
  }

  /**
   * A not-started card's details, with Start / Edit icons while they apply. Started from there, the card
   * now has a run or session, and that shows instead.
   */
  function itemDetailView({ column, card, item }: NonNullable<typeof openedItem>) {
    const detail = cardDetail(card);
    if (detail.kind === 'run') return <WorkflowRunView key={detail.id} runId={detail.id} actions={actions} alerts={alerts} onBack={backFromDetail} />;
    if (detail.kind === 'task') return <TaskDetailsView key={detail.id} taskId={detail.id} actions={actions} alerts={alerts} onBack={backFromDetail} />;
    const open = column === 'done' ? null : (card as OpenTaskRow);
    return (
      <TaskItemDetailsView
        key={item.id}
        item={item}
        status={COLUMNS[column].status}
        alerts={alerts}
        actions={actions}
        editing={open?.canEdit ? { editing: editingId === item.id, onEdit: () => setEditingId(item.id), onSave: (patch) => saveEdit(item.id, patch), onCancel: () => setEditingId(null) } : undefined}
        onStart={open?.primary === 'start' ? () => setDialog({ kind: 'start', row: open }) : undefined}
        fill={column === 'planning'}
        onBack={backFromDetail}
      />
    );
  }

  const label = (id: string | null) => workerLabel(executors, id);

  /** What the Start task dialog preselects and says for this task or bug — see `startWorkflowChoice`. */
  function startDialogChoice(itemId: string) {
    const item = items.find((candidate) => candidate.id === itemId);
    const choice = startWorkflowChoice({ bug: !!item && isBugItem(item), ...workflowDefaults });
    return { initialWorkflowId: choice.workflowId, fallbackNote: choice.fallbackNote, infoWarning: startInfoWarning(item) };
  }

  /** A ready task or bug nested in a group. Not-started, so it shows no agent. */
  function nestedCard(row: OpenTaskRow) {
    return <OpenTaskCard key={row.id} row={row} agent={null} now={now} handlers={handlers} dnd={dnd.cardDnd('planning', nestedPlanningCards.find((card) => card.id === row.id)!)} nested />;
  }

  /** An introducing-task reference card and its ready bugs; `nested` beneath a planning conversation, else at the top level. */
  function bugGroup(group: BugReferenceGroup<OpenTaskRow>, nested: boolean) {
    const expanded = isGroupExpanded(groupToggles, group);
    return (
      <BugGroupView
        key={`reference-${group.id}`}
        group={group}
        nested={nested}
        expanded={expanded}
        onToggle={() => setGroupToggles((toggles) => ({ ...toggles, [group.id]: !expanded }))}
        onOpen={() => openTaskById(group.id)}
        renderBug={nestedCard}
      />
    );
  }

  function columnCards(column: BoardColumn) {
    if (column === 'planning') {
      // Not-started tasks show no agent — it isn't chosen until the Start task dialog. A session
      // that is already running keeps its own agent label.
      return planningQueue.map((entry, index) => {
        const cardDnd = dnd.cardDnd(column, columns.planning[index]!);
        if (entry.kind === 'reference') return bugGroup(entry.reference, false);
        if (entry.kind === 'task') return <OpenTaskCard key={entry.id} row={entry.task} agent={null} now={now} handlers={handlers} dnd={cardDnd} />;
        const open = () => showDetail({ kind: 'task', id: entry.session.id });
        return entry.session.kind === 'bug-report' ? (
          <BugReportSessionCard key={entry.id} row={entry.session} agent={entry.session.cliNotStarted ? null : label(entry.session.workerId)} now={now} dnd={cardDnd} onOpen={open} />
        ) : (
          <PlanningSessionCard key={`${entry.id}-${entry.session.live}`} row={entry.session} agent={entry.session.cliNotStarted ? null : label(entry.session.workerId)} now={now} dnd={cardDnd} onOpen={open} onChain={entry.session.sessionNumber === null ? undefined : () => setDialog({ kind: 'chain', session: entry.session.sessionNumber!, titles: entry.session.ready.map((task) => task.title) })} renderTask={nestedCard} renderReference={(group) => bugGroup(group, true)} />
        );
      });
    }
    if (column === 'done') {
      return completedRows.map((row) => (
        <CompletedTaskCard
          key={row.id}
          row={row}
          agent={label(row.workerId)}
          now={now}
          dnd={dnd.cardDnd(column, row)}
          {...completedHandlers}
        />
      ));
    }
    const renderRow = (row: OpenTaskRow, nested: boolean) =>
      row.id === editingId ? (
        <li key={row.id} className="rounded-lg border bg-card p-3 text-card-foreground">
          <TaskEditForm title={row.title} description={row.description} onSave={(patch) => saveEdit(row.id, patch)} onCancel={() => setEditingId(null)} />
        </li>
      ) : (
        <OpenTaskCard key={row.id} row={row} agent={label(row.workerId)} now={now} handlers={handlers} dnd={dnd.cardDnd(column, row)} nested={nested} />
      );
    // Children sit indented under the parent they wait for when both are in this column.
    const renderNode = (node: DependencyNode<OpenTaskRow>, nested: boolean): ReactNode => (
      <Fragment key={node.row.id}>
        {renderRow(node.row, nested)}
        {node.children.length > 0 && <div data-dependents-of={node.row.id} className="ml-4 space-y-2 border-l-2 border-info/30 pl-2">{node.children.map((child) => renderNode(child, true))}</div>}
      </Fragment>
    );
    return dependencyForest(columns[column] as OpenTaskRow[]).map((node) => renderNode(node, false));
  }

  /** The lower row's cards: opened like any card, but never dragged. */
  function prNotMergedBody() {
    return (
      <div className="space-y-2">
        {groups.prNotMerged.length > 0
          ? groups.prNotMerged.map((row) => <OpenTaskCard key={row.id} row={row} agent={label(row.workerId)} now={now} handlers={handlers} dnd={dnd.cardDnd('needsYou', { ...row, locked: true })} />)
          : <EmptyState subtitle={PR_NOT_MERGED.empty} loading={loading} />}
      </div>
    );
  }

  function columnBody(column: BoardColumn) {
    const cards = columnCards(column);
    return (
      <div className="space-y-2">
        {cards.length > 0 ? cards : <EmptyState subtitle={COLUMNS[column].empty} loading={loading} />}
      </div>
    );
  }

  function columnActions(column: BoardColumn) {
    if (column === 'planning') {
      return (
        // Below 24rem of column width the two text buttons show icons only; their names stay as label and tooltip.
        <><StartPendingButton rows={bulkRows} onOpen={() => setDialog({ kind: 'bulk-start' })} /><Button type="button" variant="outline" size="sm" aria-label="Plan & bugs" title="Plan & bugs" onClick={() => setDialog({ kind: 'plan-and-bugs' })}><Lightbulb aria-hidden="true" /><Bug aria-hidden="true" /><span className="hidden @[24rem]:inline">Plan &amp; bugs</span></Button><Button type="button" variant="outline" size="sm" aria-label="Task" title="Task" onClick={() => setDialog({ kind: 'add' })}><Plus aria-hidden="true" /><span className="hidden @[24rem]:inline">Task</span></Button></>
      );
    }
    if (column === 'done') {
      const archivable = completedRows.filter((row) => row.canArchive).map((row) => row.id);
      return (
        <>
          <Button type="button" variant="ghost" size="sm" disabled={archivable.length === 0} onClick={() => setDialog({ kind: 'archiveAll', ids: archivable })} title="Archive every completed task">
            <Archive aria-hidden="true" /> Archive all
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" ref={collapseButtonRef} aria-expanded={true} aria-label="Collapse Completed" title="Collapse Completed" onClick={() => setCompletedCollapsed(true)}>
            <ChevronsRight aria-hidden="true" />
          </Button>
        </>
      );
    }
    return null;
  }

  /** The board filtered to pending tasks: their cards in a wide grid, every other column a strip that clears the filter. Nothing drags here. */
  function pendingOnlyBoard(view: NonNullable<typeof pendingOnly>) {
    const clear = () => setTasksFilter(null);
    return (
      <>
        <div className="flex flex-wrap items-center gap-3 px-4 pt-4 sm:px-6">
          <span className="inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/10 py-0.5 pr-1 pl-2.5 text-xs font-semibold">
            Pending only · {view.cards.length}
            <Button type="button" variant="ghost" size="icon-sm" className="size-5" aria-label="Clear the Pending only filter" title="Clear filter" onClick={clear}><X aria-hidden="true" /></Button>
          </span>
          <span className="text-xs text-muted-foreground">{view.hint}</span>
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={clear}>Show all tasks</Button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(15rem,1fr)_repeat(3,3.75rem)] grid-rows-[minmax(0,1fr)] gap-3 overflow-x-auto p-4 sm:px-6">
          <BoardColumnView label="Planning · pending tasks" icon={COLUMNS.planning.icon} attention={null} count={view.cards.length} drop={NO_DROP} planning actions={<StartPendingButton rows={bulkRows} onOpen={() => setDialog({ kind: 'bulk-start' })} />}>
            {view.cards.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
                {view.cards.map((row) => <OpenTaskCard key={row.id} row={row} agent={null} now={now} handlers={handlers} />)}
              </div>
            ) : <EmptyState subtitle={COLUMNS.planning.empty} loading={loading} />}
          </BoardColumnView>
          {view.strips.map(({ column, count }) => (
            <CollapsedColumnStrip key={column} buttonRef={null} label={COLUMNS[column].label} icon={COLUMNS[column].icon} count={count} attention={attention[column]} onExpand={clear} />
          ))}
        </div>
      </>
    );
  }

  return (
    <BugWorkflowIdContext.Provider value={bugWorkflowId}>
    <section className="flex min-h-0 flex-1 flex-col">
      {detailRunId ? (
        <WorkflowRunView key={`${detailRunId}:${runFocus?.stepId ?? ''}:${runFocus?.round ?? ''}`} runId={detailRunId} focus={runFocus} actions={actions} alerts={alerts} onBack={backFromDetail} />
      ) : activeTaskId ? (
        <TaskDetailsView
          key={activeTaskId}
          taskId={activeTaskId}
          historyIds={historyIds}
          actions={actions}
          alerts={alerts}
          onBack={backFromDetail}
          taskPanelSwap={taskPanelSwap}
          sessionTasks={{ onStart: (row) => setDialog({ kind: 'start', row }), onOpen: (detail) => showDetail(detail, activeTaskId) }}
        />
      ) : openedItem ? (
        itemDetailView(openedItem)
      ) : (
        <>
          {alerts}
          {pendingOnly && pendingOnlyBoard(pendingOnly)}
          <p className="sr-only" aria-live="polite">{dnd.announcement}</p>

          {!pendingOnly && <div className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 overflow-x-auto p-4 sm:px-6 ${completedCollapsed ? 'grid-cols-[repeat(3,minmax(15rem,1fr))_3.75rem]' : 'grid-cols-[repeat(4,minmax(15rem,1fr))]'}`}>
            {BOARD_COLUMNS.map((column) =>
              canCollapse(column) && completedCollapsed ? (
                <CollapsedColumnStrip
                  key={column}
                  buttonRef={stripRef}
                  label={COLUMNS[column].label}
                  icon={COLUMNS[column].icon}
                  count={columns[column].length}
                  attention={attention[column]}
                  onExpand={() => setCompletedCollapsed(false)}
                />
              ) : (
                <BoardColumnView
                  key={column}
                  label={COLUMNS[column].label}
                  icon={COLUMNS[column].icon}
                  attention={attention[column]}
                  count={column === 'planning' ? planningQueue.length : columns[column].length}
                  actions={columnActions(column)}
                  drop={dnd.columnDrop(column)}
                  planning={column === 'planning'}
                  lower={column === 'needsYou' ? { label: PR_NOT_MERGED.label, count: groups.prNotMerged.length, children: prNotMergedBody() } : undefined}
                >
                  {columnBody(column)}
                </BoardColumnView>
              ),
            )}
          </div>}
        </>
      )}

      {dialog?.kind === 'add' && <TaskPromptDialog project={project} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'plan-and-bugs' && <PlanAndBugsPromptDialog project={project} onClose={() => setDialog(null)} onSessionStarted={(taskId) => showDetail({ kind: 'task', id: taskId })} />}
      {dialog?.kind === 'chain' && (
        <ChainTasksDialog
          titles={dialog.titles}
          onCancel={() => setDialog(null)}
          onConfirm={async (autoMerge) => {
            if (!(await chainPlanningGroup(project.id, dialog.session, autoMerge))) throw new Error('The tasks could not be chained. See the error shown for the reason.');
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'start' && (
        <StartTaskDialog
          parents={startParents}
          title={dialog.row.title}
          workflows={workflows}
          {...startDialogChoice(dialog.row.id)}
          hasRepository={!!project.repositoryUrl}
          slotsInUse={slotsInUse}
          initialAutoMerge={items.find((candidate) => candidate.id === dialog.row.id)?.autoMerge?.enabled === true}
          initialUiPlanningWaits={items.find((candidate) => candidate.id === dialog.row.id)?.uiPlanningWaitsForParent === true}
          onCancel={() => setDialog(null)}
          onOpenTask={openConflictTask}
          onStart={async (options) => {
            await actions.start(dialog.row, options);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete this task?"
          description="This can't be undone."
          confirmLabel="Delete"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const id = dialog.id;
            setDialog(null);
            void actions.deleteItems([id]);
          }}
        />
      )}
      {dialog?.kind === 'bulk-start' && (
        <BulkStartDialog
          rows={bulkRows}
          hasRepository={!!project.repositoryUrl}
          slotsInUse={slotsInUse}
          lookupParents={(itemId) => serverApi.dependencyStatus(project.id, itemId).then(startConfirm)}
          start={actions.start}
          queue={() => useWorldStore.getState().planItemQueueByProject[project.id]}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'archiveAll' && (
        <ConfirmDialog
          title={`Archive ${plural(dialog.ids.length, 'completed task')}?`}
          description="They leave the board and move to the Archived tab, where you can unarchive them."
          confirmLabel="Archive all"
          destructive={false}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const rowIds = dialog.ids;
            setDialog(null);
            void actions.archiveItems(rowIds);
          }}
        />
      )}
    </section>
    </BugWorkflowIdContext.Provider>
  );
}
