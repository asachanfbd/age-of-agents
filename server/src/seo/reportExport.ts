import { SeoInputError } from './errors.ts';
import { csvLine } from './keywordCsv.ts';
import type { LinkRow, Mover, MoverLists, ReportData, Tile } from './reportBuild.ts';

export const CSV_TABLES = ['scorecard', 'pages', 'keywords', 'clusters', 'backlinks', 'indexing', 'internal-links', 'work'] as const;
export type CsvTable = (typeof CSV_TABLES)[number];

export function requireCsvTable(value: unknown): CsvTable {
  if (value === undefined || value === '') return 'scorecard';
  if (typeof value !== 'string' || !(CSV_TABLES as readonly string[]).includes(value)) throw new SeoInputError(`table must be one of ${CSV_TABLES.join(', ')}`);
  return value as CsvTable;
}

const NOT_CONNECTED = 'Not connected';
const NO_DATA = 'no data';
const NOT_AVAILABLE = 'not available yet';

const number = (n: number, unit: Tile['unit']): string => (unit === 'percent' ? `${n}%` : String(n));

/** What a tile shows for one side: its value, or the reason there is none. */
export function sideText(tile: Tile, side: 'current' | 'previous'): string {
  if (tile.state === 'not-connected') return NOT_CONNECTED;
  if (tile.state === 'not-available') return NOT_AVAILABLE;
  const value = tile[side];
  return value === null ? NO_DATA : number(value, tile.unit);
}

const verdictWord = (tile: Tile): string => (tile.verdict ?? '');

/** The change as text: "▲ +12 (+8.5%) better", or the reason there is none. */
export function changeText(tile: Tile): string {
  if (tile.state !== 'ok' || tile.change === null) return '';
  const sign = tile.change > 0 ? '+' : '';
  const pct = tile.isNew ? 'new' : tile.changePct === null ? '' : `${tile.changePct > 0 ? '+' : ''}${tile.changePct}%`;
  const unit = tile.unit === 'percent' ? ' points' : '';
  return `${tile.glyph} ${sign}${tile.change}${unit}${pct ? ` (${pct})` : ''} ${verdictWord(tile)}${tile.perDay ? ' per day' : ''}`.trim();
}

const period = (w: { from: string; to: string } | null): string => (w ? `${w.from} to ${w.to}` : 'no data');

/** The range line: "2026-09-17 to 2026-10-14 vs 2026-08-20 to 2026-09-16". */
export const periodLabel = (r: ReportData): string => `${period(r.period.current)} vs ${period(r.period.previous)}`;

const moverRows = (lists: MoverLists): Array<Array<string | number | null>> => {
  const row = (kind: string, m: Mover) => [kind, m.name, m.clicksPrevious, m.clicksCurrent, m.change, m.impressions, m.positionPrevious === null ? null : Math.round(m.positionPrevious * 10) / 10, m.positionCurrent === null ? null : Math.round(m.positionCurrent * 10) / 10];
  return [
    ...lists.gains.map((m) => row('gain', m)), ...lists.losses.map((m) => row('loss', m)),
    ...lists.positionGains.map((m) => row('position gain', m)), ...lists.positionLosses.map((m) => row('position loss', m)),
  ];
};

const NOT_AVAILABLE_BACKLINKS = 'Not available yet: import backlinks first.';
const NOT_AVAILABLE_INDEXING = 'Not available yet: no sitemap URLs.';

/** The internal-link changes as rows: the counts, then the sampled added and removed links. */
const internalLinkRows = (r: ReportData): Array<Array<string | number | null>> => {
  const il = r.internalLinks;
  if (!il.available) return [['status', il.reason ?? NOT_AVAILABLE]];
  return [
    ['links added', il.added], ['links removed', il.removed], ['orphan pages before', il.orphansBefore], ['orphan pages now', il.orphansAfter],
    ...il.addedSample.map((e) => ['added', e]), ...il.removedSample.map((e) => ['removed', e]), ...il.newlyOverLimit.map((u) => ['newly over 100 outgoing links', u]),
  ];
};

const internalLinkText = (r: ReportData): string => (r.internalLinks.available
  ? `${r.internalLinks.added} links added, ${r.internalLinks.removed} removed. Orphan pages: ${r.internalLinks.orphansBefore} before, ${r.internalLinks.orphansAfter} now.`
  : (r.internalLinks.reason ?? NOT_AVAILABLE));

