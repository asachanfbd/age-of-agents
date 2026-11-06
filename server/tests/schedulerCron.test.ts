import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidTimezone, latestMissedRun, localDay, nextRun, parseCron, resolveTimezone, upcomingRuns } from '../src/scheduler/cron.ts';
import type { CronSchedule } from '../src/scheduler/cron.ts';

const cron = (expression: string): CronSchedule => {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.schedule;
};
const at = (text: string): number => Date.parse(text);
const iso = (instant: number | null): string | null => (instant === null ? null : new Date(instant).toISOString());
const next = (expression: string, from: string, timezone: string) => iso(nextRun(cron(expression), at(from), timezone));
const upcoming = (expression: string, from: string, timezone: string, count: number) => upcomingRuns(cron(expression), at(from), timezone, count).map(iso);
const fields = (expression: string) => {
  const s = cron(expression);
  return [s.minutes, s.hours, s.daysOfMonth, s.months, s.daysOfWeek].map((set) => [...set].sort((a, b) => a - b));
};

// Sun 11 Oct 2026 11:20 Asia/Kolkata.
const MOCKUP_NOW = '2026-10-11T05:50:00Z';

test('UC01 a weekly Monday 09:00 job from Sunday 11:20 Asia/Kolkata runs Monday 09:00 local', () => {
  assert.equal(next('0 9 * * 1', MOCKUP_NOW, 'Asia/Kolkata'), '2026-10-12T03:30:00.000Z');
});

test('UC02 lists, ranges and steps give the expected next three times', () => {
  assert.deepEqual(upcoming('*/15 9-17 * * 1-5', '2026-10-09T17:40:00Z', 'UTC', 3), ['2026-10-09T17:45:00.000Z', '2026-10-12T09:00:00.000Z', '2026-10-12T09:15:00.000Z']);
  assert.deepEqual(upcoming('0 10 */3 * *', '2026-10-11T00:00:00Z', 'UTC', 3), ['2026-10-13T10:00:00.000Z', '2026-10-16T10:00:00.000Z', '2026-10-19T10:00:00.000Z']);
  assert.deepEqual(fields('5/20 1,3 * * *').slice(0, 2), [[5, 25, 45], [1, 3]], 'a start with a step runs to the end of the field');
});

test('UC03 month and weekday names in any case equal their numbers', () => {
  assert.deepEqual(fields('0 9 * JAN,jul Mon-FRI'), fields('0 9 * 1,7 1-5'));
});

test('UC04 weekday 0 and 7 both mean Sunday', () => {
  assert.deepEqual(fields('0 0 * * 7')[4], [0]);
  assert.deepEqual(fields('0 0 * * 0')[4], [0]);
  assert.equal(next('0 0 * * 7', MOCKUP_NOW, 'UTC'), '2026-10-18T00:00:00.000Z');
});

test('UC05 with both day fields set, a day matching either one runs', () => {
  // Tuesday the 13th matches the day of month; Fridays the 16th and 23rd match the weekday.
  assert.deepEqual(upcoming('0 0 13 * 5', '2026-10-11T00:00:00Z', 'UTC', 3), ['2026-10-13T00:00:00.000Z', '2026-10-16T00:00:00.000Z', '2026-10-23T00:00:00.000Z']);
  assert.equal(next('0 0 13 * *', '2026-10-13T00:00:00Z', 'UTC'), '2026-11-13T00:00:00.000Z', 'an unrestricted weekday does not widen the day of month');
  assert.equal(next('0 0 * * 5', '2026-10-11T00:00:00Z', 'UTC'), '2026-10-16T00:00:00.000Z');
});

test('UC06 the five @ macros, in any case, equal their five-field forms', () => {
  const pairs = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *' };
  for (const [macro, expression] of Object.entries(pairs)) {
    assert.deepEqual(fields(macro), fields(expression), macro);
    assert.deepEqual(fields(macro.toUpperCase()), fields(expression), macro.toUpperCase());
    assert.equal(cron(` ${macro.toUpperCase()} `).expression, macro);
  }
});

test('UC07 leading, trailing and repeated spaces or tabs are accepted and normalised', () => {
  assert.equal(cron('  0\t9   *  * \t1  ').expression, '0 9 * * 1');
});

