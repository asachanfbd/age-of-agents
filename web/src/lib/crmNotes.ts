import type { MomDto, TranscriptStatus } from './crmTypes';

export const ATTACHMENT_MAX_BYTES = 20 * 1_048_576;
export const ATTACHMENTS_MAX = 10;

export const transcriptLabel = (s: TranscriptStatus): string => (s === 'automatic' ? 'Transcript: automatic' : s === 'pasted' ? 'Transcript: pasted' : 'Transcript: none');

export function momListParams(f: { search: string; contactId?: number | null; from?: string; to?: string; offset: number; limit: number }) {
  return { search: f.search.trim() || undefined, contactId: f.contactId ?? undefined, from: f.from || undefined, to: f.to || undefined, limit: f.limit, offset: f.offset };
}

/** The same limits the server enforces: 20 MB each, 10 per MOM. */
export function checkAttachment(file: { name: string; size: number }, existing: number): string | null {
  if (existing >= ATTACHMENTS_MAX) return `A MOM can have at most ${ATTACHMENTS_MAX} attachments.`;
  if (file.size > ATTACHMENT_MAX_BYTES) return `${file.name} is larger than ${ATTACHMENT_MAX_BYTES / 1_048_576} MB.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

export type DraftBanner = { kind: 'draft'; actions: Array<'accept' | 'edit' | 'discard'> } | { kind: 'error'; message: string } | null;
/** The banner over a MOM: an agent draft to accept, edit or discard, or a failure shown in place (typed notes stay savable either way). */
export function agentBanner(mom: Pick<MomDto, 'draft'>, agentError: string | null): DraftBanner {
  if (agentError) return { kind: 'error', message: agentError };
  return mom.draft ? { kind: 'draft', actions: ['accept', 'edit', 'discard'] } : null;
}
export const badgeFor = (mom: Pick<MomDto, 'draft'>): string | null => (mom.draft ? 'Draft' : null);
export const canSaveNotes = (readOnly: boolean): boolean => !readOnly;
