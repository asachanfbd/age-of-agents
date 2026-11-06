import { TASK_KIND_DOT, taskCountsLabel } from '../lib/footerPopovers';
import type { FooterTaskCounts, FooterTaskKind } from '../lib/footerPopovers';

const TASK_KINDS: FooterTaskKind[] = ['active', 'blocked', 'pending'];

/** The project's counts per state: a dot and number for each state it has, none for zero. */
function TaskCountsBadge({ counts }: { counts: FooterTaskCounts }) {
  return (
    <span aria-label={taskCountsLabel(counts)} className="flex flex-none items-center gap-1.5 text-[10px] font-bold leading-4 tabular-nums">
      {TASK_KINDS.filter((kind) => counts[kind] > 0).map((kind) => (
        <span key={kind} aria-hidden="true" className="flex items-center gap-1">
          <i className={`inline-block size-[6px] rounded-full ${TASK_KIND_DOT[kind]}`} />
          {counts[kind]}
        </span>
      ))}
    </span>
  );
}

/**
 * A project's heading in a footer list: bold, high contrast, on a solid band that stays pinned while the
 * project's rows scroll under it. The badge is a row count, or, with `taskCounts`, a count per task state.
 */
export function FooterListHeading({ name, count, taskCounts }: { name: string; count?: number; taskCounts?: FooterTaskCounts }) {
  return (
    <h3 className="sticky top-0 z-[1] flex min-w-0 items-center gap-1.5 border-b border-border bg-popover px-2.5 py-1 text-[12px] font-bold text-foreground">
      <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
      {taskCounts ? (
        <TaskCountsBadge counts={taskCounts} />
      ) : count !== undefined && (
        <span aria-label={`${count} listed`} className="flex-none rounded-full bg-foreground px-1.5 text-[10px] font-bold leading-4 tabular-nums text-background">{count}</span>
      )}
    </h3>
  );
}
