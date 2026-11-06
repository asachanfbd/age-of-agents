import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { serverApi } from '../lib/serverApi';
import {
  CHART_HEIGHT, CHART_WIDTH, chartModel, controlsError, DEFAULT_CONTROLS, EXPORTS, exportPath, linkCell, moverRows, moversEmptyText, positionRows, PRESET_OPTIONS, rangeLine,
  SAVED_BANNER, saveNameError, savedBadges, savedConfirmation, savedCount, scheduleView, summaryButtonLabel, summaryCaption, summaryStatus, tileView,
} from '../lib/seoReports';
import type { Controls, MoverListsDto, ReportDto, SavedMetaDto } from '../lib/seoReports';
import { useSeoReportsStore } from '../store/seoReportsStore';
import type { ProjectData } from '../types';

const REQUEST_DELAY_MS = 300;
const TONE = { good: 'text-success-foreground', bad: 'text-destructive', neutral: 'text-muted-foreground' } as const;

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="rounded-lg border p-4" aria-label={title}>
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      {hint && <p className="m-0 mt-1 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Scorecard({ report, onSetup }: { report: ReportDto; onSetup: () => void }) {
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4" aria-label="Scorecard">
      {report.tiles.map((t) => {
        const v = tileView(t);
        return (
          <li key={t.key} className="rounded-md border p-3" aria-label={v.label_aria}>
            <div className="text-xs text-muted-foreground">{v.label}</div>
            <div className={`mt-1 text-xl font-semibold ${v.state === 'ok' ? '' : 'text-muted-foreground'}`}>{v.value}</div>
            {v.state === 'ok' && <div className="text-xs text-muted-foreground">{v.comparison}</div>}
            {v.change && <div className={`mt-1 text-xs font-medium ${TONE[v.tone]}`}>{v.change}</div>}
            {v.detail && <div className="mt-1 text-xs text-muted-foreground">{v.detail}</div>}
            {v.note && <div className="mt-1 text-xs text-muted-foreground">{v.note}</div>}
            {v.action === 'connect' && <button type="button" className="mt-1 text-xs underline" onClick={onSetup}>Connect in Settings</button>}
            {v.action === 'import' && <span className="mt-1 block text-xs text-muted-foreground">Import backlinks to see this.</span>}
          </li>
        );
      })}
    </ul>
  );
}

function Charts({ report }: { report: ReportDto }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {report.charts.map((c) => {
        const m = chartModel(c);
        return (
          <figure key={c.key} className="m-0 rounded-md border p-3">
            <figcaption className="text-xs font-medium">{m.label}</figcaption>
            {m.state === 'ok'
              ? (
                <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={m.ariaLabel} className="mt-2 h-16 w-full overflow-visible">
                  <path d={m.previousPath} fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
                  <path d={m.currentPath} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
                </svg>
              )
              : <p className="m-0 mt-2 text-xs text-muted-foreground">{m.ariaLabel.split(': ')[1]}</p>}
            {m.state === 'ok' && <p className="m-0 mt-1 text-[11px] text-muted-foreground">Solid line: this period. Dashed: comparison.{c.key === 'position' ? ' Lower is better.' : ''}</p>}
          </figure>
        );
      })}
    </div>
  );
}

function MoversTable({ title, list, report, positions }: { title: string; list: MoverListsDto; report: ReportDto; positions?: boolean }) {
  const perDay = report.period.perDay;
  const empty = moversEmptyText(report, list);
  const rows = [...moverRows(list.gains, 'gain', perDay), ...moverRows(list.losses, 'loss', perDay)];
  const posRows = [...positionRows(list.positionGains, 'gain'), ...positionRows(list.positionLosses, 'loss')];
  const table = (items: typeof rows, head: string) => (
    <table className="w-full text-left text-xs">
      <thead><tr><th>{head}</th><th>Clicks</th><th>Change</th><th>Impressions</th><th>Position</th></tr></thead>
      <tbody>{items.map((r) => (
        <tr key={`${r.word}-${r.name}`} className="border-t">
          <td className="break-all py-1 pr-2">{r.name}</td><td>{r.clicks}</td>
          <td className={r.word === 'gain' ? TONE.good : TONE.bad}>{r.glyph} {r.change} {r.word === 'gain' ? 'gain' : 'loss'}</td><td>{r.impressions}</td><td>{r.position}</td>
        </tr>
      ))}</tbody>
    </table>
  );
  return (
    <div className="mb-4">
      <h4 className="m-0 mb-1 text-xs font-semibold uppercase text-muted-foreground">{title}</h4>
      {empty ? <p className="m-0 text-xs text-muted-foreground">{empty}</p> : (
        <>
          {rows.length > 0 && table(rows, 'Name')}
          {positions && posRows.length > 0 && <div className="mt-2">{table(posRows, 'Position movers')}</div>}
        </>
      )}
    </div>
  );
}

