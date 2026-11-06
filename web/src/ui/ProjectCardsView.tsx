import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { GripVertical, Library, MoveRight } from 'lucide-react';
import { useWorldStore } from '../store/worldStore';
import { taskProgressLabel } from '../lib/projectTasks';
import { useProjectIndicators } from '../lib/useProjectIndicators';
import { buildingBadge } from '../lib/buildingTypes';
import {
  SIDES, announce, buildStreets, canDrop, dropRefusal, filterStreets, finishPointerDrag, freeSlotOptions, hitOfElement, isSameSlot,
  isStreetCollapsed, slotAttributeValue, slotDataAttributes, slotLabel, stepKeyboardMove, streetProjectCount,
  type DropHit, type KeyboardMove, type Side, type SlotRef, type StreetView,
} from '../lib/townGroups';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ProjectData } from '../types';
import { ProjectStatusDot } from './ProjectStatusDot';
import { TaskProgressBar } from './TaskProgressBar';

const CARD_CLASS =
  'flex min-h-28 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left text-card-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-muted/40';
const DRAG_START_DISTANCE = 4;

interface MoveHandlers {
  moving: { projectId: string; target: SlotRef } | null;
  dragging: string | null;
  onKeyboardKey: (project: ProjectData, key: string) => boolean;
  onPointerStart: (project: ProjectData, event: PointerEvent<HTMLDivElement>) => void;
  onMoveTo: (project: ProjectData, slot: SlotRef) => void;
}

