import { readFile, writeFile } from 'node:fs/promises';
import { EXECUTORS_EXAMPLE_PATH, EXECUTORS_PATH } from '../config.ts';
import type { ExecutorProfile } from '../domain/types.ts';

interface ExecutorsFile {
  executors: ExecutorProfile[];
}

export class ExecutorNotFoundError extends Error {
  constructor() {
    super('This executor is not configured — see server/executors.example.json');
    this.name = 'ExecutorNotFoundError';
  }
}

/** Refuses to remove the last configured executor — startTask's getDefaultExecutor() needs at least one to fall back to. */
export class LastExecutorError extends Error {
  constructor() {
    super('Cannot remove the last configured executor — at least one is required to start a Task');
    this.name = 'LastExecutorError';
  }
}

/**
 * Machine-specific, hand-edited config (server/executors.json, git-ignored —
 * see server/executors.example.json for the shape). Falls back to the
 * committed example so a fresh checkout still has a working default. Read
 * fresh every call, same as the Catalog, since it's meant to be editable
 * between runs.
 */
export async function listExecutors(): Promise<ExecutorProfile[]> {
  const raw = await readFile(EXECUTORS_PATH, 'utf-8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFile(EXECUTORS_EXAMPLE_PATH, 'utf-8');
  });
  const parsed = JSON.parse(raw) as ExecutorsFile;
  return parsed.executors;
}

export async function getExecutor(id: string): Promise<ExecutorProfile | undefined> {
  const executors = await listExecutors();
  return executors.find((e) => e.id === id);
}

export async function getDefaultExecutor(): Promise<ExecutorProfile> {
  const executors = await listExecutors();
  const first = executors[0];
  if (!first) throw new Error('No executors configured — see server/executors.example.json');
  return first;
}

/** Fields a caller can set through the settings panel — everything except the server-assigned `id`. */
export interface ExecutorInput {
  label: string;
  kind: ExecutorProfile['kind'];
  bin: string;
  env?: Record<string, string>;
}

const EXECUTOR_KINDS: ExecutorProfile['kind'][] = ['claude-cli', 'codex-cli'];

function validateExecutorInput(input: Partial<ExecutorInput>): void {
  if (input.label !== undefined && !input.label.trim()) throw new Error('label is required');
  if (input.bin !== undefined && !input.bin.trim()) throw new Error('bin is required');
  if (input.kind !== undefined && !EXECUTOR_KINDS.includes(input.kind)) {
    throw new Error(`kind must be one of: ${EXECUTOR_KINDS.join(', ')}`);
  }
}

/** Turns a display label into a stable, URL/file-safe id, e.g. "Claude (work)" → "claude-work". */
function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'executor';
}

/** Appends "-2", "-3", … until the id no longer collides with an already-configured one. */
function uniqueId(base: string, existing: ExecutorProfile[]): string {
  const taken = new Set(existing.map((e) => e.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Persists the full executor list back to server/executors.json — created
 * from the committed example on the very first write, same fallback
 * listExecutors() already relies on for reads.
 */
async function saveExecutors(executors: ExecutorProfile[]): Promise<void> {
  await writeFile(EXECUTORS_PATH, `${JSON.stringify({ executors }, null, 2)}\n`, 'utf-8');
}

/** Adds a new hand-configured way to run a Task — the settings panel's "add coding agent". */
export async function createExecutor(input: ExecutorInput): Promise<ExecutorProfile> {
  validateExecutorInput(input);
  const executors = await listExecutors();
  const profile: ExecutorProfile = {
    id: uniqueId(slugify(input.label), executors),
    label: input.label.trim(),
    kind: input.kind,
    bin: input.bin.trim(),
    env: input.env ?? {},
  };
  await saveExecutors([...executors, profile]);
  return profile;
}

/** Edits an existing executor in place — its id never changes, even if the label does. */
export async function updateExecutor(id: string, patch: Partial<ExecutorInput>): Promise<ExecutorProfile> {
  validateExecutorInput(patch);
  const executors = await listExecutors();
  const existing = executors.find((e) => e.id === id);
  if (!existing) throw new ExecutorNotFoundError();
  const updated: ExecutorProfile = {
    ...existing,
    ...(patch.label !== undefined && { label: patch.label.trim() }),
    ...(patch.kind !== undefined && { kind: patch.kind }),
    ...(patch.bin !== undefined && { bin: patch.bin.trim() }),
    ...(patch.env !== undefined && { env: patch.env }),
  };
  await saveExecutors(executors.map((e) => (e.id === id ? updated : e)));
  return updated;
}

/** Removes a configured executor — refuses when it's the only one left (LastExecutorError) or unknown (ExecutorNotFoundError). */
export async function removeExecutor(id: string): Promise<void> {
  const executors = await listExecutors();
  if (!executors.some((e) => e.id === id)) throw new ExecutorNotFoundError();
  if (executors.length === 1) throw new LastExecutorError();
  await saveExecutors(executors.filter((e) => e.id !== id));
}
