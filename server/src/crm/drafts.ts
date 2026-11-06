import type { CrmCtx } from './context.ts';
import { getContact } from './contacts.ts';
import { CrmConflictError, CrmInputError } from './errors.ts';
import { followupView, getFollowup } from './followups.ts';
import type { FollowupView } from './followups.ts';
import { MESSAGE_TYPES } from './settings.ts';
import type { FollowupType } from './settings.ts';

export interface DraftResult { followup: FollowupView; applied: boolean; agentError?: string }

/** Asks an agent for a personalised message. A draft until the owner accepts it, unless "apply without review" is on for message drafts. */
export async function requestDraft(ctx: CrmCtx, followupId: number): Promise<DraftResult> {
  const row = getFollowup(ctx, followupId);
  if (!MESSAGE_TYPES.includes(row.type as FollowupType)) throw new CrmInputError('Only message items can be drafted', 'followupId');
  if (!['planned', 'pending', 'approved', 'failed'].includes(row.state)) throw new CrmConflictError(`This item is already ${row.state}`);
  const contact = getContact(ctx, row.contactId);
  const recent = (ctx.db.prepare("SELECT text FROM timeline WHERE contactId = ? AND kind <> 'comment_deleted' ORDER BY at DESC, id DESC LIMIT 10").all(row.contactId) as Array<{ text: string }>).map((r) => `- ${r.text}`).join('\n');
  const prompt = [
    `Write a short, personal ${row.step === 0 ? 'first message' : `followup number ${row.step}`} to ${contact.name ?? 'this contact'}${contact.company ? ` at ${contact.company}` : ''}${contact.title ? ` (${contact.title})` : ''}.`,
    row.message ? `Template to personalise:\n${row.message}` : '', `Recent history:\n${recent || '(none)'}`, 'Reply with the message text only.',
  ].filter(Boolean).join('\n\n');
  let text: string;
  try { text = (await ctx.deps.agent.run({ kind: 'message', prompt })).trim(); if (!text) throw new Error('The agent returned no message'); }
  catch (e) { return { followup: followupView(ctx, row), applied: false, agentError: e instanceof Error ? e.message : 'The agent failed' }; }
  if (ctx.settings().agentAutoApply.messageDrafts) {
    ctx.db.prepare('UPDATE followups SET message = ?, draft = NULL, updatedAt = ? WHERE id = ?').run(text, ctx.now(), followupId);
    return { followup: followupView(ctx, getFollowup(ctx, followupId)), applied: true };
  }
  ctx.db.prepare('UPDATE followups SET draft = ?, updatedAt = ? WHERE id = ?').run(text, ctx.now(), followupId);
  return { followup: followupView(ctx, getFollowup(ctx, followupId)), applied: false };
}

/** Accept the draft as the message, optionally edited first. */
export function acceptMessageDraft(ctx: CrmCtx, followupId: number, edited?: unknown): FollowupView {
  const row = getFollowup(ctx, followupId);
  if (!row.draft) throw new CrmConflictError('There is no draft to accept');
  if (edited !== undefined && typeof edited !== 'string') throw new CrmInputError('message must be text', 'message');
  ctx.db.prepare('UPDATE followups SET message = ?, draft = NULL, unknownFields = ?, updatedAt = ? WHERE id = ?').run((edited as string | undefined) ?? row.draft, '[]', ctx.now(), followupId);
  return followupView(ctx, getFollowup(ctx, followupId));
}

export function discardMessageDraft(ctx: CrmCtx, followupId: number): FollowupView {
  getFollowup(ctx, followupId);
  ctx.db.prepare('UPDATE followups SET draft = NULL WHERE id = ?').run(followupId);
  return followupView(ctx, getFollowup(ctx, followupId));
}

