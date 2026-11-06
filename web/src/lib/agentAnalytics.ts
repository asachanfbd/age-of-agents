import { formatCompactDuration } from './sessionTiming';
import type {
  ActivityKind, ActivityView, AgentDayView, AnalyticsCheckStatus, AnalyticsHistoryStatus, CapacityState, ComparisonMetric, CurrentCapacity,
  DecreaseUnavailableReason, DecreaseView, GapReason, MetricComparison, QuotaWindowKey, SeriesPoint, StepRoundRow, UsageFailureReason, WindowSeries,
} from './serverApi';

/**
 * Pure view-model functions for the Agent Analytics view (`ui/analytics/`). The view shows one local
 * calendar day at a time. Remaining capacity is always shown with the provider's used percentage
 * beside it, and an observed quota decrease is always worded as an estimate, never as tokens.
 */

/** Marks the footer item that opens an agent's Analytics, by agent id; focus returns to it when the view closes. */
export const ANALYTICS_TRIGGER_ATTRIBUTE = 'data-analytics-trigger';

export const WINDOW_LABEL: Record<QuotaWindowKey, string> = { fiveHour: '5h', sevenDay: '7d' };
export const QUOTA_WINDOWS: readonly QuotaWindowKey[] = ['fiveHour', 'sevenDay'];

// ---- Days ----

export interface TimeRange { from: number; to: number }

