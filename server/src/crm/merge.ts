import { cancelOpenFollowups } from './chains.ts';
import type { CrmCtx } from './context.ts';
import { channelOwner, getContact } from './contacts.ts';
import type { ContactView } from './contacts.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import { mergeCustom, pairKey, pickSegment, suggestPairs, unionTags } from './mergeCompute.ts';
import type { NameCandidate, Pick } from './mergeCompute.ts';
import { nameKey } from './normalize.ts';
import { addEntry } from './timeline.ts';

interface Row { [k: string]: unknown; id: number }
interface Snapshot {
  survivor: Row; absorbed: Row;
  channels: Array<{ row: Row; owner: 'survivor' | 'absorbed' }>;
  timelineIds: number[]; followupIds: number[]; momIds: number[]; links: Array<{ buildingId: string; attachedAt: number }>;
  mergedEntryId: number;
}

const SUGGESTION_PAIRS_MAX = 5_000;
const GROUP_MAX = 20;
const stopsChains = (ctx: CrmCtx, id: number) => Boolean(ctx.db.prepare("SELECT 1 FROM timeline WHERE contactId = ? AND kind = 'response_logged' AND (data LIKE '%\"outcome\":\"interested\"%' OR data LIKE '%\"outcome\":\"later\"%' OR data LIKE '%\"outcome\":\"not_interested\"%' OR data LIKE '%\"outcome\":\"became_customer\"%')").get(id));

export interface MergeInput { firstId: unknown; secondId: unknown; keepSegmentOf?: unknown }

export function mergeContacts(ctx: CrmCtx, input: MergeInput): { contact: ContactView; mergeId: number } {
  const a = input.firstId, b = input.secondId;
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isInteger(a) || !Number.isInteger(b)) throw new CrmInputError('firstId and secondId must be contact ids', 'firstId');
  if (a === b) throw new CrmInputError('Pick two different contacts', 'secondId');
  if (input.keepSegmentOf !== undefined && input.keepSegmentOf !== 'first' && input.keepSegmentOf !== 'second') throw new CrmInputError('keepSegmentOf must be first or second', 'keepSegmentOf');
  const row = (id: number) => {
    const r = ctx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new CrmNotFoundError(`Contact ${id} does not exist`);
    if (r.mergedInto !== null) throw new CrmConflictError(`Contact ${id} was already merged into contact ${r.mergedInto}`);
    return r;
  };
  const first = row(a), second = row(b);
  const keep: Pick = pickSegment({ segment: first.segment as never }, { segment: second.segment as never }, input.keepSegmentOf as Pick | undefined);
  const seg = keep === 'first' ? first : second;
  const now = ctx.now();

  return ctx.db.transaction(() => {
    const channels = ctx.db.prepare('SELECT * FROM channels WHERE contactId IN (?, ?)').all(a, b) as Row[];
    const timelineIds = (ctx.db.prepare('SELECT id FROM timeline WHERE contactId = ?').all(b) as Array<{ id: number }>).map((r) => r.id);
    const followupIds = (ctx.db.prepare('SELECT id FROM followups WHERE contactId = ?').all(b) as Array<{ id: number }>).map((r) => r.id);
    const momIds = (ctx.db.prepare('SELECT id FROM moms WHERE contactId = ?').all(b) as Array<{ id: number }>).map((r) => r.id);
    const links = ctx.db.prepare('SELECT buildingId, attachedAt FROM building_links WHERE contactId = ?').all(b) as Snapshot['links'];

    const custom = mergeCustom(JSON.parse(first.custom as string), JSON.parse(second.custom as string));
    const tags = unionTags(JSON.parse(first.tags as string), JSON.parse(second.tags as string));
    const text = (k: string) => (first[k] as string | null) ?? (second[k] as string | null);
    const name = text('name');
    const dnc = first.dnc === 1 || second.dnc === 1 ? 1 : 0;
    ctx.db.prepare(
      `UPDATE contacts SET name = ?, company = ?, title = ?, nameKey = ?, tags = ?, tagsKey = ?, custom = ?, segment = ?, stage = ?, lostReason = ?, lostAt = ?,
        customerAt = ?, noResponse = ?, noResponseAt = ?, resurfaceAt = ?, callbackAt = ?, dnc = ?, updatedAt = ? WHERE id = ?`,
    ).run(name, text('company'), text('title'), nameKey(name), JSON.stringify(tags), tags.length ? `|${tags.map((t) => t.toLowerCase()).join('|')}|` : '', JSON.stringify(custom.value),
      seg.segment, seg.stage, seg.lostReason, seg.lostAt, (first.customerAt as number | null) ?? (second.customerAt as number | null), seg.noResponse, seg.noResponseAt, seg.resurfaceAt, seg.callbackAt, dnc, now, a);

    ctx.db.prepare('UPDATE channels SET contactId = ? WHERE contactId = ?').run(a, b);
    ctx.db.prepare('UPDATE timeline SET contactId = ? WHERE contactId = ?').run(a, b);
    ctx.db.prepare('UPDATE followups SET contactId = ? WHERE contactId = ?').run(a, b);
    ctx.db.prepare('UPDATE moms SET contactId = ? WHERE contactId = ?').run(a, b);
    ctx.db.prepare('INSERT OR IGNORE INTO building_links (contactId, buildingId, attachedAt) SELECT ?, buildingId, attachedAt FROM building_links WHERE contactId = ?').run(a, b);
    ctx.db.prepare('DELETE FROM building_links WHERE contactId = ?').run(b);
    ctx.db.prepare('UPDATE contacts SET mergedInto = ?, updatedAt = ? WHERE id = ?').run(a, now, b);

    for (const k of custom.kept) addEntry(ctx, a, 'merge_value_kept', `Kept value for a custom field from the other contact: ${k.value}`, k);
    const mergedEntryId = addEntry(ctx, a, 'merged', `Merged contact ${b} into this contact`, { firstId: a, secondId: b, keptSegmentOf: keep });

    // Both contacts' chains are re-evaluated: a reply on either stops all; a customer or lost result has no chains; do-not-contact blocks sends.
    if (dnc || seg.segment !== 'prospect' || stopsChains(ctx, a)) cancelOpenFollowups(ctx, a, 'merge: chains re-evaluated', undefined, !dnc && seg.segment === 'prospect');

    const snapshot: Snapshot = {
      survivor: first, absorbed: second,
      channels: channels.map((c) => ({ row: c, owner: c.contactId === a ? 'survivor' : 'absorbed' })),
      timelineIds, followupIds, momIds, links, mergedEntryId,
    };
    const mergeId = Number(ctx.db.prepare('INSERT INTO merges (survivorId, absorbedId, at, snapshot) VALUES (?, ?, ?, ?)').run(a, b, now, JSON.stringify(snapshot)).lastInsertRowid);
    return { contact: getContact(ctx, a), mergeId };
  })();
}

