import { redactSecrets } from '../redaction.ts';
import { checkHeaders, csvRecords, tableRows } from './csv.ts';
import type { CsvRow, RawRecord } from './csv.ts';
import { CrmInputError } from './errors.ts';
import type { ChannelMapping, Mapping } from './imports.ts';
import { CSV_MAX_ROWS } from './limits.ts';
import { CHANNEL_TYPES, normaliseEmail, normalisePhone } from './normalize.ts';
import type { ChannelType } from './normalize.ts';

/** Separator names on the wire, in the order a tie is resolved. */
export const SEPARATORS = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', none: null } as const;
export type SeparatorName = keyof typeof SEPARATORS;
const CANDIDATES: SeparatorName[] = ['tab', 'comma', 'semicolon', 'pipe'];

/** How many leading lines the separator and header detection look at. */
export const DETECT_LINES = 20;
/** How many rows the value-based role guess reads per column. */
export const GUESS_ROWS = 50;
/** Share of a column's non-empty values that must match a kind for the column to be that kind. */
export const MOST = 0.5;
/** Sample values per column shown to the owner. */
export const COLUMN_SAMPLES = 3;
/** Sample lines the agent sees; nothing else from the paste leaves the database. */
export const AGENT_SAMPLE_LINES = 5;
const AGENT_CELL_MAX = 200;
const PHONE_MIN_DIGITS = 5;

export interface PasteTable { separator: SeparatorName; hasHeader: boolean; headers: string[]; rows: CsvRow[]; rejected: Array<{ line: number; reason: string }> }

const sampleText = (text: string) => text.split(/\r\n|\r|\n/).filter((l) => l.trim()).slice(0, DETECT_LINES).join('\n');
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The most common cell count among complete records (the wider one on a tie) and how many records have it. */
function commonWidth(recs: RawRecord[]): { width: number; share: number } {
  const widths = recs.filter((r) => !r.unterminated).map((r) => r.cells.length);
  if (widths.length === 0) return { width: 1, share: 0 };
  const counts = new Map<number, number>();
  for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
  const [width, n] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
  return { width, share: n / widths.length };
}

/** The separator whose split of the first lines gives the most consistent column count above one; `none` when no split does. */
export function detectSeparator(text: string): SeparatorName {
  const sample = sampleText(stripBom(text));
  let best: { name: SeparatorName; score: number } = { name: 'none', score: 0 };
  for (const name of CANDIDATES) {
    const { width, share } = commonWidth(csvRecords(sample, SEPARATORS[name]));
    const score = width > 1 ? share : 0;
    if (score > best.score) best = { name, score };
  }
  return best.name;
}

const PLATFORM_HOSTS: Array<[ChannelType, RegExp]> = [
  ['linkedin', /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:linkedin\.com|lnkd\.in)(?:\/|$)/i],
  ['instagram', /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am)(?:\/|$)/i],
  ['facebook', /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.me)(?:\/|$)/i],
];

/** What one cell looks like: a handle of a channel type, a bare `@name` (some social network, which one is unknown), or text. */
export type ValueKind = ChannelType | 'at' | 'text';
export function valueKind(raw: string, countryCode: string | null): ValueKind {
  const v = raw.trim();
  if (normaliseEmail(v).ok) return 'email';
  for (const [type, re] of PLATFORM_HOSTS) if (re.test(v)) return type;
  if (/^@[^\s@]+$/.test(v)) return 'at';
  const phone = normalisePhone(v, countryCode);
  if (phone.ok && phone.value.length >= PHONE_MIN_DIGITS) return 'phone';
  return 'text';
}

/**
 * Header-name rules, kept in step with `guessMapping` in web/src/lib/crmImport.ts (a test compares the two) so a pasted
 * header row maps the way the same CSV header would.
 */
const HEADER_CHANNELS: Array<[ChannelType, RegExp]> = [
  ['email', /e-?mail|mail/i], ['phone', /phone|mobile|tel|cell/i], ['instagram', /insta/i], ['facebook', /facebook|fb/i], ['linkedin', /linked/i],
];
const HEADER_FIELDS: Array<['name' | 'company' | 'title' | 'tags', RegExp]> = [
  ['name', /^(full )?name$|contact/i], ['company', /company|organi[sz]ation|org$/i], ['title', /title|role|position/i], ['tags', /^(tags?|labels?)$/i],
];
const headerWord = (h: string) => HEADER_CHANNELS.some(([, re]) => re.test(h)) || HEADER_FIELDS.some(([, re]) => re.test(h));

/**
 * The first record is a header when its cells are distinct names that are not handles, and either a later line holds a
 * handle or one of the names is a known header word.
 */
