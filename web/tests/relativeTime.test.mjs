import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Root as DialogRoot } from '@radix-ui/react-dialog';
import { loadModule, render } from './renderHelper.mjs';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { formatRelativeTime, formatExactTime } = await import('../src/lib/sessionTiming.ts');
const ticker = await import('../src/lib/minuteTicker.ts');

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KOLKATA = 'Asia/Kolkata';
const NEW_YORK = 'America/New_York';
// Mon 26 Oct 2026, 15:00 in Kolkata: the mockups' fixed "now".
const NOW = new Date('2026-10-26T09:30:00.000Z');
const rel = (offsetMs, timeZone, now = NOW) => formatRelativeTime(now.getTime() + offsetMs, now, timeZone);
const plainDate = (ms, timeZone) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric', ...(timeZone ? { timeZone } : {}) });

// ---- formatRelativeTime ----

test('F01 F02 F03 within one minute either side reads "just now"', () => {
  assert.equal(rel(-20 * SEC), 'just now');
  assert.equal(rel(20 * SEC), 'just now');
  assert.equal(rel(-(MIN - 1)), 'just now');
  assert.equal(rel(MIN - 1), 'just now');
});

test('F04 F05 minutes: exactly a minute either way, then up to 59m', () => {
  assert.equal(rel(MIN), 'in 1m');
  assert.equal(rel(-MIN), '1m ago');
  assert.equal(rel(5 * MIN), 'in 5m');
  assert.equal(rel(59 * MIN), 'in 59m');
});

test('F06 F07 hours up to 23h, even when the time falls on the next calendar day', () => {
  assert.equal(rel(60 * MIN), 'in 1h');
  assert.equal(rel(23 * HOUR + 59 * MIN), 'in 23h');
  // Tomorrow 10:00 in Kolkata, seen at 15:00 today.
  assert.equal(formatRelativeTime('2026-10-27T04:30:00.000Z', NOW, KOLKATA), 'in 19h');
});

test('F08 F09 without a time zone, days are elapsed 24h spans and 30 days falls back to a date', () => {
  assert.equal(rel(24 * HOUR), 'tomorrow');
  assert.equal(rel(47 * HOUR), 'tomorrow');
  assert.equal(rel(48 * HOUR), 'in 2d');
  assert.equal(rel(29 * DAY), 'in 29d');
  assert.equal(rel(30 * DAY), plainDate(NOW.getTime() + 30 * DAY));
  assert.match(rel(30 * DAY), /2026/);
});

test('F11 F12 the time zone decides "yesterday" and "tomorrow" by its own calendar day', () => {
  const now = new Date('2026-10-26T20:00:00.000Z');
  const past = '2026-10-25T18:00:00.000Z'; // 26h earlier
  assert.equal(formatRelativeTime(past, now, KOLKATA), '2d ago');
  assert.equal(formatRelativeTime(past, now, 'UTC'), 'yesterday');
  assert.equal(formatRelativeTime(past, now, NEW_YORK), 'yesterday');
  const future = '2026-10-28T03:00:00.000Z'; // 31h later
  assert.equal(formatRelativeTime(future, now, KOLKATA), 'tomorrow');
  assert.equal(formatRelativeTime(future, now, 'UTC'), 'in 2d');
  assert.equal(formatRelativeTime(future, now, NEW_YORK), 'tomorrow');
});

test('F13 across a day boundary: 23:30 to 00:30 two local days later is "in 2d" with a zone, "tomorrow" without', () => {
  const now = new Date('2026-10-26T23:30:00.000Z');
  assert.equal(formatRelativeTime('2026-10-28T00:30:00.000Z', now, 'UTC'), 'in 2d');
  assert.equal(formatRelativeTime('2026-10-28T00:30:00.000Z', now), 'tomorrow');
});

test('F14 a 25h DST fall-back day never reads "in 0d" or "0d ago"', () => {
  // 1 Nov 2026 in New York: 00:15 EDT and 23:45 EST are 24.5h apart on one calendar day.
  const start = Date.parse('2026-11-01T04:15:00.000Z');
  const end = start + 24.5 * HOUR;
  assert.equal(formatRelativeTime(end, new Date(start), NEW_YORK), 'tomorrow');
  assert.equal(formatRelativeTime(start, new Date(end), NEW_YORK), 'yesterday');
});

