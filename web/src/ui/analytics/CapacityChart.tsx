import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import {
  formatClock, formatPercent, gapText, linePaths, nowMarkerX, QUOTA_WINDOWS, READING_KEYS, readingAnnouncement, remainingToY, stepReadingIndex, timeToX, WINDOW_LABEL,
  type TimeRange,
} from '../../lib/agentAnalytics';
import type { AgentDayView, QuotaWindowKey, SeriesPoint } from '../../lib/serverApi';
import { ActivityLanes } from './ActivityLanes';

const PLOT_HEIGHT = 220;
const Y_TICKS = [100, 75, 50, 25, 0];
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const SERIES_COLOR: Record<QuotaWindowKey, string> = { fiveHour: 'var(--analytics-5h)', sevenDay: 'var(--analytics-7d)' };
/** The 7d line is dashed so the two series differ by more than colour. */
const SERIES_DASH: Record<QuotaWindowKey, string | undefined> = { fiveHour: undefined, sevenDay: '6 4' };
/** Each window's gaps and unattributed drops sit in that window's own strip at the top of the plot, so one window's never hide the other's. */
const STRIP_HEIGHT = 16;
const STRIP_TOP: Record<QuotaWindowKey, number> = { fiveHour: 0, sevenDay: STRIP_HEIGHT };

/** Tracks an element's rendered width, so the plot and the lanes share one time scale. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function pointAt(points: SeriesPoint[], at: number): SeriesPoint | undefined {
  return points.find((point) => point.at === at);
}

/**
 * The day's remaining-capacity chart with the activity lanes under it on the same time axis. The plot
 * is one focusable element: arrow keys, Page Up/Down, Home and End step through the readings, and the
 * reading in focus is shown in a hover box and announced. Pointer hover shows the same box.
 */
