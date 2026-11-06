import { useMemo, useState } from 'react';
import { buildArchivedRows, buildPlanningRows, workerLabel } from '../../lib/projectTasks';
import { archivedSessionLabel, sessionTypeLabel } from '../../lib/bugs';
import type { CompletedRow } from '../../lib/projectTasks';
import type { WorkflowRunRecord } from '../../lib/serverApi';
import { cardDetail } from '../../lib/taskBoard';
import { useNow } from '../../lib/useNow';
import { useWorldStore } from '../../store/worldStore';
import type { PlanItemData, ProjectData } from '../../types';
import { CompletedTaskCard, TaskCard } from './TaskBoard';
import { ConfirmDialog } from './TaskDialogs';
import { TaskDetailsView } from './TaskDetailsView';
import { TaskItemDetailsView } from './TaskItemDetailsView';
import { ActionAlerts } from './TaskListParts';
import { useCardDetail } from './useCardDetail';
import { useTaskActions } from './useTaskActions';
import { WorkflowRunView } from './WorkflowRunView';

const ARCHIVED_STATUS = { label: 'Archived', variant: 'secondary' } as const;

/** Stable references, so the memoized rows aren't recomputed every render while nothing has loaded. */
const EMPTY_ITEMS: PlanItemData[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_RUNS: WorkflowRunRecord[] = [];

/**
 * The unified archive for task cards and completed planning conversations. Cards share one
 * newest-first order and open their detail, where restore and delete actions remain available.
 */
export function ArchivedPanel({ project }: { project: ProjectData }) {
  const items = useWorldStore((s) => s.planByProject[project.id]?.items) ?? EMPTY_ITEMS;
  const tasksById = useWorldStore((s) => s.tasksById);
  const taskIds = useWorldStore((s) => s.taskIdsByProject[project.id]) ?? EMPTY_IDS;
  const runs = useWorldStore((s) => s.workflowRunsByProject[project.id]) ?? EMPTY_RUNS;
  const executors = useWorldStore((s) => s.executors);
  const nowMs = useNow();
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const detail = useCardDetail(taskIds);
  const actions = useTaskActions(project, (taskId) => detail.show({ kind: 'task', id: taskId }));
  const rows = useMemo(() => buildArchivedRows({ items, tasksById, workflowRuns: runs, now: nowMs }), [items, tasksById, runs, nowMs]);
  const planningRows = useMemo(() => buildPlanningRows({ taskIds, tasksById, showArchived: true, now: nowMs, includeBugReports: true }), [taskIds, tasksById, nowMs]);
  const archiveEntries = useMemo(() => [
    ...planningRows.map((row) => ({ kind: 'planning' as const, id: row.id, completedAt: row.completedAt ?? row.metrics.startedAt, row })),
    ...rows.map((row) => ({ kind: 'task' as const, id: row.id, completedAt: row.completedAt ?? row.createdAt, row })),
  ].sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.id.localeCompare(b.id)), [planningRows, rows]);

  const back = () => detail.show(null);
  const alerts = <ActionAlerts error={actions.error} notice={actions.notice} onDismissNotice={actions.clearNotice} />;
  /** The opened not-started item, while it's still archived; unarchived or deleted, the list comes back. */
  const openedItem = detail.itemId ? items.find((item) => item.id === detail.itemId && item.archived) : undefined;

  const handlers = {
    onOpen: (row: CompletedRow) => detail.show(cardDetail(row)),
    onArchive: (id: string) => void actions.archive(id),
    onUnarchive: (id: string) => void actions.unarchive(id),
    onDelete: setDeleteId,
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Archived tasks and planning sessions">
      {detail.runId ? (
        <WorkflowRunView key={detail.runId} runId={detail.runId} actions={actions} alerts={alerts} onBack={back} />
      ) : detail.taskId ? (
        <TaskDetailsView key={detail.taskId} taskId={detail.taskId} historyIds={detail.historyIds} actions={actions} alerts={alerts} onBack={back} />
      ) : openedItem ? (
        <TaskItemDetailsView key={openedItem.id} item={openedItem} status={ARCHIVED_STATUS} alerts={alerts} actions={actions} onBack={back} />
      ) : (
        <>
          {alerts}
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2 overflow-y-auto p-4 sm:px-6">
            {archiveEntries.map((entry) => entry.kind === 'planning' ? (
              <TaskCard key={`planning-${entry.id}`} title={entry.row.title} agent={workerLabel(executors, entry.row.workerId)} started={archivedSessionLabel(entry.row)} attention={null} onOpen={() => detail.show({ kind: 'task', id: entry.row.id })} planning typeLabel={sessionTypeLabel(entry.row.kind)} />
            ) : (
              <CompletedTaskCard key={entry.id} row={entry.row} agent={workerLabel(executors, entry.row.workerId)} now={now} {...handlers} />
            ))}
          </div>
        </>
      )}

      {deleteId && (
        <ConfirmDialog
          title="Delete this task?"
          description="This can't be undone."
          confirmLabel="Delete"
          onCancel={() => setDeleteId(null)}
          onConfirm={() => {
            const id = deleteId;
            setDeleteId(null);
            void actions.deleteItems([id]);
          }}
        />
      )}
    </section>
  );
}
