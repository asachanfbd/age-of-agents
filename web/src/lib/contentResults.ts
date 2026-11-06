import { PLATFORM_LABELS } from './contentRules';
import type { Platform } from './contentRules';
import { COUNT_TARGET_MAX, TARGET_FIELDS } from './contentTargets';
import type { FieldResult, FieldState, OverallResult, TargetField, Targets } from './contentTargets';
import type { InsightsDto, PlatformResultSummaryDto } from './contentTypes';
import { formatCount } from './contentStats';

/** What each target field is called; LinkedIn and X report impressions where the others report views. */
export function targetFieldLabel(platform: Platform, field: TargetField): string {
  if (field === 'views') return platform === 'linkedin' || platform === 'x' ? 'Impressions' : 'Views';
  return { likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves', engagementRate: 'Engagement rate', followersGained: 'Followers gained', views: 'Views' }[field];
}

export interface ResultBadge { label: string; /** Tailwind tone classes, the same family as the post status chips. */ tone: string; /** A glyph so the result never relies on colour alone. */ icon: string }
export const RESULT_BADGES: Record<OverallResult, ResultBadge> = {
  'on-target': { label: 'On target', tone: 'border-success/50 bg-success/15 text-success-foreground', icon: '✓' },
  partly: { label: 'Partly', tone: 'border-warning/50 bg-warning/20 text-warning-foreground', icon: '◐' },
  'below-target': { label: 'Below target', tone: 'border-destructive/50 bg-destructive/15 text-destructive', icon: '✗' },
  'too-early': { label: 'Too early', tone: 'border-info/50 bg-info/15 text-info-foreground', icon: '…' },
  'no-target': { label: 'No target', tone: 'border-border bg-muted text-muted-foreground', icon: '–' },
};

export const FIELD_STATE_WORDS: Record<FieldState, { word: string; icon: string; tone: string }> = {
  hit: { word: 'Hit', icon: '✓', tone: 'text-success-foreground' },
  missed: { word: 'Missed', icon: '✗', tone: 'text-destructive' },
  'no-data': { word: 'No data', icon: '?', tone: 'text-muted-foreground' },
};

export const formatTargetValue = (field: TargetField, value: number | null): string => (value === null ? '—' : field === 'engagementRate' ? `${value}%` : formatCount(value));

/** "Hit · Impressions 2,140 / 2,000", "Missed · Likes 12 / 50", "No data · Saves". */
export function chipText(platform: Platform, result: FieldResult): string {
  const word = FIELD_STATE_WORDS[result.state].word, label = targetFieldLabel(platform, result.field);
  return result.state === 'no-data' ? `${word} · ${label}` : `${word} · ${label} ${formatTargetValue(result.field, result.value)} / ${formatTargetValue(result.field, result.target)}`;
}

export const RESULT_FILTER_LABELS: Record<'' | OverallResult, string> = { '': 'Any result', 'on-target': 'On target', partly: 'Partly', 'below-target': 'Below target', 'too-early': 'Too early', 'no-target': 'No target' };

/** "LinkedIn: 4 of 9 judged posts on target"; null for a platform with no published post. */
export function platformSummaryLine(s: PlatformResultSummaryDto): string | null {
  const name = PLATFORM_LABELS[s.platform];
  if (s.judged > 0) return `${name}: ${s.onTarget} of ${s.judged} judged ${s.judged === 1 ? 'post' : 'posts'} on target`;
  if (s.tooEarly > 0) return `${name}: 0 judged posts yet (${s.tooEarly} too early)`;
  return s.noTarget > 0 ? `${name}: no targets set` : null;
}
export const platformSummaryLines = (summary: PlatformResultSummaryDto[]): string[] => summary.map(platformSummaryLine).filter((l): l is string => l !== null);

// ---- the Targets form --------------------------------------------------------------------------------------------

export type TargetFormValues = Record<TargetField, string>;
export const formFromTargets = (t: Targets): TargetFormValues => Object.fromEntries(TARGET_FIELDS.map((f) => [f, t[f] === null ? '' : String(t[f])])) as TargetFormValues;

/** The client's early message for a field (the server judges): empty is fine, counts are whole numbers to 10^12, the rate 0 to 100 with 2 decimals. */
export function targetFieldError(field: TargetField, text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (field === 'engagementRate') {
    return /^\d+(\.\d{1,2})?$/.test(t) && Number(t) <= 100 ? null : 'A percent from 0 to 100 with at most 2 decimals';
  }
  return /^\d+$/.test(t) && Number(t) <= COUNT_TARGET_MAX ? null : `A whole number from 0 to ${COUNT_TARGET_MAX.toLocaleString('en-US')}`;
}
export function targetFormErrors(values: TargetFormValues): Partial<Record<TargetField, string>> {
  const errors: Partial<Record<TargetField, string>> = {};
  for (const f of TARGET_FIELDS) { const e = targetFieldError(f, values[f]); if (e) errors[f] = e; }
  return errors;
}
/** The PUT body: every field, an empty one as null (a cleared field). */
export const targetBody = (values: TargetFormValues): Record<TargetField, number | null> =>
  Object.fromEntries(TARGET_FIELDS.map((f) => [f, values[f].trim() === '' ? null : Number(values[f])])) as Record<TargetField, number | null>;
export const targetsDirty = (saved: Targets, values: TargetFormValues): boolean => TARGET_FIELDS.some((f) => values[f] !== formFromTargets(saved)[f]);
export const targetsSetCount = (t: Targets): number => TARGET_FIELDS.filter((f) => t[f] !== null).length;

/** The Settings field "Judge a post after N days": whole days from 1 to 90. */
export function evaluationDaysError(text: string): string | null {
  const t = text.trim();
  return /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 90 ? null : 'Whole days from 1 to 90';
}

// ---- Insights ----------------------------------------------------------------------------------------------------

export interface DiffLine { kind: 'added' | 'removed' | 'same'; mark: '+' | '−' | ' '; text: string }
/** A line diff by longest common subsequence; added and removed lines carry a mark, not only a colour. */
export function lineDiff(before: string | null, after: string): DiffLine[] {
  const a = before === null ? [] : before.split('\n'), b = after.split('\n');
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: 'same', mark: ' ', text: a[i]! }); i++; j++; }
    else if (i < a.length && (j === b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) { out.push({ kind: 'removed', mark: '−', text: a[i]! }); i++; }
    else { out.push({ kind: 'added', mark: '+', text: b[j]! }); j++; }
  }
  return out;
}
export const diffChanged = (lines: DiffLine[]): boolean => lines.some((l) => l.kind !== 'same');

