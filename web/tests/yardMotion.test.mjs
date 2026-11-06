import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
import { advanceWalker, headingToward, MAX_STEP_SECONDS, stepTowardPoint, WALK_SPEED } from '../src/scene/yardMotion.ts';

test('stepTowardPoint moves at capped speed toward the target without overshooting, then reports arrived', () => {
  const first = stepTowardPoint({ x: 0, z: 0 }, { x: 10, z: 0 }, 1, 2);
  assert.deepEqual(first, { position: { x: 2, z: 0 }, heading: Math.PI / 2, arrived: false });
  const last = stepTowardPoint({ x: 9, z: 0 }, { x: 10, z: 0 }, 1, 2);
  assert.deepEqual(last.position, { x: 10, z: 0 });
  assert.equal(last.arrived, true);
});

test('advanceWalker walks the queue in order, runs actions as it reaches them, and stops when done', () => {
  const log = [];
  const walker = { position: { x: 0, z: 0 }, heading: 0, queue: [{ to: { x: 0, z: 1 } }, { action: () => log.push('picked up') }, { to: { x: 1, z: 1 } }, { action: () => log.push('inside') }] };
  let frames = 0;
  while (advanceWalker(walker, 0.05) && frames < 1000) frames += 1;
  advanceWalker(walker, 0.05);
  assert.deepEqual(walker.position, { x: 1, z: 1 });
  assert.deepEqual(log, ['picked up', 'inside']);
  assert.equal(walker.queue.length, 0);
  assert.equal(advanceWalker(walker, 0.05), false, 'an idle walker asks for no frames');
});

test('a long pause between frames never teleports a robot: one step is capped', () => {
  const walker = { position: { x: 0, z: 0 }, heading: 0, queue: [{ to: { x: 100, z: 0 } }] };
  advanceWalker(walker, 30);
  assert.ok(Math.abs(walker.position.x - WALK_SPEED * MAX_STEP_SECONDS) < 1e-9);
});

test('headingToward uses the same atan2(dx, dz) facing as the walk', () => {
  assert.equal(headingToward({ x: 0, z: 0 }, { x: 0, z: 1 }), 0);
  assert.equal(headingToward({ x: 0, z: 0 }, { x: 1, z: 0 }), Math.PI / 2);
});

// ---- Fetching a pending crate ----

const { pickUpPath, PICK, SLOTS, workRobotSpot, DOOR } = await import('../src/lib/villageLayout.ts');
const { pickUpDelay } = await import('../src/lib/villageYard.ts');

/** The queue a pick-up robot follows (as YardEntities builds it), recording what happens where. */
function pickUpWalker(slot, order = 0) {
  const events = [];
  const walker = { position: DOOR, heading: 0, queue: [] };
  const { toPick, toBay } = pickUpPath(slot);
  walker.queue = [
    { wait: pickUpDelay(order) },
    { action: () => events.push(['shown', walker.position]) },
    ...toPick.slice(1).map((to) => ({ to })),
    { action: () => events.push(['lift', walker.position, walker.queue.length]) },
    ...toBay.map((to) => ({ to })),
    { action: () => events.push(['set-down', walker.position]) },
  ];
  return { walker, events, toBay };
}
const runFor = (walker, frames, dt) => { for (let i = 0; i < frames; i++) advanceWalker(walker, dt); };

test('M01 the lift runs exactly once, at PICK, before the next waypoint', () => {
  const { walker, events, toBay } = pickUpWalker(SLOTS.work[0]);
  runFor(walker, 2000, 1 / 60);
  const lifts = events.filter(([kind]) => kind === 'lift');
  assert.equal(lifts.length, 1);
  assert.deepEqual(lifts[0][1], PICK);
  assert.equal(lifts[0][2], toBay.length + 1, 'every bay waypoint (and the set-down) is still ahead');
});

test('M02 the robot carries until it reaches its bay, then sets the crate down there', () => {
  const slot = SLOTS.work[4];
  const { walker, events } = pickUpWalker(slot);
  runFor(walker, 4000, 1 / 60);
  assert.deepEqual(events.map(([kind]) => kind), ['shown', 'lift', 'set-down']);
  assert.deepEqual(events.at(-1)[1], workRobotSpot(slot));
  assert.equal(walker.queue.length, 0);
});

test('M03 a long-pause frame is capped and never skips the lift', () => {
  const { walker, events } = pickUpWalker(SLOTS.work[2]);
  runFor(walker, 3000, 30);
  assert.deepEqual(events.map(([kind]) => kind), ['shown', 'lift', 'set-down']);
  assert.deepEqual(events[1][1], PICK);
});

test('M04 a staggered robot stays in the doorway until its delay has passed', () => {
  const { walker, events } = pickUpWalker(SLOTS.work[1], 2);
  runFor(walker, 47, 1 / 60);
  assert.deepEqual([walker.position, events.length], [DOOR, 0], 'still waiting at 0.78 s of 0.8 s');
  runFor(walker, 3, 1 / 60);
  assert.equal(events[0][0], 'shown');
  assert.deepEqual(events[0][1], DOOR);
});
