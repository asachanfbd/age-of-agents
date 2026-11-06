import { forwardRef, Suspense, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useAnimations, useGLTF } from '@react-three/drei';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';
import { APRON, AREAS, BUILDING, BUILDING_CENTER, PALLET_HEIGHT, PALLET_RECT, SLOTS, WAREHOUSE, YARD_DEPTH, YARD_WIDTH } from '../lib/villageLayout';
import type { YardArea, YardRect } from '../lib/villageLayout';
import { intensityWeight } from '../lib/villageTestHealth';
import type { TestHealth } from '../lib/villageTestHealth';
import { wallColor, wallPieces } from '../lib/villageWall';
import { HEALTH_WALL_BASE, HEALTH_WALL_GATE, HEALTH_WALL_HEIGHT, HEALTH_WALL_RECT, HEALTH_WALL_THICKNESS } from './healthWallSize';
import type { WallTone } from '../lib/villageWall';
import { useWorldStore } from '../store/worldStore';
import { isSceneCovered } from '../lib/sceneRendering';
import { isOneShot, robotClip, wrenchSwing, wrenchVisible } from './robotClips';
import type { RobotClip, RobotPose } from './robotClips';
import type { YardTarget } from '../lib/villageYard';

/**
 * The yard's building blocks, in yard units (a robot is about one unit tall). Every geometry and
 * material is built once at module scope and shared by every Project's yard, so many Projects cost
 * draw calls, not memory. Everything is lit (`MeshStandardMaterial`), so the
 * day/night cycle applies; only small glowing parts (a robot's eye, a laptop screen, a machine's
 * light strip) use unlit materials.
 */

const WIDTH = BUILDING[2] - BUILDING[0];
const DEPTH = BUILDING[3] - BUILDING[1];
const { plinthHeight: PLINTH_HEIGHT, wallHeight: WALL_HEIGHT, roofOverhang: ROOF_OVERHANG, roofRise: ROOF_RISE } = WAREHOUSE;
const EAVE_Y = PLINTH_HEIGHT + WALL_HEIGHT;
const ROOF_HALF_SPAN = DEPTH / 2 + ROOF_OVERHANG;
const ROOF_SLOPE = Math.atan2(ROOF_RISE, ROOF_HALF_SPAN);

