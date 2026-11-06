import type { SettingsDto, SmtpState } from './crmTypes';

/** The same ranges the server enforces for each number field. */
export const NUMBER_FIELDS = {
  followups: { label: 'Number of followups', min: 0, max: 10 },
  gapFirst: { label: 'Days before followup 1', min: 0, max: 365 },
  gapNext: { label: 'Days between followups', min: 0, max: 365 },
  retryHours: { label: 'Retry after (hours)', min: 1, max: 720 },
  retryTries: { label: 'Tries before the catch-up', min: 1, max: 20 },
  resurfaceDays: { label: 'Resurface after (days, 0 = off)', min: 0, max: 3650 },
  dailyCap: { label: 'Emails per day', min: 1, max: 1_000_000 },
  gapSeconds: { label: 'Seconds between emails', min: 0, max: 86_400 },
  messagesPer30: { label: 'Messages per 30 minutes', min: 1, max: 10_000 },
  callsPer30: { label: 'Calls per 30 minutes', min: 1, max: 10_000 },
  onTimeMinutes: { label: 'On-time window (minutes)', min: 0, max: 1440 },
  duration: { label: 'Duration (minutes)', min: 1, max: 1440 },
  port: { label: 'Port', min: 1, max: 65_535 },
} as const;
export type NumberField = keyof typeof NUMBER_FIELDS;

/** The error text for an out-of-range value, or null. Only whole numbers are accepted. */
export function validateNumber(field: NumberField, raw: string | number): string | null {
  const f = NUMBER_FIELDS[field];
  const n = typeof raw === 'number' ? raw : raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isSafeInteger(n) || n < f.min || n > f.max) return `${f.label} must be a whole number from ${f.min.toLocaleString('en-US')} to ${f.max.toLocaleString('en-US')}.`;
  return null;
}

export interface SmtpForm { host: string; port: string; security: 'starttls' | 'ssl' | 'none'; user: string; from: string; password: string }
/** The form never shows a saved password: it starts empty and only the "saved" flag is read. */
export function smtpFormFrom(s: SettingsDto['smtp']): { form: SmtpForm; passwordSaved: boolean } {
  return { form: { host: s.host, port: String(s.port), security: s.security, user: s.user, from: s.from, password: '' }, passwordSaved: s.status.passwordSaved };
}
/** An empty password field is left out of the request, so the saved one is kept. Clearing is a separate, explicit action. */
export function smtpPayload(f: SmtpForm, clearPassword = false): { smtp: Record<string, unknown> } {
  const smtp: Record<string, unknown> = { host: f.host.trim(), port: Number(f.port), security: f.security, user: f.user.trim(), from: f.from.trim() };
  if (clearPassword) smtp.password = '';
  else if (f.password !== '') smtp.password = f.password;
  return { smtp };
}
export function smtpStatusText(status: { state: SmtpState; reason: string | null }): string {
  if (status.state === 'connected') return 'Connected';
  if (status.state === 'needs_attention') return `Needs attention: ${status.reason ?? 'sending failed'}`;
  return 'Not connected';
}

/** The text for a delete the server refused because the item is in use (409 with a count). */
export function inUseMessage(what: 'custom field' | 'lost reason', error: { status?: number; message: string; details?: Record<string, unknown> }): string {
  const n = error.details?.inUse;
  return typeof n === 'number' ? `This ${what} is in use by ${n.toLocaleString('en-US')} contact${n === 1 ? '' : 's'}. ${error.message}` : error.message;
}
