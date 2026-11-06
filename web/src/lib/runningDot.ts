export type RunningDotTone = 'running' | 'minimized';

export interface RunningDotLook {
  className: string;
  style: { boxShadow: string };
}

// The dot's `info` colour at 60% opacity.
const RUNNING_GLOW = 'color-mix(in srgb, var(--sc-info) 60%, transparent)';

/**
 * How a command's "still running" dot looks. A running command gets a solid blue dot with a
 * glow; a run in this task's working copy whose log is minimized gets a hollow blue ring with no
 * glow, so the two Quick look states stay distinct. The glow is a static box-shadow because
 * looping animations (pulse/ping) are banned for GPU cost — see `gpuFriendlyUi.test.mjs`.
 */
export function runningDotLook(tone: RunningDotTone): RunningDotLook {
  const base = 'inline-block size-2 shrink-0 rounded-full';
  if (tone === 'minimized') {
    return { className: `${base} border-2 border-info bg-transparent`, style: { boxShadow: 'none' } };
  }
  return { className: `${base} bg-info`, style: { boxShadow: `0 0 6px 2px ${RUNNING_GLOW}` } };
}
