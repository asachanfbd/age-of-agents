import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SYNC_POLL_MS, formatBytes, formatCount, oldestDataLabel, progressPercent, retentionNotice, shouldPoll } from '../lib/seoWorkspace';
import type { DiscardPreviewDto } from '../lib/seoWorkspace';
import { useSeoStore } from '../store/seoStore';
import type { ProjectData } from '../types';

const GB = 1024 ** 3;

/** Settings → Data: size, rows per dataset, oldest data held, sync state, the retention rule and discarding with a notice first. */
export function SeoData({ project }: { project: ProjectData }) {
  const id = project.id;
  const data = useSeoStore((s) => s.dataByProject[id]);
  const connections = useSeoStore((s) => s.connectionsByProject[id]?.connections);
  const store = useSeoStore.getState;
  const [message, setMessage] = useState<string | null>(null);
  const [months, setMonths] = useState('');
  const [thresholdGb, setThresholdGb] = useState('');
  const [preview, setPreview] = useState<DiscardPreviewDto | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const refresh = useCallback(async () => { await Promise.all([store().loadData(id), store().loadConnections(id)]); }, [id, store]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!shouldPoll(connections, data)) return undefined;
    const timer = setInterval(() => void refresh(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [connections, data, refresh]);

  if (!data) return <p className="text-sm text-muted-foreground">Loading data status…</p>;
  const notice = preview ? retentionNotice(preview) : null;

  async function openDiscard() {
    const result = await store().previewDiscard(id);
    if (!result.ok) { setMessage(result.error); return; }
    setAcknowledged(false);
    setPreview(result.preview);
  }

  return (
    <div className="grid max-w-3xl gap-4" aria-label="SEO data">
      {message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}
      {data.level === 'warning' && <Alert><AlertDescription>Storage is {formatBytes(data.bytes)}, over the warning size of {formatBytes(data.warningBytes)}.</AlertDescription></Alert>}
      {data.ingestionStoppedReason && <Alert><AlertDescription>Syncing stopped: {data.ingestionStoppedReason}.</AlertDescription></Alert>}

      <section className="rounded-xl border bg-card p-4" aria-label="Storage">
        <h4 className="m-0 text-sm font-semibold">Storage</h4>
        <p className="mt-1 text-sm">{formatBytes(data.bytes)} used. Warn at {formatBytes(data.warningBytes)}.</p>
        <div className="mt-2 flex items-end gap-2">
          <div className="grid gap-1"><Label htmlFor="threshold">Warning size (GB)</Label><Input id="threshold" className="w-28" inputMode="decimal" value={thresholdGb} placeholder={(data.warningBytes / GB).toFixed(1)} onChange={(e) => setThresholdGb(e.target.value)} /></div>
          <Button size="sm" variant="outline" disabled={!(Number(thresholdGb) > 0)} onClick={() => void store().setWarningBytes(id, Math.round(Number(thresholdGb) * GB)).then((r) => { if (r.ok) setThresholdGb(''); setMessage(r.ok ? 'Warning size saved.' : r.error); })}>Save</Button>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-4" aria-label="Datasets">
        <h4 className="m-0 text-sm font-semibold">What is stored</h4>
        <table className="mt-2 w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-normal">Dataset</th><th className="font-normal">Rows</th><th className="font-normal">Oldest data</th><th className="font-normal">Last sync</th></tr></thead>
          <tbody>
            {data.datasets.map((d) => (
              <tr key={d.id}><td className="py-1">{d.label}</td><td className="tabular-nums">{formatCount(d.rows)}</td><td>{oldestDataLabel(d.oldestDay)}</td><td>{d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : '—'}</td></tr>
            ))}
          </tbody>
        </table>
        {data.sync && (
          <p className="mt-2 text-xs text-muted-foreground">
            {data.sync.kind === 'backfill' ? 'Backfill' : 'Sync'} {data.sync.status}
            {data.sync.status === 'running' ? `: ${progressPercent(data.sync.done, data.sync.total)}% (${data.sync.done} of ${data.sync.total} days)` : ''}
            {data.sync.error ? `. ${data.sync.error}` : ''}
          </p>
        )}
      </section>

      <section className="rounded-xl border bg-card p-4" aria-label="Retention">
        <h4 className="m-0 text-sm font-semibold">Retention</h4>
        <p className="mt-1 text-sm text-muted-foreground">{data.retention.description}</p>
        {data.retention.lastDiscardAt && <p className="mt-1 text-xs text-muted-foreground">Last discard: {new Date(data.retention.lastDiscardAt).toLocaleString()}.</p>}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="grid gap-1"><Label htmlFor="months">Keep data for (months, 1–36)</Label><Input id="months" className="w-28" inputMode="numeric" value={months} placeholder={String(data.retention.months)} onChange={(e) => setMonths(e.target.value)} /></div>
          <Button size="sm" variant="outline" disabled={!/^\d+$/.test(months)} onClick={() => void store().setRetentionMonths(id, Number(months)).then((r) => { if (r.ok) setMonths(''); setMessage(r.ok ? 'Retention window saved.' : r.error); })}>Save</Button>
          <Button size="sm" disabled={data.retention.discarding} onClick={() => void openDiscard()}>{data.retention.discarding ? 'Discarding…' : 'Review and discard…'}</Button>
        </div>
        {data.retention.needsNotice && <p className="mt-2 text-xs text-warning-foreground">Nothing is discarded automatically until you have reviewed the notice once.</p>}
      </section>

      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{notice?.title}</DialogTitle><DialogDescription>This cannot be undone.</DialogDescription></DialogHeader>
          <ul className="m-0 grid gap-1 pl-5 text-sm">{notice?.lines.map((line) => <li key={line}>{line}</li>)}</ul>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />{notice?.confirmLabel}</label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>Cancel</Button>
            <Button disabled={!acknowledged || !preview || preview.total === 0} onClick={() => void store().acknowledgeAndDiscard(id, acknowledged).then((r) => { setPreview(null); setMessage(r.ok ? 'Discarding started.' : r.error); })}>{notice?.discardLabel}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