function MoveToMenu({ project, onMoveTo }: { project: ProjectData; onMoveTo: MoveHandlers['onMoveTo'] }) {
  const projects = useWorldStore((s) => s.projects);
  const options = freeSlotOptions(projects.map((p) => ({ id: p.id, position: p.position })));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Move ${project.name} to…`} title="Move to…">
          <MoveRight className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto" onCloseAutoFocus={(event) => event.preventDefault()}>
        {options.length === 0 && <DropdownMenuItem disabled>No free slots</DropdownMenuItem>}
        {options.map(({ street, slots }) => (
          <div key={street}>
            <DropdownMenuLabel>Street {street}</DropdownMenuLabel>
            {slots.map((ref) => (
              <DropdownMenuItem key={`${ref.side}${ref.slot}`} onSelect={() => onMoveTo(project, ref)}>{slotLabel(ref)}</DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectCard({ project, handlers }: { project: ProjectData; handlers: MoveHandlers }) {
  const openWorkspace = useWorldStore((s) => s.openWorkspace);
  const { statusStyle, dotLabel, progress } = useProjectIndicators(project);
  const badge = buildingBadge(project);
  const suppressClick = useRef(false);
  const picked = handlers.moving?.projectId === project.id;
  const dragged = handlers.dragging === project.id;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (handlers.onKeyboardKey(project, event.key)) event.preventDefault();
  };

  return (
    <div
      className={`${CARD_CLASS} group relative w-full touch-manipulation ${picked ? 'ring-2 ring-primary' : ''} ${dragged ? 'opacity-40' : ''}`}
      onPointerDown={(event) => {
        suppressClick.current = false;
        handlers.onPointerStart(project, event);
      }}
      onPointerMoveCapture={() => { if (dragged) suppressClick.current = true; }}
      data-project-card={project.id}
    >
      <button
        type="button"
        className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-primary"
        onClick={() => { if (!suppressClick.current && !handlers.moving) openWorkspace(project.id); }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => { if (event.key === ' ') event.preventDefault(); }}
        aria-label={`Open ${project.name}`}
        aria-describedby="town-move-hint"
      />
      <span className="pointer-events-none flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-sm font-semibold">{project.name}</span>
          {badge && <Badge variant="warning" className="text-[10px]">{badge}</Badge>}
        </span>
        <ProjectStatusDot style={statusStyle} label={dotLabel} />
      </span>
      <span className="pointer-events-none mt-auto flex flex-col gap-1.5">
        {progress ? <TaskProgressBar progress={progress} /> : <span className="h-1.5 w-full rounded-full bg-muted-foreground/25" />}
        <span className="text-xs text-muted-foreground">{progress ? taskProgressLabel(progress) : 'No tasks yet'}</span>
      </span>
      <span className="absolute right-2 bottom-2 z-10" onPointerDown={(event) => event.stopPropagation()}>
        <MoveToMenu project={project} onMoveTo={handlers.onMoveTo} />
      </span>
    </div>
  );
}

function slotClass(state: 'idle' | 'target' | 'valid' | 'refused', empty: boolean): string {
  const base = 'min-h-28 rounded-xl list-none';
  if (state === 'refused') return `${base} cursor-not-allowed ring-2 ring-destructive/70`;
  if (state === 'target') return `${base} ring-2 ring-primary bg-primary/10`;
  if (state === 'valid') return `${base} border-2 border-dashed border-primary/50`;
  return empty ? `${base} border-2 border-dashed border-border` : base;
}

/**
 * The non-3D overview: the Catalog pinned on top, then the town's twelve streets, each with a left
 * side, a road and a right side of ten slots (see lib/townGroups.ts). A project sits in the slot for its stored
 * position, so it appears where it stands in 3D; it can be moved to any empty slot by pointer drag,
 * by keyboard (Space, arrows, Enter, Escape) or from its "Move to…" menu. Rendered in place of the 3D
 * canvas (see App.tsx) so three.js never loads while this mode is on.
 */
export function ProjectCardsView() {
  const projects = useWorldStore((s) => s.projects);
  const openCatalog = useWorldStore((s) => s.openCatalog);
  const moveProjectToSlot = useWorldStore((s) => s.moveProjectToSlot);
  const [pickedUp, setKeyboardMove] = useState<KeyboardMove | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<{ projectId: string; x: number; y: number; hit: DropHit | null } | null>(null);
  const [message, setMessage] = useState('');

  const [query, setQuery] = useState('');
  const [onlyOccupied, setOnlyOccupied] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const positioned = projects.map((p) => ({ id: p.id, position: p.position }));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const streets = filterStreets(buildStreets(positioned), new Map(projects.map((p) => [p.id, p.name])), query, onlyOccupied);
  const toggleStreet = (street: number) => setExpanded((open) => { const next = new Set(open); if (!next.delete(street)) next.add(street); return next; });
  // A project deleted mid-move simply ends the move.
  const keyboardMove = pickedUp && byId.has(pickedUp.projectId) ? pickedUp : null;

  // A moved card remounts in its new slot, so keyboard focus is handed back to it explicitly.
  const focusCard = useCallback((id: string) => setFocusRequest((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 })), []);
  useEffect(() => {
    if (!focusRequest) return;
    document.querySelector<HTMLElement>(`[data-project-card="${focusRequest.id}"] button`)?.focus();
  }, [focusRequest]);
  useEffect(() => () => dragCleanup.current?.(), []);

  const drop = useCallback((projectId: string, target: SlotRef | null) => {
    const state = useWorldStore.getState();
    const name = state.projects.find((p) => p.id === projectId)?.name;
    if (!name) return;
    const current = state.projects.map((p) => ({ id: p.id, position: p.position }));
    if (!target || !canDrop(current, projectId, target)) {
      setMessage(announce.refused(target));
      focusCard(projectId);
      return;
    }
    void moveProjectToSlot(projectId, target).then((moved) => {
      setMessage(moved ? announce.dropped(name, target) : `${name} could not be moved and stays where it was`);
      focusCard(projectId);
    });
    focusCard(projectId);
  }, [moveProjectToSlot, focusCard]);

  const cancelAll = useCallback(() => { setDrag(null); setKeyboardMove(null); }, []);

  const onPointerStart = (project: ProjectData, event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || event.button !== 0 || (event.target as Element).closest('[role="menuitem"], [aria-haspopup]')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const el = event.currentTarget;
    const pointerId = event.pointerId;
    let started = false;
    const cleanup = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', cancel);
      dragCleanup.current = null;
    };
    // Cancelling (Escape, resize, pointercancel) ends the drag on the spot rather than on the next pointer event.
    const finish = (hit: DropHit | null, cancelled: boolean) => {
      cleanup();
      if (!started) return;
      setDrag(null);
      const result = finishPointerDrag(hit, cancelled);
      if (result.message) setMessage(result.message);
      if (result.drop) drop(project.id, result.drop);
      else focusCard(project.id);
    };
    const cancel = () => finish(null, true);
    const onKey = (key: globalThis.KeyboardEvent) => { if (key.key === 'Escape') cancel(); };
    const onMove = (move: globalThis.PointerEvent) => {
      if (!started && Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_START_DISTANCE) return;
      if (!started) { started = true; try { el.setPointerCapture(pointerId); } catch { /* the pointer may already be gone */ } }
      setDrag({ projectId: project.id, x: move.clientX, y: move.clientY, hit: hitOfElement(document.elementFromPoint(move.clientX, move.clientY)) });
    };
    const onUp = (up: globalThis.PointerEvent) => finish(hitOfElement(document.elementFromPoint(up.clientX, up.clientY)), false);
    dragCleanup.current?.();
    dragCleanup.current = cleanup;
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', cancel);
  };

  const onKeyboardKey = (project: ProjectData, key: string): boolean => {
    const step = stepKeyboardMove(positioned, keyboardMove, project, key);
    setKeyboardMove(step.move);
    if (step.message) setMessage(step.message);
    if (step.drop) drop(project.id, step.drop);
    else if (keyboardMove && !step.move) focusCard(project.id);
    return step.handled;
  };

  const handlers: MoveHandlers = {
    moving: keyboardMove,
    dragging: drag?.projectId ?? null,
    onKeyboardKey,
    onPointerStart,
    onMoveTo: (project, slot) => drop(project.id, slot),
  };

  const slotState = (ref: SlotRef, occupied: boolean): 'idle' | 'target' | 'valid' | 'refused' => {
    if (keyboardMove) return isSameSlot(ref, keyboardMove.target) ? 'target' : 'idle';
    if (!drag) return 'idle';
    const hovered = drag.hit?.kind === 'slot' && isSameSlot(drag.hit.ref, ref);
    if (occupied) return hovered ? 'refused' : 'idle';
    return hovered ? 'target' : 'valid';
  };

  const dragRefusal = drag ? dropRefusal(positioned, drag.projectId, drag.hit) : null;
  const dragged = drag ? byId.get(drag.projectId) : undefined;

  return (
    <main
      className="absolute inset-0 overflow-y-auto bg-background px-6 pb-[calc(var(--status-footer-height)+5rem)] pt-64 max-sm:px-3 max-sm:pt-40"
      aria-label="Projects"
      style={drag ? { cursor: dragRefusal ? 'not-allowed' : 'grabbing' } : undefined}
      onBlurCapture={(event) => { if (keyboardMove && !event.currentTarget.contains(event.relatedTarget as Node | null)) cancelAll(); }}
    >
      <p id="town-move-hint" className="sr-only">Press Space to pick up this project, arrow keys to choose an empty slot, Enter to drop and Escape to cancel. Press Enter to open it.</p>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{message}</div>
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div {...{ [slotDataAttributes.catalog]: '' }} className={drag ? 'cursor-not-allowed' : ''}>
          <button type="button" className={`${CARD_CLASS} min-h-0 w-full border-dashed ${drag?.hit?.kind === 'catalog' ? 'ring-2 ring-destructive/70' : ''}`} onClick={openCatalog}>
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Library className="size-4" aria-hidden="true" />
              Catalog
            </span>
            <span className="text-xs text-muted-foreground">Agents and skills available to every project</span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a project or street"
            aria-label="Find a project or street"
            className="h-9 w-64 rounded-md border border-input bg-background px-3 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={onlyOccupied} onChange={(event) => setOnlyOccupied(event.target.checked)} />
            Only streets with projects
          </label>
        </div>
        {streets.length === 0 && <p className="text-sm text-muted-foreground">No streets match.</p>}
        {streets.map((view) => (
          <StreetCard key={view.street} view={view} byId={byId} handlers={handlers} slotState={slotState} collapsed={isStreetCollapsed(view, expanded) && keyboardMove?.target.street !== view.street} onToggle={() => toggleStreet(view.street)} />
        ))}
      </div>
      {drag && dragged && (
        <div className="pointer-events-none fixed z-50 rounded-lg border border-primary bg-card px-3 py-2 text-sm font-semibold shadow-lg" style={{ left: drag.x + 12, top: drag.y + 12 }} aria-hidden="true">
          {dragged.name}
        </div>
      )}
    </main>
  );
}

const SIDE_TITLES: Record<Side, string> = { left: 'Left', right: 'Right' };

function StreetCard({ view, byId, handlers, slotState, collapsed, onToggle }: {
  view: StreetView;
  byId: Map<string, ProjectData>;
  handlers: MoveHandlers;
  slotState: (ref: SlotRef, occupied: boolean) => 'idle' | 'target' | 'valid' | 'refused';
  collapsed: boolean;
  onToggle: () => void;
}) {
  const count = streetProjectCount(view);
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-border bg-muted/20 p-3" aria-label={`Street ${view.street}`}>
      <h2 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <button type="button" className="flex w-full items-center justify-between uppercase" onClick={onToggle} aria-expanded={!collapsed}>
          <span>Street {view.street}</span>
          <span className="font-normal normal-case">{count} of {view.sides.left.length + view.sides.right.length} slots used</span>
        </button>
      </h2>
      {!collapsed && (
        <div className="grid grid-cols-[1fr_auto_1fr] gap-3 max-sm:grid-cols-1">
          {SIDES.map((side) => (
            <div key={side} className={`flex flex-col gap-2 ${side === 'right' ? 'col-start-3 max-sm:col-start-1' : ''}`}>
              <h3 className="m-0 text-[11px] font-medium text-muted-foreground">{SIDE_TITLES[side]}</h3>
              <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
                {view.sides[side].map(({ ref, projectId }) => {
                  const project = projectId ? byId.get(projectId) : undefined;
                  const state = slotState(ref, project !== undefined);
                  return (
                    <li
                      key={ref.slot}
                      {...{ [slotDataAttributes.slot]: slotAttributeValue(ref) }}
                      className={slotClass(state, project === undefined)}
                      aria-label={project ? undefined : `${slotLabel(ref)}, empty`}
                    >
                      {project ? <ProjectCard project={project} handlers={handlers} /> : <span className="flex h-full min-h-28 items-center justify-center text-xs text-muted-foreground">Empty</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <div className="col-start-2 row-start-1 w-3 rounded-full bg-border max-sm:hidden" aria-hidden="true" />
        </div>
      )}
    </section>
  );
}
