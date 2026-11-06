import { runningDotLook, type RunningDotTone } from '../../../lib/runningDot';

/**
 * The small dot on a command that's running: a glowing blue dot while it runs anywhere, a hollow
 * blue ring for a run in this task's working copy whose log is minimized (a task's Commands menu).
 */
export function RunningDot({ tone = 'running', label }: { tone?: RunningDotTone; label: string }) {
  const { className, style } = runningDotLook(tone);
  return <span role="img" aria-label={label} title={label} className={className} style={style} />;
}
