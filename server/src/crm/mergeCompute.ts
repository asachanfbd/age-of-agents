import { nameKey } from './normalize.ts';
import type { Segment } from './stage.ts';

export type Pick = 'first' | 'second';

/** Which contact's segment and stage survive. The owner's choice wins; otherwise a customer beats a prospect and an active contact beats a lost one. */
export function pickSegment(first: { segment: Segment }, second: { segment: Segment }, choice?: Pick): Pick {
  if (choice) return choice;
  const rank = (s: Segment) => (s === 'customer' ? 3 : s === 'prospect' ? 2 : s === 'lost_customer' ? 1 : 0);
  return rank(second.segment) > rank(first.segment) ? 'second' : 'first';
}

export function unionTags(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The first-picked contact's value wins when both have one; the other's is returned in `kept` for the timeline. */
export function mergeCustom(first: Record<string, string>, second: Record<string, string>): { value: Record<string, string>; kept: Array<{ fieldId: string; value: string }> } {
  const value: Record<string, string> = { ...second, ...Object.fromEntries(Object.entries(first).filter(([, v]) => v !== '')) };
  const kept: Array<{ fieldId: string; value: string }> = [];
  for (const [id, v] of Object.entries(second)) if (v !== '' && first[id] && first[id] !== '' && first[id] !== v) kept.push({ fieldId: id, value: v });
  return { value, kept };
}

export interface Timed { id: number; at: number }
/** Both lists in time order, stable at equal times (first list, then second, then by id). */
export function interleave<T extends Timed>(a: T[], b: T[]): T[] {
  return [...a.map((t) => ({ t, o: 0 })), ...b.map((t) => ({ t, o: 1 }))].sort((x, y) => x.t.at - y.t.at || x.o - y.o || x.t.id - y.t.id).map((x) => x.t);
}

export interface NameCandidate { id: number; name: string | null; company: string | null }
/** Same name ignoring case and accents, and the same company when both have one. */
export function isNameDuplicate(a: NameCandidate, b: NameCandidate): boolean {
  const ka = nameKey(a.name);
  if (!ka || ka !== nameKey(b.name)) return false;
  const ca = nameKey(a.company), cb = nameKey(b.company);
  return !ca || !cb || ca === cb;
}

export const pairKey = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

/** Candidate pairs from contacts already grouped by name key; a dismissed pair is left out. */
export function suggestPairs(group: NameCandidate[], dismissed: Set<string>): Array<[NameCandidate, NameCandidate]> {
  const out: Array<[NameCandidate, NameCandidate]> = [];
  for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i]!, b = group[j]!;
    const [lo, hi] = pairKey(a.id, b.id);
    if (dismissed.has(`${lo}:${hi}`) || !isNameDuplicate(a, b)) continue;
    out.push(a.id < b.id ? [a, b] : [b, a]);
  }
  return out;
}
