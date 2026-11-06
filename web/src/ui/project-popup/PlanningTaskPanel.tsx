import { useLayoutEffect, useMemo, useRef } from 'react';
import { ArrowUpRight, ChevronDown, Columns2, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { buildPlanningTaskPanel, isRowExpanded, planningRowDetail, sessionPanelWording, taskPanelLayout } from '../../lib/planningTaskPanel';
import { sessionKindOf } from '../../lib/bugs';
import type { PlanningPanelRow, TaskPanelSwap } from '../../lib/planningTaskPanel';
import type { CardDetail } from '../../lib/taskBoard';
import { useWorldStore } from '../../store/worldStore';
import type { PlanItemData, TaskData } from '../../types';
import { TaskSpecification } from './DetailHeader';
import type { SessionTaskPanelState } from './useSessionTaskPanelState';

const EMPTY_ITEMS: PlanItemData[] = [];

/** What the Tasks tab does for a panel row: its guarded Start task dialog, and its detail views. */
export interface SessionTaskHandlers {
  /** `title` is the task's full title, number included, as the board's cards pass it. */
  onStart: (row: { id: string; title: string }) => void;
  onOpen: (detail: CardDetail) => void;
}

/**
 * The tasks a planning session created — or the bugs and tasks a bug-filing session filed — beside its CLI: number, title and status badge per row, in
 * creation order, from the plan items and Tasks the store already holds. A ready row expands in place
 * to its description and a Start button; a started or completed row opens in its normal viewer.
 */
export function PlanningTaskPanel({ task, state, handlers, swap }: { task: TaskData; state: SessionTaskPanelState; handlers: SessionTaskHandlers; swap: TaskPanelSwap }) {
  const layout = taskPanelLayout(swap.arrangement);
  const items = useWorldStore((s) => s.planByProject[task.projectId]?.items) ?? EMPTY_ITEMS;
  const tasksById = useWorldStore((s) => s.tasksById);
  const kind = sessionKindOf(task);
  const wording = sessionPanelWording(kind);
  const panel = useMemo(
    () => buildPlanningTaskPanel({ items, tasksById, sessionNumber: task.planningSessionNumber ?? null, createdTaskCount: task.planningCreatedTaskCount ?? 0, kind }),
    [items, tasksById, task.planningSessionNumber, task.planningCreatedTaskCount, kind],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const { readScrollTop } = state;
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = readScrollTop();
  }, [readScrollTop]);

  function activate(row: PlanningPanelRow) {
    if (row.action === 'expand') {
      state.onToggle(row.id);
      return;
    }
    // Null when the task was deleted between render and click; the row is already on its way out.
    const detail = planningRowDetail(items, tasksById, row.id);
    if (detail) handlers.onOpen(detail);
  }

  return (
    <aside aria-label={wording.heading} className={`flex min-h-0 min-w-0 ${layout.panelClass} flex-col border-l`}>
      <header className="flex shrink-0 items-start gap-2 border-b bg-info/10 px-3 py-2 text-xs">
        <div className="min-w-0 flex-1">
          <h4 className="font-medium text-info-foreground">{wording.heading}</h4>
          <p className="break-words text-muted-foreground">{panel.countsLabel}</p>
        </div>
        <button
          type="button"
          aria-label={layout.swapLabel}
          aria-pressed={layout.swapPressed}
          title={layout.swapLabel}
          onClick={swap.onToggle}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Columns2 aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div ref={listRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" onScroll={(event) => state.saveScrollTop(event.currentTarget.scrollTop)}>
        {panel.empty ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{wording.emptyText}</p>
        ) : (
          <ul>
            {panel.rows.map((row) => (
              <PanelRow key={row.id} row={row} expanded={isRowExpanded(state.expanded, row)} onActivate={() => activate(row)} onStart={() => handlers.onStart({ id: row.id, title: row.fullTitle })} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** An expanded row's header stays in view over its description, so its background and hover are both opaque. */
const STICKY_ROW = 'sticky top-0 z-10 bg-background hover:bg-muted';

function PanelRow({ row, expanded, onActivate, onStart }: { row: PlanningPanelRow; expanded: boolean; onActivate: () => void; onStart: () => void }) {
  const expandable = row.action === 'expand';
  const Icon = expandable ? ChevronDown : ArrowUpRight;
  return (
    <li className="border-b">
      <button
        type="button"
        aria-expanded={expandable ? expanded : undefined}
        title={expandable ? undefined : 'Open task'}
        onClick={onActivate}
        className={`flex w-full items-start gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${expanded ? STICKY_ROW : 'hover:bg-muted/50'}`}
      >
        <span className="min-w-0 flex-1">
          {(row.number || row.kindTag) && <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">{row.number}{row.kindTag && <Badge variant="outline" className="font-sans">{row.kindTag}</Badge>}</span>}
          <span className={`block break-words text-sm ${expanded ? '' : 'line-clamp-2'}`}>{row.title}</span>
          {row.related?.map((link) => (
            <span key={`${link.prefix}:${link.itemId ?? link.text}`} className={`block truncate text-xs text-muted-foreground ${link.itemId ? '' : 'line-through'}`}>{link.prefix} {link.text}</span>
          ))}
          {row.dependsOnChip && <span className="mt-0.5 block text-xs break-words text-muted-foreground" data-depends-chip>{row.dependsOnChip}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={row.badge.variant}>{row.badge.label}</Badge>
          {row.lockedLabel && <Badge variant="outline">{row.lockedLabel}</Badge>}
        </span>
        <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 text-muted-foreground ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="flex flex-col items-start gap-2 px-3 pb-3">
          <div className="w-full min-w-0 overflow-x-auto rounded-md bg-muted/50 px-3 py-2 break-words">
            <TaskSpecification description={row.description} />
          </div>
          <Button type="button" size="sm" onClick={onStart}>
            <Play aria-hidden="true" /> Start
          </Button>
        </div>
      )}
    </li>
  );
}