export function detectHeader(records: RawRecord[], countryCode: string | null): boolean {
  const [head, ...rest] = records;
  if (!head || rest.length === 0 || head.unterminated) return false;
  const cells = head.cells.map((c) => c.trim());
  if (cells.some((c) => !c) || new Set(cells.map((c) => c.toLowerCase())).size !== cells.length) return false;
  const isHandle = (v: string) => v.trim() !== '' && valueKind(v, countryCode) !== 'text';
  if (cells.some(isHandle)) return false;
  return cells.some(headerWord) || rest.slice(0, DETECT_LINES).some((r) => r.cells.some(isHandle));
}

const columnNames = (n: number) => Array.from({ length: n }, (_, i) => `Column ${i + 1}`);

/** Splits pasted text into a table. `separator` and `hasHeader` override detection; without a header, columns are "Column 1", "Column 2", …. */
export function readPaste(text: string, opts: { separator?: SeparatorName; hasHeader?: boolean; countryCode: string | null }): PasteTable {
  const src = stripBom(text);
  const separator = opts.separator ?? detectSeparator(src);
  const recs = csvRecords(src, SEPARATORS[separator]);
  const hasHeader = opts.hasHeader ?? detectHeader(recs, opts.countryCode);
  if (hasHeader && recs[0]?.unterminated) throw new CrmInputError('The header row has an unterminated quote.', 'text');
  const headers = hasHeader ? checkHeaders(recs[0]?.cells ?? []) : columnNames(commonWidth(recs.slice(0, DETECT_LINES)).width);
  const data = hasHeader ? recs.slice(1) : recs;
  if (data.length === 0) throw new CrmInputError('Paste at least one line', 'text');
  if (data.length > CSV_MAX_ROWS) throw new CrmInputError(`The list has more than ${CSV_MAX_ROWS.toLocaleString('en-US')} lines.`, 'text');
  return { separator, hasHeader, headers, ...tableRows(data, headers.length) };
}

/** The first non-empty values of each column, for the owner to recognise it. */
export function columnSamples(table: PasteTable, n = COLUMN_SAMPLES): string[][] {
  return table.headers.map((_, i) => {
    const out: string[] = [];
    for (const row of table.rows) { const v = row.cells[i]!.trim(); if (v) out.push(v); if (out.length >= n) break; }
    return out;
  });
}

export type ColumnRole =
  | { role: 'channel'; type: ChannelType; label?: string }
  | { role: 'name' | 'company' | 'title' | 'tags' }
  | { role: 'custom'; fieldId: string }
  | { role: 'ignore' };

export interface RuleSuggestion { roles: Array<ColumnRole | null>; open: number[] }

const COMPANY_MARKER = /\b(?:pvt|ltd|limited|inc|llc|llp|plc|gmbh|corp|corporation|co\.|company|ag|bv|srl)(?:\b|$)/i;
const share = (values: string[], test: (v: string) => boolean) => values.length === 0 ? 0 : values.filter(test).length / values.length;

