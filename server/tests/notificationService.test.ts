import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { NotificationRecord, NotificationSubject } from '../src/domain/types.ts';

let notificationService: typeof import('../src/notifications/notificationService.ts');
let notificationsDb: typeof import('../src/db/collections.ts')['notificationsDb'];
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'notification-service-test-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  notificationService = await import('../src/notifications/notificationService.ts');
  ({ notificationsDb } = await import('../src/db/collections.ts'));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const taskSubject = (conversationId: string, projectId = 'proj-a', taskId = conversationId): NotificationSubject =>
  ({ type: 'task', projectId, conversationId, taskId });

test('raiseNotification inserts a brand-new kind+subject with readAt/resolvedAt null, the derived projectId, and the fixed severity for its kind', async () => {
  const n = await notificationService.raiseNotification({
    kind: 'task.needs_input',
    subject: taskSubject('conv-1'),
    title: 'Needs your input: do the thing',
    description: 'What should I do?',
  });
  assert.equal(n.readAt, null);
  assert.equal(n.resolvedAt, null);
  assert.equal(n.projectId, 'proj-a');
  assert.equal(n.severity, 'warning');
});

test('severity is fixed per kind, one case per kind', async () => {
  const cases: { kind: Parameters<typeof notificationService.raiseNotification>[0]['kind']; severity: string; subject: NotificationSubject }[] = [
    { kind: 'task.needs_input', severity: 'warning', subject: taskSubject('sev-needs-input') },
    { kind: 'task.failed', severity: 'critical', subject: taskSubject('sev-failed') },
    { kind: 'task.completed', severity: 'info', subject: taskSubject('sev-completed') },
    { kind: 'command.failed', severity: 'warning', subject: { type: 'command', projectId: 'proj-a', commandId: 'sev-cmd', runId: 'run-1' } },
    { kind: 'git.out_of_sync', severity: 'warning', subject: { type: 'project', projectId: 'proj-sev-sync' } },
    { kind: 'skill.install_failed', severity: 'warning', subject: { type: 'skill', repo: 'owner/sev-repo' } },
  ];
  for (const { kind, severity, subject } of cases) {
    const n = await notificationService.raiseNotification({ kind, subject, title: 't', description: 'd' });
    assert.equal(n.severity, severity, kind);
  }
});

test('raiseNotification dedupes: a second raise with the same kind + subject identity updates in place, re-nulls readAt, and does not insert a second record', async () => {
  const first = await notificationService.raiseNotification({
    kind: 'task.failed', subject: taskSubject('conv-dedupe', 'proj-a', 'task-1'), title: 'Task failed: v1', description: 'first reason',
  });
  await notificationService.markNotificationsRead([first.id]);
  const second = await notificationService.raiseNotification({
    kind: 'task.failed', subject: taskSubject('conv-dedupe', 'proj-a', 'task-2'), title: 'Task failed: v2', description: 'second reason',
  });
  assert.equal(second.id, first.id);
  assert.equal(second.title, 'Task failed: v2');
  assert.equal(second.description, 'second reason');
  assert.equal((second.subject as { taskId: string }).taskId, 'task-2');
  assert.equal(second.readAt, null, 're-unread: this is a fresh occurrence');

  const all = await notificationsDb.find((n) => (n.subject as { conversationId?: string }).conversationId === 'conv-dedupe');
  assert.equal(all.length, 1);
});

test('raiseNotification for a different identity (different conversationId) creates a second, independent record', async () => {
  const a = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-indep-a'), title: 'A', description: 'a' });
  const b = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-indep-b'), title: 'B', description: 'b' });
  assert.notEqual(a.id, b.id);
});

test('raiseNotification against an existing resolved notification of the same kind+identity inserts a new, separate unresolved record and leaves the resolved one untouched', async () => {
  const subject = taskSubject('conv-resolved-reraise');
  const first = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 'first', description: 'd1' });
  await notificationService.resolveNotifications(subject, ['task.needs_input']);
  const resolvedFirst = await notificationService.getNotification(first.id);
  assert.ok(resolvedFirst.resolvedAt);

  const second = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 'second', description: 'd2' });
  assert.notEqual(second.id, first.id);
  assert.equal(second.resolvedAt, null);

  const stillResolved = await notificationService.getNotification(first.id);
  assert.equal(stillResolved.title, 'first', 'the resolved record is untouched');
  assert.ok(stillResolved.resolvedAt);
});