export function CapacityChart({ view, hidden, onOpenTarget }: { view: AgentDayView; hidden: Record<QuotaWindowKey, boolean>; onOpenTarget: (activity: AgentDayView['activities'][number]) => void }) {
  const [plotRef, width] = useWidth<HTMLDivElement>();
  const [focusIndex, setFocusIndex] = useState(-1);
  const range: TimeRange = view.range;
  const shown = QUOTA_WINDOWS.filter((window) => !hidden[window]);
  const lines = useMemo(
    () => Object.fromEntries(QUOTA_WINDOWS.map((window) => [window, linePaths(view.series[window], range, width, PLOT_HEIGHT, view.now)])) as Record<QuotaWindowKey, ReturnType<typeof linePaths>>,
    [view, range, width],
  );
  /** Every reading time on the day, across the series shown: what the keyboard and the pointer step through. */
  const times = useMemo(
    () => [...new Set(shown.flatMap((window) => lines[window].points.map(({ point }) => point.at)))].sort((a, b) => a - b),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, hidden.fiveHour, hidden.sevenDay],
  );
  const focusedAt = times[focusIndex];
  const nowX = nowMarkerX(view.now, range, width);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!READING_KEYS.includes(event.key)) return;
    event.preventDefault();
    setFocusIndex(stepReadingIndex(focusIndex, event.key, times.length));
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!times.length || !width) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const nearest = times.reduce((best, at, index) => Math.abs(timeToX(at, range, width) - x) < Math.abs(timeToX(times[best]!, range, width) - x) ? index : best, 0);
    setFocusIndex(nearest);
  }

  // Nothing is placed until the plot has been measured: at zero width every mark would pile up at the left edge.
  const measured = width > 0;
  const focused = focusedAt === undefined ? [] : shown.flatMap((window) => {
    const point = pointAt(view.series[window].points, focusedAt);
    return point ? [{ window, point }] : [];
  });
  const focusX = focusedAt === undefined ? 0 : timeToX(focusedAt, range, width);

  return (
    <div className="relative pl-10">
      {Y_TICKS.map((tick) => (
        <span key={tick} aria-hidden="true" className="absolute left-0 w-8 -translate-y-1/2 text-right text-[10px] tabular-nums text-muted-foreground" style={{ top: remainingToY(tick, PLOT_HEIGHT) }}>{tick}%</span>
      ))}
      <div
        ref={plotRef}
        data-analytics-plot
        tabIndex={0}
        role="group"
        aria-label="Remaining capacity through the day. Use the arrow keys, Page Up, Page Down, Home and End to step through the readings."
        className="relative cursor-crosshair border-b border-l border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ height: PLOT_HEIGHT }}
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setFocusIndex(-1)}
        onBlur={() => setFocusIndex(-1)}
      >
        <svg aria-hidden="true" className="absolute inset-0 h-full w-full" viewBox={`0 0 ${Math.max(width, 1)} ${PLOT_HEIGHT}`} preserveAspectRatio="none">
          {Y_TICKS.slice(0, -1).map((tick) => (
            <line key={tick} x1={0} x2={width} y1={remainingToY(tick, PLOT_HEIGHT)} y2={remainingToY(tick, PLOT_HEIGHT)} stroke="var(--color-border)" strokeWidth={1} opacity={0.6} />
          ))}
          {measured && shown.map((window) => (
            <g key={window} stroke={SERIES_COLOR[window]} fill={SERIES_COLOR[window]}>
              {lines[window].paths.map((path) => <path key={path} d={path} fill="none" strokeWidth={2} strokeDasharray={SERIES_DASH[window]} strokeLinejoin="round" />)}
              {/* Every reading is its own point, so a single reading still shows without a line. */}
              {lines[window].points.map(({ x, y, point }) => <circle key={point.at} cx={x} cy={y} r={lines[window].points.length > 60 ? 1.5 : 2.5} stroke="none" />)}
              {view.series[window].resets.map((reset) => (
                <line key={reset.at} x1={timeToX(reset.at, range, width)} x2={timeToX(reset.at, range, width)} y1={0} y2={PLOT_HEIGHT} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
              ))}
            </g>
          ))}
        </svg>
        {measured && shown.flatMap((window) => view.series[window].gaps.map((gap) => {
          const left = Math.max(0, timeToX(gap.from, range, width));
          const right = Math.min(width, timeToX(gap.to, range, width));
          return (
            <div key={`${window}-${gap.from}`} aria-hidden="true" className="analytics-hatch absolute overflow-hidden whitespace-nowrap px-0.5 text-[10px] leading-4 text-muted-foreground" style={{ left, width: Math.max(0, right - left), top: STRIP_TOP[window], height: STRIP_HEIGHT }}>
              {WINDOW_LABEL[window]}: {gapText(gap.reason)}
            </div>
          );
        }))}
        {measured && shown.flatMap((window) => view.series[window].resets.map((reset) => (
          <span key={`${window}-reset-${reset.at}`} aria-hidden="true" className="absolute bottom-0.5 text-[10px] text-muted-foreground" style={{ left: timeToX(reset.at, range, width) + 3 }}>{WINDOW_LABEL[window]} reset</span>
        )))}
        {measured && view.unattributed.filter((drop) => !hidden[drop.window]).map((drop) => (
          <div key={`${drop.window}-${drop.from}`} aria-hidden="true" className="absolute overflow-hidden whitespace-nowrap rounded-sm border border-dashed border-muted-foreground bg-card px-0.5 text-[10px] leading-[14px] text-muted-foreground" style={{ left: timeToX(drop.from, range, width), width: Math.max(4, timeToX(drop.to, range, width) - timeToX(drop.from, range, width)), top: STRIP_TOP[drop.window], height: STRIP_HEIGHT }}>
            {WINDOW_LABEL[drop.window]}: Unattributed activity
          </div>
        ))}
        {measured && nowX !== null && (
          <div aria-hidden="true" className="absolute inset-y-0 right-0 border-l border-muted-foreground bg-muted/60 px-1 text-[10px] text-muted-foreground" style={{ left: nowX }}>Now</div>
        )}
        {shown.map((window) => {
          const last = lines[window].points.at(-1);
          return measured && last && (
            <span key={window} aria-hidden="true" className="absolute -translate-y-1/2 whitespace-nowrap rounded-sm bg-card px-1 text-[11px] font-semibold tabular-nums" style={{ left: Math.min(Math.max(0, width - 70), last.x + 6), top: last.y, color: SERIES_COLOR[window] }}>
              {WINDOW_LABEL[window]} {formatPercent(last.point.remaining)}
            </span>
          );
        })}
        {measured && focused.length > 0 && (
          <>
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-foreground/50" style={{ left: focusX }} />
            <div aria-hidden="true" className="pointer-events-none absolute top-14 z-10 whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-2 text-xs shadow-lg" style={focusX > width / 2 ? { right: width - focusX + 8 } : { left: focusX + 8 }}>
              <b className="mb-0.5 block">{formatClock(focusedAt!)}</b>
              {focused.map(({ window, point }) => <div key={window}>{readingAnnouncement(window, point)}</div>)}
            </div>
          </>
        )}
        <p aria-live="polite" className="sr-only">{focused.map(({ window, point }) => readingAnnouncement(window, point)).join('. ')}</p>
      </div>
      <div aria-hidden="true" className="relative mt-1 h-4">
        {HOUR_TICKS.map((hour) => (
          <span key={hour} className={`absolute whitespace-nowrap text-[10px] text-muted-foreground ${hour === 0 ? '' : hour === 24 ? '-translate-x-full' : '-translate-x-1/2'}`} style={{ left: `${hour / 24 * 100}%` }}>{String(hour).padStart(2, '0')}:00</span>
        ))}
      </div>
      <ActivityLanes view={view} width={width} onOpenTarget={onOpenTarget} />
    </div>
  );
}