/** Remembers which channel types and fields are taken, so no two columns get one. */
class Taken {
  #used = new Set<string>();
  static key(r: ColumnRole): string | null {
    if (r.role === 'channel') return `channel:${r.type}:${r.type === 'other' ? (r.label ?? 'other').trim().toLowerCase() : ''}`;
    if (r.role === 'custom') return `custom:${r.fieldId}`;
    return r.role === 'ignore' ? null : r.role;
  }
  has(r: ColumnRole): boolean { const k = Taken.key(r); return k !== null && this.#used.has(k); }
  add(r: ColumnRole): void { const k = Taken.key(r); if (k) this.#used.add(k); }
}

function headerRole(header: string, customFields: Array<{ id: string; name: string }>, taken: Taken): ColumnRole | null {
  const field = customFields.find((f) => f.name.trim().toLowerCase() === header.trim().toLowerCase());
  const candidates: ColumnRole[] = [
    ...(field ? [{ role: 'custom', fieldId: field.id } as const] : []),
    ...HEADER_CHANNELS.filter(([, re]) => re.test(header)).map(([type]) => ({ role: 'channel', type }) as const),
    ...HEADER_FIELDS.filter(([, re]) => re.test(header)).map(([role]) => ({ role }) as const),
  ];
  return candidates.find((c) => !taken.has(c)) ?? null;
}

/**
 * Rules first: header names, then what most values in a column look like. A column the rules cannot place, or a second
 * column of a kind already taken, is left open for the agent or the owner. Pure.
 */
export function guessRoles(table: PasteTable, opts: { countryCode: string | null; customFields: Array<{ id: string; name: string }> }): RuleSuggestion {
  const n = table.headers.length;
  const roles: Array<ColumnRole | null> = Array(n).fill(null);
  const taken = new Taken();
  const set = (i: number, r: ColumnRole) => { roles[i] = r; taken.add(r); };
  if (table.hasHeader) table.headers.forEach((h, i) => { const r = headerRole(h, opts.customFields, taken); if (r) set(i, r); });
  const values = table.headers.map((_, i) => table.rows.slice(0, GUESS_ROWS).map((r) => r.cells[i]!.trim()).filter(Boolean));
  const text: number[] = [];
  for (let i = 0; i < n; i++) {
    if (roles[i]) continue;
    if (values[i]!.length === 0) { roles[i] = { role: 'ignore' }; continue; }
    const kinds = values[i]!.map((v) => valueKind(v, opts.countryCode));
    const type = CHANNEL_TYPES.find((t) => share(kinds, (k) => k === t) > MOST);
    if (type) { if (!taken.has({ role: 'channel', type })) set(i, { role: 'channel', type }); continue; }
    if (share(kinds, (k) => k === 'text') > MOST) text.push(i);
  }
  const unplaced = text.filter((i) => {
    if (share(values[i]!, (v) => COMPANY_MARKER.test(v)) > MOST && !taken.has({ role: 'company' })) { set(i, { role: 'company' }); return false; }
    return true;
  });
  if (unplaced.length === 1 && !taken.has({ role: 'name' })) set(unplaced[0]!, { role: 'name' });
  return { roles, open: roles.flatMap((r, i) => (r ? [] : [i])) };
}

/** The roles in the CSV mapping shape; ignored and open columns are left out. */
export function toMapping(headers: string[], roles: Array<ColumnRole | null>): Mapping {
  const channels: ChannelMapping[] = [];
  const m: Mapping = { channels };
  roles.forEach((r, i) => {
    const column = headers[i]!;
    if (!r || r.role === 'ignore') return;
    if (r.role === 'channel') channels.push(r.type === 'other' ? { column, type: r.type, label: r.label ?? 'other' } : { column, type: r.type });
    else if (r.role === 'custom') m.custom = { ...(m.custom ?? {}), [r.fieldId]: column };
    else m[r.role] = column;
  });
  return m;
}

export const AGENT_ROLES = ['name', 'company', 'title', 'tags', 'channel', 'ignore'] as const;
export interface AgentColumn { index: number; role: (typeof AGENT_ROLES)[number]; channelType?: ChannelType; label?: string }

/** Strictly reads the agent's `{ columns: [{ index, role, channelType?, label? }] }`; null when anything is off. */
export function parseAgentMapping(text: string, columnCount: number): AgentColumn[] | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const columns = (raw as { columns?: unknown }).columns;
  if (!Array.isArray(columns) || columns.length > columnCount) return null;
  const seen = new Set<number>();
  const out: AgentColumn[] = [];
  for (const c of columns as Array<Record<string, unknown>>) {
    if (typeof c !== 'object' || c === null) return null;
    const { index, role, channelType, label } = c;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= columnCount || seen.has(index as number)) return null;
    if (!AGENT_ROLES.includes(role as AgentColumn['role'])) return null;
    if (role === 'channel' ? !CHANNEL_TYPES.includes(channelType as ChannelType) : channelType !== undefined) return null;
    if (label !== undefined && typeof label !== 'string') return null;
    seen.add(index as number);
    out.push({ index: index as number, role: role as AgentColumn['role'], ...(role === 'channel' ? { channelType: channelType as ChannelType } : {}), ...(role === 'channel' && channelType === 'other' ? { label: (label as string | undefined)?.trim() || 'other' } : {}) });
  }
  return out;
}

/** Fills only the columns the rules left open; a role already taken is skipped. Returns the roles and the columns the agent filled. */
export function mergeAgent(rules: RuleSuggestion, answer: AgentColumn[]): { roles: Array<ColumnRole | null>; filled: number[] } {
  const roles = [...rules.roles];
  const taken = new Taken();
  for (const r of roles) if (r) taken.add(r);
  const filled: number[] = [];
  for (const a of answer) {
    if (!rules.open.includes(a.index)) continue;
    const role: ColumnRole = a.role === 'channel' ? { role: 'channel', type: a.channelType!, ...(a.label ? { label: a.label } : {}) } : { role: a.role };
    if (taken.has(role)) continue;
    roles[a.index] = role;
    taken.add(role);
    if (role.role !== 'ignore') filled.push(a.index);
  }
  return { roles, filled };
}

const promptCell = (v: string) => redactSecrets(v.trim()).slice(0, AGENT_CELL_MAX);

/** The header (when there is one) and at most `AGENT_SAMPLE_LINES` data lines, with stored secrets removed. */
export function mappingPrompt(table: PasteTable): string {
  const lines = table.rows.slice(0, AGENT_SAMPLE_LINES).map((r) => JSON.stringify(r.cells.map(promptCell)));
  return redactSecrets([
    `A pasted contact list has ${table.headers.length} column(s), indexed from 0.`,
    table.hasHeader ? `Header: ${JSON.stringify(table.headers.map(promptCell))}` : 'There is no header row.',
    'Sample lines (one JSON array of cells per line):',
    ...lines,
    `Say what each column holds. Roles: ${AGENT_ROLES.join(', ')}. A "channel" column also has "channelType", one of ${CHANNEL_TYPES.join(', ')}; an "other" channel may have a short "label".`,
    'Put only this JSON in "text": {"columns":[{"index":0,"role":"name"}]}',
  ].join('\n'));
}
