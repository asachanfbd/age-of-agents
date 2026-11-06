import type { CrmCtx } from './context.ts';
import { addEntry } from './timeline.ts';

/** Followup states that can still produce work; `sent`, `done` and `cancelled` are final. */
export const OPEN_STATES = ['planned', 'pending', 'approved', 'failed'] as const;
const OPEN_SQL = OPEN_STATES.map((s) => `'${s}'`).join(',');

export interface FollowupRow {
  id: number; contactId: number; channelId: number | null; chain: string; kind: 'reachout' | 'followup' | 'task'; step: number; type: string; state: string;
  title: string; dueAt: number; message: string | null; draft: string | null; platform: string | null; sentAt: number | null; doneAt: number | null;
  tries: number; retryAt: number | null; delayReason: string | null; durationMin: number | null; catchUp: number; checkedAt: number | null; unknownFields: string; createdAt: number; updatedAt: number;
}

export function getFollowupRow(ctx: CrmCtx, id: number): FollowupRow | undefined {
  return ctx.db.prepare('SELECT * FROM followups WHERE id = ?').get(id) as FollowupRow | undefined;
}

/** Cancels a contact's open followups (every chain, or only `chain`; `chainsOnly` leaves calls, meetings and other tasks alone), writing one timeline entry for each. */
export function cancelOpenFollowups(ctx: CrmCtx, contactId: number, reason: string, chain?: string, chainsOnly = false): number[] {
  const rows = ctx.db.prepare(`SELECT id, kind, chain FROM followups WHERE contactId = ? AND state IN (${OPEN_SQL})${chain ? ' AND chain = ?' : ''}${chainsOnly ? " AND kind IN ('reachout','followup')" : ''}`)
    .all(...(chain ? [contactId, chain] : [contactId])) as Array<{ id: number; kind: string; chain: string }>;
  const now = ctx.now();
  const update = ctx.db.prepare("UPDATE followups SET state = 'cancelled', catchUp = 0, updatedAt = ? WHERE id = ?");
  for (const r of rows) {
    update.run(now, r.id);
    addEntry(ctx, contactId, r.kind === 'reachout' ? 'reachout_cancelled' : 'followup_cancelled', `Cancelled (${r.chain}): ${reason}`, { followupId: r.id, chain: r.chain, reason });
  }
  return rows.map((r) => r.id);
}
