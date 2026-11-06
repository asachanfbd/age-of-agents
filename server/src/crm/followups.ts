import { cancelOpenFollowups, getFollowupRow } from './chains.ts';
import type { FollowupRow } from './chains.ts';
import type { CrmCtx } from './context.ts';
import { channelsOf, getContact, moveStage } from './contacts.ts';
import type { ContactView } from './contacts.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import { followupDue, hasNextStep, retryOutcome } from './cadence.ts';
import type { ChannelType } from './normalize.ts';
import { pageOf } from './paging.ts';
import type { Page } from './paging.ts';
import { FOLLOWUP_TYPES, MESSAGE_TYPES, sendsWithoutApproval } from './settings.ts';
import type { FollowupType } from './settings.ts';
import { autoStage } from './stage.ts';
import { renderTemplate, templateFor } from './templates.ts';
import { addEntry } from './timeline.ts';
import type { TimelineKind } from './timeline.ts';

/** Email is the one integrated channel; every other channel uses the manual flow. */
export const INTEGRATED_CHANNELS: readonly ChannelType[] = ['email'];
const FOLLOWUP_STATES = ['planned', 'pending', 'approved', 'sent', 'failed', 'cancelled', 'done'];
export const PLATFORM_FOR: Record<ChannelType, string> = { phone: 'Phone', email: 'Email', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', other: 'Other' };

export interface FollowupView {
  id: number; contactId: number; contactName: string | null; channelId: number | null; channelType: ChannelType | null; channelHandle: string | null;
  kind: FollowupRow['kind']; step: number; type: FollowupType; state: string; title: string; dueAt: number; message: string | null; draft: string | null;
  platform: string | null; defaultPlatform: string | null; sentAt: number | null; doneAt: number | null; tries: number; retryAt: number | null; delayReason: string | null;
  durationMin: number; catchUp: boolean; unknownFields: string[]; integrated: boolean; checkedAt: number | null;
}

const tlKind = (row: Pick<FollowupRow, 'kind'>, suffix: string) => `${row.kind === 'reachout' ? 'reachout' : 'followup'}_${suffix}` as TimelineKind;

export function followupView(ctx: CrmCtx, r: FollowupRow): FollowupView {
  const contact = ctx.db.prepare('SELECT name FROM contacts WHERE id = ?').get(r.contactId) as { name: string | null } | undefined;
  const ch = r.channelId ? (ctx.db.prepare('SELECT type, handle FROM channels WHERE id = ?').get(r.channelId) as { type: ChannelType; handle: string } | undefined) : undefined;
  return {
    id: r.id, contactId: r.contactId, contactName: contact?.name ?? null, channelId: r.channelId, channelType: ch?.type ?? null, channelHandle: ch?.handle ?? null,
    kind: r.kind, step: r.step, type: r.type as FollowupType, state: r.state, title: r.title, dueAt: r.dueAt, message: r.message, draft: r.draft,
    platform: r.platform, defaultPlatform: ch ? PLATFORM_FOR[ch.type] : null, sentAt: r.sentAt, doneAt: r.doneAt, tries: r.tries, retryAt: r.retryAt,
    delayReason: r.delayReason, durationMin: r.durationMin ?? ctx.settings().durations[r.type as FollowupType] ?? 1, catchUp: r.catchUp === 1,
    unknownFields: JSON.parse(r.unknownFields), integrated: ch ? INTEGRATED_CHANNELS.includes(ch.type) : false, checkedAt: r.checkedAt,
  };
}

export function getFollowup(ctx: CrmCtx, id: number): FollowupRow {
  const row = getFollowupRow(ctx, id);
  if (!row) throw new CrmNotFoundError('That item does not exist');
  return row;
}

export function listFollowups(ctx: CrmCtx, q: Record<string, unknown>): Page<FollowupView> {
  const where: string[] = [], params: unknown[] = [];
  if (q.contactId !== undefined && q.contactId !== '') {
    const id = typeof q.contactId === 'number' ? q.contactId : typeof q.contactId === 'string' && /^\d{1,15}$/.test(q.contactId) ? Number(q.contactId) : NaN;
    if (!Number.isSafeInteger(id)) throw new CrmInputError('contactId must be a contact id', 'contactId');
    where.push('contactId = ?'); params.push(id);
  }
  if (q.state !== undefined && q.state !== '') {
    if (typeof q.state !== 'string' || !FOLLOWUP_STATES.includes(q.state)) throw new CrmInputError(`state must be one of ${FOLLOWUP_STATES.join(', ')}`, 'state');
    where.push('state = ?'); params.push(q.state);
  }
  return pageOf<FollowupRow, FollowupView>(ctx.db, { select: 'SELECT * FROM followups', where, params, order: 'dueAt ASC, id ASC', limit: q.limit, offset: q.offset, map: (r) => followupView(ctx, r) });
}

/** Refuses a send to a contact or channel the owner must not contact, or that is known to be wrong. */
export function assertSendable(contact: ContactView, channel: { type: string; invalid: boolean; dnc: boolean } | undefined): void {
  if (contact.segment.startsWith('lost')) throw new CrmConflictError('That contact is lost. Reopen it first.');
  if (contact.dnc) throw new CrmConflictError('That contact is marked do-not-contact.');
  if (channel?.dnc) throw new CrmConflictError('That channel is marked do-not-contact.');
  if (channel?.invalid) throw new CrmConflictError('That channel is marked invalid.');
}

export function buildMessage(ctx: CrmCtx, contact: ContactView, channelType: string, step: number): { text: string | null; unknownFields: string[] } {
  const template = templateFor(ctx.settings(), channelType, step);
  if (template === null) return { text: null, unknownFields: [] };
  const names = new Map(ctx.settings().customFields.map((f) => [f.id, f.name]));
  const custom: Record<string, string> = {};
  for (const [id, v] of Object.entries(contact.custom)) custom[names.get(id) ?? id] = v;
  const r = renderTemplate(template, { name: contact.name, company: contact.company, title: contact.title, custom });
  return { text: r.text, unknownFields: r.unknownFields };
}

function insertFollowup(ctx: CrmCtx, f: {
  contactId: number; channelId: number | null; chain: string; kind: FollowupRow['kind']; step: number; type: FollowupType; title: string; dueAt: number;
  message: string | null; unknownFields: string[]; durationMin: number | null;
}): FollowupRow {
  const now = ctx.now();
  const id = Number(ctx.db.prepare(
    `INSERT INTO followups (contactId, channelId, chain, kind, step, type, state, title, dueAt, message, unknownFields, durationMin, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)`).run(f.contactId, f.channelId, f.chain, f.kind, f.step, f.type, f.title, f.dueAt, f.message, JSON.stringify(f.unknownFields), f.durationMin, now, now).lastInsertRowid);
  const row = getFollowupRow(ctx, id)!;
  addEntry(ctx, f.contactId, tlKind(row, 'planned'), `${f.title} planned`, { followupId: id, step: f.step, type: f.type, dueAt: f.dueAt });
  return row;
}

function optDate(v: unknown, name: string): number {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > Date.UTC(2100, 0, 1)) throw new CrmInputError(`${name} must be a date between 2000 and 2100`, name);
  return ms;
}
export const parseDue = optDate;