test('F15 the plain date is the calendar day in the time zone', () => {
  const at = Date.parse('2026-09-10T20:00:00.000Z');
  const now = new Date(at + 45 * DAY);
  const kolkata = formatRelativeTime(at, now, KOLKATA);
  const utc = formatRelativeTime(at, now, 'UTC');
  assert.equal(kolkata, plainDate(at, KOLKATA));
  assert.equal(utc, plainDate(at, 'UTC'));
  assert.match(kolkata, /11/);
  assert.match(utc, /10/);
});

test('F16 F17 with a time zone the 30-day cut counts calendar days, both ways', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');
  assert.equal(rel(-29 * DAY, 'UTC', now), '29d ago');
  assert.equal(rel(29 * DAY, 'UTC', now), 'in 29d');
  assert.equal(rel(-30 * DAY, 'UTC', now), plainDate(now.getTime() - 30 * DAY, 'UTC'));
  assert.equal(rel(30 * DAY, 'UTC', now), plainDate(now.getTime() + 30 * DAY, 'UTC'));
  assert.equal(rel(60 * DAY, KOLKATA, now), plainDate(now.getTime() + 60 * DAY, KOLKATA));
});

test('F18 F19 an ISO string, any ISO spelling and an ms number give the same label', () => {
  for (const offset of [-3 * HOUR, 3 * HOUR, -5 * DAY, 5 * DAY]) {
    const ms = NOW.getTime() + offset;
    assert.equal(formatRelativeTime(new Date(ms).toISOString(), NOW, KOLKATA), formatRelativeTime(ms, NOW, KOLKATA));
  }
  const now = new Date('2026-10-26T10:00:00.000Z');
  assert.equal(formatRelativeTime('2026-10-26T15:00:00+05:30', now), formatRelativeTime('2026-10-26T09:30:00Z', now));
  assert.equal(formatRelativeTime('2026-10-26', now, 'UTC'), formatRelativeTime(Date.UTC(2026, 9, 26), now, 'UTC'));
  assert.equal(formatRelativeTime('2026-10-26', now, 'UTC'), '10h ago');
});

test('F20 without "now" it uses the current clock', () => {
  assert.equal(formatRelativeTime(Date.now() - 5 * MIN), '5m ago');
});

test('F21 F22 F23 an unreadable or out-of-range instant gives "", the Date range edges and epoch 0 give a plain date', () => {
  for (const bad of ['not a date', Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1, Number.MAX_SAFE_INTEGER]) assert.equal(formatRelativeTime(bad, NOW), '', String(bad));
  assert.equal(formatRelativeTime(8.64e15, NOW), plainDate(8.64e15));
  assert.equal(formatRelativeTime(-8.64e15, NOW), plainDate(-8.64e15));
  assert.notEqual(formatRelativeTime(8.64e15, NOW, 'UTC'), '');
  assert.equal(formatRelativeTime(0, NOW, 'UTC'), plainDate(0, 'UTC'));
  assert.match(formatRelativeTime(0, NOW, 'UTC'), /1970/);
});

test('F24 F25 zone spellings Intl accepts are equal; an unknown zone throws RangeError', () => {
  const at = NOW.getTime() - 26 * HOUR;
  assert.equal(formatRelativeTime(at, NOW, 'asia/kolkata'), formatRelativeTime(at, NOW, KOLKATA));
  assert.equal(formatRelativeTime(at, NOW, 'Etc/UTC'), formatRelativeTime(at, NOW, 'UTC'));
  assert.throws(() => formatRelativeTime(at, NOW, 'Mars/Base'), RangeError);
});

test('F26 a minute tick moves the labels on', () => {
  const later = new Date(NOW.getTime() + MIN);
  const at = (offset) => NOW.getTime() + offset;
  assert.deepEqual([at(5 * MIN), at(MIN), at(-59 * MIN)].map((a) => formatRelativeTime(a, NOW)), ['in 5m', 'in 1m', '59m ago']);
  assert.deepEqual([at(5 * MIN), at(MIN), at(-59 * MIN)].map((a) => formatRelativeTime(a, later)), ['in 4m', 'just now', '1h ago']);
});

// ---- formatExactTime ----

