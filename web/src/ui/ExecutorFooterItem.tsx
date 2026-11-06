import { useEffect, useState } from 'react';
import { defaultDotModel } from '../lib/executorAvailability';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ANALYTICS_TRIGGER_ATTRIBUTE } from '../lib/agentAnalytics';
import { agentBarsLabel, limitBar } from '../lib/limitBars';
import type { LimitBar } from '../lib/limitBars';
import type { ExecutorProfile } from '../lib/serverApi';
import { useWorldStore } from '../store/worldStore';
import { ExecutorLimitStatus } from './ExecutorLimitStatus';

const LEVEL_FILL: Record<LimitBar['level'], string> = {
  green: 'bg-success',
  orange: 'bg-warning',
  red: 'bg-destructive',
  unknown: '',
};

/** One thin limit bar: the filled part is what is left, and an unknown limit is an empty track. Decorative: the button's name carries the values. */
function LimitTrack({ bar }: { bar: LimitBar }) {
  return (
    <span aria-hidden="true" className="block h-1 w-full overflow-hidden rounded-full bg-muted-foreground/25">
      {bar.remaining !== null && <span className={`block h-full rounded-full ${LEVEL_FILL[bar.level]}`} style={{ width: `${bar.remaining}%` }} />}
    </span>
  );
}

/**
 * The agent's name over two thin bars (5-hour limit above, 7-day below) showing how much of each limit is
 * left; hovering or focusing it reveals the full usage view, and selecting it opens that agent's Analytics.
 */
export function ExecutorFooterItem({ executor }: { executor: ExecutorProfile }) {
  const openAnalytics = useWorldStore((s) => s.openAnalytics);
  const setDefaultExecutor = useWorldStore((s) => s.setDefaultExecutor);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(timer);
  }, []);
  const fiveHour = limitBar(executor.limits?.fiveHour, now);
  const sevenDay = limitBar(executor.limits?.sevenDay, now);
  const dot = defaultDotModel(executor, now);
  return (
    <div className="flex items-start gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            role="radio"
            aria-checked={dot.selected}
            aria-disabled={dot.disabled}
            aria-label={dot.label}
            className="mt-px flex size-4 flex-none cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => { if (!dot.disabled && !dot.selected) void setDefaultExecutor(executor.id, { notify: true }); }}
          >
            <span aria-hidden="true" className={`block size-2.5 rounded-full border ${dot.selected ? 'border-primary bg-primary' : 'border-muted-foreground'}`} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="px-2 py-1 text-[11px]">{dot.tooltip}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...{ [ANALYTICS_TRIGGER_ATTRIBUTE]: executor.id }}
            aria-label={agentBarsLabel(executor.label, fiveHour, sevenDay)}
            className="flex min-w-16 cursor-pointer flex-col gap-0.5 whitespace-nowrap rounded-sm px-1 text-left text-[11px] font-semibold text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => openAnalytics(executor.id)}
          >
            <span>{executor.label}</span>
            <span className="flex flex-col gap-0.5"><LimitTrack bar={fiveHour} /><LimitTrack bar={sevenDay} /></span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="flex flex-col gap-0.5 rounded-xl px-3 py-2 text-[11px]">
          <span className="font-semibold tabular-nums">{executor.label} · {executor.usage.taskCount} sessions</span>
          {dot.selected && <span className="text-xs text-muted-foreground">Default coding agent</span>}
          <ExecutorLimitStatus executor={executor} />
          <span className="text-xs text-muted-foreground">Select to open analytics</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