test('taskId/runId are not part of subject identity: raising task.completed again for the same conversationId but a newer taskId updates the same record', async () => {
  const first = await notificationService.raiseNotification({
    kind: 'task.completed', subject: taskSubject('conv-chain', 'proj-a', 'task-old'), title: 'Task completed: v1', description: 'd',
  });
  const second = await notificationService.raiseNotification({
    kind: 'task.completed', subject: taskSubject('conv-chain', 'proj-a', 'task-new'), title: 'Task completed: v2', description: 'd2',
  });
  assert.equal(second.id, first.id);
  assert.equal((second.subject as { taskId: string }).taskId, 'task-new');
});

test('resolveNotifications resolves every unresolved notification matching the subject identity, sets resolvedAt and readAt, leaves already-resolved records untouched, and leaves other subjects alone', async () => {
  const subject = taskSubject('conv-resolve-many');
  const n1 = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 't1', description: 'd1' });
  const n2 = await notificationService.raiseNotification({ kind: 'task.failed', subject, title: 't2', description: 'd2' });
  const other = await notificationService.raiseNotification({ kind: 'task.needs_input', subject: taskSubject('conv-other'), title: 'o', description: 'd' });

  await notificationService.resolveNotifications(subject);

  const resolved1 = await notificationService.getNotification(n1.id);
  const resolved2 = await notificationService.getNotification(n2.id);
  assert.ok(resolved1.resolvedAt);
  assert.ok(resolved1.readAt);
  assert.ok(resolved2.resolvedAt);
  assert.ok(resolved2.readAt);

  const untouchedOther = await notificationService.getNotification(other.id);
  assert.equal(untouchedOther.resolvedAt, null, 'a different subject is left alone');

  const beforeUpdatedAt = resolved1.updatedAt;
  await notificationService.resolveNotifications(subject);
  const stillResolved1 = await notificationService.getNotification(n1.id);
  assert.equal(stillResolved1.updatedAt, beforeUpdatedAt, 'an already-resolved record is untouched (no updatedAt churn)');
});

test('resolveNotifications with a kinds filter only resolves the listed kind(s), leaving other kinds for the same subject open', async () => {
  const subject = taskSubject('conv-kind-filter');
  const needsInput = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 't', description: 'd' });
  const failed = await notificationService.raiseNotification({ kind: 'task.failed', subject, title: 't', description: 'd' });

  await notificationService.resolveNotifications(subject, ['task.failed']);

  assert.equal((await notificationService.getNotification(failed.id)).resolvedAt !== null, true);
  assert.equal((await notificationService.getNotification(needsInput.id)).resolvedAt, null, 'task.needs_input for the same conversation stays open');
});

test('resolveNotifications on a subject with no matching notification is a no-op: it does not throw', async () => {
  await notificationService.resolveNotifications(taskSubject('conv-never-existed'));
});

test('markNotificationsRead sets readAt on exactly the given ids, leaves resolvedAt untouched, ignores an unknown id, and handles an empty array', async () => {
  const a = await notificationService.raiseNotification({ kind: 'task.needs_input', subject: taskSubject('conv-read-a'), title: 'a', description: 'd' });
  const b = await notificationService.raiseNotification({ kind: 'task.needs_input', subject: taskSubject('conv-read-b'), title: 'b', description: 'd' });

  await notificationService.markNotificationsRead([]);
  assert.equal((await notificationService.getNotification(a.id)).readAt, null);

  await notificationService.markNotificationsRead([a.id, 'no-such-id']);
  assert.ok((await notificationService.getNotification(a.id)).readAt);
  assert.equal((await notificationService.getNotification(b.id)).readAt, null);
  assert.equal((await notificationService.getNotification(a.id)).resolvedAt, null);
});

