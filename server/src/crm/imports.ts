import { redactSecrets } from '../redaction.ts';
import type { CrmCtx } from './context.ts';
import { channelOwner, cleanCustom, cleanTags, insertContact } from './contacts.ts';
import type { ContactFields, NewChannel } from './contacts.ts';
import { decodeCsv, parseCsv } from './csv.ts';
import type { CsvRow, ParsedCsv } from './csv.ts';
import { CrmInputError } from './errors.ts';
import { CSV_MAX_BYTES, PASTE_AGENT_TIMEOUT_MS } from './limits.ts';
import { CHANNEL_TYPES, normaliseHandle } from './normalize.ts';
import type { ChannelType } from './normalize.ts';
import { SEPARATORS, columnSamples, guessRoles, mappingPrompt, mergeAgent, parseAgentMapping, readPaste, toMapping } from './pasteColumns.ts';
import type { PasteTable, SeparatorName } from './pasteColumns.ts';
import { addEntry } from './timeline.ts';
import { withTimeout } from './workUpdates.ts';
import { localDay } from './zoned.ts';

export interface ChannelMapping { column: string; type: ChannelType; label?: string }
export interface Mapping { channels: ChannelMapping[]; name?: string; company?: string; title?: string; tags?: string; custom?: Record<string, string> }

export interface ImportCounts { added: number; existing: number; duplicatesInFile: number; rejected: number }
export interface ImportResult extends ImportCounts {
  rejectedRows: Array<{ line: number; reason: string }>;
  rejectedTruncated: boolean;
  /** Existing contacts the import matched that are lost: the owner can Reopen them. */
  reopenOffers: Array<{ contactId: number; line: number }>;
  batchId: number | null;
  committed: boolean;
}

export const REJECTED_LIST_MAX = 1_000;
const CHUNK = 2_000;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

interface RowInput {
  line: number;
  channels: Array<{ type: ChannelType; label: string; raw: string }>;
  fields: { name: string | null; company: string | null; title: string | null; tags: string[]; custom: Record<string, string> };
}

interface Planned { fields: ContactFields; channels: NewChannel[]; line: number }
interface Plan { counts: ImportCounts; rejected: Array<{ line: number; reason: string }>; added: Planned[]; again: Array<{ contactId: number; line: number }>; reopenOffers: ImportResult['reopenOffers'] }

const key = (c: { type: string; label: string; norm: string }) => `${c.type}\u0000${c.label}\u0000${c.norm}`;

function checkMapping(raw: unknown, headers: string[]): Mapping {
  const m = (raw ?? {}) as Mapping;
  if (!Array.isArray(m.channels) || m.channels.length === 0) throw new CrmInputError('Map at least one column to a channel', 'mapping');
  const has = new Set(headers);
  const seen = new Set<string>();
  for (const c of m.channels) {
    if (!has.has(c?.column)) throw new CrmInputError(`Column "${c?.column}" is not in the file`, 'mapping');
    if (!CHANNEL_TYPES.includes(c.type)) throw new CrmInputError(`"${c.type}" is not a channel type`, 'mapping');
    const k = `${c.type}:${c.type === 'other' ? (c.label ?? '').trim().toLowerCase() : ''}`;
    if (seen.has(k)) throw new CrmInputError(`Two columns are mapped to ${c.type}`, 'mapping');
    seen.add(k);
  }
  for (const f of ['name', 'company', 'title', 'tags'] as const) if (m[f] !== undefined && !has.has(m[f]!)) throw new CrmInputError(`Column "${m[f]}" is not in the file`, 'mapping');
  for (const col of Object.values(m.custom ?? {})) if (!has.has(col)) throw new CrmInputError(`Column "${col}" is not in the file`, 'mapping');
  return m;
}

