import type { CSSProperties } from 'react';
import type { StatusStyle } from '../lib/buildingVisualStatus';

/**
 * The coloured (and, for anything but idle, glowing) status dot for a project. The glow colour is
 * passed as `--dot-glow` so each view's CSS can size the halo (see `.building-status-dot`).
 */
export function ProjectStatusDot({ style, label }: { style: StatusStyle; label: string }) {
  return (
    <span
      className="building-status-dot"
      role="img"
      aria-label={label}
      title={label}
      style={{
        backgroundColor: style.dotColor,
        '--dot-glow': style.glowing ? style.dotGlowColor : 'transparent',
      } as CSSProperties}
    />
  );
}
