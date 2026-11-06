import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A minimal, dependency-free file-based database: one JSON file per
 * collection, holding `{ records: T[] }`. This is the "local file-based
 * database" agent-visual-os's central runtime state store is built on — see
 * docs/architecture.md#one-central-runtime-state-store-docs-stay-per-project.
 *
 * Not a general-purpose embedded database: no indices, no queries beyond a
 * linear `find`. That's deliberate (YAGNI) — the daemon manages, at most, a
 * handful of Projects and one active Task each in v1.
 *
 * Concurrency: every mutation is queued onto a single promise chain per
 * instance, so concurrent callers never interleave a read-modify-write cycle
 * against the same file. Writes are atomic (write to a temp file, then
 * rename) so a crash mid-write can never leave a truncated JSON file behind.
 */
export class FileDatabase<T extends { id: string }> {
  #filePath: string;
  #cache: T[] | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async all(): Promise<T[]> {
    const records = await this.#load();
    return [...records];
  }

  async get(id: string): Promise<T | undefined> {
    const records = await this.#load();
    return records.find((r) => r.id === id);
  }

  async find(predicate: (record: T) => boolean): Promise<T[]> {
    const records = await this.#load();
    return records.filter(predicate);
  }

  insert(record: T): Promise<T> {
    return this.#mutate(async (records) => {
      if (records.some((r) => r.id === record.id)) {
        throw new Error(`FileDatabase: record with id "${record.id}" already exists`);
      }
      records.push(record);
      return record;
    });
  }

  update(id: string, patch: Partial<Omit<T, 'id'>>): Promise<T | undefined> {
    return this.#mutate(async (records) => {
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) return undefined;
      const current = records[index] as T;
      const updated = { ...current, ...patch, id: current.id };
      records[index] = updated;
      return updated;
    });
  }

  /** Applies a set of record patches in one collection write, or none if any id is missing. */
  updateMany(patches: { id: string; patch: Partial<Omit<T, 'id'>> }[]): Promise<T[]> {
    return this.#mutate(async (records) => {
      const updated: T[] = [];
      for (const { id, patch } of patches) {
        const index = records.findIndex((record) => record.id === id);
        if (index === -1) throw new Error(`FileDatabase: record with id "${id}" does not exist`);
        const current = records[index] as T;
        const next = { ...current, ...patch, id: current.id };
        records[index] = next;
        updated.push(next);
      }
      return updated;
    });
  }

  /**
   * Like `update`, but the patch is computed from the record's own live,
   * queue-serialized state (via `fn`) rather than a value the caller read
   * earlier — race-safe when several independent callers can each patch the
   * same record around the same time (e.g. two concurrent Tasks on one
   * Project each adjusting that Project's active-task set — see
   * server/src/worker/workerManager.ts). `fn` may be async; it runs inside
   * this instance's own serialized mutation queue, so the record it sees is
   * always the latest one, never a stale read from before some other queued
   * mutation landed. `fn` also receives every record of the collection, for
   * checks that span records (e.g. a slot another Project already holds).
   */
  updateWith(id: string, fn: (record: T, records: readonly T[]) => Partial<Omit<T, 'id'>> | Promise<Partial<Omit<T, 'id'>>>): Promise<T | undefined> {
    return this.#mutate(async (records) => {
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) return undefined;
      const current = records[index] as T;
      const patch = await fn(current, records);
      const updated = { ...current, ...patch, id: current.id };
      records[index] = updated;
      return updated;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.#mutate(async (records) => {
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      return true;
    });
  }

  async #load(): Promise<T[]> {
    if (this.#cache) return this.#cache;
    try {
      const raw = await readFile(this.#filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { records: T[] };
      this.#cache = parsed.records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#cache = [];
      } else {
        throw error;
      }
    }
    return this.#cache;
  }

  /** Serializes every read-modify-write cycle through one promise chain. */
  #mutate<R>(fn: (records: T[]) => Promise<R>): Promise<R> {
    const run = this.#queue.then(async () => {
      // Work on a copy so a failed persist never exposes an uncommitted mutation through the cache.
      const records = (await this.#load()).map((record) => ({ ...record }));
      const result = await fn(records);
      await this.#persist(records);
      return result;
    });
    // Swallow so one failed mutation doesn't wedge the queue for the next caller.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #persist(records: T[]): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const tmpPath = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ records }, null, 2));
    await rename(tmpPath, this.#filePath);
    this.#cache = records;
  }
}
