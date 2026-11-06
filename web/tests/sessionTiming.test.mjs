import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const { formatSessionTimespan, formatSessionDuration, sumTokenUsage, formatSessionTokens, formatSessionTokensCompact, formatTimestamp, formatTokenCount, formatCompactDuration, formatRelativeTime } =
  await import('../src/lib/sessionTiming.ts');

const usage = (patch = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
  ...patch,
});

test('formatSessionTimespan shows the date once with both times when start and end fall on the same day', () => {
  const timespan = formatSessionTimespan('2026-09-13T14:04:00.000Z', '2026-09-13T14:19:00.000Z');
  const start = new Date('2026-09-13T14:04:00.000Z');
  const end = new Date('2026-09-13T14:19:00.000Z');
  const expectedDate = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const expectedStartTime = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const expectedEndTime = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  assert.equal(timespan, `${expectedDate}, ${expectedStartTime} – ${expectedEndTime}`);
});

test('formatSessionTimespan shows each side its own date when start and end fall on different days', () => {
  // Several days apart (not just past midnight) so the "different day" assertion holds regardless
  // of the test runner's local timezone.
  const timespan = formatSessionTimespan('2026-09-10T14:04:00.000Z', '2026-09-13T09:15:00.000Z');
  const start = new Date('2026-09-10T14:04:00.000Z');
  const end = new Date('2026-09-13T09:15:00.000Z');
  const expectedStart = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const expectedEnd = `${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  assert.equal(timespan, `${expectedStart} – ${expectedEnd}`);
  assert.notEqual(start.toDateString(), end.toDateString());
});

test('formatSessionTimespan reads open-ended ("now") for a still-in-progress session', () => {
  const timespan = formatSessionTimespan('2026-09-13T14:04:00.000Z', null);
  const start = new Date('2026-09-13T14:04:00.000Z');
  const expectedStart = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  assert.equal(timespan, `${expectedStart} – now`);
});

test('formatSessionDuration reports "<1m" for a zero/near-instant session', () => {
  assert.equal(formatSessionDuration('2026-09-13T14:04:00.000Z', '2026-09-13T14:04:00.000Z'), '<1m');
  assert.equal(formatSessionDuration('2026-09-13T14:04:00.000Z', '2026-09-13T14:04:30.000Z'), '<1m');
});

test('formatSessionDuration formats whole minutes below an hour', () => {
  assert.equal(formatSessionDuration('2026-09-13T14:00:00.000Z', '2026-09-13T14:15:00.000Z'), '15m');
  assert.equal(formatSessionDuration('2026-09-13T14:00:00.000Z', '2026-09-13T14:59:00.000Z'), '59m');
});

test('formatSessionDuration rolls over the hour boundary cleanly', () => {
  assert.equal(formatSessionDuration('2026-09-13T14:00:00.000Z', '2026-09-13T15:00:00.000Z'), '1h');
  assert.equal(formatSessionDuration('2026-09-13T14:00:00.000Z', '2026-09-13T15:12:00.000Z'), '1h 12m');
  assert.equal(formatSessionDuration('2026-09-13T14:00:00.000Z', '2026-09-13T16:05:00.000Z'), '2h 5m');
});

test('formatSessionDuration measures up to "now" and appends "so far" for a still-in-progress session', () => {
  const start = '2026-09-13T14:00:00.000Z';
  const now = new Date('2026-09-13T14:12:00.000Z');
  assert.equal(formatSessionDuration(start, null, now), '12m so far');
});

test('formatSessionDuration never goes negative for a clock skew (end before start)', () => {
  assert.equal(formatSessionDuration('2026-09-13T14:10:00.000Z', '2026-09-13T14:00:00.000Z'), '<1m');
});

test('sumTokenUsage returns zeroed usage for an empty list', () => {
  assert.deepEqual(sumTokenUsage([]), usage());
});

test('sumTokenUsage adds every field across several Tasks', () => {
  const total = sumTokenUsage([
    usage({ inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 1, cacheReadInputTokens: 2, totalCostUsd: 0.5 }),
    usage({ inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 3, totalCostUsd: 0.25 }),
  ]);
  assert.deepEqual(total, usage({ inputTokens: 15, outputTokens: 20, cacheCreationInputTokens: 1, cacheReadInputTokens: 5, totalCostUsd: 0.75 }));
});

test('sumTokenUsage treats a missing/null entry (a Task record predating token tracking) as zero rather than throwing', () => {
  const total = sumTokenUsage([usage({ inputTokens: 10, totalCostUsd: 0.5 }), null, undefined]);
  assert.deepEqual(total, usage({ inputTokens: 10, totalCostUsd: 0.5 }));
});

test('formatSessionTokens omits the segment for undefined/null usage', () => {
  assert.equal(formatSessionTokens(undefined), null);
  assert.equal(formatSessionTokens(null), null);
});

test('formatSessionTokens omits the segment for an all-zero usage (predates tracking, or used none)', () => {
  assert.equal(formatSessionTokens(usage()), null);
});

test('formatSessionTokens formats a non-zero total with the footer\'s own convention', () => {
  const total = usage({ inputTokens: 1000, outputTokens: 2345, cacheCreationInputTokens: 100, cacheReadInputTokens: 55 });
  assert.equal(formatSessionTokens(total), `${(1000 + 2345 + 100 + 55).toLocaleString()} tokens`);
});

test('formatSessionTokensCompact omits the segment for undefined/null/all-zero usage', () => {
  assert.equal(formatSessionTokensCompact(undefined), null);
  assert.equal(formatSessionTokensCompact(null), null);
  assert.equal(formatSessionTokensCompact(usage()), null);
});

test('formatSessionTokensCompact shows the exact number below 1,000', () => {
  assert.equal(formatSessionTokensCompact(usage({ inputTokens: 744 })), '744 tokens');
});

test('formatSessionTokensCompact abbreviates thousands to one decimal, dropping a trailing ".0"', () => {
  assert.equal(formatSessionTokensCompact(usage({ inputTokens: 744407 })), '744.4k tokens');
  assert.equal(formatSessionTokensCompact(usage({ inputTokens: 1500 })), '1.5k tokens');
  assert.equal(formatSessionTokensCompact(usage({ inputTokens: 12000 })), '12k tokens');
});

test('formatSessionTokensCompact abbreviates millions to one decimal, dropping a trailing ".0"', () => {
  assert.equal(formatSessionTokensCompact(usage({ inputTokens: 2261027 })), '2.3M tokens');
  assert.equal(formatSessionTokensCompact(usage({ inputTokens: 3000000 })), '3M tokens');
});

test('formatTimestamp formats a single instant the same way formatSessionTimespan formats one side of a range', () => {
  const iso = '2026-09-13T14:04:00.000Z';
  const timestamp = formatTimestamp(iso);
  // Same-day start/end collapses formatSessionTimespan to "<date>, <time> – <time>" — the date prefix
  // and first time should be exactly what formatTimestamp produces for that same instant.
  const timespan = formatSessionTimespan(iso, iso);
  const [datePart, timesPart] = timespan.split(', ');
  const [firstTime] = timesPart.split(' – ');
  assert.equal(timestamp, `${datePart}, ${firstTime}`);
});

test('formatTokenCount is exact below 1,000 and abbreviates to one decimal above', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(31400), '31.4k');
  assert.equal(formatTokenCount(184300), '184.3k');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(2_261_027), '2.3M');
});

test('formatCompactDuration with seconds keeps them under an hour, and reads like the plain format from an hour up', () => {
  assert.equal(formatCompactDuration(0, { seconds: true }), '<1s');
  assert.equal(formatCompactDuration(45_000, { seconds: true }), '45s');
  assert.equal(formatCompactDuration(45_999, { seconds: true }), '45s');
  assert.equal(formatCompactDuration(130_000, { seconds: true }), '2m 10s');
  assert.equal(formatCompactDuration(120_000, { seconds: true }), '2m');
  assert.equal(formatCompactDuration(3_599_000, { seconds: true }), '59m 59s');
  assert.equal(formatCompactDuration(65 * 60_000 + 30_000, { seconds: true }), '1h 6m');
  assert.equal(formatCompactDuration(65 * 60_000, { seconds: true }), '1h 5m');
});

test('formatCompactDuration never reads as a bare zero and rolls minutes into hours', () => {
  assert.equal(formatCompactDuration(0), '<1m');
  assert.equal(formatCompactDuration(59_000), '<1m');
  assert.equal(formatCompactDuration(41 * 60_000), '41m');
  assert.equal(formatCompactDuration(60 * 60_000), '1h');
  assert.equal(formatCompactDuration((3 * 60 + 26) * 60_000), '3h 26m');
});

test('formatRelativeTime reads as just now, minutes, hours, yesterday, days, then a date', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const minute = 60_000;
  assert.equal(formatRelativeTime(ago(20_000), now), 'just now');
  assert.equal(formatRelativeTime(ago(25 * minute), now), '25m ago');
  assert.equal(formatRelativeTime(ago(59 * minute), now), '59m ago');
  assert.equal(formatRelativeTime(ago(60 * minute), now), '1h ago');
  assert.equal(formatRelativeTime(ago(23 * 60 * minute), now), '23h ago');
  assert.equal(formatRelativeTime(ago(24 * 60 * minute), now), 'yesterday');
  assert.equal(formatRelativeTime(ago(47 * 60 * minute), now), 'yesterday');
  assert.equal(formatRelativeTime(ago(3 * 24 * 60 * minute), now), '3d ago');
  assert.match(formatRelativeTime(ago(45 * 24 * 60 * minute), now), /2026/);
});

test('formatRelativeTime reads a future time (clock skew) forward instead of clamping it', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  assert.equal(formatRelativeTime('2026-09-21T12:30:00.000Z', now), 'in 30m');
});
