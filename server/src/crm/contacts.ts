import type { Statement } from 'better-sqlite3';
import type { CrmCtx } from './context.ts';
import { cancelOpenFollowups } from './chains.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import { CUSTOM_VALUE_MAX } from './limits.ts';
import { CHANNEL_TYPES, nameKey, normaliseHandle } from './normalize.ts';
import type { ChannelType } from './normalize.ts';
import { escapeLike, pageOf } from './paging.ts';
import type { Page } from './paging.ts';
import { MESSAGE_TYPES } from './settings.ts';
import { isStage, SEGMENTS } from './stage.ts';
import type { Segment, Stage } from './stage.ts';
import { addEntry } from './timeline.ts';

export interface ChannelView { id: number; type: ChannelType; label: string; handle: string; invalid: boolean; dnc: boolean }
export interface ContactView {
  id: number; name: string | null; company: string | null; title: string | null; tags: string[]; custom: Record<string, string>;
  segment: Segment; stage: Stage | null; lostReason: string | null; lostAt: number | null; customerAt: number | null;
  noResponse: boolean; noResponseAt: number | null; resurfaceAt: number | null; callbackAt: number | null; dnc: boolean;
  source: string; batchId: number | null; mergedInto: number | null; createdAt: number; channels: ChannelView[];
  pendingReachout?: boolean; awaitingApproval?: boolean;
}

interface ContactRow {
  id: number; name: string | null; company: string | null; title: string | null; tags: string; custom: string; segment: Segment; stage: Stage | null;
  lostReason: string | null; lostAt: number | null; customerAt: number | null; noResponse: number; noResponseAt: number | null; resurfaceAt: number | null;
  callbackAt: number | null; dnc: number; source: string; batchId: number | null; mergedInto: number | null; createdAt: number;
  pendingReachout?: number; awaitingApproval?: number;
}
interface ChannelRow { id: number; contactId: number; type: ChannelType; label: string; handle: string; invalid: number; dnc: number }

const channelView = (c: ChannelRow): ChannelView => ({ id: c.id, type: c.type, label: c.label, handle: c.handle, invalid: c.invalid === 1, dnc: c.dnc === 1 });

/** A contact read with every defined custom field present; a value stored before the field existed reads as "". */
function toView(ctx: CrmCtx, r: ContactRow, channels: ChannelRow[]): ContactView {
  const stored = JSON.parse(r.custom) as Record<string, string>;
  const custom: Record<string, string> = {};
  for (const f of ctx.settings().customFields) custom[f.id] = stored[f.id] ?? '';
  return {
    id: r.id, name: r.name, company: r.company, title: r.title, tags: JSON.parse(r.tags), custom, segment: r.segment, stage: r.stage,
    lostReason: r.lostReason, lostAt: r.lostAt, customerAt: r.customerAt, noResponse: r.noResponse === 1, noResponseAt: r.noResponseAt,
    resurfaceAt: r.resurfaceAt, callbackAt: r.callbackAt, dnc: r.dnc === 1, source: r.source, batchId: r.batchId, mergedInto: r.mergedInto,
    createdAt: r.createdAt, channels: channels.map(channelView),
    ...(r.pendingReachout !== undefined ? { pendingReachout: r.pendingReachout === 1, awaitingApproval: r.awaitingApproval === 1 } : {}),
  };
}

export function channelsOf(ctx: CrmCtx, contactId: number): ChannelRow[] {
  return ctx.db.prepare('SELECT * FROM channels WHERE contactId = ? ORDER BY id').all(contactId) as ChannelRow[];
}

export function getContact(ctx: CrmCtx, id: number): ContactView {
  const row = ctx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  if (!row || row.mergedInto !== null) throw new CrmNotFoundError('That contact does not exist');
  return toView(ctx, row, channelsOf(ctx, id));
}

// ---- input checks -------------------------------------------------------

export function cleanTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CrmInputError('tags must be a list', 'tags');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') throw new CrmInputError('Each tag must be text', 'tags');
    const tag = t.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    if (tag.includes('|')) throw new CrmInputError('A tag cannot contain "|"', 'tags');
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}
const tagsKey = (tags: string[]) => (tags.length ? `|${tags.map((t) => t.toLowerCase()).join('|')}|` : '');

