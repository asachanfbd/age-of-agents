import type { ReactNode } from 'react';
import { Bug, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BUG_REPORT_LABEL, bugGroupCountLabel, bugGroupKey, bugReportCardLine, bugReportStatusLabel, taskRefLabel } from '../../lib/bugs';
import type { BugReferenceGroup, ReferenceStatus } from '../../lib/bugs';
import type { OpenTaskRow, PlanningGroup } from '../../lib/projectTasks';
import { boardKeyAction, cardStartedLabel } from '../../lib/taskBoard';
import { TaskCard } from './TaskBoard';
import type { CardDnd } from './useBoardDnd';

const REFERENCE_STATUS_VARIANT: Record<ReferenceStatus, 'success' | 'warning' | 'soft-destructive' | 'secondary'> = {
  Running: 'success',
  'Needs you': 'warning',
  Failed: 'soft-destructive',
  Stopped: 'secondary',
  Completed: 'success',
  Removed: 'secondary',
};

/**
 * The card for the task that introduced the bugs nested beneath it. A reference only: it has no drag
 * handle and is never draggable, nothing can be started from it, and it opens that task's normal
 * detail view. Once the task is removed it shows the stored number and title struck through and
 * does nothing.
 */
export function ReferenceCard({ group, nested, onOpen }: { group: BugReferenceGroup<OpenTaskRow>; nested: boolean; onOpen: () => void }) {
  const label = taskRefLabel(group);
  const opens = group.removed ? {} : {
    role: 'button',
    tabIndex: 0,
    'aria-label': `Open introducing task "${label}"`,
    onClick: onOpen,
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (boardKeyAction('reference', event) !== 'open') return;
      event.preventDefault();
      onOpen();
    },
  };
  return (
    <article data-card data-reference data-nested={nested || undefined} draggable={false} className="rounded-lg border border-dashed bg-muted/40 text-card-foreground">
      <div {...opens} className={`rounded-lg p-3 ${group.removed ? '' : 'cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'}`}>
        <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Introducing task</p>
        <div className="mt-1 flex items-start justify-between gap-2">
          <p className={`line-clamp-2 text-sm leading-5 font-medium break-words ${group.removed ? 'text-muted-foreground line-through' : ''}`} title={label}>{label}</p>
          {group.status && <Badge variant={REFERENCE_STATUS_VARIANT[group.status]}>{group.status}</Badge>}
        </div>
      </div>
    </article>
  );
}

/**
 * An introducing-task reference card with its ready bugs nested beneath it. The expander is its own
 * button: it only shows or hides the bugs, and never opens the task. `nested` is the group shown
 * beneath a planning conversation rather than at the top level of the column.
 */
export function BugGroupView({ group, nested, expanded, onToggle, onOpen, renderBug }: {
  group: BugReferenceGroup<OpenTaskRow>;
  nested: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  renderBug: (bug: OpenTaskRow) => ReactNode;
}) {
  return (
    <div>
      <ReferenceCard group={group} nested={nested} onOpen={onOpen} />
      <Button type="button" variant="ghost" size="sm" className="mt-1 w-full justify-start text-xs text-destructive" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />} <Bug aria-hidden="true" /> {bugGroupCountLabel(group.bugs.length)}
      </Button>
      {expanded && <div data-group-list={bugGroupKey(group.id)} className="ml-4 space-y-2 border-l-2 border-destructive/30 pl-2">{group.bugs.map(renderBug)}</div>}
    </div>
  );
}

/**
 * A bug report session on the board: a session card like a planning conversation's, labelled "Bug
 * report" in text. Its bugs are not nested under it — they sit under their introducing tasks — so a
 * plain line says how many are ready, or that the session still waits for a coding agent.
 */
export function BugReportSessionCard({ row, agent, now, dnd, onOpen }: { row: PlanningGroup; agent: string | null; now: Date; dnd: CardDnd; onOpen: () => void }) {
  const { cliNotStarted } = row;
  return (
    <div>
      <TaskCard
        title={row.title}
        agent={agent}
        started={cardStartedLabel(cliNotStarted ? null : row.metrics, now)}
        attention={row.attention}
        dnd={dnd}
        onOpen={onOpen}
        planning
        dragHandle
        typeLabel={BUG_REPORT_LABEL}
        typeIcon={Bug}
        status={bugReportStatusLabel({ live: row.live, cliNotStarted })}
      />
      <p className="mt-1 px-2 text-xs text-muted-foreground">{bugReportCardLine({ cliNotStarted, readyCount: row.readyBugCount ?? 0, readyTaskCount: row.readyTaskCount, filedCount: row.createdTaskCount })}</p>
    </div>
  );
}