function validChannel(ctx: CrmCtx, contactId: number, channelId: unknown) {
  if (typeof channelId !== 'number' || !Number.isInteger(channelId)) throw new CrmInputError('channelId must be a channel of this contact', 'channelId');
  const ch = channelsOf(ctx, contactId).find((c) => c.id === channelId);
  if (!ch) throw new CrmNotFoundError('That channel does not belong to this contact');
  return { id: ch.id, type: ch.type, invalid: ch.invalid === 1, dnc: ch.dnc === 1 };
}

/** The first message to a contact on one channel. It starts as soon as it is due (now unless a time is given). */
export function createReachout(ctx: CrmCtx, contactId: number, body: unknown): { followup: FollowupView; autoApproved: boolean } {
  const b = (body ?? {}) as { channelId?: unknown; dueAt?: unknown; message?: unknown };
  const contact = getContact(ctx, contactId);
  const ch = validChannel(ctx, contactId, b.channelId);
  assertSendable(contact, ch);
  if (contact.segment !== 'prospect') throw new CrmConflictError('A reachout starts a prospect\'s outreach');
  const open = ctx.db.prepare("SELECT 1 FROM followups WHERE chain = ? AND contactId = ? AND state IN ('planned','pending','approved','failed') AND kind IN ('reachout','followup')").get(String(ch.id), contactId);
  if (open) throw new CrmConflictError('That channel already has an open reachout or followup');
  const built = buildMessage(ctx, contact, ch.type, 0);
  let message = built.text;
  if (b.message !== undefined) { if (typeof b.message !== 'string') throw new CrmInputError('message must be text', 'message'); message = b.message; }
  const dueAt = b.dueAt === undefined ? ctx.now() : optDate(b.dueAt, 'dueAt');
  let row = insertFollowup(ctx, { contactId, channelId: ch.id, chain: String(ch.id), kind: 'reachout', step: 0, type: ch.type === 'email' ? 'email' : ch.type === 'phone' ? 'call' : 'dm', title: `Reachout on ${PLATFORM_FOR[ch.type]}`, dueAt, message, unknownFields: built.unknownFields, durationMin: null });
  let autoApproved = false;
  if (dueAt <= ctx.now()) autoApproved = enterPending(ctx, row);
  row = getFollowupRow(ctx, row.id)!;
  return { followup: followupView(ctx, row), autoApproved };
}

