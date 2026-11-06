import { House } from 'lucide-react';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { STATUS_FOOTER_HEIGHT } from '../lib/statusFooter';
import type { GroundPoint } from '../scene/cameraMath';
import {
  HOME_MARKER, MINIMAP_VIEWBOX, minimapKey, minimapToWorld, pressEnd, pressMove, pressStart, worldToMinimap,
  type MinimapDot, type MinimapPoint, type MinimapPress,
} from '../scene/minimapMath';
import { ROADS } from '../scene/scenery';

/** Gap between the card and the status footer below it. */
const FOOTER_GAP = 16;
const HOME_MARKER_SIZE = 7;

/** Each road (every street and the cross road) as a line along its middle, in viewBox units. */
const STREETS = ROADS.map(([x0, z0, x1, z1]) => {
  const across = x1 - x0 < z1 - z0;
  const from = worldToMinimap(across ? { x: (x0 + x1) / 2, z: z0 } : { x: x0, z: (z0 + z1) / 2 }, MINIMAP_VIEWBOX);
  const to = worldToMinimap(across ? { x: (x0 + x1) / 2, z: z1 } : { x: x1, z: (z0 + z1) / 2 }, MINIMAP_VIEWBOX);
  return { from, to };
});

export interface VillageNavigationCardProps {
  /** A Project is being dragged: Home and the minimap are paused. */
  disabled: boolean;
  dots: readonly MinimapDot[];
  /** The camera's ground footprint (near-left, near-right, far-right, far-left), in viewBox units. */
  footprint: readonly MinimapPoint[];
  /** The camera target, in viewBox units. */
  target: MinimapPoint;
  onHome: () => void;
  /** A minimap click asks to `fly` to `point`; a drag asks the camera to `follow` it. */
  onPick: (point: GroundPoint, mode: 'fly' | 'follow') => void;
  /** An arrow key on the focused minimap; returns whether it was handled. */
  onKey: (key: string) => boolean;
}

/**
 * The 3D village's bottom-left navigation card: the Home button and a north-up minimap of the whole
 * town. Props only, so it renders to static markup in tests; `VillageNavigation` wires it to the camera.
 */
export function VillageNavigationCard({ disabled, dots, footprint, target, onHome, onPick, onKey }: VillageNavigationCardProps) {
  const press = useRef<MinimapPress | null>(null);

  const pointOf = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return minimapToWorld(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
  };

  const handlePointerDown = (e: PointerEvent<SVGSVGElement>) => {
    press.current = pressStart({ x: e.clientX, y: e.clientY }, e.button, disabled);
    if (press.current) e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const next = pressMove(press.current, { x: e.clientX, y: e.clientY }, disabled);
    press.current = next.press;
    const point = next.action ? pointOf(e) : null;
    if (point) onPick(point, 'follow');
  };

  const handlePointerEnd = (e: PointerEvent<SVGSVGElement>) => {
    const action = pressEnd(press.current, disabled, e.type === 'pointercancel');
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const point = action ? pointOf(e) : null;
    if (point) onPick(point, 'fly');
  };

  const handleKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (minimapKey(e.key, disabled, onKey)) e.preventDefault();
  };

  return (
    <section
      aria-label="Village navigation"
      className="absolute left-6 z-10 grid gap-1.5 rounded-[14px] border border-border bg-background/90 p-2 shadow-md max-sm:left-3"
      style={{ bottom: STATUS_FOOTER_HEIGHT + FOOTER_GAP }}
    >
      <div className="flex items-center justify-between pl-0.5">
        <span className="text-xs font-semibold text-muted-foreground">Map</span>
        <button
          type="button"
          onClick={onHome}
          disabled={disabled}
          title="Return to the home view"
          aria-label="Return to the home view"
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-semibold text-foreground hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-border disabled:hover:text-foreground"
        >
          <House aria-hidden="true" className="size-3.5" />
          <span className="max-sm:hidden">Home</span>
        </button>
      </div>
      <svg
        role="application"
        tabIndex={0}
        aria-label="Village minimap. Click or drag to move the camera; arrow keys pan."
        aria-disabled={disabled}
        viewBox={`0 0 ${MINIMAP_VIEWBOX} ${MINIMAP_VIEWBOX}`}
        className={`minimap block size-[200px] touch-none overflow-hidden rounded-[10px] border border-border focus-visible:outline-2 focus-visible:outline-ring max-sm:size-[140px] ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-crosshair'}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onKeyDown={handleKeyDown}
      >
        {STREETS.map(({ from, to }) => (
          <line key={`${from.x}:${from.y}:${to.x}:${to.y}`} className="minimap__street" strokeWidth={2.4} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
        ))}
        <polygon
          points={footprint.map((point) => `${point.x},${point.y}`).join(' ')}
          className="minimap__footprint"
          strokeWidth={0.9}
          strokeLinejoin="round"
        />
        <rect
          x={HOME_MARKER.x - HOME_MARKER_SIZE / 2}
          y={HOME_MARKER.y - HOME_MARKER_SIZE / 2}
          width={HOME_MARKER_SIZE}
          height={HOME_MARKER_SIZE}
          rx={1}
          className="minimap__home"
        >
          <title>Home</title>
        </rect>
        {dots.map((dot) => (
          <circle key={dot.id} cx={dot.x} cy={dot.y} r={2.6} fill={dot.color} className="minimap__dot" strokeWidth={0.6}>
            <title>{dot.name}</title>
          </circle>
        ))}
        <circle cx={target.x} cy={target.y} r={1.3} className="minimap__target" />
        <text x={MINIMAP_VIEWBOX - 6} y={9} textAnchor="middle" fontSize={7} fontWeight={700} className="minimap__north" aria-hidden="true">N</text>
      </svg>
    </section>
  );
}
