import {
  CITY_POSITION, PROJECT_CAPACITY, PROJECT_PLOTS, SIDES, SLOTS_PER_SIDE, STREET_COUNT, flatIndexOfRef, migrateLegacyPosition,
  nearestFreePlot, plotIndexOf, refOfFlatIndex, samePlot, type Side,
} from '../scene/townLayout';

/**
 * The 2D view's model of the town: twelve streets, each with a left and a right side of ten slots
 * (see scene/townLayout.ts). Nothing is stored — street, side and slot are derived from a project's
 * position, so 2D and 3D always agree.
 *
 * Orientation: the default 3D camera (DEFAULT_VIEW in scene/defaultView.ts) sits on the +x/+z diagonal looking toward the town, so on
 * screen +x runs right-and-down and +z runs left-and-down. The 2D view is a plain top-down map with
 * +x to the right and +z downward; "left" is the street's side at smaller x, and slot 1 is the one
 * nearest the cross road through City Center.
 */

export { SIDES, SLOTS_PER_SIDE, STREET_COUNT };
export type { Side };

export interface SlotRef { street: number; side: Side; slot: number }
export type Position = [number, number];
export interface PositionedProject { id: string; position: Position }

const flatIndex = flatIndexOfRef;
export const isSameSlot = (a: SlotRef, b: SlotRef): boolean => a.street === b.street && a.side === b.side && a.slot === b.slot;

const isValidSlot = (ref: SlotRef): boolean =>
  Number.isInteger(ref.street) && ref.street >= 1 && ref.street <= STREET_COUNT
  && Number.isInteger(ref.slot) && ref.slot >= 1 && ref.slot <= SLOTS_PER_SIDE
  && (SIDES as readonly string[]).includes(ref.side);

export function plotOfSlot(ref: SlotRef): Position {
  if (!isValidSlot(ref)) throw new RangeError(`No such slot: street ${ref.street}, ${ref.side}, slot ${ref.slot}`);
  const plot = PROJECT_PLOTS[flatIndex(ref)]!;
  return [plot.x, plot.z];
}

/** The slot a position stands on, or null when it is not one of the project plots (within the 3D plot tolerance). */
export function slotOfPlot(position: readonly number[] | null | undefined): SlotRef | null {
  const index = plotIndexOf(position);
  return index === -1 ? null : refOfFlatIndex(index);
}

const sideLabel = (side: Side): string => (side === 'left' ? 'Left' : 'Right');
export const slotLabel = (ref: SlotRef): string => `Street ${ref.street}, ${sideLabel(ref.side)}, slot ${ref.slot}`;

export interface SlotView { ref: SlotRef; projectId: string | null }
export interface StreetView { street: number; sides: Record<Side, SlotView[]> }

/** Flat plot index → the project standing on it; when two projects share a plot the first keeps it. */
function ownersOf(projects: readonly PositionedProject[]): Map<number, string> {
  const owners = new Map<number, string>();
  for (const project of projects) {
    const index = plotIndexOf(project.position);
    if (index !== -1 && !owners.has(index)) owners.set(index, project.id);
  }
  return owners;
}

/** Every street with each project in its slot. */
export function buildStreets(projects: readonly PositionedProject[]): StreetView[] {
  const owners = ownersOf(projects);
  const sideSlots = (street: number, side: Side): SlotView[] => Array.from({ length: SLOTS_PER_SIDE }, (_, s) => {
    const ref = { street, side, slot: s + 1 };
    return { ref, projectId: owners.get(flatIndex(ref)) ?? null };
  });
  return Array.from({ length: STREET_COUNT }, (_, i) => ({
    street: i + 1,
    sides: { left: sideSlots(i + 1, 'left'), right: sideSlots(i + 1, 'right') },
  }));
}

export const streetProjectCount = (view: StreetView): number =>
  SIDES.reduce((total, side) => total + view.sides[side].filter((slot) => slot.projectId !== null).length, 0);

/**
 * Legacy repair: positions on the earlier block grid move to the same-numbered street plot (so saved
 * projects keep their relative order); positions that are missing, off the plots or shared with an
 * earlier project move to the nearest free plot (the same rule new projects use). Returns only the
 * projects that change. Projects beyond the capacity stay unplaced.
 */
export function repairPositions(projects: readonly { id: string; position: Position | null }[]): PositionedProject[] {
  const claimed: { x: number; z: number }[] = [];
  const changes: PositionedProject[] = [];
  const later: { id: string; position: Position | null }[] = [];
  const claim = (position: Position): boolean => {
    if (claimed.some((other) => samePlot(other, { x: position[0], z: position[1] }))) return false;
    claimed.push({ x: position[0], z: position[1] });
    return true;
  };
  for (const project of projects) {
    const index = plotIndexOf(project.position);
    const plot = index === -1 ? undefined : PROJECT_PLOTS[index];
    if (!plot || !claim([plot.x, plot.z])) later.push(project);
  }
  const needsPlot: string[] = [];
  for (const project of later) {
    const migrated = migrateLegacyPosition(project.position);
    if (migrated && claim(migrated)) changes.push({ id: project.id, position: migrated });
    else needsPlot.push(project.id);
  }
  for (const id of needsPlot) {
    const position = nearestFreePlot(...CITY_POSITION, claimed);
    if (!position) break;
    claim(position);
    changes.push({ id, position });
  }
  return changes;
}

