/** The RobotExpressive model's animation clips that a yard robot plays. */
export type RobotClip = 'Idle' | 'Walking' | 'Wave' | 'Sitting';

/** A yard robot's pose; `sit` types at the laptop, `seated` sits still (a planning session between turns or waiting for input). */
export type RobotPose = 'idle' | 'work' | 'wait' | 'carry' | 'sit' | 'seated';

/**
 * Which clip a robot plays. Walking wins over every pose (a robot walking out with a box still
 * walks); standing still, `work` idles (the wrench turn is layered on top, see `wrenchSwing`),
 * `wait` waves for the person, and the two seated poses sit. Plain TypeScript with no glTF import, so Node tests can load it.
 */
export function robotClip(pose: RobotPose, moving: boolean): RobotClip {
  if (moving) return 'Walking';
  switch (pose) {
    case 'wait': return 'Wave';
    case 'sit':
    case 'seated': return 'Sitting';
    default: return 'Idle';
  }
}

/** Sitting is a one-shot transition that holds its last pose; every other clip loops. */
export const isOneShot = (clip: RobotClip): boolean => clip === 'Sitting';

/** Peak wrench rotation in radians. */
export const WRENCH_AMPLITUDE = 0.45;
/** Seconds per swing cycle; slow enough to read as a relaxed turn, not a strike. */
export const WRENCH_PERIOD_SECONDS = 2.5;

/** The wrench's rotation at `seconds` of a running task: a calm sine turn. */
export const wrenchSwing = (seconds: number): number =>
  WRENCH_AMPLITUDE * Math.sin((2 * Math.PI * seconds) / WRENCH_PERIOD_SECONDS);

/** The wrench is in hand only while a working robot stands at its box. */
export const wrenchVisible = (pose: RobotPose, moving: boolean): boolean => pose === 'work' && !moving;
