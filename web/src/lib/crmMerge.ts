import type { ContactDto, Segment, SuggestionDto } from './crmTypes';

export const SEGMENT_RANK: Record<Segment, number> = { customer: 3, prospect: 2, lost_customer: 1, lost_prospect: 0 };

/** Which contact's segment and stage the merged contact keeps when the owner does not choose: a customer beats a prospect, active beats lost. */
export function defaultSegmentChoice(first: Segment, second: Segment): 'first' | 'second' {
  return SEGMENT_RANK[second] > SEGMENT_RANK[first] ? 'second' : 'first';
}

export function suggestionTitle(s: SuggestionDto): string {
  const label = (c: SuggestionDto['first']) => `${c.name ?? 'No name'}${c.company ? ` (${c.company})` : ''}`;
  return `${label(s.first)} and ${label(s.second)}`;
}

export const key = (s: SuggestionDto): string => `${s.first.id}:${s.second.id}`;
/** A dismissed or accepted pair leaves the list at once. */
export const without = (list: SuggestionDto[], s: SuggestionDto): SuggestionDto[] => list.filter((x) => key(x) !== key(s));

/** The text shown when the server refuses an undo (409): its own sentence, with the reason kind when it sent one. */
export function undoRefusal(error: { status?: number; message: string; details?: Record<string, unknown> }): string {
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : null;
  return reason ? `${error.message} (${reason})` : error.message;
}

/** How a contact reads in the picker: name (or first handle), company and id. */
export const contactLabel = (c: Pick<ContactDto, 'id' | 'name' | 'company' | 'channels'>): string => `${c.name ?? c.channels[0]?.handle ?? 'No name'}${c.company ? ` (${c.company})` : ''} · #${c.id}`;