test('markNotificationsRead on an unresolved task.completed also resolves it; on an already-resolved one it is a no-op on resolvedAt', async () => {
  const subject = taskSubject('conv-completed-read');
  const n = await notificationService.raiseNotification({ kind: 'task.completed', subject, title: 't', description: 'd' });
  const read = await (async () => { await notificationService.markNotificationsRead([n.id]); return notificationService.getNotification(n.id); })();
  assert.ok(read.readAt);
  assert.ok(read.resolvedAt, 'reading a task.completed resolves it');

  const resolvedAtFirst = read.resolvedAt;
  await notificationService.markNotificationsRead([n.id]);
  const again = await notificationService.getNotification(n.id);
  assert.equal(again.resolvedAt, resolvedAtFirst, 'already resolved — no-op on resolvedAt');
});

test('markNotificationsRead on non-completed kinds does not auto-resolve', async () => {
  const n = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-no-autoresolve'), title: 't', description: 'd' });
  await notificationService.markNotificationsRead([n.id]);
  const read = await notificationService.getNotification(n.id);
  assert.ok(read.readAt);
  assert.equal(read.resolvedAt, null);
});

test('markNotificationUnread sets readAt back to null, does not touch resolvedAt, and is a non-throwing no-op for an unknown id', async () => {
  const subject = taskSubject('conv-unread');
  const n = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 't', description: 'd' });
  await notificationService.resolveNotifications(subject, ['task.needs_input']);
  const resolved = await notificationService.getNotification(n.id);
  assert.ok(resolved.readAt);
  assert.ok(resolved.resolvedAt);

  await notificationService.markNotificationUnread(n.id);
  const unread = await notificationService.getNotification(n.id);
  assert.equal(unread.readAt, null);
  assert.ok(unread.resolvedAt, 'unread-but-resolved is a valid, reachable state');

  await notificationService.markNotificationUnread('no-such-id');
});

test('markSubjectRead marks every notification matching that subject identity (any kind) read in one call, respecting the task.completed-resolves-on-read rule, and is a no-op for a subject with no match', async () => {
  const subject = taskSubject('conv-subject-read');
  const needsInput = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 't', description: 'd' });
  const completed = await notificationService.raiseNotification({ kind: 'task.completed', subject, title: 't', description: 'd' });

  await notificationService.markSubjectRead(subject);

  assert.ok((await notificationService.getNotification(needsInput.id)).readAt);
  const readCompleted = await notificationService.getNotification(completed.id);
  assert.ok(readCompleted.readAt);
  assert.ok(readCompleted.resolvedAt);

  await notificationService.markSubjectRead(taskSubject('conv-never-seen'));
});

test('markAllRead marks read only the notifications matching the filter, leaving the rest unread', async () => {
  const projectId = `proj-mark-all-${Date.now()}`;
  const critical = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-mark-all-crit', projectId), title: 't', description: 'd' });
  const info = await notificationService.raiseNotification({ kind: 'task.completed', subject: taskSubject('conv-mark-all-info', projectId), title: 't', description: 'd' });
  const otherProject = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-mark-all-other', 'some-other-project'), title: 't', description: 'd' });

  await notificationService.markAllRead({ severity: 'critical', projectId });

  assert.ok((await notificationService.getNotification(critical.id)).readAt);
  assert.equal((await notificationService.getNotification(info.id)).readAt, null, 'a different severity in the same filter is untouched');
  assert.equal((await notificationService.getNotification(otherProject.id)).readAt, null, 'a different project is untouched');
});

test('markAllRead with projectId "none" only affects the one project-less subject (a skill install)', async () => {
  const skill = await notificationService.raiseNotification({ kind: 'skill.install_failed', subject: { type: 'skill', repo: 'owner/none-filter' }, title: 't', description: 'd' });
  const projectScoped = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-none-filter'), title: 't', description: 'd' });

  await notificationService.markAllRead({ projectId: 'none' });

  assert.ok((await notificationService.getNotification(skill.id)).readAt);
  assert.equal((await notificationService.getNotification(projectScoped.id)).readAt, null);
});

test('markAllRead with no filter marks everything unread as read', async () => {
  const a = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-mark-all-empty-a'), title: 't', description: 'd' });
  const b = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-mark-all-empty-b'), title: 't', description: 'd' });
  await notificationService.markAllRead();
  assert.ok((await notificationService.getNotification(a.id)).readAt);
  assert.ok((await notificationService.getNotification(b.id)).readAt);
});

