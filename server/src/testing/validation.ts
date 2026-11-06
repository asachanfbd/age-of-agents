import type { ContractIssue, ContractIssueCode } from './types.ts';

/**
 * Small, dependency-free readers shared by the testing config and result validators. Each reader
 * records a ContractIssue instead of throwing, so one pass reports every problem in a document —
 * the "Repair testing" flow needs the whole list, not just the first failure.
 */

export type Issues = ContractIssue[];
type UnknownRecord = Record<string, unknown>;

/** Lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function addIssue(issues: Issues, code: ContractIssueCode, path: string, message: string): void {
  issues.push({ code, path, message });
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

export function readString(issues: Issues, obj: UnknownRecord, key: string, at: string, required = false): string | undefined {
  const value = obj[key];
  const where = childPath(at, key);
  if (value === undefined) {
    if (required) addIssue(issues, 'invalid-value', where, `${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    addIssue(issues, 'invalid-value', where, `${key} must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

export function readBoolean(issues: Issues, obj: UnknownRecord, key: string, at: string, fallback: boolean): boolean {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    addIssue(issues, 'invalid-value', childPath(at, key), `${key} must be true or false`);
    return fallback;
  }
  return value;
}

/** A finite number, optionally required to be non-negative. */
export function readNumber(issues: Issues, obj: UnknownRecord, key: string, at: string, opts: { required?: boolean; nonNegative?: boolean } = {}): number | undefined {
  const value = obj[key];
  const where = childPath(at, key);
  if (value === undefined) {
    if (opts.required) addIssue(issues, 'invalid-value', where, `${key} is required`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || (opts.nonNegative && value < 0)) {
    addIssue(issues, 'invalid-value', where, `${key} must be a ${opts.nonNegative ? 'non-negative ' : ''}finite number`);
    return undefined;
  }
  return value;
}

export function readEnum<T extends string>(
  issues: Issues, obj: UnknownRecord, key: string, at: string, allowed: readonly T[],
  opts: { fallback?: T; code?: ContractIssueCode } = {},
): T | undefined {
  const value = obj[key];
  const where = childPath(at, key);
  if (value === undefined) {
    if (opts.fallback !== undefined) return opts.fallback;
    addIssue(issues, 'invalid-value', where, `${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    addIssue(issues, opts.code ?? 'invalid-value', where, `${key} must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return value as T;
}

/** Records an issue and returns [] when present but not an array; `undefined` reads as []. */
export function readArray(issues: Issues, obj: UnknownRecord, key: string, at: string, required = false): unknown[] {
  const value = obj[key];
  const where = childPath(at, key);
  if (value === undefined) {
    if (required) addIssue(issues, 'invalid-value', where, `${key} is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    addIssue(issues, 'invalid-value', where, `${key} must be an array`);
    return [];
  }
  return value;
}

/** Reads an entry that must be an object, recording an issue (and returning null) otherwise. */
export function asRecord(issues: Issues, value: unknown, at: string): UnknownRecord | null {
  if (isRecord(value)) return value;
  addIssue(issues, 'invalid-value', at, 'must be an object');
  return null;
}

export function readId(issues: Issues, obj: UnknownRecord, key: string, at: string): string | undefined {
  const value = obj[key];
  const where = childPath(at, key);
  if (typeof value === 'string' && ID_PATTERN.test(value)) return value;
  addIssue(issues, 'invalid-id', where, `${key} must be 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit`);
  return undefined;
}

/** Flags every repeat of an id among siblings; `undefined` ids (already reported as invalid) are skipped. */
export function checkUniqueIds(issues: Issues, ids: (string | undefined)[], at: (index: number) => string, what: string): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (id === undefined) return;
    if (seen.has(id)) addIssue(issues, 'duplicate-id', at(index), `duplicate ${what} id "${id}"`);
    seen.add(id);
  });
}

/**
 * Normalizes a user-supplied relative path to POSIX form (`.` for the root itself), or returns null
 * when it is absolute (POSIX, Windows drive, or UNC), contains a `..` segment, or contains a NUL byte.
 * Purely syntactic — callers that touch the disk still resolve through fileTree.ts's resolveSafePath.
 */
export function normalizeRelativePath(raw: string): string | null {
  const unified = raw.trim().replace(/\\/g, '/');
  if (unified.includes('\0') || unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null;
  const segments = unified.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..')) return null;
  return segments.length ? segments.join('/') : '.';
}

/** Keeps the normalized output free of `key: undefined` noise for optional fields. */
export function dropUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
