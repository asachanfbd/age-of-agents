import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { parseCompetitors, pendingIds, proposalView, runOutcome, runView } from '../lib/seoKeywords';
import type { ClusterRowDto } from '../lib/seoKeywords';
import { useSeoKeywordsStore } from '../store/seoKeywordsStore';

/** Keyword research: an agent run that proposes ideas into a review list. Nothing is tracked until the person accepts it. */
export function SeoKeywordResearch({ projectId, readOnly, clusters, adsConnected, onChanged }: { projectId: string; readOnly: boolean; clusters: ClusterRowDto[]; adsConnected: boolean; onChanged: () => void }) {
  const store = useSeoKeywordsStore;
  const run = useSeoKeywordsStore((s) => s.runsByProject[projectId]?.research ?? null);
  const proposals = useSeoKeywordsStore((s) => s.proposalsByProject[projectId]);
  const [competitors, setCompetitors] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Record<string, string>>({});
  const view = runView(run);

  useEffect(() => { void store.getState().loadRun(projectId, 'research'); void store.getState().loadProposals(projectId); }, [projectId, store]);
  useEffect(() => {
    if (!view?.active) return;
    const timer = setInterval(() => { void store.getState().loadRun(projectId, 'research'); }, 1500);
    return () => clearInterval(timer);
  }, [projectId, store, view?.active]);
  const finished = run && !view?.active ? run.id : null;
  useEffect(() => { if (finished) void store.getState().loadProposals(projectId); }, [finished, projectId, store]);

  const guard = async (work: Promise<{ ok: boolean } & Partial<{ error: string }>>) => {
    const result = await work;
    setError(result.ok ? null : result.error ?? 'The request failed');
    return result.ok;
  };
  const decide = async (action: 'accept' | 'reject', ids: string[], clusterId?: string) => {
    if (await guard(store.getState().decideProposals(projectId, action, ids, clusterId))) onChanged();
  };
  const volumeAvailable = proposals?.volumeAvailable ?? adsConnected;
  const adsError = run?.adsError ?? proposals?.adsError ?? null;
  const list = proposals?.proposals.filter((p) => p.status === 'pending') ?? [];
  const named = clusters.filter((c) => c.id !== null);

  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4" aria-label="Keyword research">
      <h4 className="m-0 text-sm font-semibold">Keyword research</h4>
      <p className="m-0 text-xs text-muted-foreground">An agent proposes new keywords from your Search Console queries, your pages and the competitors you name. Nothing is added to your keywords until you accept it.</p>
      <label className="grid gap-1 text-sm">Competitor domains (optional, up to 10, one per line)
        <textarea aria-label="Competitor domains" className="min-h-16 rounded-md border bg-background p-2 text-sm" value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder="rival.com" />
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <Button size="sm" disabled={readOnly || view?.active} onClick={() => void guard(store.getState().startRun(projectId, 'research', { competitors: parseCompetitors(competitors) }))}>Run research</Button>
        {view?.active && <Button size="sm" variant="outline" onClick={() => void guard(store.getState().stopRun(projectId, 'research'))}>Stop</Button>}
        {adsConnected && <Button size="sm" variant="outline" disabled={readOnly} onClick={async () => { if (await guard(store.getState().refreshVolumes(projectId))) onChanged(); }}>Refresh volumes</Button>}
      </div>
      <p className="m-0 text-xs text-muted-foreground">{proposals?.market ? `Volumes use language ${proposals.market.languageId} and location ${proposals.market.locationId}.` : 'Volumes need a language and location: set them under Settings → Connections → Google Ads.'}</p>
      {error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}
      {view && (
        <p className="m-0 text-sm" role="status">
          Research: <strong>{view.label}</strong>{view.progress && view.active ? ` · ${view.progress}` : ''}{!view.active && runOutcome(run) ? ` · ${runOutcome(run)}` : ''}
        </p>
      )}
      {view?.notices.map((n) => <Alert key={n}><AlertDescription>{n}</AlertDescription></Alert>)}
      {adsError && <Alert role="alert"><AlertDescription>Google Ads: {adsError}. Keywords and volumes already saved are unchanged.</AlertDescription></Alert>}
      {!volumeAvailable && <p className="m-0 text-xs text-muted-foreground">Connect Google Ads for volume.</p>}
      <div className="flex items-center gap-2">
        <h5 className="m-0 text-xs font-semibold uppercase text-muted-foreground">Review ({list.length})</h5>
        <Button size="sm" variant="outline" disabled={readOnly || !list.length} onClick={() => void decide('accept', pendingIds(list))}>Accept all remaining</Button>
      </div>
      {!list.length && <p className="m-0 text-sm text-muted-foreground">No ideas waiting for review.</p>}
      <ul className="m-0 grid list-none gap-2 p-0">
        {list.map((p) => {
          const v = proposalView(p, volumeAvailable);
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
              <span className="font-medium">{v.keyword}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{v.source}</span>
              <span className="text-xs text-muted-foreground" title={v.volume.title}>{v.volume.text}</span>
              {v.reason && <span className="basis-full text-xs text-muted-foreground">{v.reason}</span>}
              <span className="ml-auto flex flex-wrap items-center gap-1">
                <Button size="sm" disabled={readOnly} onClick={() => void decide('accept', [p.id])}>Accept</Button>
                <select aria-label={`Cluster for ${v.keyword}`} className="h-8 rounded-md border bg-background px-1 text-xs" value={target[p.id] ?? ''} onChange={(e) => setTarget((t) => ({ ...t, [p.id]: e.target.value }))}>
                  <option value="">Accept into cluster…</option>
                  {named.map((c) => <option key={c.id} value={c.id!}>{c.name}</option>)}
                </select>
                <Button size="sm" variant="outline" disabled={readOnly || !target[p.id]} onClick={() => void decide('accept', [p.id], target[p.id])}>Accept into cluster</Button>
                <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => void decide('reject', [p.id])}>Reject</Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