export interface InsightsViewModel {
  statusText: string;
  /** Refresh insights when false, Stop when true. */
  running: boolean;
  canRefresh: boolean;
  canEditNotes: boolean;
  failure: string | null;
  empty: boolean;
}
/** What the Insights tab shows for a state; a failed refresh keeps the document and says why. */
export function insightsViewModel(dto: InsightsDto, readOnly: boolean, timeZone: string, now = Date.now()): InsightsViewModel {
  const running = dto.state === 'running';
  const statusText = running ? 'Refreshing insights…'
    : dto.updatedAt ? `Updated ${new Date(dto.updatedAt).toLocaleString('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' })} from ${dto.postCount ?? 0} ${dto.postCount === 1 ? 'post' : 'posts'}${nextRefreshText(dto.nextRefreshAt, now) ? ` · ${nextRefreshText(dto.nextRefreshAt, now)}` : ''}`
      : 'No insights yet';
  const failure = dto.lastError ? `Last refresh failed: ${dto.lastError.reason} (${new Date(dto.lastError.at).toLocaleString('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' })})` : null;
  return { statusText, running, canRefresh: !readOnly && !running, canEditNotes: !readOnly, failure, empty: dto.markdown === '' };
}
/** "Refreshes in about 7 minutes"; null when no refresh is waiting. */
export function nextRefreshText(nextRefreshAt: string | null, now: number): string | null {
  if (!nextRefreshAt) return null;
  const minutes = Math.max(1, Math.ceil((Date.parse(nextRefreshAt) - now) / 60_000));
  return `Refreshes in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
