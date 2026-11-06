import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_NOTIFICATION_DRAWER_FILTER,
  countUnreadNotifications,
  filterNotifications,
  isAttention,
  matchesNotificationFilter,
  quickActionFor,
  sameSubjectIdentity,
} from '../src/lib/notificationCenter.ts';

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

test('isAttention is true only when unread and unresolved', () => {
  assert.equal(isAttention(makeNotification({ readAt: null, resolvedAt: null })), true);
  assert.equal(isAttention(makeNotification({ readAt: '2026-01-01T00:00:00.000Z', resolvedAt: null })), false);
  assert.equal(isAttention(makeNotification({ readAt: null, resolvedAt: '2026-01-01T00:00:00.000Z' })), false);
  assert.equal(isAttention(makeNotification({ readAt: '2026-01-01T00:00:00.000Z', resolvedAt: '2026-01-01T00:00:00.000Z' })), false);
});

test('countUnreadNotifications counts unread regardless of resolved state', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', readAt: null, resolvedAt: null }),
    b: makeNotification({ id: 'b', readAt: null, resolvedAt: '2026-01-01T00:00:00.000Z' }),
    c: makeNotification({ id: 'c', readAt: '2026-01-01T00:00:00.000Z', resolvedAt: null }),
  };
  assert.equal(countUnreadNotifications(notificationsById), 2);
});

test('countUnreadNotifications is 0 for an empty store', () => {
  assert.equal(countUnreadNotifications({}), 0);
});

test('sameSubjectIdentity compares type plus the field that names the thing — never taskId/runId', () => {
  const a = { type: 'task', projectId: 'p1', conversationId: 'conv-1', taskId: 'task-old' };
  const b = { type: 'task', projectId: 'p1', conversationId: 'conv-1', taskId: 'task-new' };
  assert.equal(sameSubjectIdentity(a, b), true, 'same conversationId, different taskId — still the same subject');
  assert.equal(sameSubjectIdentity(a, { ...a, conversationId: 'conv-2' }), false);
  assert.equal(sameSubjectIdentity({ type: 'project', projectId: 'p1' }, { type: 'command', projectId: 'p1', commandId: 'c1', runId: 'r1' }), false, 'different types never match');
});

test('matchesNotificationFilter mirrors the server-side filter semantics', () => {
  const n = makeNotification({ severity: 'critical', projectId: 'p1', readAt: null, resolvedAt: null });
  assert.equal(matchesNotificationFilter(n, {}), true);
  assert.equal(matchesNotificationFilter(n, { resolved: false }), true);
  assert.equal(matchesNotificationFilter(n, { resolved: true }), false);
  assert.equal(matchesNotificationFilter(n, { read: false }), true);
  assert.equal(matchesNotificationFilter(n, { severity: 'critical' }), true);
  assert.equal(matchesNotificationFilter(n, { severity: 'warning' }), false);
  assert.equal(matchesNotificationFilter(n, { projectId: 'p1' }), true);
  assert.equal(matchesNotificationFilter(n, { projectId: 'p2' }), false);
  assert.equal(matchesNotificationFilter(makeNotification({ projectId: null }), { projectId: 'none' }), true);
  assert.equal(matchesNotificationFilter(n, { projectId: 'none' }), false);
});

test('DEFAULT_NOTIFICATION_DRAWER_FILTER defaults to any state, any severity, every project', () => {
  assert.deepEqual(DEFAULT_NOTIFICATION_DRAWER_FILTER, { state: 'all', severity: 'all', project: 'all' });
});

test('filterNotifications with the default filter returns everything, newest first by updatedAt', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
    b: makeNotification({ id: 'b', updatedAt: '2026-01-02T00:00:00.000Z', resolvedAt: '2026-01-02T00:00:00.000Z' }),
    c: makeNotification({ id: 'c', updatedAt: '2026-01-03T00:00:00.000Z' }),
  };
  const result = filterNotifications(notificationsById, DEFAULT_NOTIFICATION_DRAWER_FILTER);
  assert.deepEqual(result.map((n) => n.id), ['c', 'b', 'a']);
});

test('filterNotifications "active" state is unresolved only; "resolved" is resolved only', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', resolvedAt: null }),
    b: makeNotification({ id: 'b', resolvedAt: '2026-01-01T00:00:00.000Z' }),
  };
  assert.deepEqual(filterNotifications(notificationsById, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, state: 'active' }).map((n) => n.id), ['a']);
  assert.deepEqual(filterNotifications(notificationsById, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, state: 'resolved' }).map((n) => n.id), ['b']);
});

test('filterNotifications narrows by severity', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', severity: 'info' }),
    b: makeNotification({ id: 'b', severity: 'critical' }),
  };
  const result = filterNotifications(notificationsById, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, severity: 'critical' });
  assert.deepEqual(result.map((n) => n.id), ['b']);
});

test('filterNotifications "project: none" returns only the one project-less subject (a skill install)', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', projectId: 'p1' }),
    b: makeNotification({ id: 'b', projectId: null, subject: { type: 'skill', repo: 'x/y' } }),
    c: makeNotification({ id: 'c', projectId: 'p2' }),
  };
  const result = filterNotifications(notificationsById, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, project: 'none' });
  assert.deepEqual(result.map((n) => n.id), ['b']);
});

test('filterNotifications narrows by a specific project id', () => {
  const notificationsById = {
    a: makeNotification({ id: 'a', projectId: 'p1' }),
    b: makeNotification({ id: 'b', projectId: 'p2' }),
  };
  const result = filterNotifications(notificationsById, { ...DEFAULT_NOTIFICATION_DRAWER_FILTER, project: 'p1' });
  assert.deepEqual(result.map((n) => n.id), ['a']);
});

test('quickActionFor maps each kind to its one quick action, only while unresolved', () => {
  assert.deepEqual(quickActionFor(makeNotification({ kind: 'task.needs_input' })), { kind: 'reply', label: 'Reply' });
  assert.deepEqual(quickActionFor(makeNotification({ kind: 'task.failed' })), { kind: 'retry', label: 'Retry' });
  assert.deepEqual(quickActionFor(makeNotification({ kind: 'command.failed' })), { kind: 'run-again', label: 'Run again' });
  assert.deepEqual(quickActionFor(makeNotification({ kind: 'git.out_of_sync' })), { kind: 'sync', label: 'Sync' });
  assert.deepEqual(quickActionFor(makeNotification({ kind: 'git.auto_pull_failed' })), { kind: 'sync', label: 'Sync' });
  assert.equal(quickActionFor(makeNotification({ kind: 'task.completed' })), null);
  assert.equal(quickActionFor(makeNotification({ kind: 'skill.install_failed' })), null);
  assert.equal(quickActionFor(makeNotification({ kind: 'task.failed', resolvedAt: '2026-01-01T00:00:00.000Z' })), null, 'none once resolved');
});
