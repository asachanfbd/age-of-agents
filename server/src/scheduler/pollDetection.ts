import { createHash } from 'node:crypto';
import type { DetectMode, PollBaseline } from './types.ts';

/**
 * Change detection for poll triggers. Pure: a source hands in what it read (file entries, or a response) and these
 * functions turn it into a baseline and compare two baselines.
 */

/** One file under a watched path. `hash` is the content hash, present only when the source was asked for it. */
export interface FileEntry {
  /** Relative to the watched path, with `/` separators; a single watched file is its own name. */
  path: string;
  mtimeMs: number;
  size: number;
  hash?: string;
}

export interface ApiResponse {
  status: number;
  body: string;
}

export type PollReading = { ok: true; baseline: PollBaseline } | { ok: false; error: string };

export type PollComparison = { changed: false } | { changed: true; summary: string };

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A folder's baseline: each file's signature under the detect mode. `mtime` mode does not see a content change that keeps the time and size. */
export function filesBaseline(entries: readonly FileEntry[], detect: DetectMode): PollBaseline {
  const files: Record<string, string> = {};
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    files[entry.path] = detect === 'hash' ? entry.hash ?? '' : `${entry.mtimeMs}:${entry.size}`;
  }
  return { kind: 'files', files };
}

const MAX_NAMED_FILES = 3;
const MAX_VALUE_LENGTH = 80;

function shorten(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH - 1)}…` : value;
}

function fileGroup(paths: string[], verb: string): string | null {
  if (!paths.length) return null;
  const named = paths.slice(0, MAX_NAMED_FILES).map(shorten).join(', ');
  const more = paths.length - MAX_NAMED_FILES;
  return `${paths.length} ${verb}: ${named}${more > 0 ? ` and ${more} more` : ''}`;
}

function compareFiles(before: Record<string, string>, after: Record<string, string>): PollComparison {
  const added = Object.keys(after).filter((path) => !(path in before));
  const removed = Object.keys(before).filter((path) => !(path in after));
  const modified = Object.keys(after).filter((path) => path in before && before[path] !== after[path]);
  const groups = [fileGroup(modified, 'modified'), fileGroup(added, 'added'), fileGroup(removed, 'removed')].filter((group): group is string => group !== null);
  return groups.length ? { changed: true, summary: groups.join('; ') } : { changed: false };
}

/** Whether the new reading differs from the stored one, with a short, bounded description of what changed. */
export function comparePoll(before: PollBaseline, after: PollBaseline, label = 'The response'): PollComparison {
  if (before.kind === 'files' && after.kind === 'files') return compareFiles(before.files, after.files);
  if (before.kind === 'value' && after.kind === 'value') {
    if (before.hash === after.hash) return { changed: false };
    return { changed: true, summary: before.display !== null && after.display !== null ? `${label} ${before.display} to ${after.display}` : `${label} changed` };
  }
  return { changed: true, summary: `${label} changed` };
}

/** `plans[0].price` as the keys and indexes to follow. */
export function parseJsonPath(path: string): (string | number)[] {
  const steps: (string | number)[] = [];
  for (const part of path.split('.')) {
    const [key, ...indexes] = part.split('[');
    steps.push(key!);
    for (const index of indexes) steps.push(Number(index.slice(0, -1)));
  }
  return steps;
}

function selectField(document: unknown, path: string): { found: true; value: unknown } | { found: false } {
  let current = document;
  for (const step of parseJsonPath(path)) {
    if (current === null || typeof current !== 'object') return { found: false };
    if (typeof step === 'number' ? !Array.isArray(current) || step >= current.length : Array.isArray(current) || !Object.hasOwn(current, step)) return { found: false };
    current = (current as Record<string | number, unknown>)[step];
  }
  return { found: true, value: current };
}

/** JSON with object keys in a fixed order, so reordered keys and whitespace never read as a change. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * An API response as a baseline. The whole response is compared on its raw body and kept only as a hash. A selected
 * field is compared on its canonical JSON, kept as a hash plus a shortened copy for the change summary.
 */
export function apiReading(response: ApiResponse, jsonField: string | null): PollReading {
  if (response.status < 200 || response.status > 299) return { ok: false, error: `The address answered ${response.status}` };
  if (jsonField === null) return { ok: true, baseline: { kind: 'value', hash: sha256(response.body), display: null } };
  let document: unknown;
  try { document = JSON.parse(response.body); } catch { return { ok: false, error: 'The response is not JSON, so the selected field cannot be read' }; }
  const selected = selectField(document, jsonField);
  if (!selected.found) return { ok: false, error: `The response has no field "${jsonField}"` };
  const canonical = canonicalJson(selected.value);
  return { ok: true, baseline: { kind: 'value', hash: sha256(canonical), display: shorten(canonical) } };
}