/** Whether `projectId` may be dropped on `target`: an existing, empty slot (never the Catalog, never an occupied one, no swapping). */
export function canDrop(projects: readonly PositionedProject[], projectId: string, target: SlotRef | null): boolean {
  if (!target || !projects.some((p) => p.id === projectId) || !isValidSlot(target)) return false;
  return !ownersOf(projects).has(flatIndex(target));
}

/** The empty slot after (direction 1) or before (-1) `from` in reading order, skipping occupied slots; `from` itself when there is none. */
export function nextFreeSlot(projects: readonly PositionedProject[], projectId: string, from: SlotRef, direction: 1 | -1): SlotRef {
  const owners = ownersOf(projects.filter((p) => p.id !== projectId));
  for (let index = flatIndex(from) + direction; index >= 0 && index < PROJECT_CAPACITY; index += direction) {
    if (!owners.has(index)) return refOfFlatIndex(index);
  }
  return from;
}

export interface FreeSlotStreet { street: number; slots: SlotRef[] }

/** The "Move to…" choices: free slots by street, leaving out streets with none. */
export function freeSlotOptions(projects: readonly PositionedProject[]): FreeSlotStreet[] {
  return buildStreets(projects)
    .map(({ street, sides }) => ({ street, slots: SIDES.flatMap((side) => sides[side].filter((s) => s.projectId === null).map((s) => s.ref)) }))
    .filter((entry) => entry.slots.length > 0);
}

// ---- The street list: filtering, collapsing and the top-bar summary ----

/** Streets matching a search (a project name, or a street number such as "3" or "street 3"), optionally only those with projects. */
export function filterStreets(streets: readonly StreetView[], names: ReadonlyMap<string, string>, query: string, onlyOccupied: boolean): StreetView[] {
  const text = query.trim().toLowerCase();
  const streetNumber = /^(?:street\s*)?(\d+)$/.exec(text)?.[1];
  const matches = (view: StreetView): boolean => {
    if (text === '') return true;
    if (streetNumber !== undefined) return view.street === Number(streetNumber);
    return SIDES.some((side) => view.sides[side].some((slot) => slot.projectId !== null && (names.get(slot.projectId) ?? '').toLowerCase().includes(text)));
  };
  return streets.filter((view) => matches(view) && (!onlyOccupied || streetProjectCount(view) > 0));
}

/** An empty street starts collapsed to one line; opening it explicitly wins. */
export const isStreetCollapsed = (view: StreetView, expanded: ReadonlySet<number>): boolean =>
  streetProjectCount(view) === 0 && !expanded.has(view.street);

export const projectSummary = (count: number): string => `${count} ${count === 1 ? 'project' : 'projects'} · ${STREET_COUNT} streets`;

/** Occupancy at which the top bar starts warning that the map is nearly full. */
export const CAPACITY_WARNING_AT = Math.ceil(PROJECT_CAPACITY * 0.9);
export type CapacityState = 'ok' | 'nearly-full' | 'full';

export function capacityState(count: number): CapacityState {
  if (count >= PROJECT_CAPACITY) return 'full';
  return count >= CAPACITY_WARNING_AT ? 'nearly-full' : 'ok';
}

export const announce = {
  pickedUp: (name: string, from: SlotRef) => `Picked up ${name} from ${slotLabel(from)}. Arrow keys choose an empty slot, Enter drops, Escape cancels.`,
  target: (target: SlotRef, empty: boolean) => `${slotLabel(target)}, ${empty ? 'empty' : 'occupied'}`,
  noFreeSlot: () => 'No free slots',
  dropped: (name: string, target: SlotRef) => `Dropped ${name} in ${slotLabel(target)}`,
  cancelled: (name: string, from: SlotRef | null) => (from ? `Move cancelled. ${name} stays in ${slotLabel(from)}` : `Move cancelled for ${name}`),
  refused: (target: SlotRef | null) => (target ? `${slotLabel(target)} is not available` : 'That is not a project slot'),
} as const;

export type MoveKeyAction = 'pickUp' | 'next' | 'prev' | 'drop' | 'cancel' | 'open';

