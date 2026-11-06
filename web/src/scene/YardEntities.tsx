import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CRATE_CAP, DOOR, PALLET, carryToMergePath, crateSpot, pathFromDoor, pathToDoorFront, pickUpPath, workBoxSpot, workRobotSpot } from '../lib/villageLayout';
import type { TagAnchor, YardPoint } from '../lib/villageLayout';
import { machineTooltip, mergeTooltip, msUntilNextMinute, MORE_CLICK_HINT, pendingStack, pendingTooltip, pickUpDelay, planningTooltip } from '../lib/villageYard';
import type { MachineWorkItem, MergeWaitItem, PlanningSeat, StackChange, TaskTooltip, TaskWorkState, YardTarget, YardTransition } from '../lib/villageYard';
import { isSceneCovered } from '../lib/sceneRendering';
import { useWorldStore } from '../store/worldStore';
import { SCENE_HTML_Z_RANGE } from './htmlZIndex';
import { advanceWalker, headingToward } from './yardMotion';
import type { Walker } from './yardMotion';
import { Crate, Machine, MergePin, OverflowStack, Pallet, PlanningStation, Robot } from './yardParts';
import type { RobotMotion, RobotPose } from './yardParts';

/**
 * The things standing in a Project's yard. Each one is told how it got here (`transition`, from
 * `lib/villageYard.ts`'s `yardTransitions`) whenever the yard model changes (`version`), and moves
 * accordingly: walking out of the warehouse, fetching a crate from the pending stack, carrying its
 * box, fading in or out. `leaving` keeps an entity
 * mounted while it walks or fades away; it calls `onDone` when gone. Its root group carries its
 * `yardTarget` in `userData`, which `ProjectYard` reads to open the right thing on click.
 */

/** Tags scale with camera distance, so they shrink with the yard as it moves away. */
const TAG_DISTANCE_FACTOR = 9;
/** Faces of things at rest: a work robot looks at its box (+x); a waiting one, a desk robot and a machine face the camera. */
const FACE_BOX = Math.PI / 2;
const FACE_CAMERA = Math.PI / 4;

export function Tag({ position, children, visible }: { position: [number, number, number]; children: ReactNode; visible: boolean }) {
  if (!visible) return null;
  return (
    <Html position={position} center zIndexRange={SCENE_HTML_Z_RANGE} distanceFactor={TAG_DISTANCE_FACTOR} occlude={false} style={{ pointerEvents: 'none' }}>
      {children}
    </Html>
  );
}

function TaskTagCard({ tooltip, tone }: { tooltip: TaskTooltip; tone: TaskWorkState }) {
  return (
    <div className={`yard-tag yard-tag--compact yard-tag--${tone}`}>
      <div className="yard-tag__title">{tooltip.title}</div>
      <div className="yard-tag__line">
        {tooltip.status && <span className={`yard-tag__status yard-tag__status--${tooltip.status.tone}`}>{tooltip.status.text}</span>}
        {tooltip.status && tooltip.step && ' · '}
        {tooltip.step}
      </div>
    </div>
  );
}

/** Scales a group in on mount (`pop`) and out while `leaving`, then calls `onDone`. */
function usePresence(group: React.RefObject<THREE.Group | null>, pop: boolean, leaving: boolean, onDone?: () => void) {
  const scale = useRef(pop ? 0.01 : 1);
  const done = useRef(false);
  const covered = useWorldStore(isSceneCovered);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { invalidate(); }, [leaving, invalidate]);
  useFrame((state, delta) => {
    const target = leaving ? 0 : 1;
    if (scale.current === target) return;
    const step = Math.min(delta, 0.1) * 3.5;
    scale.current = target > scale.current ? Math.min(1, scale.current + step) : Math.max(0, scale.current - step);
    group.current?.scale.setScalar(Math.max(0.001, scale.current));
    if (leaving && scale.current === 0 && !done.current) { done.current = true; onDone?.(); }
    if (!covered) state.invalidate();
  });
}