test('markAllRead combining resolved=false + severity only touches unresolved notifications of that severity', async () => {
  const projectId = `proj-combo-${Date.now()}`;
  const open = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-combo-open', projectId), title: 't', description: 'd' });
  const resolvedSubject = taskSubject('conv-combo-resolved', projectId);
  const resolved = await notificationService.raiseNotification({ kind: 'task.failed', subject: resolvedSubject, title: 't', description: 'd' });
  await notificationService.resolveNotifications(resolvedSubject, ['task.failed']);
  await notificationService.markNotificationUnread(resolved.id);

  await notificationService.markAllRead({ resolved: false, severity: 'critical', projectId });

  assert.ok((await notificationService.getNotification(open.id)).readAt);
  assert.equal((await notificationService.getNotification(resolved.id)).readAt, null, 'resolved=false excludes the resolved one even though it is unread');
});

test('listNotifications returns newest-first by updatedAt (a dedupe-updated old record sorts as if new)', async () => {
  const subject = taskSubject('conv-sort-old');
  const old = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 'old', description: 'd' });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const newer = await notificationService.raiseNotification({ kind: 'task.needs_input', subject: taskSubject('conv-sort-new'), title: 'new', description: 'd' });
  await new Promise((resolve) => setTimeout(resolve, 2));
  // Re-raising the OLD one bumps its updatedAt past the newer one's.
  const touched = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 'old again', description: 'd' });
  assert.equal(touched.id, old.id);

  const projectId = (await notificationService.getNotification(newer.id)).projectId!;
  const all = await notificationService.listNotifications({ projectId });
  const ids = all.map((n) => n.id);
  assert.ok(ids.indexOf(touched.id) < ids.indexOf(newer.id), 'the re-raised (now-newest) record sorts first');
});

test('listNotifications filters by resolved/read/severity/projectId, including projectId "none"', async () => {
  const projectId = `proj-filters-${Date.now()}`;
  const resolvedN = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-filters-resolved', projectId), title: 't', description: 'd' });
  await notificationService.resolveNotifications(taskSubject('conv-filters-resolved', projectId), ['task.failed']);
  const openN = await notificationService.raiseNotification({ kind: 'task.needs_input', subject: taskSubject('conv-filters-open', projectId), title: 't', description: 'd' });
  const skillN = await notificationService.raiseNotification({ kind: 'skill.install_failed', subject: { type: 'skill', repo: 'owner/filters-repo' }, title: 't', description: 'd' });

  const resolvedOnly = await notificationService.listNotifications({ projectId, resolved: true });
  assert.deepEqual(resolvedOnly.map((n) => n.id), [resolvedN.id]);

  const unresolvedOnly = await notificationService.listNotifications({ projectId, resolved: false });
  assert.deepEqual(unresolvedOnly.map((n) => n.id), [openN.id]);

  const unreadOnly = await notificationService.listNotifications({ projectId, read: false });
  assert.ok(unreadOnly.some((n) => n.id === openN.id));

  const severityOnly = await notificationService.listNotifications({ severity: 'warning', projectId });
  assert.ok(severityOnly.every((n) => n.severity === 'warning'));

  const none = await notificationService.listNotifications({ projectId: 'none' });
  assert.ok(none.some((n) => n.id === skillN.id));
  assert.ok(none.every((n) => n.projectId === null));
});

test('every raise/resolve/mark-read/mark-all call emits exactly one onNotificationEvent with the final record state; unsubscribing stops further emits', async () => {
  const events: NotificationRecord[] = [];
  const unsubscribe = notificationService.onNotificationEvent((event) => events.push(event.notification));

  const subject = taskSubject('conv-emit');
  const raised = await notificationService.raiseNotification({ kind: 'task.needs_input', subject, title: 't', description: 'd' });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], raised);

  await notificationService.resolveNotifications(subject, ['task.needs_input']);
  assert.equal(events.length, 2);

  await notificationService.markNotificationUnread(raised.id);
  assert.equal(events.length, 3);

  unsubscribe();
  await notificationService.markNotificationsRead([raised.id]);
  assert.equal(events.length, 3, 'no further emits once unsubscribed');
});

