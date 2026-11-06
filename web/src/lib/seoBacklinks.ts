/**
 * Pure view-models for the Backlinks tab and its CSV import wizard, kept free of React so the rules are testable without a DOM.
 * Metrics the files did not give are `null`; they show as a dash, never as 0.
 */

export type LinkStatus = 'live' | 'new' | 'lost';
export type BacklinkView = 'all' | 'new' | 'lost' | 'domains' | 'targets';
export type ImportMode = 'full' | 'partial';

export interface BacklinkDto {
  uid: string;
  sourceUrl: string;
  sourceHost: string;
  targetUrl: string;
  anchor: string;
  linkType: string | null;
  firstSeen: string;
  lastSeen: string;
  status: LinkStatus;
  lostAt: string | null;
  sourceDr: number | null;
  sourceUr: number | null;
  sourceTraffic: number | null;
  pageDr: number | null;
  pageUr: number | null;
  pageTraffic: number | null;
  otherHost: boolean;
  extras: Record<string, string>;
  note: string;
}
export interface BacklinksDto { links: BacklinkDto[]; total: number; limit: number; offset: number }
export interface SummaryDto { total: number; referringDomains: number; newInPeriod: number; lostInPeriod: number; averageDr: number | null; withDr: number }
export interface OverviewDto { summary: SummaryDto; period: number; hasImports: boolean }
export interface DomainRollupDto { domain: string; links: number; bestDr: number | null; totalTraffic: number | null }
export interface TargetRollupDto { target: string; links: number; domains: number; bestDr: number | null; otherHost: boolean }
export interface BatchDto { seq: number; uid: string; fileName: string; mode: ImportMode; importedAt: string; fileRows: number; added: number; updated: number; unchanged: number; lost: number; returned: number; skipped: number }
export interface MappingDto { name: string; mapping: Record<string, string> }
export interface ProblemDto { row: number; message: string }

export interface ImportRequestDto { fileName: string; content: string; format?: string; mapping?: Record<string, string>; mode?: ImportMode; confirm?: boolean; rememberAs?: string }
export interface PreviewDto {
  encoding: string;
  delimiter: string;
  headers: string[];
  rows: number;
  presets: Array<{ id: string; name: string }>;
  suggested: string | null;
  needsMapping: boolean;
  mapping?: Record<string, string>;
  extraColumns?: string[];
  valid?: number;
  invalid?: number;
  duplicates?: number;
  problems?: ProblemDto[];
  problemsTotal?: number;
  willBeLost?: number;
  sample?: Array<Record<string, string | number | boolean | null>>;
}
export interface CommitDto { batch: BatchDto; counts: { added: number; updated: number; unchanged: number; lost: number; returned: number }; skipped: number }

export const MAX_FILE_BYTES = 15_000_000;
export const PERIODS = [{ days: 7, label: 'Last 7 days' }, { days: 28, label: 'Last 28 days' }, { days: 90, label: 'Last 90 days' }] as const;
export const DEFAULT_PERIOD = 28;
export const PAGE_SIZE = 50;

export const VIEWS: Array<{ key: BacklinkView; label: string }> = [
  { key: 'all', label: 'All links' }, { key: 'new', label: 'New in period' }, { key: 'lost', label: 'Lost in period' },
  { key: 'domains', label: 'Referring domains' }, { key: 'targets', label: 'Target pages' },
];
export const isListView = (view: BacklinkView): boolean => view === 'all' || view === 'new' || view === 'lost';

export const FIELD_LABELS: Record<string, string> = {
  sourceUrl: 'Source URL', targetUrl: 'Target URL', anchor: 'Anchor text', linkType: 'Link type', firstSeen: 'First seen', lastSeen: 'Last seen',
  sourceDr: 'Source DR', sourceUr: 'Source UR', sourceTraffic: 'Source traffic', pageDr: 'Linking page DR', pageUr: 'Linking page UR', pageTraffic: 'Linking page traffic',
};
export const MAPPABLE_FIELDS = Object.keys(FIELD_LABELS);
export const REQUIRED_FIELDS = ['sourceUrl', 'targetUrl'];