/** Moves a robot along its walker's queue every frame, and turns it to `rest` once it stops. `motion` tells the robot's limbs whether it is walking. */
function useWalker(initial: YardPoint, heading: number, robot: React.RefObject<THREE.Group | null>, rest: React.RefObject<number>) {
  const walker = useRef<Walker>({ position: initial, heading, queue: [] });
  const motion = useRef<RobotMotion>({ moving: false });
  const covered = useWorldStore(isSceneCovered);
  useFrame((state, delta) => {
    const moving = advanceWalker(walker.current, delta);
    motion.current.moving = moving;
    const group = robot.current;
    if (!group) return;
    group.position.set(walker.current.position.x, 0, walker.current.position.z);
    group.rotation.set(0, moving ? walker.current.heading : rest.current, 0);
    if (moving && !covered) state.invalidate();
  });
  return { walker, motion };
}

export interface EntityLifecycle {
  transition: YardTransition;
  version: number;
  leaving: boolean;
  onDone?: () => void;
}

// ---- Task: a box in a work bay, or a robot holding it in the PR queue ----

export interface TaskEntityProps extends EntityLifecycle {
  target: YardTarget;
  area: 'work' | 'merge';
  slot: YardPoint;
  /** Where the tag floats relative to the slot. */
  tagAnchor: TagAnchor;
  /** For a work box; null in the PR queue. */
  state: TaskWorkState | null;
  workTooltip: TaskTooltip | null;
  merge: MergeWaitItem | null;
  /** For a `pick-up`: this robot's place among the robots leaving the doorway together (`pickUpDelay`). */
  pickUpOrder: number;
  /** For a `pick-up`: the robot has lifted its crate off the pending stack. */
  onLift: () => void;
}

