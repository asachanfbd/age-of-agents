import { SeoConflictError, SeoInputError, SeoNotFoundError } from '../errors.ts';
import { isNode } from './analysis.ts';
import { DEEP_PAGE_CLICKS, FEW_INBOUND } from './rules.ts';
import { checkSnapshotId, latestSnapshot, listSnapshots, readSnapshot } from './store.ts';
import type { LinkRecord, PageRecord, Snapshot, SnapshotMeta } from './types.ts';

export const MAX_MATRIX_SIDE = 30;
export const MAX_LIST = 500;

/** The site section of a page: its first path segment, or "home" for `/`. */
export function sectionOf(url: string): string {
  const first = new URL(url).pathname.split('/').filter(Boolean)[0];
  return first ?? 'home';
}

const pathOf = (url: string) => { const u = new URL(url); return `${u.pathname}${u.search}`; };

/** The snapshot named by `?snapshot=`, or the newest one. */
export async function snapshotFor(buildingId: string, id: unknown): Promise<Snapshot> {
  if (id === undefined || id === '') {
    const latest = await latestSnapshot(buildingId);
    if (!latest) throw new SeoNotFoundError('No crawl has finished yet');
    return latest;
  }
  return readSnapshot(buildingId, checkSnapshotId(id));
}

const EDGE_NOFOLLOW = 1;
const EDGE_REDIRECT = 2;
const EDGE_BROKEN = 4;

/** Everything the graph draws. Edges are `[fromIndex, toIndex, flags, linkCount]`; flags add 1 (nofollow), 2 (via a redirect), 4 (target is broken). */
export function graphOf(snapshot: Snapshot) {
  const nodesList = snapshot.pages.filter(isNode);
  const index = new Map(nodesList.map((p, i) => [p.url, i]));
  const edges = new Map<string, [number, number, number, number]>();
  for (const l of snapshot.links) {
    const from = index.get(l.from);
    const to = index.get(l.to);
    if (from === undefined || to === undefined) continue;
    const key = `${from}>${to}`;
    const edge = edges.get(key) ?? [from, to, 0, 0];
    edge[2] |= (l.nofollow ? EDGE_NOFOLLOW : 0) | (l.via ? EDGE_REDIRECT : 0) | (l.broken ? EDGE_BROKEN : 0);
    edge[3] += 1;
    edges.set(key, edge);
  }
  return {
    snapshot: metaOf(snapshot),
    thresholds: { deepClicks: DEEP_PAGE_CLICKS, fewInbound: FEW_INBOUND },
    nodes: nodesList.map((p) => ({
      url: p.url, path: pathOf(p.url), section: sectionOf(p.url), status: p.status, error: p.error, depth: p.depth, inbound: p.inbound, outbound: p.outbound,
      noindex: p.noindex, canonicalElsewhere: !!p.canonical && normalCanonical(p.canonical) !== p.url, inSitemap: p.inSitemap, orphan: p.orphan, title: p.title,
    })),
    edges: [...edges.values()],
  };
}

function normalCanonical(canonical: string): string | null {
  try { const u = new URL(canonical); return `https://${u.host}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`; } catch { return null; }
}

export const metaOf = (s: SnapshotMeta): SnapshotMeta => {
  const { id, startedAt, finishedAt, status, stopReason, capped, incomplete, host, seededFrom, settings, stats, warning } = s;
  return { id, startedAt, finishedAt, status, stopReason, capped, incomplete, host, seededFrom, settings, stats, ...(warning ? { warning } : {}) };
};

const linkView = (l: LinkRecord, other: string) => ({ url: other, path: pathOf(other), anchor: l.anchor, location: l.location, nofollow: l.nofollow, via: l.via, broken: l.broken });

/** Who links to one page and where it links, with anchors; plus the addresses that redirect to it. */
export function pageLinks(snapshot: Snapshot, rawUrl: unknown) {
  const page = typeof rawUrl === 'string' ? snapshot.pages.find((p) => p.url === rawUrl && isNode(p)) : undefined;
  if (!page) throw new SeoNotFoundError('That page is not in this crawl');
  const from = snapshot.links.filter((l) => l.to === page.url);
  const to = snapshot.links.filter((l) => l.from === page.url);
  return {
    snapshot: metaOf(snapshot),
    page: pageView(page),
    linkedFrom: { total: from.length, links: from.slice(0, MAX_LIST).map((l) => linkView(l, l.from)) },
    linksTo: { total: to.length, links: to.slice(0, MAX_LIST).map((l) => linkView(l, l.to)) },
    redirectsFrom: snapshot.pages.filter((p) => p.redirectTo === page.url).map((p) => p.url).slice(0, MAX_LIST),
  };
}

export const pageView = (p: PageRecord) => ({
  url: p.url, path: pathOf(p.url), section: sectionOf(p.url), status: p.status, error: p.error, title: p.title, description: p.description, canonical: p.canonical, noindex: p.noindex,
  depth: p.depth, inbound: p.inbound, outbound: p.outbound, externalLinks: p.externalLinks, inSitemap: p.inSitemap, orphan: p.orphan, fetchedAt: p.fetchedAt,
});

function checkSide(value: unknown, name: string, snapshot: Snapshot): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new SeoInputError(`${name} must be a list of page addresses`);
  if (value.length > MAX_MATRIX_SIDE) throw new SeoInputError(`${name} can hold at most ${MAX_MATRIX_SIDE} pages`);
  const known = new Set(snapshot.pages.filter(isNode).map((p) => p.url));
  const unknown = (value as string[]).find((u) => !known.has(u));
  if (unknown !== undefined) throw new SeoInputError(`${name} contains a page that is not in this crawl`);
  return [...new Set(value as string[])];
}

