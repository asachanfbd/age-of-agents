import { SeoInputError } from './errors.ts';
import { MAX_KEYWORD_LENGTH, nameKeyOf, normalizeKeyword } from './keywordRules.ts';

export interface Candidate { key: string; display: string; pinned: boolean; clusterId: string | null; impressions: number }

export interface Selection { selected: Candidate[]; total: number; capped: boolean; message: string | null }

const byImpressions = (a: Candidate, b: Candidate) => b.impressions - a.impressions || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The keywords one run sends to the agent: keywords nobody placed yet come first, then placed ones the person has not
 * pinned, then pinned ones (which the agent may only comment on); within each group highest impressions first, ties by
 * keyword. The cap keeps the run's cost bounded, and the message says how many were left for the next run.
 */
export function selectCandidates(all: Candidate[], cap: number): Selection {
  const rank = (c: Candidate) => (c.pinned ? 2 : c.clusterId ? 1 : 0);
  const ordered = [...all].sort((a, b) => rank(a) - rank(b) || byImpressions(a, b));
  const selected = ordered.slice(0, cap);
  const capped = ordered.length > cap;
  return {
    selected, total: ordered.length, capped,
    message: capped ? `Processed ${cap} of ${ordered.length} keywords this run (keywords without a cluster first, then highest impressions). Run again to place the rest.` : null,
  };
}

export function splitBatches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AgentGroup { name: string; keys: string[] }

/**
 * Checks what the agent answered: `{ clusters: [{ name, keywords: [text] }] }`. Names must be 1 to 500 characters.
 * Keywords the batch did not contain are dropped (the agent may not invent keywords). Anything else is refused, because a
 * half-understood answer must not change the person's clusters.
 */
export function parseClusterOutput(output: unknown, allowed: ReadonlySet<string>): AgentGroup[] {
  const bad = (why: string): never => { throw new SeoInputError(`The agent's clustering answer was not usable: ${why}`); };
  const clusters = (output as { clusters?: unknown } | null)?.clusters;
  if (!Array.isArray(clusters)) return bad('it has no list of clusters');
  return clusters.map((c): AgentGroup => {
    const { name, keywords } = (c ?? {}) as { name?: unknown; keywords?: unknown };
    if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_KEYWORD_LENGTH) return bad('a cluster has no usable name');
    if (!Array.isArray(keywords)) return bad(`cluster "${name.trim().slice(0, 40)}" has no list of keywords`);
    const keys = keywords.map((k) => normalizeKeyword(k)).filter((k): k is string => k !== null && allowed.has(k));
    return { name: name.trim().replace(/\s+/g, ' '), keys };
  });
}

export interface PlanState {
  /** The keywords this run sent to the agent, with where they are now. */
  sent: Map<string, { pinned: boolean; clusterId: string | null }>;
  clusters: Map<string, { id: string; name: string; nameKey: string }>;
}

export interface Move { key: string; clusterId: string | null; newName: string | null }
export interface Suggestion { key: string; fromClusterId: string | null; toName: string }
export interface Plan { moves: Move[]; suggestions: Suggestion[]; createdNames: string[] }

/**
 * Turns the agent's groups into changes. A keyword the agent returns twice is placed by its first group only; a keyword it
 * leaves out stays where it is; a keyword it was not sent is ignored. An unpinned keyword is moved (into the existing
 * cluster of the same name, compared without case, or a new one). A pinned keyword is never moved: when the agent
 * would put it somewhere else, that becomes a suggestion for the person.
 */
export function planClustering(state: PlanState, groups: AgentGroup[]): Plan {
  const byNameKey = new Map([...state.clusters.values()].map((c) => [c.nameKey, c]));
  const created = new Map<string, string>();
  const placed = new Set<string>();
  const moves: Move[] = [];
  const suggestions: Suggestion[] = [];
  for (const group of groups) {
    const nameKey = nameKeyOf(group.name);
    const existing = byNameKey.get(nameKey);
    for (const key of group.keys) {
      const now = state.sent.get(key);
      if (!now || placed.has(key)) continue;
      placed.add(key);
      if (existing ? now.clusterId === existing.id : false) continue;
      if (now.pinned) {
        suggestions.push({ key, fromClusterId: now.clusterId, toName: existing?.name ?? group.name });
        continue;
      }
      if (!existing && !created.has(nameKey)) created.set(nameKey, group.name);
      moves.push({ key, clusterId: existing?.id ?? null, newName: existing ? null : created.get(nameKey)! });
    }
  }
  return { moves, suggestions, createdNames: [...created.values()] };
}
