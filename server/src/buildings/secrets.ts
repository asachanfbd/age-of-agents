import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { redactSecrets, rememberSecret } from '../redaction.ts';

/**
 * The one place credentials and integration settings are stored. A secret lives in its Building's own file
 * (`<data>/buildings/<id>/secrets.json`, owner-only permissions), or in the app-wide file (`<data>/secrets.json`)
 * when every Building shares it. A value is never copied into a record, a log line or an API response: callers get
 * `hasSecret` and nothing else. A hosted store can replace this class later without changing any caller.
 */

export const buildingsRoot = () => path.join(DATA_DIR, 'buildings');
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** A Building's folder. The id must be a plain name so it can never point outside the buildings folder. */
export function buildingDir(buildingId: string): string {
  if (!SAFE_ID.test(buildingId)) throw new Error('Not a valid Building id');
  return path.join(buildingsRoot(), buildingId);
}

/** The app-wide secrets file, shared by every Building. */
export const appSecretsFile = () => path.join(DATA_DIR, 'secrets.json');

export { redactSecrets };

/** Remembers a credential that only lives in memory (a `gh` token), with the encodings it could show up in. */
export function registerSecret(value: string): void {
  rememberSecret(value, true);
}

/** Remembers every saved value so the scrub list is complete from the first log line after a restart. */
export async function loadKnownSecrets(): Promise<void> {
  const ids = await readdir(buildingsRoot()).catch(() => [] as string[]);
  for (const id of ids) if (SAFE_ID.test(id)) await new SecretsStore(id).list().catch(() => undefined);
  await appSecrets().list().catch(() => undefined);
}

/** A log argument as text with secrets removed; objects are scrubbed through their JSON form. */
function scrubArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactSecrets(arg);
  if (arg instanceof Error) return redactSecrets(arg.stack ?? arg.message);
  if (typeof arg === 'object' && arg !== null) {
    try {
      const text = JSON.stringify(arg);
      const scrubbed = redactSecrets(text);
      return scrubbed === text ? arg : scrubbed;
    } catch { return arg; }
  }
  return arg;
}

/** Wraps console so a secret value never reaches the daemon log, even inside an error message or an object. */
export function installLogRedaction(target: Pick<Console, 'log' | 'error' | 'warn'> = console): void {
  for (const level of ['log', 'error', 'warn'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => original(...args.map(scrubArg));
  }
}

/** Names that would collide with object internals. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class SecretsStore {
  #file: string;
  /** One queue per Building file, so two concurrent saves never overwrite each other. */
  static #queues = new Map<string, Promise<unknown>>();

  /** A Building's store, or `{ file }` for a store outside the buildings folder (see `appSecrets`). */
  constructor(owner: string | { file: string }) {
    this.#file = typeof owner === 'string' ? path.join(buildingDir(owner), 'secrets.json') : owner.file;
  }

  async #read(): Promise<Record<string, string>> {
    try {
      const parsed = Object.assign(Object.create(null), JSON.parse(await readFile(this.#file, 'utf8'))) as Record<string, string>;
      for (const v of Object.values(parsed)) rememberSecret(v);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null);
      throw error;
    }
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = (SecretsStore.#queues.get(this.#file) ?? Promise.resolve()).then(work, work);
    SecretsStore.#queues.set(this.#file, run.catch(() => undefined));
    return run;
  }

  async #write(all: Record<string, string>): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.#file);
  }

  set(key: string, value: unknown): Promise<void> {
    return this.setMany({ [key]: value });
  }

  /** Saves several values in one write, so a reader never sees some of them without the others. */
  setMany(entries: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      if (!key.trim() || FORBIDDEN_KEYS.has(key)) return Promise.reject(new TypeError('That is not a valid secret name'));
      if (typeof value !== 'string' || !value) return Promise.reject(new TypeError('A secret value must be a non-empty string'));
    }
    return this.#exclusive(async () => {
      const all = await this.#read();
      for (const [key, value] of Object.entries(entries as Record<string, string>)) {
        all[key] = value;
        rememberSecret(value);
      }
      await this.#write(all);
    });
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.#read())[key];
  }

  /** The names that have a value: the only thing an API or the browser ever sees. */
  async list(): Promise<Array<{ key: string; hasSecret: true }>> {
    return Object.keys(await this.#read()).sort().map((key) => ({ key, hasSecret: true }));
  }

  delete(...keys: string[]): Promise<void> {
    return this.#exclusive(async () => {
      const all = await this.#read();
      const present = keys.filter((key) => key in all);
      if (!present.length) return;
      for (const key of present) delete all[key];
      await this.#write(all);
    });
  }

  async deleteAll(): Promise<void> {
    await rm(this.#file, { force: true });
  }
}

/** The app-wide store (`<data>/secrets.json`) for credentials every Building shares. */
export const appSecrets = () => new SecretsStore({ file: appSecretsFile() });