async function plan(ctx: CrmCtx, inputs: RowInput[], preRejected: Array<{ line: number; reason: string }>): Promise<Plan> {
  const counts: ImportCounts = { added: 0, existing: 0, duplicatesInFile: 0, rejected: preRejected.length };
  const rejected = [...preRejected];
  const added: Planned[] = [];
  const seen = new Map<string, Planned>();
  const again: Plan['again'] = [];
  const reopenOffers: Plan['reopenOffers'] = [];
  const lostCheck = ctx.db.prepare("SELECT segment FROM contacts WHERE id = ?");
  const cc = ctx.settings().countryCode;
  for (let i = 0; i < inputs.length; i++) {
    if (i > 0 && i % CHUNK === 0) await yieldLoop();
    const row = inputs[i]!;
    const channels: NewChannel[] = [];
    let reason: string | null = null;
    for (const c of row.channels) {
      const n = normaliseHandle(c.type, c.raw, { countryCode: cc, label: c.label });
      if (!n.ok) { reason = `${n.reason}: ${c.raw}`; break; }
      if (!channels.some((x) => key(x) === key({ type: c.type, label: c.label, norm: n.value }))) channels.push({ type: c.type, label: c.label, handle: c.raw.trim(), norm: n.value });
    }
    if (!reason && channels.length === 0) reason = 'No handle';
    if (reason) { rejected.push({ line: row.line, reason }); counts.rejected++; continue; }
    const owner = channels.map((c) => channelOwner(ctx, c)).find(Boolean);
    if (owner) {
      counts.existing++;
      again.push({ contactId: owner.contactId, line: row.line });
      if (String((lostCheck.get(owner.contactId) as { segment: string }).segment).startsWith('lost')) reopenOffers.push({ contactId: owner.contactId, line: row.line });
      continue;
    }
    const earlier = channels.map((c) => seen.get(key(c))).find(Boolean);
    if (earlier) {
      counts.duplicatesInFile++;
      for (const c of channels) if (!seen.has(key(c))) { earlier.channels.push(c); seen.set(key(c), earlier); }
      continue;
    }
    const planned: Planned = { fields: row.fields, channels, line: row.line };
    for (const c of channels) seen.set(key(c), planned);
    added.push(planned);
    counts.added++;
  }
  counts.rejected = rejected.length;
  rejected.sort((a, b) => a.line - b.line);
  return { counts, rejected, added, again, reopenOffers };
}

function resultOf(p: Plan, batchId: number | null, committed: boolean): ImportResult {
  return {
    ...p.counts, rejectedRows: p.rejected.slice(0, REJECTED_LIST_MAX), rejectedTruncated: p.rejected.length > REJECTED_LIST_MAX,
    reopenOffers: p.reopenOffers.slice(0, REJECTED_LIST_MAX), batchId, committed,
  };
}

