import { cancelOpenFollowups } from './chains.ts';
import type { CrmCtx } from './context.ts';
import { channelsOf, getContact, markCustomer, markLost } from './contacts.ts';
import type { ContactView } from './contacts.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import { applyStage, createTask, parseDue } from './followups.ts';
import { addEntry } from './timeline.ts';

export const OUTCOMES = ['interested', 'not_interested', 'later', 'wrong_number', 'no_response_yet', 'became_customer'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ResponseResult { contact: ContactView; outcome: Outcome; needsLostDecision?: boolean; createdFollowupId?: number }

/** A reply stops every chain: open chain items are cancelled and sent items stop waiting for an answer. */
function stopAllChains(ctx: CrmCtx, contactId: number, why: string): void {
  cancelOpenFollowups(ctx, contactId, why, undefined, true);
  ctx.db.prepare("UPDATE followups SET doneAt = ? WHERE contactId = ? AND state = 'sent' AND doneAt IS NULL AND kind IN ('reachout','followup')").run(ctx.now(), contactId);
  ctx.db.prepare('UPDATE contacts SET noResponse = 0, resurfaceAt = NULL WHERE id = ?').run(contactId);
}

export function logResponse(ctx: CrmCtx, contactId: number, body: unknown): ResponseResult {
  const b = (body ?? {}) as { outcome?: unknown; channelId?: unknown; reason?: unknown; date?: unknown; nextAction?: unknown; note?: unknown };
  if (!OUTCOMES.includes(b.outcome as Outcome)) throw new CrmInputError(`outcome must be one of ${OUTCOMES.join(', ')}`, 'outcome');
  const outcome = b.outcome as Outcome;
  const contact = getContact(ctx, contactId);
  if (contact.segment.startsWith('lost')) throw new CrmConflictError('That contact is lost. Reopen it first.');
  if (contact.segment === 'customer' && outcome !== 'no_response_yet') throw new CrmConflictError('Responses are logged on prospects');
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : '';
  const entry = (extra: Record<string, unknown> = {}) => addEntry(ctx, contactId, 'response_logged', `Response: ${outcome.replace(/_/g, ' ')}${note ? ` — ${note}` : ''}`, { outcome, channelId: b.channelId ?? null, ...extra });
  let needsLostDecision = false;
  let createdFollowupId: number | undefined;

  // Validate everything first so a refused response changes nothing.
  if (outcome === 'not_interested' && (typeof b.reason !== 'string' || !ctx.settings().lostReasons.includes(b.reason))) throw new CrmInputError('Pick a reason from the lost reason list', 'reason');
  let callbackAt = 0;
  if (outcome === 'later') {
    callbackAt = parseDue(b.date, 'date');
    if (callbackAt <= ctx.now()) throw new CrmInputError('The call-back date must be in the future', 'date');
  }
  if (outcome === 'interested' && (typeof b.nextAction !== 'object' || b.nextAction === null)) throw new CrmInputError('Pick or schedule the next action', 'nextAction');
  let wrongChannel: { id: number } | undefined;
  if (outcome === 'wrong_number') {
    wrongChannel = channelsOf(ctx, contactId).find((c) => c.id === b.channelId);
    if (!wrongChannel) throw new CrmNotFoundError('Pick the channel that was wrong');
  }

  ctx.db.transaction(() => {
    entry();
    switch (outcome) {
      case 'interested':
        stopAllChains(ctx, contactId, 'a reply came in');
        applyStage(ctx, contactId, 'response_interested');
        createdFollowupId = createTask(ctx, contactId, b.nextAction).id;
        break;
      case 'not_interested':
        stopAllChains(ctx, contactId, 'not interested');
        markLost(ctx, contactId, b.reason);
        break;
      case 'later':
        stopAllChains(ctx, contactId, 'asked to be contacted later');
        ctx.db.prepare('UPDATE contacts SET callbackAt = ?, updatedAt = ? WHERE id = ?').run(callbackAt, ctx.now(), contactId);
        createdFollowupId = createTask(ctx, contactId, { type: 'call', dueAt: callbackAt, title: 'Call back' }).id;
        break;
      case 'wrong_number': {
        ctx.db.prepare('UPDATE channels SET invalid = 1 WHERE id = ?').run(wrongChannel!.id);
        cancelOpenFollowups(ctx, contactId, 'wrong number or bounced', String(wrongChannel!.id));
        const left = channelsOf(ctx, contactId).filter((c) => c.invalid === 0 && c.dnc === 0);
        needsLostDecision = left.length === 0;
        break;
      }
      case 'no_response_yet':
        ctx.db.prepare("UPDATE followups SET checkedAt = ? WHERE contactId = ? AND state = 'sent' AND doneAt IS NULL").run(ctx.now(), contactId);
        break;
      case 'became_customer':
        markCustomer(ctx, contactId);
        break;
    }
  })();
  return { contact: getContact(ctx, contactId), outcome, ...(needsLostDecision ? { needsLostDecision } : {}), ...(createdFollowupId ? { createdFollowupId } : {}) };
}