function Lists({ report }: { report: ReportDto }) {
  const links = (title: string, rows: ReportDto['backlinks']['added']) => (
    <div>
      <h4 className="m-0 mb-1 text-xs font-semibold uppercase text-muted-foreground">{title}</h4>
      {rows.length === 0 ? <p className="m-0 text-xs text-muted-foreground">None in this period.</p> : (
        <table className="w-full text-left text-xs"><thead><tr><th>Source</th><th>DR</th><th>UR</th><th>Date</th></tr></thead>
          <tbody>{rows.map((l) => <tr key={`${l.sourceUrl}-${l.on}`} className="border-t"><td className="break-all py-1 pr-2">{l.sourceUrl}</td><td>{linkCell(l.dr)}</td><td>{linkCell(l.ur)}</td><td>{l.on}</td></tr>)}</tbody></table>
      )}
    </div>
  );
  const urls = (title: string, items: string[], total: number) => (
    <div>
      <h4 className="m-0 mb-1 text-xs font-semibold uppercase text-muted-foreground">{title} ({total})</h4>
      {items.length === 0 ? <p className="m-0 text-xs text-muted-foreground">None.</p> : <ul className="m-0 list-none p-0 text-xs">{items.map((u) => <li key={u} className="break-all">{u}</li>)}</ul>}
    </div>
  );
  const il = report.internalLinks;
  return (
    <>
      <Section title="Winners and losers" hint={`Pages, keywords and clusters with at least ${report.minImpressions} impressions in both periods. Position is the Search Console average, not rank tracking.`}>
        <MoversTable title="Pages" list={report.movers.pages} report={report} />
        <MoversTable title="Keywords" list={report.movers.keywords} report={report} positions />
        <MoversTable title="Clusters" list={report.movers.clusters} report={report} />
      </Section>
      <Section title="Backlinks" hint={report.backlinks.available ? (report.backlinks.coverage.dr ?? 'No DR in the imported data.') : undefined}>
        {report.backlinks.available
          ? <div className="grid gap-4 md:grid-cols-2">{links(`New (${report.backlinks.addedTotal})`, report.backlinks.added)}{links(`Lost (${report.backlinks.lostTotal})`, report.backlinks.lost)}</div>
          : <p className="m-0 text-sm text-muted-foreground">Not available yet. Import backlinks in the Backlinks tab.</p>}
      </Section>
      <Section title="Indexing changes">
        {report.indexing.available
          ? <div className="grid gap-4 md:grid-cols-2">{urls('Newly indexed', report.indexing.newlyIndexed, report.indexing.newlyIndexedTotal)}{urls('Newly excluded', report.indexing.newlyExcluded, report.indexing.newlyExcludedTotal)}</div>
          : <p className="m-0 text-sm text-muted-foreground">Not available yet. Add sitemaps so pages can be checked.</p>}
      </Section>
      <Section title="Internal link changes">
        {il.available
          ? <p className="m-0 text-sm">{il.added} links added, {il.removed} removed. Orphan pages: {il.orphansBefore} before, {il.orphansAfter} now.{il.newlyOverLimit.length > 0 && ` Pages newly over 100 outgoing links: ${il.newlyOverLimit.length}.`}</p>
          : <p className="m-0 text-sm text-muted-foreground">{il.reason}</p>}
      </Section>
      <Section title="Work done">
        {report.work.tasks.length + report.work.agentRuns.length === 0 ? <p className="m-0 text-sm text-muted-foreground">No tasks were completed and no agent ran in this period.</p> : (
          <ul className="m-0 list-none p-0 text-sm">
            {report.work.tasks.map((w) => <li key={w.id}>Task done: {w.title} <span className="text-xs text-muted-foreground">{w.at}</span></li>)}
            {report.work.agentRuns.map((w) => <li key={w.id}>Agent run: {w.title} <span className="text-xs text-muted-foreground">{w.at}</span></li>)}
          </ul>
        )}
      </Section>
    </>
  );
}

