import { SeoConflictError, SeoInputError, SeoNotFoundError } from './errors.ts';
import { MAX_BULK_KEYS, nameKeyOf, normalizeKeyword, requireName } from './keywordRules.ts';
import type { KeywordSource, KeywordStatus } from './keywordRules.ts';

/** A keyword the person or an import has touched. Keywords only seen in Search Console have no record until something is done to them. */
export interface KeywordRec {
  key: string;
  display: string;
  /** Where the keyword came from besides Search Console, which is implied by its data. */
  sources: Array<Exclude<KeywordSource, 'gsc'>>;
  status: KeywordStatus;
  /** A manual placement. A clustering run never moves a pinned keyword. */
  pinned: boolean;
  clusterId: string | null;
  targetPage: string;
  createdAt: string;
}

export interface ClusterRec { id: string; name: string; nameKey: string; pinned: boolean; createdAt: string }

/** What an edit sees: the clusters, the stored keywords, and a lookup for keywords known only from Search Console. */
export interface EditState {
  clusters: Map<string, ClusterRec>;
  keywords: Map<string, KeywordRec>;
  /** The display text of a keyword Search Console reported, or null. */
  gscDisplay(key: string): string | null;
  newId(): string;
  now(): string;
}

/** The records an edit writes: a cluster set to null is deleted. Nothing is written until the whole edit succeeded. */
export interface Changes { clusters: Map<string, ClusterRec | null>; keywords: Map<string, KeywordRec> }

const empty = (): Changes => ({ clusters: new Map(), keywords: new Map() });

function clusterOf(state: EditState, id: unknown): ClusterRec {
  const c = typeof id === 'string' ? state.clusters.get(id) : undefined;
  if (!c) throw new SeoNotFoundError('That cluster does not exist');
  return c;
}

function assertNameFree(state: EditState, name: string, exceptId?: string): string {
  const clean = requireName(name, 'cluster name');
  const taken = [...state.clusters.values()].find((c) => c.nameKey === nameKeyOf(clean) && c.id !== exceptId);
  if (taken) throw new SeoConflictError('A cluster with that name already exists');
  return clean;
}

/** The stored record for a keyword, or a fresh one for a keyword only Search Console has seen. Unknown keywords are a 404. */
export function recordFor(state: EditState, key: string, source?: Exclude<KeywordSource, 'gsc'>, changes?: Changes): KeywordRec {
  const existing = changes?.keywords.get(key) ?? state.keywords.get(key);
  if (existing) return { ...existing };
  const display = state.gscDisplay(key);
  if (display === null) throw new SeoNotFoundError('That keyword is not tracked in this Building');
  return { key, display, sources: source ? [source] : [], status: 'tracking', pinned: false, clusterId: null, targetPage: '', createdAt: state.now() };
}

/** Normalises and de-duplicates the keywords an edit names, and refuses an empty or over-long list. */
export function requireKeys(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length) throw new SeoInputError('keys must be a list with at least one keyword');
  if (input.length > MAX_BULK_KEYS) throw new SeoInputError(`at most ${MAX_BULK_KEYS} keywords can be changed at once`);
  const keys = new Set<string>();
  for (const k of input) {
    const key = normalizeKeyword(k);
    if (!key) throw new SeoInputError('every keyword must be text of 1 to 500 characters');
    keys.add(key);
  }
  return [...keys];
}

export function createCluster(state: EditState, nameInput: unknown): { changes: Changes; cluster: ClusterRec } {
  const name = assertNameFree(state, nameInput as string);
  const cluster: ClusterRec = { id: state.newId(), name, nameKey: nameKeyOf(name), pinned: true, createdAt: state.now() };
  const changes = empty();
  changes.clusters.set(cluster.id, cluster);
  return { changes, cluster };
}

/** Renaming is a manual edit: the cluster's name is pinned and a clustering run will not rename it. */
export function renameCluster(state: EditState, id: unknown, nameInput: unknown): Changes {
  const cluster = clusterOf(state, id);
  const name = assertNameFree(state, nameInput as string, cluster.id);
  const changes = empty();
  changes.clusters.set(cluster.id, { ...cluster, name, nameKey: nameKeyOf(name), pinned: true });
  return changes;
}

/** Moves the sources' keywords into the target and deletes the sources. Keywords keep their pins; the target keeps its name. */
export function mergeClusters(state: EditState, sourceIds: unknown, targetId: unknown): Changes {
  const target = clusterOf(state, targetId);
  if (!Array.isArray(sourceIds) || !sourceIds.length) throw new SeoInputError('sourceIds must list at least one cluster');
  const sources = [...new Set(sourceIds)].map((id) => clusterOf(state, id));
  if (sources.some((s) => s.id === target.id)) throw new SeoInputError('a cluster cannot be merged into itself');
  const changes = empty();
  const ids = new Set(sources.map((s) => s.id));
  for (const s of sources) changes.clusters.set(s.id, null);
  for (const k of state.keywords.values()) if (k.clusterId && ids.has(k.clusterId)) changes.keywords.set(k.key, { ...k, clusterId: target.id });
  return changes;
}

/** Puts the chosen keywords into a new cluster. Moving them pins them. Selecting none, or every keyword of the cluster, is refused. */
export function splitCluster(state: EditState, id: unknown, keysInput: unknown, nameInput: unknown): { changes: Changes; cluster: ClusterRec } {
  const source = clusterOf(state, id);
  const keys = requireKeys(keysInput);
  const members = [...state.keywords.values()].filter((k) => k.clusterId === source.id);
  const memberKeys = new Set(members.map((m) => m.key));
  if (keys.some((k) => !memberKeys.has(k))) throw new SeoInputError('every keyword to split must belong to the cluster');
  if (keys.length >= members.length) throw new SeoInputError('leave at least one keyword in the original cluster');
  const { changes, cluster } = createCluster(state, nameInput);
  for (const key of keys) changes.keywords.set(key, { ...state.keywords.get(key)!, clusterId: cluster.id, pinned: true });
  return { changes, cluster };
}

/** Deleting a cluster sends its keywords to Unclustered and unpins them, so the next clustering run can place them again. */
export function deleteCluster(state: EditState, id: unknown): Changes {
  const cluster = clusterOf(state, id);
  const changes = empty();
  changes.clusters.set(cluster.id, null);
  for (const k of state.keywords.values()) if (k.clusterId === cluster.id) changes.keywords.set(k.key, { ...k, clusterId: null, pinned: false });
  return changes;
}

/** Moves keywords into a cluster (or to Unclustered with a null id). A move is a manual edit, so the keywords are pinned. */
export function moveKeywords(state: EditState, keysInput: unknown, clusterId: unknown): Changes {
  const keys = requireKeys(keysInput);
  if (clusterId !== null) clusterOf(state, clusterId);
  const changes = empty();
  for (const key of keys) changes.keywords.set(key, { ...recordFor(state, key, undefined, changes), clusterId: clusterId as string | null, pinned: true });
  return changes;
}

/** The state after the changes; used to prove every keyword is in exactly one cluster that exists. */
export function applyChanges(state: Pick<EditState, 'clusters' | 'keywords'>, changes: Changes): { clusters: Map<string, ClusterRec>; keywords: Map<string, KeywordRec> } {
  const clusters = new Map(state.clusters);
  for (const [id, c] of changes.clusters) { if (c) clusters.set(id, c); else clusters.delete(id); }
  const keywords = new Map(state.keywords);
  for (const [key, k] of changes.keywords) keywords.set(key, k);
  return { clusters, keywords };
}
