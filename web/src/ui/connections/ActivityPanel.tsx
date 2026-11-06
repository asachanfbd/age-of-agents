import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ACTIVITY_RESULTS, activityRangeProblem, activityRow } from '../../lib/connections';
import type { ActivityFilters, ActivityResult } from '../../lib/connections';
import { isBuildingReadOnly } from '../../lib/buildingTypes';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';

const SELECT_CLASS = 'h-9 w-full rounded-md border border-border bg-card px-2 text-sm';
const TONE_VARIANT = { ok: 'success', bad: 'destructive', warn: 'warning', neutral: 'secondary' } as const;
const RESULT_NAMES: Record<ActivityResult, string> = {
  ok: 'Done', error: 'Failed', refused: 'Refused', 'awaiting-approval': 'Waiting for approval', 'changes-requested': 'Changes requested', stopped: 'Stopped', 'rate-limited': 'Rate limited',
};

/** The Activity log of one Building: every call and event it took part in, newest first, with filters and the approve / request changes / stop actions of a call that is waiting. */
export function ActivityPanel({ project }: { project: ProjectData }) {
  const entries = useWorldStore((s) => s.activityByProject[project.id]);
  const links = useWorldStore((s) => s.linksByProject[project.id]);
  const loadActivity = useWorldStore((s) => s.loadActivity);
  const loadLinks = useWorldStore((s) => s.loadLinks);
  const decide = useWorldStore((s) => s.decideCapabilityCall);
  const [filters, setFilters] = useState<ActivityFilters>({});
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const readOnly = isBuildingReadOnly(project);
  const rangeProblem = activityRangeProblem(filters);

  useEffect(() => { void loadActivity(project.id); void loadLinks(project.id); }, [project.id, loadActivity, loadLinks]);

  const apply = async (next: ActivityFilters) => {
    setFilters(next);
    const result = await loadActivity(project.id, next);
    setError(result.ok ? null : result.error);
  };
  const callers = [...(links?.outgoing ?? []).map((l) => [l.toBuildingId, l.toName] as const), ...(links?.incoming ?? []).map((l) => [l.fromBuildingId, l.fromName] as const)];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label="Activity log">
      <h3 className="text-base font-semibold tracking-tight">Activity</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">Every call and event this Building took part in.</p>
      <form className="mt-4 grid gap-3 sm:grid-cols-5" aria-label="Activity filters" onSubmit={(e) => { e.preventDefault(); void apply(filters); }}>
        <label className="flex flex-col gap-1 text-xs font-medium">Building
          <select className={SELECT_CLASS} value={filters.caller ?? ''} onChange={(e) => setFilters({ ...filters, caller: e.target.value })}>
            <option value="">Any</option>
            <option value={project.id}>{project.name}</option>
            {callers.map(([id, name]) => <option key={id} value={id}>{name ?? 'Building deleted'}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">Capability or event
          <Input value={filters.capability ?? ''} onChange={(e) => setFilters({ ...filters, capability: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">Result
          <select className={SELECT_CLASS} value={filters.result ?? ''} onChange={(e) => setFilters({ ...filters, result: e.target.value as ActivityResult | '' })}>
            <option value="">Any</option>
            {ACTIVITY_RESULTS.map((r) => <option key={r} value={r}>{RESULT_NAMES[r]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">From
          <Input type="datetime-local" value={filters.from ?? ''} aria-invalid={Boolean(rangeProblem)} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">To
          <Input type="datetime-local" value={filters.to ?? ''} aria-invalid={Boolean(rangeProblem)} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </label>
        <div className="flex items-center gap-2 sm:col-span-5">
          <Button type="submit" size="sm" disabled={Boolean(rangeProblem)}>Apply filters</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void apply({})}>Clear</Button>
          {(rangeProblem || error) && <p className="text-xs text-destructive" role="alert">{rangeProblem ?? error}</p>}
        </div>
      </form>

      {!entries ? <p className="mt-6 text-sm text-muted-foreground">Loading activity...</p> : entries.length === 0 ? <p className="mt-6 text-sm text-muted-foreground">Nothing yet.</p> : (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Activity entries">
          {entries.map((entry) => {
            const row = activityRow(entry);
            const open = openId === entry.id;
            return (
              <li key={entry.id} className="rounded-lg border bg-card px-3 py-2.5">
                <button type="button" className="flex w-full flex-wrap items-center gap-3 text-left" aria-expanded={open} onClick={() => setOpenId(open ? null : entry.id)}>
                  <span className="w-40 shrink-0 text-xs text-muted-foreground">{new Date(row.time).toLocaleString()}</span>
                  <span className="min-w-0 flex-1 truncate text-sm"><span className="font-medium">{row.what}</span> · {row.caller} → {row.target}</span>
                  <Badge variant={TONE_VARIANT[row.tone]}>{row.resultLabel}</Badge>
                </button>
                {open && (
                  <div className="mt-2 flex flex-col gap-1 border-t pt-2 text-xs text-muted-foreground">
                    <p>Inputs: <code>{row.summary}</code>{entry.inputsShortened && ' (shortened)'}</p>
                    {row.message && <p>{row.message}</p>}
                    {row.runRef && <p>Run: <code>{row.runRef}</code></p>}
                    {entry.result === 'awaiting-approval' && (
                      <div className="flex gap-2 pt-1">
                        {(['approve', 'request-changes', 'stop'] as const).map((decision) => (
                          <Button key={decision} type="button" size="sm" variant={decision === 'approve' ? 'default' : 'outline'} disabled={readOnly} onClick={async () => { const r = await decide(project.id, entry.id, decision); setError(r.ok ? null : r.error); }}>
                            {decision === 'approve' ? 'Approve' : decision === 'stop' ? 'Stop' : 'Request changes'}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
