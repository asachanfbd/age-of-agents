import type { CrmCtx, WorkTask } from './context.ts';
import { redactSecrets } from '../redaction.ts';
import { UNTITLED_TASK, WORK_BACKFILL_DAYS, WORK_LOG_MAX, WORK_PROMPT_MAX, WORK_SUMMARY_MAX, WORK_SUMMARY_TIMEOUT_MS, WORK_TITLE_MAX } from './limits.ts';
import { addWorkEntry, hasWorkEntry } from './timeline.ts';

export type WorkPhase = 'started' | 'finished';

export interface WorkLogEntry { id: number; at: number; phase: WorkPhase; taskTitle: string; summary: string; rewritten: boolean; backfilled: boolean }
export interface WorkTarget { buildingId: string; buildingName: string }

const DAY_MS = 86_400_000;

/** Cuts to `max` characters, counting an emoji pair as one. */
export function capText(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

export function taskLabel(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? capText(trimmed, WORK_TITLE_MAX) : UNTITLED_TASK;
}

/** One entry per customer, Building, task and phase; the timeline's unique index enforces it. */
export function workKey(contactId: number, buildingId: string, planItemId: string, phase: WorkPhase): string {
  return JSON.stringify([contactId, buildingId, planItemId, phase]);
}

export function workText(phase: WorkPhase, title: string, buildingName: string): string {
  return `${phase === 'started' ? 'Started' : 'Finished'}: ${title} on ${buildingName}`;
}

/** The summary written without the agent: the title, plus the run's own final summary when it has one. */
export function fallbackSummary(title: string, runSummary: string | null): string {
  const outcome = redactSecrets(runSummary?.trim() ?? '');
  return capText(outcome ? `${title}: ${outcome}` : title, WORK_SUMMARY_MAX);
}

/** The agent sees only the task title and the run's final summary, never other run fields. */
export function summaryPrompt(title: string, runSummary: string | null): string {
  const outcome = capText(redactSecrets(runSummary?.trim() ?? ''), WORK_PROMPT_MAX);
  return `Write a short, plain-language update for a customer about work just finished for them.\nTask: ${title}\nOutcome: ${outcome || 'not recorded'}`;
}

/** Stops waiting after `ms`; the agent turn itself is not aborted (the executor has no cancel) and its late answer is discarded. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The agent took too long')), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Asks the CRM agent for the customer-facing summary; a failure, timeout or empty answer yields the fallback, marked not rewritten. */
export async function writeSummary(ctx: CrmCtx, title: string, runSummary: string | null, timeoutMs = WORK_SUMMARY_TIMEOUT_MS): Promise<{ summary: string; rewritten: boolean }> {
  try {
    const answer = (await withTimeout(ctx.deps.agent.run({ kind: 'work', prompt: summaryPrompt(title, runSummary) }), timeoutMs)).trim();
    if (answer) return { summary: capText(answer, WORK_SUMMARY_MAX), rewritten: true };
  } catch { /* the fallback below is the designed outcome */ }
  return { summary: fallbackSummary(title, runSummary), rewritten: false };
}

interface Target { contactId: number; attachedAt: number }

/** Customers (not merged away) that currently have the Building attached. */
function attachedCustomers(ctx: CrmCtx, buildingId: string): Target[] {
  return ctx.db.prepare(
    `SELECT l.contactId, l.attachedAt FROM building_links l JOIN contacts c ON c.id = l.contactId
     WHERE l.buildingId = ? AND c.segment = 'customer' AND c.mergedInto IS NULL ORDER BY l.contactId`,
  ).all(buildingId) as Target[];
}

function logFailure(what: string, e: unknown): void {
  console.error(`CRM work update failed (${what}):`, e);
}

/** Posts "started" to every attached customer that had the Building attached when the task started. Uses the task title only. */
export function postStarted(ctx: CrmCtx, target: WorkTarget, task: WorkTask): void {
  if (task.startedAt === null) return;
  const title = taskLabel(task.title);
  for (const { contactId, attachedAt } of attachedCustomers(ctx, target.buildingId)) {
    if (task.startedAt < attachedAt) continue;
    try {
      addWorkEntry(ctx, contactId, workKey(contactId, target.buildingId, task.planItemId, 'started'), workText('started', title, target.buildingName),
        { phase: 'started', buildingId: target.buildingId, buildingName: target.buildingName, planItemId: task.planItemId, taskTitle: title, summary: '', rewritten: false, backfilled: false }, ctx.now());
    } catch (e) { logFailure('started', e); }
  }
}

/** A future finish time is dated now; a missing or invalid one too. */
const finishTime = (ctx: CrmCtx, task: WorkTask): number => {
  const t = task.finishedAt;
  return t !== null && Number.isFinite(t) && t > 0 ? Math.min(t, ctx.now()) : ctx.now();
};

async function postFinishedTo(ctx: CrmCtx, contactIds: number[], target: WorkTarget, task: WorkTask, backfilled: boolean): Promise<void> {
  const pending = contactIds.filter((id) => !hasWorkEntry(ctx, workKey(id, target.buildingId, task.planItemId, 'finished')));
  if (!pending.length) return;
  const title = taskLabel(task.title);
  const { summary, rewritten } = await writeSummary(ctx, title, task.runSummary);
  const at = finishTime(ctx, task);
  for (const contactId of pending) {
    try {
      addWorkEntry(ctx, contactId, workKey(contactId, target.buildingId, task.planItemId, 'finished'), workText('finished', title, target.buildingName),
        { phase: 'finished', buildingId: target.buildingId, buildingName: target.buildingName, planItemId: task.planItemId, taskTitle: title, summary, rewritten, backfilled }, at);
    } catch (e) { logFailure('finished', e); }
  }
}

/** Posts "finished" to every attached customer; the summary is written once and shared. */
export async function postFinished(ctx: CrmCtx, target: WorkTarget, task: WorkTask): Promise<void> {
  await postFinishedTo(ctx, attachedCustomers(ctx, target.buildingId).map((t) => t.contactId), target, task, false);
}

/** A task finished exactly the window ago is still included. */
export function inBackfillWindow(finished: number | null, now: number): boolean {
  return finished !== null && Number.isFinite(finished) && finished > 0 && finished >= now - WORK_BACKFILL_DAYS * DAY_MS;
}

/** Posts "finished" for tasks completed in the last 30 days to one newly attached customer, oldest first. Never throws. */
export async function backfillBuilding(ctx: CrmCtx, contactId: number, target: WorkTarget): Promise<void> {
  try {
    const now = ctx.now();
    const tasks = (await ctx.deps.tasks.finishedSince(target.buildingId, now - WORK_BACKFILL_DAYS * DAY_MS))
      .filter((t) => inBackfillWindow(t.finishedAt, now))
      .sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const task of tasks) await postFinishedTo(ctx, [contactId], target, task, true).catch((e) => logFailure('backfill', e));
  } catch (e) { logFailure('backfill', e); }
}