/** A gable roof: a triangle across the building's depth, extruded along its width so the ridge runs along x. */
function roofGeometry(): THREE.BufferGeometry {
  const profile = new THREE.Shape([new THREE.Vector2(-ROOF_HALF_SPAN, 0), new THREE.Vector2(ROOF_HALF_SPAN, 0), new THREE.Vector2(0, ROOF_RISE)]);
  const length = WIDTH + 2 * ROOF_OVERHANG;
  const geometry = new THREE.ExtrudeGeometry(profile, { depth: length, bevelEnabled: false });
  geometry.translate(0, 0, -length / 2);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

const noRaycast = () => {};

const G = {
  box: new THREE.BoxGeometry(0.56, 0.5, 0.56),
  tape: new THREE.BoxGeometry(0.58, 0.02, 0.13),
  ring: new THREE.RingGeometry(0.3, 0.38, 40).rotateX(-Math.PI / 2),
  plinth: new THREE.BoxGeometry(WIDTH + 0.3, 0.26, DEPTH + 0.3),
  walls: new THREE.BoxGeometry(WIDTH, WALL_HEIGHT, DEPTH),
  healthWall: new THREE.BoxGeometry(1, HEALTH_WALL_HEIGHT, HEALTH_WALL_THICKNESS),
  roof: roofGeometry(),
  roofRib: new THREE.BoxGeometry(WIDTH + 2 * ROOF_OVERHANG - 0.1, 0.05, 0.08),
  ridgeCap: new THREE.BoxGeometry(WIDTH + 2 * ROOF_OVERHANG + 0.1, 0.14, 0.3),
  eaveTrim: new THREE.BoxGeometry(WIDTH + 2 * ROOF_OVERHANG, 0.1, 0.1),
  doorway: new THREE.BoxGeometry(1.5, 1.45, 0.08),
  doorSplit: new THREE.BoxGeometry(0.06, 1.45, 0.1),
  awning: new THREE.BoxGeometry(1.9, 0.08, 0.7),
  windowPane: new THREE.BoxGeometry(0.85, 0.7, 0.06),
  chimney: new THREE.BoxGeometry(0.42, 1.1, 0.42),
  lamp: new THREE.SphereGeometry(0.16, 16, 10),
  machineBody: new THREE.BoxGeometry(0.95, 0.62, 0.72),
  machinePanel: new THREE.PlaneGeometry(0.6, 0.26),
  machineStrip: new THREE.BoxGeometry(0.62, 0.05, 0.02),
  drum: new THREE.CylinderGeometry(0.2, 0.2, 0.3, 24),
  fan: new THREE.BoxGeometry(0.46, 0.03, 0.07),
  beacon: new THREE.SphereGeometry(0.07, 12, 8),
  seat: new THREE.BoxGeometry(0.42, 0.06, 0.42),
  back: new THREE.BoxGeometry(0.06, 0.42, 0.42),
  post: new THREE.CylinderGeometry(0.03, 0.03, 0.36, 8),
  wrenchHandle: new THREE.CylinderGeometry(0.06, 0.06, 1, 8),
  wrenchHead: new THREE.BoxGeometry(0.3, 0.18, 0.1),
  chairBase: new THREE.CylinderGeometry(0.2, 0.2, 0.03, 16),
  desk: new THREE.BoxGeometry(0.5, 0.04, 0.62),
  deskLeg: new THREE.BoxGeometry(0.04, 0.6, 0.04),
  laptopBase: new THREE.BoxGeometry(0.22, 0.02, 0.3),
  laptopScreen: new THREE.BoxGeometry(0.015, 0.2, 0.3),
  laptopGlow: new THREE.PlaneGeometry(0.27, 0.17).rotateY(-Math.PI / 2),
  pinHead: new THREE.SphereGeometry(0.15, 20, 14),
  pinTip: new THREE.ConeGeometry(0.09, 0.24, 16).rotateX(Math.PI),
  stack: new THREE.BoxGeometry(0.42, 0.36, 0.42),
  palletDeck: new THREE.BoxGeometry(PALLET_RECT[2] - PALLET_RECT[0], PALLET_HEIGHT * 0.4, PALLET_RECT[3] - PALLET_RECT[1]),
  palletRunner: new THREE.BoxGeometry(PALLET_RECT[2] - PALLET_RECT[0], PALLET_HEIGHT * 0.6, 0.14),
  yard: new THREE.PlaneGeometry(YARD_WIDTH, YARD_DEPTH).rotateX(-Math.PI / 2),
};

const std = (color: string, options: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...options });
const glow = (color: string) => new THREE.MeshBasicMaterial({ color });

const M = {
  box: std('#d6a46c', { roughness: 0.9 }),
  tape: std('#b98249', { roughness: 0.8 }),
  boxFailed: std('#e0605a', { roughness: 0.85 }),
  tapeFailed: std('#a8322e'),
  dark: std('#1e2633', { roughness: 0.25, metalness: 0.2 }),
  eyeWaiting: glow('#f2b34d'),
  ringWaiting: new THREE.MeshStandardMaterial({ color: '#f2b34d', emissive: '#f2b34d', emissiveIntensity: 0.6, side: THREE.DoubleSide }),
  ringFailed: new THREE.MeshStandardMaterial({ color: '#e5484d', emissive: '#e5484d', emissiveIntensity: 0.6, side: THREE.DoubleSide }),
  white: std('#ffffff', { roughness: 0.45 }),
  wall: std('#f7f0e1', { roughness: 0.85 }),
  doorway: std('#2b3a4d', { roughness: 0.6 }),
  window: std('#bfe3f2', { roughness: 0.2, metalness: 0.1 }),
  brick: std('#c98a6b', { roughness: 0.95 }),
  metal: std('#d3d9e1', { roughness: 0.35, metalness: 0.5 }),
  metalDark: std('#5b6675', { roughness: 0.4, metalness: 0.6 }),
  machineFailed: std('#f0b9b6', { roughness: 0.5, metalness: 0.2 }),
  stripRunning: glow('#4f8cff'),
  stripFailed: glow('#ff4d52'),
  chair: std('#334155', { roughness: 0.5 }),
  desk: std('#e9edf2', { roughness: 0.6 }),
  pin: std('#7c5cf0', { roughness: 0.3 }),
  stack: std('#cbd5e1', { roughness: 0.8 }),
  pallet: std('#a97c50', { roughness: 0.95 }),
};

