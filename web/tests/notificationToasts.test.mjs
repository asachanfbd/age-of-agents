import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  TOAST_AUTO_DISMISS_MS,
  shouldPersistToast,
  notificationsToToast,
} from '../src/lib/notificationToasts.ts';

const toastSource = await readFile(new URL('../src/ui/NotificationToasts.tsx', import.meta.url), 'utf8');

function makeNotification(overrides = {}) {
  return {
    id: 'n1', kind: 'task.failed', severity: 'warning',
    subject: { type: 'task', projectId: 'p1', conversationId: 'conv-1', taskId: 'task-1' },
    projectId: 'p1',
    title: 'Task failed: do the thing', description: 'Needs input',
    readAt: null, resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('shouldPersistToast is true only for critical — info and warning auto-dismiss', () => {
  assert.equal(shouldPersistToast('critical'), true);
  assert.equal(shouldPersistToast('warning'), false);
  assert.equal(shouldPersistToast('info'), false);
});

test('TOAST_AUTO_DISMISS_MS is a positive, finite duration', () => {
  assert.ok(Number.isFinite(TOAST_AUTO_DISMISS_MS));
  assert.ok(TOAST_AUTO_DISMISS_MS > 0);
});

test('notificationsToToast returns unread+unresolved ids never toasted before', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
    b: makeNotification({ id: 'b', updatedAt: '2026-01-01T00:00:00.000Z' }),
    c: makeNotification({ id: 'c', resolvedAt: '2026-01-01T00:00:00.000Z' }),
  };
  const result = notificationsToToast(notificationsById, new Map());
  assert.deepEqual(result.map((n) => n.id).sort(), ['a', 'b']);
});

test('notificationsToToast excludes an id already toasted at its current updatedAt', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
  };
  const lastToasted = new Map([['a', '2026-01-01T00:00:00.000Z']]);
  assert.deepEqual(notificationsToToast(notificationsById, lastToasted), []);
});

test('notificationsToToast re-includes an id toasted before but updated since (a recurrence) while still unread+unresolved', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', updatedAt: '2026-01-02T00:00:00.000Z' }),
  };
  const lastToasted = new Map([['a', '2026-01-01T00:00:00.000Z']]);
  assert.deepEqual(notificationsToToast(notificationsById, lastToasted).map((n) => n.id), ['a']);
});

test('notificationsToToast excludes a read notification even with a newer updatedAt (a content-only update the user already reviewed)', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', readAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }),
  };
  const lastToasted = new Map([['a', '2026-01-01T00:00:00.000Z']]);
  assert.deepEqual(notificationsToToast(notificationsById, lastToasted), []);
});

test('notificationsToToast excludes a resolved notification', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', resolvedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }),
  };
  assert.deepEqual(notificationsToToast(notificationsById, new Map()), []);
});

test('notificationsToToast returns nothing for an empty notificationsById', () => {
  assert.deepEqual(notificationsToToast({}, new Map()), []);
});

test('the component baselines on first load, toasts new arrivals and recurrences, dismisses on read/resolve, and the action is the quick action when there is one', () => {
  assert.match(toastSource, /import \{ toast \} from 'sonner'/);
  assert.match(toastSource, /baselinedRef\.current = true/);
  assert.match(toastSource, /lastToastedRef\.current\.set\(n\.id, n\.updatedAt\)/);
  assert.match(toastSource, /toast\.dismiss\(id\)/);
  assert.match(toastSource, /quickActionFor\(notification\)/);
  assert.match(toastSource, /closeButton: notification\.severity === 'critical'/);
  assert.match(toastSource, /closeButtonAriaLabel: `Close notification: \$\{notification\.title\}`/);
  assert.match(toastSource, /label: quickAction\?\.label \?\? 'Open'/);
  assert.match(toastSource, /toast\.error\(notification\.title, options\)/);
  assert.doesNotMatch(toastSource, /notificationToastDestination/);
});

// ---- Toasts stay interactive over modals (task 22.003) ----
import { isToastTarget, TOAST_ATTRIBUTE } from '../src/lib/notificationToasts.ts';
import { isStatusFooterTarget, STATUS_FOOTER_ATTRIBUTE } from '../src/lib/statusFooter.ts';

const withAncestor = (attribute) => ({ closest: (selector) => (selector === `[${attribute}]` ? {} : null) });
const readSrc = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('isToastTarget: null, no-closest and unrelated targets are false', () => {
  assert.equal(isToastTarget(null), false);
  assert.equal(isToastTarget({}), false);
  assert.equal(isToastTarget({ closest: () => null }), false);
});

test('isToastTarget: true for a descendant of a toast, independent of the footer helper', () => {
  assert.equal(isToastTarget(withAncestor(TOAST_ATTRIBUTE)), true);
  assert.equal(isStatusFooterTarget(withAncestor(TOAST_ATTRIBUTE)), false);
  assert.equal(isToastTarget(withAncestor(STATUS_FOOTER_ATTRIBUTE)), false);
});

test('regression: only critical persists; unknown severity does not; timer unchanged', () => {
  assert.equal(shouldPersistToast('critical'), true);
  assert.equal(shouldPersistToast(''), false);
  assert.equal(TOAST_AUTO_DISMISS_MS, 6000);
});

test('dialog and sheet ignore toast and footer outside interactions and forward the caller handler', async () => {
  for (const file of ['../src/components/ui/dialog.tsx', '../src/components/ui/sheet.tsx']) {
    const src = await readSrc(file);
    assert.match(src, /isStatusFooterTarget\(event\.target\) \|\| isToastTarget\(event\.target\)\) event\.preventDefault\(\)/, file);
    assert.match(src, /onInteractOutside\?\.\(event\)/, file);
  }
});

test('the toast layer opts toasts (not the whole layer) into pointer events', async () => {
  const css = await readSrc('../src/index.css');
  assert.ok(css.includes(`[${TOAST_ATTRIBUTE}] {\n  pointer-events: auto;`));
  assert.doesNotMatch(css, /\.toaster\s*{[^}]*pointer-events/);
  const sonner = await readSrc('../src/components/ui/sonner.tsx');
  assert.doesNotMatch(sonner.replace(/pointer-events-none opacity-0[^"]*/, ''), /pointer-events-none/);
});

test('stacking is unchanged: modal z-150, footer z-160, toaster mounted with its offsets', async () => {
  assert.match(await readSrc('../src/components/ui/dialog.tsx'), /z-\[150\]/);
  assert.match(await readSrc('../src/components/ui/sheet.tsx'), /z-\[150\]/);
  assert.match(await readSrc('../src/ui/StatusFooter.tsx'), /z-\[160\]/);
  const app = await readSrc('../src/App.tsx');
  assert.match(app, /offset=\{\{ bottom: STATUS_FOOTER_HEIGHT \+ 20, left: 24 \}\}/);
  assert.match(app, /mobileOffset=/);
});

test('toast actions never close a modal', () => {
  assert.doesNotMatch(toastSource, /closeProject|setOpen\(false\)/);
});

test('blueprint documents toasts staying interactive over modals', async () => {
  const doc = await readSrc('../../.docs/blueprint.md');
  assert.match(doc, /toasts stay interactive over modals/i);
});
