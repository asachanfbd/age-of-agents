import { PHONE_DIGITS_MAX } from './limits.ts';

export const CHANNEL_TYPES = ['phone', 'email', 'instagram', 'facebook', 'linkedin', 'other'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export type Normalised = { ok: true; value: string; noCountryCode?: boolean } | { ok: false; reason: string };

const fullWidth = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** Default country code as bare digits (1 to 3), or null when unset. `+49` and `49` read the same. */
export function parseCountryCode(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replace(/^\+/, '');
  if (!/^[1-9]\d{0,2}$/.test(text)) throw new RangeError('Country code must be 1 to 3 digits');
  return text;
}

/** Digits with an optional leading `+` or `00` and the usual separators; letters or other text are not a phone. */
const PHONE_SHAPE = /^(?:\+|00)?[\d\s().\-/]*$/;

export function normalisePhone(raw: string, countryCode: string | null): Normalised {
  const text = fullWidth(raw.trim());
  if (!PHONE_SHAPE.test(text)) return { ok: false, reason: 'Invalid phone' };
  const international = /^(\+|00)/.test(text);
  let digits = text.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'Invalid phone' };
  if (text.startsWith('00') && !text.startsWith('+')) digits = digits.slice(2);
  let noCountryCode = false;
  if (!international) {
    if (countryCode) digits = countryCode + digits.replace(/^0/, '');
    else noCountryCode = true;
  }
  if (!digits || digits.length > PHONE_DIGITS_MAX) return { ok: false, reason: 'Invalid phone' };
  return noCountryCode ? { ok: true, value: digits, noCountryCode } : { ok: true, value: digits };
}

export function normaliseEmail(raw: string): Normalised {
  const value = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) return { ok: false, reason: 'Invalid email' };
  return { ok: true, value };
}

const SOCIAL_HOST = /^(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.me|linkedin\.com|lnkd\.in)(?:\/|$)/i;

/** Reduces an Instagram, Facebook or LinkedIn profile URL, `@name` or bare name to a lower-cased handle. */
export function normaliseSocial(raw: string, type: 'instagram' | 'facebook' | 'linkedin'): Normalised {
  let text = raw.trim();
  text = text.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '');
  const host = SOCIAL_HOST.exec(text);
  if (host) text = text.slice(host[0].length);
  text = text.replace(/^@+/, '').replace(/\/+$/, '');
  if (type === 'linkedin') {
    const match = /^(in|company)\/([^/]+)/i.exec(text);
    if (match) text = `${match[1]!.toLowerCase()}/${match[2]}`;
  } else {
    text = text.split('/')[0]!;
  }
  text = text.trim().toLowerCase();
  return text ? { ok: true, value: text } : { ok: false, reason: 'No handle' };
}

export function normaliseOther(raw: string, label: string | undefined): Normalised {
  if (!label?.trim()) return { ok: false, reason: 'Label required' };
  const value = raw.trim().toLowerCase();
  return value ? { ok: true, value } : { ok: false, reason: 'No handle' };
}

export function normaliseHandle(type: ChannelType, raw: unknown, opts: { countryCode?: string | null; label?: string } = {}): Normalised {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'No handle' };
  switch (type) {
    case 'email': return normaliseEmail(raw);
    case 'phone': return normalisePhone(raw, opts.countryCode ?? null);
    case 'other': return normaliseOther(raw, opts.label);
    default: return normaliseSocial(raw, type);
  }
}

/** The key two contacts share when "same name" applies: case and accents ignored, spaces collapsed. */
export function nameKey(name: string | null | undefined): string {
  return (name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