interface MergeRow { id: number; survivorId: number; absorbedId: number; at: number; snapshot: string; undoneAt: number | null }

export function undoMerge(ctx: CrmCtx, mergeId: number, body: unknown): { survivor: ContactView; restored: ContactView } {
  const m = ctx.db.prepare('SELECT * FROM merges WHERE id = ?').get(mergeId) as MergeRow | undefined;
  if (!m) throw new CrmNotFoundError('That merge does not exist');
  const assign = ((body ?? {}) as { assignLaterEntries?: unknown }).assignLaterEntries ?? 'merged';
  if (assign !== 'merged' && assign !== 'first' && assign !== 'second') throw new CrmInputError('assignLaterEntries must be merged, first or second', 'assignLaterEntries');
  if (m.undoneAt !== null) throw new CrmConflictError('That merge was already undone');
  const later = ctx.db.prepare('SELECT id FROM merges WHERE id > ? AND undoneAt IS NULL AND (survivorId IN (?, ?) OR absorbedId IN (?, ?))').get(m.id, m.survivorId, m.absorbedId, m.survivorId, m.absorbedId);
  if (later) throw new CrmConflictError('A newer merge involves this contact. Undo that merge first.', { reason: 'newer merge' });
  const snap = JSON.parse(m.snapshot) as Snapshot;
  for (const c of snap.channels) {
    const owner = channelOwner(ctx, { type: c.row.type as string, label: c.row.label as string, norm: c.row.norm as string });
    if (owner && owner.contactId !== m.survivorId && owner.contactId !== m.absorbedId) {
      throw new CrmConflictError(`Cannot undo: the ${c.row.type} handle ${c.row.handle} now belongs to contact ${owner.contactId}`, { reason: 'handle in use', handle: c.row.handle, ownerId: owner.contactId });
    }
  }
  const now = ctx.now();
  ctx.db.transaction(() => {
    const restore = (r: Row) => ctx.db.prepare(
      `UPDATE contacts SET name = ?, company = ?, title = ?, nameKey = ?, tags = ?, tagsKey = ?, custom = ?, segment = ?, stage = ?, lostReason = ?, lostAt = ?, customerAt = ?,
        noResponse = ?, noResponseAt = ?, resurfaceAt = ?, callbackAt = ?, dnc = ?, mergedInto = NULL, updatedAt = ? WHERE id = ?`,
    ).run(r.name, r.company, r.title, r.nameKey, r.tags, r.tagsKey, r.custom, r.segment, r.stage, r.lostReason, r.lostAt, r.customerAt, r.noResponse, r.noResponseAt, r.resurfaceAt, r.callbackAt, r.dnc, now, r.id);
    restore(snap.survivor); restore(snap.absorbed);
    for (const c of snap.channels) {
      const target = c.owner === 'survivor' ? m.survivorId : m.absorbedId;
      const exists = channelOwner(ctx, { type: c.row.type as string, label: c.row.label as string, norm: c.row.norm as string });
      if (exists) ctx.db.prepare('UPDATE channels SET contactId = ? WHERE id = ?').run(target, exists.id);
      else ctx.db.prepare('INSERT INTO channels (contactId, type, label, handle, norm, invalid, dnc, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(target, c.row.type, c.row.label, c.row.handle, c.row.norm, c.row.invalid, c.row.dnc, c.row.createdAt);
    }
    const back = (table: string, ids: number[]) => { const st = ctx.db.prepare(`UPDATE ${table} SET contactId = ? WHERE id = ?`); for (const id of ids) st.run(m.absorbedId, id); };
    back('timeline', snap.timelineIds.filter((id) => id !== snap.mergedEntryId)); back('followups', snap.followupIds); back('moms', snap.momIds);
    for (const l of snap.links) {
      ctx.db.prepare('DELETE FROM building_links WHERE contactId = ? AND buildingId = ?').run(m.survivorId, l.buildingId);
      ctx.db.prepare('INSERT OR IGNORE INTO building_links (contactId, buildingId, attachedAt) VALUES (?, ?, ?)').run(m.absorbedId, l.buildingId, l.attachedAt);
    }
    if (assign !== 'merged') {
      const target = assign === 'first' ? m.survivorId : m.absorbedId;
      ctx.db.prepare('UPDATE timeline SET contactId = ? WHERE contactId = ? AND (at > ? OR (at = ? AND id > ?)) AND kind <> ?').run(target, m.survivorId, m.at, m.at, snap.mergedEntryId, 'merged');
    }
    ctx.db.prepare('UPDATE merges SET undoneAt = ? WHERE id = ?').run(now, m.id);
    addEntry(ctx, m.survivorId, 'unmerged', `Merge with contact ${m.absorbedId} undone`, { mergeId: m.id });
    addEntry(ctx, m.absorbedId, 'unmerged', `Restored from a merge into contact ${m.survivorId}`, { mergeId: m.id });
  })();
  return { survivor: getContact(ctx, m.survivorId), restored: getContact(ctx, m.absorbedId) };
}

export function listMerges(ctx: CrmCtx, contactId: number): Array<{ id: number; survivorId: number; absorbedId: number; at: number; undone: boolean }> {
  return (ctx.db.prepare('SELECT id, survivorId, absorbedId, at, undoneAt FROM merges WHERE survivorId = ? OR absorbedId = ? ORDER BY id DESC').all(contactId, contactId) as Array<{ id: number; survivorId: number; absorbedId: number; at: number; undoneAt: number | null }>)
    .map((r) => ({ id: r.id, survivorId: r.survivorId, absorbedId: r.absorbedId, at: r.at, undone: r.undoneAt !== null }));
}

export interface Suggestion { first: NameCandidate; second: NameCandidate }

export function listSuggestions(ctx: CrmCtx, limit: number, offset: number): { rows: Suggestion[]; total: number; capped: boolean } {
  const dismissed = new Set((ctx.db.prepare('SELECT a, b FROM dismissed_pairs').all() as Array<{ a: number; b: number }>).map((r) => `${r.a}:${r.b}`));
  // One pass over the contacts whose name key is shared, in key order; a group is closed when the key changes.
  const rows = ctx.db.prepare(
    `SELECT id, name, company, nameKey FROM contacts WHERE mergedInto IS NULL AND nameKey IN
       (SELECT nameKey FROM contacts WHERE mergedInto IS NULL AND nameKey <> '' GROUP BY nameKey HAVING COUNT(*) > 1) ORDER BY nameKey, id`,
  ).iterate() as IterableIterator<NameCandidate & { nameKey: string }>;
  const all: Suggestion[] = [];
  let capped = false;
  let key = '';
  let group: NameCandidate[] = [];
  const flush = () => { for (const [first, second] of suggestPairs(group, dismissed)) all.push({ first, second }); group = []; };
  for (const r of rows) {
    if (r.nameKey !== key) { flush(); key = r.nameKey; if (all.length >= SUGGESTION_PAIRS_MAX) { capped = true; break; } }
    if (group.length < GROUP_MAX) group.push({ id: r.id, name: r.name, company: r.company });
  }
  if (!capped) flush();
  return { rows: all.slice(offset, offset + limit), total: all.length, capped };
}

export function dismissPair(ctx: CrmCtx, aId: unknown, bId: unknown): void {
  if (typeof aId !== 'number' || typeof bId !== 'number' || aId === bId) throw new CrmInputError('Give two different contact ids', 'firstId');
  for (const id of [aId, bId]) if (!ctx.db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(id)) throw new CrmNotFoundError(`Contact ${id} does not exist`);
  const [lo, hi] = pairKey(aId, bId);
  ctx.db.prepare('INSERT OR IGNORE INTO dismissed_pairs (a, b) VALUES (?, ?)').run(lo, hi);
}
