import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  firstMatch, highlighted, HIGHLIGHTS, legendFor, NO_FILTERS, sectionColours, sectionsOf, showingText, visibleEdges, visibleNodes,
} from '../lib/seoInternalLinks';
import type { ColourBy, GraphDto, GraphFilters, HighlightKind, PageLinkDto, SizeBy } from '../lib/seoInternalLinks';
import { useSeoInternalLinksStore } from '../store/seoInternalLinksStore';

const SeoGraphCanvas = lazy(() => import('./SeoGraphCanvas'));

const LOCATION_LABEL = { nav: 'nav', header: 'header', footer: 'footer', body: 'body' } as const;

function LinkRows({ links, empty, onPick }: { links: PageLinkDto[]; empty: string; onPick: (url: string) => void }) {
  if (!links.length) return <p className="m-0 text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="m-0 grid list-none gap-1 p-0">
      {links.map((l, i) => (
        <li key={`${l.url}-${i}`}>
          <button type="button" className="w-full rounded px-1 py-0.5 text-left text-xs hover:bg-muted" onClick={() => onPick(l.url)}>
            <span className="break-all font-medium">{l.path}</span>
            <span className="block text-muted-foreground">
              “{l.anchor || 'no anchor'}” <span className="rounded bg-muted px-1">{LOCATION_LABEL[l.location]}</span>
              {l.nofollow && <span className="ml-1 rounded bg-muted px-1">nofollow</span>}
              {l.via && <span className="ml-1 rounded bg-warning/20 px-1">via redirect</span>}
              {l.broken && <span className="ml-1 rounded bg-destructive/20 px-1">broken</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Detail({ projectId, graph, index, onClose, onPick, onOpenPages }: { projectId: string; graph: GraphDto; index: number; onClose: () => void; onPick: (url: string) => void; onOpenPages?: (url: string) => void }) {
  const page = useSeoInternalLinksStore((s) => s.pageByProject[projectId]);
  const node = graph.nodes[index]!;
  const fresh = page?.page.url === node.url ? page : null;
  return (
    <aside className="w-full shrink-0 overflow-y-auto border-t bg-card p-4 text-sm lg:w-96 lg:border-l lg:border-t-0" aria-label="Page links">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 break-all text-sm font-semibold">{node.path}</h4>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <p className="m-0 mt-1 text-xs text-muted-foreground">
        {node.status ?? node.error ?? '—'} · {node.depth === null ? 'not reachable from home' : `${node.depth} click${node.depth === 1 ? '' : 's'} from home`} · {node.inbound} inbound · {node.outbound} outbound
        {node.orphan && <span className="ml-1 rounded bg-warning/20 px-1">Orphan: in a sitemap, nothing links to it</span>}
      </p>
      {onOpenPages && <Button size="sm" variant="outline" className="mt-2" onClick={() => onOpenPages(node.url)}>Open in Pages tab</Button>}
      {!fresh ? <p className="mt-3 text-xs text-muted-foreground">Loading links…</p> : (
        <>
          <h5 className="mb-1 mt-3 text-xs font-semibold uppercase text-muted-foreground">Linked from ({fresh.linkedFrom.total})</h5>
          <LinkRows links={fresh.linkedFrom.links} empty="No page links here." onPick={onPick} />
          <h5 className="mb-1 mt-3 text-xs font-semibold uppercase text-muted-foreground">Links to ({fresh.linksTo.total})</h5>
          <LinkRows links={fresh.linksTo.links} empty="This page has no internal links." onPick={onPick} />
          <p className="mt-2 text-xs text-muted-foreground">{fresh.page.externalLinks} external link{fresh.page.externalLinks === 1 ? '' : 's'} (counted, not followed)</p>
          {(fresh.linkedFrom.total > fresh.linkedFrom.links.length || fresh.linksTo.total > fresh.linksTo.links.length) && <p className="text-xs text-muted-foreground">The first 500 of each list are shown.</p>}
        </>
      )}
    </aside>
  );
}

/** The graph view: filters, size and colour, highlight chips, the Sigma canvas and a click-a-page panel. */
export function SeoGraphView({ projectId, graph, selectedUrl, onSelectUrl, onOpenPages }: { projectId: string; graph: GraphDto; selectedUrl: string | null; onSelectUrl: (url: string | null) => void; onOpenPages?: (url: string) => void }) {
  const [filters, setFilters] = useState<GraphFilters>(NO_FILTERS);
  const [sizeBy, setSizeBy] = useState<SizeBy>('inbound');
  const [colourBy, setColourBy] = useState<ColourBy>('section');
  const [on, setOn] = useState<Set<HighlightKind>>(new Set());
  const nodes = useMemo(() => visibleNodes(graph, filters), [graph, filters]);
  const edges = useMemo(() => visibleEdges(graph, nodes), [graph, nodes]);
  const marks = useMemo(() => highlighted(graph, on), [graph, on]);
  const sections = useMemo(() => sectionColours(graph.nodes), [graph]);
  const selected = selectedUrl === null ? null : graph.nodes.findIndex((n) => n.url === selectedUrl);
  const selectedIndex = selected === null || selected < 0 ? null : selected;
  useEffect(() => { void useSeoInternalLinksStore.getState().loadPage(projectId, selectedUrl); }, [projectId, selectedUrl, graph]);
  const patch = (change: Partial<GraphFilters>) => setFilters((f) => ({ ...f, ...change }));
  const toggle = (kind: HighlightKind) => setOn((current) => { const next = new Set(current); if (!next.delete(kind)) next.add(kind); return next; });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2" aria-label="Graph filters">
        <Input aria-label="Search pages" className="w-48" placeholder="Search pages" value={filters.search} onChange={(e) => patch({ search: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { const hit = firstMatch(graph, filters); if (hit !== null) onSelectUrl(graph.nodes[hit]!.url); } }} />
        <select aria-label="Section" className="h-9 rounded-md border bg-background px-2 text-sm" value={filters.section} onChange={(e) => patch({ section: e.target.value })}>
          <option value="all">All sections</option>{sectionsOf(graph).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Status" className="h-9 rounded-md border bg-background px-2 text-sm" value={filters.status} onChange={(e) => patch({ status: e.target.value as GraphFilters['status'] })}>
          <option value="all">Any status</option><option value="ok">2xx</option><option value="redirect">3xx</option><option value="error">4xx / 5xx / failed</option>
        </select>
        <label className="flex items-center gap-1 text-sm">Max clicks
          <Input aria-label="Max depth" type="number" min={0} className="w-20" value={filters.maxDepth ?? ''} onChange={(e) => patch({ maxDepth: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} />
        </label>
        <label className="flex items-center gap-1 text-sm">Min inbound
          <Input aria-label="Min inbound" type="number" min={0} className="w-20" value={filters.minInbound} onChange={(e) => patch({ minInbound: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <select aria-label="Node size" className="h-9 rounded-md border bg-background px-2 text-sm" value={sizeBy} onChange={(e) => setSizeBy(e.target.value as SizeBy)}>
          <option value="inbound">Size by inbound links</option><option value="clicks">Size by clicks from home</option>
        </select>
        <select aria-label="Node colour" className="h-9 rounded-md border bg-background px-2 text-sm" value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)}>
          <option value="section">Colour by section</option><option value="status">Colour by status</option><option value="indexing">Colour by indexing</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Highlights">
        {HIGHLIGHTS.map((h) => (
          <button key={h.key} type="button" aria-pressed={on.has(h.key)} onClick={() => toggle(h.key)}
            className={`rounded-full border px-3 py-1 text-xs ${on.has(h.key) ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:bg-muted'}`}>{h.label}</button>
        ))}
      </div>
      <p className="m-0 text-xs text-muted-foreground" aria-live="polite">{showingText(graph, nodes, edges)} · size by {sizeBy === 'inbound' ? 'inbound links' : 'clicks from home'} · deeper than {graph.thresholds.deepClicks} clicks and fewer than {graph.thresholds.fewInbound} inbound links count as deep and few.</p>
      <div className="flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-xl border bg-card lg:flex-row">
        <div className="relative min-h-[320px] min-w-0 flex-1">
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading graph…</div>}>
            <SeoGraphCanvas graph={graph} visible={nodes} sizeBy={sizeBy} colourBy={colourBy} highlightNodes={marks.nodes} highlightEdges={marks.edges} selected={selectedIndex} onSelect={(i) => onSelectUrl(i === null ? null : graph.nodes[i]!.url)} />
          </Suspense>
          <ul className="absolute bottom-2 left-2 m-0 flex list-none flex-wrap gap-2 rounded bg-background/80 p-1 text-xs" aria-label="Legend">
            {legendFor(colourBy, sections).map((l) => <li key={l.label} className="flex items-center gap-1"><span className="inline-block size-2 rounded-full" style={{ background: l.colour }} />{l.label}</li>)}
          </ul>
        </div>
        {selectedIndex !== null && <Detail projectId={projectId} graph={graph} index={selectedIndex} onClose={() => onSelectUrl(null)} onPick={onSelectUrl} onOpenPages={onOpenPages} />}
      </div>
    </div>
  );
}
