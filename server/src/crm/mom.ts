import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CrmCtx } from './context.ts';
import { getContact } from './contacts.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import { createTask } from './followups.ts';
import { MOM_ATTACHMENT_MAX_BYTES, MOM_ATTACHMENTS_MAX } from './limits.ts';
import { parseMomOutput } from './momParse.ts';
import { pageOf } from './paging.ts';
import type { Page } from './paging.ts';
import { addEntry } from './timeline.ts';
import { escapeLike } from './paging.ts';

export type TranscriptStatus = 'none' | 'automatic' | 'pasted';
export interface ActionItem { title: string; dueAt?: number; type?: string; followupId?: number | null }
export interface MomFileView { id: number; kind: 'attachment' | 'audio'; name: string; size: number }
export interface MomView {
  id: number; contactId: number; contactName: string | null; targetKind: string; targetId: number; notes: string; transcript: string; transcriptStatus: TranscriptStatus;
  summary: string; decisions: string; attendees: number[]; actionItems: ActionItem[]; draft: { summary: string; decisions: string; actionItems: string[] } | null;
  files: MomFileView[]; createdAt: number; updatedAt: number;
}

interface Row { id: number; contactId: number; targetKind: string; targetId: number; notes: string; transcript: string; transcriptStatus: TranscriptStatus; summary: string; decisions: string; attendees: string; actionItems: string; draft: string | null; createdAt: number; updatedAt: number }
interface FileRow { id: number; momId: number; kind: 'attachment' | 'audio'; name: string; size: number; stored: string }

const TEXT_MAX = 50_000;

