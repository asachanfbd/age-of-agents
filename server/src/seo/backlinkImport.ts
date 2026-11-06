import type { LinkInput } from './backlinkRows.ts';

/** A stored backlink. Metrics the files never gave are null. */
export interface LinkRec {
  uid: string;
  key: string;
  sourceUrl: string;
  sourceHost: string;
  targetUrl: string;
  anchor: string;
  linkType: string | null;
  firstSeen: string;
  lastSeen: string;
  sourceDr: number | null;
  sourceUr: number | null;
  sourceTraffic: number | null;
  pageDr: number | null;
  pageUr: number | null;
  pageTraffic: number | null;
  otherHost: boolean;
  extras: Record<string, string>;
  note: string;
  /** Number of the import batch that first brought the link in. */
  firstBatch: number;
  /** The day a full export marked the link lost, or '' while it is not lost. */
  lostAt: string;
}

export type LinkStatus = 'live' | 'new' | 'lost';
export const LINK_STATUSES: readonly LinkStatus[] = ['live', 'new', 'lost'];
export type ImportMode = 'full' | 'partial';

export const statusOf = (link: LinkRec, latestBatch: number): LinkStatus => (link.lostAt ? 'lost' : link.firstBatch === latestBatch ? 'new' : 'live');

export interface ImportCounts { added: number; updated: number; unchanged: number; lost: number; returned: number }
export interface ImportPlan { changes: LinkRec[]; counts: ImportCounts }

const METRICS = ['sourceDr', 'sourceUr', 'sourceTraffic', 'pageDr', 'pageUr', 'pageTraffic'] as const;
const sameRec = (a: LinkRec, b: LinkRec): boolean => JSON.stringify(a) === JSON.stringify(b);

function merged(old: LinkRec, input: LinkInput, today: string): LinkRec {
  const next: LinkRec = { ...old, extras: { ...old.extras, ...input.extras }, lostAt: '', otherHost: input.otherHost };
  for (const m of METRICS) if (input[m] !== null) next[m] = input[m];
  if (input.linkType !== null) next.linkType = input.linkType;
  next.firstSeen = input.firstSeen && input.firstSeen < old.firstSeen ? input.firstSeen : old.firstSeen;
  const seenLast = input.lastSeen ?? today;
  next.lastSeen = seenLast > old.lastSeen ? seenLast : old.lastSeen;
  return next;
}

/**
 * Applies one import to the stored links. Links in the file are added or updated (a value the file leaves empty never
 * overwrites a stored one); a link that was lost and is listed again is live again. A full export marks every stored,
 * not-yet-lost link that the file does not list as lost, except links whose row was invalid but still identified the
 * link, because a typo in a row says nothing about the link. A partial update never marks anything lost.
 */
export function planImport(
  existing: Map<string, LinkRec>, inputs: LinkInput[], skippedKeys: Set<string>, mode: ImportMode, batch: number, today: string, newUid: () => string,
): ImportPlan {
  const counts: ImportCounts = { added: 0, updated: 0, unchanged: 0, lost: 0, returned: 0 };
  const changes: LinkRec[] = [];
  const listed = new Set<string>();
  for (const input of inputs) {
    listed.add(input.key);
    const old = existing.get(input.key);
    if (!old) {
      counts.added++;
      changes.push({
        uid: newUid(), key: input.key, sourceUrl: input.sourceUrl, sourceHost: input.sourceHost, targetUrl: input.targetUrl, anchor: input.anchor, linkType: input.linkType,
        firstSeen: input.firstSeen ?? today, lastSeen: input.lastSeen ?? today, sourceDr: input.sourceDr, sourceUr: input.sourceUr, sourceTraffic: input.sourceTraffic,
        pageDr: input.pageDr, pageUr: input.pageUr, pageTraffic: input.pageTraffic, otherHost: input.otherHost, extras: input.extras, note: '', firstBatch: batch, lostAt: '',
      });
      continue;
    }
    const next = merged(old, input, today);
    if (sameRec(old, next)) { counts.unchanged++; continue; }
    if (old.lostAt) counts.returned++;
    counts.updated++;
    changes.push(next);
  }
  if (mode === 'full') {
    for (const old of existing.values()) {
      if (old.lostAt || listed.has(old.key) || skippedKeys.has(old.key)) continue;
      counts.lost++;
      changes.push({ ...old, lostAt: today });
    }
  }
  return { changes, counts };
}

/** How many links a full export of these rows would mark lost, for the preview. */
export const lostCount = (existing: Map<string, LinkRec>, inputs: LinkInput[], skippedKeys: Set<string>): number => planImport(existing, inputs, skippedKeys, 'full', 0, '', () => '').counts.lost;
