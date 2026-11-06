import { useMemo, useRef, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useWorldStore } from '../store/worldStore';
import type { ProjectData } from '../types';
import { useProjectIndicators } from '../lib/useProjectIndicators';
import { useYardModel } from '../lib/useYardModel';
import { useTestHealth } from '../lib/useTestHealth';
import { testHealthTooltip } from '../lib/villageTestHealth';
import { TaskProgressBar } from '../ui/TaskProgressBar';
import { ProjectStatusDot } from '../ui/ProjectStatusDot';
import { buildingBadge, lookFor } from '../lib/buildingTypes';
import { BUILDING_CENTER, MERGE_TAG_ANCHOR, SLOTS, WORK_TAG_ANCHOR, YARD_SCALE, machineTagLift, plotOfWorld, worldOfPlot, yardFacing } from '../lib/villageLayout';
import { AREA_CAPS, SLOT_AREAS, layoutYard, isYardClick, openYardTarget, overflowText, yardTargetOf, pickUpOrder, stackChange, survivingTransit, taskKey, yardTransitions } from '../lib/villageYard';
import type { SlotArea } from '../lib/villageLayout';
import type { StackChange, YardLayout, YardModel, YardTarget, YardTransition } from '../lib/villageYard';
import { TOWN_SCALE, WORLD_BOUND } from './townLayout';
import { SCENE_HTML_Z_RANGE } from './htmlZIndex';
import { Warehouse, YardGround, YardHealthWall } from './yardParts';
import { MachineEntity, OverflowMarker, Tag, PendingStack, PlanningEntity, TaskEntity } from './YardEntities';

/**
 * Pointer must travel more than this many CSS pixels from its down-position before a press turns
 * into a drag — matches Ground.tsx's CLICK_DRIFT_PX so click-vs-gesture feels the same across the
 * scene. Below this, a plain click's jitter never nudges the yard.
 */
const DRAG_START_THRESHOLD_PX = 4;

const PLOT_BOUND = WORLD_BOUND / TOWN_SCALE;
const clampToTown = (v: number) => Math.max(-PLOT_BOUND, Math.min(PLOT_BOUND, v));

/**
 * Glass-badge label: the status dot, the name pill under it, and the project's done / in-progress /
 * pending task bar under the pill once its plan has any items, then the read-only or unavailable
 * badge. `Html` renders this as a real DOM element layered on top of the whole canvas
 * (`occlude={false}`), so nothing in the 3D scene can be drawn "in front of" it by depth alone —
 * anything whose projected screen position falls inside the label's rendered box (see
 * `.building-label` in index.css: the dot, pill and bar rows, and its own `translateY(-4px)`) is
 * covered regardless of world-space depth. It floats above the warehouse roof, in yard units.
 */
const LABEL_Y = 4.6;
/** The test-health tag floats just above the roof ridge, under the name label. */
const HEALTH_TAG_Y = 3.4;

/** What an entity in the yard needs to draw itself, kept for a while after it leaves so it can walk or fade away. */
type EntityInfo =
  | { kind: 'task'; key: string; area: 'work' | 'merge'; slot: number; model: YardModel }
  | { kind: 'machine'; key: string; slot: number; model: YardModel }
  | { kind: 'planning'; key: string; slot: number; model: YardModel };

function entitiesOf(model: YardModel, layout: YardLayout): EntityInfo[] {
  const out: EntityInfo[] = [];
  for (const item of model.work) {
    const slot = layout.work.slots[item.key];
    if (slot !== undefined) out.push({ kind: 'task', key: item.key, area: 'work', slot, model });
  }
  for (const item of model.commands) {
    const slot = layout.commands.slots[item.key];
    if (slot !== undefined) out.push({ kind: 'machine', key: item.key, slot, model });
  }
  for (const item of model.merge) {
    const slot = layout.merge.slots[item.key];
    if (slot !== undefined) out.push({ kind: 'task', key: item.key, area: 'merge', slot, model });
  }
  for (const seat of model.planning) {
    const slot = layout.planning.slots[seat.key];
    if (slot !== undefined) out.push({ kind: 'planning', key: seat.key, slot, model });
  }
  return out;
}

