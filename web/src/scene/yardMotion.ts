import type { YardPoint } from '../lib/villageLayout';

/**
 * How a yard robot moves: a queue of waypoints, pauses and one-off actions (lift a crate, set it
 * down, go inside), walked at a fixed speed. Plain logic with no three.js or React, so it is unit-tested
 * (tests/yardMotion.test.mjs); `YardEntities.tsx` advances it from `useFrame`.
 */

/** Yard units per second. */
export const WALK_SPEED = 2.6;
/** A frame after a long on-demand pause reports a huge delta; cap it so a robot resumes its walk instead of teleporting. */
export const MAX_STEP_SECONDS = 0.1;

/** Walk to a point; run an action once; or stand still for `wait` seconds (counted down in place). */
export type WalkStep = { to: YardPoint } | { action: () => void } | { wait: number };

export interface Walker {
  position: YardPoint;
  /** Radians, `Math.atan2(dx, dz)`: 0 faces +z (toward the camera). */
  heading: number;
  queue: WalkStep[];
}

/**
 * Moves `position` at most `speed * delta` straight toward `target`, never overshooting. `heading`
 * faces the direction of travel; once arrived it is meaningless (the caller then wants the spot's own facing).
 */
export function stepTowardPoint(position: YardPoint, target: YardPoint, delta: number, speed: number): { position: YardPoint; heading: number; arrived: boolean } {
  const dx = target.x - position.x;
  const dz = target.z - position.z;
  const distance = Math.hypot(dx, dz);
  const heading = Math.atan2(dx, dz);
  const step = speed * delta;
  if (distance <= step) return { position: target, heading, arrived: true };
  return { position: { x: position.x + (dx / distance) * step, z: position.z + (dz / distance) * step }, heading, arrived: false };
}

/**
 * Runs any actions at the head of the queue, then waits out a pause or walks toward the next
 * waypoint for `delta` seconds. Returns whether the walker still has steps left (so the caller keeps
 * requesting frames).
 */
export function advanceWalker(walker: Walker, delta: number, speed: number = WALK_SPEED): boolean {
  const dt = Math.min(Math.max(delta, 0), MAX_STEP_SECONDS);
  while (walker.queue.length > 0 && 'action' in walker.queue[0]!) (walker.queue.shift() as { action: () => void }).action();
  const next = walker.queue[0];
  if (!next || 'action' in next) return false;
  if ('wait' in next) {
    next.wait -= dt;
    if (next.wait <= 0) walker.queue.shift();
    return walker.queue.length > 0;
  }
  const step = stepTowardPoint(walker.position, next.to, dt, speed);
  walker.position = step.position;
  if (!step.arrived || walker.queue.length > 1) walker.heading = step.heading;
  if (step.arrived) walker.queue.shift();
  return walker.queue.length > 0;
}

/** Heading that faces from `from` toward `to`. */
export const headingToward = (from: YardPoint, to: YardPoint): number => Math.atan2(to.x - from.x, to.z - from.z);
