import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/**
 * Pins the Notifications drawer's own behavioral contracts that live in `ui/NotificationCenter.tsx`
 * itself, not in the pure helpers already covered by `notificationCenter.test.mjs` — this codebase
 * has no React render harness (see `workspaceTaskFlow.test.mjs`'s own source-matching convention),
 * so these are source-text assertions rather than a mounted-component interaction test.
 */
const source = await readFile(new URL('../src/ui/NotificationCenter.tsx', import.meta.url), 'utf8');

test('a row\'s tab is snapshotted only on the open transition, not on every notificationsById change', () => {
  assert.match(source, /tabSnapshotRef\.current = Object\.fromEntries/);
  // The snapshot effect depends only on notificationCenterOpen — not notificationsById — so toggling
  // a row's read state while the drawer stays open never reshuffles which tab it's listed under.
  assert.match(source, /\}, \[notificationCenterOpen\]\);/);
});

test('clicking a row opens its target and closes the drawer', () => {
  assert.match(source, /async function openRow\(n: DrawerNotification\)/);
  assert.match(source, /await openNotificationTarget\(n\)/);
  assert.match(source, /closeNotificationCenter\(\)/);
});

test('the read/unread dot and the quick action button both stop propagation, so neither triggers the row\'s own click', () => {
  const dotButton = source.match(/aria-label=\{unread[\s\S]{0,400}?event\.stopPropagation\(\);/);
  assert.ok(dotButton, 'the dot toggle stops propagation before acting');
  const quickActionButton = source.match(/onClick=\{async \(event\) => \{\s*event\.stopPropagation\(\);/);
  assert.ok(quickActionButton, 'the quick action button stops propagation before acting');
});

test('the quick action button shows a pending state while it runs, and only appears when quickActionFor returns one', () => {
  assert.match(source, /const \[pending, setPending\] = useState\(false\)/);
  assert.match(source, /setPending\(true\)/);
  assert.match(source, /await runNotificationQuickAction\(notification\)/);
  assert.match(source, /setPending\(false\)/);
  assert.match(source, /\{action && \(/);
});

test('"Mark all as read" sends only the drawer\'s current filters, and is disabled when nothing visible is unread', () => {
  assert.match(source, /markAllDisabled = !filtered\.some\(\(n\) => n\.readAt === null\)/);
  assert.match(source, /disabled=\{markAllDisabled\}/);
  assert.match(source, /read: false,/);
});

test('changing any filter resets pagination to page 1', () => {
  assert.match(source, /function updateFilter\(patch: Partial<NotificationDrawerFilter>\) \{\s*setFilter\(\(f\) => \(\{ \.\.\.f, \.\.\.patch \}\)\);\s*setPage\(1\);/);
});

test('rows are paginated 10 at a time with a "Load more (x of y remaining)" control', () => {
  assert.match(source, /const PAGE_SIZE = 10;/);
  assert.match(source, /Load more \(\{remaining\} of \{rows\.length\} remaining\)/);
});

test('empty states use the template\'s own wording for the Read tab, and a generic "caught up" message otherwise', () => {
  assert.match(source, /Nothing here yet\. Notifications you read will show up here\./);
  // The same branch covers both a genuinely-empty Unread tab and a severity/project/state filter
  // that happens to match nothing — `rows.length === 0` doesn't distinguish why, and the drawer's
  // own filter row (a specific severity/project combination showing no results) already makes the
  // "why" visible without a second wording.
  assert.match(source, /Nothing here\. You’re all caught up\./);
  assert.match(source, /rows\.length === 0 \? \(/);
});

test('opens via the existing notificationCenterOpen/closeNotificationCenter API', () => {
  assert.match(source, /notificationCenterOpen = useWorldStore\(\(s\) => s\.notificationCenterOpen\)/);
  assert.match(source, /closeNotificationCenter = useWorldStore\(\(s\) => s\.closeNotificationCenter\)/);
  assert.match(source, /if \(!notificationCenterOpen\) return null;/);
});
