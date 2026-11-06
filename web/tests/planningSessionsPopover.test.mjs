import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const {
  buildTerminalSessionGroups, countTerminalSessionRows, SESSION_KIND_LABELS, UNKNOWN_PROJECT_NAME,
  popoverTransition, rowNavigationTarget, CLOSED_POPOVER, OPEN_DELAY_MS, CLOSE_DELAY_MS,
} = await import('../src/lib/planningSessionsPopover.ts');
const { STATUS_FOOTER_ATTRIBUTE, isStatusFooterTarget } = await import('../src/lib/statusFooter.ts');

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const popover = await read('../src/ui/PlanningSessionsPopover.tsx');
const footer = await read('../src/ui/StatusFooter.tsx');

const projects = [{ id: 'p-b', name: 'beta' }, { id: 'p-a', name: 'Alpha' }];
const session = (id, kind, projectId, title = id) => ({ id, kind, projectId, title });

test('U1 every live session is one row, whatever its kind, and the total is the snapshot length', () => {
  const sessions = Object.keys(SESSION_KIND_LABELS).map((kind) => session(`s-${kind}`, kind, 'p-a'));
  const groups = buildTerminalSessionGroups(projects, sessions);
  assert.equal(countTerminalSessionRows(groups), sessions.length);
  assert.deepEqual(groups[0].sessions.map((s) => s.kindLabel).sort(), Object.values(SESSION_KIND_LABELS).sort());
});

test('U2 groups sort A–Z ignoring case; projects without sessions get no heading', () => {
  const groups = buildTerminalSessionGroups([...projects, { id: 'p-c', name: 'Gamma' }], [session('x', 'task', 'p-b'), session('y', 'agent', 'p-a')]);
  assert.deepEqual(groups.map((g) => g.projectName), ['Alpha', 'beta']);
});

test('U3 sessions within a group sort by kind, then name, then id', () => {
  const groups = buildTerminalSessionGroups(projects, [session('3', 'task', 'p-a', 'b'), session('2', 'task', 'p-a', 'a'), session('1', 'agent', 'p-a', 'z')]);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['1', '2', '3']);
});

test('U4 a session whose project is gone or unresolved still counts, under one trailing "Unknown project" group', () => {
  const groups = buildTerminalSessionGroups(projects, [session('lost', 'task', null), session('gone', 'agent', 'p-missing'), session('ok', 'agent', 'p-a')]);
  assert.deepEqual(groups.map((g) => g.projectName), ['Alpha', UNKNOWN_PROJECT_NAME]);
  assert.equal(countTerminalSessionRows(groups), 3);
  assert.equal(groups[1].projectId, null);
});

test('U5 no sessions gives no groups', () => {
  assert.deepEqual(buildTerminalSessionGroups(projects, []), []);
});

test('U6 the accessible name carries kind, title and project', () => {
  const [group] = buildTerminalSessionGroups(projects, [session('a1', 'agent', 'p-a', 'Terminal 1')]);
  assert.equal(group.sessions[0].accessibleName, 'Open agent session Terminal 1, Alpha');
});

const at = (mode, ignoreNextFocus = false) => ({ mode, ignoreNextFocus });
const after = (state, ...events) => events.reduce((s, event) => popoverTransition(s, event).state, state);