export function startOfLocalDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The local day `days` away. Built from calendar fields, so a 23- or 25-hour day still lands on midnight. */
export function shiftDay(dayStart: number, days: number): number {
  const date = new Date(dayStart);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

export function dayRange(dayStart: number): TimeRange {
  return { from: dayStart, to: shiftDay(dayStart, 1) };
}

/** What the date switcher allows: nothing after today, nothing before the oldest retained day. */
export function daySwitcher(dayStart: number, now: number, earliestAt: number): { isToday: boolean; canPrevious: boolean; canNext: boolean; oldestDay: number; today: number } {
  const today = startOfLocalDay(now);
  const oldestDay = Math.min(today, startOfLocalDay(earliestAt));
  return { isToday: dayStart === today, canPrevious: dayStart > oldestDay, canNext: dayStart < today, oldestDay, today };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** A day as a date input's value. */
export function dateInputValue(dayStart: number): string {
  const date = new Date(dayStart);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A date input's value as that local day, kept inside `[oldestDay, today]`; null when it is not a date. */
export function parseDateInput(value: string, oldestDay: number, today: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(day) ? Math.min(today, Math.max(oldestDay, day)) : null;
}

export function formatDayTitle(dayStart: number): string {
  return new Date(dayStart).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** "14:05", in local time. */
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "7 Oct, 14:05", in local time. */
export function formatDateTime(at: number): string {
  return `${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${formatClock(at)}`;
}

/** A percentage with at most one decimal: "78%", "77.6%". */
export function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

/** Percentage points with at most one decimal: "3 pts", "0.5 pts". */
export function formatPoints(value: number): string {
  return `${Math.round(value * 10) / 10} pts`;
}

/** Remaining first, with the provider's used figure beside it so the two are never confused. */
export function remainingText(remaining: number, used: number): string {
  return `${formatPercent(remaining)} remaining (${formatPercent(used)} used)`;
}

// ---- Current capacity tiles ----

const STATE_HEADLINE: Record<Exclude<CapacityState, 'measured' | 'stale' | 'failed'>, string> = {
  expired: 'Awaiting a reading after reset',
  unavailable: 'Unavailable',
  awaiting: 'Awaiting first reading',
};

export interface CapacityTile {
  state: CapacityState;
  headline: string;
  detail: string;
  /** 0–100 for the meter; null when there is no measured value to draw. */
  meter: number | null;
}

/** One window's tile. A window with no measured value says why in words and never shows a percentage. */
export function capacityTile(current: CurrentCapacity): CapacityTile {
  const { state } = current;
  if (state === 'expired') {
    return { state, headline: STATE_HEADLINE.expired, detail: `The window reset ${formatDateTime(current.resetsAt!)}; no reading since`, meter: null };
  }
  if (state === 'unavailable') {
    return { state, headline: STATE_HEADLINE.unavailable, detail: `The provider did not report this window at ${formatDateTime(current.observedAt!)}`, meter: null };
  }
  if (state === 'awaiting') return { state, headline: STATE_HEADLINE.awaiting, detail: 'History starts with the first successful check', meter: null };
  const observed = formatDateTime(current.observedAt!);
  const reset = current.resetsAt === null ? 'reset time unknown' : `resets ${formatDateTime(current.resetsAt)}`;
  const detail = state === 'failed' ? `Last check failed · last successful reading ${observed} · ${reset}`
    : state === 'stale' ? `Last reading ${observed}, nothing newer · ${reset}`
    : `Observed ${observed} · ${reset}`;
  return { state, headline: remainingText(current.remaining!, current.used!), detail, meter: current.remaining };
}

// ---- Chart geometry ----

/** Time to x: the range's start is the left edge, its end the right edge. */
export function timeToX(at: number, range: TimeRange, width: number): number {
  return (at - range.from) / (range.to - range.from) * width;
}

/** Remaining to y: 100% is the top edge, 0% the bottom. */
export function remainingToY(remaining: number, height: number): number {
  return (100 - remaining) / 100 * height;
}

export interface PlottedPoint { x: number; y: number; point: SeriesPoint }

/**
 * A window's line as one path per segment, so nothing is drawn across a gap or a reset. A segment of
 * one reading has no path, only its point. Readings after `now` are not drawn.
 */
export function linePaths(series: WindowSeries, range: TimeRange, width: number, height: number, now: number): { paths: string[]; points: PlottedPoint[] } {
  const points = series.points.filter((point) => point.at <= now)
    .map((point) => ({ x: timeToX(point.at, range, width), y: remainingToY(point.remaining, height), point }));
  const bySegment = new Map<number, PlottedPoint[]>();
  for (const plotted of points) bySegment.set(plotted.point.segment, [...(bySegment.get(plotted.point.segment) ?? []), plotted]);
  const paths = [...bySegment.values()].filter((segment) => segment.length > 1)
    .map((segment) => segment.map(({ x, y }, index) => `${index ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' '));
  return { paths, points };
}

/** Where "Now" falls on the day shown; null on any day but today. */
export function nowMarkerX(now: number, range: TimeRange, width: number): number | null {
  return now >= range.from && now < range.to ? timeToX(now, range, width) : null;
}

const GAP_TEXT: Record<GapReason, string> = {
  'no-readings': 'No readings',
  'check-failed': 'Check failed',
  'window-unavailable': 'Window unavailable',
};

export function gapText(reason: GapReason): string {
  return GAP_TEXT[reason];
}

// ---- Day summary ----

/** One line under the date switcher: the day's lowest 5h remaining, resets, tracked sessions and unattributed activity. */
export function daySummary(view: Pick<AgentDayView, 'series' | 'activities' | 'unattributed'>): string {
  const points = view.series.fiveHour.points;
  const lowest = points.reduce<SeriesPoint | null>((low, point) => !low || point.remaining < low.remaining ? point : low, null);
  const resets = view.series.fiveHour.resets.length + view.series.sevenDay.resets.length;
  const sessions = view.activities.length;
  return [
    lowest ? `Lowest 5h remaining ${formatPercent(lowest.remaining)} at ${formatClock(lowest.at)}` : 'No 5h readings',
    `${resets} ${resets === 1 ? 'reset' : 'resets'}`,
    `${sessions} tracked ${sessions === 1 ? 'session' : 'sessions'}`,
    view.unattributed.length ? 'Unattributed activity seen' : 'No unattributed activity',
  ].join(' · ');
}

// ---- Activity lanes ----

/**
 * A lane for every activity: ones that overlap in time get different lanes, ones that do not reuse a
 * lane. Placed in start order, so adding a later activity never moves an earlier one.
 */
export function assignLanes(activities: Pick<ActivityView, 'id' | 'startedAt' | 'endedAt'>[], now: number): Map<string, number> {
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  const ordered = [...activities].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const activity of ordered) {
    let lane = laneEnds.findIndex((end) => end <= activity.startedAt);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = activity.endedAt ?? Math.max(now, activity.startedAt);
    lanes.set(activity.id, lane);
  }
  return lanes;
}

export interface BandPart { x: number; width: number; state: 'active' | 'waiting' }
export interface Band {
  x: number;
  width: number;
  /** The session started before, or ran past, the day shown. Its label still gives the real start and end. */
  clippedStart: boolean;
  clippedEnd: boolean;
  live: boolean;
  parts: BandPart[];
}

/** An activity's band on the day shown, clipped to the day; null when none of it falls in the day. */
export function activityBand(activity: Pick<ActivityView, 'startedAt' | 'endedAt' | 'segments'>, range: TimeRange, now: number, width: number): Band | null {
  const live = activity.endedAt === null;
  const end = activity.endedAt ?? now;
  const from = Math.max(activity.startedAt, range.from);
  const to = Math.min(end, range.to);
  if (to < from) return null;
  const span = (start: number, finish: number) => ({ x: timeToX(start, range, width), width: Math.max(0, timeToX(finish, range, width) - timeToX(start, range, width)) });
  const parts = activity.segments.flatMap((segment): BandPart[] => {
    const start = Math.max(segment.start, range.from);
    const finish = Math.min(segment.end ?? now, range.to);
    return finish > start ? [{ ...span(start, finish), state: segment.state }] : [];
  });
  return { ...span(from, to), clippedStart: activity.startedAt < range.from, clippedEnd: end > range.to, live, parts };
}

const KIND_LABEL: Record<ActivityKind, string> = { coding: 'Coding', planning: 'Planning', background: 'App background work' };

export function activityKindLabel(kind: ActivityKind): string {
  return KIND_LABEL[kind];
}

export type BandTexture = 'solid' | 'striped' | 'dotted';
const KIND_TEXTURE: Record<ActivityKind, BandTexture> = { coding: 'solid', planning: 'striped', background: 'dotted' };

/** How a band is drawn: a colour and a texture per kind, so kinds stay distinct without relying on colour alone. */
export function bandStyle(activity: Pick<ActivityView, 'kind' | 'approximate'>): { colorVar: string; texture: BandTexture; approximate: boolean } {
  return { colorVar: `--analytics-${activity.kind}`, texture: KIND_TEXTURE[activity.kind], approximate: activity.approximate };
}

const DECREASE_REASON: Record<DecreaseUnavailableReason, string> = {
  'missing-boundary-reading': 'missing boundary reading',
  reset: 'the window reset during it',
  gap: 'readings are missing during it',
  'in-progress': 'still in progress',
};

/**
 * An observed decrease in words. It is always an account-wide estimate; when other tracked sessions
 * were working at the same time it is shared and never divided between them.
 */
export function decreaseText(decrease: DecreaseView): string {
  if (!decrease.available) return `Unavailable — ${DECREASE_REASON[decrease.reason]}`;
  const observed = `observed ${formatPoints(decrease.points)} (estimate)`;
  if (!decrease.sharedWith) return observed;
  return `${observed} · Shared with ${decrease.sharedWith} overlapping ${decrease.sharedWith === 1 ? 'session' : 'sessions'} — not divided`;
}

function activeTimeText(activity: Pick<ActivityView, 'activeMs' | 'endedAt' | 'approximate'>): string {
  const duration = formatCompactDuration(activity.activeMs, { seconds: true });
  return activity.endedAt === null ? `${duration} so far` : activity.approximate ? `approx. ${duration}` : duration;
}

function endText(activity: Pick<ActivityView, 'endedAt' | 'approximate'>): string {
  if (activity.endedAt === null) return 'Still running';
  return `${formatDateTime(activity.endedAt)}${activity.approximate ? ' (approximate)' : ''}`;
}

/** The hover box's rows for one activity. */
export function activityDetails(activity: ActivityView): { label: string; value: string }[] {
  return [
    { label: 'Project', value: activity.projectName ?? 'Unknown project' },
    { label: 'Task', value: activity.label },
    { label: 'Agent', value: activity.agentLabel },
    { label: 'Kind', value: activityKindLabel(activity.kind) },
    ...(activity.workflow ? [
      { label: 'Step', value: `${activity.workflow.stepName} (${activity.workflow.name})` },
      { label: 'Round', value: activity.workflow.round === null ? 'Unknown' : String(activity.workflow.round) },
    ] : []),
    { label: 'Started', value: formatDateTime(activity.startedAt) },
    { label: 'Ended', value: endText(activity) },
    { label: 'Active time', value: activeTimeText(activity) },
    { label: '5h decrease', value: decreaseText(activity.decrease.fiveHour) },
    { label: '7d decrease', value: decreaseText(activity.decrease.sevenDay) },
  ];
}

/** What selecting a band does: open the task, or nothing for deleted work. */
export function activityAction(activity: Pick<ActivityView, 'target' | 'deleted'>): string {
  if (activity.deleted) return 'This task was deleted; there is nothing to open.';
  return activity.target ? 'Select to open the task.' : 'This work can no longer be opened.';
}

/** A band's accessible name: everything the hover box says, in one sentence. */
export function activityAriaLabel(activity: ActivityView): string {
  return `${activityDetails(activity).map(({ label, value }) => `${label}: ${value}`).join('. ')}. ${activityAction(activity)}`;
}

/** A band's visible caption: the step and round for a workflow round, the task's name otherwise. */
export function bandCaption(activity: Pick<ActivityView, 'label' | 'workflow'>): string {
  if (!activity.workflow) return activity.label;
  const round = activity.workflow.round === null ? '' : ` r${activity.workflow.round}`;
  return `${activity.workflow.stepName}${round} · ${activity.label}`;
}

// ---- Readings: keyboard stepping and the chronological table ----

/** Readings moved per Page Up / Page Down: about an hour at one reading every five minutes. */
const PAGE_STEP = 12;

/** The keys that move between readings on the plot. */
export const READING_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];

/** The reading index after a key press on the plot (-1: none in focus yet); unchanged for any other key. Stops at both ends. */
export function stepReadingIndex(index: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (!READING_KEYS.includes(key)) return index;
  const moves: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, PageUp: index - PAGE_STEP, PageDown: index + PAGE_STEP, Home: 0, End: count - 1 };
  return Math.min(count - 1, Math.max(0, moves[key]!));
}

function resetText(resetsAt: number | null): string {
  return resetsAt === null ? 'reset time unknown' : `resets ${formatDateTime(resetsAt)}`;
}

/** What is announced for a focused reading: the window, the exact percentage, the time and the reset. */
export function readingAnnouncement(window: QuotaWindowKey, point: SeriesPoint): string {
  return `${WINDOW_LABEL[window]}: ${remainingText(point.remaining, point.used)} at ${formatClock(point.at)}, ${resetText(point.resetsAt)}`;
}

export interface ReadingRow {
  at: number;
  kind: 'reading' | 'reset' | 'gap';
  /** "Reading", "5h reset", "7d gap", and so on. */
  event: string;
  fiveHour: string;
  sevenDay: string;
}

const KIND_ORDER: Record<ReadingRow['kind'], number> = { gap: 0, reset: 1, reading: 2 };

/**
 * Every value the chart shows, in time order: one row per reading with both windows, plus a row for
 * each reset and each gap. This is the chart for anyone not using colour or a pointer.
 */
export function readingRows(series: Record<QuotaWindowKey, WindowSeries>): ReadingRow[] {
  const cell = (point: SeriesPoint | undefined) => point ? `${remainingText(point.remaining, point.used)}, ${resetText(point.resetsAt)}` : 'Unavailable';
  const times = [...new Set(QUOTA_WINDOWS.flatMap((window) => series[window].points.map((point) => point.at)))];
  const readings = times.map((at): ReadingRow => ({
    at, kind: 'reading', event: 'Reading',
    fiveHour: cell(series.fiveHour.points.find((point) => point.at === at)),
    sevenDay: cell(series.sevenDay.points.find((point) => point.at === at)),
  }));
  const marks = QUOTA_WINDOWS.flatMap((window): ReadingRow[] => {
    const own = (text: string) => ({ fiveHour: window === 'fiveHour' ? text : '', sevenDay: window === 'sevenDay' ? text : '' });
    return [
      ...series[window].resets.map((reset): ReadingRow => ({
        at: reset.at, kind: 'reset', event: `${WINDOW_LABEL[window]} reset`,
        ...own(`Replenished: ${formatPercent(reset.before)} → ${formatPercent(reset.after)} remaining`),
      })),
      ...series[window].gaps.map((gap): ReadingRow => ({
        at: gap.from, kind: 'gap', event: `${WINDOW_LABEL[window]} gap`,
        ...own(`${gapText(gap.reason)} until ${formatDateTime(gap.to)}`),
      })),
    ];
  });
  return [...readings, ...marks].sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

// ---- Step comparison ----

export const METRIC_LABEL: Record<ComparisonMetric, string> = {
  activeDuration: 'Active duration',
  tokens: 'Tokens',
  fiveHourDecrease: '5h decrease',
  sevenDayDecrease: '7d decrease',
};

export function metricValueText(metric: ComparisonMetric, value: number): string {
  if (metric === 'activeDuration') return formatCompactDuration(value, { seconds: true });
  if (metric === 'tokens') return Math.round(value).toLocaleString('en-US');
  return formatPoints(value);
}

/** The exact token total with its categories, or "Unavailable". Never "0" for a round with no usage evidence. */
export function tokenCell(tokens: StepRoundRow['tokens']): { text: string; detail: string | null } {
  if (!tokens) return { text: 'Unavailable', detail: null };
  const { counts } = tokens;
  const count = (value: number) => value.toLocaleString('en-US');
  return {
    text: `${count(tokens.total)}${tokens.partial ? ' (partial)' : ''}`,
    detail: `input ${count(counts.inputTokens)} · output ${count(counts.outputTokens)} · cache write ${count(counts.cacheCreationInputTokens)} · cache read ${count(counts.cacheReadInputTokens)}`,
  };
}

/** A round's active duration: "so far" while it runs, "approx." when working and waiting time could not be separated. */
export function durationCell(duration: StepRoundRow['duration']): string {
  if (duration.ms === null) return 'Unavailable';
  const text = formatCompactDuration(duration.ms, { seconds: true });
  return duration.live ? `${text} so far` : duration.approximate ? `approx. ${text}` : text;
}

/** The median and how many earlier rounds it comes from, or "Not enough history" below the minimum. */
export function medianCell(metric: ComparisonMetric, comparison: MetricComparison): string {
  const prior = `${comparison.samples} prior`;
  if (!comparison.enoughHistory || comparison.median === null) return `Not enough history (${prior})`;
  return `median ${metricValueText(metric, comparison.median)} · ${prior}`;
}

/** Each metric that marked the round, with the round's value against the median. */
export function highUsageNotes(row: Pick<StepRoundRow, 'highUsage' | 'comparison'>): string[] {
  return row.highUsage.map((metric) => {
    const { value, median } = row.comparison[metric];
    const multiple = Math.round(value! / median! * 10) / 10;
    return `${METRIC_LABEL[metric]}: ${metricValueText(metric, value!)} is ${multiple}× the median ${metricValueText(metric, median!)}`;
  });
}

export type RoundSortKey = ComparisonMetric | 'startedAt';

/** Rows ordered by a metric. Rounds where the metric is unavailable come last whichever way the sort runs. */
export function sortRounds(rows: StepRoundRow[], key: RoundSortKey, direction: 'asc' | 'desc'): StepRoundRow[] {
  const valueOf = (row: StepRoundRow) => key === 'startedAt' ? row.startedAt : row.comparison[key].value;
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const [left, right] = [valueOf(a), valueOf(b)];
    if (left === null || right === null) return Number(left === null) - Number(right === null);
    return sign * (left - right);
  });
}

export function onlyHighUsage(rows: StepRoundRow[]): StepRoundRow[] {
  return rows.filter((row) => row.highUsage.length > 0);
}

// ---- Refresh and history status ----

const FAILURE_TEXT: Record<UsageFailureReason, string> = {
  'no-access': 'no account access',
  'provider-error': 'the provider could not be reached',
};

export type RefreshPhase = 'idle' | 'refreshing' | 'refreshed' | 'not-eligible' | 'failed';

/** The status line beside Refresh: what the last check did, when the last good reading is from, and when another check may run. */
export function refreshStatusText(phase: RefreshPhase, check: AnalyticsCheckStatus | null, history: AnalyticsHistoryStatus | null): string {
  const lastGood = check?.lastSuccessAt != null ? `last successful check ${formatDateTime(check.lastSuccessAt)}` : 'no successful check yet';
  const next = check?.nextEligibleAt != null ? ` · next check eligible at ${formatClock(check.nextEligibleAt)}` : '';
  const parts: string[] = [];
  if (phase === 'refreshing') parts.push('Checking the provider…');
  else if (check?.lastFailure) parts.push(`Check failed (${FAILURE_TEXT[check.lastFailure.reason]}) · ${lastGood}${next}`);
  else if (phase === 'not-eligible') parts.push(`Not checked: the provider allows another check later · ${lastGood}${next}`);
  else if (phase === 'refreshed') parts.push(`Refreshed · ${lastGood}`);
  else parts.push(`${lastGood[0]!.toUpperCase()}${lastGood.slice(1)} · checks run about every 5 minutes`);
  if (history?.saveError) parts.push(history.saveError);
  if (history?.loadError) parts.push(history.loadError);
  return parts.join(' · ');
}
