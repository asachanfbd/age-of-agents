import type { YardRect } from './villageLayout';

/**
 * The test-health wall along a rectangle's fence, as straight pieces centred on it. The front (+z)
 * side has a gate gap centred on it; the wall starts at the gate's left edge and runs round the
 * fence to the gate's right edge, so a given coverage always covers the same stretch and the gate
 * stays open.
 */

export type WallTone = 'pass' | 'fail' | 'unknown';

export interface WallPiece {
  tone: WallTone;
  /** The piece runs along this axis. */
  axis: 'x' | 'z';
  length: number;
  /** Its centre relative to the rectangle's centre, in yard units. */
  x: number;
  z: number;
}

export interface WallSplit {
  passedShare: number | null;
  failedShare: number | null;
}

const MIN_PIECE = 1e-6;

interface Side {
  axis: 'x' | 'z';
  /** Where the side starts and its unit direction, relative to the rectangle's centre. */
  start: [number, number];
  dir: [number, number];
  length: number;
}

/**
 * The wall's path as an open polyline: from the left edge of the gate (centred on the front side),
 * round the front-left, back-left, back-right and front-right corners, to the gate's right edge.
 */
function sidesOf(rect: YardRect, gateWidth: number): Side[] {
  const w = rect[2] - rect[0];
  const d = rect[3] - rect[1];
  const hw = w / 2;
  const hd = d / 2;
  const frontRun = (w - gateWidth) / 2;
  return [
    { axis: 'x', start: [-gateWidth / 2, hd], dir: [-1, 0], length: frontRun },
    { axis: 'z', start: [-hw, hd], dir: [0, -1], length: d },
    { axis: 'x', start: [-hw, -hd], dir: [1, 0], length: w },
    { axis: 'z', start: [hw, -hd], dir: [0, 1], length: d },
    { axis: 'x', start: [hw, hd], dir: [-1, 0], length: frontRun },
  ];
}

/** The runs of one tone along the wall's length, green first then red; the last run absorbs rounding. */
function toneRuns(total: number, split: WallSplit): { tone: WallTone; from: number; to: number }[] {
  if (split.passedShare === null || split.failedShare === null) return [{ tone: 'unknown', from: 0, to: total }];
  const passedEnd = total * split.passedShare;
  return [{ tone: 'pass', from: 0, to: passedEnd }, { tone: 'fail', from: passedEnd, to: total }];
}

/** The wall pieces for `coverageFraction` of the fence length (the gate gap not counted); none for null or 0. */
export function wallPieces(coverageFraction: number | null, split: WallSplit, rect: YardRect, gateWidth: number): WallPiece[] {
  if (coverageFraction === null || !(coverageFraction > 0)) return [];
  const sides = sidesOf(rect, gateWidth);
  const pathLength = sides.reduce((sum, side) => sum + side.length, 0);
  const total = Math.min(1, coverageFraction) * pathLength;
  const pieces: WallPiece[] = [];
  let sideStart = 0;
  for (const side of sides) {
    const sideEnd = sideStart + side.length;
    for (const run of toneRuns(total, split)) {
      const from = Math.max(run.from, sideStart);
      const to = Math.min(run.to, sideEnd);
      if (to - from <= MIN_PIECE) continue;
      const mid = (from + to) / 2 - sideStart;
      pieces.push({
        tone: run.tone,
        axis: side.axis,
        length: to - from,
        x: side.start[0] + side.dir[0] * mid,
        z: side.start[1] + side.dir[1] * mid,
      });
    }
    sideStart = sideEnd;
  }
  return pieces;
}

const FULL_TONES: Record<WallTone, number> = { pass: 0x2fb344, fail: 0xe5484d, unknown: 0x4f8cff };
const FADED_TONES: Record<WallTone, number> = { pass: 0xa9bfae, fail: 0xcfb1b3, unknown: 0xbcc6d6 };

/** A tone's colour: its full colour at `weight` 1, its faded tone at 0. */
export function wallColor(tone: WallTone, weight: number): string {
  const t = Math.min(1, Math.max(0, weight));
  const channel = (shift: number) => {
    const full = (FULL_TONES[tone] >> shift) & 0xff;
    const faded = (FADED_TONES[tone] >> shift) & 0xff;
    return Math.round(faded + (full - faded) * t);
  };
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
}