test('UC08 invalid expressions are refused, each naming the problem', () => {
  const refused: [string, RegExp][] = [
    ['* * * *', /5 fields.*has 4/], ['* * * * * *', /5 fields.*has 6/], ['', /empty/], ['   ', /empty/],
    ['@reboot', /@reboot/], ['@annually', /@annually/], ['0 0 * FOO *', /month "FOO"/],
    ['60 * * * *', /minute "60"/], ['* 24 * * *', /hour "24"/], ['* * 0 * *', /day of month "0"/], ['* * 32 * *', /day of month "32"/],
    ['* * * 0 *', /month "0"/], ['* * * 13 *', /month "13"/], ['* * * * 8', /day of week "8"/],
    ['*/0 * * * *', /minute step "0"/], ['5-1 * * * *', /minute range "5-1"/], ['-1 * * * *', /minute/], ['1.5 * * * *', /minute "1.5"/],
    ['12345678901234567890 * * * *', /minute/], ['? * * * *', /minute "\?"/], ['* * L * *', /day of month "L"/],
    ['* * 1W * *', /day of month "1W"/], ['* * * * 1#2', /day of week "1#2"/], ['1,,2 * * * *', /minute/], ['1/2/3 * * * *', /minute/], ['1- * * * *', /minute/],
  ];
  for (const [expression, problem] of refused) {
    const parsed = parseCron(expression);
    assert.equal(parsed.ok, false, expression);
    if (!parsed.ok) {
      assert.match(parsed.error, /cron/i, expression);
      assert.match(parsed.error, problem, expression);
    }
  }
  for (const notText of [undefined, null, 5, {}]) assert.equal(parseCron(notText).ok, false);
});

test('UC09 an expression that never matches ends the search with no next run', () => {
  assert.equal(next('0 0 30 2 *', MOCKUP_NOW, 'UTC'), null);
  assert.deepEqual(upcoming('0 0 30 2 *', MOCKUP_NOW, 'UTC', 3), []);
});

test('UC10 29 February from October 2026 is 29 February 2028', () => {
  assert.equal(next('0 0 29 2 *', MOCKUP_NOW, 'UTC'), '2028-02-29T00:00:00.000Z');
});

test('UC11 the 31st skips months with fewer days', () => {
  assert.deepEqual(upcoming('0 0 31 * *', '2026-10-31T00:00:00Z', 'UTC', 3), ['2026-12-31T00:00:00.000Z', '2027-01-31T00:00:00.000Z', '2027-03-31T00:00:00.000Z']);
});

test('UC12 the next run is strictly after the starting instant', () => {
  assert.equal(next('0 9 * * 1', '2026-10-12T09:00:00.000Z', 'UTC'), '2026-10-19T09:00:00.000Z');
  assert.equal(next('0 9 * * 1', '2026-10-12T08:59:59.999Z', 'UTC'), '2026-10-12T09:00:00.000Z');
});

test('UC13 one expression gives a different instant in each timezone', () => {
  const zones = ['UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/New_York'];
  assert.deepEqual(zones.map((zone) => next('0 9 * * *', '2026-10-11T12:00:00Z', zone)), [
    '2026-10-12T09:00:00.000Z', '2026-10-12T03:30:00.000Z', '2026-10-12T03:15:00.000Z', '2026-10-11T13:00:00.000Z',
  ]);
});

test('UC14 a local time the clocks skip runs once right after the jump, then at its normal time the next day', () => {
  assert.deepEqual(upcoming('30 2 * * *', '2027-03-13T12:00:00Z', 'America/New_York', 2), ['2027-03-14T07:00:00.000Z', '2027-03-15T06:30:00.000Z']);
});

test('UC15 a gap hiding four slots gives one run, not four', () => {
  assert.deepEqual(upcoming('*/15 2 * * *', '2027-03-14T06:50:00Z', 'America/New_York', 2), ['2027-03-14T07:00:00.000Z', '2027-03-15T06:00:00.000Z']);
});