export function TaskEntity({ target, area, slot, tagAnchor, state, workTooltip, merge, pickUpOrder, onLift, transition, version, leaving, onDone }: TaskEntityProps) {
  const root = useRef<THREE.Group>(null);
  const robot = useRef<THREE.Group>(null);
  const robotHome = area === 'work' ? workRobotSpot(slot) : slot;
  const restHeading = area === 'work' ? FACE_BOX : FACE_CAMERA;
  const rest = useRef(restHeading);
  rest.current = restHeading;
  const robotAtWork = state === 'running' || state === 'needs-you';
  const [robotShown, setRobotShown] = useState(area === 'merge' || robotAtWork);
  const [carrying, setCarrying] = useState(area === 'merge');
  // A fetched crate is set down in the bay only when its robot arrives.
  const [boxInBay, setBoxInBay] = useState(transition !== 'pick-up');
  const [fadingOut, setFadingOut] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { walker, motion } = useWalker(transition === 'walk-out' || transition === 'pick-up' ? DOOR : robotHome, restHeading, robot, rest);
  usePresence(root, transition === 'fade-in', fadingOut, onDone);

  // Each model change says how this task got to where it now is; act on it once.
  useLayoutEffect(() => {
    const w = walker.current;
    const backToDoorFront = pathToDoorFront(area, slot);
    if (leaving) {
      if (transition === 'carry-in' && robotShown) {
        setCarrying(true);
        w.queue = [...backToDoorFront, DOOR].map((to) => ({ to }));
        w.queue.push({ action: () => onDone?.() });
      } else {
        setFadingOut(true);
      }
      return;
    }
    const walk = (points: YardPoint[]) => points.map((to) => ({ to }));
    switch (transition) {
      case 'appear':
      case 'fade-in':
        w.position = robotHome;
        w.queue = [];
        setRobotShown(area === 'merge' || robotAtWork);
        setCarrying(area === 'merge');
        setBoxInBay(true);
        break;
      case 'walk-out':
        setRobotShown(true);
        setCarrying(false);
        setBoxInBay(true);
        w.position = DOOR;
        w.queue = walk(pathFromDoor(area, slot).slice(1));
        break;
      case 'pick-up': {
        // Hidden in the doorway until its turn, then out to the dock, lift the crate, carry it to the bay and set it down.
        const { toPick, toBay } = pickUpPath(slot);
        setRobotShown(false);
        setCarrying(false);
        setBoxInBay(false);
        w.position = DOOR;
        w.queue = [
          { wait: pickUpDelay(pickUpOrder) },
          { action: () => setRobotShown(true) },
          ...walk(toPick.slice(1)),
          { action: () => { setCarrying(true); onLift(); } },
          ...walk(toBay),
          { action: () => { setCarrying(false); setBoxInBay(true); } },
        ];
        break;
      }
      case 'return-to-dome':
        // Stopped mid pick-up too: the red box stands in the bay and the robot walks back empty-handed.
        setCarrying(false);
        setBoxInBay(true);
        w.queue = [...backToDoorFront, DOOR].map((to) => ({ to }));
        w.queue.push({ action: () => setRobotShown(false) });
        break;
      case 'carry-to-merge':
        setRobotShown(true);
        setCarrying(true);
        w.queue = walk(carryToMergePath(w.position, slot));
        break;
      default:
        break;
    }
    // Only a new model (version) restarts a move; prop identity alone must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, leaving]);

  // A hidden robot (inside the warehouse while its box is red) stands still, so it requests no frames.
  const pose: RobotPose = !robotShown ? 'idle' : carrying ? 'carry' : state === 'needs-you' ? 'wait' : 'work';
  const box = workBoxSpot(slot);
  const tagVisible = !leaving && (area === 'work' || hovered);
  return (
    <group
      ref={root}
      userData={{ yardTarget: target }}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      {!carrying && boxInBay && area === 'work' && (
        <group position={[box.x, 0, box.z]}>
          <Crate failed={state === 'stopped'} />
        </group>
      )}
      <group visible={robotShown}>
        <Robot ref={robot} pose={pose} motion={motion} overhead={area === 'merge' && !leaving ? <MergePin /> : null}>
          {carrying ? <Crate /> : null}
        </Robot>
      </group>
      <Tag position={[slot.x + tagAnchor.dx, tagAnchor.dy, slot.z]} visible={tagVisible}>
        {area === 'work' && workTooltip && state ? <TaskTagCard tooltip={workTooltip} tone={state} /> : null}
        {area === 'merge' && merge ? <MergeTagCard item={merge} /> : null}
      </Tag>
    </group>
  );
}

function MergeTagCard({ item }: { item: MergeWaitItem }) {
  const tooltip = mergeTooltip(item);
  return (
    <div className="yard-tag yard-tag--merge">
      <div className="yard-tag__title">{tooltip.title}</div>
      <div className="yard-tag__line">{tooltip.pr}</div>
      <div className="yard-tag__line yard-tag__line--muted">{tooltip.autoMerge}</div>
    </div>
  );
}

// ---- Planning: a robot at a desk ----

export interface PlanningEntityProps extends EntityLifecycle {
  target: YardTarget;
  slot: YardPoint;
  seat: PlanningSeat;
}

export function PlanningEntity({ target, slot, seat, transition, version, leaving, onDone }: PlanningEntityProps) {
  const root = useRef<THREE.Group>(null);
  const robot = useRef<THREE.Group>(null);
  const rest = useRef(FACE_BOX);
  const [hovered, setHovered] = useState(false);
  const { walker, motion } = useWalker(transition === 'walk-out' ? DOOR : slot, FACE_BOX, robot, rest);
  usePresence(root, transition === 'fade-in', leaving, onDone);
  useLayoutEffect(() => {
    if (leaving) return;
    if (transition === 'walk-out') {
      walker.current.position = DOOR;
      walker.current.queue = pathFromDoor('planning', slot).slice(1).map((to) => ({ to }));
    } else if (transition === 'appear' || transition === 'fade-in') {
      walker.current.position = slot;
      walker.current.queue = [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, leaving]);
  const tooltip = planningTooltip(seat);
  return (
    <group ref={root} userData={{ yardTarget: target }} onPointerOver={() => setHovered(true)} onPointerOut={() => setHovered(false)}>
      <group position={[slot.x, 0, slot.z]}><PlanningStation live={seat.live} /></group>
      <Robot ref={robot} pose={seat.live === 'running' ? 'sit' : 'seated'} motion={motion} />
      <Tag position={[slot.x + 0.3, 2.0, slot.z]} visible={hovered && !leaving}>
        <div className="yard-tag yard-tag--planning">
          <div className="yard-tag__title">{tooltip.title}</div>
          <div className="yard-tag__line"><span className={`yard-tag__dot ${tooltip.dotClass}`} />{tooltip.live}</div>
        </div>
      </Tag>
    </group>
  );
}

// ---- Command machine ----

export interface MachineEntityProps extends EntityLifecycle {
  target: YardTarget;
  slot: YardPoint;
  /** The tag's height above the slot (`machineTagLift`). */
  tagLift: number;
  item: MachineWorkItem;
}

/** A machine's tag: name and elapsed time, re-rendered once a minute (no seconds are shown). */
function MachineTagCard({ item }: { item: MachineWorkItem }) {
  const [now, setNow] = useState(() => Date.now());
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (item.failed) return;
    const timer = setTimeout(() => { setNow(Date.now()); invalidate(); }, msUntilNextMinute(item.startedAt, now));
    return () => clearTimeout(timer);
  }, [item.failed, item.startedAt, now, invalidate]);
  const tooltip = machineTooltip(item, now);
  return (
    <div className={`yard-tag ${tooltip.failed ? 'yard-tag--stopped' : 'yard-tag--command'}`}>
      <div className="yard-tag__kind">{tooltip.kindLabel}</div>
      <div className="yard-tag__title">{tooltip.title}</div>
      <div className={tooltip.failed ? 'yard-tag__status yard-tag__status--red' : 'yard-tag__line'}>{tooltip.status}</div>
    </div>
  );
}

export function MachineEntity({ target, slot, tagLift, item, transition, leaving, onDone }: MachineEntityProps) {
  const root = useRef<THREE.Group>(null);
  usePresence(root, transition === 'fade-in', leaving, onDone);
  return (
    <group ref={root} userData={{ yardTarget: target }}>
      <group position={[slot.x, 0, slot.z]} rotation={[0, headingToward(slot, { x: slot.x + 1, z: slot.z + 1 }), 0]}>
        <Machine failed={item.failed} />
      </group>
      <Tag position={[slot.x, tagLift, slot.z]} visible={!leaving}><MachineTagCard item={item} /></Tag>
    </group>
  );
}

// ---- "+N more" ----

export function OverflowMarker({ slot, count, details }: { slot: YardPoint; count: number; details: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <group userData={{ yardTarget: { kind: 'more' } satisfies YardTarget }} onPointerOver={() => setHovered(true)} onPointerOut={() => setHovered(false)}>
      <group position={[slot.x, 0, slot.z]}><OverflowStack /></group>
      <Tag position={[slot.x + 0.2, 1.4, slot.z]} visible>
        <div className="yard-tag yard-tag--more">
          <div className="yard-tag__title">+{count} more</div>
          {hovered && <div className="yard-tag__line">{details}</div>}
          {hovered && <div className="yard-tag__line yard-tag__line--muted">{MORE_CLICK_HINT}</div>}
        </div>
      </Tag>
    </group>
  );
}

// ---- The pending stack ----

/** How far a dropped crate falls, and how long a drop or fade takes. */
const DROP_HEIGHT = 0.8;
const STACK_CHANGE_SECONDS = 0.5;
const BADGE_Y = 1.7;

export interface PendingStackProps {
  pendingCount: number;
  /** Crates robots are on their way to fetch, drawn on top until lifted. */
  inTransit: number;
  /** Crates this change dropped on or faded off (`stackChange`), played once per `version`. */
  change: StackChange;
  version: number;
  /** A click on the badge; the stack itself opens through its `yardTarget`. */
  onOpen: () => void;
}

/**
 * The pending dock: a pallet with one crate per pending task, at most `CRATE_CAP`, and a badge with
 * the exact count (none at 0, when the pallet stands empty). A new pending task drops its crate on
 * top; one that leaves without a robot fetching it fades the top crate. Frames are requested only
 * while that plays.
 */
export function PendingStack({ pendingCount, inTransit, change, version, onOpen }: PendingStackProps) {
  const [hovered, setHovered] = useState(false);
  const view = pendingStack(pendingCount, inTransit);
  const drawn = view.resting + view.transit;
  // This change's drops and fades are counted once, when it arrives, so a later lift (which shrinks the transit count) never adds a ghost crate.
  const arrived = () => ({ version, drops: Math.min(change.drops, view.resting), fades: Math.min(change.fades, CRATE_CAP - drawn) });
  const [played, setPlayed] = useState(arrived);
  let counts = played;
  if (played.version !== version) {
    counts = arrived();
    setPlayed(counts);
  }
  // Clamped to what is drawn now, which can only remove crates.
  const drops = Math.min(counts.drops, view.resting);
  const fades = Math.min(counts.fades, CRATE_CAP - drawn);
  const dropping = useRef<THREE.Group>(null);
  const fading = useRef<THREE.Group>(null);
  const progress = useRef(1);
  const covered = useWorldStore(isSceneCovered);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    progress.current = drops + fades > 0 ? 0 : 1;
    invalidate();
    // Each model change (version) plays its own drop or fade once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  useFrame((state, delta) => {
    if (progress.current >= 1) return;
    progress.current = Math.min(1, progress.current + Math.min(delta, 0.1) / STACK_CHANGE_SECONDS);
    dropping.current?.position.setY((1 - progress.current) * DROP_HEIGHT);
    fading.current?.scale.setScalar(Math.max(0.001, 1 - progress.current));
    if (!covered) state.invalidate();
  });
  const crate = (index: number, origin: YardPoint = { x: 0, z: 0 }) => {
    const spot = crateSpot(index);
    return <group key={index} position={[spot.x - origin.x, spot.y, spot.z - origin.z]}><Crate /></group>;
  };
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
  const tooltip = pendingTooltip(pendingCount);
  return (
    <group userData={{ yardTarget: { kind: 'pending' } satisfies YardTarget }} onPointerOver={() => setHovered(true)} onPointerOut={() => setHovered(false)}>
      <group position={[PALLET.x, 0, PALLET.z]}><Pallet /></group>
      {range(0, view.resting - drops).map((index) => crate(index))}
      <group ref={dropping}>{range(view.resting - drops, view.resting).map((index) => crate(index))}</group>
      {range(view.resting, drawn).map((index) => crate(index))}
      {/* Faded crates shrink into the pallet. */}
      {fades > 0 && <group ref={fading} position={[PALLET.x, 0, PALLET.z]}>{range(drawn, drawn + fades).map((index) => crate(index, PALLET))}</group>}
      {view.badge && (
        <Html position={[PALLET.x, BADGE_Y, PALLET.z]} center zIndexRange={SCENE_HTML_Z_RANGE} distanceFactor={TAG_DISTANCE_FACTOR} occlude={false}>
          <button type="button" className="yard-badge" aria-label={`${tooltip[1]}. ${tooltip[2]}`} onClick={onOpen}>{view.badge}</button>
        </Html>
      )}
      <Tag position={[PALLET.x, BADGE_Y + 0.9, PALLET.z]} visible={hovered}>
        <div className="yard-tag yard-tag--pending">
          <div className="yard-tag__title">{tooltip[0]}</div>
          <div className="yard-tag__line">{tooltip[1]}</div>
          <div className="yard-tag__line yard-tag__line--muted">{tooltip[2]}</div>
        </div>
      </Tag>
    </group>
  );
}