export function cleanCustom(ctx: CrmCtx, raw: unknown, base: Record<string, string> = {}): Record<string, string> {
  if (raw === undefined || raw === null) return base;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new CrmInputError('custom must be an object', 'custom');
  const out = { ...base };
  const known = new Set(ctx.settings().customFields.map((f) => f.id));
  for (const [id, value] of Object.entries(raw)) {
    if (!known.has(id)) throw new CrmInputError(`Unknown custom field "${id}"`, 'custom');
    if (typeof value !== 'string') throw new CrmInputError('A custom value must be text', 'custom');
    if ([...value].length > CUSTOM_VALUE_MAX) throw new CrmInputError(`A custom value can be at most ${CUSTOM_VALUE_MAX} characters`, 'custom');
    out[id] = value;
  }
  return out;
}

const optText = (v: unknown, name: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new CrmInputError(`${name} must be text`, name);
  const t = v.trim();
  if (t.length > 300) throw new CrmInputError(`${name} must be at most 300 characters`, name);
  return t || null;
};

export interface NewChannel { type: ChannelType; label: string; handle: string; norm: string }

export function checkChannel(ctx: CrmCtx, raw: unknown): NewChannel {
  const c = (raw ?? {}) as { type?: unknown; label?: unknown; handle?: unknown };
  if (!CHANNEL_TYPES.includes(c.type as ChannelType)) throw new CrmInputError(`channel type must be one of ${CHANNEL_TYPES.join(', ')}`, 'type');
  const type = c.type as ChannelType;
  const label = type === 'other' ? (typeof c.label === 'string' ? c.label.trim() : '') : '';
  const n = normaliseHandle(type, c.handle, { countryCode: ctx.settings().countryCode, label });
  if (!n.ok) throw new CrmInputError(n.reason, 'handle');
  return { type, label, handle: String(c.handle).trim(), norm: n.value };
}

export function channelOwner(ctx: CrmCtx, c: { type: string; label: string; norm: string }): { id: number; contactId: number } | undefined {
  return ctx.db.prepare('SELECT id, contactId FROM channels WHERE type = ? AND label = ? AND norm = ?').get(c.type, c.label, c.norm) as { id: number; contactId: number } | undefined;
}

function refuseOwned(ctx: CrmCtx, c: NewChannel): void {
  const owner = channelOwner(ctx, c);
  if (!owner) return;
  const seg = (ctx.db.prepare('SELECT segment FROM contacts WHERE id = ?').get(owner.contactId) as { segment: Segment }).segment;
  throw new CrmConflictError(`That ${c.type} handle already belongs to contact ${owner.contactId}`, { ownerId: owner.contactId, lost: seg.startsWith('lost'), offerReopen: seg.startsWith('lost') });
}

// ---- create -------------------------------------------------------------

export interface ContactFields { name: string | null; company: string | null; title: string | null; tags: string[]; custom: Record<string, string> }
export interface InsertOptions { source: string; batchId: number | null }

const contactStatements = new WeakMap<object, { contact: Statement<unknown[]>; channel: Statement<unknown[]> }>();

/** Writes a validated contact and its channels. Callers wrap it in a transaction; the statements are prepared once per database so a large import stays fast. */
export function insertContact(ctx: CrmCtx, f: ContactFields, channels: NewChannel[], o: InsertOptions): number {
  let st = contactStatements.get(ctx.db);
  if (!st) {
    st = {
      contact: ctx.db.prepare(`INSERT INTO contacts (name, company, title, nameKey, tags, tagsKey, custom, stage, source, batchId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?)`),
      channel: ctx.db.prepare('INSERT INTO channels (contactId, type, label, handle, norm, createdAt) VALUES (?, ?, ?, ?, ?, ?)'),
    };
    contactStatements.set(ctx.db, st);
  }
  const now = ctx.now();
  const id = Number(st.contact.run(f.name, f.company, f.title, nameKey(f.name), JSON.stringify(f.tags), tagsKey(f.tags), JSON.stringify(f.custom), o.source, o.batchId, now, now).lastInsertRowid);
  for (const c of channels) st.channel.run(id, c.type, c.label, c.handle, c.norm, now);
  addEntry(ctx, id, 'added', `Added (${o.source})`, { source: o.source, batchId: o.batchId }, now);
  return id;
}

export function createContact(ctx: CrmCtx, body: unknown, o: InsertOptions = { source: 'added by hand', batchId: null }): ContactView {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.channels) || b.channels.length === 0) throw new CrmInputError('A contact needs at least one channel', 'channels');
  const channels = b.channels.map((c) => checkChannel(ctx, c));
  const keys = new Set<string>();
  for (const c of channels) {
    const k = `${c.type}|${c.label}|${c.norm}`;
    if (keys.has(k)) throw new CrmInputError('The same handle is listed twice', 'channels');
    keys.add(k);
    refuseOwned(ctx, c);
  }
  const fields: ContactFields = { name: optText(b.name, 'name'), company: optText(b.company, 'company'), title: optText(b.title, 'title'), tags: cleanTags(b.tags), custom: cleanCustom(ctx, b.custom) };
  return getContact(ctx, ctx.db.transaction(() => insertContact(ctx, fields, channels, o))());
}