/** The laptop's screen glows in the Planning board's state colour. */
const SCREEN_COLORS = { running: '#34d399', blocked: '#f59e0b', idle: '#9cc7ff' } as const;
const SCREEN = { running: glow(SCREEN_COLORS.running), blocked: glow(SCREEN_COLORS.blocked), idle: glow(SCREEN_COLORS.idle) };

const roofCache = new Map<string, THREE.MeshStandardMaterial>();
const lampCache = new Map<string, THREE.MeshStandardMaterial>();

/** One roof material per Building Type colour, shared by every warehouse of that type. */
function roofMaterial(color: string): THREE.MeshStandardMaterial {
  let material = roofCache.get(color);
  if (!material) {
    material = std(color, { roughness: 0.55 });
    roofCache.set(color, material);
  }
  return material;
}

/** One health-wall material per (tone, intensity step), shared by every yard. */
const healthCache = new Map<string, THREE.MeshStandardMaterial>();
function healthMaterial(tone: WallTone, intensity: number): THREE.MeshStandardMaterial {
  const color = wallColor(tone, intensityWeight(intensity));
  let material = healthCache.get(color);
  if (!material) {
    material = std(color, { roughness: 0.6 });
    healthCache.set(color, material);
  }
  return material;
}

/** One trim/lamp material per status colour; a glowing status lights the lamp. */
function statusMaterial(color: string, glowing: boolean): THREE.MeshStandardMaterial {
  const key = `${color}:${glowing}`;
  let material = lampCache.get(key);
  if (!material) {
    material = std(color, { roughness: 0.4, emissive: color, emissiveIntensity: glowing ? 0.9 : 0.05 });
    lampCache.set(key, material);
  }
  return material;
}

// ---- The painted yard: one canvas texture shared by every Project ----

const PX = 48;

/** Each zone's ground tint, dashed edge and painted floor word. */
const ZONE_LOOK: Record<YardArea, { fill: string; edge: string; word: string }> = {
  pending: { fill: '#f7efe2', edge: '#c08a4e', word: 'PENDING' },
  planning: { fill: '#e9f6ee', edge: '#4fa77a', word: 'PLANNING' },
  work: { fill: '#eaf1fc', edge: '#5b8fd9', word: 'IN PROGRESS' },
  commands: { fill: '#eef0f6', edge: '#7a86a3', word: 'COMMANDS' },
  merge: { fill: '#f1edfc', edge: '#8a6fe0', word: 'PRs WAITING' },
};

