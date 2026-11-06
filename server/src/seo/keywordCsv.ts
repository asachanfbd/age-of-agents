import { SeoInputError } from './errors.ts';
import { displayOf, normalizeKeyword, statusFromText } from './keywordRules.ts';
import type { KeywordStatus } from './keywordRules.ts';
import { normalizePageUrl } from './urls.ts';

export const MAX_CSV_BYTES = 5_000_000;
export const MAX_CSV_ROWS = 50_000;

/** Reads delimited text into rows of cells (comma-separated unless told otherwise): quoted fields may hold the delimiter, doubled quotes and line breaks; a leading byte-order mark and CRLF line ends are accepted. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let touched = false;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (row.length > 1 || row[0] !== '') rows.push(row); row = []; touched = false; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === '') { quoted = true; touched = true; }
    else if (c === delimiter) { endCell(); touched = true; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; endRow(); }
    else { cell += c; touched = true; }
  }
  if (touched || cell !== '' || row.length) endRow();
  return rows;
}

const KEYWORD_HEADERS = ['keyword', 'keywords', 'query', 'term'];
const TARGET_HEADERS = ['target page', 'target', 'targetpage', 'target_page', 'url'];

export interface ImportRow { line: number; keyword: string; display: string; cluster: string; status: KeywordStatus | null; targetPage: string }
export interface ImportParse { rows: ImportRow[]; rejected: Array<{ line: number; reason: string }>; duplicates: number }

/** Turns an uploaded file into keywords to add. Unknown columns are ignored; a row that cannot be used is rejected with its reason and never stops the others. */
export function parseKeywordImport(text: unknown): ImportParse {
  if (typeof text !== 'string' || !text.trim()) throw new SeoInputError('the file is empty');
  if (Buffer.byteLength(text) > MAX_CSV_BYTES) throw new SeoInputError(`the file is larger than ${MAX_CSV_BYTES / 1_000_000} MB`);
  const table = parseCsv(text);
  if (table.length - 1 > MAX_CSV_ROWS) throw new SeoInputError(`the file has more than ${MAX_CSV_ROWS} rows`);
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const column = (names: string[]) => header.findIndex((h) => names.includes(h));
  const at = { keyword: column(KEYWORD_HEADERS), cluster: column(['cluster', 'cluster name']), status: column(['status']), target: column(TARGET_HEADERS) };
  if (at.keyword < 0) throw new SeoInputError('the file needs a "keyword" column');
  const out: ImportParse = { rows: [], rejected: [], duplicates: 0 };
  const seen = new Set<string>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const cell = (index: number) => (index >= 0 ? (cells[index] ?? '').trim() : '');
    const key = normalizeKeyword(cell(at.keyword));
    if (!key) return void out.rejected.push({ line, reason: 'the keyword is empty or longer than 500 characters' });
    const statusText = cell(at.status);
    const status = statusText ? statusFromText(statusText) : null;
    if (statusText && !status) return void out.rejected.push({ line, reason: `status "${statusText.slice(0, 40)}" is not tracking, target or ignored` });
    const targetText = cell(at.target);
    const target = targetText ? normalizePageUrl(targetText) : '';
    if (targetText && !target) return void out.rejected.push({ line, reason: 'the target page is not a full http or https address' });
    if (seen.has(key)) { out.duplicates++; return; }
    seen.add(key);
    out.rows.push({ line, keyword: key, display: displayOf(cell(at.keyword)), cluster: cell(at.cluster), status, targetPage: target ?? '' });
  });
  return out;
}

/** A spreadsheet runs text that starts with one of these as a formula, so exported text gets a leading apostrophe. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (cells: Array<string | number | null | undefined>): string => cells.map(csvCell).join(',');
