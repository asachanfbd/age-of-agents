import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContact } from '../src/crm/contacts.ts';
import { openCrmDb, repairPlannedText } from '../src/crm/db.ts';
import type { Db } from '../src/crm/db.ts';
import { createReachout, createTask } from '../src/crm/followups.ts';
import { logResponse } from '../src/crm/responses.ts';
import { listTimeline } from '../src/crm/timeline.ts';
import { harness } from './helpers/crmFakes.ts';
import type { Harness } from './helpers/crmFakes.ts';

const DAY = 86_400_000;
const ISO = /\d{4}-\d{2}-\d{2}T/;
const planned = (h: Harness, contactId: number) => listTimeline(h.ctx, contactId, 200, 0).rows.filter((e) => e.kind.endsWith('_planned'));

test('P001 a planned task entry has no ISO time in its text and carries dueAt in data', () => {
  const h = harness();
  const c = createContact(h.ctx, { name: 'Ann', channels: [{ type: 'email', handle: 'ann@x.com' }] });
  const dueAt = Date.parse('2026-10-27T09:30:00Z');
  createTask(h.ctx, c.id, { type: 'call', title: 'Call for a meeting', dueAt });
  const [entry] = planned(h, c.id);
  assert.equal(entry!.text, 'Call for a meeting planned');
  assert.doesNotMatch(entry!.text, ISO);
  assert.equal(entry!.data.dueAt, dueAt);
});

test('P002 a reachout planned entry carries dueAt and no ISO time', () => {
  const h = harness();
  const c = createContact(h.ctx, { name: 'Ann', channels: [{ type: 'instagram', handle: '@ann' }] });
  const r = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id }).followup;
  const entry = planned(h, c.id).find((e) => e.kind === 'reachout_planned')!;
  assert.doesNotMatch(entry.text, ISO);
  assert.equal(entry.data.dueAt, r.dueAt);
});

test('P003 logging interested with a next action, and later, write planned entries with dueAt', () => {
  const h = harness();
  const c = createContact(h.ctx, { name: 'Ann', channels: [{ type: 'email', handle: 'ann@x.com' }] });
  const next = h.clock.now + DAY;
  logResponse(h.ctx, c.id, { outcome: 'interested', nextAction: { type: 'call', dueAt: next } });
  const later = h.clock.now + 2 * DAY;
  const d = createContact(h.ctx, { name: 'Bo', channels: [{ type: 'email', handle: 'bo@x.com' }] });
  logResponse(h.ctx, d.id, { outcome: 'later', date: later });
  for (const [id, due] of [[c.id, next], [d.id, later]] as const) {
    const entries = planned(h, id);
    assert.ok(entries.some((e) => e.data.dueAt === due), JSON.stringify(entries));
    assert.ok(entries.every((e) => !ISO.test(e.text)));
  }
});

function insertRow(db: Db, kind: string, text: string, data: unknown): number {
  return Number(db.prepare('INSERT INTO timeline (contactId, kind, at, text, data) VALUES (1, ?, 1, ?, ?)').run(kind, text, JSON.stringify(data)).lastInsertRowid);
}
const row = (db: Db, id: number) => db.prepare('SELECT text, data, editedAt FROM timeline WHERE id = ?').get(id) as { text: string; data: string; editedAt: number | null };
const count = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM timeline').get() as { n: number }).n;

test('M001 an old planned row moves its ISO time into data.dueAt without a new entry', () => {
  const db = openCrmDb(':memory:');
  const id = insertRow(db, 'followup_planned', 'X planned for 2026-10-26T09:30:00.000Z', { followupId: 1 });
  repairPlannedText(db);
  const r = row(db, id);
  assert.equal(r.text, 'X planned');
  assert.deepEqual(JSON.parse(r.data), { followupId: 1, dueAt: Date.parse('2026-10-26T09:30:00.000Z') });
  assert.equal(r.editedAt, null);
  assert.equal(count(db), 1);
});

test('M002 a clean planned row and a comment ending in an ISO time are left untouched', () => {
  const db = openCrmDb(':memory:');
  const clean = insertRow(db, 'reachout_planned', 'Y planned', { followupId: 2, dueAt: 5 });
  const comment = insertRow(db, 'comment', 'Meeting planned for 2026-10-26T09:30:00.000Z', {});
  const before = [row(db, clean), row(db, comment)];
  repairPlannedText(db);
  assert.deepEqual([row(db, clean), row(db, comment)], before);
});

test('M003 a second run is a no-op, and reopening a file database repairs through migrate', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crm-planned-'));
  try {
    const file = path.join(dir, 'crm.db');
    let db = openCrmDb(file);
    const id = insertRow(db, 'reachout_planned', 'Hi planned for 2026-10-26T09:30:00Z', { step: 0 });
    db.close();
    db = openCrmDb(file);
    const once = row(db, id);
    assert.equal(once.text, 'Hi planned');
    repairPlannedText(db);
    assert.deepEqual(row(db, id), once);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M004 a row with an unreadable ISO time is left as is', () => {
  const db = openCrmDb(':memory:');
  const id = insertRow(db, 'followup_planned', 'Z planned for 2026-13-45T00:00:00.000Z', { followupId: 3 });
  const before = row(db, id);
  repairPlannedText(db);
  assert.deepEqual(row(db, id), before);
});

test('M005 a planned row with unreadable data still gets its due time', () => {
  const db = openCrmDb(':memory:');
  const id = db.prepare("INSERT INTO timeline (contactId, kind, at, text, data) VALUES (1, 'followup_planned', 1, 'W planned for 2026-10-26T09:30:00.000Z', 'not json')").run().lastInsertRowid;
  repairPlannedText(db);
  assert.deepEqual(JSON.parse(row(db, Number(id)).data), { dueAt: Date.parse('2026-10-26T09:30:00.000Z') });
});
