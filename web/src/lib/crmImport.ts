import type { ChannelMappingDto, ChannelType, ImportResultDto, MappingDto, PasteSuggestDto, SeparatorName } from './crmTypes';

export const CSV_MAX_BYTES = 15 * 1_048_576;
export const CSV_MAX_ROWS = 50_000;
export const CHANNEL_OPTIONS: Array<{ value: ChannelType; label: string }> = [
  { value: 'email', label: 'Email' }, { value: 'phone', label: 'Phone' }, { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' }, { value: 'linkedin', label: 'LinkedIn' }, { value: 'other', label: 'Other' },
];

/** The same wording the server answers with, so a refusal reads the same before and after the request. */
export function precheckFile(bytes: number, dataRows?: number): string | null {
  if (bytes > CSV_MAX_BYTES) return `The file is larger than the ${CSV_MAX_BYTES / 1_048_576} MB limit.`;
  if (dataRows !== undefined && dataRows > CSV_MAX_ROWS) return `The file has more than ${CSV_MAX_ROWS.toLocaleString('en-US')} rows.`;
  return null;
}

/** Counts data rows without parsing cells: records outside quotes, header excluded, blank lines skipped. */
export function countRows(text: string): number {
  let quoted = false, rows = 0, lineHasContent = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') { quoted = !quoted; lineHasContent = true; }
    else if (!quoted && (c === '\n' || c === '\r')) { if (c === '\r' && text[i + 1] === '\n') i++; if (lineHasContent) rows++; lineHasContent = false; }
    else if (!/\s/.test(c) || quoted) lineHasContent = true;
  }
  if (lineHasContent) rows++;
  return Math.max(0, rows - 1);
}

const GUESS: Array<[ChannelType, RegExp]> = [
  ['email', /e-?mail|mail/i], ['phone', /phone|mobile|tel|cell/i], ['instagram', /insta/i], ['facebook', /facebook|fb/i], ['linkedin', /linked/i],
];
/** A starting mapping from the header names; the owner adjusts it. */
export function guessMapping(headers: string[]): MappingDto {
  const channels: ChannelMappingDto[] = [];
  const used = new Set<ChannelType>();
  for (const h of headers) for (const [type, re] of GUESS) if (!used.has(type) && re.test(h)) { channels.push({ column: h, type }); used.add(type); break; }
  const find = (re: RegExp) => headers.find((h) => re.test(h));
  const m: MappingDto = { channels };
  const name = find(/^(full )?name$|contact/i), company = find(/company|organi[sz]ation|org$/i), title = find(/title|role|position/i), tags = find(/^(tags?|labels?)$/i);
  if (name) m.name = name;
  if (company) m.company = company;
  if (title) m.title = title;
  if (tags) m.tags = tags;
  return m;
}

/** Shared by Preview and Import so the two cannot disagree about whether a mapping can be sent. */
export const channelBlocker = (mapping: MappingDto): string | null => mapping.channels.length === 0 ? 'Map at least one column to a channel.' : null;

/** Why Import cannot run yet, in the order the owner would fix it; null when it can. `noun` names what was previewed. */
export function commitBlocker(state: { content: string; mapping: MappingDto; previewed: boolean; preview: ImportResultDto | null }, noun: 'file' | 'list' = 'file'): string | null {
  if (state.content === '') return 'Still reading the file. Try again in a moment.';
  const channel = channelBlocker(state.mapping);
  if (channel) return channel;
  if (!state.previewed || !state.preview) return `Preview the ${noun} first, then Import.`;
  if (state.preview.added + state.preview.existing + state.preview.duplicatesInFile === 0) return 'The preview found nothing to import. Check the column mapping and preview again.';
  return null;
}

export function countLines(r: Pick<ImportResultDto, 'added' | 'existing' | 'duplicatesInFile' | 'rejected'>, committed: boolean): string[] {
  return [
    `${r.added} ${committed ? 'added' : 'would be added'}`, `${r.existing} already existing`, `${r.duplicatesInFile} duplicates inside the file`, `${r.rejected} rejected`,
  ];
}

export function validateHandForm(f: { channel: string; handle: string }): string | null {
  if (!CHANNEL_OPTIONS.some((o) => o.value === f.channel)) return 'Choose a channel type.';
  if (!f.handle.trim()) return 'Enter a handle: an email, phone number or profile.';
  return null;
}
export function resultMessage(r: ImportResultDto): string {
  const parts = countLines(r, r.committed).join(', ');
  return r.reopenOffers.length ? `${parts}. ${r.reopenOffers.length} matched a lost contact: you can reopen it.` : parts;
}

