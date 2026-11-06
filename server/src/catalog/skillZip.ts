import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

/**
 * Extracts an uploaded "skill folder as a zip" into `.claude/skills/<id>/`.
 * Validated in two passes before anything is written: every entry's path
 * must resolve inside the target directory (the classic "zip slip" attack —
 * a `../../etc/passwd`-style entry name, or an absolute path) and must not
 * be a symlink entry (the zip format can carry one via its Unix external
 * attributes, which would let a "file" written through it point anywhere on
 * disk). One bad entry fails the whole extraction; nothing partial is left
 * behind.
 */

export class InvalidZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidZipError';
  }
}

export class ZipSlipError extends Error {
  constructor(entryName: string) {
    super(`Zip entry "${entryName}" would extract outside the target directory — refusing to extract`);
    this.name = 'ZipSlipError';
  }
}

interface EntryPlan {
  entry: Entry;
  targetPath: string;
  isDirectory: boolean;
}

const SYMLINK_UNIX_MODE = 0o120000;
const UNIX_MODE_MASK = 0o170000;

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error instanceof Error ? new InvalidZipError(error.message) : new InvalidZipError('Could not open zip file'));
        return;
      }
      resolve(zipfile);
    });
  });
}

function readAllEntries(zipfile: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zipfile.on('entry', (entry: Entry) => {
      entries.push(entry);
      zipfile.readEntry();
    });
    zipfile.on('end', () => resolve(entries));
    zipfile.on('error', (error: Error) => reject(new InvalidZipError(error.message)));
    zipfile.readEntry();
  });
}

function planEntry(targetDir: string, entry: Entry): EntryPlan {
  const isDirectory = entry.fileName.endsWith('/');
  const resolvedRoot = path.resolve(targetDir);
  const targetPath = path.resolve(resolvedRoot, entry.fileName);
  const rel = path.relative(resolvedRoot, targetPath);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new ZipSlipError(entry.fileName);

  const unixMode = entry.externalFileAttributes >>> 16;
  if ((unixMode & UNIX_MODE_MASK) === SYMLINK_UNIX_MODE) throw new ZipSlipError(entry.fileName);

  return { entry, targetPath, isDirectory };
}

function extractFile(zipfile: ZipFile, plan: EntryPlan): Promise<void> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(plan.entry, (error, readStream) => {
      if (error || !readStream) {
        reject(error instanceof Error ? new InvalidZipError(error.message) : new InvalidZipError(`Could not read zip entry "${plan.entry.fileName}"`));
        return;
      }
      const chunks: Buffer[] = [];
      readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      readStream.on('error', (streamError: Error) => reject(streamError));
      readStream.on('end', () => {
        mkdir(path.dirname(plan.targetPath), { recursive: true })
          .then(() => writeFile(plan.targetPath, Buffer.concat(chunks)))
          .then(resolve, reject);
      });
    });
  });
}

/** Extracts every entry of `zipBuffer` into `targetDir` (created if missing). Throws ZipSlipError/InvalidZipError instead of writing anything if any entry fails validation. */
export async function extractZip(zipBuffer: Buffer, targetDir: string): Promise<void> {
  const zipfile = await openZip(zipBuffer);
  try {
    const entries = await readAllEntries(zipfile);
    const plans = entries.map((entry) => planEntry(targetDir, entry)); // Validates every entry before any write happens.

    await mkdir(targetDir, { recursive: true });
    for (const plan of plans) {
      if (plan.isDirectory) {
        await mkdir(plan.targetPath, { recursive: true });
      } else {
        await extractFile(zipfile, plan);
      }
    }
  } finally {
    zipfile.close();
  }
}
