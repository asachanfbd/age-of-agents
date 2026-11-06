import { SeoInputError, SeoTooLargeError } from './errors.ts';
import { parseCsv } from './keywordCsv.ts';

/** The largest import file. Uploads travel as base64 inside the daemon's 25 MB JSON body, so this stays below what that body can carry. */
export const MAX_BACKLINK_FILE_BYTES = 15_000_000;
export const MAX_BACKLINK_ROWS = 500_000;

const ACCEPTED_EXTENSIONS = ['.csv', '.tsv', '.txt'];
const DELIMITERS = [',', ';', '\t', '|'] as const;

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export function checkFileName(fileName: unknown): string {
  const name = typeof fileName === 'string' ? fileName.trim() : '';
  if (!name || !ACCEPTED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) throw new SeoInputError('That is not a CSV or TSV file. Export the links as .csv or .tsv.');
  return name.slice(0, 200);
}

export function checkFileSize(bytes: number, cap: number): void {
  if (bytes > cap) throw new SeoTooLargeError(`The file is larger than the ${Math.round(cap / 1_000_000)} MB limit. Split it into smaller files and import each one as a partial update.`);
}

function looksBinary(bytes: Buffer): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return true;
  const sample = bytes.subarray(0, 8192);
  const utf16 = (sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff);
  return !utf16 && sample.includes(0);
}

/** Decodes an uploaded file: a byte-order mark picks UTF-8 or UTF-16, text that is not valid UTF-8 is read as Windows-1252. */
export function decodeBytes(bytes: Buffer): { text: string; encoding: Encoding } {
  if (looksBinary(bytes)) throw new SeoInputError('That file is not a CSV: it holds binary data.');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** The delimiter that splits the first line (outside quotes) into the most cells; comma when nothing splits it. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const c of text.slice(0, 20_000)) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  let best: string = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) if (counts.get(d)! > bestCount) { best = d; bestCount = counts.get(d)!; }
  return best;
}

export interface ParsedFile { encoding: Encoding; delimiter: string; headers: string[]; rows: Array<{ row: number; cells: string[] }> }

/** Reads a file into headers and numbered rows: records are counted with the header as row 1, and blank lines are not records. */
export function readFile(fileName: unknown, bytes: Buffer, cap: number): ParsedFile {
  checkFileName(fileName);
  checkFileSize(bytes.length, cap);
  const { text, encoding } = decodeBytes(bytes);
  if (!text.trim()) throw new SeoInputError('The file is empty.');
  const delimiter = detectDelimiter(text);
  const table = parseCsv(text, delimiter);
  if (table.length < 2) throw new SeoInputError('The file has a header row but no links.');
  if (table.length - 1 > MAX_BACKLINK_ROWS) throw new SeoInputError(`The file has more than ${MAX_BACKLINK_ROWS.toLocaleString('en-US')} rows.`);
  return { encoding, delimiter, headers: uniqueHeaders(table[0]!), rows: table.slice(1).map((cells, i) => ({ row: i + 2, cells })) };
}

/** Trims headers and gives empty or repeated names a distinct one, so every column can be addressed by its header. */
export function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}