/** The header cells of the first record (quotes honoured), so the owner can map columns before anything is sent. */
export function readHeaders(text: string): string[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const cells: string[] = [];
  let cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; continue; }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { cells.push(cell.trim()); cell = ''; }
    else if (c === '\n' || c === '\r') break;
    else cell += c;
  }
  cells.push(cell.trim());
  return cells.filter((h, i) => h !== '' || i < cells.length - 1);
}

// ---- mapping edits, shared by the CSV and paste grids ------------------------------

/** Maps `column` to the channel (or unmaps it when empty); an Other channel starts with the label "other". */
export function withChannel(m: MappingDto, type: ChannelType, column: string): MappingDto {
  const kept = m.channels.find((c) => c.type === type);
  const label = type === 'other' ? { label: kept?.label ?? 'other' } : {};
  return { ...m, channels: [...m.channels.filter((c) => c.type !== type), ...(column ? [{ column, type, ...label }] : [])] };
}
export function withOtherLabel(m: MappingDto, label: string): MappingDto {
  return { ...m, channels: m.channels.map((c) => (c.type === 'other' ? { ...c, label } : c)) };
}
export function withField(m: MappingDto, field: 'name' | 'company' | 'title' | 'tags', column: string): MappingDto {
  const next = { ...m };
  if (column) next[field] = column; else delete next[field];
  return next;
}
export function withCustom(m: MappingDto, id: string, column: string): MappingDto {
  const custom = { ...(m.custom ?? {}) };
  if (column) custom[id] = column; else delete custom[id];
  return { ...m, custom };
}

// ---- paste a list -----------------------------------------------------------------

export const SEPARATOR_OPTIONS: Array<{ value: SeparatorName; label: string }> = [
  { value: 'tab', label: 'Tab' }, { value: 'comma', label: 'Comma' }, { value: 'semicolon', label: 'Semicolon' }, { value: 'pipe', label: 'Pipe' }, { value: 'none', label: 'None (one column)' },
];

/** The detected columns of the text they were detected from. */
export interface DetectedPaste extends PasteSuggestDto { text: string }
export interface PasteState { detected: DetectedPaste; mapping: MappingDto; agentColumns: string[]; previewed: boolean; preview: ImportResultDto | null }

/** A fresh suggestion replaces the mapping and any earlier preview. */
export function applySuggestion(text: string, s: PasteSuggestDto): PasteState {
  return { detected: { ...s, text }, mapping: s.mapping, agentColumns: s.columns.filter((c) => c.byAgent).map((c) => c.name), previewed: false, preview: null };
}

/** Why Preview cannot run yet: no text, columns not (re)detected for this text, or no channel column. */
export function pasteBlocker(state: { text: string; detectedText: string | null; mapping: MappingDto }): string | null {
  if (!state.text.trim()) return 'Paste at least one line.';
  if (state.detectedText === null) return 'Detect columns before you preview.';
  if (state.detectedText !== state.text) return 'Detect columns again before you preview.';
  return channelBlocker(state.mapping);
}

const FIELD_LABELS = { name: 'Name', company: 'Company', title: 'Title', tags: 'Tags' } as const;

/** What one column is mapped to, as labels; `["Not mapped"]` when nothing. */
export function columnRoles(m: MappingDto, column: string, customFields: Array<{ id: string; name: string }> = []): string[] {
  const out = [
    ...m.channels.filter((c) => c.column === column).map((c) => (c.type === 'other' ? `Other (${c.label || 'other'})` : CHANNEL_OPTIONS.find((o) => o.value === c.type)!.label)),
    ...(Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>).filter((f) => m[f] === column).map((f) => FIELD_LABELS[f]),
    ...Object.entries(m.custom ?? {}).filter(([, col]) => col === column).map(([id]) => customFields.find((f) => f.id === id)?.name ?? id),
  ];
  return out.length ? out : ['Not mapped'];
}

/** Columns whose roles differ between two mappings: an owner edit there removes the agent's tag. */
export function changedColumns(before: MappingDto, after: MappingDto, columns: string[]): string[] {
  return columns.filter((c) => columnRoles(before, c).join() !== columnRoles(after, c).join());
}

export function suggestionNote(s: Pick<PasteSuggestDto, 'agentUsed' | 'agentError'>): string {
  if (s.agentError) return `Suggested without the agent: ${s.agentError}. Check the columns below.`;
  if (s.agentUsed) return 'The agent suggested the columns the rules could not place. Check them below.';
  return 'Suggested from the column names and values. Check them below.';
}

export function shapeText(columns: number, lines: number): string {
  return `${columns} ${columns === 1 ? 'column' : 'columns'}, ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}