function paintYard(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = YARD_WIDTH * PX;
  canvas.height = YARD_DEPTH * PX;
  const g = canvas.getContext('2d');
  if (g) {
    const X = (x: number) => (x + YARD_WIDTH / 2) * PX;
    const Z = (z: number) => (z + YARD_DEPTH / 2) * PX;
    const rounded = (r: YardRect, radius: number) => {
      g.beginPath();
      g.roundRect(X(r[0]), Z(r[1]), (r[2] - r[0]) * PX, (r[3] - r[1]) * PX, radius);
    };
    rounded([-8.95, -7.45, 8.95, 7.45], 24);
    g.fillStyle = '#f6f8fb';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#d9e0e9';
    g.stroke();
    // The apron: a plain walkway, edged but unlabelled, that nothing stands on.
    g.fillStyle = '#ece6d8';
    g.fillRect(X(APRON[0]), Z(APRON[1]), (APRON[2] - APRON[0]) * PX, (APRON[3] - APRON[1]) * PX);
    g.setLineDash([10, 8]);
    g.lineWidth = 2;
    g.strokeStyle = '#c9bc9f';
    for (const z of [APRON[1], APRON[3]]) {
      g.beginPath();
      g.moveTo(X(APRON[0]), Z(z));
      g.lineTo(X(APRON[2]), Z(z));
      g.stroke();
    }
    g.setLineDash([]);
    for (const area of Object.keys(ZONE_LOOK) as YardArea[]) {
      const r = AREAS[area];
      rounded(r, 12);
      g.fillStyle = ZONE_LOOK[area].fill;
      g.fill();
      g.setLineDash([14, 9]);
      g.lineWidth = 3;
      g.strokeStyle = ZONE_LOOK[area].edge;
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = ZONE_LOOK[area].edge;
      g.font = '700 22px Inter, system-ui, sans-serif';
      g.fillText(ZONE_LOOK[area].word, X(r[0]) + 12, Z(r[3]) - 12);
    }
    g.lineWidth = 2;
    g.strokeStyle = '#cdd6e3';
    for (const slot of SLOTS.work.slice(0, -1)) {
      rounded([slot.x - 1.25, slot.z - 0.95, slot.x + 1.25, slot.z + 0.95], 6);
      g.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const YARD_MATERIAL = new THREE.MeshStandardMaterial({ map: paintYard(), roughness: 1 });

export function YardGround() {
  return <mesh geometry={G.yard} material={YARD_MATERIAL} position={[0, 0.01, 0]} receiveShadow />;
}

// ---- Warehouse ----

/**
 * The test-health wall: a path over the Project's boundary fence, running from one edge of the gate round the yard to the other. Its
 * length is the coverage, its colour the passed/failed split, its intensity the age of the last run.
 * It never takes a click: the pieces opt out of raycasting.
 */
export function YardHealthWall({ health }: { health: TestHealth }) {
  return (
    <>
      {wallPieces(health.coverageFraction, health, HEALTH_WALL_RECT, HEALTH_WALL_GATE).map((piece, i) => (
        <mesh
          key={i}
          geometry={G.healthWall}
          material={healthMaterial(piece.tone, health.ageIntensity)}
          position={[piece.x, HEALTH_WALL_BASE + HEALTH_WALL_HEIGHT / 2, piece.z]}
          rotation={[0, piece.axis === 'z' ? Math.PI / 2 : 0, 0]}
          scale={[piece.length, 1, 1]}
          raycast={noRaycast}
          castShadow
        />
      ))}
    </>
  );
}

const RIB_FRACTIONS = [0.3, 0.55, 0.8];

/**
 * The Project's warehouse: cream walls, a pitched roof in its Building Type colour with tile ribs, a
 * double door under an awning on the front (+z) wall, windows, a chimney, and a status lamp and eave
 * trim in the status colour. Every Building Type uses this same shape.
 */
export function Warehouse({ color, statusColor, glowing, selected }: { color: string; statusColor: string; glowing: boolean; selected: boolean }) {
  const roof = roofMaterial(color);
  const status = statusMaterial(statusColor, glowing);
  const front = DEPTH / 2;
  return (
    <group position={[BUILDING_CENTER.x, 0, BUILDING_CENTER.z]} userData={{ yardTarget: { kind: 'dome' } satisfies YardTarget }}>
      <mesh geometry={G.plinth} material={M.white} position={[0, PLINTH_HEIGHT / 2, 0]} castShadow receiveShadow />
      <mesh geometry={G.walls} material={M.wall} position={[0, PLINTH_HEIGHT + WALL_HEIGHT / 2, 0]} castShadow receiveShadow />
      <mesh geometry={G.roof} material={roof} position={[0, EAVE_Y, 0]} castShadow receiveShadow />
      {RIB_FRACTIONS.flatMap((fraction) => [1, -1].map((side) => (
        <mesh
          key={`${fraction}:${side}`}
          geometry={G.roofRib}
          material={M.white}
          position={[0, EAVE_Y + ROOF_RISE * fraction + 0.04, side * ROOF_HALF_SPAN * (1 - fraction)]}
          rotation={[side * ROOF_SLOPE, 0, 0]}
        />
      )))}
      <mesh geometry={G.ridgeCap} material={selected ? M.pin : M.white} position={[0, EAVE_Y + ROOF_RISE + 0.04, 0]} />
      {[1, -1].map((side) => <mesh key={side} geometry={G.eaveTrim} material={status} position={[0, EAVE_Y - 0.02, side * ROOF_HALF_SPAN]} />)}
      <mesh geometry={G.doorway} material={M.doorway} position={[0, PLINTH_HEIGHT + 0.725, front + 0.02]} />
      <mesh geometry={G.doorSplit} material={M.metal} position={[0, PLINTH_HEIGHT + 0.725, front + 0.06]} />
      <mesh geometry={G.awning} material={roof} position={[0, PLINTH_HEIGHT + 1.7, front + 0.35]} rotation={[0.18, 0, 0]} />
      {[-1.7, 1.7].map((x) => <mesh key={x} geometry={G.windowPane} material={M.window} position={[x, PLINTH_HEIGHT + 1.05, front + 0.02]} />)}
      <mesh geometry={G.lamp} material={status} position={[0, EAVE_Y - 0.25, front + 0.12]} />
      <mesh geometry={G.chimney} material={M.brick} position={[1.6, EAVE_Y + 1.1, -0.6]} />
    </group>
  );
}

// ---- Box ----

/** A cardboard box; a stopped or failed task's box is red, tipped over, with a red ring around it. */
export function Crate({ failed = false }: { failed?: boolean }) {
  return (
    <group>
      <group rotation={[0, 0, failed ? 0.2 : 0]} position={[failed ? 0.06 : 0, 0, 0]}>
        <mesh geometry={G.box} material={failed ? M.boxFailed : M.box} position={[0, 0.25, 0]} castShadow receiveShadow />
        <mesh geometry={G.tape} material={failed ? M.tapeFailed : M.tape} position={[0, 0.505, 0]} />
      </group>
      {failed && <mesh geometry={G.ring} material={M.ringFailed} position={[0, 0.02, 0]} scale={[1.3, 1, 1.3]} />}
    </group>
  );
}

// ---- Robot ----

export type { RobotPose } from './robotClips';

export interface RobotMotion {
  /** Set by the entity each frame: true while walking. */
  moving: boolean;
}

const MODEL_PATH = '/models/RobotExpressive.glb';
/** The glTF is ~4.79 units tall; this brings it to about one yard unit. */
const MODEL_SCALE = 0.21;
const CLIP_FADE_SECONDS = 0.3;
/** After a clip switch the robot keeps requesting frames this long, so the cross-fade and a one-shot clip finish. */
const SETTLE_SECONDS = 1.5;

/** Wrench length in the model's own (unscaled) units; the model is ~4.79 tall. */
const WRENCH_LENGTH = 0.6;

/** A small wrench held by the robot's right hand while it works on its box. */
function buildWrench(): THREE.Group {
  const wrench = new THREE.Group();
  const handle = new THREE.Mesh(G.wrenchHandle, M.metalDark);
  handle.position.y = 0.5;
  const head = new THREE.Mesh(G.wrenchHead, M.metalDark);
  head.position.y = 1.05;
  wrench.add(handle, head);
  wrench.visible = false;
  return wrench;
}

/**
 * One RobotExpressive model, cloned with its skeleton so each robot animates independently off a single
 * shared load. The clip follows `pose` and `motion.moving`; the canvas renders on demand, so the robot
 * asks for frames only while its clip keeps moving (walking, wrench turning, waving) or is settling
 * after a switch, and never while a popup covers the scene.
 */
function RobotModel({ pose, motion }: { pose: RobotPose; motion: { current: RobotMotion } }) {
  const { scene, animations } = useGLTF(MODEL_PATH);
  const clone = useMemo(() => {
    const copy = SkeletonUtils.clone(scene) as THREE.Group;
    copy.traverse((child) => { if ((child as THREE.Mesh).isMesh) child.castShadow = true; });
    return copy;
  }, [scene]);
  const rig = useMemo(() => {
    const wrench = buildWrench();
    const hand = clone.getObjectByName('Hand.R');
    if (hand) {
      // The hand bone carries a large scale (100) under a shrunken arm; cancel it so the wrench keeps its own size.
      clone.updateMatrixWorld(true);
      wrench.scale.setScalar(WRENCH_LENGTH / hand.getWorldScale(new THREE.Vector3()).x);
      hand.add(wrench);
    }
    return { wrench };
  }, [clone]);
  const { actions } = useAnimations(animations, clone);
  const covered = useWorldStore(isSceneCovered);
  const current = useRef<RobotClip | null>(null);
  const settle = useRef(SETTLE_SECONDS);

  useFrame((state, delta) => {
    const moving = motion.current.moving;
    const clip = robotClip(pose, moving);
    if (clip !== current.current) {
      const next = actions[clip];
      if (next) {
        const previous = current.current ? actions[current.current] : null;
        previous?.fadeOut(CLIP_FADE_SECONDS);
        next.reset().setLoop(isOneShot(clip) ? THREE.LoopOnce : THREE.LoopRepeat, Infinity).fadeIn(CLIP_FADE_SECONDS).play();
        next.clampWhenFinished = true;
        current.current = clip;
        settle.current = SETTLE_SECONDS;
      }
    }
    settle.current = Math.max(0, settle.current - delta);
    const turning = wrenchVisible(pose, moving);
    rig.wrench.visible = turning;
    if (turning) {
      rig.wrench.rotation.z = wrenchSwing(state.clock.elapsedTime);
    }
    // Holding, idle and seated robots settle into a still pose; walking, wrench turning and waving keep moving.
    const animating = moving || pose === 'work' || pose === 'wait' || settle.current > 0;
    if (animating && !covered) state.invalidate();
  });

  return <primitive object={clone} scale={MODEL_SCALE} />;
}

useGLTF.preload(MODEL_PATH);

/**
 * The expressive robot. Its clip animates from `pose` (and `motion.moving`, which the entity updates as
 * it walks): turning a wrench at its box, waving with an amber ring and light while waiting on the person,
 * standing while holding a box, or sitting at the laptop. `children` ride in front of it (a carried
 * box); `overhead` floats above its head.
 */
export const Robot = forwardRef<THREE.Group, { pose: RobotPose; motion: { current: RobotMotion }; children?: React.ReactNode; overhead?: React.ReactNode }>(function Robot({ pose, motion, children, overhead }, ref) {
  const waiting = pose === 'wait';
  return (
    <group ref={ref}>
      <Suspense fallback={null}>
        <RobotModel pose={pose} motion={motion} />
      </Suspense>
      {children && <group position={[0, 0.42, 0.36]} scale={0.8}>{children}</group>}
      {waiting && <mesh geometry={G.ring} material={M.ringWaiting} position={[0, 0.02, 0]} />}
      {waiting && <mesh geometry={G.beacon} material={M.eyeWaiting} position={[0, 1.08, 0]} />}
      {overhead}
    </group>
  );
});

/** The purple map pin over a robot waiting outside the warehouse with its box (its PR is not merged). */
export function MergePin() {
  return (
    <group position={[0, 1.15, 0]}>
      <mesh geometry={G.pinTip} material={M.pin} position={[0, 0.12, 0]} />
      <mesh geometry={G.pinHead} material={M.pin} position={[0, 0.3, 0]} />
    </group>
  );
}

// ---- Command machine ----

/** A command run's machine: drum and fan turn while it runs; a failed run's machine is red and still. */
export function Machine({ failed }: { failed: boolean }) {
  const drum = useRef<THREE.Mesh>(null);
  const fan = useRef<THREE.Group>(null);
  const covered = useWorldStore(isSceneCovered);
  useFrame((state, delta) => {
    if (failed) return;
    const dt = Math.min(delta, 0.1);
    if (drum.current) drum.current.rotation.y += dt * 3;
    if (fan.current) fan.current.rotation.y += dt * 9;
    if (!covered) state.invalidate();
  });
  const light = failed ? M.stripFailed : M.stripRunning;
  return (
    <group>
      <mesh geometry={G.machineBody} material={failed ? M.machineFailed : M.metal} position={[0, 0.31, 0]} castShadow receiveShadow />
      <mesh geometry={G.machinePanel} material={M.dark} position={[0, 0.38, 0.361]} />
      <mesh geometry={G.machineStrip} material={light} position={[0, 0.14, 0.37]} />
      <mesh ref={drum} geometry={G.drum} material={M.metalDark} position={[-0.18, 0.77, 0]} castShadow />
      <group ref={fan} position={[0.22, 0.65, 0]}>
        <mesh geometry={G.fan} material={M.metalDark} />
        <mesh geometry={G.fan} material={M.metalDark} rotation={[0, Math.PI / 2, 0]} />
      </group>
      <mesh geometry={G.beacon} material={light} position={[0.38, 0.69, 0.26]} />
      {failed && <mesh geometry={G.ring} material={M.ringFailed} position={[0, 0.02, 0]} scale={[1.9, 1, 1.9]} />}
    </group>
  );
}

// ---- Planning desk ----

/** A chair and a desk with a laptop, its screen glowing in the session's live-state colour. */
export function PlanningStation({ live }: { live: keyof typeof SCREEN }) {
  return (
    <group>
      <mesh geometry={G.chairBase} material={M.chair} position={[0, 0.015, 0]} />
      <mesh geometry={G.post} material={M.chair} position={[0, 0.2, 0]} />
      <mesh geometry={G.seat} material={M.chair} position={[0, 0.4, 0]} castShadow />
      <mesh geometry={G.back} material={M.chair} position={[-0.2, 0.62, 0]} castShadow />
      <mesh geometry={G.desk} material={M.desk} position={[0.5, 0.62, 0]} castShadow receiveShadow />
      {[[-0.2, -0.27], [0.2, -0.27], [-0.2, 0.27], [0.2, 0.27]].map(([dx, dz]) => (
        <mesh key={`${dx}:${dz}`} geometry={G.deskLeg} material={M.desk} position={[0.5 + dx!, 0.3, dz!]} />
      ))}
      <group position={[0.48, 0.645, 0]}>
        <mesh geometry={G.laptopBase} material={M.metalDark} />
        <group position={[0.11, 0, 0]} rotation={[0, 0, -0.28]}>
          <mesh geometry={G.laptopScreen} material={M.metalDark} position={[0, 0.1, 0]} />
          <mesh geometry={G.laptopGlow} material={SCREEN[live]} position={[-0.009, 0.1, 0]} />
        </group>
      </group>
    </group>
  );
}

/** The pending dock's pallet: a deck on three runners, low enough that a full stack stays below the warehouse walls. */
export function Pallet() {
  const depth = PALLET_RECT[3] - PALLET_RECT[1];
  return (
    <group>
      {[-1, 0, 1].map((side) => (
        <mesh key={side} geometry={G.palletRunner} material={M.pallet} position={[0, PALLET_HEIGHT * 0.3, (side * (depth - 0.14)) / 2]} castShadow receiveShadow />
      ))}
      <mesh geometry={G.palletDeck} material={M.pallet} position={[0, PALLET_HEIGHT * 0.8, 0]} castShadow receiveShadow />
    </group>
  );
}

/** The "+N more" marker: a small stack of boxes in the zone's reserved slot. */
export function OverflowStack() {
  return (
    <group>
      <mesh geometry={G.stack} material={M.stack} position={[0, 0.18, 0]} castShadow />
      <mesh geometry={G.stack} material={M.stack} position={[0.06, 0.54, -0.04]} rotation={[0, 0.4, 0]} castShadow />
      <mesh geometry={G.stack} material={M.stack} position={[0.5, 0.18, 0.12]} rotation={[0, -0.3, 0]} castShadow />
    </group>
  );
}
