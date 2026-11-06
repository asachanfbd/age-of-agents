import { Html, Line } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import { linkLines, linkTooltip } from '../lib/connections';
import { buildingWorldPoint } from '../lib/villageLayout';
import { useWorldStore } from '../store/worldStore';
import { SCENE_HTML_Z_RANGE } from './htmlZIndex';

/** Lines sit above the ground, under the warehouses' roofs, so they read as a link between two Buildings. */
const LINE_HEIGHT = 0.9;
const LINK_COLOR = '#4f8fd6';
const BROKEN_COLOR = '#d6483f';

/**
 * The visible connections between linked Buildings: a line per link, warehouse to warehouse, dashed red when the link is broken. Hovering one
 * shows what it grants. The geometry (endpoints, the offset of a two-way pair) comes from `linkLines`, which has no
 * three.js in it and is tested directly.
 */
export function ConnectionLines() {
  const links = useWorldStore((s) => s.allLinks);
  const projects = useWorldStore((s) => s.projects);
  const loadAllLinks = useWorldStore((s) => s.loadAllLinks);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => { void loadAllLinks(); }, [loadAllLinks]);

  const lines = useMemo(() => linkLines(links, new Map(projects.map((p) => [p.id, buildingWorldPoint(p.position)] as const))), [links, projects]);
  const byId = useMemo(() => new Map(links.map((link) => [link.id, link])), [links]);

  return (
    <>
      {lines.map((line) => (
        <group key={line.id}>
          <Line
            points={[[line.from[0], LINE_HEIGHT, line.from[1]], [line.to[0], LINE_HEIGHT, line.to[1]]]}
            color={line.broken ? BROKEN_COLOR : LINK_COLOR}
            lineWidth={hovered === line.id ? 3 : 2}
            dashed={line.broken}
            dashSize={0.25}
            gapSize={0.15}
            onPointerOver={() => setHovered(line.id)}
            onPointerOut={() => setHovered((current) => (current === line.id ? null : current))}
          />
          {hovered === line.id && byId.get(line.id) && (
            <Html position={[(line.from[0] + line.to[0]) / 2, LINE_HEIGHT + 0.3, (line.from[1] + line.to[1]) / 2]} center zIndexRange={SCENE_HTML_Z_RANGE} style={{ pointerEvents: 'none' }}>
              <div className="whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow" role="tooltip">{linkTooltip(byId.get(line.id)!)}</div>
            </Html>
          )}
        </group>
      ))}
    </>
  );
}
