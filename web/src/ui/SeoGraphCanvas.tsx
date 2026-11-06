import { useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import Sigma from 'sigma';
import { layoutBudget, nodeColour, nodeRadius, sectionColours } from '../lib/seoInternalLinks';
import { onThemeChange, readToken, withAlpha } from '../lib/themeColour';
import type { ColourBy, GraphDto, SizeBy } from '../lib/seoInternalLinks';

export interface GraphCanvasProps {
  graph: GraphDto;
  visible: Set<number>;
  sizeBy: SizeBy;
  colourBy: ColourBy;
  highlightNodes: Set<number>;
  highlightEdges: Set<number>;
  selected: number | null;
  onSelect: (index: number | null) => void;
}

/** The colours the graph draws around its data (edges, dimmed nodes, the selection), read from the theme tokens. */
const chromeColours = () => ({ muted: readToken('--sc-muted-foreground'), selected: readToken('--sc-foreground'), highlight: readToken('--sc-destructive') });

const webglAvailable = () => {
  try { return !!document.createElement('canvas').getContext('webgl'); } catch { return false; }
};

/**
 * The graph, drawn with Sigma.js (WebGL). The layout (ForceAtlas2) runs in a worker for a time that shrinks as the graph grows,
 * then stops, so a few thousand pages neither freeze the page nor keep the CPU busy. Filters and highlights only change what
 * the reducers return; the graph itself is built once per snapshot.
 */
export default function SeoGraphCanvas(props: GraphCanvasProps) {
  const { graph: dto } = props;
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const latest = useRef(props);
  useEffect(() => { latest.current = props; });
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    if (!webglAvailable()) { setUnsupported(true); return; }
    const budget = layoutBudget(dto.nodes.length);
    let chrome = chromeColours();
    const g = new Graph({ multi: false, type: 'directed' });
    const radius = Math.sqrt(dto.nodes.length) * 8;
    dto.nodes.forEach((n, i) => {
      const angle = i * 2.399963;
      const r = radius * Math.sqrt((i + 1) / dto.nodes.length);
      g.addNode(String(i), { x: r * Math.cos(angle), y: r * Math.sin(angle), size: 3, label: budget.labels ? n.path : '' });
    });
    const edgeIndex = new Map<string, number>();
    dto.edges.forEach(([from, to], i) => {
      const key = `${from}>${to}`;
      if (from !== to && !edgeIndex.has(key)) { g.addEdgeWithKey(key, String(from), String(to)); edgeIndex.set(key, i); }
    });
    // Computed once per snapshot: the reducers run for every node and edge on every refresh.
    const sections = sectionColours(dto.nodes);
    const maxInbound = Math.max(1, ...dto.nodes.map((n) => n.inbound));
    const maxDepth = Math.max(1, ...dto.nodes.map((n) => n.depth ?? 0));
    let layout: FA2Layout | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sigma: Sigma | null = null;
    try {
      sigma = new Sigma(g, container.current, {
        renderLabels: budget.labels, enableEdgeEvents: false, defaultEdgeColor: withAlpha(chrome.muted, budget.thinEdges ? 0.2 : 0.4), hideEdgesOnMove: dto.nodes.length > 1500, labelRenderedSizeThreshold: 6,
        nodeReducer: (key, attrs) => {
          const p = latest.current;
          const i = Number(key);
          const node = p.graph.nodes[i]!;
          const dim = !p.visible.has(i);
          const highlight = p.highlightNodes.has(i);
          const anyHighlight = p.highlightNodes.size > 0 || p.highlightEdges.size > 0;
          return {
            ...attrs, hidden: dim, color: p.selected === i ? chrome.selected : anyHighlight && !highlight ? withAlpha(chrome.muted, 0.33) : nodeColour(node, p.colourBy, sections),
            size: nodeRadius(node, p.sizeBy, maxInbound, maxDepth) * (highlight ? 1.4 : 1), zIndex: p.selected === i || highlight ? 2 : 1, forceLabel: p.selected === i,
          };
        },
        edgeReducer: (key, attrs) => {
          const p = latest.current;
          const [source, target] = g.extremities(key).map(Number);
          if (!p.visible.has(source!) || !p.visible.has(target!)) return { ...attrs, hidden: true };
          return p.highlightEdges.has(edgeIndex.get(key)!) ? { ...attrs, color: chrome.highlight, size: 1.5, zIndex: 2 } : attrs;
        },
      });
      sigma.on('clickNode', ({ node }) => latest.current.onSelect(Number(node)));
      sigma.on('clickStage', () => latest.current.onSelect(null));
      sigmaRef.current = sigma;
      const settings = forceAtlas2.inferSettings(g);
      layout = new FA2Layout(g, { settings });
      layout.start();
      timer = setTimeout(() => layout?.stop(), Math.min(20_000, budget.iterations * 40));
    } catch {
      setUnsupported(true);
    }
    const stopThemeSync = onThemeChange(() => { chrome = chromeColours(); sigma?.setSetting('defaultEdgeColor', withAlpha(chrome.muted, budget.thinEdges ? 0.2 : 0.4)); sigma?.refresh(); });
    return () => {
      stopThemeSync();
      if (timer) clearTimeout(timer);
      layout?.kill();
      sigma?.kill();
      sigmaRef.current = null;
    };
  }, [dto]);

  useEffect(() => { sigmaRef.current?.refresh(); }, [props.visible, props.sizeBy, props.colourBy, props.highlightNodes, props.highlightEdges, props.selected]);

  if (unsupported) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground" role="status">The graph needs WebGL, which this browser does not offer. The page list below still works.</div>;
  }
  return <div ref={container} className="h-full w-full" aria-label="Internal links graph" role="img" />;
}
