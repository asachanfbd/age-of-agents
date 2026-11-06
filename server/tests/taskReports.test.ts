import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanItemRecord, WorkflowRunRecord } from '../src/domain/types.ts';
import { migrateLinkGrants } from '../src/connections/grantsMigration.ts';
import { boardNumber, cut, listCompleted, parseCompletedFilter, parseTaskRef, phaseOf, statusOf } from '../src/connections/taskReports.ts';

const item = (patch: Partial<PlanItemRecord> = {}) => ({ id: 'i1', projectId: 'p', title: 'T', description: '', status: 'pending', order: 1, taskIds: [], milestoneId: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...patch }) as PlanItemRecord;
const run = (status: string, patch: Record<string, unknown> = {}) => ({ id: 'r1', status, completedAt: null, ...patch }) as unknown as WorkflowRunRecord;

test('U1-U13 status and phase follow the board: runs, waiting, merge hold, archive, and unknown values do not throw', () => {
  const cases: Array<[PlanItemRecord, WorkflowRunRecord | undefined, string, string]> = [
    [item(), undefined, 'ready', 'not-started'],
    [item({ waiting: { state: 'waiting' } as never }), undefined, 'waiting', 'not-started'],
    [item({ status: 'blocked' }), undefined, 'waiting-for-input', 'in-progress'],
    [item({ status: 'failed' }), undefined, 'failed', 'in-progress'],
    [item({ status: 'stopped' }), undefined, 'stopped', 'in-progress'],
    [item(), run('starting'), 'running', 'in-progress'],
    [item(), run('completing'), 'running', 'in-progress'],
    [item(), run('awaiting-approval'), 'awaiting-approval', 'in-progress'],
    [item(), run('needs-attention'), 'needs-attention', 'in-progress'],
    [item(), run('failed'), 'failed', 'in-progress'],
    [item(), run('stopped'), 'stopped', 'in-progress'],
    [item({ status: 'done' }), undefined, 'completed', 'completed'],
    [item(), run('completed'), 'completed', 'completed'],
    [item({ status: 'done', archived: true }), undefined, 'archived', 'completed'],
    [item({ archived: true }), undefined, 'archived', 'not-started'],
    [item({ archived: true }), run('failed'), 'archived', 'in-progress'],
    [item({ status: 'done', workflowRunId: 'r1', autoMerge: { enabled: true, state: 'merging' } as never }), run('completed'), 'waiting', 'in-progress'],
    [item({ status: 'done', workflowRunId: 'r1', autoMerge: { enabled: true, state: 'merged' } as never }), run('completed'), 'completed', 'completed'],
    [item({ status: 'weird' as never }), run('mystery'), 'ready', 'not-started'],
  ];
  for (const [i, r, status, phase] of cases) assert.deepEqual([statusOf(i, r), phaseOf(i, r)], [status, phase], JSON.stringify([i.status, r?.status]));
});

test('U29 a cut never splits a surrogate pair and flags only when it cut', () => {
  assert.deepEqual(cut('ab😀', 3), { text: 'ab😀', truncated: false });
  assert.deepEqual(cut('ab😀c', 3), { text: 'ab😀', truncated: true });
});

test('U34-U37 exactly one of id and number, trimmed, never empty', () => {
  assert.deepEqual(parseTaskRef({ id: ' a ' }), { id: 'a' });
  assert.deepEqual(parseTaskRef({ number: '10.017' }), { number: '10.017' });
  for (const bad of [{}, { id: 'a', number: '1' }, { id: ' ' }]) assert.throws(() => parseTaskRef(bad), { status: 400 });
});

test('boardNumber uses a bug title number before the planning reference and pads the task part', () => {
  assert.equal(boardNumber(item({ planningRef: { session: 4, task: 2 } })), '4.002');
  assert.equal(boardNumber(item({ title: 'B.004: Crash', planningRef: { session: 4, task: 2 } })), 'B.004');
  assert.equal(boardNumber(item()), null);
});

test('U41-U44 list filters: defaults, a tampered or foreign cursor and date forms', () => {
  assert.equal(parseCompletedFilter({}).limit, 20);
  assert.equal(parseCompletedFilter({ since: '2026-10-12T09:30:00+05:30' }).since, parseCompletedFilter({ since: '2026-10-12T04:00:00Z' }).since);
  assert.throws(() => parseCompletedFilter({ since: '1700000000' }), { status: 400 });
  assert.throws(() => parseCompletedFilter({ cursor: 'not-base64-json' }), { status: 400 });
  const done = ['a', 'b'].map((id) => item({ id, status: 'done' }));
  const first = listCompleted(done, () => undefined, { limit: 1 });
  assert.throws(() => parseCompletedFilter({ cursor: first.nextCursor, since: '2026-01-01' }), { status: 400 });
  assert.throws(() => parseCompletedFilter({ cursor: Buffer.from('{"at":"x"}').toString('base64url') }), { status: 400 });
  assert.deepEqual(parseCompletedFilter({ cursor: first.nextCursor }).cursor?.id, 'a');
});

test('U49 nextCursor is absent when the remaining items exactly fill the page', () => {
  const done = ['a', 'b'].map((id) => item({ id, status: 'done' }));
  assert.equal(listCompleted(done, () => undefined, { limit: 2 }).nextCursor, undefined);
  assert.equal(listCompleted([], () => undefined, { limit: 2 }).total, 0);
});

test('U52-U58 migration adds the two ids once, keeps choices and pre-approval, and skips a type without them', () => {
  const type = { capabilities: [{ id: 'get-task-details' }, { id: 'list-completed-tasks' }, { id: 'x' }] } as never;
  const link = { id: 'l', capabilities: [{ capabilityId: 'x', preApproved: true }], events: ['e'] } as never;
  const migrated = migrateLinkGrants(link, type)!;
  assert.deepEqual(migrated.capabilities.map((g: any) => [g.capabilityId, g.preApproved]), [['x', true], ['get-task-details', false], ['list-completed-tasks', false]]);
  assert.deepEqual([migrated.grantsVersion, migrated.events], [1, ['e']]);
  assert.equal(migrateLinkGrants(migrated, type), null);
  assert.deepEqual(migrateLinkGrants(link, { capabilities: [{ id: 'x' }] } as never)!.capabilities.length, 1);
  assert.deepEqual(migrateLinkGrants(link, undefined)!.capabilities.length, 1);
});