// ---- edit ---------------------------------------------------------------

export function patchContact(ctx: CrmCtx, id: number, body: unknown): ContactView {
  const cur = getContact(ctx, id);
  const b = (body ?? {}) as Record<string, unknown>;
  const name = b.name !== undefined ? optText(b.name, 'name') : cur.name;
  const company = b.company !== undefined ? optText(b.company, 'company') : cur.company;
  const title = b.title !== undefined ? optText(b.title, 'title') : cur.title;
  const tags = b.tags !== undefined ? cleanTags(b.tags) : cur.tags;
  const stored = JSON.parse((ctx.db.prepare('SELECT custom FROM contacts WHERE id = ?').get(id) as { custom: string }).custom) as Record<string, string>;
  const custom = cleanCustom(ctx, b.custom, stored);
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE contacts SET name = ?, company = ?, title = ?, nameKey = ?, tags = ?, tagsKey = ?, custom = ?, updatedAt = ? WHERE id = ?')
      .run(name, company, title, nameKey(name), JSON.stringify(tags), tagsKey(tags), JSON.stringify(custom), ctx.now(), id);
    addEntry(ctx, id, 'contact_edited', 'Contact details edited');
  })();
  return getContact(ctx, id);
}

export function addChannel(ctx: CrmCtx, contactId: number, body: unknown): ContactView {
  getContact(ctx, contactId);
  const c = checkChannel(ctx, body);
  refuseOwned(ctx, c);
  ctx.db.transaction(() => {
    ctx.db.prepare('INSERT INTO channels (contactId, type, label, handle, norm, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(contactId, c.type, c.label, c.handle, c.norm, ctx.now());
    addEntry(ctx, contactId, 'channel_changed', `Added ${c.type} ${c.handle}`);
  })();
  return getContact(ctx, contactId);
}

function ownChannel(ctx: CrmCtx, contactId: number, channelId: number): ChannelRow {
  const ch = ctx.db.prepare('SELECT * FROM channels WHERE id = ? AND contactId = ?').get(channelId, contactId) as ChannelRow | undefined;
  if (!ch) throw new CrmNotFoundError('That channel does not exist');
  return ch;
}

export function removeChannel(ctx: CrmCtx, contactId: number, channelId: number): ContactView {
  const ch = ownChannel(ctx, contactId, channelId);
  ctx.db.transaction(() => {
    cancelOpenFollowups(ctx, contactId, 'channel removed', String(channelId));
    ctx.db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    addEntry(ctx, contactId, 'channel_changed', `Removed ${ch.type} ${ch.handle}`);
  })();
  return getContact(ctx, contactId);
}

export function patchChannel(ctx: CrmCtx, contactId: number, channelId: number, body: unknown): ContactView {
  const ch = ownChannel(ctx, contactId, channelId);
  const b = (body ?? {}) as { invalid?: unknown; dnc?: unknown };
  for (const k of ['invalid', 'dnc'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw new CrmInputError(`${k} must be true or false`, k);
  ctx.db.transaction(() => {
    if (b.invalid !== undefined) {
      ctx.db.prepare('UPDATE channels SET invalid = ? WHERE id = ?').run(b.invalid ? 1 : 0, channelId);
      addEntry(ctx, contactId, 'channel_changed', `${ch.type} ${ch.handle} marked ${b.invalid ? 'invalid' : 'valid'}`);
      if (b.invalid) cancelOpenFollowups(ctx, contactId, 'channel marked invalid', String(channelId));
    }
    if (b.dnc !== undefined) {
      ctx.db.prepare('UPDATE channels SET dnc = ? WHERE id = ?').run(b.dnc ? 1 : 0, channelId);
      addEntry(ctx, contactId, 'dnc_changed', `Do-not-contact ${b.dnc ? 'set' : 'cleared'} on ${ch.type} ${ch.handle}`, { channelId, dnc: b.dnc });
      if (b.dnc) cancelOpenFollowups(ctx, contactId, 'do-not-contact on this channel', String(channelId));
    }
  })();
  return getContact(ctx, contactId);
}

export function setContactDnc(ctx: CrmCtx, id: number, value: unknown): ContactView {
  getContact(ctx, id);
  if (typeof value !== 'boolean') throw new CrmInputError('dnc must be true or false', 'dnc');
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE contacts SET dnc = ?, updatedAt = ? WHERE id = ?').run(value ? 1 : 0, ctx.now(), id);
    addEntry(ctx, id, 'dnc_changed', `Do-not-contact ${value ? 'set' : 'cleared'} on the contact`, { dnc: value });
    if (value) cancelOpenFollowups(ctx, id, 'do-not-contact');
  })();
  return getContact(ctx, id);
}

// ---- segments -----------------------------------------------------------

export function setStage(ctx: CrmCtx, id: number, stage: unknown): ContactView {
  const c = getContact(ctx, id);
  if (c.segment !== 'prospect') throw new CrmConflictError('Only a prospect has a stage');
  if (!isStage(stage)) throw new CrmInputError('stage is not a known stage', 'stage');
  moveStage(ctx, id, c.stage, stage, 'by hand');
  return getContact(ctx, id);
}

/** Writes a stage change and its timeline entry; callers decide whether the move is allowed. */
export function moveStage(ctx: CrmCtx, id: number, from: Stage | null, to: Stage, why: string): void {
  if (from === to) return;
  ctx.db.prepare('UPDATE contacts SET stage = ?, updatedAt = ? WHERE id = ?').run(to, ctx.now(), id);
  addEntry(ctx, id, 'stage_changed', `Stage ${from ?? 'none'} → ${to} (${why})`, { from, to, why });
}

export function markLost(ctx: CrmCtx, id: number, reason: unknown): ContactView {
  const c = getContact(ctx, id);
  if (c.segment.startsWith('lost')) throw new CrmConflictError('That contact is already lost');
  if (typeof reason !== 'string' || !ctx.settings().lostReasons.includes(reason)) throw new CrmInputError('Pick a reason from the lost reason list', 'reason');
  const now = ctx.now();
  const segment: Segment = c.segment === 'customer' ? 'lost_customer' : 'lost_prospect';
  ctx.db.transaction(() => {
    cancelOpenFollowups(ctx, id, `lost: ${reason}`);
    ctx.db.prepare('UPDATE contacts SET segment = ?, stage = NULL, lostReason = ?, lostAt = ?, noResponse = 0, resurfaceAt = NULL, callbackAt = NULL, updatedAt = ? WHERE id = ?').run(segment, reason, now, now, id);
    addEntry(ctx, id, 'segment_moved', `Moved to ${segment === 'lost_customer' ? 'lost customers' : 'lost prospects'}: ${reason}`, { from: c.segment, to: segment, reason });
  })();
  return getContact(ctx, id);
}

export function reopen(ctx: CrmCtx, id: number, stage?: unknown): ContactView {
  const c = getContact(ctx, id);
  if (!c.segment.startsWith('lost')) throw new CrmConflictError('Only a lost contact can be reopened');
  if (stage !== undefined && stage !== null && !isStage(stage)) throw new CrmInputError('stage is not a known stage', 'stage');
  const to: Segment = c.segment === 'lost_customer' ? 'customer' : 'prospect';
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE contacts SET segment = ?, stage = ?, lostReason = NULL, lostAt = NULL, updatedAt = ? WHERE id = ?')
      .run(to, to === 'prospect' ? ((stage as Stage | undefined | null) ?? 'New') : null, ctx.now(), id);
    addEntry(ctx, id, 'segment_moved', `Reopened as ${to}`, { from: c.segment, to });
  })();
  return getContact(ctx, id);
}