interface YardState {
  model: YardModel;
  layout: YardLayout;
  transitions: Record<string, YardTransition>;
  /** Bumped on every model change, so each entity acts on its transition once. */
  version: number;
  /** The model and layout before this change (null on mount). */
  previous: { model: YardModel; layout: YardLayout } | null;
  /** Crates dropped onto or faded off the pending stack by this change. */
  stack: StackChange;
  /** The tasks fetching a crate in this change, in the order they leave the doorway. */
  pickUps: string[];
}

function nextYard(model: YardModel, previous: YardState | null): YardState {
  const before = previous ? { model: previous.model, layout: previous.layout } : null;
  const layout = layoutYard(model, before?.layout ?? null);
  const transitions = yardTransitions(before, { model, layout });
  return {
    model, layout, transitions, version: (previous?.version ?? 0) + 1, previous: before,
    stack: stackChange(before?.model ?? null, model, transitions),
    pickUps: pickUpOrder(model, transitions),
  };
}

/**
 * The yard's layout and, each time its model changes, how every entity moved (`yardTransitions`).
 * Starts from no previous layout on every mount, so a reload or a return to 3D shows everything in
 * place; only changes after that animate.
 */
function useYard(projectId: string): YardState {
  const model = useYardModel(projectId);
  const [yard, setYard] = useState(() => nextYard(model, null));
  if (yard.model === model) return yard;
  const next = nextYard(model, yard);
  setYard(next);
  return next;
}

type Leaving = EntityInfo & { exit: YardTransition; version: number };

/**
 * A Project in the 3D village: a warehouse with a roof tinted by its Building Type in its own yard, with
 * the pending dock (a crate per pending task), the planning desks (robots at laptops), the work bays
 * (task boxes), the command machines and the PR queue (robots holding finished work whose PR isn't
 * merged). See lib/villageLayout.ts for where each zone stands and lib/villageYard.ts for every rule.
 *
 * Press and drag anywhere on the yard to move it to another plot (the camera's pan is disabled for
 * the drag); a plain click opens what was clicked — the warehouse its Project Workspace, an item its own view.
 */
