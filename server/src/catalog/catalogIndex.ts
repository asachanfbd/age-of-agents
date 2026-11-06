import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CATALOG_AGENTS_DIR, CATALOG_INDEX_PATH, CATALOG_SKILLS_DIR } from '../config.ts';
import type { Autonomy } from '../domain/types.ts';

/**
 * The sidecar `catalog/catalog-index.json` — the game-only metadata Claude
 * Code itself has no concept of (avatar, manager flag, default autonomy,
 * enabled, triggers), keyed by agent/skill id. The agent markdown files and
 * SKILL.md files stay ordinary and portable; this is the one place that
 * extra metadata lives instead. See docs/architecture.md's Catalog section.
 *
 * Concurrency: every read-modify-write of the index (including the sync that
 * each Catalog read runs) is queued onto one module-level promise chain, so
 * concurrent callers in this process never act on a stale snapshot and undo
 * each other's entries. Writes are atomic (write to a temp file, then rename)
 * so overlapping or crashed writes can never leave a corrupt JSON file.
 */

export interface AgentIndexEntry {
  name: string;
  avatar: string;
  manager: boolean;
  defaultAutonomy: Autonomy;
  enabled: boolean;
}

export interface SkillIndexEntry {
  name: string;
  avatar: string;
  enabled: boolean;
  triggers: string[];
}

export interface CatalogIndexFile {
  agents: Record<string, AgentIndexEntry>;
  skills: Record<string, SkillIndexEntry>;
}

export const DEFAULT_AGENT_AVATAR = '🤖';
export const DEFAULT_SKILL_AVATAR = '🧩';
export const DEFAULT_AUTONOMY: Autonomy = 'auto';

/** A sensible default display name for a file auto-discovered on disk, e.g. "server-daemon-architect" → "Server Daemon Architect". */
export function titleCaseId(id: string): string {
  const words = id.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return id;
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readIndexFile(): Promise<CatalogIndexFile> {
  try {
    const raw = await readFile(CATALOG_INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CatalogIndexFile>;
    return { agents: parsed.agents ?? {}, skills: parsed.skills ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { agents: {}, skills: {} };
    throw error;
  }
}

let tempFileCounter = 0;

async function writeIndexFile(index: CatalogIndexFile): Promise<void> {
  await mkdir(path.dirname(CATALOG_INDEX_PATH), { recursive: true });
  const tempPath = `${CATALOG_INDEX_PATH}.${process.pid}.${++tempFileCounter}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  await rename(tempPath, CATALOG_INDEX_PATH);
}

let indexQueue: Promise<unknown> = Promise.resolve();

/** Runs `operation` after every previously queued index operation settles; a failure is returned to its caller without blocking later ones. */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = indexQueue.then(operation, operation);
  indexQueue = result.catch(() => undefined);
  return result;
}

async function discoverAgentIds(): Promise<string[]> {
  try {
    const entries = await readdir(CATALOG_AGENTS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function discoverSkillIds(): Promise<string[]> {
  try {
    const entries = await readdir(CATALOG_SKILLS_DIR, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await fileExists(path.join(CATALOG_SKILLS_DIR, entry.name, 'SKILL.md'))) ids.push(entry.name);
    }
    return ids.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Re-reads the sidecar index, scans `catalog/agents/*.md` and
 * `catalog/skills/<id>/SKILL.md` for anything not yet indexed, synthesizes a
 * default entry for each (this is how the pre-existing dev-tooling
 * agents/skills, and anything dropped in externally via `npx skills add` or
 * hand-editing, surface with no manual migration step), drops entries whose
 * backing file is gone, and persists the result back — unless nothing
 * actually changed, to avoid rewriting the file on every read.
 */
export function syncCatalogIndex(): Promise<CatalogIndexFile> {
  return enqueue(syncIndexFile);
}

async function syncIndexFile(): Promise<CatalogIndexFile> {
  const [index, agentIds, skillIds] = await Promise.all([readIndexFile(), discoverAgentIds(), discoverSkillIds()]);

  const agents: Record<string, AgentIndexEntry> = {};
  for (const id of agentIds) {
    agents[id] = index.agents[id] ?? {
      name: titleCaseId(id),
      avatar: DEFAULT_AGENT_AVATAR,
      manager: false,
      defaultAutonomy: DEFAULT_AUTONOMY,
      enabled: true,
    };
  }

  const skills: Record<string, SkillIndexEntry> = {};
  for (const id of skillIds) {
    skills[id] = index.skills[id] ?? {
      name: titleCaseId(id),
      avatar: DEFAULT_SKILL_AVATAR,
      enabled: true,
      triggers: [],
    };
  }

  const synced: CatalogIndexFile = { agents, skills };
  if (JSON.stringify(synced) !== JSON.stringify({ agents: index.agents, skills: index.skills })) {
    await writeIndexFile(synced);
  }
  return synced;
}

type IndexSection = 'agents' | 'skills';
type EntryFor<K extends IndexSection> = CatalogIndexFile[K][string];

export function setIndexEntry<K extends IndexSection>(section: K, id: string, entry: EntryFor<K>): Promise<void> {
  return enqueue(async () => {
    const index = await readIndexFile();
    (index[section] as Record<string, EntryFor<K>>)[id] = entry;
    await writeIndexFile(index);
  });
}

export function updateIndexEntry<K extends IndexSection>(section: K, id: string, patch: Partial<EntryFor<K>>): Promise<void> {
  return enqueue(async () => {
    const index = await readIndexFile();
    const table = index[section] as Record<string, EntryFor<K>>;
    const existing = table[id];
    if (!existing) return; // Caller already verified the entry exists via get*/list* — nothing to patch onto.
    table[id] = { ...existing, ...patch };
    await writeIndexFile(index);
  });
}

export function deleteIndexEntry(section: IndexSection, id: string): Promise<void> {
  return enqueue(async () => {
    const index = await readIndexFile();
    delete index[section][id];
    await writeIndexFile(index);
  });
}