// The format `formatAt` in crmHooks.ts produced before it was replaced.
const legacyFormatAt = (ms, timeZone, withDate = true) => new Intl.DateTimeFormat('en-GB', { timeZone, ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

test('X01 X02 X03 X04 the exact time with and without the date, h23 and in the given zone', () => {
  assert.equal(formatExactTime(NOW.getTime(), KOLKATA), 'Mon 26 Oct, 15:00');
  assert.equal(formatExactTime(NOW.getTime(), KOLKATA, false), '15:00');
  assert.equal(formatExactTime('2026-10-26T00:00:00.000Z', 'UTC', false), '00:00');
  assert.equal(formatExactTime(NOW.getTime(), 'UTC', false), '09:30');
});

test('X05 X06 ISO and ms give the same output; the New York fall-back hour repeats 01:30', () => {
  assert.equal(formatExactTime(NOW.toISOString(), KOLKATA), formatExactTime(NOW.getTime(), KOLKATA));
  assert.equal(formatExactTime('2026-11-01T05:30:00.000Z', NEW_YORK, false), '01:30');
  assert.equal(formatExactTime('2026-11-01T06:30:00.000Z', NEW_YORK, false), '01:30');
});

test('X07 the output matches the old formatAt format exactly', () => {
  for (const ms of [NOW.getTime(), Date.UTC(2026, 0, 1, 0, 0), Date.UTC(2026, 11, 31, 23, 59)]) {
    for (const zone of [KOLKATA, 'UTC', NEW_YORK]) {
      assert.equal(formatExactTime(ms, zone), legacyFormatAt(ms, zone));
      assert.equal(formatExactTime(ms, zone, false), legacyFormatAt(ms, zone, false));
    }
  }
});

// ---- the shared minute ticker ----

function withFakeTimers(run) {
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now };
  const timers = new Map();
  let nextId = 1;
  let clock = 1_000_000;
  globalThis.setInterval = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = (id) => { timers.delete(id); };
  Date.now = () => clock;
  try {
    run({ timers, advance: (ms) => { clock += ms; for (const t of [...timers.values()]) t.fn(); } });
  } finally {
    Object.assign(globalThis, { setInterval: real.setInterval, clearInterval: real.clearInterval });
    Date.now = real.now;
  }
}

test('T01 T02 many subscribers share one 60-second interval', () => {
  withFakeTimers(({ timers }) => {
    const offs = [1, 2, 3].map(() => ticker.subscribeMinute(() => {}));
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].ms, 60_000);
    assert.equal(ticker.MINUTE_TICK_MS, 60_000);
    offs.forEach((off) => off());
  });
});

test('T03 T05 a tick gives every subscriber the same new value; between ticks the value stays put', () => {
  withFakeTimers(({ advance }) => {
    const seen = [];
    const offs = [0, 1].map(() => ticker.subscribeMinute(() => seen.push(ticker.currentMinute())));
    const before = ticker.currentMinute();
    assert.equal(ticker.currentMinute(), before, 'stable between ticks');
    assert.deepEqual(seen, [], 'no notification without a tick');
    advance(60_000);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.equal(seen[0], before + 60_000);
    offs.forEach((off) => off());
  });
});

test('T04 the last unsubscribe clears the interval and a new subscribe starts a fresh one', () => {
  withFakeTimers(({ timers }) => {
    const a = ticker.subscribeMinute(() => {});
    const b = ticker.subscribeMinute(() => {});
    a();
    assert.equal(timers.size, 1, 'still one subscriber left');
    b();
    assert.equal(timers.size, 0);
    const c = ticker.subscribeMinute(() => {});
    assert.equal(timers.size, 1);
    c();
  });
});

// ---- RelativeTime component ----

const RT = 'src/ui/design/RelativeTime.tsx';
const at3h = Date.parse('2026-10-26T12:30:00.000Z');

test('C01 C02 renders <time> with dateTime, the exact local time as title and the relative label', async () => {
  const html = await render(RT, 'RelativeTime', { at: at3h, timeZone: KOLKATA, now: NOW.getTime() });
  assert.match(html, /^<time dateTime="2026-10-26T12:30:00.000Z" title="Mon 26 Oct, 18:00"[^>]*>in 3h<\/time>$/);
  assert.equal(await render(RT, 'RelativeTime', { at: '2026-10-26T12:30:00.000Z', timeZone: KOLKATA, now: NOW.getTime() }), html);
});

test('C03 without a time zone the title is the exact time in the runtime zone', async () => {
  const html = await render(RT, 'RelativeTime', { at: at3h, now: NOW.getTime() });
  assert.ok(html.includes(`title="${formatExactTime(at3h)}"`));
  assert.match(html, />in 3h</);
});