/** Moves a due item to `pending`; an email item skips approval when "send without approval" is on, and the caller then sends it. */
export function enterPending(ctx: CrmCtx, row: FollowupRow): boolean {
  const ch = row.channelId ? (ctx.db.prepare('SELECT type FROM channels WHERE id = ?').get(row.channelId) as { type: string } | undefined) : undefined;
  const auto = ch?.type === 'email' && MESSAGE_TYPES.includes(row.type as FollowupType) && sendsWithoutApproval(ctx.settings(), 'email');
  ctx.db.prepare('UPDATE followups SET state = ?, updatedAt = ? WHERE id = ?').run(auto ? 'approved' : 'pending', ctx.now(), row.id);
  if (auto) addEntry(ctx, row.contactId, tlKind(row, 'approved'), 'Approved automatically (send without approval)', { followupId: row.id, auto: true });
  return auto;
}

/** A call, meeting, appointment or other task, or a hand-scheduled message followup. */
export function createTask(ctx: CrmCtx, contactId: number, body: unknown): FollowupView {
  const b = (body ?? {}) as { type?: unknown; dueAt?: unknown; title?: unknown; message?: unknown; channelId?: unknown; durationMin?: unknown };
  const contact = getContact(ctx, contactId);
  if (contact.segment.startsWith('lost')) throw new CrmConflictError('That contact is lost. Reopen it first.');
  if (!FOLLOWUP_TYPES.includes(b.type as FollowupType)) throw new CrmInputError(`type must be one of ${FOLLOWUP_TYPES.join(', ')}`, 'type');
  const type = b.type as FollowupType;
  if (b.message !== undefined && !MESSAGE_TYPES.includes(type)) throw new CrmInputError('Calls, meetings and appointments carry no message', 'message');
  if (b.message !== undefined && typeof b.message !== 'string') throw new CrmInputError('message must be text', 'message');
  const dueAt = optDate(b.dueAt, 'dueAt');
  const ch = b.channelId === undefined || b.channelId === null ? null : validChannel(ctx, contactId, b.channelId);
  if (ch) assertSendable(contact, ch);
  let duration: number | null = null;
  if (b.durationMin !== undefined && b.durationMin !== null) {
    if (typeof b.durationMin !== 'number' || !Number.isSafeInteger(b.durationMin) || b.durationMin < 1 || b.durationMin > 1440) throw new CrmInputError('durationMin must be a whole number of minutes from 1 to 1440', 'durationMin');
    duration = b.durationMin;
  }
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : type.replace(/_/g, ' ');
  const row = insertFollowup(ctx, { contactId, channelId: ch?.id ?? null, chain: ch ? String(ch.id) : 'manual', kind: 'task', step: 0, type, title, dueAt, message: (b.message as string | undefined) ?? null, unknownFields: [], durationMin: duration });
  if (type === 'online_meeting' || type === 'in_person_meeting' || type === 'appointment') applyStage(ctx, contactId, 'meeting_created');
  return followupView(ctx, row);
}

/** Moves a prospect's stage forward after an event; it never moves backwards. */
export function applyStage(ctx: CrmCtx, contactId: number, trigger: Parameters<typeof autoStage>[1]): void {
  const c = getContact(ctx, contactId);
  if (c.segment !== 'prospect' || !c.stage) return;
  moveStage(ctx, contactId, c.stage, autoStage(c.stage, trigger), 'automatic');
}

/** Marks an item sent and plans the next step of its chain by cadence. */
export function markSent(ctx: CrmCtx, row: FollowupRow, platform: string | null, at = ctx.now()): void {
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE followups SET state = 'sent', sentAt = ?, platform = ?, delayReason = NULL, updatedAt = ? WHERE id = ?").run(at, platform, ctx.now(), row.id);
    const channelType = row.channelId ? ((ctx.db.prepare('SELECT type FROM channels WHERE id = ?').get(row.channelId) as { type: string } | undefined)?.type ?? null) : null;
    addEntry(ctx, row.contactId, tlKind(row, 'sent'), `${row.title} sent${platform ? ` on ${platform}` : ''}`, { followupId: row.id, platform, step: row.step, dueAt: row.dueAt, delayMs: Math.max(0, at - row.dueAt), channelId: row.channelId, channelType }, at);
    if (row.kind === 'reachout') applyStage(ctx, row.contactId, 'reachout_sent');
    if (row.kind === 'reachout' || row.kind === 'followup') planNextStep(ctx, row, at);
  })();
}

