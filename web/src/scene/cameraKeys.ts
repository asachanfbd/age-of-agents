/**
 * Keyboard rotation of the 3D village camera as pure functions: which keys turn or tilt it, how far a
 * held key moves it in one frame, and which key events must be left alone (typing, browser shortcuts).
 * No DOM or three.js import, so node tests cover it (tests/cameraKeys.test.mjs).
 */
import { clampElevation, normalizeAzimuth, type Orbit } from './cameraMath';

/** Direction of travel per axis: -1, 0 or 1. D raises the azimuth and W raises the elevation. */
export interface KeyRotation { azimuth: number; elevation: number }

/** Turn and tilt speed while a key is held, in radians per second (75°/s). */
export const ROTATE_RATE = (75 * Math.PI) / 180;
/** The longest frame gap that moves the camera, in seconds, so a stalled frame never makes it jump. */
export const MAX_ROTATE_DT = 0.1;

const KEY_ROTATIONS: Record<string, KeyRotation> = {
  a: { azimuth: -1, elevation: 0 },
  d: { azimuth: 1, elevation: 0 },
  w: { azimuth: 0, elevation: 1 },
  s: { azimuth: 0, elevation: -1 },
};

/** The rotation key a keyboard `key` stands for (any letter case), or null. */
export function rotationKey(key: string): string | null {
  const lower = key.toLowerCase();
  return lower in KEY_ROTATIONS ? lower : null;
}

/** The combined direction of the held rotation keys; opposite keys cancel. */
export function rotationOfKeys(keys: Iterable<string>): KeyRotation {
  const total: KeyRotation = { azimuth: 0, elevation: 0 };
  for (const key of keys) {
    total.azimuth += KEY_ROTATIONS[key].azimuth;
    total.elevation += KEY_ROTATIONS[key].elevation;
  }
  return total;
}

/** `orbit` after `dt` seconds of `rotation`; the target and distance stay, the tilt stays within limits. */
export function rotateOrbit(orbit: Orbit, rotation: KeyRotation, dt: number): Orbit {
  if (!(dt > 0) || !Number.isFinite(dt)) return orbit;
  const step = ROTATE_RATE * Math.min(dt, MAX_ROTATE_DT);
  return {
    ...orbit,
    azimuth: normalizeAzimuth(orbit.azimuth + rotation.azimuth * step),
    elevation: clampElevation(orbit.elevation + rotation.elevation * step),
  };
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  target: unknown;
}

interface TargetLike { tagName?: string; isContentEditable?: boolean; closest?(selector: string): unknown }

/** Marks the terminal pane (its xterm helper textarea is covered by the `textarea` rule). */
const TERMINAL_SELECTOR = '[data-task-terminal], .xterm';
const EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"])';
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function isTypingTarget(target: unknown): boolean {
  const element = target as TargetLike | null;
  if (!element) return false;
  if (element.tagName && TYPING_TAGS.has(element.tagName.toUpperCase())) return true;
  if (element.isContentEditable) return true;
  return typeof element.closest === 'function' && Boolean(element.closest(`${EDITABLE_SELECTOR}, ${TERMINAL_SELECTOR}`));
}

/** Whether a key event must not drive the camera: a browser shortcut, IME composition or typing. */
export function isCameraKeyIgnored(event: KeyEventLike): boolean {
  return event.ctrlKey || event.metaKey || event.altKey || Boolean(event.isComposing) || isTypingTarget(event.target);
}
