import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { serverApi } from '../lib/serverApi';
import { canRunNow, CRON_PRESETS, GROUP_LABEL, GROUP_TONE, scheduleError, triggerLabel } from '../lib/seoTasks';
import type { ScheduleDto } from '../lib/seoTasks';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');
const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

function NewScheduleDialog({ projectId, actions, onClose, onSaved }: { projectId: string; actions: Array<{ id: string; label: string }>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [actionId, setActionId] = useState(actions[0]?.id ?? '');
  const [cron, setCron] = useState<string>(CRON_PRESETS[0].cron);
  const [runs, setRuns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    serverApi.seoCronPreview(projectId, cron).then((p) => { if (current) { setRuns(p.runs); setError(null); } }).catch((e) => { if (current) { setRuns([]); setError(errorText(e)); } });
    return () => { current = false; };
  }, [projectId, cron]);
  const save = async () => {
    const problem = scheduleError(name, actionId, cron);
    if (problem) { setError(problem); return; }
    try { await serverApi.seoCreateSchedule(projectId, { name: name.trim(), actionId, cron: cron.trim() }); onSaved(); onClose(); } catch (e) { setError(errorText(e)); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-label="New schedule">
        <DialogHeader><DialogTitle>New schedule</DialogTitle></DialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="grid gap-1">Name<Input aria-label="Name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
          <label className="grid gap-1">Fetch
            <select aria-label="Fetch" className="h-9 rounded border bg-background px-2" value={actionId} onChange={(e) => setActionId(e.target.value)}>{actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
          </label>
          <div className="flex flex-wrap gap-1">{CRON_PRESETS.map((p) => <Button key={p.cron} size="sm" variant={cron === p.cron ? 'default' : 'outline'} onClick={() => setCron(p.cron)}>{p.label}</Button>)}</div>
          <label className="grid gap-1">Cron<Input aria-label="Cron" value={cron} onChange={(e) => setCron(e.target.value)} /></label>
          {runs.length > 0 && <ul className="m-0 p-0 text-xs text-muted-foreground" aria-label="Next runs">{runs.map((r) => <li key={r} className="list-none">Next: {when(r)}</li>)}</ul>}
          {error && <p role="alert" className="m-0 text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()}>Create schedule</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Card({ projectId, s, readOnly, onChanged }: { projectId: string; s: ScheduleDto; readOnly: boolean; onChanged: () => void }) {
  const [history, setHistory] = useState<Array<{ id: string; outcome: string; note: string | null; startedAt: string; startedBy: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => { try { await work(); setError(null); onChanged(); } catch (e) { setError(errorText(e)); } };
  return (
    <li className="list-none rounded border p-3 text-sm" aria-label={`Schedule ${s.name}`}>
      {s.autoDisabled && <p role="alert" className="m-0 mb-2 rounded bg-destructive/10 p-2 text-destructive">Turned off after {s.consecutiveFailures} failed runs. Switch it back on once the cause is fixed.</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><strong>{s.name}</strong> <span className="text-muted-foreground">{s.actionLabel}</span> <code className="text-xs">{s.cron}</code></div>
        <div className="flex items-center gap-2">
          <span className={GROUP_TONE[s.group]}>{GROUP_LABEL[s.group]}</span>
          <Switch aria-label={`${triggerLabel(s)}: ${s.name}`} checked={s.enabled} disabled={readOnly} onCheckedChange={(enabled) => void act(() => serverApi.seoUpdateSchedule(projectId, s.id, { enabled }))} />
        </div>
      </div>
      <p className="m-0 mt-1 text-xs text-muted-foreground">Next run: {when(s.nextRunAt)}. Last result: {s.last ? `${s.last.outcome}${s.last.note ? ` — ${s.last.note}` : ''} (${when(s.last.startedAt)})` : 'never run'}.</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={readOnly || !canRunNow(s)} onClick={() => void act(() => serverApi.seoRunSchedule(projectId, s.id))}>Run now</Button>
        <Button size="sm" variant="outline" onClick={() => void (history ? setHistory(null) : serverApi.seoScheduleHistory(projectId, s.id).then((h) => setHistory(h.entries)).catch((e) => setError(errorText(e))))}>{history ? 'Hide history' : 'History'}</Button>
        <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => void act(() => serverApi.seoDeleteSchedule(projectId, s.id))}>Delete</Button>
      </div>
      {history && <ul className="m-0 mt-2 p-0 text-xs" aria-label="History">{history.length ? history.map((h) => <li key={h.id} className="list-none">{when(h.startedAt)} · {h.startedBy} · {h.outcome}{h.note ? ` — ${h.note}` : ''}</li>) : <li className="list-none text-muted-foreground">No runs yet.</li>}</ul>}
      {error && <p role="alert" className="m-0 mt-1 text-destructive">{error}</p>}
    </li>
  );
}

/** Scheduled fetches: the scheduler owns cron, history and failure handling; this lists and controls them. */
export function SeoSchedules({ projectId, readOnly, onChanged }: { projectId: string; readOnly: boolean; onChanged: () => void }) {
  const [data, setData] = useState<{ actions: Array<{ id: string; label: string }>; schedules: ScheduleDto[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(await serverApi.seoSchedules(projectId)); setError(null); } catch (e) { setError(errorText(e)); } }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  const changed = () => { void load(); onChanged(); };
  return (
    <div className="grid gap-3 p-4" aria-label="Schedules">
      <div className="flex items-center justify-between"><h3 className="m-0 text-base font-semibold">Scheduled fetches</h3><Button size="sm" disabled={readOnly || !data} onClick={() => setCreating(true)}>New schedule</Button></div>
      {error && <p role="alert" className="m-0 text-destructive">{error} <button type="button" className="underline" onClick={() => void load()}>Retry</button></p>}
      {data && data.schedules.length === 0 && <p className="m-0 text-sm text-muted-foreground">No schedules yet. Add one to fetch fresh data automatically.</p>}
      <ul className="m-0 grid gap-2 p-0">{data?.schedules.map((s) => <Card key={s.id} projectId={projectId} s={s} readOnly={readOnly} onChanged={changed} />)}</ul>
      {creating && data && <NewScheduleDialog projectId={projectId} actions={data.actions} onClose={() => setCreating(false)} onSaved={changed} />}
    </div>
  );
}