const linkRows = (kind: string, rows: LinkRow[]) => rows.map((l) => [kind, l.sourceUrl, l.targetUrl, l.sourceHost, l.dr ?? NO_DATA, l.ur ?? NO_DATA, l.on]);

/** One table of the report as CSV. Cells that start with `=`, `+`, `-` or `@` are neutralised by `csvLine`. */
export function reportCsv(report: ReportData, table: CsvTable): string {
  const lines: Array<Array<string | number | null>> = [];
  if (table === 'scorecard') {
    lines.push(['Metric', 'Current', 'Comparison', 'Change', 'Note']);
    for (const t of report.tiles) lines.push([t.label, sideText(t, 'current'), sideText(t, 'previous'), changeText(t), t.note ?? t.detail ?? '']);
  } else if (table === 'pages' || table === 'keywords' || table === 'clusters') {
    lines.push(['Kind', table === 'pages' ? 'Page' : table === 'keywords' ? 'Keyword' : 'Cluster', 'Clicks (comparison)', 'Clicks (current)', 'Change', 'Impressions', 'Position (comparison)', 'Position (current)']);
    lines.push(...moverRows(report.movers[table]));
  } else if (table === 'backlinks') {
    lines.push(['Kind', 'Source', 'Target', 'Domain', 'DR', 'UR', 'Date']);
    lines.push(...linkRows('new', report.backlinks.added), ...linkRows('lost', report.backlinks.lost));
    lines.push(['coverage', report.backlinks.coverage.dr ?? NO_DATA, report.backlinks.coverage.ur ?? NO_DATA]);
  } else if (table === 'internal-links') {
    lines.push(['Item', 'Value'], ...internalLinkRows(report));
  } else if (table === 'indexing') {
    lines.push(['Kind', 'URL']);
    lines.push(...report.indexing.newlyIndexed.map((u) => ['newly indexed', u]), ...report.indexing.newlyExcluded.map((u) => ['newly excluded', u]));
  } else {
    lines.push(['Kind', 'Title', 'Type', 'Date']);
    lines.push(...report.work.tasks.map((w) => ['task', w.title, w.kind, w.at.slice(0, 10)]), ...report.work.agentRuns.map((w) => ['agent run', w.title, w.kind, w.at.slice(0, 10)]));
  }
  return `${lines.map(csvLine).join('\n')}\n`;
}

const mdCell = (text: string | number | null): string => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const mdTable = (head: string[], rows: Array<Array<string | number | null>>): string => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n');

export interface ExportMeta { name: string; savedAt: string | null }

/** The report as Markdown: the scorecard, the lists and the AI summary (marked as AI-generated). */
export function reportMarkdown(report: ReportData, meta: ExportMeta): string {
  const out: string[] = [`# ${meta.name}`, '', `${report.site} · ${periodLabel(report)}${meta.savedAt ? ` · saved ${meta.savedAt.slice(0, 10)}` : ''}`, ''];
  if (report.state === 'setup') return `${[...out, 'Nothing is set up yet.', '', ...report.setup.map((s) => `- ${s}`)].join('\n')}\n`;
  if (report.summary) out.push('## Summary (AI-generated)', '', report.summary.paragraph, '', ...report.summary.actions.map((a) => `- ${a}`), '');
  for (const n of report.notes) out.push(`> ${n}`);
  if (report.notes.length) out.push('');
  out.push('## Scorecard', '', mdTable(['Metric', 'Current', 'Comparison', 'Change'], report.tiles.map((t) => [t.label, sideText(t, 'current'), sideText(t, 'previous'), changeText(t)])), '');
  for (const key of ['pages', 'keywords', 'clusters'] as const) {
    const rows = moverRows(report.movers[key]);
    out.push(`## ${key[0]!.toUpperCase()}${key.slice(1)}: winners and losers`, '', rows.length ? mdTable(['Kind', 'Name', 'Clicks before', 'Clicks now', 'Change', 'Impressions', 'Position before', 'Position now'], rows) : `Nothing reached ${report.minImpressions} impressions in both periods.`, '');
  }
  out.push('## Backlinks', '');
  if (!report.backlinks.available) out.push(NOT_AVAILABLE_BACKLINKS, '');
  else {
    out.push(mdTable(['Kind', 'Source', 'Target', 'Domain', 'DR', 'UR', 'Date'], [...linkRows('new', report.backlinks.added), ...linkRows('lost', report.backlinks.lost)]), '');
    if (report.backlinks.coverage.dr) out.push(report.backlinks.coverage.dr, '');
  }
  out.push('## Indexing changes', '');
  out.push(report.indexing.available ? mdTable(['Kind', 'URL'], [...report.indexing.newlyIndexed.map((u) => ['newly indexed', u]), ...report.indexing.newlyExcluded.map((u) => ['newly excluded', u])]) : NOT_AVAILABLE_INDEXING, '');
  out.push('## Internal links', '', internalLinkText(report), '');
  out.push('## Work done', '', mdTable(['Kind', 'Title', 'Type', 'Date'], [...report.work.tasks.map((w) => ['task', w.title, w.kind, w.at.slice(0, 10)]), ...report.work.agentRuns.map((w) => ['agent run', w.title, w.kind, w.at.slice(0, 10)])]), '');
  return `${out.join('\n')}\n`;
}