test('UC16 a local time that happens twice runs on its first occurrence only', () => {
  assert.deepEqual(upcoming('30 1 * * *', '2026-10-31T12:00:00Z', 'America/New_York', 2), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  assert.equal(next('30 1 * * *', '2026-11-01T06:10:00Z', 'America/New_York'), '2026-11-02T06:30:00.000Z', 'starting inside the second pass does not run it again');
});

test('UC17 an hourly job runs 01:00 once in the repeated hour; the next run is 02:00', () => {
  assert.deepEqual(upcoming('0 * * * *', '2026-11-01T04:30:00Z', 'America/New_York', 2), ['2026-11-01T05:00:00.000Z', '2026-11-01T07:00:00.000Z']);
});

test('UC18 an hourly job across a gap runs 01:00 then 03:00, and 03:00 only once', () => {
  assert.deepEqual(upcoming('0 * * * *', '2027-03-14T05:30:00Z', 'America/New_York', 3), ['2027-03-14T06:00:00.000Z', '2027-03-14T07:00:00.000Z', '2027-03-14T08:00:00.000Z']);
});

test('UC19 a half-hour shift (Lord Howe) runs a skipped 02:15 once right after the jump', () => {
  assert.deepEqual(upcoming('15 2 * * *', '2027-10-02T00:00:00Z', 'Australia/Lord_Howe', 2), ['2027-10-02T15:30:00.000Z', '2027-10-03T15:15:00.000Z']);
});

test('UC20 a timezone must be an IANA name or UTC', () => {
  for (const good of ['UTC', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) assert.equal(isValidTimezone(good), true, good);
  for (const bad of ['Mars/Olympus', '', 'utc', '+05:30', 'EST', 5, null, undefined, {}]) assert.equal(isValidTimezone(bad), false, String(bad));
});

test('UC21 an absent or null timezone is the host timezone', () => {
  assert.equal(resolveTimezone(undefined, 'Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(resolveTimezone(null, 'Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(resolveTimezone('UTC', 'Asia/Kolkata'), 'UTC');
});

test('UC22 the earliest and the largest dates give a valid instant or null, never a throw', () => {
  assert.equal(iso(nextRun(cron('* * * * *'), 0, 'UTC')), '1970-01-01T00:01:00.000Z');
  assert.equal(iso(nextRun(cron('0 0 * * *'), 0, 'America/New_York')), '1970-01-01T05:00:00.000Z');
  for (const from of [8.64e15, 8.64e15 - 1000, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(nextRun(cron('* * * * *'), from, 'UTC'), null);
});

test('UC23 the preview gives three ascending, distinct instants', () => {
  const runs = upcomingRuns(cron('0 9 * * 1'), at(MOCKUP_NOW), 'Asia/Kolkata', 3);
  assert.deepEqual(runs.map(iso), ['2026-10-12T03:30:00.000Z', '2026-10-19T03:30:00.000Z', '2026-10-26T03:30:00.000Z']);
  assert.equal(new Set(runs).size, 3);
});

test('UC24 the latest missed slot between two instants, found without visiting every slot', () => {
  assert.equal(latestMissedRun(cron('0 9 * * *'), at('2026-10-11T09:00:00Z'), at('2026-10-11T20:00:00Z'), 'UTC'), null, 'nothing missed');
  assert.equal(iso(latestMissedRun(cron('0 9 * * *'), at('2026-10-08T09:30:00Z'), at('2026-10-11T20:00:00Z'), 'UTC')), '2026-10-11T09:00:00.000Z');
  assert.equal(iso(latestMissedRun(cron('0 9 * * *'), at('2026-10-11T08:59:00Z'), at('2026-10-11T09:00:00Z'), 'UTC')), '2026-10-11T09:00:00.000Z', 'a slot exactly at now counts');
  assert.equal(latestMissedRun(cron('0 9 * * *'), at('2026-10-11T20:00:00Z'), at('2026-10-11T10:00:00Z'), 'UTC'), null, 'a clock that stepped back missed nothing');
  const started = Date.now();
  assert.equal(iso(latestMissedRun(cron('* * * * *'), at('2021-10-11T00:00:00Z'), at('2026-10-11T00:00:30Z'), 'UTC')), '2026-10-11T00:00:00.000Z');
  assert.equal(iso(latestMissedRun(cron('0 0 29 2 *'), at('2021-10-11T00:00:00Z'), at('2026-10-11T00:00:30Z'), 'UTC')), '2024-02-29T00:00:00.000Z');
  assert.ok(Date.now() - started < 2000, 'five years of every-minute slots must not be walked one by one');
});

test('the local calendar day follows the timezone', () => {
  assert.equal(localDay(at('2026-10-11T19:00:00Z'), 'Asia/Kolkata'), '2026-10-12');
  assert.equal(localDay(at('2026-10-11T19:00:00Z'), 'UTC'), '2026-10-11');
});
