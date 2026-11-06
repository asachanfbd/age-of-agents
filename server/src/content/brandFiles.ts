import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentInputError, ContentNotFoundError } from './errors.ts';
import { knowledgeDir, listDir, removeFile } from './files.ts';
import { FILE_MAX_BYTES, FILE_NAME_MAX, FILES_MAX, MB } from './limits.ts';

export interface BrandFile { name: string; size: number; changedAt: string; image: boolean }

const filesDir = (ctx: ContentCtx) => path.join(knowledgeDir(ctx.dir), 'files');
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

/** A plain file name: no folders, no control characters, no leading dot. The name is used as the stored file name. */
export function parseFileName(value: unknown): string {
  if (typeof value !== 'string') throw new ContentInputError('name is required', 'name');
  const name = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > FILE_NAME_MAX || /[\\/\u0000-\u001f]/.test(name) || name.startsWith('.')) throw new ContentInputError('name must be a plain file name', 'name');
  return name;
}

async function describe(dir: string, name: string): Promise<BrandFile> {
  const info = await stat(path.join(dir, name));
  return { name, size: info.size, changedAt: info.mtime.toISOString(), image: IMAGE.test(name) };
}

export async function listBrandFiles(ctx: ContentCtx): Promise<BrandFile[]> {
  const dir = filesDir(ctx);
  const files: BrandFile[] = [];
  for (const name of (await listDir(dir)).sort()) { const f = await describe(dir, name).catch(() => null); if (f) files.push(f); }
  return files;
}

export async function addBrandFile(ctx: ContentCtx, rawName: unknown, bytes: Buffer): Promise<BrandFile> {
  const name = parseFileName(rawName);
  if (bytes.length === 0) throw new ContentInputError('The file is empty', 'file');
  if (bytes.length > FILE_MAX_BYTES) throw new ContentInputError(`A file can be at most ${FILE_MAX_BYTES / MB} MB`, 'file');
  const existing = await listDir(filesDir(ctx));
  if (existing.length >= FILES_MAX) throw new ContentInputError(`At most ${FILES_MAX} files`, 'file');
  if (existing.includes(name)) throw new ContentConflictError('A file with that name already exists');
  await mkdir(filesDir(ctx), { recursive: true });
  await writeFile(path.join(filesDir(ctx), name), bytes);
  return describe(filesDir(ctx), name);
}

async function existingName(ctx: ContentCtx, rawName: string): Promise<string> {
  const name = (() => { try { return parseFileName(rawName); } catch { return null; } })();
  if (!name || !(await listDir(filesDir(ctx))).includes(name)) throw new ContentNotFoundError('That file does not exist');
  return name;
}

export async function readBrandFile(ctx: ContentCtx, rawName: string): Promise<{ name: string; bytes: Buffer }> {
  const name = await existingName(ctx, rawName);
  return { name, bytes: await readFile(path.join(filesDir(ctx), name)) };
}

export async function deleteBrandFile(ctx: ContentCtx, rawName: string): Promise<void> {
  await removeFile(path.join(filesDir(ctx), await existingName(ctx, rawName)));
}