/** Writes the plan in one transaction: either the whole batch lands or none of it. */
function apply(ctx: CrmCtx, p: Plan, batch: { name: string; kind: 'csv' | 'paste'; fileName: string | null; tags: string[]; source: string }): number {
  return ctx.db.transaction(() => {
    const now = ctx.now();
    const batchId = Number(ctx.db.prepare('INSERT INTO batches (name, kind, fileName, tags, counts, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(batch.name, batch.kind, batch.fileName, JSON.stringify(batch.tags), JSON.stringify(p.counts), now).lastInsertRowid);
    for (const a of p.added) {
      const tags = [...new Set([...a.fields.tags, ...batch.tags])];
      insertContact(ctx, { ...a.fields, tags }, a.channels, { source: batch.source, batchId });
    }
    for (const a of p.again) addEntry(ctx, a.contactId, 'imported_again', `Seen again in ${batch.name} (line ${a.line})`, { batchId, tags: batch.tags, source: batch.source });
    return batchId;
  })();
}

function batchName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return fallback;
  if (typeof raw !== 'string') throw new CrmInputError('batchName must be text', 'batchName');
  if (raw.trim().length > 120) throw new CrmInputError('batchName must be at most 120 characters', 'batchName');
  return raw.trim();
}

/** One input per parsed row through the mapping; a row whose custom value is refused is rejected with its line. */
function rowInputs(ctx: CrmCtx, parsed: ParsedCsv, mapping: unknown): { inputs: RowInput[]; rejected: Array<{ line: number; reason: string }> } {
  const m = checkMapping(mapping, parsed.headers);
  const idx = new Map(parsed.headers.map((h, i) => [h, i]));
  const cell = (row: CsvRow, col?: string) => (col === undefined ? '' : (row.cells[idx.get(col)!] ?? '').trim());
  const fields = ctx.settings().customFields;
  for (const id of Object.keys(m.custom ?? {})) if (!fields.some((f) => f.id === id)) throw new CrmInputError(`Unknown custom field "${id}"`, 'mapping');
  const rejected = [...parsed.rejected];
  const inputs: RowInput[] = [];
  for (const row of parsed.rows) {
    try {
      inputs.push({
        line: row.line,
        channels: m.channels.map((c) => ({ type: c.type, label: c.type === 'other' ? (c.label ?? '').trim() : '', raw: cell(row, c.column) })).filter((c) => c.raw),
        fields: {
          name: cell(row, m.name) || null, company: cell(row, m.company) || null, title: cell(row, m.title) || null,
          tags: cleanTags(cell(row, m.tags) ? cell(row, m.tags).split(/[;,]/) : []),
          custom: cleanCustom(ctx, Object.fromEntries(Object.entries(m.custom ?? {}).map(([id, col]) => [id, cell(row, col)]).filter(([, v]) => v))),
        },
      });
    } catch (e) { rejected.push({ line: row.line, reason: (e as Error).message }); }
  }
  return { inputs, rejected };
}

export interface CsvImportInput { fileName?: unknown; contentBase64?: unknown; mapping?: unknown; batchName?: unknown; tags?: unknown }

function csvInputs(ctx: CrmCtx, body: CsvImportInput): { inputs: RowInput[]; rejected: Array<{ line: number; reason: string }>; name: string; fileName: string; tags: string[] } {
  if (typeof body.contentBase64 !== 'string' || !body.contentBase64) throw new CrmInputError('contentBase64 is required', 'contentBase64');
  if (Math.floor((body.contentBase64.length * 3) / 4) > CSV_MAX_BYTES + 3) throw new CrmInputError(`The file is larger than the ${CSV_MAX_BYTES / 1_048_576} MB limit.`, 'contentBase64');
  const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim().slice(0, 200) : 'import.csv';
  const parsed = parseCsv(decodeCsv(Buffer.from(body.contentBase64, 'base64')));
  if (parsed.headers.length === 0) throw new CrmInputError('The file is empty.', 'contentBase64');
  return { ...rowInputs(ctx, parsed, body.mapping), name: batchName(body.batchName, `${fileName} ${localDay(ctx.now(), ctx.settings().timezone)}`), fileName, tags: cleanTags(body.tags) };
}

/** Counts what a commit of the same file would do. Saves nothing. */
export async function previewCsv(ctx: CrmCtx, body: CsvImportInput): Promise<ImportResult> {
  const c = csvInputs(ctx, body);
  return resultOf(await plan(ctx, c.inputs, c.rejected), null, false);
}

/** Re-reads the file and applies it as one named batch. */
export async function commitCsv(ctx: CrmCtx, body: CsvImportInput): Promise<ImportResult> {
  const c = csvInputs(ctx, body);
  const p = await plan(ctx, c.inputs, c.rejected);
  const batchId = apply(ctx, p, { name: c.name, kind: 'csv', fileName: c.fileName, tags: c.tags, source: `import: ${c.name}` });
  return resultOf(p, batchId, true);
}

/**
 * A paste body. `mapping` has the CSV shape over the detected (or overridden) columns. The older `{ channel, label }`
 * form reads every line as one handle of that channel.
 */
export interface PasteInput { text?: unknown; mapping?: unknown; separator?: unknown; hasHeader?: unknown; channel?: unknown; label?: unknown; batchName?: unknown; tags?: unknown; commit?: unknown }

function pasteTable(ctx: CrmCtx, body: PasteInput, shape: { separator?: SeparatorName; hasHeader?: boolean } = {}): PasteTable {
  if (typeof body.text !== 'string' || !body.text.trim()) throw new CrmInputError('Paste at least one line', 'text');
  if (body.separator !== undefined && !Object.hasOwn(SEPARATORS, body.separator as string)) throw new CrmInputError('separator must be one of tab, comma, semicolon, pipe or none', 'separator');
  if (body.hasHeader !== undefined && typeof body.hasHeader !== 'boolean') throw new CrmInputError('hasHeader must be true or false', 'hasHeader');
  return readPaste(body.text, { separator: body.separator as SeparatorName | undefined, hasHeader: body.hasHeader as boolean | undefined, ...shape, countryCode: ctx.settings().countryCode });
}

/** The older body as a one-column mapping. */
function legacyMapping(body: PasteInput): { mapping: Mapping; shape: { separator: SeparatorName; hasHeader: boolean } } {
  if (body.mapping !== undefined) throw new CrmInputError('Send either mapping or channel, not both', 'mapping');
  if (!CHANNEL_TYPES.includes(body.channel as ChannelType)) throw new CrmInputError('Choose a channel type', 'channel');
  const type = body.channel as ChannelType;
  const label = type === 'other' && typeof body.label === 'string' ? body.label.trim() : '';
  return { mapping: { channels: [{ column: 'Column 1', type, ...(type === 'other' ? { label } : {}) }] }, shape: { separator: 'none', hasHeader: false } };
}

/** Previews (`commit: false`, saves nothing) or applies a pasted list as one batch, through the same plan as a CSV file. */
export async function importPaste(ctx: CrmCtx, body: PasteInput): Promise<ImportResult> {
  if (body.commit !== undefined && typeof body.commit !== 'boolean') throw new CrmInputError('commit must be true or false', 'commit');
  const legacy = body.channel !== undefined ? legacyMapping(body) : null;
  const table = pasteTable(ctx, body, legacy?.shape);
  const { inputs, rejected } = rowInputs(ctx, table, legacy ? legacy.mapping : body.mapping);
  const name = batchName(body.batchName, `Pasted list ${localDay(ctx.now(), ctx.settings().timezone)}`);
  const tags = cleanTags(body.tags);
  const p = await plan(ctx, inputs, rejected);
  if (body.commit === false) return resultOf(p, null, false);
  const batchId = apply(ctx, p, { name, kind: 'paste', fileName: null, tags, source: 'pasted list' });
  return resultOf(p, batchId, true);
}

export interface PasteSuggestion {
  separator: SeparatorName; hasHeader: boolean; rows: number;
  columns: Array<{ name: string; samples: string[]; byAgent: boolean }>;
  mapping: Mapping; agentUsed: boolean; agentError?: string;
}

/** The agent's mapping for the columns the rules left open; throws when it fails, times out or answers something invalid. */
async function askAgent(ctx: CrmCtx, table: PasteTable, timeoutMs: number) {
  const answer = await withTimeout(ctx.deps.agent.run({ kind: 'mapping', prompt: mappingPrompt(table) }), timeoutMs);
  const columns = parseAgentMapping(answer.trim(), table.headers.length);
  if (!columns) throw new Error('The agent did not answer with a valid column mapping');
  return columns;
}

/**
 * Detects the columns of a pasted list and suggests a mapping: rules first, then the agent for columns they left open.
 * An agent failure keeps the rule-based suggestion. Saves nothing.
 */
export async function suggestPaste(ctx: CrmCtx, body: PasteInput, timeoutMs = PASTE_AGENT_TIMEOUT_MS): Promise<PasteSuggestion> {
  const table = pasteTable(ctx, body);
  const rules = guessRoles(table, { countryCode: ctx.settings().countryCode, customFields: ctx.settings().customFields });
  let roles = rules.roles, filled: number[] = [], agentError: string | undefined;
  if (rules.open.length > 0) {
    try { ({ roles, filled } = mergeAgent(rules, await askAgent(ctx, table, timeoutMs))); }
    catch (e) { agentError = redactSecrets((e as Error).message).slice(0, 200); }
  }
  const samples = columnSamples(table);
  return {
    separator: table.separator, hasHeader: table.hasHeader, rows: table.rows.length + table.rejected.length,
    columns: table.headers.map((name, i) => ({ name, samples: samples[i]!, byAgent: filled.includes(i) })),
    mapping: toMapping(table.headers, roles), agentUsed: rules.open.length > 0 && agentError === undefined,
    ...(agentError ? { agentError } : {}),
  };
}

export function listBatches(ctx: CrmCtx): Array<{ id: number; name: string; kind: string; fileName: string | null; tags: string[]; counts: ImportCounts; createdAt: number }> {
  return (ctx.db.prepare('SELECT * FROM batches ORDER BY id DESC').all() as Array<{ id: number; name: string; kind: string; fileName: string | null; tags: string; counts: string; createdAt: number }>)
    .map((b) => ({ id: b.id, name: b.name, kind: b.kind, fileName: b.fileName, tags: JSON.parse(b.tags), counts: JSON.parse(b.counts), createdAt: b.createdAt }));
}

/** Used by the suggestion scan and reports to turn a batch id from a request into a validated id. */
export function batchIdOf(ctx: CrmCtx, raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id)) throw new CrmInputError('batch must be a batch id', 'batch');
  if (!ctx.db.prepare('SELECT 1 FROM batches WHERE id = ?').get(id)) throw new CrmInputError('That batch does not exist', 'batch');
  return id;
}