const esc = (text: string | number | null): string => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const htmlTable = (head: string[], rows: Array<Array<string | number | null>>): string => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

/** A printable page (use the browser's "Save as PDF"). Every value is escaped. */
export function reportHtml(report: ReportData, meta: ExportMeta): string {
  const body: string[] = [`<h1>${esc(meta.name)}</h1>`, `<p>${esc(report.site)} · ${esc(periodLabel(report))}${meta.savedAt ? ` · saved ${esc(meta.savedAt.slice(0, 10))}` : ''}</p>`];
  if (report.state === 'setup') body.push(`<ul>${report.setup.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`);
  else {
    if (report.summary) body.push(`<h2>Summary (AI-generated)</h2><p>${esc(report.summary.paragraph)}</p><ul>${report.summary.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`);
    body.push(...report.notes.map((n) => `<p class="note">${esc(n)}</p>`));
    body.push('<h2>Scorecard</h2>', htmlTable(['Metric', 'Current', 'Comparison', 'Change'], report.tiles.map((t) => [t.label, sideText(t, 'current'), sideText(t, 'previous'), changeText(t)])));
    for (const key of ['pages', 'keywords', 'clusters'] as const) body.push(`<h2>${esc(key)}: winners and losers</h2>`, htmlTable(['Kind', 'Name', 'Clicks before', 'Clicks now', 'Change', 'Impressions', 'Position before', 'Position now'], moverRows(report.movers[key])));
    body.push('<h2>Backlinks</h2>', report.backlinks.available
      ? `${htmlTable(['Kind', 'Source', 'Target', 'Domain', 'DR', 'UR', 'Date'], [...linkRows('new', report.backlinks.added), ...linkRows('lost', report.backlinks.lost)])}${report.backlinks.coverage.dr ? `<p>${esc(report.backlinks.coverage.dr)}</p>` : ''}${report.backlinks.coverage.ur ? `<p>${esc(report.backlinks.coverage.ur)}</p>` : ''}`
      : `<p>${esc(NOT_AVAILABLE_BACKLINKS)}</p>`);
    body.push('<h2>Indexing changes</h2>', report.indexing.available
      ? htmlTable(['Kind', 'URL'], [...report.indexing.newlyIndexed.map((u) => ['newly indexed', u]), ...report.indexing.newlyExcluded.map((u) => ['newly excluded', u])])
      : `<p>${esc(NOT_AVAILABLE_INDEXING)}</p>`);
    body.push('<h2>Internal links</h2>', `<p>${esc(internalLinkText(report))}</p>`);
    body.push('<h2>Work done</h2>', htmlTable(['Kind', 'Title', 'Type', 'Date'], [...report.work.tasks.map((w) => ['task', w.title, w.kind, w.at.slice(0, 10)]), ...report.work.agentRuns.map((w) => ['agent run', w.title, w.kind, w.at.slice(0, 10)])]));
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(meta.name)}</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border:1px solid #bbb;padding:.25rem .5rem;text-align:left;font-size:.85rem}.note{font-style:italic}@media print{body{margin:0}}</style></head><body>${body.join('')}</body></html>`;
}

/** A file name safe for a Content-Disposition header. */
export const exportFileName = (name: string, extension: string): string => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'seo-report'}.${extension}`;