export function ProjectYard({ project }: { project: ProjectData }) {
  // "Selected" tracks whether this Project's workspace is the open one.
  const selected = useWorldStore((s) => s.workspaceProjectId === project.id);
  const moveProject = useWorldStore((s) => s.moveProject);
  const setDragging = useWorldStore((s) => s.setDragging);
  const setControlsEnabled = useWorldStore((s) => s.setControlsEnabled);
  const buildingTypes = useWorldStore((s) => s.buildingTypes);
  // Every Building Type uses the same warehouse; only its roof tint (the type's colour) differs.
  const tint = lookFor(project, buildingTypes).color;
  const badge = buildingBadge(project);
  const { statusStyle, dotLabel, progress } = useProjectIndicators(project);
  const yard = useYard(project.id);
  const health = useTestHealth(project.id, project.sync?.branch ?? null);
  const [warehouseHovered, setWarehouseHovered] = useState(false);
  const healthTag = health && warehouseHovered ? testHealthTooltip(health, Date.now()) : null;

  // Entities that just left keep drawing (walking into the warehouse or fading) until they report done.
  const [leaving, setLeaving] = useState<Record<string, Leaving>>({});
  const [seenVersion, setSeenVersion] = useState(yard.version);
  const entities = useMemo(() => entitiesOf(yard.model, yard.layout), [yard]);
  if (seenVersion !== yard.version) {
    setSeenVersion(yard.version);
    const shown = new Set(entities.map((entity) => entity.key));
    const next = Object.fromEntries(Object.entries(leaving).filter(([key]) => !shown.has(key)));
    for (const entity of yard.previous ? entitiesOf(yard.previous.model, yard.previous.layout) : []) {
      const exit = yard.transitions[entity.key];
      if (!shown.has(entity.key) && (exit === 'carry-in' || exit === 'quiet-leave')) next[entity.key] = { ...entity, exit, version: yard.version };
    }
    setLeaving(next);
  }
  // Crates a robot is on its way to fetch stay on the stack until it lifts them (`survivingTransit`).
  const [transit, setTransit] = useState<ReadonlySet<string>>(() => new Set());
  const [transitVersion, setTransitVersion] = useState(yard.version);
  if (transitVersion !== yard.version) {
    setTransitVersion(yard.version);
    setTransit(survivingTransit(transit, yard.layout, yard.transitions, yard.pickUps));
  }
  const handleLift = (key: string) => {
    setTransit((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const handleGone = (key: string) => {
    setLeaving((current) => {
      if (!(key in current)) return current;
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  };

  // Pointer capture keeps this group receiving move/up events once a drag starts; this ref is the actual "drag in progress" gate.
  const isDraggingRef = useRef(false);
  const pointerDownAtRef = useRef<{ x: number; y: number } | null>(null);

  const openTarget = (target: YardTarget) => {
    const state = useWorldStore.getState();
    openYardTarget(project.id, target, state, {
      ...state,
      openCommandRunFromVillage: (projectId, runId) => void state.openCommandRunFromVillage(projectId, runId),
      openTestRunFromFooter: (projectId, runId) => void state.openTestRunFromFooter(projectId, runId),
    });
  };

  const groundPoint = (ray: THREE.Ray): [number, number] | null => {
    if (Math.abs(ray.direction.y) < 1e-6) return null; // parallel to the ground
    const t = -ray.origin.y / ray.direction.y;
    const [x, z] = plotOfWorld(ray.origin.x + ray.direction.x * t, ray.origin.z + ray.direction.z * t);
    return [clampToTown(x), clampToTown(z)];
  };

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    pointerDownAtRef.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!isDraggingRef.current) {
      const start = pointerDownAtRef.current;
      if (!start) { // plain hover: the pointer cursor only over something clickable
        document.body.style.cursor = yardTargetOf(e.object) ? 'pointer' : 'auto';
        return;
      }
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_START_THRESHOLD_PX) return;
      isDraggingRef.current = true;
      setDragging(project.id);
      setControlsEnabled(false);
      document.body.style.cursor = 'grabbing';
    }
    e.stopPropagation();
    const point = groundPoint(e.ray);
    if (point) moveProject(project.id, point[0], point[1]);
  };

  const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const element = e.target as Element;
    if (element.hasPointerCapture?.(e.pointerId)) element.releasePointerCapture(e.pointerId);
    const pressStarted = pointerDownAtRef.current !== null;
    pointerDownAtRef.current = null;
    if (isDraggingRef.current) {
      const point = groundPoint(e.ray);
      if (point) moveProject(project.id, point[0], point[1]);
      isDraggingRef.current = false;
      setDragging(null);
      setControlsEnabled(true);
    } else if (isYardClick(pressStarted, false)) {
      // A release after a camera drag has no press here and opens nothing, nor does bare ground.
      const target = yardTargetOf(e.object);
      if (target) openTarget(target);
    }
    document.body.style.cursor = 'auto';
  };

  const [wx, wz] = worldOfPlot(project.position);
  const renderEntity = (entity: EntityInfo, exit: YardTransition | null, version: number) => {
    const lifecycle = {
      transition: exit ?? yard.transitions[entity.key] ?? 'stay',
      version,
      leaving: exit !== null,
      onDone: exit !== null ? () => handleGone(entity.key) : undefined,
    };
    if (entity.kind === 'machine') {
      const item = entity.model.commands.find((c) => c.key === entity.key);
      if (!item) return null;
      const target: YardTarget = item.runKind === 'command' ? { kind: 'command', runId: item.runId } : { kind: 'test', runId: item.runId };
      return <MachineEntity key={entity.key} target={target} slot={SLOTS.commands[entity.slot]!} tagLift={machineTagLift(entity.slot)} item={item} {...lifecycle} />;
    }
    if (entity.kind === 'planning') {
      const seat = entity.model.planning.find((p) => p.key === entity.key);
      if (!seat) return null;
      return <PlanningEntity key={entity.key} target={{ kind: 'planning', taskId: seat.taskId }} slot={SLOTS.planning[entity.slot]!} seat={seat} {...lifecycle} />;
    }
    const work = entity.area === 'work' ? entity.model.work.find((w) => w.key === entity.key) : undefined;
    const merge = entity.area === 'merge' ? entity.model.merge.find((m) => m.key === entity.key) ?? null : null;
    const itemId = entity.key.slice(taskKey('').length);
    return (
      <TaskEntity
        key={entity.key}
        target={{ kind: 'task', itemId }}
        area={entity.area}
        slot={SLOTS[entity.area][entity.slot]!}
        tagAnchor={entity.area === 'work' ? WORK_TAG_ANCHOR : MERGE_TAG_ANCHOR}
        state={work?.state ?? null}
        workTooltip={work?.tooltip ?? null}
        merge={merge}
        pickUpOrder={Math.max(0, yard.pickUps.indexOf(entity.key))}
        onLift={() => handleLift(entity.key)}
        {...lifecycle}
      />
    );
  };

  const overflow = (area: SlotArea) => {
    const hidden = yard.layout[area].hidden.length;
    if (hidden === 0) return null;
    return <OverflowMarker key={`more:${area}`} slot={SLOTS[area][AREA_CAPS[area]]!} count={hidden} details={overflowText(area, yard.model, yard.layout)} />;
  };

  return (
    <group
      position={[wx, 0.07, wz]}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerOut={() => { document.body.style.cursor = 'auto'; }}
    >
      <group scale={YARD_SCALE} rotation={[0, yardFacing(project.position), 0]}>
        <YardGround />
        <group onPointerOver={() => setWarehouseHovered(true)} onPointerOut={() => setWarehouseHovered(false)}>
          <Warehouse color={tint} statusColor={statusStyle.dotColor} glowing={statusStyle.glowing} selected={selected} />
        </group>
        {health && <YardHealthWall health={health} />}
        <Tag position={[BUILDING_CENTER.x, HEALTH_TAG_Y, BUILDING_CENTER.z]} visible={healthTag !== null}>
          {healthTag && (
            <div className="yard-tag yard-tag--command">
              <div className="yard-tag__title">{healthTag.title}</div>
              {healthTag.lines.map((line) => <div key={line} className="yard-tag__line">{line}</div>)}
            </div>
          )}
        </Tag>
        {entities.map((entity) => renderEntity(entity, null, yard.version))}
        {Object.values(leaving).map((entity) => renderEntity(entity, entity.exit, entity.version))}
        {SLOT_AREAS.map(overflow)}
        <PendingStack pendingCount={yard.model.pending.length} inTransit={transit.size} change={yard.stack} version={yard.version} onOpen={() => openTarget({ kind: 'pending' })} />

        <Html position={[BUILDING_CENTER.x, LABEL_Y, BUILDING_CENTER.z]} center occlude={false} zIndexRange={SCENE_HTML_Z_RANGE}>
          <div className={`building-label${selected ? ' building-label--selected' : ''}`}>
            <ProjectStatusDot style={statusStyle} label={dotLabel} />
            <div className="building-label-body">
              <div className="building-badge">
                <span className="building-name">{project.name}</span>
              </div>
              {progress && <TaskProgressBar progress={progress} className="building-progress h-[6px] w-[70%] self-center" />}
            </div>
            {badge && <span className="building-type-badge">{badge}</span>}
          </div>
        </Html>
      </group>
    </group>
  );
}