export interface MatrixCell { count: number; anchors: string[]; locations: string[] }

/** Source rows by target columns for chosen pages (30 at most per side). A cell is null when no link exists or row and column are the same page. */
export function matrixOf(snapshot: Snapshot, body: { rows?: unknown; cols?: unknown }) {
  const rows = checkSide(body.rows, 'rows', snapshot);
  const cols = checkSide(body.cols, 'cols', snapshot);
  const rowAt = new Map(rows.map((u, i) => [u, i]));
  const colAt = new Map(cols.map((u, i) => [u, i]));
  const cells: Array<Array<MatrixCell | null>> = rows.map(() => cols.map(() => null));
  for (const l of snapshot.links) {
    const r = rowAt.get(l.from);
    const c = colAt.get(l.to);
    if (r === undefined || c === undefined) continue;
    const cell = cells[r]![c] ?? (cells[r]![c] = { count: 0, anchors: [], locations: [] });
    cell.count += 1;
    if (!cell.anchors.includes(l.anchor)) cell.anchors.push(l.anchor);
    if (!cell.locations.includes(l.location)) cell.locations.push(l.location);
  }
  const count = (cell: MatrixCell | null) => cell?.count ?? 0;
  return {
    snapshot: metaOf(snapshot),
    rows: rows.map((url) => ({ url, path: pathOf(url) })),
    cols: cols.map((url) => ({ url, path: pathOf(url) })),
    cells,
    rowTotals: cells.map((r) => r.reduce((t, c) => t + count(c), 0)),
    colTotals: cols.map((_, c) => cells.reduce((t, r) => t + count(r[c]!), 0)),
  };
}

/** A cell that a spreadsheet would run as a formula gets a leading apostrophe. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function matrixCsv(matrix: ReturnType<typeof matrixOf>): string {
  const lines = [['source \\ target', ...matrix.cols.map((c) => c.url), 'total'].map(csvCell).join(',')];
  matrix.rows.forEach((row, r) => lines.push([row.url, ...matrix.cells[r]!.map((c) => c?.count ?? 0), matrix.rowTotals[r]!].map(csvCell).join(',')));
  lines.push(['total', ...matrix.colTotals, matrix.colTotals.reduce((a, b) => a + b, 0)].map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** A file name for the export: the chosen label (letters, digits, dashes) plus the crawl's date. */
export function matrixFileName(label: unknown, snapshot: SnapshotMeta): string {
  const clean = typeof label === 'string' ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : '';
  return `matrix-${clean ? `${clean}-` : ''}${snapshot.startedAt.slice(0, 10)}.csv`;
}

const linkKey = (l: LinkRecord) => `${l.from}\n${l.to}\n${l.anchor}`;
const capList = <T>(list: T[]) => ({ total: list.length, items: list.slice(0, MAX_LIST) });

export interface CompareResult {
  from: SnapshotMeta; to: SnapshotMeta;
  pagesAdded: ReturnType<typeof capList<string>>; pagesRemoved: ReturnType<typeof capList<string>>;
  statusChanged: ReturnType<typeof capList<{ url: string; from: number | null; to: number | null }>>;
  linksAdded: ReturnType<typeof capList<{ from: string; to: string; anchor: string }>>; linksRemoved: ReturnType<typeof capList<{ from: string; to: string; anchor: string }>>;
}

/** What changed from the older crawl to the newer one: pages by address, links by source, target and anchor. */
export function compareSnapshots(older: Snapshot, newer: Snapshot): CompareResult {
  const olderPages = new Map(older.pages.filter(isNode).map((p) => [p.url, p]));
  const newerPages = new Map(newer.pages.filter(isNode).map((p) => [p.url, p]));
  const olderLinks = new Map(older.links.map((l) => [linkKey(l), l]));
  const newerLinks = new Map(newer.links.map((l) => [linkKey(l), l]));
  const pair = (l: LinkRecord) => ({ from: l.from, to: l.to, anchor: l.anchor });
  return {
    from: metaOf(older), to: metaOf(newer),
    pagesAdded: capList([...newerPages.keys()].filter((u) => !olderPages.has(u))),
    pagesRemoved: capList([...olderPages.keys()].filter((u) => !newerPages.has(u))),
    statusChanged: capList([...newerPages.values()].filter((p) => olderPages.has(p.url) && olderPages.get(p.url)!.status !== p.status).map((p) => ({ url: p.url, from: olderPages.get(p.url)!.status, to: p.status }))),
    linksAdded: capList([...newerLinks.entries()].filter(([k]) => !olderLinks.has(k)).map(([, l]) => pair(l))),
    linksRemoved: capList([...olderLinks.entries()].filter(([k]) => !newerLinks.has(k)).map(([, l]) => pair(l))),
  };
}

/** Compares two crawls; by default the newest against the one before it. */
export async function compareForBuilding(buildingId: string, query: Record<string, unknown>): Promise<CompareResult> {
  const metas = await listSnapshots(buildingId);
  const toId = query.to === undefined || query.to === '' ? metas[0]?.id : checkSnapshotId(query.to);
  const fromId = query.from === undefined || query.from === '' ? metas.find((m) => m.id !== toId)?.id : checkSnapshotId(query.from);
  if (!toId || !fromId) throw new SeoConflictError('Comparing needs two crawls; only one exists so far');
  if (toId === fromId) throw new SeoInputError('Choose two different crawls to compare');
  return compareSnapshots(await readSnapshot(buildingId, fromId), await readSnapshot(buildingId, toId));
}