const inflight = new Set<Promise<unknown>>();
/** Runs work after the caller has answered; tests wait for it with `settleWorkUpdates`. */
export function inBackground(work: Promise<unknown>): void {
  const tracked: Promise<unknown> = work.catch((e) => logFailure('background', e)).finally(() => inflight.delete(tracked));
  inflight.add(tracked);
}
export async function settleWorkUpdates(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

interface LogRow { id: number; at: number; data: string }
const toLogEntry = (r: LogRow): WorkLogEntry => {
  const d = JSON.parse(r.data) as Partial<WorkLogEntry> & { phase: WorkPhase };
  return { id: r.id, at: r.at, phase: d.phase, taskTitle: d.taskTitle ?? UNTITLED_TASK, summary: d.summary ?? '', rewritten: d.rewritten !== false, backfilled: d.backfilled === true };
};

/** One attached Building's work updates for a customer: the newest few, newest first, plus the total. */
export function workLogFor(ctx: CrmCtx, contactId: number, buildingId: string): { workLog: WorkLogEntry[]; workLogTotal: number } {
  const where = "contactId = ? AND kind = 'building_work' AND json_extract(data, '$.buildingId') = ?";
  const rows = ctx.db.prepare(`SELECT id, at, data FROM timeline WHERE ${where} ORDER BY at DESC, id DESC LIMIT ?`).all(contactId, buildingId, WORK_LOG_MAX) as LogRow[];
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM timeline WHERE ${where}`).get(contactId, buildingId) as { n: number }).n;
  return { workLog: rows.map(toLogEntry), workLogTotal: total };
}
