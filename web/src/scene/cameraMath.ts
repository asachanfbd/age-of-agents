/**
 * The 3D village camera's rules as pure numbers: how far it may pan, zoom and tilt, how zooming in
 * becomes a walk down the street, and how a flight back Home or to a minimap spot moves. No three.js
 * import, so node tests cover it (tests/cameraMath.test.mjs).
 *
 * The camera is described as an orbit around a ground target: `distance` from it, `azimuth` round the
 * y axis (three.js Spherical's theta: 0 looks from +z toward -z) and `elevation` above the horizon.
 */
import { DEFAULT_VIEW, type Vec3 } from './defaultView';
import { ROAD_REACH } from './townLayout';

export interface GroundPoint { x: number; z: number }
export interface Orbit { target: GroundPoint; distance: number; azimuth: number; elevation: number }

const degToRad = (deg: number) => (deg * Math.PI) / 180;

/** How far the camera target may pan: the town's edge, in world units, on both axes. */
export const MAP_HALF = ROAD_REACH;
/** The target's height; panning keeps it on the ground. */
export const TARGET_Y = DEFAULT_VIEW.target[1];

/** Closest zoom: a street with the yards on both sides filling the screen. */
export const MIN_DISTANCE = 8;
/** Furthest zoom: the whole 12-street town on screen and still nearer than the fog. */
export const MAX_DISTANCE = 160;
/** Tilt limits, so the camera never goes under the ground or over the top. */
export const MIN_ELEVATION = degToRad(20);
export const MAX_ELEVATION = degToRad(80);
/** How low zooming all the way in brings the camera, so the yards are seen from the side. */
export const STREET_ELEVATION = degToRad(28);

export const HOME_FLIGHT_MS = 700;
export const MINIMAP_FLIGHT_MS = 450;

export function orbitOfView(position: Vec3, target: Vec3): Orbit {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  return {
    target: { x: target[0], z: target[2] },
    distance: Math.hypot(dx, dy, dz),
    azimuth: Math.atan2(dx, dz),
    elevation: Math.atan2(dy, Math.hypot(dx, dz)),
  };
}

export function positionOfOrbit(orbit: Orbit): Vec3 {
  const ground = orbit.distance * Math.cos(orbit.elevation);
  return [
    orbit.target.x + ground * Math.sin(orbit.azimuth),
    TARGET_Y + orbit.distance * Math.sin(orbit.elevation),
    orbit.target.z + ground * Math.cos(orbit.azimuth),
  ];
}

/** The Home view as an orbit; DEFAULT_VIEW stays its one definition. */
export const HOME_ORBIT: Orbit = orbitOfView(DEFAULT_VIEW.position, DEFAULT_VIEW.target);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clampToMap = (value: number) => clamp(value, -MAP_HALF, MAP_HALF);

/** Keeps a target on the map; a NaN coordinate falls back to `fallback`'s (the previous target). */
export function clampTarget(point: GroundPoint, fallback: GroundPoint = HOME_ORBIT.target): GroundPoint {
  return {
    x: clampToMap(Number.isNaN(point.x) ? fallback.x : point.x),
    z: clampToMap(Number.isNaN(point.z) ? fallback.z : point.z),
  };
}

export function clampDistance(distance: number): number {
  return Number.isNaN(distance) ? HOME_ORBIT.distance : clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
}

export function clampElevation(elevation: number): number {
  return Number.isNaN(elevation) ? HOME_ORBIT.elevation : clamp(elevation, MIN_ELEVATION, MAX_ELEVATION);
}

/**
 * The elevation zoom alone gives at `distance`: Home's elevation from Home's distance outwards,
 * easing down to `STREET_ELEVATION` at `MIN_DISTANCE`. Never decreases as the camera backs off.
 */
export function streetWalkElevation(distance: number): number {
  const t = (clampDistance(distance) - MIN_DISTANCE) / (HOME_ORBIT.distance - MIN_DISTANCE);
  return STREET_ELEVATION + (HOME_ORBIT.elevation - STREET_ELEVATION) * easeInOut(t);
}

/** The street-walk elevation at `distance` plus the user's own tilt on top of it, within the tilt limits. */
export function tiltedElevation(distance: number, tilt: number): number {
  return clampElevation(streetWalkElevation(distance) + tilt);
}

/** After a zoom from `fromDistance` to `toDistance`, the elevation that keeps the user's tilt. */
export function elevationAfterZoom(elevation: number, fromDistance: number, toDistance: number): number {
  return tiltedElevation(toDistance, elevation - streetWalkElevation(fromDistance));
}

/** An angle in (-π, π]; any non-finite angle becomes 0. */
export function normalizeAzimuth(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const turned = angle % (2 * Math.PI);
  if (turned > Math.PI) return turned - 2 * Math.PI;
  if (turned <= -Math.PI) return turned + 2 * Math.PI;
  return turned;
}

export function easeInOut(t: number): number {
  const x = clamp(Number.isNaN(t) ? 0 : t, 0, 1);
  return x * x * (3 - 2 * x);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The orbit `t` (0..1, already eased) of the way from `from` to `to`; the azimuth turns the short way round. */
export function interpolateOrbit(from: Orbit, to: Orbit, t: number): Orbit {
  if (t >= 1) return to;
  return {
    target: { x: lerp(from.target.x, to.target.x, t), z: lerp(from.target.z, to.target.z, t) },
    distance: lerp(from.distance, to.distance, t),
    azimuth: normalizeAzimuth(from.azimuth + normalizeAzimuth(to.azimuth - from.azimuth) * t),
    elevation: lerp(from.elevation, to.elevation, t),
  };
}

export interface Flight { from: Orbit; to: Orbit; startedAt: number; duration: number }

/** Where a flight is `now`; `done` once it has reached `to` exactly. */
export function flightStep(flight: Flight, now: number): { orbit: Orbit; done: boolean } {
  const elapsed = now - flight.startedAt;
  if (flight.duration <= 0 || elapsed >= flight.duration) return { orbit: flight.to, done: true };
  if (!(elapsed > 0)) return { orbit: flight.from, done: false };
  return { orbit: interpolateOrbit(flight.from, flight.to, easeInOut(elapsed / flight.duration)), done: false };
}

const EPSILON = 1e-6;

export function sameOrbit(a: Orbit, b: Orbit): boolean {
  return Math.abs(a.target.x - b.target.x) < EPSILON && Math.abs(a.target.z - b.target.z) < EPSILON
    && Math.abs(a.distance - b.distance) < EPSILON && Math.abs(normalizeAzimuth(a.azimuth - b.azimuth)) < EPSILON
    && Math.abs(a.elevation - b.elevation) < EPSILON;
}