test('U29 open/close transitions: hover, focus, click-to-pin, Esc, outside, focus leaving and row activation', () => {
  assert.equal(OPEN_DELAY_MS, 200);
  assert.equal(CLOSE_DELAY_MS, 250);
  assert.deepEqual(CLOSED_POPOVER, at('closed'));

  // Hover opens after a delay; leaving both schedules a close; coming back cancels it.
  assert.deepEqual(popoverTransition(at('closed'), 'pointerEnter'), { state: at('closed'), timer: { event: 'hoverOpen', delayMs: 200 } });
  assert.deepEqual(after(at('closed'), 'hoverOpen'), at('hover'));
  assert.deepEqual(popoverTransition(at('hover'), 'pointerLeave'), { state: at('hover'), timer: { event: 'hoverClose', delayMs: 250 } });
  assert.equal(popoverTransition(at('hover'), 'pointerEnter').timer, 'cancel');
  assert.equal(popoverTransition(at('closed'), 'pointerLeave').timer, 'cancel', 'leaving before the open delay cancels the open');
  assert.deepEqual(after(at('hover'), 'hoverClose'), at('closed'));
  assert.deepEqual(after(at('pinned'), 'hoverOpen'), at('pinned'), 'a late hover-open doesn\'t change a pinned popover');

  // Focus opens at once; a pointer press suppresses that, so a mouse click doesn't open then toggle.
  assert.deepEqual(after(at('closed'), 'focus'), at('focus'));
  assert.deepEqual(after(at('closed'), 'pointerDown', 'focus'), at('closed'));
  assert.deepEqual(after(at('closed'), 'pointerDown', 'focus', 'click'), at('pinned'));
  assert.deepEqual(after(at('hover'), 'focus'), at('hover'));
  assert.deepEqual(after(at('closed'), 'keyboardOpen'), at('focus'));
  assert.deepEqual(after(at('pinned'), 'keyboardOpen'), at('pinned'));

  // A click pins (from closed or hover-open); a click while pinned closes.
  assert.deepEqual(after(at('closed'), 'click'), at('pinned'));
  assert.deepEqual(after(at('hover'), 'click'), at('pinned'));
  assert.deepEqual(after(at('focus'), 'click'), at('pinned'));
  assert.deepEqual(after(at('pinned'), 'click'), at('closed'));

  // Pinned ignores the pointer leaving.
  assert.equal(popoverTransition(at('pinned'), 'pointerLeave').timer, 'cancel');
  assert.deepEqual(after(at('pinned'), 'pointerLeave', 'hoverClose'), at('pinned'));

  // Esc closes and returns focus to the count without reopening it.
  const escaped = popoverTransition(at('pinned'), 'escape');
  assert.deepEqual(escaped, { state: at('closed', true), timer: 'cancel', returnFocus: true });
  assert.deepEqual(after(escaped.state, 'focus'), at('closed'));
  assert.deepEqual(after(escaped.state, 'focus', 'focus'), at('focus'), 'only that one focus is skipped');

  // Outside clicks and row activation close from any open mode.
  for (const mode of ['hover', 'focus', 'pinned']) {
    assert.deepEqual(after(at(mode), 'outside'), at('closed'), mode);
    assert.deepEqual(after(at(mode), 'select'), at('closed'), mode);
  }

  // Focus leaving closes only a keyboard-opened popover.
  assert.deepEqual(after(at('focus'), 'focusLeave'), at('closed'));
  assert.deepEqual(after(at('pinned'), 'focusLeave'), at('pinned'));
  assert.deepEqual(after(at('hover'), 'focusLeave'), at('hover'));
});

test('U30 keyboard row navigation: arrows from the count, then up/down/Home/End within the list', () => {
  assert.equal(rowNavigationTarget('ArrowDown', null, 4), 0);
  assert.equal(rowNavigationTarget('ArrowUp', null, 4), 3);
  assert.equal(rowNavigationTarget('Enter', null, 4), null);
  assert.equal(rowNavigationTarget('ArrowDown', 1, 4), 2);
  assert.equal(rowNavigationTarget('ArrowDown', 3, 4), 3, 'clamps at the end');
  assert.equal(rowNavigationTarget('ArrowUp', 2, 4), 1);
  assert.equal(rowNavigationTarget('ArrowUp', 0, 4), 0, 'clamps at the start');
  assert.equal(rowNavigationTarget('Home', 2, 4), 0);
  assert.equal(rowNavigationTarget('End', 0, 4), 3);
  assert.equal(rowNavigationTarget('Tab', 1, 4), null, 'Tab keeps its own behaviour');
  assert.equal(rowNavigationTarget('ArrowDown', null, 0), null);
  assert.equal(rowNavigationTarget('End', 0, 0), null);
});

// ---- Component wiring (source checks; there is no DOM harness) ----