test('pruneNotifications deletes only read+resolved notifications older than NOTIFICATION_RETENTION_MS, keeping resolved-but-unread, read-but-unresolved, and recently-resolved ones', async () => {
  const { NOTIFICATION_RETENTION_MS } = await import('../src/domain/types.ts');
  const now = Date.now();
  const old = now - NOTIFICATION_RETENTION_MS - 1000;
  const boundary = now - NOTIFICATION_RETENTION_MS + 5000; // just under the boundary — kept

  const base = {
    id: '', kind: 'task.failed' as const, severity: 'critical' as const, subject: { type: 'project' as const, projectId: 'prune-proj' },
    projectId: 'prune-proj', title: 't', description: 'd', createdAt: new Date(old).toISOString(), updatedAt: new Date(old).toISOString(),
  };
  const oldReadResolved = { ...base, id: 'prune-old-read-resolved', readAt: new Date(old).toISOString(), resolvedAt: new Date(old).toISOString() };
  const resolvedUnread = { ...base, id: 'prune-resolved-unread', readAt: null, resolvedAt: new Date(old).toISOString() };
  const readUnresolved = { ...base, id: 'prune-read-unresolved', readAt: new Date(old).toISOString(), resolvedAt: null };
  const recentReadResolved = { ...base, id: 'prune-recent-read-resolved', readAt: new Date(boundary).toISOString(), resolvedAt: new Date(boundary).toISOString() };

  for (const record of [oldReadResolved, resolvedUnread, readUnresolved, recentReadResolved]) await notificationsDb.insert(record);

  await notificationService.pruneNotifications(now);

  assert.equal(await notificationsDb.get('prune-old-read-resolved'), undefined, 'read+resolved, older than retention — deleted');
  assert.ok(await notificationsDb.get('prune-resolved-unread'), 'resolved-but-unread — kept regardless of age');
  assert.ok(await notificationsDb.get('prune-read-unresolved'), 'read-but-unresolved — kept regardless of age');
  assert.ok(await notificationsDb.get('prune-recent-read-resolved'), 'read+resolved but under retention — kept');
});

test('legacy wipe: a notifications.json record with no kind field is deleted on load; one that already has kind survives untouched, with no attempt to backfill kind', async () => {
  const legacy = {
    id: 'legacy-no-kind', severity: 'info', originProjectId: null, originFeature: 'system',
    title: 'old shape', description: 'd', status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolvedAt: null,
  };
  await notificationsDb.insert(legacy as unknown as Parameters<typeof notificationsDb.insert>[0]);
  const modern = await notificationService.raiseNotification({ kind: 'task.failed', subject: taskSubject('conv-legacy-survivor'), title: 't', description: 'd' });

  await notificationService.pruneNotifications();

  assert.equal(await notificationsDb.get('legacy-no-kind'), undefined);
  const survivor = await notificationsDb.get(modern.id);
  assert.ok(survivor);
  assert.equal(survivor!.kind, 'task.failed');
});

/** Polls until `condition` is true or `waitUntil` times out — pruneNotifications does real async fs I/O, so a tick's effect lands a few microtasks after the timer fires. */
async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('startNotificationPruning runs once immediately, then on an unref\'d interval; its disposer clears the interval', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const legacy = (id: string) => ({
    id, severity: 'info', originProjectId: null, originFeature: 'system',
    title: 'old shape', description: 'd', status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolvedAt: null,
  }) as unknown as Parameters<typeof notificationsDb.insert>[0];

  await notificationsDb.insert(legacy('startup-tick-legacy'));
  const stop = notificationService.startNotificationPruning(1000);
  await waitUntil(async () => (await notificationsDb.get('startup-tick-legacy')) === undefined);

  await notificationsDb.insert(legacy('interval-tick-legacy'));
  t.mock.timers.tick(1000);
  await waitUntil(async () => (await notificationsDb.get('interval-tick-legacy')) === undefined);

  stop();
  await notificationsDb.insert(legacy('after-stop-legacy'));
  t.mock.timers.tick(5000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(await notificationsDb.get('after-stop-legacy'), 'the disposer clears the interval — no further ticks');

  t.mock.timers.reset();
});
