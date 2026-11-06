import type { ChannelType, FollowupDto, Outcome } from './crmTypes';

// ---- the manual "Pending reachout" popup -----------------------------------

export type ManualChoice = 'sent' | 'retry' | 'stop';
export const MANUAL_OPTIONS: Array<{ value: ManualChoice; label: (platform: string) => string }> = [
  { value: 'sent', label: (platform) => `Sent message on ${platform}` },
  { value: 'retry', label: () => "Message sending failed, I'll try again" },
  { value: 'stop', label: () => 'Stop the followups' },
];

export const PLATFORMS = ['Phone', 'Email', 'Instagram', 'Facebook', 'LinkedIn', 'WhatsApp', 'SMS', 'Other'] as const;
const PLATFORM_FOR_CHANNEL: Record<ChannelType, string> = { phone: 'Phone', email: 'Email', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', other: 'Other' };
/** Pre-selected from the channel; the owner can change it. */
export const defaultPlatform = (channel: ChannelType | null): string => (channel ? PLATFORM_FOR_CHANNEL[channel] : 'Other');

/** Submit stays disabled until a choice is made, and while a request is in flight. */
export const submitEnabled = (choice: ManualChoice | null, busy = false): boolean => choice !== null && !busy;

export function submitBody(choice: ManualChoice, platform: string): { choice: ManualChoice; platform?: string } {
  return choice === 'sent' ? { choice, platform } : { choice };
}

/** What the retry option promises, from the Settings values. */
export function retryNote(tries: number, settings: { retryHours: number; retryTries: number }): string {
  const hours = settings.retryHours === 1 ? '1 hour' : `${settings.retryHours} hours`;
  return `Returns in ${hours} (try ${Math.min(tries + 1, settings.retryTries)} of ${settings.retryTries})`;
}

/** Copy puts exactly the message the owner sees (edited or not) on the clipboard. */
export const copyText = (message: string | null): string => message ?? '';

export function unknownFieldNote(fields: string[]): string | null {
  if (fields.length === 0) return null;
  return `Unknown field${fields.length === 1 ? '' : 's'} left in the message: ${fields.map((f) => `{${f}}`).join(', ')}`;
}

// ---- Expand Today ---------------------------------------------------------

export const RESPONSE_OPTIONS: Array<{ value: Outcome; label: string }> = [
  { value: 'interested', label: 'Interested' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'later', label: 'Later / call back on a date' },
  { value: 'wrong_number', label: 'Wrong number / bounced' },
  { value: 'no_response_yet', label: 'No response yet' },
  { value: 'became_customer', label: 'Became a customer' },
];

export type CardGroupId = 'sent_no_response' | 'overdue' | 'awaiting_approval' | 'failed_retry' | 'agenda';
export interface SeriesCard { group: CardGroupId; groupTitle: string; index: number; of: number; progress: string; card: unknown }

/** One flat series of cards in the server's group order, each saying "n of N" across all groups. */
export function flattenSeries(groups: Array<{ id: CardGroupId; title: string; cards: unknown[] }>): SeriesCard[] {
  const all = groups.flatMap((g) => g.cards.map((card) => ({ group: g.id, groupTitle: g.title, card })));
  return all.map((c, i) => ({ ...c, index: i, of: all.length, progress: `${i + 1} of ${all.length}` }));
}

/** Skip leaves the item for later and sends nothing: the position just moves on. */
export const skipTo = (index: number, total: number): number | null => (index + 1 < total ? index + 1 : null);

export function emptyGroups(groups: Array<{ id: CardGroupId; title: string; emptyText: string; cards: unknown[] }>): Array<{ id: CardGroupId; title: string; text: string }> {
  return groups.filter((g) => g.cards.length === 0).map((g) => ({ id: g.id, title: g.title, text: g.emptyText }));
}

/** The actions a card offers follow its group: the popup's three choices for a manual item, approval for email, the response list for waiting items. */
export function cardActions(group: CardGroupId, item: Pick<FollowupDto, 'integrated' | 'catchUp'> | null): string[] {
  if (group === 'sent_no_response') return RESPONSE_OPTIONS.map((o) => o.value);
  if (group === 'awaiting_approval') return ['approve', 'reject', 'edit'];
  if (group === 'failed_retry') return item?.catchUp ? ['change_channel', 'keep_trying', 'stop'] : ['sent', 'retry', 'stop'];
  if (group === 'overdue') return item?.integrated ? ['approve', 'reject'] : ['sent', 'retry', 'stop'];
  return [];
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** A `datetime-local` value ("YYYY-MM-DDTHH:mm") for the instant in the browser's local time, which is how the input reads it. */
export function localDateTimeInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