/** The source of one top-level function in PlanningSessionsPopover.tsx. */
function fn(name) {
  const start = popover.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return popover.slice(start, popover.indexOf('\n}\n', start) + 2);
}
const count = fn('PlanningSessionsCount');
const trigger = count.slice(count.indexOf('<button'), count.indexOf('</button>'));
const content = count.slice(count.indexOf('<PopoverContent'), count.indexOf('</PopoverContent>'));

test('C1 the planning count is a button that announces it opens a list, keeping its dot, number, word and title', () => {
  assert.match(trigger, /type="button"/);
  assert.match(trigger, /aria-haspopup="dialog"/);
  assert.match(trigger, /aria-expanded=\{open\}/);
  assert.match(trigger, /aria-controls=\{open \? POPOVER_ID : undefined\}/);
  assert.match(trigger, /aria-label=\{`\$\{value\} live sessions\. Show list`\}/);
  assert.match(trigger, /title=\{`\$\{value\} live sessions`\}/);
  assert.match(trigger, /rounded-full bg-info/);
  assert.match(trigger, /font-semibold tabular-nums text-foreground">\{value\}</);
  assert.match(trigger, /<span className="max-sm:sr-only">sessions<\/span>/);
  assert.match(content, /id=\{POPOVER_ID\}/);
});

test('C2 the footer feeds the count from the live terminal sessions and renders it through the popover trigger', () => {
  assert.match(footer, /<PlanningSessionsCount value=\{liveTerminalSessions\.length\} \/>/);
  assert.match(footer, /import \{ PlanningSessionsCount \} from '\.\/PlanningSessionsPopover';/);
});

test('C3 hover enters and leaves on both the count and the popover, timed by the reducer, with the timer cleared on unmount', () => {
  for (const part of [trigger, content]) {
    assert.match(part, /onPointerEnter=\{onPointerEnter\}/);
    assert.match(part, /onPointerLeave=\{onPointerLeave\}/);
  }
  assert.match(count, /event\.pointerType !== 'touch'\) dispatch\('pointerEnter'\)/, 'touch taps pin instead of hovering');
  assert.match(count, /window\.setTimeout\(\(\) => dispatch\(timer\.event\), timer\.delayMs\)/);
  assert.match(count, /useEffect\(\(\) => \(\) => window\.clearTimeout\(timerRef\.current\), \[\]\);/);
});

test('C4 focus opens, a pointer press suppresses the focus-open, and a click toggles the pin', () => {
  assert.match(trigger, /onFocus=\{\(\) => dispatch\('focus'\)\}/);
  assert.match(trigger, /onPointerDown=\{\(\) => dispatch\('pointerDown'\)\}/);
  assert.match(trigger, /onClick=\{\(\) => dispatch\('click'\)\}/);
  assert.match(trigger, /onKeyDown=\{onTriggerKeyDown\}/);
  assert.match(content, /onKeyDown=\{onContentKeyDown\}/);
  assert.match(count, /rowNavigationTarget\(key, current, list\.length\)/);
});

