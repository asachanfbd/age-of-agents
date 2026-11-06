/**
 * The village minimap's geometry: a north-up (-z at the top) square showing the whole map, the
 * camera's ground footprint on it, and the pointer and arrow-key input that moves the camera. Pure
 * numbers, so node tests cover it (tests/minimapMath.test.mjs).
 */
import { worldOfPlot } from '../lib/villageLayout';
import { MAP_HALF, clampTarget, positionOfOrbit, TARGET_Y, type GroundPoint, type Orbit } from './cameraMath';
import { CITY_POSITION } from './townLayout';

export interface MinimapPoint { x: number; y: number }

/** The minimap SVG's viewBox side; CSS sets its on-screen size. */
export const MINIMAP_VIEWBOX = 100;
/** A pointer that moves less than this between press and release is a click (fly), not a drag (follow). */
export const CLICK_DRAG_THRESHOLD_PX = 3;
/** How far one arrow key press moves the camera target, in world units. */
export const KEY_PAN_STEP = 5;
/** How far from the camera the footprint's far edge may reach when it looks at or past the horizon. */
export const FOOTPRINT_RANGE = 4 * MAP_HALF;

export function worldToMinimap(point: GroundPoint, size: number): MinimapPoint {
  return { x: ((point.x + MAP_HALF) / (2 * MAP_HALF)) * size, y: ((point.z + MAP_HALF) / (2 * MAP_HALF)) * size };
}

/** The map point under a pointer at (`px`, `py`) in a `width`×`height` minimap; null when there is none. */
export function minimapToWorld(px: number, py: number, width: number, height: number): GroundPoint | null {
  if (!(width > 0) || !(height > 0) || Number.isNaN(px) || Number.isNaN(py)) return null;
  return clampTarget({ x: (px / width) * 2 * MAP_HALF - MAP_HALF, z: (py / height) * 2 * MAP_HALF - MAP_HALF });
}

export function isMinimapDrag(start: MinimapPoint, current: MinimapPoint): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= CLICK_DRAG_THRESHOLD_PX;
}

/** One press on the minimap, from pointer down to up, in client pixels. */
export interface MinimapPress { start: MinimapPoint; dragging: boolean }

/** A primary-button press on an enabled minimap starts a press; anything else is ignored. */
export function pressStart(at: MinimapPoint, button: number, disabled: boolean): MinimapPress | null {
  return disabled || button !== 0 ? null : { start: at, dragging: false };
}

/** Once a press has moved `CLICK_DRAG_THRESHOLD_PX`, it is a drag and every move asks the camera to follow. */
export function pressMove(press: MinimapPress | null, at: MinimapPoint, disabled: boolean): { press: MinimapPress | null; action: 'follow' | null } {
  if (!press || disabled) return { press, action: null };
  if (!press.dragging && !isMinimapDrag(press.start, at)) return { press, action: null };
  return { press: { ...press, dragging: true }, action: 'follow' };
}

/** A press released before it became a drag is a click, which flies; a cancelled press does nothing. */
export function pressEnd(press: MinimapPress | null, disabled: boolean, cancelled: boolean): 'fly' | null {
  return press && !press.dragging && !disabled && !cancelled ? 'fly' : null;
}

/** Whether a key on the focused minimap was used (so its default, such as scrolling, is prevented). */
export function minimapKey(key: string, disabled: boolean, pan: (key: string) => boolean): boolean {
  return !disabled && pan(key);
}

const ARROW_STEPS: Record<string, GroundPoint> = {
  ArrowUp: { x: 0, z: -KEY_PAN_STEP },
  ArrowDown: { x: 0, z: KEY_PAN_STEP },
  ArrowLeft: { x: -KEY_PAN_STEP, z: 0 },
  ArrowRight: { x: KEY_PAN_STEP, z: 0 },
};

/** Where an arrow key moves the target (north-up, like the minimap); null for any other key. */
export function keyPan(key: string, target: GroundPoint): GroundPoint | null {
  const step = ARROW_STEPS[key];
  return step ? clampTarget({ x: target.x + step.x, z: target.z + step.z }) : null;
}

type Vec = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec): Vec => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};

/**
 * The ground the camera sees: its four screen corners cast onto y = 0, in the order near-left,
 * near-right, far-right, far-left. A corner ray that misses the ground, or meets it beyond
 * `FOOTPRINT_RANGE`, stops at that range instead.
 */
export function groundFootprint(orbit: Orbit, aspect: number, fov: number): GroundPoint[] {
  const position = positionOfOrbit(orbit) as Vec;
  const forward = unit(sub([orbit.target.x, TARGET_Y, orbit.target.z], position));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const tanHalf = Math.tan((fov * Math.PI) / 360);
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  return corners.map(([sx, sy]) => {
    const ray: Vec = [0, 1, 2].map((i) => forward[i] + right[i] * sx * tanHalf * aspect + up[i] * sy * tanHalf) as Vec;
    const reach = ray[1] < 0 ? -position[1] / ray[1] : Infinity;
    const flat = Math.hypot(ray[0], ray[2]);
    const scale = Math.min(reach, FOOTPRINT_RANGE / flat);
    return { x: position[0] + ray[0] * scale, z: position[2] + ray[2] * scale };
  });
}

export interface MinimapDot { id: string; name: string; color: string; x: number; y: number }

interface PlacedProject { id: string; name: string; position: readonly [number, number] }

/** One dot per Project at its yard, in viewBox units; a Project off the map sits at its edge. */
export function minimapDots<P extends PlacedProject>(projects: readonly P[], colorOf: (project: P) => string): MinimapDot[] {
  return projects.map((project) => {
    const [x, z] = worldOfPlot(project.position);
    return { id: project.id, name: project.name, color: colorOf(project), ...worldToMinimap(clampTarget({ x, z }), MINIMAP_VIEWBOX) };
  });
}

/** The Home building (City Center) on the minimap, in viewBox units. */
export const HOME_MARKER: MinimapPoint = (() => {
  const [x, z] = worldOfPlot(CITY_POSITION);
  return worldToMinimap({ x, z }, MINIMAP_VIEWBOX);
})();
