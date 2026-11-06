import { CrmConflictError, CrmInputError } from './errors.ts';
import { CUSTOM_FIELDS_MAX, EMAIL_DAILY_CAP, EMAIL_GAP_SECONDS, FOLLOWUPS_MAX, GAP_DAYS_MAX, ON_TIME_MINUTES, RETRY_DELAY_HOURS, RETRY_TRIES } from './limits.ts';
import { parseCountryCode } from './normalize.ts';
import { isValidTimeZone, parseClock } from './zoned.ts';

export const FOLLOWUP_TYPES = ['call', 'message', 'email', 'dm', 'online_meeting', 'in_person_meeting', 'appointment', 'other'] as const;
export type FollowupType = (typeof FOLLOWUP_TYPES)[number];
/** Types whose items are drafted from templates; the rest carry no message. */
export const MESSAGE_TYPES: readonly FollowupType[] = ['message', 'email', 'dm'];
export const SMTP_SECURITY = ['starttls', 'ssl', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export const DEFAULT_LOST_REASONS = ['Not interested', 'No response', 'Wrong fit', 'Bought elsewhere', 'Do not contact', 'Other'] as const;

export interface DailySlot { id: string; name: string; minutes: number; start: string | null }
export interface CustomFieldDef { id: string; name: string }
export interface WorkingDay { open: boolean; start: string; end: string }
export interface SmtpConfig { host: string; port: number; security: SmtpSecurity; user: string; from: string }

export interface CrmSettings {
  cadence: { gapDays: [number, number]; followups: number; retryHours: number; retryTries: number; autoLost: boolean; resurfaceDays: number };
  approval: Record<string, boolean>;
  agentAutoApply: { messageDrafts: boolean; moms: boolean };
  templates: Record<string, string>;
  durations: Record<FollowupType, number>;
  sessions: { messagesPer30: number; callsPer30: number };
  workingHours: WorkingDay[];
  timezone: string;
  dailySlots: DailySlot[];
  lostReasons: string[];
  customFields: CustomFieldDef[];
  countryCode: string | null;
  emailFooter: string;
  email: { dailyCap: number; gapSeconds: number };
  onTimeMinutes: number;
  smtp: SmtpConfig;
}

export function defaultSettings(timezone = 'UTC'): CrmSettings {
  const weekday: WorkingDay = { open: true, start: '09:00', end: '17:00' };
  const closed: WorkingDay = { open: false, start: '09:00', end: '17:00' };
  return {
    cadence: { gapDays: [2, 4], followups: 2, retryHours: RETRY_DELAY_HOURS, retryTries: RETRY_TRIES, autoLost: false, resurfaceDays: 30 },
    approval: { email: false },
    agentAutoApply: { messageDrafts: false, moms: false },
    templates: {},
    durations: { call: 2, message: 1, email: 1, dm: 1, online_meeting: 30, in_person_meeting: 60, appointment: 60, other: 5 },
    sessions: { messagesPer30: 40, callsPer30: 15 },
    // Index 0 is Sunday, as in Date.getDay().
    workingHours: [closed, weekday, weekday, weekday, weekday, weekday, closed],
    timezone,
    dailySlots: [
      { id: 'reachouts', name: 'Reachouts', minutes: 60, start: null },
      { id: 'finding', name: 'Finding new prospects', minutes: 60, start: null },
    ],
    lostReasons: [...DEFAULT_LOST_REASONS],
    customFields: [],
    countryCode: null,
    emailFooter: 'If you would rather not hear from me, just reply "unsubscribe" and I will not contact you again.',
    email: { dailyCap: EMAIL_DAILY_CAP, gapSeconds: EMAIL_GAP_SECONDS },
    onTimeMinutes: ON_TIME_MINUTES,
    smtp: { host: '', port: 587, security: 'starttls', user: '', from: '' },
  };
}

/** `approval` default: email waits for approval (true means "send without approval"). */
export const sendsWithoutApproval = (s: CrmSettings, channel: string): boolean => s.approval[channel] === true;

export function intIn(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new CrmInputError(`${name} must be a whole number from ${min} to ${max}`, name);
  return value;
}
const bool = (v: unknown, name: string): boolean => {
  if (typeof v !== 'boolean') throw new CrmInputError(`${name} must be true or false`, name);
  return v;
};
const text = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string') throw new CrmInputError(`${name} must be text`, name);
  if (v.length > max) throw new CrmInputError(`${name} must be at most ${max} characters`, name);
  return v;
};
const MAX_MINUTES = 24 * 60;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const obj = (v: unknown, name: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CrmInputError(`${name} must be an object`, name);
  return v as Record<string, unknown>;
};