/** What a key does on a focused project card: Space picks up (Enter still opens the workspace); once picked up, arrows retarget, Enter or Space drops and Escape cancels. */
export function moveKeyAction(key: string, moving: boolean): MoveKeyAction | null {
  if (!moving) {
    if (key === ' ') return 'pickUp';
    return key === 'Enter' ? 'open' : null;
  }
  if (key === 'ArrowRight' || key === 'ArrowDown') return 'next';
  if (key === 'ArrowLeft' || key === 'ArrowUp') return 'prev';
  if (key === 'Enter' || key === ' ') return 'drop';
  return key === 'Escape' ? 'cancel' : null;
}

export type DropHit = { kind: 'slot'; ref: SlotRef } | { kind: 'catalog' };

const SLOT_ATTRIBUTE = 'data-slot';
const CATALOG_ATTRIBUTE = 'data-catalog';

/** The `data-slot` value for a slot element (`street-L|R-slot`), read back by {@link hitOfElement}. */
export const slotAttributeValue = (ref: SlotRef): string => `${ref.street}-${ref.side === 'left' ? 'L' : 'R'}-${ref.slot}`;
export const slotDataAttributes = { slot: SLOT_ATTRIBUTE, catalog: CATALOG_ATTRIBUTE } as const;

function slotOfAttribute(value: string): SlotRef | null {
  const parts = value.split('-');
  if (parts.length !== 3) return null;
  const [street, sideCode, slot] = [Number(parts[0]), parts[1], Number(parts[2])];
  const side = sideCode === 'L' ? 'left' : sideCode === 'R' ? 'right' : null;
  return side && street && slot ? { street, side, slot } : null;
}

/** The slot or Catalog cell under (or containing) an element, or null for gaps and anything else. */
export function hitOfElement(element: Element | null): DropHit | null {
  const cell = element?.closest(`[${SLOT_ATTRIBUTE}], [${CATALOG_ATTRIBUTE}]`);
  if (!cell) return null;
  if (cell.hasAttribute(CATALOG_ATTRIBUTE)) return { kind: 'catalog' };
  const ref = slotOfAttribute(cell.getAttribute(SLOT_ATTRIBUTE) ?? '');
  return ref ? { kind: 'slot', ref } : null;
}

/** Why a drop would be refused (or null when allowed) — drives the not-allowed cue and the refusal announcement. */
export function dropRefusal(projects: readonly PositionedProject[], projectId: string, hit: DropHit | null): 'catalog' | 'occupied' | 'none' | null {
  if (!hit) return 'none';
  if (hit.kind === 'catalog') return 'catalog';
  return canDrop(projects, projectId, hit.ref) ? null : 'occupied';
}

export interface KeyboardMove { projectId: string; from: SlotRef; target: SlotRef }
export interface KeyboardStep {
  move: KeyboardMove | null;
  handled: boolean;
  message?: string;
  /** Set when the key dropped the card on a different slot; the caller still re-validates against fresh projects. */
  drop?: SlotRef;
}

/** One key press on a project card: picks up, retargets, drops or cancels a keyboard move. `handled` says whether the browser default should be suppressed. */
export function stepKeyboardMove(
  projects: readonly PositionedProject[],
  move: KeyboardMove | null,
  project: { id: string; name: string; position: Position },
  key: string,
): KeyboardStep {
  const mine = move?.projectId === project.id ? move : null;
  const action = moveKeyAction(key, mine !== null);
  if (action === 'pickUp') {
    const from = slotOfPlot(project.position);
    if (!from) return { move, handled: true };
    return { move: { projectId: project.id, from, target: from }, handled: true, message: announce.pickedUp(project.name, from) };
  }
  if (!mine) return { move, handled: false };
  if (action === 'next' || action === 'prev') {
    const target = nextFreeSlot(projects, project.id, mine.target, action === 'next' ? 1 : -1);
    const message = isSameSlot(target, mine.target) && isSameSlot(target, mine.from) ? announce.noFreeSlot() : announce.target(target, true);
    return { move: { ...mine, target }, handled: true, message };
  }
  if (action === 'drop') {
    if (isSameSlot(mine.target, mine.from)) return { move: null, handled: true, message: announce.cancelled(project.name, mine.from) };
    return { move: null, handled: true, drop: mine.target };
  }
  if (action === 'cancel') return { move: null, handled: true, message: announce.cancelled(project.name, mine.from) };
  return { move, handled: false };
}

export const CANCELLED_MESSAGE = 'Move cancelled';

/** What ending a pointer drag does: a cancelled drag or one released off any slot changes nothing; a release on a slot asks the caller to drop there. */
export function finishPointerDrag(hit: DropHit | null, cancelled: boolean): { drop: SlotRef | null; message: string | null } {
  if (cancelled) return { drop: null, message: CANCELLED_MESSAGE };
  if (hit?.kind === 'slot') return { drop: hit.ref, message: null };
  return { drop: null, message: announce.refused(null) };
}
