import type { FollowupRow } from './chains.ts';
import type { CrmCtx } from './context.ts';
import { getContact, markLost } from './contacts.ts';
import { chainEnd, resurfaceAt } from './cadence.ts';
import { sendApproved } from './email.ts';
import { CrmConflictError } from './errors.ts';
import { enterPending } from './followups.ts';
import { addEntry } from './timeline.ts';
import { hasNextStep } from './cadence.ts';

export interface TickResult { due: number; retried: number; chainsEnded: number; sent: number; cancelled: number }

/** Why a due item can no longer go ahead, or null when it can. */
function blocked(ctx: CrmCtx, row: FollowupRow): string | null {
  const contact = ctx.db.prepare('SELECT segment, dnc, mergedInto FROM contacts WHERE id = ?').get(row.contactId) as { segment: string; dnc: number; mergedInto: number | null } | undefined;
  if (!contact || contact.mergedInto !== null) return 'the contact was merged';
  if (contact.segment.startsWith('lost')) return 'the contact is lost';
  if (contact.dnc) return 'do-not-contact';
  const ch = row.channelId ? (ctx.db.prepare('SELECT invalid, dnc FROM channels WHERE id = ?').get(row.channelId) as { invalid: number; dnc: number } | undefined) : undefined;
  if (row.channelId && !ch) return 'the channel was removed';
  if (ch?.dnc) return 'do-not-contact on this channel';
  if (ch?.invalid) return 'the channel is invalid';
  return null;
}

function cancelOne(ctx: CrmCtx, row: FollowupRow, why: string): void {
  ctx.db.prepare("UPDATE followups SET state = 'cancelled', catchUp = 0, updatedAt = ? WHERE id = ?").run(ctx.now(), row.id);
  addEntry(ctx, row.contactId, row.kind === 'reachout' ? 'reachout_cancelled' : 'followup_cancelled', `${row.title} cancelled: ${why}`, { followupId: row.id, reason: why });
}

function endChains(ctx: CrmCtx): number {
  const s = ctx.settings();
  const candidates = ctx.db.prepare(
    `SELECT f.* FROM followups f JOIN contacts c ON c.id = f.contactId
     WHERE f.state = 'sent' AND f.doneAt IS NULL AND f.kind IN ('reachout','followup') AND c.segment = 'prospect'
       AND NOT EXISTS (SELECT 1 FROM followups g WHERE g.contactId = f.contactId AND g.chain = f.chain AND g.kind IN ('reachout','followup') AND g.state <> 'cancelled' AND (g.step > f.step OR (g.step = f.step AND g.id > f.id)))`,
  ).all() as FollowupRow[];
  let ended = 0;
  for (const f of candidates) {
    if (hasNextStep(f.step, s) || f.sentAt === null) continue;
    const end = chainEnd(f.sentAt, s);
    if (end > ctx.now()) continue;
    ctx.db.transaction(() => {
      ctx.db.prepare('UPDATE followups SET doneAt = ? WHERE id = ?').run(end, f.id);
      const c = getContact(ctx, f.contactId);
      const open = ctx.db.prepare("SELECT 1 FROM followups WHERE contactId = ? AND kind IN ('reachout','followup') AND state IN ('planned','pending','approved','failed')").get(f.contactId);
      if (open || c.noResponse) return;
      ctx.db.prepare('UPDATE contacts SET noResponse = 1, noResponseAt = ?, resurfaceAt = ?, updatedAt = ? WHERE id = ?').run(end, resurfaceAt(end, s), ctx.now(), f.contactId);
      addEntry(ctx, f.contactId, 'no_response', 'No response after the last followup', { chain: f.chain, endedAt: end });
      if (s.cadence.autoLost) markLost(ctx, f.contactId, 'No response');
    })();
    ended++;
  }
  return ended;
}

/** Moves time-driven work forward. Safe to run repeatedly: each step only acts on items whose time has come. */
export async function tick(ctx: CrmCtx): Promise<TickResult> {
  const now = ctx.now();
  const result: TickResult = { due: 0, retried: 0, chainsEnded: 0, sent: 0, cancelled: 0 };
  const due = ctx.db.prepare("SELECT * FROM followups WHERE state = 'planned' AND dueAt <= ? ORDER BY dueAt, id").all(now) as FollowupRow[];
  const retry = ctx.db.prepare("SELECT * FROM followups WHERE state = 'failed' AND catchUp = 0 AND retryAt IS NOT NULL AND retryAt <= ? ORDER BY retryAt, id").all(now) as FollowupRow[];
  ctx.db.transaction(() => {
    for (const row of [...due, ...retry]) {
      const why = blocked(ctx, row);
      if (why) { cancelOne(ctx, row, why); result.cancelled++; continue; }
      if (row.state === 'failed') {
        addEntry(ctx, row.contactId, row.kind === 'reachout' ? 'reachout_retried' : 'followup_retried', `${row.title} is due again (try ${row.tries + 1})`, { followupId: row.id });
        result.retried++;
      } else result.due++;
      ctx.db.prepare('UPDATE followups SET retryAt = NULL WHERE id = ?').run(row.id);
      enterPending(ctx, row);
    }
    result.chainsEnded = endChains(ctx);
  })();
  const approved = ctx.db.prepare(
    `SELECT f.id FROM followups f JOIN channels ch ON ch.id = f.channelId WHERE f.state = 'approved' AND ch.type = 'email' AND f.dueAt <= ? ORDER BY f.dueAt, f.id`,
  ).all(now) as Array<{ id: number }>;
  for (const { id } of approved) {
    try {
      const out = await sendApproved(ctx, id);
      if (out.sent) result.sent++;
      else if ('delayed' in out) break;
    } catch (error) {
      if (cancelBlockedApproved(ctx, id)) continue;
      // A refusal that is not about the contact (email not set up, say) leaves the item waiting, visibly and once, instead of failing every tick.
      if (error instanceof CrmConflictError) noteWaiting(ctx, id, error.message);
      else console.error(`CRM could not send item ${id}:`, error);
    }
  }
  return result;
}

/** An approved item that can no longer be sent (the contact became do-not-contact, say) is cancelled rather than retried forever. */
function cancelBlockedApproved(ctx: CrmCtx, id: number): boolean {
  const row = ctx.db.prepare('SELECT * FROM followups WHERE id = ?').get(id) as FollowupRow | undefined;
  if (!row || row.state !== 'approved') return false;
  const why = blocked(ctx, row);
  if (why) cancelOne(ctx, row, why);
  return Boolean(why);
}

function noteWaiting(ctx: CrmCtx, id: number, reason: string): void {
  const row = ctx.db.prepare('SELECT * FROM followups WHERE id = ?').get(id) as FollowupRow | undefined;
  if (!row || row.delayReason === reason) return;
  ctx.db.prepare('UPDATE followups SET delayReason = ?, updatedAt = ? WHERE id = ?').run(reason, ctx.now(), id);
  addEntry(ctx, row.contactId, row.kind === 'reachout' ? 'reachout_delayed' : 'followup_delayed', `${row.title} is waiting: ${reason}`, { followupId: id, reason });
}

