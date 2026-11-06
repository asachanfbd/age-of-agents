import { useMemo, useState } from 'react';
import { activityAction, activityAriaLabel, activityBand, activityDetails, assignLanes, bandCaption, bandStyle } from '../../lib/agentAnalytics';
import type { ActivityView, AgentDayView } from '../../lib/serverApi';

const LANE_HEIGHT = 18;
const LANE_GAP = 4;
const HOVER_BOX_WIDTH = 330;

/**
 * Tracked activity under the chart, on the chart's own time axis. Sessions running at the same time
 * get separate lanes. Each band is a button: hovering or focusing it shows its details in a hover
 * box, and selecting it opens the task. The filled parts are working time; the dashed outline around
 * them is the whole session, waiting included.
 */
export function ActivityLanes({ view, width, onOpenTarget }: { view: AgentDayView; width: number; onOpenTarget: (activity: ActivityView) => void }) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const lanes = useMemo(() => assignLanes(view.activities, view.now), [view.activities, view.now]);
  const laneCount = Math.max(1, ...[...lanes.values()].map((lane) => lane + 1));
  const top = (activity: ActivityView) => lanes.get(activity.id)! * (LANE_HEIGHT + LANE_GAP);
  const hovered = view.activities.find((activity) => activity.id === hoveredId);
  const hoveredBand = hovered ? activityBand(hovered, view.range, view.now, width) : null;

  return (
    <section aria-label="Tracked activity">
      <h4 className="mb-1 mt-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Activity</h4>
      {view.activities.length === 0 && <p className="text-xs italic text-muted-foreground">No tracked activity on this day.</p>}
      <div className="relative border-l border-border" style={{ height: laneCount * (LANE_HEIGHT + LANE_GAP) }}>
        {view.activities.map((activity) => {
          // Bands are placed once the shared plot width is known.
          const band = width > 0 ? activityBand(activity, view.range, view.now, width) : null;
          if (!band) return null;
          const style = bandStyle(activity);
          const openable = activity.target !== null;
          return (
            <button
              key={activity.id}
              type="button"
              data-analytics-band
              aria-label={activityAriaLabel(activity)}
              aria-disabled={!openable}
              className={`absolute overflow-hidden rounded-[3px] border border-dashed border-muted-foreground/70 text-left text-[11px] leading-[16px] text-foreground outline-none hover:z-[1] hover:ring-2 hover:ring-foreground focus-visible:z-[1] focus-visible:ring-2 focus-visible:ring-foreground ${openable ? 'cursor-pointer' : 'cursor-default'}`}
              style={{ left: band.x, width: Math.max(5, band.width), top: top(activity), height: LANE_HEIGHT, ['--band-color' as string]: `var(${style.colorVar})` }}
              onClick={() => { if (openable) onOpenTarget(activity); }}
              onPointerEnter={() => setHoveredId(activity.id)}
              onPointerLeave={() => setHoveredId(null)}
              onFocus={() => setHoveredId(activity.id)}
              onBlur={() => setHoveredId(null)}
            >
              {band.parts.filter((part) => part.state === 'active').map((part) => (
                <i
                  key={part.x}
                  aria-hidden="true"
                  data-texture={style.texture}
                  className={`analytics-band-part absolute inset-y-0 border-l-[3px] ${style.approximate ? 'border-dashed opacity-70' : 'border-solid'}`}
                  style={{ left: part.x - band.x, width: Math.max(3, part.width), borderLeftColor: `var(${style.colorVar})` }}
                />
              ))}
              <span aria-hidden="true" className="relative whitespace-nowrap px-1">
                {band.clippedStart && '‹ '}{bandCaption(activity)}{band.clippedEnd && ' ›'}{band.live && ' …'}
              </span>
            </button>
          );
        })}
        {hovered && hoveredBand && (
          <div
            aria-hidden="true"
            data-analytics-hover-box
            className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-2.5 py-2 text-xs shadow-lg"
            // Below the band, so the box never covers the band it describes.
            style={{ left: Math.max(0, Math.min(hoveredBand.x, width - HOVER_BOX_WIDTH)), top: top(hovered) + LANE_HEIGHT + 6, width: HOVER_BOX_WIDTH, maxWidth: '90%' }}
          >
            <dl className="grid grid-cols-[max-content_1fr] gap-x-2.5 gap-y-px">
              {activityDetails(hovered).map(({ label, value }) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="m-0">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1.5 border-t border-border pt-1 text-muted-foreground">{activityAction(hovered)}</p>
          </div>
        )}
      </div>
    </section>
  );
}
