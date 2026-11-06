import { CrmInputError } from './errors.ts';
import { CSV_MAX_BYTES, CSV_MAX_ROWS } from './limits.ts';

export interface CsvRow { line: number; cells: string[] }
export interface ParsedCsv { headers: string[]; rows: CsvRow[]; rejected: Array<{ line: number; reason: string }> }

export interface RawRecord { line: number; cells: string[]; unterminated?: boolean }

/**
 * Splits text into records on `separator` (null keeps each line one cell); `line` is the physical source line a record
 * starts on, so a multi-line quoted cell is one record. Blank lines are skipped.
 */
export function csvRecords(text: string, separator: string | null = ','): RawRecord[] {
  const out: RawRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let any = false;
  let quotedCell = false;
  const endRecord = () => {
    cells.push(cell);
    if (cells.length > 1 || cells[0]!.trim() !== '' || (any && quotedCell)) out.push({ line: start, cells });
    cells = []; cell = ''; any = false; quotedCell = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else { if (c === '\n') line++; else if (c === '\r' && text[i + 1] !== '\n') line++; cell += c; }
      continue;
    }
    if (c === '"' && cell === '') { quoted = true; any = true; quotedCell = true; }
    else if (c === separator) { cells.push(cell); cell = ''; any = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord(); line++; start = line;
    } else { cell += c; any = true; }
  }
  if (quoted) {
    // The rest of the file is inside a quote that never closed.
    out.push({ line: start, cells: [], unterminated: true });
    return out;
  }
  if (cell !== '' || cells.length > 0 || any) endRecord();
  return out;
}

export function decodeCsv(bytes: Buffer): string {
  if (bytes.length > CSV_MAX_BYTES) throw new CrmInputError(`The file is larger than the ${CSV_MAX_BYTES / 1_048_576} MB limit.`);
  if (bytes.includes(0)) throw new CrmInputError('That file is not a CSV: it holds binary data.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CrmInputError('The file is not valid UTF-8 text. Save it as CSV (UTF-8).'); }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Trimmed header names; refuses an empty or repeated name. */
export function checkHeaders(cells: string[]): string[] {
  const headers = cells.map((h) => h.trim());
  if (headers.some((h) => !h)) throw new CrmInputError('Every column needs a header name.');
  if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length) throw new CrmInputError('Two columns have the same header name.');
  return headers;
}

/** Data records with `width` cells become rows; the others are rejected with their line number. */
export function tableRows(data: RawRecord[], width: number): Pick<ParsedCsv, 'rows' | 'rejected'> {
  const rows: CsvRow[] = [];
  const rejected: ParsedCsv['rejected'] = [];
  for (const r of data) {
    if (r.unterminated) rejected.push({ line: r.line, reason: 'Unterminated quote: the rest of the file was not read' });
    else if (r.cells.length !== width) rejected.push({ line: r.line, reason: 'Wrong column count' });
    else rows.push({ line: r.line, cells: r.cells });
  }
  return { rows, rejected };
}

export function parseCsv(text: string): ParsedCsv {
  const recs = csvRecords(text);
  if (recs.length === 0) return { headers: [], rows: [], rejected: [] };
  const head = recs[0]!;
  if (head.unterminated) throw new CrmInputError('The header row has an unterminated quote.');
  const headers = checkHeaders(head.cells);
  const data = recs.slice(1);
  if (data.length > CSV_MAX_ROWS) throw new CrmInputError(`The file has more than ${CSV_MAX_ROWS.toLocaleString('en-US')} rows.`);
  return { headers, ...tableRows(data, headers.length) };
}

const FORMULA = /^[=+\-@]/;
/** A cell that starts like a formula gets one leading apostrophe on export; an already-quoted cell is left alone. */
export const exportCell = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return FORMULA.test(text) ? `'${text}` : text;
};

const quote = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [headers, ...rows.map((r) => r.map(exportCell))].map((r) => r.map((c) => quote(String(c))).join(',')).join('\r\n') + '\r\n';
}
