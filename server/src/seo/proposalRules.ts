import { SeoInputError } from './errors.ts';
import { TASK_LIMITS } from './taskRules.ts';
import { normalizePageUrl } from './urls.ts';

export type Decision = 'pending' | 'accepted' | 'rejected';
export const DECISIONS: readonly Decision[] = ['pending', 'accepted', 'rejected'];

/** One page's proposed change. A title/meta run fills title and meta; content and audit runs put their text in `notes`. */
export interface ProposalRow {
  id: string;
  url: string;
  currentTitle: string;
  currentMeta: string;
  proposedTitle: string;
  proposedMeta: string;
  notes: string;
  decision: Decision;
  /** Set when the person edited the proposal; the edited text is what is handed off. */
  editedTitle: string | null;
  editedMeta: string | null;
}

export const effectiveTitle = (row: ProposalRow): string => row.editedTitle ?? row.proposedTitle;
export const effectiveMeta = (row: ProposalRow): string => row.editedMeta ?? row.proposedMeta;

// ---- character guidance ---------------------------------------------------------------------------------------------

export const GUIDANCE = { title: { min: 30, max: 60 }, meta: { min: 70, max: 160 } } as const;
export type GuidanceState = 'empty' | 'short' | 'good' | 'long';

/** Counts what a person sees as characters: code points, so an emoji is one. */
export const lengthOf = (text: string): number => [...text].length;

export function guidance(field: 'title' | 'meta', text: string): { count: number; state: GuidanceState } {
  const count = lengthOf(text);
  const { min, max } = GUIDANCE[field];
  return { count, state: count === 0 ? 'empty' : count < min ? 'short' : count > max ? 'long' : 'good' };
}

// ---- reading the agent's answer -------------------------------------------------------------------------------------

export interface ParsedProposal { rows: Array<Pick<ProposalRow, 'url' | 'proposedTitle' | 'proposedMeta' | 'notes'>>; skipped: number }

function jsonFrom(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through to the first object or list */ }
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new SeoInputError("The agent's answer was not usable: it contains no JSON");
  try { return JSON.parse(candidate.slice(start)); } catch { throw new SeoInputError("The agent's answer was not usable: the JSON is broken"); }
}

/**
 * Reads `{ pages: [{ url, title, meta, notes }] }` (or the bare list). A row for a page that was not selected is ignored,
 * a duplicate keeps the first, and a row whose fields are not text is skipped and counted.
 */
export function parseProposalOutput(outputs: readonly string[], selected: ReadonlySet<string>): ParsedProposal {
  let parsed: unknown;
  let failure: Error | null = null;
  for (const text of outputs) {
    try { parsed = jsonFrom(text); failure = null; break; } catch (error) { failure = error as Error; }
  }
  if (parsed === undefined) throw failure ?? new SeoInputError("The agent's answer was not usable: it produced no output");
  const list = Array.isArray(parsed) ? parsed : (parsed as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(list)) throw new SeoInputError("The agent's answer was not usable: it has no list of pages");
  const seen = new Set<string>();
  const rows: ParsedProposal['rows'] = [];
  let skipped = 0;
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    const url = normalizePageUrl(r.url);
    if (!url || !selected.has(url) || seen.has(url)) continue;
    const text = (value: unknown): string | null => (value === undefined || value === null ? '' : typeof value === 'string' ? value.trim() : null);
    const title = text(r.title); const meta = text(r.meta); const notes = text(r.notes);
    if (title === null || meta === null || notes === null) { skipped++; continue; }
    seen.add(url);
    rows.push({ url, proposedTitle: title.slice(0, TASK_LIMITS.proposedTitle), proposedMeta: meta.slice(0, TASK_LIMITS.proposedMeta), notes: notes.slice(0, TASK_LIMITS.notes) });
    if (rows.length >= TASK_LIMITS.pagesPerRun) break;
  }
  return { rows, skipped };
}

// ---- review ---------------------------------------------------------------------------------------------------------

export interface RowChange { decision?: unknown; title?: unknown; meta?: unknown }