function ReportBody({ report, onSetup }: { report: ReportDto; onSetup: () => void }) {
  if (report.state === 'setup') {
    return (
      <div className="rounded-lg border p-6" aria-label="Set up first">
        <h3 className="m-0 text-base font-semibold">Nothing to report yet</h3>
        <p className="m-0 mt-1 text-sm text-muted-foreground">Set up at least one source and this tab fills in.</p>
        <ol className="mt-3 list-decimal pl-5 text-sm">{report.setup.map((s) => <li key={s}>{s}</li>)}</ol>
        <Button className="mt-3" size="sm" variant="outline" onClick={onSetup}>Open Connections</Button>
      </div>
    );
  }
  return (
    <>
      {report.notes.map((n) => <Alert key={n}><AlertDescription>{n}</AlertDescription></Alert>)}
      <Scorecard report={report} onSetup={onSetup} />
      <Section title="Trends" hint="Solid line: the selected period. Dashed line: the comparison period, lined up day by day."><Charts report={report} /></Section>
      <Lists report={report} />
    </>
  );
}

function SummaryPanel({ project, controls, report, readOnly }: { project: ProjectData; controls: Controls; report: ReportDto; readOnly: boolean }) {
  const summary = useSeoReportsStore((s) => (readOnly ? report.summary : s.summaryByProject[project.id] ?? null));
  const busy = useSeoReportsStore((s) => s.summaryBusy[project.id] ?? false);
  const error = useSeoReportsStore((s) => s.summaryError[project.id] ?? null);
  const status = summaryStatus(summary, report, busy, error);
  if (readOnly && !summary) return null;
  return (
    <Section title="AI summary">
      {summary && (
        <div className={status === 'stale' ? 'opacity-70' : ''}>
          <p className="m-0 text-xs font-medium text-muted-foreground">{summaryCaption(summary, report)}</p>
          <p className="m-0 mt-1 text-sm">{summary.paragraph}</p>
          {summary.actions.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{summary.actions.map((a) => <li key={a}>{a}</li>)}</ul>}
        </div>
      )}
      {!summary && <p className="m-0 text-sm text-muted-foreground">Optional. An agent reads this report and writes a short summary with next steps. Nothing is sent anywhere.</p>}
      {error && <p className="m-0 mt-1 text-sm text-destructive" role="alert">The summary could not be written: {error}. The report below is complete without it.</p>}
      {!readOnly && <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={() => void useSeoReportsStore.getState().writeSummary(project.id, controls)}>{summaryButtonLabel(status)}</Button>}
    </Section>
  );
}