function view(ctx: CrmCtx, r: Row): MomView {
  const c = ctx.db.prepare('SELECT name FROM contacts WHERE id = ?').get(r.contactId) as { name: string | null } | undefined;
  const files = (ctx.db.prepare('SELECT * FROM mom_files WHERE momId = ? ORDER BY id').all(r.id) as FileRow[]).map((f) => ({ id: f.id, kind: f.kind, name: f.name, size: f.size }));
  return {
    id: r.id, contactId: r.contactId, contactName: c?.name ?? null, targetKind: r.targetKind, targetId: r.targetId, notes: r.notes, transcript: r.transcript, transcriptStatus: r.transcriptStatus,
    summary: r.summary, decisions: r.decisions, attendees: JSON.parse(r.attendees), actionItems: JSON.parse(r.actionItems), draft: r.draft ? JSON.parse(r.draft) : null, files, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

function row(ctx: CrmCtx, id: number): Row {
  const r = ctx.db.prepare('SELECT * FROM moms WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new CrmNotFoundError('That MOM does not exist');
  return r;
}
export const getMom = (ctx: CrmCtx, id: number): MomView => view(ctx, row(ctx, id));

function text(v: unknown, name: string, max = TEXT_MAX): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new CrmInputError(`${name} must be text`, name);
  if ([...v].length > max) throw new CrmInputError(`${name} must be at most ${max} characters`, name);
  return v;
}

function attendeeIds(ctx: CrmCtx, raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CrmInputError('attendees must be a list of contact ids', 'attendees');
  return [...new Set(raw.map((id) => { if (typeof id !== 'number') throw new CrmInputError('attendees must be contact ids', 'attendees'); getContact(ctx, id); return id; }))];
}

function items(raw: unknown): ActionItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CrmInputError('actionItems must be a list', 'actionItems');
  return raw.map((i) => {
    const o = (i ?? {}) as ActionItem;
    if (typeof o.title !== 'string' || !o.title.trim()) throw new CrmInputError('Each action item needs a title', 'actionItems');
    return { title: o.title.trim().slice(0, 300), ...(o.dueAt !== undefined ? { dueAt: o.dueAt } : {}), ...(o.type ? { type: o.type } : {}), followupId: o.followupId ?? null };
  });
}

export function createMom(ctx: CrmCtx, body: unknown): MomView {
  const b = (body ?? {}) as Record<string, unknown>;
  const targets = (['followupId', 'meetingId', 'appointmentId'] as const).filter((k) => b[k] !== undefined);
  if (targets.length !== 1) throw new CrmInputError('Attach the MOM to exactly one of followupId, meetingId or appointmentId', 'followupId');
  const key = targets[0]!;
  const id = b[key];
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new CrmInputError(`${key} must be an item id`, key);
  const f = ctx.db.prepare('SELECT id, contactId, type FROM followups WHERE id = ?').get(id) as { id: number; contactId: number; type: string } | undefined;
  if (!f) throw new CrmNotFoundError('That item does not exist');
  const isMeeting = f.type === 'online_meeting' || f.type === 'in_person_meeting';
  if ((key === 'meetingId' && !isMeeting) || (key === 'appointmentId' && f.type !== 'appointment')) throw new CrmInputError(`That item is not a ${key === 'meetingId' ? 'meeting' : 'appointment'}`, key);
  if (ctx.db.prepare('SELECT 1 FROM moms WHERE targetKind = ? AND targetId = ?').get('followup', id)) throw new CrmConflictError('That item already has a MOM');
  const now = ctx.now();
  const momId = ctx.db.transaction(() => {
    const mid = Number(ctx.db.prepare(`INSERT INTO moms (contactId, targetKind, targetId, notes, transcript, transcriptStatus, attendees, actionItems, createdAt, updatedAt) VALUES (?, 'followup', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.contactId, id, text(b.notes, 'notes'), text(b.transcript, 'transcript'), b.transcript ? 'pasted' : 'none', JSON.stringify(attendeeIds(ctx, b.attendees)), JSON.stringify(items(b.actionItems)), now, now).lastInsertRowid);
    addEntry(ctx, f.contactId, 'mom', `Meeting notes added for ${f.type.replace(/_/g, ' ')}`, { momId: mid, followupId: id });
    return mid;
  })();
  return getMom(ctx, momId);
}

export function patchMom(ctx: CrmCtx, id: number, body: unknown): MomView {
  const r = row(ctx, id);
  const b = (body ?? {}) as Record<string, unknown>;
  const notes = b.notes !== undefined ? text(b.notes, 'notes') : r.notes;
  const transcript = b.transcript !== undefined ? text(b.transcript, 'transcript') : r.transcript;
  const status: TranscriptStatus = b.transcript !== undefined ? (transcript ? 'pasted' : 'none') : r.transcriptStatus;
  const summary = b.summary !== undefined ? text(b.summary, 'summary') : r.summary;
  const decisions = b.decisions !== undefined ? text(b.decisions, 'decisions') : r.decisions;
  const attendees = b.attendees !== undefined ? attendeeIds(ctx, b.attendees) : JSON.parse(r.attendees);
  const actionItems = b.actionItems !== undefined ? items(b.actionItems) : JSON.parse(r.actionItems);
  ctx.db.prepare('UPDATE moms SET notes = ?, transcript = ?, transcriptStatus = ?, summary = ?, decisions = ?, attendees = ?, actionItems = ?, updatedAt = ? WHERE id = ?')
    .run(notes, transcript, status, summary, decisions, JSON.stringify(attendees), JSON.stringify(actionItems), ctx.now(), id);
  return getMom(ctx, id);
}

export function listMoms(ctx: CrmCtx, q: Record<string, unknown>): Page<MomView> {
  const where: string[] = [], params: unknown[] = [];
  if (typeof q.search === 'string' && q.search.trim()) {
    const like = `%${escapeLike(q.search.trim().toLowerCase())}%`;
    where.push("(lower(notes) LIKE ? ESCAPE '\\' OR lower(summary) LIKE ? ESCAPE '\\' OR lower(decisions) LIKE ? ESCAPE '\\' OR lower(transcript) LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  if (q.contactId !== undefined && q.contactId !== '') {
    const id = Number(q.contactId);
    if (!Number.isSafeInteger(id)) throw new CrmInputError('contactId must be a contact id', 'contactId');
    where.push('contactId = ?'); params.push(id);
  }
  const date = (v: unknown, name: string) => {
    if (v === undefined || v === '') return null;
    const ms = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
    if (!Number.isFinite(ms)) throw new CrmInputError(`${name} must be a date like 2026-03-14`, name);
    return ms;
  };
  const from = date(q.from, 'from'), to = date(q.to, 'to');
  if (from !== null && to !== null && from > to) throw new CrmInputError('from must not be after to', 'from');
  if (from !== null) { where.push('createdAt >= ?'); params.push(from); }
  if (to !== null) { where.push('createdAt < ?'); params.push(to + 86_400_000); }
  return pageOf<Row, MomView>(ctx.db, { select: 'SELECT * FROM moms', where, params, order: 'createdAt DESC, id DESC', limit: q.limit, offset: q.offset, map: (r) => view(ctx, r) });
}

// ---- files --------------------------------------------------------------

/** A plain file name: no folders, no control characters, bounded length. */
export function safeFileName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f]/g, '').split(/[\\/]/).pop()!.trim().replace(/^\.+/, '') : '';
  if (!name) throw new CrmInputError('The file needs a name', 'name');
  return name.slice(0, 120);
}

export async function addFile(ctx: CrmCtx, momId: number, kind: 'attachment' | 'audio', rawName: unknown, bytes: Buffer): Promise<MomFileView> {
  row(ctx, momId);
  const name = safeFileName(rawName);
  if (bytes.length === 0) throw new CrmInputError('The file is empty', 'file');
  if (bytes.length > MOM_ATTACHMENT_MAX_BYTES) throw new CrmInputError(`A file can be at most ${MOM_ATTACHMENT_MAX_BYTES / 1_048_576} MB`, 'file');
  const count = (ctx.db.prepare("SELECT COUNT(*) AS n FROM mom_files WHERE momId = ? AND kind = 'attachment'").get(momId) as { n: number }).n;
  if (kind === 'attachment' && count >= MOM_ATTACHMENTS_MAX) throw new CrmInputError(`A MOM can have at most ${MOM_ATTACHMENTS_MAX} attachments`, 'file');
  const id = Number(ctx.db.prepare('INSERT INTO mom_files (momId, kind, name, size, stored, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(momId, kind, name, bytes.length, '', ctx.now()).lastInsertRowid);
  const stored = `${momId}/${id}`;
  try {
    await mkdir(path.join(ctx.filesDir, String(momId)), { recursive: true });
    await writeFile(path.join(ctx.filesDir, stored), bytes);
  } catch (e) { ctx.db.prepare('DELETE FROM mom_files WHERE id = ?').run(id); throw e; }
  ctx.db.prepare('UPDATE mom_files SET stored = ? WHERE id = ?').run(stored, id);
  return { id, kind, name, size: bytes.length };
}

export async function readFileBytes(ctx: CrmCtx, momId: number, fileId: number): Promise<{ name: string; bytes: Buffer }> {
  const f = ctx.db.prepare('SELECT * FROM mom_files WHERE id = ? AND momId = ?').get(fileId, momId) as FileRow | undefined;
  if (!f) throw new CrmNotFoundError('That file does not exist');
  return { name: f.name, bytes: await readFile(path.join(ctx.filesDir, f.stored)) };
}

export async function deleteFile(ctx: CrmCtx, momId: number, fileId: number): Promise<void> {
  const f = ctx.db.prepare('SELECT * FROM mom_files WHERE id = ? AND momId = ?').get(fileId, momId) as FileRow | undefined;
  if (!f) throw new CrmNotFoundError('That file does not exist');
  ctx.db.prepare('DELETE FROM mom_files WHERE id = ?').run(fileId);
  await rm(path.join(ctx.filesDir, f.stored), { force: true });
}

// ---- agent --------------------------------------------------------------

const agentMessage = (e: unknown) => (e instanceof Error ? e.message : 'The agent failed');

/** Asks an agent to transcribe the saved audio. A failure is reported in place and leaves the transcript as it was. */
export async function transcribe(ctx: CrmCtx, momId: number): Promise<{ mom: MomView; agentError?: string }> {
  const r = row(ctx, momId);
  const audio = ctx.db.prepare("SELECT * FROM mom_files WHERE momId = ? AND kind = 'audio' ORDER BY id DESC").get(momId) as FileRow | undefined;
  if (!audio) throw new CrmConflictError('Add an audio note first');
  try {
    const out = (await ctx.deps.agent.run({ kind: 'mom', prompt: `Transcribe the audio file at ${path.join(ctx.filesDir, audio.stored)} with any tool available on this machine. Reply with the transcript only.` })).trim();
    if (!out) return { mom: view(ctx, r), agentError: 'The agent returned no transcript' };
    ctx.db.prepare("UPDATE moms SET transcript = ?, transcriptStatus = 'automatic', updatedAt = ? WHERE id = ?").run(out.slice(0, TEXT_MAX), ctx.now(), momId);
    return { mom: getMom(ctx, momId) };
  } catch (e) { return { mom: view(ctx, r), agentError: agentMessage(e) }; }
}

/** The agent turns notes, transcript and attachments into a MOM. The result is a draft unless "apply without review" is on for MOMs. */
export async function analyse(ctx: CrmCtx, momId: number): Promise<{ mom: MomView; applied: boolean; agentError?: string }> {
  const r = row(ctx, momId);
  const files = (ctx.db.prepare("SELECT * FROM mom_files WHERE momId = ? AND kind = 'attachment'").all(momId) as FileRow[]).map((f) => path.join(ctx.filesDir, f.stored));
  const prompt = [
    'Write minutes of meeting with the headings Summary, Decisions and Action items (one action item per line).',
    `Typed notes:\n${r.notes || '(none)'}`, `Transcript:\n${r.transcript || '(none)'}`, files.length ? `Attachments to read:\n${files.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  let parsed;
  try { parsed = parseMomOutput(await ctx.deps.agent.run({ kind: 'mom', prompt })); }
  catch (e) { return { mom: view(ctx, r), applied: false, agentError: agentMessage(e) }; }
  if (ctx.settings().agentAutoApply.moms) return { mom: applyParsed(ctx, momId, parsed), applied: true };
  ctx.db.prepare('UPDATE moms SET draft = ?, updatedAt = ? WHERE id = ?').run(JSON.stringify(parsed), ctx.now(), momId);
  return { mom: getMom(ctx, momId), applied: false };
}

function applyParsed(ctx: CrmCtx, momId: number, p: { summary: string; decisions: string; actionItems: string[] }): MomView {
  const r = row(ctx, momId);
  const existing: ActionItem[] = JSON.parse(r.actionItems);
  const merged = [...existing, ...p.actionItems.filter((t) => !existing.some((e) => e.title === t)).map((title) => ({ title, followupId: null }))];
  ctx.db.prepare('UPDATE moms SET summary = ?, decisions = ?, actionItems = ?, draft = NULL, updatedAt = ? WHERE id = ?').run(p.summary.slice(0, TEXT_MAX), p.decisions.slice(0, TEXT_MAX), JSON.stringify(merged), ctx.now(), momId);
  return getMom(ctx, momId);
}

export function acceptDraft(ctx: CrmCtx, momId: number, body: unknown): MomView {
  const r = row(ctx, momId);
  if (!r.draft) throw new CrmConflictError('There is no draft to accept');
  const b = (body ?? {}) as { summary?: unknown; decisions?: unknown };
  const d = JSON.parse(r.draft) as { summary: string; decisions: string; actionItems: string[] };
  return applyParsed(ctx, momId, { ...d, summary: b.summary !== undefined ? text(b.summary, 'summary') : d.summary, decisions: b.decisions !== undefined ? text(b.decisions, 'decisions') : d.decisions });
}

export function discardDraft(ctx: CrmCtx, momId: number): MomView {
  row(ctx, momId);
  ctx.db.prepare('UPDATE moms SET draft = NULL WHERE id = ?').run(momId);
  return getMom(ctx, momId);
}

/** One click turns an action item into a followup; a second click returns the same one. */
export function actionItemToFollowup(ctx: CrmCtx, momId: number, index: number): { followupId: number; created: boolean } {
  const r = row(ctx, momId);
  const list: ActionItem[] = JSON.parse(r.actionItems);
  const item = list[index];
  if (!item) throw new CrmNotFoundError('That action item does not exist');
  if (item.followupId) return { followupId: item.followupId, created: false };
  const tomorrow = ctx.now() + 86_400_000;
  const f = createTask(ctx, r.contactId, { type: item.type ?? 'other', dueAt: item.dueAt ?? tomorrow, title: item.title });
  list[index] = { ...item, followupId: f.id };
  ctx.db.prepare('UPDATE moms SET actionItems = ? WHERE id = ?').run(JSON.stringify(list), momId);
  return { followupId: f.id, created: true };
}