/**
 * Applies one reviewer action. Editing text without naming a decision accepts the row (the person edited it because
 * they want it); a hard cap guards the stored text.
 */
export function applyRowChange(row: ProposalRow, change: unknown): ProposalRow {
  if (typeof change !== 'object' || change === null || Array.isArray(change)) throw new SeoInputError('the change must be a JSON object');
  const c = change as RowChange;
  let next = { ...row };
  if (c.title !== undefined) {
    if (typeof c.title !== 'string') throw new SeoInputError('title must be text');
    if (lengthOf(c.title) > TASK_LIMITS.proposedTitle) throw new SeoInputError(`title must be at most ${TASK_LIMITS.proposedTitle} characters`);
    next.editedTitle = c.title.trim();
  }
  if (c.meta !== undefined) {
    if (typeof c.meta !== 'string') throw new SeoInputError('meta must be text');
    if (lengthOf(c.meta) > TASK_LIMITS.proposedMeta) throw new SeoInputError(`meta must be at most ${TASK_LIMITS.proposedMeta.toLocaleString('en-US')} characters`);
    next.editedMeta = c.meta.trim();
  }
  if (c.decision !== undefined) {
    if (typeof c.decision !== 'string' || !DECISIONS.includes(c.decision as Decision)) throw new SeoInputError('decision must be pending, accepted or rejected');
    next = { ...next, decision: c.decision as Decision };
  } else if (c.title !== undefined || c.meta !== undefined) {
    next = { ...next, decision: 'accepted' };
  }
  return next;
}

export function reviewSummary(rows: readonly ProposalRow[]): { accepted: number; rejected: number; pending: number; canApprove: boolean } {
  const count = (d: Decision) => rows.filter((r) => r.decision === d).length;
  const accepted = count('accepted');
  return { accepted, rejected: count('rejected'), pending: count('pending'), canApprove: accepted > 0 };
}

// ---- handoff documents ----------------------------------------------------------------------------------------------

const csvCell = (value: string): string => {
  // A leading = + - @ would run as a formula in a spreadsheet; the apostrophe keeps it text.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const accepted = (rows: readonly ProposalRow[]): ProposalRow[] => rows.filter((r) => r.decision === 'accepted');

export const CSV_COLUMNS = ['url', 'current_title', 'new_title', 'current_meta', 'new_meta', 'notes'] as const;

/** The accepted rows with their edited values; the only place stored text is escaped for a spreadsheet. */
export function proposalCsv(rows: readonly ProposalRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of accepted(rows)) {
    lines.push([r.url, r.currentTitle, effectiveTitle(r), r.currentMeta, effectiveMeta(r), r.notes].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** The planning-session prompt: only accepted rows, never truncated. Returns null when it would pass the limit. */
export function handoffPrompt(title: string, rows: readonly ProposalRow[], limit: number = TASK_LIMITS.handoffPrompt): string | null {
  const chosen = accepted(rows);
  const body = chosen.map((r, i) => {
    const parts = [`${i + 1}. ${r.url}`];
    if (r.currentTitle || effectiveTitle(r)) parts.push(`   Title: ${r.currentTitle || '(none)'} -> ${effectiveTitle(r) || '(unchanged)'}`);
    if (r.currentMeta || effectiveMeta(r)) parts.push(`   Meta description: ${r.currentMeta || '(none)'} -> ${effectiveMeta(r) || '(unchanged)'}`);
    if (r.notes) parts.push(`   Notes: ${r.notes}`);
    return parts.join('\n');
  }).join('\n');
  const prompt = `Apply these approved SEO changes to the website's source. Change only what is listed.\n\n${title}\n\n${body}`;
  return [...prompt].length > limit ? null : prompt;
}

export const MAX_FOLLOW_UP_TITLE = 120;

/** The manual task an agent leaves behind once a proposal is handed off. */
export function followUpTask(title: string, count: number): { title: string; notes: string } {
  return { title: `Publish: ${title}`.slice(0, MAX_FOLLOW_UP_TITLE), notes: `${count} approved change${count === 1 ? '' : 's'} from "${title}" are ready to be published on the website.` };
}
