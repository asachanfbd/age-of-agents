import path from 'node:path';
import { buildingDir } from '../buildings/secrets.ts';
import type { ProjectRecord } from '../domain/types.ts';
import type { ContentCtx } from './context.ts';
import { openContentDb, readMeta, writeMeta } from './db.ts';
import type { Db } from './db.ts';
import { DEFAULT_TIMEZONE } from './limits.ts';

const contentFile = (buildingId: string) => path.join(buildingDir(buildingId), 'content.sqlite');

const open = new Map<string, Db>();
/** The Building's database, opened on first use. It lives in the Building's folder, so deleting the Building deletes it. */
function dbFor(buildingId: string): Db {
  let db = open.get(buildingId);
  if (!db) { db = openContentDb(contentFile(buildingId)); open.set(buildingId, db); }
  return db;
}

let clock: () => number = Date.now;
/** Test seam: an injected clock. */
export function setContentClock(now: () => number): void { clock = now; }

const cache = new Map<string, ContentCtx>();
const queues = new Map<string, Promise<unknown>>();

export const TIMEZONE_KEY = 'timezone';

export function contentCtx(project: ProjectRecord): ContentCtx {
  let ctx = cache.get(project.id);
  if (!ctx) {
    const id = project.id;
    const db = dbFor(id);
    ctx = {
      db, buildingId: id, dir: buildingDir(id), now: () => clock(),
      timezone: () => readMeta(db, TIMEZONE_KEY) ?? DEFAULT_TIMEZONE,
      exclusive: <T>(work: () => Promise<T>) => {
        const run = (queues.get(id) ?? Promise.resolve()).then(work, work);
        queues.set(id, run.catch(() => undefined));
        return run;
      },
    };
    cache.set(id, ctx);
  }
  return ctx;
}

/** Saves the create-time zone before anything reads it. */
export function seedTimezone(buildingId: string, timezone: string): void { writeMeta(dbFor(buildingId), TIMEZONE_KEY, timezone); }

/** Stops using a Building's database (it is about to be deleted). */
export function forgetContent(buildingId: string): void {
  cache.delete(buildingId);
  queues.delete(buildingId);
  open.get(buildingId)?.close();
  open.delete(buildingId);
}
