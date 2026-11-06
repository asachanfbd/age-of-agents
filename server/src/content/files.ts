import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const knowledgeDir = (buildingDir: string): string => path.join(buildingDir, 'knowledge');

/** Short content hash used as the version of an agent-editable file: it changes whenever any byte does. */
export const versionOf = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 16);

/** Reads a text file; a file that does not exist yet reads as empty with no change time. */
export async function readText(file: string): Promise<{ content: string; changedAt: string | null }> {
  try {
    const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return { content, changedAt: info.mtime.toISOString() };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', changedAt: null };
    throw e;
  }
}

/** Writes through a temporary file so an agent reading the folder never sees half a document. */
export async function writeTextAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

export async function listDir(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

export const removeFile = (file: string): Promise<void> => rm(file, { force: true });
