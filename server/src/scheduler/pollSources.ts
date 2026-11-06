import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ApiResponse, FileEntry } from './pollDetection.ts';
import type { DetectMode } from './types.ts';

/** The real sources a poll trigger reads: the local file system and an HTTP GET. The scheduler takes them as dependencies. */

export const MAX_WATCHED_FILES = 20_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** `signal` aborts when the check has timed out: the source stops reading and rejects. */
export type FileSource = (absolutePath: string, detect: DetectMode, signal: AbortSignal) => Promise<FileEntry[]>;
export type ApiSource = (url: string, signal: AbortSignal) => Promise<ApiResponse>;

async function entryOf(file: string, relative: string, detect: DetectMode): Promise<FileEntry> {
  const info = await stat(file);
  const entry: FileEntry = { path: relative, mtimeMs: info.mtimeMs, size: info.size };
  if (detect === 'hash') entry.hash = createHash('sha256').update(await readFile(file)).digest('hex');
  return entry;
}

/** Every file under a folder (nested folders included), or the one file the path names. Content is read only in `hash` mode. */
export const readWatchedFiles: FileSource = async (absolutePath, detect, signal) => {
  if (!(await stat(absolutePath)).isDirectory()) return [await entryOf(absolutePath, path.basename(absolutePath), detect)];
  const entries: FileEntry[] = [];
  const listed = await readdir(absolutePath, { recursive: true, withFileTypes: true });
  for (const item of listed) {
    signal.throwIfAborted();
    if (!item.isFile()) continue;
    if (entries.length >= MAX_WATCHED_FILES) throw new Error(`the folder holds more than ${MAX_WATCHED_FILES.toLocaleString('en-US')} files`);
    const file = path.join(item.parentPath, item.name);
    entries.push(await entryOf(file, path.relative(absolutePath, file).split(path.sep).join('/'), detect));
  }
  return entries;
};

/**
 * A plain GET with no headers. The body is read as it arrives and the download is dropped as soon as it passes the
 * cap, so a huge response is refused without ever being held in memory.
 */
export const fetchApiResponse: ApiSource = async (url, signal) => {
  const tooLarge = () => new Error(`the response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`);
  const response = await fetch(url, { method: 'GET', signal, redirect: 'follow' });
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
    received += part.value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader!.cancel();
      throw tooLarge();
    }
    chunks.push(part.value);
  }
  return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
};
