import { getFollowupRow } from './chains.ts';
import type { FollowupRow } from './chains.ts';
import { SMTP_PASSWORD_KEY, SmtpError } from './context.ts';
import type { CrmCtx } from './context.ts';
import { channelsOf, getContact } from './contacts.ts';
import { CrmConflictError, CrmInputError, CrmUpstreamError } from './errors.ts';
import { canSendEmail } from './emailCaps.ts';
import { assertSendable, followupView, getFollowup, markSent, recordFailure } from './followups.ts';
import type { FollowupView } from './followups.ts';
import { redactSecrets } from '../redaction.ts';
import { withFooter } from './templates.ts';
import { addEntry } from './timeline.ts';

export type SmtpState = 'not_connected' | 'connected' | 'needs_attention';
export interface SmtpStatus { state: SmtpState; reason: string | null; passwordSaved: boolean; configured: boolean }

interface StoredStatus { state: SmtpState; reason: string | null }
const readStatus = (ctx: CrmCtx): StoredStatus => {
  const row = ctx.db.prepare("SELECT value FROM meta WHERE key = 'smtpStatus'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : { state: 'not_connected', reason: null };
};
const writeStatus = (ctx: CrmCtx, s: StoredStatus) => {
  ctx.db.prepare("INSERT INTO meta (key, value) VALUES ('smtpStatus', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
};

export async function smtpStatus(ctx: CrmCtx): Promise<SmtpStatus> {
  const passwordSaved = (await ctx.secrets.get(SMTP_PASSWORD_KEY)) !== undefined;
  const { host, from } = ctx.settings().smtp;
  const configured = Boolean(host && from);
  const stored = readStatus(ctx);
  if (!configured || !passwordSaved) return { state: 'not_connected', reason: null, passwordSaved, configured };
  return { ...stored, passwordSaved, configured };
}

/** The write-only password: an omitted field keeps it, an empty string clears it. */
export async function savePassword(ctx: CrmCtx, password: unknown): Promise<void> {
  if (password === undefined) return;
  if (typeof password !== 'string') throw new CrmInputError('password must be text', 'password');
  if (password === '') { await ctx.secrets.delete(SMTP_PASSWORD_KEY); writeStatus(ctx, { state: 'not_connected', reason: null }); return; }
  await ctx.secrets.set(SMTP_PASSWORD_KEY, password);
  writeStatus(ctx, { state: 'not_connected', reason: null });
}

async function account(ctx: CrmCtx) {
  const s = ctx.settings().smtp;
  const password = await ctx.secrets.get(SMTP_PASSWORD_KEY);
  if (!s.host || !s.from) throw new CrmConflictError('Email is not set up. Enter the mail server and from address in Settings.');
  if (s.user && password === undefined) throw new CrmConflictError('Email is not set up. Save the mail server password in Settings.');
  return { s, acct: { host: s.host, port: s.port, security: s.security, user: s.user, password: password ?? '' } };
}

/** Refuses with 409 when email cannot be sent at all because the connection is not set up. */
export async function assertSmtpReady(ctx: CrmCtx): Promise<void> {
  await account(ctx);
}

const ATTENTION_KINDS = new Set(['auth', 'tls', 'refused', 'timeout']);
const REASONS: Record<string, string> = { auth: 'The mail server refused the login', tls: 'The secure connection failed', refused: 'The mail server could not be reached', timeout: 'The mail server did not answer in time', rejected: 'The mail server rejected the message', other: 'Sending failed' };

/** A failure reason that is safe to show and store: a fixed phrase plus the server's own text, with secrets removed. */
function reasonOf(e: unknown): { kind: string; reason: string } {
  const kind = e instanceof SmtpError ? e.kind : 'other';
  const detail = e instanceof Error ? redactSecrets(e.message) : '';
  return { kind, reason: detail && detail !== REASONS[kind] ? `${REASONS[kind]}: ${detail}` : REASONS[kind]! };
}

function noteFailure(ctx: CrmCtx, kind: string, reason: string): void {
  if (!ATTENTION_KINDS.has(kind)) return;
  writeStatus(ctx, { state: 'needs_attention', reason });
  ctx.deps.notifyAttention(ctx.buildingId, reason);
}
function noteSuccess(ctx: CrmCtx): void {
  writeStatus(ctx, { state: 'connected', reason: null });
  ctx.deps.resolveAttention(ctx.buildingId);
}

export async function testSend(ctx: CrmCtx, to: unknown): Promise<{ sent: true }> {
  if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(to.trim())) throw new CrmInputError('Enter an email address to send the test to', 'to');
  const { s, acct } = await account(ctx);
  try {
    await ctx.deps.transport.send(acct, { from: s.from, to: to.trim(), subject: 'CRM test message', text: 'This is a test message from your CRM Building.' });
  } catch (e) {
    const { kind, reason } = reasonOf(e);
    noteFailure(ctx, kind, reason);
    throw new CrmUpstreamError(reason);
  }
  noteSuccess(ctx);
  return { sent: true };
}

function subjectAndBody(row: FollowupRow): { subject: string; body: string } {
  const text = row.message ?? '';
  const m = /^subject:[ \t]*(.+)\r?\n?/i.exec(text);
  if (m) return { subject: m[1]!.trim().slice(0, 200), body: text.slice(m[0].length).replace(/^\s+/, '') };
  return { subject: row.step === 0 ? 'Hello' : 'Following up', body: text };
}

export type SendOutcome = { sent: true } | { sent: false; delayed: string } | { sent: false; failed: string };

/** Approves a waiting email item (optionally with an edited message) so it is sent. */
export function approveItem(ctx: CrmCtx, id: number, message?: unknown): void {
  const row = getFollowup(ctx, id);
  const view = followupView(ctx, row);
  if (!view.integrated) throw new CrmConflictError('This channel is sent by hand. Use the Pending reachout popup.');
  if (row.state !== 'pending') throw new CrmConflictError(`This item is already ${row.state}`);
  if (message !== undefined && typeof message !== 'string') throw new CrmInputError('message must be text', 'message');
  ctx.db.transaction(() => {
    if (typeof message === 'string') ctx.db.prepare('UPDATE followups SET message = ?, unknownFields = ? WHERE id = ?').run(message, '[]', id);
    ctx.db.prepare("UPDATE followups SET state = 'approved', updatedAt = ? WHERE id = ?").run(ctx.now(), id);
    addEntry(ctx, row.contactId, row.kind === 'reachout' ? 'reachout_approved' : 'followup_approved', `${row.title} approved`, { followupId: id });
  })();
}

/** Sends an approved email item over SMTP, honouring do-not-contact, the daily cap and the gap between sends. */
export async function sendApproved(ctx: CrmCtx, id: number): Promise<SendOutcome> {
  const row = getFollowupRow(ctx, id);
  if (!row) throw new CrmConflictError('That item does not exist');
  if (row.state !== 'approved') throw new CrmConflictError(`This item is ${row.state}, not approved`);
  const contact = getContact(ctx, row.contactId);
  const channel = channelsOf(ctx, row.contactId).find((c) => c.id === row.channelId);
  assertSendable(contact, channel && { type: channel.type, invalid: channel.invalid === 1, dnc: channel.dnc === 1 });
  if (!channel) throw new CrmConflictError('This item has no email address to send to.');
  const { s, acct } = await account(ctx);
  const sends = (ctx.db.prepare('SELECT at FROM email_sends ORDER BY at DESC LIMIT 5000').all() as Array<{ at: number }>).map((r) => r.at);
  const verdict = canSendEmail(ctx.now(), sends, ctx.settings());
  if (!verdict.ok) {
    const label = verdict.reason === 'daily cap' ? 'delayed by daily cap' : 'waiting between sends';
    if (row.delayReason !== label) {
      ctx.db.prepare('UPDATE followups SET delayReason = ?, updatedAt = ? WHERE id = ?').run(label, ctx.now(), id);
      addEntry(ctx, row.contactId, row.kind === 'reachout' ? 'reachout_delayed' : 'followup_delayed', `${row.title} ${label}`, { followupId: id, reason: label });
    }
    return { sent: false, delayed: label };
  }
  const { subject, body } = subjectAndBody(row);
  const text = contact.segment === 'prospect' ? withFooter(body, ctx.settings().emailFooter) : body;
  try {
    await ctx.deps.transport.send(acct, { from: s.from, to: channel.handle, subject, text });
  } catch (e) {
    const { kind, reason } = reasonOf(e);
    noteFailure(ctx, kind, reason);
    recordFailure(ctx, { ...row, state: 'approved' }, reason);
    return { sent: false, failed: reason };
  }
  ctx.db.prepare('INSERT INTO email_sends (at) VALUES (?)').run(ctx.now());
  noteSuccess(ctx);
  markSent(ctx, row, 'Email');
  return { sent: true };
}

export type { FollowupView };
