import { YARD_RECT, YARD_SCALE } from '../lib/villageLayout';
import type { YardRect } from '../lib/villageLayout';
import { FENCE_HEIGHT, FENCE_MARGIN, GATE_WIDTH } from './scenery';

/**
 * Where the test-health wall stands, in yard units: a path along the Project's boundary fence (the
 * yard rectangle pushed out by the fence margin) whose base sits on the fence top, so the two read
 * as one boundary with the status band above it.
 */

const fenceMargin = FENCE_MARGIN / YARD_SCALE;

export const HEALTH_WALL_RECT: YardRect = [
  YARD_RECT[0] - fenceMargin, YARD_RECT[1] - fenceMargin, YARD_RECT[2] + fenceMargin, YARD_RECT[3] + fenceMargin,
];
/** The fence's gate gap, which the wall leaves open. */
export const HEALTH_WALL_GATE = GATE_WIDTH / YARD_SCALE;
export const HEALTH_WALL_BASE = FENCE_HEIGHT / YARD_SCALE;
export const HEALTH_WALL_HEIGHT = 0.9;
export const HEALTH_WALL_THICKNESS = 0.3;