function ControlsBar({ controls, onChange, error }: { controls: Controls; onChange: (c: Controls) => void; error: string | null }) {
  const set = (patch: Partial<Controls>) => onChange({ ...controls, ...patch });
  return (
    <div className="grid gap-2" aria-label="Report period">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs font-semibold uppercase text-muted-foreground">Period
          <select aria-label="Period" className="h-9 rounded-md border bg-background px-2 text-sm font-normal normal-case text-foreground" value={controls.preset} onChange={(e) => set({ preset: e.target.value as Controls['preset'] })}>
            {PRESET_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        {controls.preset === 'custom' && (
          <>
            <label className="grid gap-1 text-xs font-semibold uppercase text-muted-foreground">From<Input type="date" aria-label="From" value={controls.from} onChange={(e) => set({ from: e.target.value })} /></label>
            <label className="grid gap-1 text-xs font-semibold uppercase text-muted-foreground">To<Input type="date" aria-label="To" value={controls.to} onChange={(e) => set({ to: e.target.value })} /></label>
            <label className="grid gap-1 text-xs font-semibold uppercase text-muted-foreground">Compare from<Input type="date" aria-label="Compare from" value={controls.compareFrom} onChange={(e) => set({ compareFrom: e.target.value })} /></label>
            <label className="grid gap-1 text-xs font-semibold uppercase text-muted-foreground">Compare to<Input type="date" aria-label="Compare to" value={controls.compareTo} onChange={(e) => set({ compareTo: e.target.value })} /></label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={controls.includePartial} onChange={(e) => set({ includePartial: e.target.checked })} />Include partial days</label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-muted-foreground">Min impressions
          <Input type="number" min={0} aria-label="Minimum impressions" className="w-28" value={controls.minImpressions} onChange={(e) => set({ minImpressions: Number(e.target.value) })} />
        </label>
      </div>
      {controls.preset === 'custom' && <p className="m-0 text-xs text-muted-foreground">Leave the comparison empty to compare with the period of equal length right before.</p>}
      {error && <p className="m-0 text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}

function ExportMenu({ projectId, saved, controls }: { projectId: string; saved: string | null; controls: Controls }) {
  return (
    <details className="relative">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border px-3 text-sm">Export</summary>
      <ul className="absolute right-0 z-10 m-0 mt-1 grid min-w-56 list-none gap-1 rounded-md border bg-popover p-2 text-sm shadow-md">
        {EXPORTS.map((item) => (
          <li key={item.label}><a className="block rounded px-2 py-1 hover:bg-muted" href={serverApi.seoReportExportUrl(projectId, exportPath(saved, item, controls))} {...(item.format === 'html' ? { target: '_blank', rel: 'noreferrer' } : { download: true })}>{item.label}</a></li>
        ))}
      </ul>
    </details>
  );
}

function LiveReport({ project, onSetup, onSaved }: { project: ProjectData; onSetup: () => void; onSaved: (message: string) => void }) {
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const report = useSeoReportsStore((s) => s.reportByProject[project.id]);
  const problem = controlsError(controls);
  // Typing in a date or the threshold waits for a pause before asking again; the store drops answers for older requests anyway.
  useEffect(() => {
    if (problem) return undefined;
    const timer = setTimeout(() => { void useSeoReportsStore.getState().loadReport(project.id, controls).then((r) => setError(r.ok ? null : r.error)); }, REQUEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [project.id, controls, problem]);
  const nameProblem = saveNameError(name);
  const save = async () => {
    const res = await useSeoReportsStore.getState().saveReport(project.id, controls, name);
    if (!res.ok) { setError(res.error); return; }
    setName('');
    onSaved(savedConfirmation(res.saved, useSeoReportsStore.getState().savedByProject[project.id]?.length ?? 1));
  };
  return (
    <div className="grid gap-4">
      <ControlsBar controls={controls} onChange={setControls} error={problem ?? error} />
      {report && <p className="m-0 text-sm text-muted-foreground" aria-label="Range">{rangeLine(report.period)}</p>}
      {report && report.state === 'ok' && <SummaryPanel project={project} controls={controls} report={report} readOnly={false} />}
      {report ? <ReportBody report={report} onSetup={onSetup} /> : <p className="m-0 text-sm text-muted-foreground">Loading…</p>}
      {report && report.state === 'ok' && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Input aria-label="Report name" className="w-64" placeholder="Name (optional)" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" disabled={!!nameProblem || !!problem} onClick={() => void save()}>Save report</Button>
          <ExportMenu projectId={project.id} saved={null} controls={controls} />
          {nameProblem && <span className="text-xs text-destructive">{nameProblem}</span>}
        </div>
      )}
    </div>
  );
}

function ScheduleCard({ project }: { project: ProjectData }) {
  const state = useSeoReportsStore((s) => s.scheduleByProject[project.id]);
  const view = scheduleView(state ?? null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Generate reports on a schedule" hint="A scheduled report is saved by itself and also keeps history beyond the 12 months of live data.">
      {view.note && <p className="m-0 text-sm text-muted-foreground">{view.note}</p>}
      {view.rows.map((r) => (
        <label key={r.cadence} className="flex items-center gap-2 py-1 text-sm">
          <input type="checkbox" checked={r.enabled} onChange={(e) => void useSeoReportsStore.getState().setSchedule(project.id, r.cadence, e.target.checked).then((res) => setError(res.ok ? null : res.error))} />
          {r.label}{r.next && <span className="text-xs text-muted-foreground"> · next {r.next.slice(0, 16).replace('T', ' ')}</span>}
        </label>
      ))}
      {error && <p className="m-0 text-sm text-destructive" role="alert">{error}</p>}
    </Section>
  );
}

function SavedList({ project, items }: { project: ProjectData; items: SavedMetaDto[] }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (items.length === 0) return <p className="m-0 text-sm text-muted-foreground">No saved reports yet. Save one from the live report.</p>;
  return (
    <ul className="m-0 grid list-none gap-2 p-0" aria-label="Saved reports">
      {items.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
          <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => void useSeoReportsStore.getState().openSaved(project.id, m.id)}>{m.name}</button>
          <span className="text-xs text-muted-foreground">{m.from} to {m.to} · saved {m.savedAt.slice(0, 10)}</span>
          {savedBadges(m).map((b) => <span key={b} className="rounded bg-muted px-1.5 py-0.5 text-xs">{b}</span>)}
          <span className="ml-auto" />
          {confirming === m.id
            ? <><Button size="sm" variant="destructive" onClick={() => void useSeoReportsStore.getState().deleteSaved(project.id, m.id).then(() => setConfirming(null))}>Delete for good</Button><Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Keep</Button></>
            : <Button size="sm" variant="ghost" onClick={() => setConfirming(m.id)}>Delete</Button>}
        </li>
      ))}
    </ul>
  );
}

function SavedArea({ project, onSetup }: { project: ProjectData; onSetup: () => void }) {
  const items = useSeoReportsStore((s) => s.savedByProject[project.id]) ?? [];
  const opened = useSeoReportsStore((s) => s.openedByProject[project.id]);
  if (opened) {
    return (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => useSeoReportsStore.getState().closeSaved(project.id)}>Back to saved reports</Button>
          <h3 className="m-0 text-base font-semibold">{opened.name}</h3>
          <span className="ml-auto" />
          <ExportMenu projectId={project.id} saved={opened.id} controls={DEFAULT_CONTROLS} />
        </div>
        <Alert><AlertDescription>{SAVED_BANNER}</AlertDescription></Alert>
        <p className="m-0 text-sm text-muted-foreground" aria-label="Range">{rangeLine(opened.report.period)}</p>
        <SummaryPanel project={project} controls={DEFAULT_CONTROLS} report={opened.report} readOnly />
        <ReportBody report={opened.report} onSetup={onSetup} />
      </div>
    );
  }
  return <div className="grid gap-4"><ScheduleCard project={project} /><SavedList project={project} items={items} /></div>;
}

/** The Reports tab: a live report for the chosen period, and the saved reports with their schedule. */
export function SeoReports({ project, onOpenSettings }: { project: ProjectData; onOpenSettings: () => void }) {
  const [view, setView] = useState<'live' | 'saved'>('live');
  const [message, setMessage] = useState<string | null>(null);
  const saved = useSeoReportsStore((s) => s.savedByProject[project.id]);
  useEffect(() => {
    const store = useSeoReportsStore.getState();
    void store.loadSaved(project.id);
    void store.loadSchedule(project.id);
  }, [project.id]);
  const tabs = useMemo(() => [{ key: 'live' as const, label: 'Live report' }, { key: 'saved' as const, label: savedCount(saved?.length ?? 0) }], [saved?.length]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label="SEO reports">
      <div className="mb-4 flex gap-2" role="tablist" aria-label="Reports views">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={view === t.key} onClick={() => setView(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${view === t.key ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'}`}>{t.label}</button>
        ))}
      </div>
      {message && <Alert className="mb-4"><AlertDescription>{message}</AlertDescription></Alert>}
      {view === 'live' ? <LiveReport project={project} onSetup={onOpenSettings} onSaved={setMessage} /> : <SavedArea project={project} onSetup={onOpenSettings} />}
    </div>
  );
}
