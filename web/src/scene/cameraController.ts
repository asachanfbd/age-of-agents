/**
 * Drives the 3D village camera between the user's own pan/zoom/rotate (drei MapControls) and the
 * Home button, minimap and W/A/S/D keys. It applies the camera rules from `cameraMath.ts` on every controls change,
 * runs flights one frame at a time, and publishes the camera's orbit for the minimap.
 *
 * Camera state lives here and never in the world store, so moving the camera re-renders only the
 * navigation card, never the Scene or its yards. No three.js import: the controls are reached through
 * the small `OrbitControlsLike` shape, so node tests drive it with a fake (tests/cameraController.test.mjs).
 */
import {
  HOME_FLIGHT_MS, HOME_ORBIT, MINIMAP_FLIGHT_MS, TARGET_Y, clampDistance, clampElevation, clampTarget,
  elevationAfterZoom, flightStep, orbitOfView, positionOfOrbit, sameOrbit, type Flight, type GroundPoint, type Orbit,
} from './cameraMath';
import { isCameraKeyIgnored, rotateOrbit, rotationKey, rotationOfKeys, type KeyEventLike } from './cameraKeys';
import { keyPan } from './minimapMath';

interface Vec3Like { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown }

export interface OrbitControlsLike {
  target: Vec3Like;
  object: { position: Vec3Like; lookAt(x: number, y: number, z: number): unknown };
  update(): unknown;
  addEventListener(type: 'start' | 'change', listener: () => void): void;
  removeEventListener(type: 'start' | 'change', listener: () => void): void;
}

export interface CameraSnapshot { orbit: Orbit; enabled: boolean; aspect: number }

interface ControlsEnabledStore {
  getState(): { controlsEnabled: boolean };
  subscribe(listener: (state: { controlsEnabled: boolean }) => void): () => void;
}

export class CameraController {
  private readonly now: () => number;
  private controls: OrbitControlsLike | null = null;
  private invalidate: () => void = () => {};
  private flight: Flight | null = null;
  /** Rotation keys (W/A/S/D, lower case) currently held, and when they last moved the camera. */
  private readonly heldKeys = new Set<string>();
  private lastRotateAt = 0;
  /** True while a popup covers the scene; it can't be seen, so the keys do nothing. */
  private covered = false;
  /** Set while the controller itself moves the camera, so its own `change` events aren't treated as user input. */
  private applying = false;
  private current: CameraSnapshot = { orbit: HOME_ORBIT, enabled: true, aspect: 16 / 9 };
  private readonly listeners = new Set<() => void>();

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Takes over `controls`; `invalidate` asks the on-demand canvas for a frame. Returns the detach. */
  attach(controls: OrbitControlsLike, invalidate: () => void): () => void {
    this.controls = controls;
    this.invalidate = invalidate;
    controls.addEventListener('start', this.handleStart);
    controls.addEventListener('change', this.handleChange);
    this.publish({ orbit: this.readOrbit(controls) });
    return () => {
      controls.removeEventListener('start', this.handleStart);
      controls.removeEventListener('change', this.handleChange);
      if (this.controls === controls) this.controls = null;
      this.flight = null;
      this.heldKeys.clear();
    };
  }

