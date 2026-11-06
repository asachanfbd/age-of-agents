import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildingDir } from '../../buildings/secrets.ts';
import { SeoInputError, SeoNotFoundError } from '../errors.ts';
import { DEFAULT_CRAWL_SETTINGS } from './rules.ts';
import type { CrawlSettings } from './rules.ts';
import type { RunView, Snapshot, SnapshotMeta, WorkState } from './types.ts';

const dirOf = (buildingId: string) => path.join(buildingDir(buildingId), 'crawl');
const SNAPSHOT_ID = /^s-[a-z0-9]{1,40}$/;

export const newSnapshotId = (now: Date) => `s-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Snapshot ids come from the web, so they are checked before they become part of a file name. */
export function checkSnapshotId(id: unknown): string {
  if (typeof id !== 'string' || !SNAPSHOT_ID.test(id)) throw new SeoInputError('snapshot must be the id of a crawl snapshot');
  return id;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function readCrawlSettings(buildingId: string): Promise<CrawlSettings> {
  return { ...DEFAULT_CRAWL_SETTINGS, ...(await readJson<Partial<CrawlSettings>>(path.join(dirOf(buildingId), 'settings.json'))) };
}
export const writeCrawlSettings = (buildingId: string, settings: CrawlSettings) => writeJson(path.join(dirOf(buildingId), 'settings.json'), settings);

export const readRun = (buildingId: string) => readJson<RunView>(path.join(dirOf(buildingId), 'run.json'));
export const writeRun = (buildingId: string, run: RunView) => writeJson(path.join(dirOf(buildingId), 'run.json'), run);

export const readWork = (buildingId: string) => readJson<WorkState>(path.join(dirOf(buildingId), 'work.json'));
export const writeWork = (buildingId: string, work: WorkState) => writeJson(path.join(dirOf(buildingId), 'work.json'), work);
export const deleteWork = (buildingId: string) => rm(path.join(dirOf(buildingId), 'work.json'), { force: true });

const cache = new Map<string, Snapshot>();
const cacheKey = (buildingId: string, id: string) => `${buildingId}/${id}`;

export async function writeSnapshot(buildingId: string, snapshot: Snapshot): Promise<void> {
  const { pages, links, rawLinks, ...meta } = snapshot;
  await writeJson(path.join(dirOf(buildingId), `${snapshot.id}.json`), { pages, links, rawLinks });
  await writeJson(path.join(dirOf(buildingId), `${snapshot.id}.meta.json`), meta);
  cache.set(cacheKey(buildingId, snapshot.id), snapshot);
  for (const key of cache.keys()) if (cache.size > 4 && key !== cacheKey(buildingId, snapshot.id)) cache.delete(key);
}

/** Snapshot summaries, newest first. */
export async function listSnapshots(buildingId: string): Promise<SnapshotMeta[]> {
  let names: string[];
  try { names = await readdir(dirOf(buildingId)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const metas = await Promise.all(names.filter((n) => n.endsWith('.meta.json')).map((n) => readJson<SnapshotMeta>(path.join(dirOf(buildingId), n))));
  return metas.filter((m): m is SnapshotMeta => m !== null).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : -1));
}

export async function readSnapshot(buildingId: string, id: string): Promise<Snapshot> {
  checkSnapshotId(id);
  const hit = cache.get(cacheKey(buildingId, id));
  if (hit) return hit;
  const dir = dirOf(buildingId);
  const [meta, body] = await Promise.all([readJson<SnapshotMeta>(path.join(dir, `${id}.meta.json`)), readJson<Pick<Snapshot, 'pages' | 'links' | 'rawLinks'>>(path.join(dir, `${id}.json`))]);
  if (!meta || !body) throw new SeoNotFoundError('That crawl snapshot does not exist');
  const snapshot = { ...meta, ...body };
  cache.set(cacheKey(buildingId, id), snapshot);
  return snapshot;
}

/** The newest snapshot, or null before any crawl. */
export async function latestSnapshot(buildingId: string): Promise<Snapshot | null> {
  const [first] = await listSnapshots(buildingId);
  return first ? readSnapshot(buildingId, first.id) : null;
}

export function forgetSnapshots(buildingId: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${buildingId}/`)) cache.delete(key);
}

/** Partial snapshots are kept separately and sparingly, so stopped runs cannot push out the complete snapshots people compare against. */
export const KEPT_PARTIAL_SNAPSHOTS = 2;

/** Keeps the newest `keepComplete` complete snapshots and the newest few partial ones, so repeated crawls cannot fill the disk. */
export async function pruneSnapshots(buildingId: string, keepComplete: number): Promise<void> {
  const metas = await listSnapshots(buildingId);
  const old = [...metas.filter((m) => m.status === 'complete').slice(keepComplete), ...metas.filter((m) => m.status === 'partial').slice(KEPT_PARTIAL_SNAPSHOTS)];
  for (const meta of old) {
    await rm(path.join(dirOf(buildingId), `${meta.id}.json`), { force: true });
    await rm(path.join(dirOf(buildingId), `${meta.id}.meta.json`), { force: true });
    cache.delete(cacheKey(buildingId, meta.id));
  }
}