export function markCustomer(ctx: CrmCtx, id: number): ContactView {
  const c = getContact(ctx, id);
  if (c.segment !== 'prospect') throw new CrmConflictError(c.segment === 'customer' ? 'That contact is already a customer' : 'A lost contact must be reopened first');
  const now = ctx.now();
  ctx.db.transaction(() => {
    cancelOpenFollowups(ctx, id, 'became a customer');
    ctx.db.prepare("UPDATE contacts SET segment = 'customer', stage = NULL, customerAt = ?, noResponse = 0, resurfaceAt = NULL, updatedAt = ? WHERE id = ?").run(now, now, id);
    addEntry(ctx, id, 'segment_moved', 'Became a customer', { from: 'prospect', to: 'customer' });
  })();
  return getContact(ctx, id);
}

// ---- list ---------------------------------------------------------------

export const FLAGS = ['dnc', 'noResponse', 'pending', 'approval', 'invalid'] as const;

// Only message items wait on a send; calls and meetings are marked done instead, so they never raise these flags.
const MESSAGE_TYPES_SQL = MESSAGE_TYPES.map((t) => `'${t}'`).join(',');
const PENDING_SQL = `EXISTS (SELECT 1 FROM followups f JOIN channels ch ON ch.id = CAST(f.chain AS INTEGER) WHERE f.contactId = c.id AND f.state = 'pending' AND f.type IN (${MESSAGE_TYPES_SQL}) AND ch.type <> 'email')`;
const APPROVAL_SQL = `EXISTS (SELECT 1 FROM followups f JOIN channels ch ON ch.id = CAST(f.chain AS INTEGER) WHERE f.contactId = c.id AND f.state = 'pending' AND f.type IN (${MESSAGE_TYPES_SQL}) AND ch.type = 'email')`;