test('C5 Esc and an outside press close it; a press on the count is left to its click; Esc returns focus to the count', () => {
  assert.match(content, /onEscapeKeyDown=\{\(\) => dispatch\('escape'\)\}/);
  assert.match(content, /onPointerDownOutside=\{\(event\) => \{[\s\S]*if \(isInside\(event\.target\)\) event\.preventDefault\(\);\s*else dispatch\('outside'\);/);
  assert.match(content, /onFocusOutside=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(content, /onOpenAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/, 'hovering never steals focus');
  assert.match(count, /if \(returnFocus\) \{[\s\S]*triggerRef\.current\?\.focus\(\);/);
  assert.match(count, /onBlur=\{onBlur\}/);
  assert.match(count, /if \(!isInside\(event\.relatedTarget\)\) dispatch\('focusLeave'\)/);
});

test('C6 the popover carries the footer marker, so an open modal ignores interactions with it even in a portal', () => {
  assert.match(content, /data-status-footer\n/);
  const rowInPopover = { closest: (selector) => (selector === `[${STATUS_FOOTER_ATTRIBUTE}]` ? { id: 'planning-sessions-popover' } : null) };
  assert.equal(isStatusFooterTarget(rowInPopover), true);
  assert.match(content, /ref=\{setContent\}/);
  assert.match(count, /isolateScroll\(node\)/, 'the list still scrolls under a modal\'s scroll lock');
});

test('C7 layer order: the popover sits above the footer, which sits above every popup, sheet and overlay', () => {
  const layer = Number(content.match(/z-\[(\d+)\]/)?.[1]);
  assert.ok(layer > 160, 'above the footer layer (z-[160])');
  assert.ok(layer < 170, 'below the global error alert layer (z-[170])');
  assert.match(content, /pointer-events-auto/, 'clickable while a modal disables pointer events outside it');
  assert.match(footer, /fixed inset-x-0 bottom-0 z-\[160\]/);
});

test('C8 placement and size: above the count, right-aligned, bounded by the viewport and the space above the footer', () => {
  assert.match(content, /side="top"/);
  assert.match(content, /align="end"/);
  assert.match(content, /sideOffset=\{8\}/);
  assert.match(content, /collisionPadding=\{12\}/);
  assert.match(content, /w-\[min\(360px,calc\(100vw-24px\)\)\]/);
  assert.match(content, /max-h-\[min\(440px,calc\(100dvh-var\(--status-footer-height\)-16px\)\)\]/);
  assert.match(fn('TerminalSessionsList'), /overflow-y-auto overflow-x-hidden overscroll-contain/);
});

test('C9 long project and session names truncate with the full text on hover', () => {
  assert.match(fn('TerminalSessionsList'), /<FooterListHeading name=\{group\.projectName\} count=\{group\.sessions\.length\} \/>/);
  assert.match(fn('SessionRow'), /className="truncate[^"]*" title=\{session\.name\}>\{session\.name\}</);
  assert.match(fn('SessionRow'), /min-w-0/);
});

test('C10 rows are buttons named by the view-model, opening the session and closing the popover', () => {
  const row = fn('SessionRow');
  assert.match(row, /<button\s+type="button"\s+data-planning-session-row\s+aria-label=\{session\.accessibleName\}/);
  assert.match(row, /onClick=\{\(\) => onOpen\(session\)\}/);
  assert.match(count, /dispatch\('select'\);\s*if \(session\.projectId\) openPlanningSession\(session\.projectId, session\.id\);/);
});

test('C11 the state marker is static: no looping animation in the popover', () => {
  assert.doesNotMatch(popover, /animate-(pulse|ping|spin)|infinite/);
});

test('C12 an empty list shows "No live sessions"', () => {
  assert.match(fn('TerminalSessionsList'), /total === 0 \? \([\s\S]*No live sessions/);
});

test('C13 the list reads the store\'s live terminal sessions and mounts only while open', () => {
  const list = fn('TerminalSessionsList');
  for (const slice of ['projects', 'liveTerminalSessions']) assert.match(list, new RegExp(`useWorldStore\\(\\(s\\) => s\\.${slice}\\)`));
  assert.match(list, /buildTerminalSessionGroups\(projects, liveTerminalSessions\)/);
  assert.match(content, /<TerminalSessionsList onOpen=\{onOpenSession\} \/>/);
  assert.match(count, /<Popover open=\{open\}>/, 'Radix unmounts the content while closed');
});

test('C14 key handling lives in the popover file; the footer itself still has no key handler', () => {
  assert.doesNotMatch(footer, /onKeyDown|addEventListener\('keydown'/);
  assert.match(popover, /onKeyDown=/);
});

test('C15 the row shows the session\'s kind badge, and the trigger and heading use the Sessions wording', () => {
  assert.match(fn('SessionRow'), /\{session\.kindLabel\}/);
  assert.match(fn('TerminalSessionsList'), />Sessions<\/span>/);
  assert.match(popover, /aria-label="Live sessions"/);
});
