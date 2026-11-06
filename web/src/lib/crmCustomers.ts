import type { BuildingPeekDto, ContactDto, Segment } from './crmTypes';

export type AttachedRowState =
  | { state: 'ok'; line: string; retry: false }
  | { state: 'basics'; line: string; retry: false }
  | { state: 'unavailable'; line: string; retry: false }
  | { state: 'read_failed'; line: string; retry: true };

/** An attached Building row: a summary, the basics only, "no longer exists", or a failed read with Retry. One row never hides another. */
export function attachedRowState(peek: BuildingPeekDto): AttachedRowState {
  if (peek.state === 'unavailable') return { state: 'unavailable', line: 'This Building no longer exists', retry: false };
  if (peek.state === 'read_failed') return { state: 'read_failed', line: `Could not read this Building: ${peek.reason}`, retry: true };
  const basics = `${peek.name} · ${peek.typeId} · ${peek.status}`;
  return peek.summary ? { state: 'ok', line: `${basics} · ${peek.summary}`, retry: false } : { state: 'basics', line: basics, retry: false };
}

/** "Reopen (stage New)" by default; the owner can pick another stage for a lost prospect. A lost customer returns as a customer. */
export function reopenLabel(segment: Segment, stage: string = 'New'): string {
  return segment === 'lost_customer' ? 'Reopen as customer' : `Reopen (stage ${stage})`;
}
export const REOPEN_STAGES = ['New', 'Contacted', 'Engaged', 'Meeting set', 'Proposal'] as const;
/** The stage sent with a reopen: only a lost prospect has one, and New is the server's default. */
export const reopenStageParam = (segment: Segment, stage: string): string | undefined => (segment === 'lost_prospect' && stage !== 'New' ? stage : undefined);
export const LOST_SECTIONS = [{ key: 'prospects', title: 'Lost prospects' }, { key: 'customers', title: 'Lost customers' }] as const;

/** Share of a contact's basics that are filled (name, company, title, one usable channel, one tag), as a whole-number percentage. */
export function profileCompleteness(c: Pick<ContactDto, 'name' | 'company' | 'title' | 'channels' | 'tags'>): number {
  const filled = [c.name, c.company, c.title].filter((v) => v && v.trim()).length + (c.channels.some((ch) => !ch.invalid && !ch.dnc) ? 1 : 0) + (c.tags.length > 0 ? 1 : 0);
  return Math.round((filled / 5) * 100);
}

/** When the contact became a customer, falling back to when it was added; null when neither is a usable instant. */
export function sinceAt(c: Pick<ContactDto, 'customerAt' | 'createdAt'>): number | null {
  const at = c.customerAt ?? c.createdAt;
  return Number.isFinite(at) && at > 0 ? at : null;
}

export const GRID_VIEWS = [{ value: 'grid', label: 'Grid' }, { value: 'table', label: 'Table' }] as const;
export type CustomerView = (typeof GRID_VIEWS)[number]['value'];

/** The segment chips of the Customers directory; "all" shows every customer loaded. */
export const SEGMENT_CHIPS = [{ value: 'all', label: 'All' }, { value: 'with-buildings', label: 'With Buildings' }, { value: 'no-buildings', label: 'No Buildings' }] as const;
export type SegmentChip = (typeof SEGMENT_CHIPS)[number]['value'];
export function filterCustomers<T extends { buildings: unknown[] }>(rows: readonly T[], chip: SegmentChip): T[] {
  if (chip === 'with-buildings') return rows.filter((r) => r.buildings.length > 0);
  if (chip === 'no-buildings') return rows.filter((r) => r.buildings.length === 0);
  return [...rows];
}

const usable = (c: Pick<ContactDto, 'channels' | 'dnc'>, type: 'email' | 'phone') => (c.dnc ? undefined : c.channels.find((ch) => ch.type === type && !ch.invalid && !ch.dnc));
/** `mailto:` link to the contact's first usable email, or null when it has none (or is marked do-not-contact). */
export const emailHref = (c: Pick<ContactDto, 'channels' | 'dnc'>): string | null => { const ch = usable(c, 'email'); return ch ? `mailto:${ch.handle}` : null; };
/** `tel:` link to the contact's first usable phone number, or null. */
export const phoneHref = (c: Pick<ContactDto, 'channels' | 'dnc'>): string | null => { const ch = usable(c, 'phone'); return ch ? `tel:${ch.handle.replace(/\s+/g, '')}` : null; };
/** "Title · Company", whichever are present. */
export const roleLine = (c: Pick<ContactDto, 'title' | 'company'>): string => [c.title, c.company].filter((v) => v && v.trim()).join(' · ') || 'No company';