  /** Follows the world store's `controlsEnabled`: a Project drag pauses the camera, Home and the minimap. */
  followControlsEnabled(store: ControlsEnabledStore): () => void {
    this.setEnabled(store.getState().controlsEnabled);
    return store.subscribe((state) => this.setEnabled(state.controlsEnabled));
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.current.enabled) return;
    if (!enabled) {
      this.flight = null;
      this.heldKeys.clear();
    }
    this.publish({ enabled });
  }

  setCovered(covered: boolean): void {
    this.covered = covered;
    if (covered) this.heldKeys.clear();
  }

  /**
   * Listens on `target` (the window) for W/A/S/D, so the keys work without the minimap focused.
   * Returns the unbind.
   */
  bindKeyboard(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const onKeyDown = (event: KeyboardEvent) => {
      if (this.pressKey(event)) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => this.releaseKey(event.key);
    const onLeave = () => this.heldKeys.clear();
    target.addEventListener('keydown', onKeyDown as EventListener);
    target.addEventListener('keyup', onKeyUp as EventListener);
    target.addEventListener('blur', onLeave);
    return () => {
      target.removeEventListener('keydown', onKeyDown as EventListener);
      target.removeEventListener('keyup', onKeyUp as EventListener);
      target.removeEventListener('blur', onLeave);
      this.heldKeys.clear();
    };
  }

  /** A key went down: true when it is a rotation key the camera now follows (so its default is prevented). */
  pressKey(event: KeyEventLike): boolean {
    const key = rotationKey(event.key);
    if (!key || !this.controls || !this.current.enabled || this.covered || isCameraKeyIgnored(event)) return false;
    if (this.heldKeys.size === 0) this.lastRotateAt = this.now();
    this.flight = null;
    this.heldKeys.add(key);
    this.invalidate();
    return true;
  }

  releaseKey(key: string): void {
    const rotation = rotationKey(key);
    if (rotation) this.heldKeys.delete(rotation);
  }

  setAspect(aspect: number): void {
    if (aspect > 0 && Number.isFinite(aspect) && aspect !== this.current.aspect) this.publish({ aspect });
  }

  readonly getSnapshot = (): CameraSnapshot => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get flying(): boolean {
    return this.flight !== null;
  }

  goHome(): void {
    this.flyTo(HOME_ORBIT, HOME_FLIGHT_MS);
  }

  /** A minimap click: fly to `point`, keeping zoom and rotation. */
  flyToPoint(point: GroundPoint): void {
    this.flyTo({ ...this.current.orbit, target: clampTarget(point, this.current.orbit.target) }, MINIMAP_FLIGHT_MS);
  }

  /** A minimap drag: the target follows `point` at once. */
  moveToPoint(point: GroundPoint): void {
    if (!this.controls || !this.current.enabled) return;
    this.flight = null;
    this.apply({ ...this.current.orbit, target: clampTarget(point, this.current.orbit.target) });
  }

  /** An arrow key on the focused minimap; false for any other key. */
  panByKey(key: string): boolean {
    const next = keyPan(key, this.current.orbit.target);
    if (next) this.moveToPoint(next);
    return next !== null;
  }

  /** Advances a running flight; called every rendered frame. */
  tick(): void {
    if (this.flight) {
      const { orbit, done } = flightStep(this.flight, this.now());
      if (done) this.flight = null;
      this.apply(orbit);
    } else if (this.heldKeys.size > 0) {
      this.rotateHeld();
    }
  }

  private rotateHeld(): void {
    const now = this.now();
    const dt = (now - this.lastRotateAt) / 1000;
    this.lastRotateAt = now;
    this.apply(rotateOrbit(this.current.orbit, rotationOfKeys(this.heldKeys), dt));
  }

  private flyTo(goal: Orbit, duration: number): void {
    if (!this.controls || !this.current.enabled) return;
    const from = this.current.orbit;
    if (sameOrbit(from, goal)) {
      this.flight = null;
      return;
    }
    this.heldKeys.clear();
    this.flight = { from, to: goal, startedAt: this.now(), duration };
    this.invalidate();
  }

  private apply(orbit: Orbit): void {
    const controls = this.controls;
    if (!controls) return;
    this.applying = true;
    try {
      this.write(controls, orbit);
      controls.update();
    } finally {
      this.applying = false;
    }
    this.publish({ orbit });
    this.invalidate();
  }

  private write(controls: OrbitControlsLike, orbit: Orbit): void {
    controls.target.set(orbit.target.x, TARGET_Y, orbit.target.z);
    controls.object.position.set(...positionOfOrbit(orbit));
  }

  private readOrbit(controls: OrbitControlsLike): Orbit {
    const { position } = controls.object;
    return orbitOfView([position.x, position.y, position.z], [controls.target.x, controls.target.y, controls.target.z]);
  }

  /** Any user input (pan, zoom, rotate) cancels a flight where it is. */
  private readonly handleStart = () => {
    this.flight = null;
  };

  /**
   * After every controls change: a zoom also lowers or raises the camera (street walk), and the
   * target is kept on the map by moving target and camera together, so the tilt never changes.
   */
  private readonly handleChange = () => {
    const controls = this.controls;
    if (!controls || this.applying) return;
    const seen = this.readOrbit(controls);
    const last = this.current.orbit;
    const distance = clampDistance(seen.distance);
    const zoomed = Math.abs(distance - last.distance) > 1e-6;
    const orbit: Orbit = {
      target: clampTarget(seen.target, last.target),
      distance,
      azimuth: seen.azimuth,
      elevation: zoomed ? elevationAfterZoom(seen.elevation, last.distance, distance) : clampElevation(seen.elevation),
    };
    if (!sameOrbit(orbit, seen)) {
      this.write(controls, orbit);
      // OrbitControls aimed the camera before dispatching `change`; re-aim it from the moved position.
      // Not `update()`, which would apply the damping deltas a second time.
      controls.object.lookAt(controls.target.x, controls.target.y, controls.target.z);
    }
    this.publish({ orbit });
  };

  private publish(change: Partial<CameraSnapshot>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener();
  }
}

/** The one camera the 3D village has; Scene attaches it, the navigation card drives it. */
export const villageCamera = new CameraController();
