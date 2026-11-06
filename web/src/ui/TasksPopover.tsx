import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Dispatch, ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronRight, ListChecks } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useWorldStore } from '../store/worldStore';
import { useNow } from '../lib/useNow';
import { isolateScroll } from '../lib/scrollIsolation';
import { FOOTER_POPOVER_CLOSE_DELAY_MS, FOOTER_POPOVER_OPEN_DELAY_MS } from '../lib/footerPopoverState';
import type { FooterPopoverAction, FooterPopoverState } from '../lib/footerPopoverState';
import { EMPTY_TASKS_MESSAGE, TASK_KIND_DOT, buildTasksPopupGroups, taskRowTimeLabel } from '../lib/footerPopovers';
import type { FooterTaskKind, FooterTaskRow } from '../lib/footerPopovers';
import { FooterListHeading } from './FooterListHeading';
import { useFooterBoards } from './useFooterBoards';

export const TASKS_POPOVER_ID = 'tasks';

const TASK_KIND_TEXT: Record<FooterTaskKind, string> = {
  active: 'text-warning',
  blocked: 'text-destructive',
  pending: 'text-muted-foreground',
};

function TaskRow({ row, projectName, now, onOpen }: { row: FooterTaskRow; projectName: string; now: Date; onOpen: (row: FooterTaskRow) => void }) {
  const word = row.label;
  const time = taskRowTimeLabel(row.kind, row, now);
  const agent = row.agent ?? 'No agent assigned';
  return (
    <button
      type="button"
      aria-label={[row.title, projectName, word, row.detail, time, agent].filter(Boolean).join(', ')}
      className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(row)}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className={`size-2 flex-none rounded-full ${TASK_KIND_DOT[row.kind]}`} />
          <span className="truncate text-xs font-medium text-foreground" title={row.title}>{row.title}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-[11px] text-muted-foreground">
          <span className={`font-medium ${TASK_KIND_TEXT[row.kind]}`}>{word}</span>
          {row.detail && <span className="max-w-full truncate" title={row.detail}>{row.detail}</span>}
          {time && <span>{time}</span>}
          <span>{agent}</span>
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-3.5 flex-none text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

/** Every active, blocked and pending task under ranked project headings: mounted only while open, so its times tick only then. */
function TasksList({ onDone }: { onDone: () => void }) {
  const boards = useFooterBoards();
  const openCard = useWorldStore((s) => s.openWorkspaceCardDetail);
  const now = new Date(useNow(15_000));
  const groups = useMemo(() => buildTasksPopupGroups(boards), [boards]);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const open = (row: FooterTaskRow) => { openCard(row.projectId, row.open); onDone(); };

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-foreground">Tasks</span>
        <span className="rounded-full bg-foreground/10 px-1.5 text-[11px] font-semibold tabular-nums text-foreground">{total}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">Across all projects</span>
      </div>
      {total === 0 ? (
        <p className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <ListChecks aria-hidden="true" className="size-4" />
          {EMPTY_TASKS_MESSAGE}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-1 pb-1">
          {groups.map((group) => (
            <section key={group.projectId} aria-label={group.projectName}>
              <FooterListHeading name={group.projectName} taskCounts={group.counts} />
              {group.rows.map((row) => <TaskRow key={row.id} row={row} projectName={group.projectName} now={now} onOpen={open} />)}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

export interface TasksTrigger {
  kind: FooterTaskKind;
  /** The count in words ("3 active tasks"). */
  label: string;
  node: ReactNode;
}

/**
 * The footer's three task counts as one trigger for one popover listing every active, blocked and pending
 * task. Hover (after a short delay) or focus on any count opens it, a click on any pins it and a click on
 * any while pinned closes it; moving between the counts never closes it, because the pointer and focus
 * rules sit on the wrapper around all three. Esc, an outside click or opening a row closes it. It shares
 * the footer's one-open-at-a-time state, stacks above the footer and carries the footer's marker so an
 * open modal ignores interactions with it.
 */
export function TasksCountPopover({ state, dispatch, triggers }: {
  state: FooterPopoverState | null;
  dispatch: Dispatch<FooterPopoverAction>;
  triggers: TasksTrigger[];
}) {
  const open = state?.id === TASKS_POPOVER_ID;
  const pinned = open && state.pinned;
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number>(0);
  const detachScroll = useRef<(() => void) | null>(null);

  const schedule = (action: FooterPopoverAction, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => dispatch(action), delay);
  };
  const cancel = () => window.clearTimeout(timer.current);
  useEffect(() => cancel, []);

  // See `isolateScroll`: keeps the list scrollable while a modal popup is open behind it.
  const setContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    detachScroll.current?.();
    detachScroll.current = node ? isolateScroll(node) : null;
  }, []);

  const isInside = (node: EventTarget | null) =>
    node instanceof Node && (!!wrapperRef.current?.contains(node) || !!contentRef.current?.contains(node));
  const enter = () => schedule({ type: 'preview', id: TASKS_POPOVER_ID }, FOOTER_POPOVER_OPEN_DELAY_MS);
  const leave = () => schedule({ type: 'unpreview', id: TASKS_POPOVER_ID }, FOOTER_POPOVER_CLOSE_DELAY_MS);
  const close = () => dispatch({ type: 'close' });

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <span
          ref={wrapperRef}
          className="flex items-center gap-2.5 max-sm:gap-2"
          onMouseEnter={enter}
          onMouseLeave={leave}
          onFocus={() => dispatch({ type: 'preview', id: TASKS_POPOVER_ID })}
          onBlur={(event) => { if (!isInside(event.relatedTarget)) dispatch({ type: 'unpreview', id: TASKS_POPOVER_ID }); }}
        >
          {triggers.map(({ kind, label, node }) => (
            <button
              key={kind}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? TASKS_POPOVER_ID : undefined}
              aria-label={`${label}, opens the tasks list`}
              data-pinned={pinned || undefined}
              className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring data-[pinned]:shadow-[inset_0_-2px_0_var(--color-foreground)]"
              onClick={() => { cancel(); dispatch({ type: 'toggle', id: TASKS_POPOVER_ID }); }}
            >
              {node}
            </button>
          ))}
        </span>
      </PopoverAnchor>
      <PopoverContent
        ref={setContent}
        id={TASKS_POPOVER_ID}
        data-status-footer
        role="dialog"
        aria-label="Tasks across all projects"
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        // Above the footer (and so above every popup, sheet, drawer and full-screen output beneath it).
        className="glass pointer-events-auto z-[165] flex max-h-[min(440px,calc(100dvh-var(--status-footer-height)-16px))] w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={close}
        onPointerDownOutside={(event) => {
          // A press on a count is handled by its own click, which toggles the pin.
          if (isInside(event.target)) event.preventDefault();
          else close();
        }}
        // Focus leaving is handled by the wrapper's `onBlur`; an open modal's focus trap pulling focus back must not close this.
        onFocusOutside={(event) => event.preventDefault()}
        onMouseEnter={cancel}
        onMouseLeave={leave}
        onBlur={(event) => { if (!isInside(event.relatedTarget)) dispatch({ type: 'unpreview', id: TASKS_POPOVER_ID }); }}
      >
        <TasksList onDone={close} />
        <PopoverPrimitive.Arrow aria-hidden="true" className="fill-popover" width={12} height={6} />
      </PopoverContent>
    </Popover>
  );
}
