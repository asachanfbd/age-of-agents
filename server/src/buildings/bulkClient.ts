import { Worker } from 'node:worker_threads';
import type { ReplaceStep, StorageSpec } from './contract.ts';
import type { AggregateRequest, GroupSumsRequest, ListRequest } from './query.ts';

export class StorageCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageCrashError';
  }
}

export class StorageOpError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(info: { message: string; code?: string; name?: string; status?: number }) {
    super(info.message);
    this.name = info.name ?? 'StorageOpError';
    this.code = info.code;
    this.status = info.status;
  }
}

export interface OpenOptions {
  file: string;
  spec: StorageSpec;
  version: number;
  backupDir: string;
  faultInjection?: boolean;
}

export interface OpenOutcome { status: 'ok' | 'migrated' | 'newer' | 'failed'; version: number; backupFile?: string; error?: string }
export interface Progress { done: number; total: number; /** Set while a bulk load builds its indexes after the last row. */ phase?: 'indexing' }
export interface Job<T> { id: number; result: Promise<T>; cancel(): void }

interface Pending { resolve(value: any): void; reject(error: Error): void; onProgress?: (p: Progress) => void }

const WORKER_URL = new URL('./bulkWorker.ts', import.meta.url);

/**
 * The daemon's handle on one Building's database. All database work happens in a worker thread; this class only
 * relays messages. If the thread dies, every pending call rejects with `StorageCrashError` and the next call starts a
 * fresh thread and reopens the file, so a crash costs at most the batch that was in flight.
 */
export class BulkStore {
  #options: OpenOptions;
  #worker: Worker | null = null;
  #starting: Promise<OpenOutcome> | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  lastOpen: OpenOutcome | null = null;

  constructor(options: OpenOptions) {
    this.#options = options;
  }

  get alive(): boolean { return this.#worker !== null; }

  async open(): Promise<OpenOutcome> {
    await this.#ensureWorker();
    return this.lastOpen!;
  }

  async #ensureWorker(): Promise<Worker> {
    if (this.#closed) throw new StorageCrashError('This Building\'s storage is closed');
    if (this.#worker) return this.#worker;
    this.#starting ??= this.#spawn();
    try { await this.#starting; } finally { this.#starting = null; }
    return this.#worker!;
  }

  async #spawn(): Promise<OpenOutcome> {
    const worker = new Worker(WORKER_URL, { execArgv: ['--no-warnings'] });
    this.#worker = worker;
    worker.on('message', (m) => this.#onMessage(m));
    const fail = (error: Error) => {
      if (this.#worker === worker) this.#worker = null;
      const crash = new StorageCrashError(`The storage worker stopped: ${error.message}`);
      for (const p of this.#pending.values()) p.reject(crash);
      this.#pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`exit code ${code}`)));
    const outcome = await this.#send<OpenOutcome>(worker, 'open', this.#options);
    this.lastOpen = outcome;
    return outcome;
  }

  #onMessage(m: { id: number; type: string; value?: unknown; error?: any; done?: number; total?: number; phase?: 'indexing' }): void {
    const pending = this.#pending.get(m.id);
    if (!pending) return;
    if (m.type === 'progress') { pending.onProgress?.({ done: m.done!, total: m.total!, phase: m.phase }); return; }
    this.#pending.delete(m.id);
    if (m.type === 'result') pending.resolve(m.value);
    else pending.reject(new StorageOpError(m.error));
  }

  #send<T>(worker: Worker, op: string, payload: object, onProgress?: (p: Progress) => void): Promise<T> & { id: number } {
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ ...payload, op, id });
    }) as Promise<T> & { id: number };
    promise.id = id;
    return promise;
  }

  async call<T>(op: string, payload: object = {}, onProgress?: (p: Progress) => void): Promise<T> {
    return this.#send<T>(await this.#ensureWorker(), op, payload, onProgress);
  }

  /** A long operation: resolves with its result, reports progress, and can be cancelled between batches. */
  startJob<T>(op: string, payload: object, onProgress?: (p: Progress) => void): Job<T> {
    let jobId = 0;
    const result = this.#ensureWorker().then((worker) => {
      const call = this.#send<T>(worker, op, payload, onProgress);
      jobId = call.id;
      return call;
    });
    return { get id() { return jobId; }, result, cancel: () => { if (jobId) this.#worker?.postMessage({ op: 'cancel', cancel: jobId }); } };
  }

  insert(table: string, rows: Array<Array<string | number>>) { return this.call<{ inserted: number }>('insert', { table, rows }); }
  list(table: string, request: ListRequest) { return this.call<{ rows: Array<Record<string, string | number>>; nextCursor: string | null; total: null }>('list', { table, request }); }
  aggregate(rollup: string, request: AggregateRequest) { return this.call<{ rows: Array<Record<string, string | number>>; source: string }>('aggregate', { rollup, request }); }
  /** Per-group sums over a whole table or roll-up with no 200-group page cap (see `groupSums` in the worker). */
  groupSums(request: GroupSumsRequest) { return this.call<{ rows: Array<Record<string, string | number>>; capped: boolean }>('groupSums', request); }
  /** Replaces matching rows (and fixes the roll-ups) across several tables in one transaction. */
  replaceRows(steps: ReplaceStep[]) { return this.call<{ removed: number; inserted: number }>('replaceRows', { steps }); }
  retentionPreview(now: string, months?: number) { return this.call<{ cutoff: string | null; tables: Array<{ table: string; count: number }> }>('retentionPreview', { now, months }); }
  count(table: string) { return this.call<{ count: number }>('count', { table }); }
  backup(dest: string) { return this.call<{ dest: string }>('backup', { dest }); }
  setFault(fault: { code: string; atRow?: number } | null) { return this.call('setFault', { fault }); }

  /** Test seam: kills the thread without a goodbye, as a crash would. */
  async terminateForTest(): Promise<void> {
    await this.#worker?.terminate();
  }

  async close(): Promise<void> {
    this.#closed = true;
    const worker = this.#worker;
    if (!worker) return;
    try { await this.#send(worker, 'close', {}); } catch { /* already gone */ }
    await worker.terminate();
    this.#worker = null;
  }
}
