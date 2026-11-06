import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const { STATUS_FOOTER_ATTRIBUTE, isStatusFooterTarget } = await import('../src/lib/statusFooter.ts');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const footer = await read('../src/ui/StatusFooter.tsx');
const app = await read('../src/App.tsx');
const dialog = await read('../src/components/ui/dialog.tsx');
const sheet = await read('../src/components/ui/sheet.tsx');
const notificationCenter = await read('../src/ui/NotificationCenter.tsx');
const cards = await read('../src/ui/ProjectCardsView.tsx');
const store = await read('../src/store/worldStore.ts');

/** The source of one top-level function in StatusFooter.tsx. */
function fn(name) {
  const start = footer.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return footer.slice(start, footer.indexOf('\n}\n', start) + 2);
}
const footerElement = footer.slice(footer.indexOf('<footer'), footer.indexOf('</footer>'));

test('App renders the footer once, outside the view-mode branch, so it shows in both the 3D and cards views', () => {
  assert.equal(app.match(/<StatusFooter \/>/g)?.length, 1);
  const branchEnd = app.indexOf('<ProjectCardsView />');
  assert.ok(app.indexOf('<StatusFooter />') > branchEnd, 'rendered after the world/cards branch closes');
});

test('the footer is fixed, full width, the shared height', () => {
  assert.match(footerElement, /className="pointer-events-auto fixed inset-x-0 bottom-0 z-\[160\] flex h-\[var\(--status-footer-height\)\] items-stretch/);
  assert.match(footer, /py-\[5px\]/, 'fits the 46px footer around the two-line agent and group items');
  assert.doesNotMatch(footer, /py-2\.5/);
  assert.doesNotMatch(footer, /sortedExecutors\.length > 0 &&/, 'no guard hides the whole footer when no agents are configured');
});

test('the footer sits above every popup scrim and stays clickable while one is open', () => {
  assert.match(dialog, /DialogPrimitive\.Overlay[\s\S]*fixed inset-0 z-\[150\]/);
  assert.match(sheet, /SheetPrimitive\.Overlay[\s\S]*fixed inset-0 z-\[150\]/);
  assert.match(footerElement, /pointer-events-auto[^"]*z-\[160\]/);
});

test('the agents section is unchanged: sorted by usage, the same item and divider rule', () => {
  const agents = fn('AgentUsage');
  assert.match(agents, /sortExecutorsByUsage\(executors\)/);
  assert.match(agents, /role="radiogroup" aria-label="Default coding agent"/);
  assert.match(agents, /<ExecutorFooterItem executor=\{executor\} \/>/);
  assert.match(agents, /index < sortedExecutors\.length - 1 \? 'mr-4 border-r border-border' : ''/);
});

test('with no coding agents, a muted placeholder shows and the counts and bell stay', () => {
  const agents = fn('AgentUsage');
  assert.match(agents, /sortedExecutors\.length === 0[\s\S]*italic text-muted-foreground">No coding agents configured</);
  assert.match(footer, /<AgentUsage \/>\s*<WorkspaceCountsSection \/>\s*<AppUpdateSection \/>\s*<\/div>\s*<NotificationBell \/>/);
});

test('counts: projects, tasks across all projects, and live terminal sessions, each with its dot and full wording', () => {
  const counts = fn('WorkspaceCountsSection');
  assert.match(counts, /summarizeProjectStatus\(projects\)/);
  assert.match(counts, /summarizeWorkspaceCounts\(\{ projects, planByProject, taskIdsByProject, workflowRunsByProject, tasksById \}\)/);
  const expected = [
    ['projectStatus.total', 'projects', 'projects', null],
    ['projectStatus.working', 'working', 'projects working', 'bg-warning'],
    ['projectStatus.blocked', 'blocked', 'projects blocked', 'bg-destructive'],
    ['tasks.active', 'active', 'active tasks', 'bg-warning'],
    ['tasks.blocked', 'blocked', 'blocked tasks', 'bg-destructive'],
    ['tasks.pending', 'pending', 'pending tasks', 'bg-muted-foreground', ' showLabel'],
  ];
  for (const [value, label, fullLabel, dot, show = ''] of expected) {
    const dotProp = dot ? ` dot="${dot}"` : '';
    assert.match(counts, new RegExp(`<StatusCount value=\\{${value.replace('.', '\\.')}\\} label="${label}"${show} fullLabel="${fullLabel}"${dotProp} />`));
  }
  // The sessions count (every live terminal session) opens the sessions popover, so it renders through its trigger (see planningSessionsPopover.test.mjs).
  assert.match(counts, /<PlanningSessionsCount value=\{liveTerminalSessions\.length\} \/>/);
  for (const group of ['Projects', 'Tasks across all projects', 'Live sessions across all projects', 'Running commands across all projects']) {
    assert.match(counts, new RegExp(`ariaLabel="${group}"`));
  }
  const count = fn('StatusCount');
  assert.match(count, /title=\{`\$\{value\} \$\{fullLabel\}`\}/, 'the tooltip has the full wording, e.g. "5 active tasks"');
  assert.match(count, /font-semibold tabular-nums \$\{muted \? 'text-muted-foreground' : 'text-foreground'\}`\}>\{value\}/);
});

test('on narrow screens the row stays one line: labels collapse to dot and number, the middle scrolls, the bell is pinned', () => {
  assert.match(footer, /<div className="flex min-w-0 flex-1 items-center overflow-x-auto/);
  assert.doesNotMatch(footer, /flex-wrap/);
  assert.match(fn('StatusCount'), /<span className=\{showLabel \? 'max-sm:sr-only' : 'sr-only'\}>\{label\}<\/span>/, 'words hidden visually, still read out; "pending" stays visible from sm up');
  assert.match(fn('CountGroup'), /aria-hidden="true"[^>]*>\{heading\}/, 'headings stay at every width');
  assert.match(fn('NotificationBell'), /flex-none/);
});

test('the bell sits after the scrolling area, keeps its badge, opens its tooltip upward and shows when the drawer is open', () => {
  const bell = fn('NotificationBell');
  assert.ok(footer.indexOf('<NotificationBell />') > footer.indexOf('<WorkspaceCountsSection />'));
  assert.match(bell, /countUnreadNotifications\(notificationsById, errorNotificationsById\)/);
  assert.match(bell, /\{unreadNotificationCount > 0 && \(\s*<Badge\s+variant="destructive"/);
  assert.match(bell, /`Open notifications \(\$\{unreadNotificationCount\} unread\)` : 'Open notifications'/);
  assert.match(bell, /<TooltipContent side="top">Notifications<\/TooltipContent>/);
  assert.match(bell, /aria-pressed=\{notificationCenterOpen\}/);
  assert.match(bell, /onClick=\{toggleNotificationCenter\}/);
});

test('the global error box is gone: no alert, no lastError, in or above the footer', () => {
  assert.doesNotMatch(footer, /LastErrorAlert|role="alert"|lastError|AlertDescription/);
});

test('toasts sit above the footer on desktop and mobile', () => {
  assert.match(app, /offset=\{\{ bottom: STATUS_FOOTER_HEIGHT \+ 20, left: 24 \}\}/);
  assert.match(app, /mobileOffset=\{\{ bottom: STATUS_FOOTER_HEIGHT \+ 12, left: 12, right: 12 \}\}/);
});

test('the cards view leaves room below the last row for the footer', () => {
  assert.match(cards, /pb-\[calc\(var\(--status-footer-height\)\+5rem\)\]/);
});

test('the footer adds no backdrop blur', () => {
  assert.doesNotMatch(footer, /backdrop-blur|backdrop-filter/);
});

test('a click on the footer is recognised by its marker attribute', () => {
  const inFooter = { closest: (selector) => (selector === `[${STATUS_FOOTER_ATTRIBUTE}]` ? {} : null) };
  const elsewhere = { closest: () => null };
  assert.equal(isStatusFooterTarget(inFooter), true);
  assert.equal(isStatusFooterTarget(elsewhere), false);
  assert.equal(isStatusFooterTarget(null), false);
  assert.equal(isStatusFooterTarget({}), false, 'a non-element target (e.g. the document)');
  assert.match(footerElement, /data-status-footer/);
});

test('modal dialogs and sheets ignore outside clicks on the footer, then defer to the caller\'s handler', () => {
  for (const [name, source] of [['dialog', dialog], ['sheet', sheet]]) {
    assert.match(source, /onInteractOutside=\{\(event\) => \{\s*\/\/[^\n]*\n\s*if \(isStatusFooterTarget\(event\.target\)(?: \|\| isToastTarget\(event\.target\))?\) event\.preventDefault\(\)\s*onInteractOutside\?\.\(event\)/, name);
  }
});

test('the drawer mounts only while open, so its layer lands above an already-open Workspace or Catalog', () => {
  assert.match(notificationCenter, /if \(!notificationCenterOpen\) return null;/);
  assert.match(app, /<ProjectWorkspaceModal \/>\s*<CatalogModal \/>\s*<NotificationCenter \/>\s*<FooterCommandLog \/>/);
  assert.match(notificationCenter, /w-\[min\(448px,calc\(100%-2\.5rem\)\)\]/, 'keeps its width');
});

test('Escape and closing the drawer only close the drawer; no global key handler closes the Workspace', () => {
  assert.match(notificationCenter, /<Sheet open onOpenChange=\{\(open\) => \{ if \(!open\) closeNotificationCenter\(\); \}\}>/);
  for (const source of [footer, notificationCenter, app]) assert.doesNotMatch(source, /addEventListener\('keydown'|onKeyDown/);
  assert.match(store, /closeNotificationCenter: \(\) => set\(\{ notificationCenterOpen: false \}\)/);
});

test('opening a notification row still goes to its target, then closes the drawer', () => {
  assert.match(notificationCenter, /await openNotificationTarget\(n\);\s*closeNotificationCenter\(\);/);
});

const popoverShell = await read('../src/ui/FooterCountPopover.tsx');
const popoverLists = await read('../src/ui/FooterListPopovers.tsx');
const tasksPopover = await read('../src/ui/TasksPopover.tsx');

test('the footer counts open popovers (the three task counts share one) and the total projects number does not', () => {
  const ids = [...footer.matchAll(/<FooterCountPopover id="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['projects-working', 'projects-blocked', 'commands-running', 'pull-requests-open', 'app-update']);
  assert.match(footer, /<StatusCount value=\{projectStatus\.total\} label="projects" fullLabel="projects" \/>/, 'the total stays a plain count');
  assert.doesNotMatch(footer, /id="projects-total"/);
  assert.equal(footer.match(/<TasksCountPopover/g)?.length, 1, 'the three task counts are one trigger');
  assert.match(footer, /kind: 'active'[\s\S]*kind: 'blocked'[\s\S]*kind: 'pending'/);
  for (const label of ['active tasks', 'blocked tasks', 'pending tasks']) assert.match(footer, new RegExp(`\\$\\{tasks\\.\\w+\\} ${label}`));
});

// WorkspaceCountsSection's six counts share one open-popover state; the app-update item (task
// 7.001) is a separate, independent group (like PlanningSessionsCount's own Popover) — it isn't
// mutually exclusive with those five, only with itself.
test('the workspace counts share one open-popover state, so only one of those six is open at a time', () => {
  assert.equal(footer.match(/useReducer\(footerPopoverReducer/g)?.length, 2);
  assert.equal(footer.match(/state=\{popover\} dispatch=\{dispatch\}/g)?.length, 5);
  assert.equal(footer.match(/state=\{popover\}\s+dispatch=\{dispatch\}\s+triggers=/g)?.length, 1, 'the Tasks popover shares the same state');
});

test('the popover renders inside the footer, so modal popups ignore clicks in it, and stacks with the footer above every popup', () => {
  assert.doesNotMatch(popoverShell, /createPortal|Portal/);
  assert.match(popoverShell, /className="fixed bottom-\[calc\(var\(--status-footer-height\)\+6px\)\]/);
  assert.match(footerElement, /z-\[160\]/);
});

test('the popover is sized to fit above the footer and the viewport, scrolls inside, and truncates long names with a hover title', () => {
  assert.match(popoverShell, /max-h-\[min\(24rem,calc\(100vh-var\(--status-footer-height\)-16px\)\)\]/);
  assert.match(popoverShell, /overflow-y-auto/);
  assert.match(popoverShell, /window\.innerWidth - 2 \* VIEWPORT_MARGIN_PX/);
  assert.match(popoverLists, /truncate font-medium" title=\{row\.name\}/);
  assert.match(tasksPopover, /truncate text-xs font-medium text-foreground" title=\{row\.title\}/);
});

test('triggers are buttons announcing a list; Esc is captured so it never closes a modal underneath; outside press closes', () => {
  assert.match(popoverShell, /aria-haspopup="true"/);
  assert.match(popoverShell, /aria-expanded=\{open\}/);
  assert.match(popoverShell, /opens a list/);
  assert.match(popoverShell, /window\.addEventListener\('keydown', onKeyDown, true\)/);
  assert.match(popoverShell, /event\.stopPropagation\(\)/);
  assert.match(popoverShell, /document\.addEventListener\('pointerdown', onPointerDown, true\)/);
  assert.match(popoverShell, /onFocus=/);
});

test('a row opens its project through the store then closes the popover, with no other actions', () => {
  assert.match(popoverLists, /openCard\(row\.projectId, null\); onDone\(\)/);
  assert.match(tasksPopover, /openCard\(row\.projectId, row\.open\); onDone\(\)/);
  assert.doesNotMatch(popoverLists + tasksPopover, /approve|retry|archive|startTask/i);
});

test('the footer numbers still come from the same functions', () => {
  assert.match(footer, /summarizeProjectStatus\(projects\)/);
  assert.match(footer, /summarizeWorkspaceCounts\(\{ projects, planByProject, taskIdsByProject, workflowRunsByProject, tasksById \}\)/);
});

test('the Tasks board applies a footer request once, then clears it', async () => {
  const panel = await read('../src/ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /showDetail\(cardDetailRequest\.detail\);\s*clearCardDetailRequest\(\);/);
});

test('no popover file uses a looping animation', async () => {
  assert.doesNotMatch(popoverShell + popoverLists + tasksPopover + (await read('../src/ui/FooterListHeading.tsx')), /animate-(pulse|ping|spin|bounce)/);
});

test('Esc closes the popover and returns focus to the trigger without that focus reopening it', () => {
  const esc = popoverShell.slice(popoverShell.indexOf('const onKeyDown'), popoverShell.indexOf("window.addEventListener('keydown'"));
  assert.match(esc, /dispatch\(\{ type: 'close' \}\);\s*\/\/[^\n]*\n\s*restoringFocus\.current = true;\s*rootRef\.current\?\.querySelector\('button'\)\?\.focus\(\);\s*restoringFocus\.current = false;/);
  assert.match(popoverShell, /onFocus=\{\(\) => \{ if \(!restoringFocus\.current\) dispatch\(\{ type: 'preview', id \}\); \}\}/);
});

test('the app-update item keeps a gap before its divider, and renders nothing without an update', () => {
  const update = fn('AppUpdateSection');
  assert.match(update, /ml-3\.5[^"]*border-l[^"]*max-sm:ml-2\.5/);
  assert.match(update, /if \(!appUpdate\) return null/);
});