test('C04 a past "yesterday" follows the time zone', async () => {
  const now = Date.parse('2026-10-26T20:00:00.000Z');
  assert.match(await render(RT, 'RelativeTime', { at: '2026-10-25T18:00:00.000Z', timeZone: 'UTC', now }), />yesterday</);
  assert.match(await render(RT, 'RelativeTime', { at: '2026-10-25T18:00:00.000Z', timeZone: KOLKATA, now }), />2d ago</);
});

test('C05 an unreadable instant renders nothing', async () => {
  assert.equal(await render(RT, 'RelativeTime', { at: 'not a date', now: NOW.getTime() }), '');
  assert.equal(await render(RT, 'RelativeTime', { at: Number.NaN }), '');
});

test('C06 its only styling is a dotted underline on hover, so it inherits the parent text', async () => {
  const html = await render(RT, 'RelativeTime', { at: at3h, now: NOW.getTime() });
  assert.match(html, /class="decoration-dotted underline-offset-2 hover:underline"/);
  assert.doesNotMatch(html, /text-|font-/);
});

test('C07 without "now" the label comes from the shared ticker', async () => {
  // Half a minute of margin: the ticker's value is from when it last moved, a moment before this test.
  assert.match(await render(RT, 'RelativeTime', { at: Date.now() - 5.5 * MIN }), />5m ago</);
});

