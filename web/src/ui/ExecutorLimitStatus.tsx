import { useEffect, useState } from 'react';
import type { ExecutorProfile } from '../lib/serverApi';

function duration(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes % 60}m`].filter(Boolean).join(' ');
}

export function ExecutorLimitStatus({ executor }: { executor: ExecutorProfile }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(timer);
  }, []);
  const limits = executor.limits;
  const provider = executor.kind === 'codex-cli' ? 'Codex' : 'Claude';
  if (!limits) return <span className="text-xs text-muted-foreground">5h / 7d · waiting for {provider} usage</span>;
  const stale = now - limits.observedAt > 300;
  return <span className="flex flex-col gap-0.5 tabular-nums text-xs" title={`Last updated ${new Date(limits.observedAt * 1000).toLocaleString()}. Usage refreshes every five minutes.`}>
    {([['5h', limits.fiveHour], ['7d', limits.sevenDay]] as const).map(([label, window]) => {
      const expired = window?.resetsAt != null && window.resetsAt <= now;
      const reset = window?.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' IST' : '';
      return <span key={label} className="text-muted-foreground" title={reset ? `Resets ${reset}` : undefined}>
        <strong className="font-medium text-foreground">{label}</strong> {window ? expired ? 'awaiting refresh' : `${Math.round(window.usedPercentage)}% used` : 'unavailable'}
        {window?.resetsAt && !expired ? ` · resets in ${duration(window.resetsAt - now)}` : ''}
      </span>;
    })}
    {stale && <span className="text-xs text-muted-foreground">Last updated {duration(now - limits.observedAt)} ago</span>}
  </span>;
}