function planNextStep(ctx: CrmCtx, sent: FollowupRow, sentAt: number): void {
  const s = ctx.settings();
  if (!hasNextStep(sent.step, s)) return;
  const contact = getContact(ctx, sent.contactId);
  const ch = sent.channelId ? channelsOf(ctx, sent.contactId).find((c) => c.id === sent.channelId) : undefined;
  const step = sent.step + 1;
  const built = buildMessage(ctx, contact, ch?.type ?? 'email', step);
  insertFollowup(ctx, {
    contactId: sent.contactId, channelId: sent.channelId, chain: sent.chain, kind: 'followup', step, type: sent.type === 'call' ? 'call' : (sent.type as FollowupType),
    title: `Followup ${step}`, dueAt: followupDue(sentAt, step, s), message: built.text, unknownFields: built.unknownFields, durationMin: null,
  });
}

/**
 * Applies a changed "number of followups" to chains already under way: open steps beyond the new count are cancelled, and a chain
 * whose last step was sent and not yet closed gets its next step when the count was raised. A chain that already ended is left alone.
 */
export function reconcileChains(ctx: CrmCtx): { cancelled: number; planned: number } {
  const max = ctx.settings().cadence.followups;
  return ctx.db.transaction(() => {
    const over = ctx.db.prepare("SELECT * FROM followups WHERE kind = 'followup' AND step > ? AND state IN ('planned','pending','approved','failed')").all(max) as FollowupRow[];
    for (const row of over) {
      ctx.db.prepare("UPDATE followups SET state = 'cancelled', catchUp = 0, updatedAt = ? WHERE id = ?").run(ctx.now(), row.id);
      addEntry(ctx, row.contactId, tlKind(row, 'cancelled'), `${row.title} cancelled: the number of followups was lowered`, { followupId: row.id, max });
    }
    const tails = ctx.db.prepare(
      `SELECT f.* FROM followups f JOIN contacts c ON c.id = f.contactId
       WHERE f.state = 'sent' AND f.doneAt IS NULL AND f.kind IN ('reachout','followup') AND f.step < ? AND c.segment = 'prospect'
         AND NOT EXISTS (SELECT 1 FROM followups g WHERE g.contactId = f.contactId AND g.chain = f.chain AND g.kind IN ('reachout','followup') AND g.state <> 'cancelled' AND (g.step > f.step OR (g.step = f.step AND g.id > f.id)))`,
    ).all(max) as FollowupRow[];
    for (const row of tails) if (row.sentAt !== null) planNextStep(ctx, row, row.sentAt);
    return { cancelled: over.length, planned: tails.length };
  })();
}

// ---- manual flow --------------------------------------------------------

export function submitManual(ctx: CrmCtx, id: number, body: unknown): FollowupView {
  const b = (body ?? {}) as { choice?: unknown; platform?: unknown };
  if (b.choice !== 'sent' && b.choice !== 'retry' && b.choice !== 'stop') throw new CrmInputError('choice must be sent, retry or stop', 'choice');
  const row = getFollowup(ctx, id);
  const view = followupView(ctx, row);
  if (view.integrated) throw new CrmConflictError('This channel is sent by the app. Approve or reject it instead.');
  if (row.state !== 'pending') throw new CrmConflictError(`This item is already ${row.state}`);
  if (b.choice === 'sent') {
    let platform = view.defaultPlatform ?? 'Other';
    if (b.platform !== undefined) {
      if (typeof b.platform !== 'string' || !b.platform.trim() || b.platform.length > 40) throw new CrmInputError('platform must be a short name', 'platform');
      platform = b.platform.trim();
    }
    markSent(ctx, row, platform);
  } else if (b.choice === 'retry') recordFailure(ctx, row, 'Message sending failed');
  else stopChain(ctx, row);
  return followupView(ctx, getFollowup(ctx, id));
}

