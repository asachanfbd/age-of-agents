import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { FocusEvent, KeyboardEvent, PointerEvent } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronRight, Lightbulb } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useWorldStore } from '../store/worldStore';
import {
  CLOSED_POPOVER,
  buildTerminalSessionGroups,
  countTerminalSessionRows,
  popoverTransition,
  rowNavigationTarget,
} from '../lib/planningSessionsPopover';
import type { TerminalSessionEntry, PopoverEvent, PopoverState, PopoverTransition } from '../lib/planningSessionsPopover';
import { FooterListHeading } from './FooterListHeading';
import { isolateScroll } from '../lib/scrollIsolation';

const POPOVER_ID = 'planning-sessions-popover';
const ROW_SELECTOR = '[data-planning-session-row]';

/** Keeps the latest transition so the component can act on its timer and focus instructions after dispatch. */
function reduce(current: PopoverTransition, event: PopoverEvent): PopoverTransition {
  return popoverTransition(current.state, event);
}

function SessionRow({ session, onOpen }: { session: TerminalSessionEntry; onOpen: (session: TerminalSessionEntry) => void }) {
  return (
    <button
      type="button"
      data-planning-session-row
      aria-label={session.accessibleName}
      className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(session)}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span aria-hidden="true" className="size-2 flex-none rounded-full bg-success" />
        <span className="truncate text-xs font-medium text-foreground" title={session.name}>{session.name}</span>
        <span className="flex-none rounded-full bg-info/15 px-1.5 text-[11px] font-medium text-info-foreground">{session.kindLabel}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-3.5 flex-none text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

/** The live terminal sessions, straight from the store's latest daemon snapshot. */
function TerminalSessionsList({ onOpen }: { onOpen: (session: TerminalSessionEntry) => void }) {
  const projects = useWorldStore((s) => s.projects);
  const liveTerminalSessions = useWorldStore((s) => s.liveTerminalSessions);
  const groups = useMemo(() => buildTerminalSessionGroups(projects, liveTerminalSessions), [projects, liveTerminalSessions]);
  const total = countTerminalSessionRows(groups);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-foreground">Sessions</span>
        <span className="rounded-full bg-info/15 px-1.5 text-[11px] font-semibold tabular-nums text-info-foreground">{total}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">Across all projects</span>
      </div>
      {total === 0 ? (
        <p className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <Lightbulb aria-hidden="true" className="size-4" />
          No live sessions
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-1 pb-1">
          {groups.map((group) => (
            <section key={group.projectId ?? 'unknown'} aria-label={group.projectName}>
              <FooterListHeading name={group.projectName} count={group.sessions.length} />
              {group.sessions.map((session) => <SessionRow key={session.id} session={session} onOpen={onOpen} />)}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The footer's sessions count, which opens a popover listing every live terminal session. Hover opens it
 * after a short delay, keyboard focus opens it, and a click pins it (a second click closes it); Esc, an
 * outside click or opening a row closes it. The popover is stacked above the footer, and carries the
 * footer's marker so an open modal popup ignores interactions with it (see `isStatusFooterTarget`).
 */
export function PlanningSessionsCount({ value }: { value: number }) {
  const openPlanningSession = useWorldStore((s) => s.openPlanningSession);
  const [transition, dispatch] = useReducer(reduce, { state: CLOSED_POPOVER });
  const { mode }: PopoverState = transition.state;
  const open = mode !== 'closed';
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);

  // Act on the latest transition's instructions: (re)start or clear the hover timer, and return focus after Esc.
  useEffect(() => {
    const { timer, returnFocus } = transition;
    if (timer) {
      window.clearTimeout(timerRef.current);
      if (timer !== 'cancel') timerRef.current = window.setTimeout(() => dispatch(timer.event), timer.delayMs);
    }
    if (returnFocus) {
      // Already focused, the count gets no focus event to consume the skip, so clear it here.
      if (document.activeElement === triggerRef.current) dispatch('focus');
      else triggerRef.current?.focus();
    }
  }, [transition]);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  // See `isolateScroll`: keeps the list scrollable while a modal popup is open behind it.
  const detachScroll = useRef<(() => void) | null>(null);
  const setContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    detachScroll.current?.();
    detachScroll.current = node ? isolateScroll(node) : null;
  }, []);

  const rows = () => [...(contentRef.current?.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR) ?? [])];
  const focusRow = (key: string, current: number | null) => {
    const list = rows();
    const target = rowNavigationTarget(key, current, list.length);
    if (target === null) return false;
    list[target]!.focus();
    return true;
  };

  const onPointerEnter = (event: PointerEvent) => { if (event.pointerType !== 'touch') dispatch('pointerEnter'); };
  const onPointerLeave = (event: PointerEvent) => { if (event.pointerType !== 'touch') dispatch('pointerLeave'); };
  const isInside = (node: EventTarget | null) =>
    node instanceof Node && (!!triggerRef.current?.contains(node) || !!contentRef.current?.contains(node));
  const onBlur = (event: FocusEvent) => { if (!isInside(event.relatedTarget)) dispatch('focusLeave'); };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    dispatch('keyboardOpen');
    // The rows mount with the popover, so wait a frame when it has just opened.
    const key = event.key;
    requestAnimationFrame(() => focusRow(key, null));
  };
  const onContentKeyDown = (event: KeyboardEvent) => {
    const current = rows().indexOf(document.activeElement as HTMLButtonElement);
    if (current >= 0 && focusRow(event.key, current)) event.preventDefault();
  };

  const onOpenSession = useCallback((session: TerminalSessionEntry) => {
    dispatch('select');
    if (session.projectId) openPlanningSession(session.projectId, session.id);
  }, [openPlanningSession]);

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? POPOVER_ID : undefined}
          aria-label={`${value} live sessions. Show list`}
          title={`${value} live sessions`}
          data-pinned={mode === 'pinned' || undefined}
          className="-mx-1 flex items-center gap-1.5 whitespace-nowrap rounded px-1 text-[11px] text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-info/15 data-[pinned]:shadow-[inset_0_-2px_0_var(--color-info)]"
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onPointerDown={() => dispatch('pointerDown')}
          onFocus={() => dispatch('focus')}
          onBlur={onBlur}
          onClick={() => dispatch('click')}
          onKeyDown={onTriggerKeyDown}
        >
          <i aria-hidden="true" className="inline-block h-[5px] w-[5px] rounded-full bg-info" />
          <strong className="font-semibold tabular-nums text-foreground">{value}</strong>
          <span className="max-sm:sr-only">sessions</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        ref={setContent}
        id={POPOVER_ID}
        data-status-footer
        role="dialog"
        aria-label="Live sessions"
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        // Above the footer (and so above every popup, sheet, drawer and full-screen output beneath it).
        className="glass pointer-events-auto z-[165] flex max-h-[min(440px,calc(100dvh-var(--status-footer-height)-16px))] w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => dispatch('escape')}
        onPointerDownOutside={(event) => {
          // A press on the count is handled by its own click, which toggles the pin.
          if (isInside(event.target)) event.preventDefault();
          else dispatch('outside');
        }}
        // Focus leaving is handled by `onBlur`; an open modal's focus trap pulling focus back must not close this.
        onFocusOutside={(event) => event.preventDefault()}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onBlur={onBlur}
        onKeyDown={onContentKeyDown}
      >
        <TerminalSessionsList onOpen={onOpenSession} />
        <PopoverPrimitive.Arrow aria-hidden="true" className="fill-popover" width={12} height={6} />
      </PopoverContent>
    </Popover>
  );
}