test('C08 C09 C10 the design slots take "Due " plus RelativeTime', async () => {
  const { RelativeTime } = await loadModule(RT);
  const due = createElement('span', null, 'Due ', createElement(RelativeTime, { at: at3h, timeZone: KOLKATA, now: NOW.getTime() }));
  const card = await render('src/ui/design/Cards.tsx', 'ItemCard', { accent: 'yellow', title: 'Call', topLine: due, onOpen() {}, openLabel: 'Open' });
  assert.match(card, /Due <time dateTime="2026-10-26T12:30:00.000Z"[^>]*>in 3h<\/time>/);
  const { TwoLine } = await loadModule('src/ui/design/DataTable.tsx');
  const lost = renderToStaticMarkup(createElement(TwoLine, { main: 'No reason', sub: createElement(RelativeTime, { at: at3h, now: NOW.getTime() }) }));
  assert.match(lost, /text-muted-foreground"><time [^>]*>in 3h<\/time>/);
  const { StageModalHeading } = await loadModule('src/ui/design/StageModal.tsx');
  const heading = renderToStaticMarkup(createElement(DialogRoot, { open: true }, createElement(StageModalHeading, { title: 'Reachout', topLine: due })));
  assert.match(heading, /Due <time [^>]*title="Mon 26 Oct, 18:00"[^>]*>in 3h<\/time>/);
});

// ---- source checks ----

const SRC = new URL('../src/', import.meta.url);
const src = (file) => readFileSync(new URL(file, SRC), 'utf8');
const filesUnder = (dir) => readdirSync(new URL(dir, SRC), { recursive: true }).filter((f) => /\.tsx?$/.test(f)).map((f) => `${dir}${f}`);
const count = (text, re) => text.match(re)?.length ?? 0;

test('S01 S02 no hand-rolled display formatting under ui/crm; toISOString only for API payloads and input values', () => {
  const allowed = { 'ui/crm/ResponseForm.tsx': 2, 'ui/crm/ContactPanel.tsx': 1 };
  for (const file of filesUnder('ui/crm/')) {
    const text = src(file);
    assert.doesNotMatch(text, /Intl\.DateTimeFormat/, file);
    assert.doesNotMatch(text, /toLocale(Date|Time)String/, file);
    assert.equal(count(text, /toISOString\(/g), allowed[file] ?? 0, file);
  }
  assert.match(src('ui/crm/ContactPanel.tsx'), /createFollowup\([^)]*dueAt: new Date\(task\.when\)\.toISOString\(\)/);
});

test('S03 formatAt and formatDay are gone from crmHooks and nothing imports them', () => {
  assert.doesNotMatch(src('ui/crm/crmHooks.ts'), /formatAt|formatDay/);
  for (const file of filesUnder('ui/crm/')) assert.doesNotMatch(src(file), /\bformatAt\b|import[^;]*\bformatDay\b/, file);
});

test('S04 S09 Calendar: the due line is relative, session start and working hours stay absolute', () => {
  const cal = src('ui/crm/CalendarTab.tsx');
  assert.match(cal, /topLine=\{<>Due <RelativeTime at=\{item\.dueAt\} timeZone=\{timezone\} \/><\/>\}/);
  assert.match(cal, /formatExactTime\(session\.start, timezone, false\)/);
  assert.match(cal, /formatExactTime\(d\.window\.start, cal!\.timezone, false\)\}-\{formatExactTime\(d\.window\.end, cal!\.timezone, false\)\}/);
  assert.match(src('ui/crm/ExpandToday.tsx'), /formatExactTime\(e\.start, timezone, false\)/);
});

test('S05 the reachout popup takes the Building time zone from every caller and has no UTC literal', () => {
  const popup = src('ui/crm/ReachoutPopup.tsx');
  assert.match(popup, /timezone\?: string;/);
  assert.match(popup, /<RelativeTime at=\{item\.dueAt\} timeZone=\{timezone\} \/>/);
  assert.doesNotMatch(popup, /'UTC'/);
  const callers = { 'ui/crm/ContactPanel.tsx': 'settings.data.timezone', 'ui/crm/ExpandToday.tsx': 'timezone', 'ui/crm/ProspectsTab.tsx': 'settings.data.timezone', 'ui/crm/CalendarTab.tsx': 'settings.data.timezone' };
  for (const [file, value] of Object.entries(callers)) assert.ok(src(file).includes(`<ReachoutPopup`) && src(file).includes(`timezone={${value}}`), file);
});

test('S06 S07 S08 the contact timeline, notes list and lost date use RelativeTime in the Building zone', () => {
  assert.match(src('ui/crm/ContactPanel.tsx'), /topLine=\{<><RelativeTime at=\{e\.at\} timeZone=\{settings\.data\?\.timezone\} \/>\{e\.editedAt \? ' · edited' : ''\}<\/>\}/);
  const notes = src('ui/crm/NotesTab.tsx');
  assert.match(notes, /crmApi\.settings\(project\.id\)/);
  assert.match(notes, /<RelativeTime at=\{m\.createdAt\} timeZone=\{settings\.data\?\.timezone\} \/>/);
  const lost = src('ui/crm/LostTab.tsx');
  assert.match(lost, /crmApi\.settings\(project\.id\)/);
  assert.match(lost, /<RelativeTime at=\{c\.lostAt\} timeZone=\{timezone\} \/>/);
  assert.equal(count(lost, /timezone=\{settings\.data\?\.timezone\}/g), 2);
  assert.match(lost, /sortValue: \(c\) => c\.lostAt/);
});

test('S10 S11 outside the CRM, JSX callers use the component; the string-only summary keeps the pure function', () => {
  assert.match(src('ui/NotificationCenter.tsx'), /<RelativeTime at=\{notification\.updatedAt\} \/>/);
  assert.match(src('ui/project-popup/commands/CommandsPanel.tsx'), /started <RelativeTime at=\{run\.startedAt\} \/>/);
  const rows = src('ui/project-popup/TaskRows.tsx');
  assert.match(rows, /<MetaTag icon=\{Clock\}>Started <RelativeTime at=\{row\.metrics\.startedAt\} now=\{now\.getTime\(\)\} \/><\/MetaTag>/);
  assert.match(rows, /`Started \$\{formatRelativeTime\(row\.metrics\.startedAt, now\)\}`/);
  for (const file of ['ui/NotificationCenter.tsx', 'ui/project-popup/commands/CommandsPanel.tsx']) assert.doesNotMatch(src(file), /formatRelativeTime|timeZone=/, file);
});

test('S12 each formatter is defined once and RelativeTime runs no interval of its own', () => {
  const all = filesUnder('').map(src).join('\n');
  assert.equal(count(all, /function formatRelativeTime\b/g), 1);
  assert.equal(count(all, /function formatExactTime\b/g), 1);
  const component = src('ui/design/RelativeTime.tsx');
  assert.doesNotMatch(component, /setInterval|useNow/);
  assert.match(component, /useSyncExternalStore\(subscribeMinute, currentMinute, currentMinute\)/);
});

test('S13 the design language says timestamps and planned times use RelativeTime', () => {
  const doc = readFileSync(new URL('../../docs/design-language.md', import.meta.url), 'utf8');
  const components = doc.slice(doc.indexOf('## Components'), doc.indexOf('## Charts and motion'));
  assert.match(components, /timestamp and planned or due time renders through `RelativeTime`/);
});