export function listContacts(ctx: CrmCtx, q: Record<string, unknown>): Page<ContactView> {
  const where = ['c.mergedInto IS NULL'];
  const params: unknown[] = [];
  const str = (name: string): string | undefined => {
    const v = q[name];
    if (v === undefined || v === '') return undefined;
    if (typeof v !== 'string') throw new CrmInputError(`${name} must be text`, name);
    return v;
  };
  const segment = str('segment');
  if (segment) {
    if (segment === 'lost') where.push("c.segment IN ('lost_prospect','lost_customer')");
    else if ((SEGMENTS as readonly string[]).includes(segment)) { where.push('c.segment = ?'); params.push(segment); }
    else throw new CrmInputError('segment is not known', 'segment');
  }
  const stage = str('stage');
  if (stage) { if (!isStage(stage)) throw new CrmInputError('stage is not known', 'stage'); where.push('c.stage = ?'); params.push(stage); }
  const channel = str('channel');
  if (channel) {
    if (!CHANNEL_TYPES.includes(channel as ChannelType)) throw new CrmInputError('channel is not known', 'channel');
    where.push('EXISTS (SELECT 1 FROM channels ch WHERE ch.contactId = c.id AND ch.type = ?)'); params.push(channel);
  }
  const batch = str('batch');
  if (batch) {
    const id = /^\d+$/.test(batch) ? Number(batch) : NaN;
    if (!Number.isSafeInteger(id)) throw new CrmInputError('batch must be a batch id', 'batch');
    where.push('c.batchId = ?'); params.push(id);
  }
  const flag = str('flag');
  if (flag) {
    if (!(FLAGS as readonly string[]).includes(flag)) throw new CrmInputError('flag is not known', 'flag');
    where.push({
      dnc: 'c.dnc = 1', noResponse: 'c.noResponse = 1', pending: PENDING_SQL, approval: APPROVAL_SQL,
      invalid: 'EXISTS (SELECT 1 FROM channels ch WHERE ch.contactId = c.id AND ch.invalid = 1)',
    }[flag as (typeof FLAGS)[number]]);
  }
  const tag = str('tag');
  if (tag) { where.push("c.tagsKey LIKE ? ESCAPE '\\'"); params.push(`%|${escapeLike(tag.toLowerCase())}|%`); }
  const search = str('search')?.trim();
  if (search) {
    const like = `%${escapeLike(search.toLowerCase())}%`;
    where.push("(lower(c.name) LIKE ? ESCAPE '\\' OR lower(c.company) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM channels ch WHERE ch.contactId = c.id AND (ch.norm LIKE ? ESCAPE '\\' OR lower(ch.handle) LIKE ? ESCAPE '\\')))");
    params.push(like, like, like, like);
  }
  const page = pageOf<ContactRow, ContactRow>(ctx.db, {
    select: `SELECT c.*, ${PENDING_SQL} AS pendingReachout, ${APPROVAL_SQL} AS awaitingApproval FROM contacts c`,
    countFrom: 'FROM contacts c', where, params, order: 'c.id DESC', limit: q.limit, offset: q.offset, map: (r) => r,
  });
  const ids = page.rows.map((r) => r.id);
  const byContact = new Map<number, ChannelRow[]>();
  if (ids.length) {
    for (const ch of ctx.db.prepare(`SELECT * FROM channels WHERE contactId IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as ChannelRow[]) {
      byContact.set(ch.contactId, [...(byContact.get(ch.contactId) ?? []), ch]);
    }
  }
  return { ...page, rows: page.rows.map((r) => toView(ctx, r, byContact.get(r.id) ?? [])) };
}
