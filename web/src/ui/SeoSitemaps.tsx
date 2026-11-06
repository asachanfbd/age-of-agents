import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { bingAction, bingCell, confirmText, countLabel, INDEXNOW_NOTE, keyFileGuidance, keyFileTag, lastInspectedLabel, logEntryLabel, quotaMeter, selectionActions, sitemapTags, STATUS_AGE_NOTE, submissionCount, submittedIndexedLabel, toggle, typeLabel, urlStatusTag } from '../lib/seoSitemaps';
import type { Tag } from '../lib/seoSitemaps';
import { useSeoStore } from '../store/seoStore';
import type { ProjectData } from '../types';

const TONE: Record<Tag['tone'], string> = {
  good: 'bg-success/15 text-success-foreground', warning: 'bg-warning/15 text-warning-foreground',
  bad: 'bg-destructive/15 text-destructive', muted: 'bg-muted text-muted-foreground',
};
const TagChip = ({ tag }: { tag: Tag }) => <span className={`mr-1 inline-block rounded-full px-2 py-0.5 text-xs ${TONE[tag.tone]}`}>{tag.label}</span>;

type Pending = { mode: 'selected' | 'sitemap' | 'new-or-changed'; count: number; urls?: string[]; sitemap?: string } | null;

/** The Sitemaps tab: every sitemap found, per-URL indexing status from Google, the inspection quota and IndexNow submissions with their log. */
export function SeoSitemaps({ project }: { project: ProjectData }) {
  const id = project.id;
  const sitemaps = useSeoStore((s) => s.sitemapsByProject[id]);
  const urls = useSeoStore((s) => s.urlsByProject[id]);
  const keyFile = useSeoStore((s) => s.keyFileByProject[id]);
  const log = useSeoStore((s) => s.logByProject[id]);
  const busy = useSeoStore((s) => s.sitemapBusy[id] ?? false);
  const store = useSeoStore.getState;
  const [selectedSitemap, setSelectedSitemap] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [sending, setSending] = useState(false);

  const params = useCallback(() => { const p = new URLSearchParams({ limit: '100', filter }); if (selectedSitemap) p.set('sitemap', selectedSitemap); if (search) p.set('search', search); return p; }, [filter, search, selectedSitemap]);
  const refresh = useCallback(async () => {
    const results = await Promise.all([store().loadSitemaps(id), store().loadSitemapUrls(id, params()), store().loadLog(id)]);
    const failed = results.find((r) => !r.ok);
    setMessage(failed && !failed.ok ? failed.error : null);
  }, [id, params, store]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void store().loadKeyFile(id, false); }, [id, store]);
  /** Selection is cleared whenever the visible list changes, so a click never acts on rows the person can no longer see. */
  const changeList = (change: () => void) => { setSelected(new Set()); change(); };

  if (!sitemaps) return <div className="p-6 text-sm text-muted-foreground">{message ?? 'Loading sitemaps…'}</div>;
  const meter = quotaMeter(sitemaps.quota);
  const actions = selectionActions(selected.size, sitemaps.quota);
  const bing = bingAction(selected.size, urls?.rows ?? []);
  const keyTag = keyFileTag(keyFile?.status ?? 'checking');
  const now = new Date();

  async function readAll(sitemap?: string) {
    const r = await store().readSitemaps(id, sitemap);
    setMessage(r.ok ? null : r.error);
    await refresh();
  }
  async function inspectSelected() {
    const r = await store().inspectUrls(id, [...selected]);
    setMessage(r.ok ? null : r.error);
    await refresh();
  }
  async function checkBingSelected() {
    const r = await store().checkBing(id, [...selected], params());
    setMessage(r.ok ? null : r.error);
  }
  async function confirmSubmit() {
    if (!pending || sending) return;
    setSending(true);
    const body = pending.mode === 'selected' ? { mode: 'selected' as const, urls: pending.urls ?? [] } : { mode: pending.mode, sitemap: pending.sitemap };
    const r = await store().submitIndexNow(id, body);
    setSending(false);
    setPending(null);
    if (r.ok) { setSelected(new Set()); setMessage(`Sent ${r.outcome.total} URLs in ${r.outcome.batches} request${r.outcome.batches === 1 ? '' : 's'}: ${r.outcome.accepted} accepted, ${r.outcome.rejected} rejected, ${r.outcome.errors} failed.${r.outcome.keyFileWarning ? ' The key file could not be verified.' : ''}`); } else setMessage(r.error);
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6" aria-label="SEO sitemaps">
      {message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}
      {sitemaps.gsc.state === 'not-connected' && <Alert><AlertDescription>Connect Search Console to see sitemap errors, submitted and indexed counts, and URL indexing status.</AlertDescription></Alert>}
      {sitemaps.notes.map((n) => <Alert key={n}><AlertDescription>{n}</AlertDescription></Alert>)}
      {sitemaps.gsc.state === 'error' && <Alert><AlertDescription>Search Console could not be reached: {sitemaps.gsc.error}</AlertDescription></Alert>}

      <section className="rounded-xl border bg-card p-4" aria-label="Sitemaps">
        <div className="flex items-center justify-between">
          <h4 className="m-0 text-sm font-semibold">Sitemaps</h4>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void readAll()}>{busy ? 'Reading…' : 'Read all sitemaps'}</Button>
        </div>
        {!sitemaps.sitemaps.length && <p className="text-sm text-muted-foreground">No sitemaps found yet. They are looked up in Search Console, robots.txt and {new URL(sitemaps.siteUrl).origin}/sitemap.xml when you read them.</p>}
        <ul className="m-0 mt-2 list-none p-0">
          {sitemaps.sitemaps.map((s) => (
            <li key={s.url} className={`border-t py-2 text-sm ${s.parent ? 'ml-6' : ''}`}>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={`break-all text-left font-medium ${selectedSitemap === s.url ? 'underline' : ''}`} onClick={() => changeList(() => setSelectedSitemap(selectedSitemap === s.url ? undefined : s.url))}>{s.url}</button>
                <span className="text-xs text-muted-foreground">{typeLabel(s)}</span>
                {sitemapTags(s).map((t) => <TagChip key={t.label} tag={t} />)}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void readAll(s.url)}>Re-read</Button>
              </div>
              <div className="text-xs text-muted-foreground">
                {s.kind === 'index' ? `${s.children.length} child sitemaps` : `${countLabel(s.urlCount)} URLs`} · read {s.fetchedAt ? new Date(s.fetchedAt).toLocaleString() : 'never'} · {submittedIndexedLabel(s)}
                {s.gsc ? ` · submitted ${s.gsc.lastSubmitted ? new Date(s.gsc.lastSubmitted).toLocaleDateString() : 'no data'}, fetched by Google ${s.gsc.lastDownloaded ? new Date(s.gsc.lastDownloaded).toLocaleDateString() : 'no data'}` : ''}
              </div>
              {s.error && <div className="text-xs text-destructive">{s.error}</div>}
              {s.warnings.slice(0, 3).map((w) => <div key={w} className="text-xs text-warning-foreground">{w}</div>)}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border bg-card p-4" aria-label="URL inspection">
        <h4 className="m-0 text-sm font-semibold">URL inspection quota</h4>
        <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={meter.used} aria-valuemax={meter.limit}><div className="h-full bg-primary" style={{ width: `${meter.percent}%` }} /></div>
        <p className="m-0 mt-1 text-xs text-muted-foreground">{meter.used.toLocaleString('en-US')} of {meter.limit.toLocaleString('en-US')} used today · {meter.statusText} · {meter.resetText}</p>
        <p className="m-0 text-xs text-muted-foreground">{meter.reserveText} {STATUS_AGE_NOTE}</p>
      </section>

      <section className="rounded-xl border bg-card p-4" aria-label="IndexNow">
        <h4 className="m-0 text-sm font-semibold">IndexNow</h4>
        <p className="mb-2 mt-1 text-sm">{INDEXNOW_NOTE}</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <TagChip tag={keyTag} />
          <Button size="sm" variant="ghost" onClick={() => void store().loadKeyFile(id, true)}>Check key file</Button>
        </div>
        <p className="m-0 mt-1 text-xs text-muted-foreground">{keyFileGuidance(keyFile ?? null)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!selectedSitemap} onClick={() => setPending({ mode: 'sitemap', count: submissionCount(sitemaps.sitemaps.find((s) => s.url === selectedSitemap)!, sitemaps.sitemaps), sitemap: selectedSitemap })}>Submit whole sitemap</Button>
          <Button size="sm" variant="outline" onClick={() => setPending({ mode: 'new-or-changed', count: 0, sitemap: selectedSitemap })}>Submit new or changed</Button>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-4" aria-label="URLs">
        <div className="flex flex-wrap items-end gap-2">
          <h4 className="m-0 mr-auto text-sm font-semibold">URLs{selectedSitemap ? ' in the selected sitemap' : ''}</h4>
          <Input aria-label="Search URLs" className="w-52" placeholder="Search URLs" value={search} onChange={(e) => changeList(() => setSearch(e.target.value))} />
          <select aria-label="Status filter" className="h-9 rounded-md border bg-background px-2 text-sm" value={filter} onChange={(e) => changeList(() => setFilter(e.target.value))}>
            {['all', 'indexed', 'not-indexed', 'unknown', 'waiting', 'never-inspected'].map((f) => <option key={f} value={f}>{f === 'all' ? 'All statuses' : f.replace('-', ' ')}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={actions.inspectDisabled} onClick={() => void inspectSelected()}>{actions.inspectLabel}</Button>
          {bing.visible && <Button size="sm" variant="outline" disabled={bing.disabled} onClick={() => void checkBingSelected()}>{bing.label}</Button>}
          <Button size="sm" disabled={actions.submitDisabled} onClick={() => setPending({ mode: 'selected', count: selected.size, urls: [...selected] })}>{actions.submitLabel}</Button>
        </div>
        <table className="mt-2 w-full text-sm">
          <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="w-6" /><th>URL</th><th>Google indexing</th><th>Last inspected</th><th>IndexNow</th><th>Bing</th></tr></thead>
          <tbody>
            {(urls?.rows ?? []).map((u) => {
              const tag = urlStatusTag(u.indexing);
              return (
                <tr key={u.url} className="border-b last:border-0 align-top">
                  <td><input type="checkbox" aria-label={`Select ${u.url}`} checked={selected.has(u.url)} onChange={() => setSelected(toggle(selected, u.url))} /></td>
                  <td className="break-all py-1 pr-2">{u.url}</td>
                  <td><TagChip tag={tag} />{u.indexing.error && <div className="text-xs text-destructive">{u.indexing.error}</div>}</td>
                  <td className="text-xs text-muted-foreground">{lastInspectedLabel(u.indexing.inspectedAt, now)}</td>
                  <td className="text-xs">{u.indexNow ? `${u.indexNow.result === 'accepted' ? 'Accepted' : u.indexNow.result} ${new Date(u.indexNow.lastSubmittedAt).toLocaleString()}` : 'Not submitted'}</td>
                  <td className="text-xs text-muted-foreground">{bingCell(u.bing)}</td>
                </tr>
              );
            })}
            {!urls?.rows.length && <tr><td colSpan={6} className="p-3 text-center text-muted-foreground">No URLs to show. Read the sitemaps first.</td></tr>}
          </tbody>
        </table>
        {urls && urls.total > urls.rows.length && <p className="text-xs text-muted-foreground">Showing the first {urls.rows.length} of {urls.total.toLocaleString('en-US')} URLs; narrow the list with the search box or a sitemap.</p>}
      </section>

      <section className="rounded-xl border bg-card p-4" aria-label="IndexNow submission log">
        <h4 className="m-0 text-sm font-semibold">IndexNow submission log</h4>
        {!log?.length && <p className="text-sm text-muted-foreground">Nothing has been submitted yet. Submissions only happen when you confirm one here.</p>}
        <ul className="m-0 list-none p-0 text-xs">{(log ?? []).map((e) => <li key={`${e.batchId}${e.url}`} className="border-t py-1"><span className="text-muted-foreground">{new Date(e.at).toLocaleString()} · {e.endpoint} · {e.httpStatus ?? 'no answer'}</span> <span className="break-all">{e.url}</span> — {logEntryLabel(e)}</li>)}</ul>
      </section>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open && !sending) setPending(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Submit to IndexNow</DialogTitle><DialogDescription>{pending ? (pending.mode === 'new-or-changed' && !pending.count ? 'Send the URLs that are new or changed since they were last submitted to IndexNow? This only notifies search engines; it does not confirm indexing.' : confirmText({ mode: pending.mode, count: pending.count })) : ''}</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={sending} onClick={() => setPending(null)}>Cancel</Button>
            <Button disabled={sending} onClick={() => void confirmSubmit()}>{sending ? 'Sending…' : 'Send'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
