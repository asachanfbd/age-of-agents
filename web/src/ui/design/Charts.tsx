import { useState } from 'react';
import { accentVar } from '../../lib/accent';
import { areaPath, axisTicks, barLayout, groupAt, linePoints, niceMax, smoothPath } from '../../lib/chartData';
import type { BarGroup, BarSeries } from '../../lib/chartData';
import { metricText } from '../../lib/crmReports';

const PLOT = { width: 560, height: 180 };
const PAD = { left: 36, top: 8, bottom: 28 };

/** Series legend chips. */
export function Legend({ series }: { series: readonly BarSeries[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0 text-xs">
      {series.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1.5 rounded-control bg-secondary px-2.5 py-1">
          <span aria-hidden className="size-2.5 rounded-full" style={{ background: accentVar(s.accent) }} />{s.label}
        </li>
      ))}
    </ul>
  );
}

const PLOT_BOX = { width: PLOT.width + PAD.left, height: PLOT.height + PAD.top + PAD.bottom };

/** The frame both charts share: legend, axis, hover tooltip card and the hidden table for screen readers. `draw` paints the marks inside the plot. */
function ChartFrame({ label, groups, series, max, groupWidth, draw }: { label: string; groups: readonly BarGroup[]; series: readonly BarSeries[]; max: number; groupWidth: number; draw: (active: number | null) => React.ReactNode }) {
  const [active, setActive] = useState<number | null>(null);
  const ticks = axisTicks(max);
  const tipLeft = active === null ? 0 : ((PAD.left + active * groupWidth + groupWidth / 2) / PLOT_BOX.width) * 100;
  return (
    <figure className="relative m-0 grid gap-3" aria-label={label}>
      <Legend series={series} />
      <div className="relative">
        <svg viewBox={`0 0 ${PLOT_BOX.width} ${PLOT_BOX.height}`} role="img" aria-label={label} className="w-full"
          onMouseMove={(event) => { const box = event.currentTarget.getBoundingClientRect(); const x = ((event.clientX - box.left) / box.width) * PLOT_BOX.width - PAD.left; setActive(groupAt(x, groupWidth, groups.length)); }}
          onMouseLeave={() => setActive(null)}>
          <g transform={`translate(${PAD.left} ${PAD.top})`}>
            {ticks.map((tick) => {
              const y = PLOT.height - (tick / max) * PLOT.height;
              return <g key={tick}><line x1={0} x2={PLOT.width} y1={y} y2={y} className="stroke-border" strokeWidth={1} /><text x={-8} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">{Math.round(tick)}</text></g>;
            })}
            {draw(active)}
            {groups.map((group, i) => <text key={group.label} x={i * groupWidth + groupWidth / 2} y={PLOT.height + 18} textAnchor="middle" className="fill-muted-foreground text-[11px]">{group.label.length > 14 ? `${group.label.slice(0, 13)}…` : group.label}</text>)}
          </g>
        </svg>
        {active !== null && groups[active] && (
          <div role="status" className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-2xl bg-toast px-4 py-3 text-sm text-toast-foreground shadow-lift" style={{ left: `${Math.min(85, Math.max(15, tipLeft))}%` }}>
            <div className="mb-1 text-xs opacity-75">{groups[active]!.label}</div>
            {series.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2"><span aria-hidden className="size-2 rounded-full" style={{ background: accentVar(s.accent) }} />{s.label}: <b className="tabular-nums">{metricText(groups[active]!.values[i] ?? null)}</b></div>
            ))}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead><tr><th scope="col">Group</th>{series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}</tr></thead>
        <tbody>{groups.map((g) => <tr key={g.label}><th scope="row">{g.label}</th>{g.values.map((v, i) => <td key={series[i]?.key ?? i}>{metricText(v)}</td>)}</tr>)}</tbody>
      </table>
    </figure>
  );
}

/**
 * Rounded grouped bars from theme colours, with a tooltip card on hover. A null value draws no bar and reads "no data".
 */
export function BarChart({ label, groups, series }: { label: string; groups: readonly BarGroup[]; series: readonly BarSeries[] }) {
  const { rects, groupWidth, max } = barLayout(groups, series.length, PLOT);
  return (
    <ChartFrame label={label} groups={groups} series={series} max={max} groupWidth={groupWidth} draw={(active) => rects.map((rect) => {
      const s = series[rect.series]!;
      return <rect key={`${rect.group}-${rect.series}`} x={rect.x} y={rect.y} width={rect.width} height={Math.max(rect.height, 0)} rx={Math.min(8, rect.width / 2)} fill={accentVar(s.accent)} fillOpacity={s.dashed ? 0.35 : 1} stroke={s.dashed ? accentVar(s.accent) : 'none'} strokeDasharray={s.dashed ? '4 3' : undefined} strokeWidth={s.dashed ? 1.5 : 0} opacity={active === null || active === rect.group ? 1 : 0.45} />;
    })} />
  );
}

/**
 * Smooth lines with a light area fill under the solid series; a series marked `dashed` is the comparison and is drawn dashed.
 * A null value leaves a gap, and a run of one point is drawn as a dot.
 */
export function LineChart({ label, groups, series }: { label: string; groups: readonly BarGroup[]; series: readonly BarSeries[] }) {
  const max = niceMax(groups.flatMap((g) => g.values));
  const groupWidth = groups.length === 0 ? 0 : PLOT.width / groups.length;
  return (
    <ChartFrame label={label} groups={groups} series={series} max={max} groupWidth={groupWidth} draw={(active) => (
      <>
        {active !== null && <line x1={active * groupWidth + groupWidth / 2} x2={active * groupWidth + groupWidth / 2} y1={0} y2={PLOT.height} className="stroke-border" strokeWidth={1.5} />}
        {series.map((s, i) => linePoints(groups, i, PLOT, max).map((run, r) => (
          <g key={`${s.key}-${r}`} style={{ color: accentVar(s.accent) }}>
            {!s.dashed && run.length > 1 && <path d={areaPath(run, PLOT.height)} fill="currentColor" fillOpacity={0.12} />}
            {run.length > 1 && <path d={smoothPath(run)} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={s.dashed ? '6 5' : undefined} />}
            {run.map((p) => <circle key={p.x} cx={p.x} cy={p.y} r={run.length === 1 || active === Math.round((p.x - groupWidth / 2) / groupWidth) ? 5 : 3} fill="currentColor" />)}
          </g>
        )))}
      </>
    )} />
  );
}