export function validateDailySlots(value: unknown): DailySlot[] {
  if (!Array.isArray(value)) throw new CrmInputError('dailySlots must be a list', 'dailySlots');
  const names = new Set<string>();
  return value.map((raw, i) => {
    const s = obj(raw, 'dailySlots');
    const name = text(s.name, 'slot name', 80).trim();
    if (!name) throw new CrmInputError('A slot needs a name', 'dailySlots');
    if (names.has(name.toLowerCase())) throw new CrmInputError(`Slot name "${name}" is used twice`, 'dailySlots');
    names.add(name.toLowerCase());
    const minutes = intIn(s.minutes, 1, MAX_MINUTES, 'slot minutes');
    const start = s.start === null || s.start === undefined ? null : text(s.start, 'slot start', 5);
    if (start !== null && parseClock(start) === null) throw new CrmInputError('Slot start must be HH:MM', 'dailySlots');
    return { id: typeof s.id === 'string' && s.id ? s.id : `slot-${i + 1}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, minutes, start };
  });
}

export function validateWorkingHours(value: unknown): WorkingDay[] {
  if (!Array.isArray(value) || value.length !== 7) throw new CrmInputError('workingHours needs seven days, Sunday first', 'workingHours');
  return value.map((raw) => {
    const d = obj(raw, 'workingHours');
    const open = bool(d.open, 'open');
    const start = parseClock(d.start), end = parseClock(d.end);
    if (start === null || end === null) throw new CrmInputError('Working hours must be HH:MM', 'workingHours');
    if (open && end <= start) throw new CrmInputError('Working hours must end after they start', 'workingHours');
    return { open, start: String(d.start), end: String(d.end) };
  });
}

export function validateCustomFieldName(name: unknown, existing: CustomFieldDef[], selfId?: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new CrmInputError('Field name is required', 'name');
  if (trimmed.length > 80) throw new CrmInputError('Field name must be at most 80 characters', 'name');
  if (existing.some((f) => f.id !== selfId && f.name.toLowerCase() === trimmed.toLowerCase())) throw new CrmConflictError(`A field named "${trimmed}" already exists`);
  return trimmed;
}

export const customFieldCapReached = (fields: CustomFieldDef[]) => fields.length >= CUSTOM_FIELDS_MAX;

export function validateLostReasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new CrmInputError('Keep at least one lost reason', 'lostReasons');
  const seen = new Set<string>();
  return value.map((r) => {
    const reason = text(r, 'lost reason', 80).trim();
    if (!reason) throw new CrmInputError('A lost reason cannot be empty', 'lostReasons');
    if (seen.has(reason.toLowerCase())) throw new CrmInputError(`Reason "${reason}" is listed twice`, 'lostReasons');
    seen.add(reason.toLowerCase());
    return reason;
  });
}

export function validateSmtpConfig(value: unknown, current: SmtpConfig): SmtpConfig {
  const s = obj(value, 'smtp');
  const next = { ...current };
  if (s.host !== undefined) next.host = text(s.host, 'host', 255).trim();
  if (s.port !== undefined) next.port = intIn(s.port, 1, 65535, 'port');
  if (s.security !== undefined) {
    if (!SMTP_SECURITY.includes(s.security as SmtpSecurity)) throw new CrmInputError('security must be starttls, ssl or none', 'security');
    next.security = s.security as SmtpSecurity;
  }
  if (s.user !== undefined) next.user = text(s.user, 'user', 255).trim();
  if (s.from !== undefined) {
    next.from = text(s.from, 'from', 255).trim();
    if (next.from && !/^[^\s@]+@[^\s@]+$/.test(next.from)) throw new CrmInputError('from must be an email address', 'from');
  }
  return next;
}

/** Applies a partial settings change, validating each field; unknown keys and the managed lists (custom fields, reasons) are refused here. */
export function applySettingsPatch(current: CrmSettings, patch: unknown): CrmSettings {
  const p = obj(patch, 'body');
  const next: CrmSettings = structuredClone(current);
  for (const [key, value] of Object.entries(p)) {
    switch (key) {
      case 'cadence': {
        const c = obj(value, 'cadence');
        if (c.gapDays !== undefined) {
          if (!Array.isArray(c.gapDays) || c.gapDays.length !== 2) throw new CrmInputError('gapDays needs two numbers', 'gapDays');
          next.cadence.gapDays = [intIn(c.gapDays[0], 0, GAP_DAYS_MAX, 'gapDays'), intIn(c.gapDays[1], 0, GAP_DAYS_MAX, 'gapDays')];
        }
        if (c.followups !== undefined) next.cadence.followups = intIn(c.followups, 0, FOLLOWUPS_MAX, 'followups');
        if (c.retryHours !== undefined) next.cadence.retryHours = intIn(c.retryHours, 1, 24 * 30, 'retryHours');
        if (c.retryTries !== undefined) next.cadence.retryTries = intIn(c.retryTries, 1, 20, 'retryTries');
        if (c.autoLost !== undefined) next.cadence.autoLost = bool(c.autoLost, 'autoLost');
        if (c.resurfaceDays !== undefined) next.cadence.resurfaceDays = intIn(c.resurfaceDays, 0, 3650, 'resurfaceDays');
        break;
      }
      case 'approval': {
        for (const [ch, v] of Object.entries(obj(value, 'approval'))) next.approval[ch] = bool(v, `approval.${ch}`);
        break;
      }
      case 'agentAutoApply': {
        const a = obj(value, 'agentAutoApply');
        if (a.messageDrafts !== undefined) next.agentAutoApply.messageDrafts = bool(a.messageDrafts, 'messageDrafts');
        if (a.moms !== undefined) next.agentAutoApply.moms = bool(a.moms, 'moms');
        break;
      }
      case 'templates': {
        for (const [k, v] of Object.entries(obj(value, 'templates'))) {
          if (!/^[a-z]+:\d+$/.test(k)) throw new CrmInputError(`Template key "${k}" must look like email:0`, 'templates');
          next.templates[k] = text(v, 'template', 20_000);
        }
        break;
      }
      case 'durations': {
        for (const [k, v] of Object.entries(obj(value, 'durations'))) {
          if (!FOLLOWUP_TYPES.includes(k as FollowupType)) throw new CrmInputError(`Unknown duration type "${k}"`, 'durations');
          next.durations[k as FollowupType] = intIn(v, 1, MAX_MINUTES, k);
        }
        break;
      }
      case 'sessions': {
        const s = obj(value, 'sessions');
        if (s.messagesPer30 !== undefined) next.sessions.messagesPer30 = intIn(s.messagesPer30, 1, 10_000, 'messagesPer30');
        if (s.callsPer30 !== undefined) next.sessions.callsPer30 = intIn(s.callsPer30, 1, 10_000, 'callsPer30');
        break;
      }
      case 'workingHours': next.workingHours = validateWorkingHours(value); break;
      case 'timezone': {
        if (value === '' || value === null) next.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        else if (typeof value === 'string' && isValidTimeZone(value)) next.timezone = value;
        else throw new CrmInputError('timezone is not a known time zone name', 'timezone');
        break;
      }
      case 'dailySlots': next.dailySlots = validateDailySlots(value); break;
      case 'lostReasons': next.lostReasons = validateLostReasons(value); break;
      case 'countryCode': {
        try { next.countryCode = parseCountryCode(value); } catch { throw new CrmInputError('countryCode must be 1 to 3 digits, e.g. +49', 'countryCode'); }
        break;
      }
      case 'emailFooter': next.emailFooter = text(value, 'emailFooter', 2_000); break;
      case 'email': {
        const e = obj(value, 'email');
        if (e.dailyCap !== undefined) next.email.dailyCap = intIn(e.dailyCap, 1, SAFE_MAX, 'dailyCap');
        if (e.gapSeconds !== undefined) next.email.gapSeconds = intIn(e.gapSeconds, 0, 86_400, 'gapSeconds');
        break;
      }
      case 'onTimeMinutes': next.onTimeMinutes = intIn(value, 0, 24 * 60, 'onTimeMinutes'); break;
      case 'smtp': next.smtp = validateSmtpConfig(value, next.smtp); break;
      default: throw new CrmInputError(`Unknown setting "${key}"`, key);
    }
  }
  return next;
}
