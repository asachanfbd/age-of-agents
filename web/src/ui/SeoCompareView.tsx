import { useEffect, useState } from 'react';
import { COMPARE_TILES, noChanges, snapshotLabel } from '../lib/seoInternalLinks';
import type { CompareTile, SnapshotDto } from '../lib/seoInternalLinks';
import { useSeoInternalLinksStore } from '../store/seoInternalLinksStore';

const path = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };

/** Latest crawl against an earlier one: pages and links added or removed, and pages whose status changed. */
export function SeoCompareView({ projectId, snapshots }: { projectId: string; snapshots: SnapshotDto[] }) {
  const diff = useSeoInternalLinksStore((s) => s.compareByProject[projectId]);
  const [from, setFrom] = useState(snapshots[1]?.id ?? '');
  const [to, setTo] = useState(snapshots[0]?.id ?? '');
  const [tile, setTile] = useState<CompareTile>('pagesAdded');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!from || !to || from === to) return;
    void useSeoInternalLinksStore.getState().loadCompare(projectId, from, to).then((res) => setError(res.ok ? null : res.error));
  }, [projectId, from, to]);
  if (snapshots.length < 2) return <p className="text-sm text-muted-foreground">Comparing needs two crawls. Run another crawl later to see what changed.</p>;
  const items = diff ? diff[tile].items : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 text-sm">
        <label className="flex items-center gap-1">Earlier
          <select aria-label="Earlier crawl" className="h-9 rounded-md border bg-background px-2" value={from} onChange={(e) => setFrom(e.target.value)}>{snapshots.map((s) => <option key={s.id} value={s.id}>{snapshotLabel(s)}</option>)}</select>
        </label>
        <label className="flex items-center gap-1">Later
          <select aria-label="Later crawl" className="h-9 rounded-md border bg-background px-2" value={to} onChange={(e) => setTo(e.target.value)}>{snapshots.map((s) => <option key={s.id} value={s.id}>{snapshotLabel(s)}</option>)}</select>
        </label>
      </div>
      {from === to && <p className="text-sm text-muted-foreground">Choose two different crawls.</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {diff && from !== to && (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Changes">
            {COMPARE_TILES.map((t) => (
              <button key={t.key} type="button" aria-pressed={tile === t.key} onClick={() => setTile(t.key)} className={`rounded-xl border px-4 py-2 text-left ${tile === t.key ? 'border-primary bg-primary/10' : 'hover:bg-muted'}`}>
                <div className="text-xl font-semibold tabular-nums">{diff[t.key].total.toLocaleString('en-US')}</div><div className="text-xs text-muted-foreground">{t.label}</div>
              </button>
            ))}
          </div>
          {noChanges(diff) ? <p className="text-sm text-muted-foreground">No changes between these crawls.</p> : (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm"><tbody>
                {items.map((item, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {typeof item === 'string' ? <td className="break-all px-2 py-1.5">{path(item)}</td>
                      : 'anchor' in item ? <td className="break-all px-2 py-1.5">{path(item.from)} → {path(item.to)} <span className="text-muted-foreground">“{item.anchor || 'no anchor'}”</span></td>
                        : <td className="break-all px-2 py-1.5">{path(item.url)} <span className="text-muted-foreground">{item.from ?? '—'} → {item.to ?? '—'}</span></td>}
                  </tr>
                ))}
              </tbody></table>
              <p className="m-0 p-2 text-xs text-muted-foreground">Showing {items.length.toLocaleString('en-US')} of {diff[tile].total.toLocaleString('en-US')}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