/** A missing value is a dash; a stored 0 is `0`. */
export function formatCell(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export const STATUS_LABEL: Record<LinkStatus, { label: string; tone: 'good' | 'neutral' | 'bad' }> = {
  live: { label: 'Live', tone: 'neutral' }, new: { label: 'New', tone: 'good' }, lost: { label: 'Lost', tone: 'bad' },
};

export interface Tile { label: string; value: string; note: string | null }

/** The summary strip. The average covers only domains with a DR, and the note says how many links have one. */
export function summaryTiles(s: SummaryDto): Tile[] {
  return [
    { label: 'Backlinks', value: formatCell(s.total), note: `${formatCell(s.withDr)} of ${formatCell(s.total)} links have DR` },
    { label: 'Referring domains', value: formatCell(s.referringDomains), note: null },
    { label: 'New in period', value: formatCell(s.newInPeriod), note: null },
    { label: 'Lost in period', value: formatCell(s.lostInPeriod), note: null },
    { label: 'Average DR', value: formatCell(s.averageDr), note: s.averageDr === null ? 'No DR in the imported data' : 'Of referring domains that have DR' },
  ];
}

export const extrasView = (extras: Record<string, string>): { text: string; title: string } => {
  const entries = Object.entries(extras);
  return entries.length ? { text: `${entries.length} extra${entries.length === 1 ? '' : 's'}`, title: entries.map(([k, v]) => `${k}: ${v}`).join('\n') } : { text: '—', title: '' };
};

export const pairView = (a: number | null, b: number | null): string => `${formatCell(a)} / ${formatCell(b)}`;

export interface Controls {
  view: BacklinkView;
  period: number;
  search: string;
  status: LinkStatus | '';
  type: string;
  drMin: string;
  drMax: string;
  domain: string;
  target: string;
  sort: string;
  dir: 'asc' | 'desc';
}
export const DEFAULT_CONTROLS: Controls = { view: 'all', period: DEFAULT_PERIOD, search: '', status: '', type: '', drMin: '', drMax: '', domain: '', target: '', sort: 'firstSeen', dir: 'desc' };

/** The DR range is valid when each bound is a number from 0 to 100 and the minimum is not above the maximum. */
export function drRangeError(min: string, max: string): string | null {
  const bad = (v: string) => v !== '' && !(Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100);
  if (bad(min) || bad(max)) return 'DR must be a number from 0 to 100.';
  return min !== '' && max !== '' && Number(min) > Number(max) ? 'The lowest DR cannot be above the highest.' : null;
}

/** Query string for the list and export routes; empty values are left out. */
export function listParams(c: Controls, offset = 0): URLSearchParams {
  const p = new URLSearchParams({ view: isListView(c.view) ? c.view : 'all', period: String(c.period), sort: c.sort, dir: c.dir, limit: String(PAGE_SIZE), offset: String(offset) });
  for (const [k, v] of [['search', c.search.trim()], ['status', c.status], ['type', c.type], ['drMin', c.drMin], ['drMax', c.drMax], ['domain', c.domain], ['target', c.target]] as const) if (v) p.set(k, v);
  return p;
}

// ---- import wizard -------------------------------------------------------------------------------------------------

export type WizardStep = 'file' | 'mapping' | 'preview' | 'done';

export function fileError(file: { name: string; size: number }): string | null {
  if (!/\.(csv|tsv|txt)$/i.test(file.name)) return 'That is not a CSV or TSV file. Export the links as .csv or .tsv.';
  if (file.size > MAX_FILE_BYTES) return `The file is larger than the ${MAX_FILE_BYTES / 1_000_000} MB limit. Split it into smaller files and import each one as a partial update.`;
  return null;
}

/** "Next" on the file step needs a usable file and an explicit full-or-partial choice: there is no default, because a wrong one would mark links lost. */
export const canContinueFromFile = (hasFile: boolean, error: string | null, mode: ImportMode | null): boolean => hasFile && error === null && mode !== null;

/** After the file step: a preset or saved mapping goes straight to the preview; anything else asks for a mapping first. */
export const stepAfterFile = (preview: Pick<PreviewDto, 'needsMapping'>): WizardStep => (preview.needsMapping ? 'mapping' : 'preview');

export function mappingError(mapping: Record<string, string>): string | null {
  for (const f of REQUIRED_FIELDS) if (!mapping[f]) return `${FIELD_LABELS[f]} needs a column.`;
  const columns = Object.values(mapping).filter(Boolean);
  return new Set(columns).size === columns.length ? null : 'Each column can be used for one field only.';
}

export function confirmLabel(valid: number, problems: number): { text: string; disabled: boolean } {
  return { text: problems > 0 ? `Import ${valid} valid rows` : `Import ${valid} rows`, disabled: valid === 0 };
}

export function problemLines(problems: ProblemDto[], total: number): string[] {
  const lines = problems.map((p) => `Row ${p.row}: ${p.message}`);
  return total > problems.length ? [...lines, `and ${total - problems.length} more`] : lines;
}

export const lostWarning = (mode: ImportMode | null, willBeLost: number): string | null =>
  mode === 'full' && willBeLost > 0 ? `${willBeLost} link${willBeLost === 1 ? '' : 's'} will be marked lost` : null;

export function completionText(c: CommitDto): string {
  const { added, updated, unchanged, lost } = c.counts;
  const parts = [`${added} added`, `${updated} updated`, `${unchanged} unchanged`];
  if (lost) parts.push(`${lost} marked lost`);
  if (c.skipped) parts.push(`${c.skipped} problem rows skipped`);
  return `Imported ${c.batch.fileName}: ${parts.join(', ')}.`;
}

// ---- link actions --------------------------------------------------------------------------------------------------

export type DeleteState = 'idle' | 'confirming';
/** Deleting needs a second click on the same link; choosing another link starts over. */
export function nextDeleteState(state: DeleteState, event: 'delete' | 'confirm' | 'cancel' | 'select'): { state: DeleteState; deleted: boolean } {
  if (event === 'delete') return { state: 'confirming', deleted: false };
  if (event === 'confirm') return { state: 'idle', deleted: state === 'confirming' };
  return { state: 'idle', deleted: false };
}

/** The tracking-task shortcut is shown only while the Tasks panel exists. */
export const canCreateTask = (hasTasksPanel: boolean): boolean => hasTasksPanel;
