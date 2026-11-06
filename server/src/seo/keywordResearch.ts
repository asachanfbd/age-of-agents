import { SeoInputError } from './errors.ts';
import { MAX_COMPETITORS, normalizeKeyword } from './keywordRules.ts';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAX_HOST_LENGTH = 253;

/** Turns what the person typed (`https://Rival.com/path` or `rival.com`) into a bare lower-case domain. Local and numeric addresses are refused: the agent is meant to look at public sites. */
export function competitorDomain(input: unknown): string {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) throw new SeoInputError('a competitor must be a domain such as rival.com');
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) throw new SeoInputError('a competitor must be a web address starting with http or https, or a bare domain');
  let host: string;
  try { host = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase().replace(/\.$/, ''); } catch { throw new SeoInputError(`"${text.slice(0, 60)}" is not a domain`); }
  if (!host || host.length > MAX_HOST_LENGTH) throw new SeoInputError(`a domain must be 1 to ${MAX_HOST_LENGTH} characters`);
  if (host === 'localhost' || host.endsWith('.localhost') || host.includes(':') || host.startsWith('[') || IPV4.test(host) || !host.includes('.')) throw new SeoInputError(`"${host.slice(0, 60)}" is not a public domain`);
  return host;
}

export function competitorDomains(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new SeoInputError('competitors must be a list of domains');
  const domains = [...new Set(input.map(competitorDomain))];
  if (domains.length > MAX_COMPETITORS) throw new SeoInputError(`at most ${MAX_COMPETITORS} competitors can be named`);
  return domains;
}

export interface Idea { keyword: string; origin: 'agent' | 'ads'; reason: string; volume?: unknown }

/** Reads the agent's research answer: `{ keywords: [{ keyword, reason }] }` (plain strings are accepted as keywords). */
export function parseResearchOutput(output: unknown): Array<{ keyword: string; reason: string }> {
  const list = (output as { keywords?: unknown } | null)?.keywords;
  if (!Array.isArray(list)) throw new SeoInputError("The agent's research answer was not usable: it has no list of keywords");
  return list.map((item) => {
    const keyword = typeof item === 'string' ? item : (item as { keyword?: unknown } | null)?.keyword;
    const reason = typeof item === 'object' && item !== null && typeof (item as { reason?: unknown }).reason === 'string' ? (item as { reason: string }).reason.slice(0, 300) : '';
    if (typeof keyword !== 'string') throw new SeoInputError("The agent's research answer was not usable: a keyword is not text");
    return { keyword, reason };
  });
}

/** Ideas that are new: not already tracked, rejected or waiting for review (compared by normalised keyword), and not repeated within the run. First idea wins. */
export function freshIdeas(ideas: Idea[], excluded: ReadonlySet<string>): Array<Idea & { key: string }> {
  const seen = new Set(excluded);
  const out: Array<Idea & { key: string }> = [];
  for (const idea of ideas) {
    const key = normalizeKeyword(idea.keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...idea, key });
  }
  return out;
}