/** A failed attempt: back to the list after the retry delay, or to the catch-up after the last try. */
export function recordFailure(ctx: CrmCtx, row: FollowupRow, reason: string): void {
  const tries = row.tries + 1;
  const out = retryOutcome(tries, ctx.now(), ctx.settings());
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE followups SET state = 'failed', tries = ?, retryAt = ?, catchUp = ?, delayReason = ?, updatedAt = ? WHERE id = ?")
      .run(tries, out.to === 'retry' ? out.at : null, out.to === 'catch_up' ? 1 : 0, reason, ctx.now(), row.id);
    addEntry(ctx, row.contactId, tlKind(row, 'failed'), `${row.title} failed (try ${tries}): ${reason}`, { followupId: row.id, tries, reason, catchUp: out.to === 'catch_up' });
  })();
}

export function stopChain(ctx: CrmCtx, row: FollowupRow): void {
  ctx.db.transaction(() => {
    cancelOpenFollowups(ctx, row.contactId, 'stopped by the owner', row.chain);
    addEntry(ctx, row.contactId, 'followup_cancelled', 'Followups stopped for this channel', { chain: row.chain, stopped: true });
  })();
}

/** What the owner can do with an item that used all its tries. */
export function catchUpAction(ctx: CrmCtx, id: number, body: unknown): FollowupView {
  const b = (body ?? {}) as { action?: unknown; channelId?: unknown };
  const row = getFollowup(ctx, id);
  if (row.state !== 'failed' || row.catchUp !== 1) throw new CrmConflictError('This item is not waiting in the catch-up');
  if (b.action === 'keep_trying') {
    ctx.db.prepare("UPDATE followups SET state = 'pending', tries = 0, retryAt = NULL, catchUp = 0, updatedAt = ? WHERE id = ?").run(ctx.now(), id);
    addEntry(ctx, row.contactId, tlKind(row, 'retried'), `${row.title} back on the list`, { followupId: id });
  } else if (b.action === 'stop') stopChain(ctx, row);
  else if (b.action === 'change_channel') {
    const contact = getContact(ctx, row.contactId);
    const ch = validChannel(ctx, row.contactId, b.channelId);
    assertSendable(contact, ch);
    const built = buildMessage(ctx, contact, ch.type, row.step);
    ctx.db.prepare("UPDATE followups SET channelId = ?, chain = ?, state = 'pending', tries = 0, retryAt = NULL, catchUp = 0, message = COALESCE(?, message), updatedAt = ? WHERE id = ?").run(ch.id, String(ch.id), built.text, ctx.now(), id);
    addEntry(ctx, row.contactId, tlKind(row, 'retried'), `${row.title} moved to ${ch.type}`, { followupId: id, channelId: ch.id });
  } else throw new CrmInputError('action must be keep_trying, change_channel or stop', 'action');
  return followupView(ctx, getFollowup(ctx, id));
}

export function editMessage(ctx: CrmCtx, id: number, text: unknown): FollowupView {
  const row = getFollowup(ctx, id);
  if (typeof text !== 'string') throw new CrmInputError('message must be text', 'message');
  if (!MESSAGE_TYPES.includes(row.type as FollowupType)) throw new CrmInputError('This item carries no message', 'message');
  if (!['planned', 'pending', 'approved', 'failed'].includes(row.state)) throw new CrmConflictError(`This item is already ${row.state}`);
  ctx.db.prepare('UPDATE followups SET message = ?, unknownFields = ?, updatedAt = ? WHERE id = ?').run(text, '[]', ctx.now(), id);
  return followupView(ctx, getFollowup(ctx, id));
}

export function rejectItem(ctx: CrmCtx, id: number): FollowupView {
  const row = getFollowup(ctx, id);
  if (row.state !== 'pending') throw new CrmConflictError(`This item is already ${row.state}`);
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE followups SET state = 'cancelled', updatedAt = ? WHERE id = ?").run(ctx.now(), id);
    addEntry(ctx, row.contactId, tlKind(row, 'cancelled'), `${row.title} rejected`, { followupId: id, rejected: true });
  })();
  return followupView(ctx, getFollowup(ctx, id));
}

/** Done: a call, meeting or appointment that took place. */
export function completeItem(ctx: CrmCtx, id: number): FollowupView {
  const row = getFollowup(ctx, id);
  if (!['planned', 'pending', 'approved'].includes(row.state)) throw new CrmConflictError(`This item is already ${row.state}`);
  if (MESSAGE_TYPES.includes(row.type as FollowupType)) throw new CrmConflictError('Send a message item instead of completing it');
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE followups SET state = 'done', doneAt = ?, updatedAt = ? WHERE id = ?").run(ctx.now(), ctx.now(), id);
    addEntry(ctx, row.contactId, 'followup_done', `${row.title} done`, { followupId: id, dueAt: row.dueAt, delayMs: Math.max(0, ctx.now() - row.dueAt) });
  })();
  return followupView(ctx, getFollowup(ctx, id));
}
