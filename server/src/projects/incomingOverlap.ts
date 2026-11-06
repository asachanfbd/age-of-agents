/**
 * The overlap rule shared by the app self-update and the Project auto-pull: a local change blocks a
 * fast-forward only when the incoming commits touch the same path (see docs/architecture.md,
 * "Update overlap rule"). Everything here works on paths only and streams git's output, so a huge
 * working tree or incoming diff costs time, never a giant string.
 */
import { gitRecords } from './git.ts';
import type { BlockingFile, BlockingFileKind } from '../domain/types.ts';

/** Most files a status keeps; the exact count travels separately as `total`. */
export const MAX_BLOCKING_FILES = 10;

export interface BlockingChanges {
  /** At most `limit` blocking files, sorted by path. */
  files: BlockingFile[];
  /** How many files block, including those cut from `files`. */
  total: number;
  /** Set when the incoming paths could not be computed and every tracked change was treated as blocking instead. */
  fallbackReason: string | null;
}

export const NO_BLOCKING_CHANGES: BlockingChanges = { files: [], total: 0, fallbackReason: null };

export type IncomingPaths = (cwd: string, remoteRef: string) => Promise<string[]>;

/** Paths the commits between HEAD and `remoteRef` change. Renames are listed as a delete plus an add so both sides count. */
export const incomingChangedPaths: IncomingPaths = async (cwd, remoteRef) => {
  const paths: string[] = [];
  for await (const path of gitRecords(cwd, ['diff', '--name-only', '-z', '--no-renames', `HEAD..${remoteRef}`])) paths.push(path);
  return paths;
};

/** One spelling per path: a case-insensitive filesystem or a stray space must not hide an overlap. */
function pathKey(path: string): string {
  return path.normalize('NFC').trim().toLowerCase();
}

function* ancestorKeys(key: string): Generator<string> {
  for (let slash = key.lastIndexOf('/'); slash > 0; slash = key.lastIndexOf('/', slash - 1)) yield key.slice(0, slash);
}

interface LocalChange { path: string; kind: BlockingFileKind }

/** `git status --porcelain=v1 -z` entries; a rename or copy carries its old path as a second record. Ignored files are never listed. */
async function* localChanges(cwd: string): AsyncGenerator<LocalChange> {
  const records = gitRecords(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  for await (const record of records) {
    const x = record[0];
    const y = record[1];
    const path = record.slice(3);
    if (x === '?') { yield { path, kind: 'untracked' }; continue; }
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const origin = await records.next();
      yield { path, kind: 'modified' };
      if (!origin.done) yield { path: origin.value, kind: 'modified' };
      continue;
    }
    yield { path, kind: x === 'D' || y === 'D' ? 'deleted' : 'modified' };
  }
}

/**
 * The local changes that `incoming` (the paths the update changes) would collide with. With
 * `incoming` null every tracked change counts, the conservative reading used when the incoming paths
 * are unknown. An untracked file blocks only when the update adds that path, or a path beneath it, or
 * a file where one of its parent folders is.
 */
export async function findBlockingChanges(cwd: string, incoming: string[] | null, limit = MAX_BLOCKING_FILES): Promise<BlockingChanges> {
  const incomingKeys = incoming ? new Set(incoming.map(pathKey)) : null;
  const blocking = new Map<string, BlockingFileKind>();
  const untracked = new Map<string, string>();

  for await (const change of localChanges(cwd)) {
    if (change.kind === 'untracked') {
      if (incomingKeys) untracked.set(pathKey(change.path), change.path);
      continue;
    }
    if (!incomingKeys || incomingKeys.has(pathKey(change.path))) blocking.set(change.path, change.kind);
  }

  if (incomingKeys && untracked.size > 0) {
    for (const [key, path] of untracked) {
      if (incomingKeys.has(key) || [...ancestorKeys(key)].some((ancestor) => incomingKeys.has(ancestor))) blocking.set(path, 'untracked');
    }
    for (const key of incomingKeys) {
      for (const ancestor of ancestorKeys(key)) {
        const path = untracked.get(ancestor);
        if (path !== undefined) blocking.set(path, 'untracked');
      }
    }
  }

  const files = [...blocking].map(([path, kind]) => ({ path, kind })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.slice(0, limit), total: files.length, fallbackReason: null };
}

/**
 * What blocks an update to `remoteRef`, plus the incoming paths when they could be read (null when
 * they could not; then `fallbackReason` explains and any tracked change blocks). A failure to read
 * the local status itself still throws: nothing can be said about the folder then.
 */
export async function checkBlockingChanges(
  cwd: string,
  remoteRef: string,
  options: { limit?: number; incomingPaths?: IncomingPaths } = {},
): Promise<{ incoming: string[] | null; blocking: BlockingChanges }> {
  const readIncoming = options.incomingPaths ?? incomingChangedPaths;
  let incoming: string[];
  try {
    incoming = await readIncoming(cwd, remoteRef);
  } catch (error) {
    const blocking = await findBlockingChanges(cwd, null, options.limit);
    const reason = error instanceof Error ? error.message : 'unknown error';
    return { incoming: null, blocking: { ...blocking, fallbackReason: `could not tell which files the update changes (${reason})` } };
  }
  return { incoming, blocking: await findBlockingChanges(cwd, incoming, options.limit) };
}

/** "a, b, c and 2 more": the first `shown` paths, then how many of `total` are left out. */
export function describeFiles(paths: string[], total: number, shown: number): string {
  const listed = paths.slice(0, shown);
  const more = total - listed.length;
  return more > 0 ? `${listed.join(', ')} and ${more} more` : listed.join(', ');
}

const GIT_ESCAPES: Record<string, number> = { t: 9, n: 10, '"': 34, '\\': 92 };

/** Undoes git's C-style quoting of a path (`"caf\303\251"`), which git applies to unusual names in its messages. */
function unquoteGitPath(quoted: string): string {
  if (!/^".*"$/.test(quoted)) return quoted;
  const bytes: number[] = [];
  const inner = quoted.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1, i + 4));
    if (inner[i] === '\\' && octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    const escaped = inner[i] === '\\' ? GIT_ESCAPES[inner[i + 1] as string] : undefined;
    if (escaped !== undefined) { bytes.push(escaped); i++; continue; }
    bytes.push(...Buffer.from(inner[i] as string));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The files git names when it refuses a merge because local changes or untracked files would be overwritten; empty for any other message. */
export function parseOverwriteRefusal(message: string): string[] {
  const lines = message.split('\n');
  const files: string[] = [];
  lines.forEach((line, i) => {
    if (!/would be overwritten by/.test(line)) return;
    for (let j = i + 1; lines[j]?.startsWith('\t'); j++) files.push(unquoteGitPath((lines[j] as string).trim()));
  });
  return files;
}

/** The person-facing sentence for a refused merge, or null when the message is not an overwrite refusal. */
export function overwriteRefusalMessage(message: string, shown = 3): string | null {
  const files = parseOverwriteRefusal(message);
  if (files.length === 0) return null;
  return `local changes would be overwritten by the update: ${describeFiles(files, files.length, shown)}. Nothing was changed`;
}
