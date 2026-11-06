import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCrmDb, repairPhoneHandles } from '../src/crm/db.ts';
import type { Db } from '../src/crm/db.ts';

function seed(countryCode?: string): Db {
  const db = openCrmDb(':memory:');
  if (countryCode) db.prepare("INSERT INTO meta (key, value) VALUES ('settings', ?)").run(JSON.stringify({ countryCode }));
  return db;
}
function addContact(db: Db, id: number, name: string | null) {
  db.prepare('INSERT INTO contacts (id, name, nameKey, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1)').run(id, name, (name ?? '').toLowerCase());
}
function addPhone(db: Db, id: number, contactId: number, handle: string, norm: string) {
  db.prepare("INSERT INTO channels (id, contactId, type, handle, norm, createdAt) VALUES (?, ?, 'phone', ?, ?, 1)").run(id, contactId, handle, norm);
}
const channel = (db: Db, id: number) => db.prepare('SELECT handle, norm FROM channels WHERE id = ?').get(id) as { handle: string; norm: string };
const contact = (db: Db, id: number) => db.prepare('SELECT name, nameKey FROM contacts WHERE id = ?').get(id) as { name: string | null; nameKey: string };

test('R001 repairs a name-plus-number handle: name set, handle and norm replaced, timeline entry written', () => {
  const db = seed('91');
  addContact(db, 1, null);
  addPhone(db, 1, 1, 'Tarun Gera, +919910166500', '91919910166500');
  repairPhoneHandles(db);
  assert.deepEqual(channel(db, 1), { handle: '+919910166500', norm: '919910166500' });
  assert.deepEqual(contact(db, 1), { name: 'Tarun Gera', nameKey: 'tarun gera' });
  const log = db.prepare("SELECT text FROM timeline WHERE contactId = 1 AND kind = 'channel_changed'").all();
  assert.equal(log.length, 1);
});

test('R002 a contact with a name keeps it', () => {
  const db = seed();
  addContact(db, 1, 'Real Name');
  addPhone(db, 1, 1, 'Someone Else: +49 151 234567', '49151234567');
  repairPhoneHandles(db);
  assert.equal(contact(db, 1).name, 'Real Name');
  assert.deepEqual(channel(db, 1), { handle: '+49 151 234567', norm: '49151234567' });
});

test('R003 a collision leaves the row unchanged and writes no timeline entry', () => {
  const db = seed();
  addContact(db, 1, null);
  addContact(db, 2, 'Owner');
  addPhone(db, 1, 1, 'Tarun Gera, +919910166500', '91919910166500');
  addPhone(db, 2, 2, '+919910166500', '919910166500');
  const warn = console.warn; const lines: string[] = [];
  console.warn = (m: string) => { lines.push(m); };
  try { repairPhoneHandles(db); } finally { console.warn = warn; }
  assert.equal(channel(db, 1).handle, 'Tarun Gera, +919910166500');
  assert.equal(contact(db, 1).name, null);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM timeline').get() as { n: number }).n, 0);
  assert.equal(lines.length, 1);
});

test('R004 a second run changes nothing', () => {
  const db = seed('91');
  addContact(db, 1, null);
  addPhone(db, 1, 1, 'Tarun Gera, +919910166500', 'x');
  repairPhoneHandles(db);
  repairPhoneHandles(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM timeline').get() as { n: number }).n, 1);
});

test('R005 text with no usable number is left alone, and an empty candidate keeps no name', () => {
  const db = seed();
  addContact(db, 1, null);
  addContact(db, 2, null);
  addPhone(db, 1, 1, 'no number here', 'x1');
  addPhone(db, 2, 2, 'ext +49 151 234567', '49151234567');
  repairPhoneHandles(db);
  assert.equal(channel(db, 1).handle, 'no number here');
  assert.equal(contact(db, 2).name, 'ext');
});

test('R006 a number-only phone handle is untouched', () => {
  const db = seed();
  addContact(db, 1, null);
  addPhone(db, 1, 1, '+49 151 234567', '49151234567');
  repairPhoneHandles(db);
  assert.equal(channel(db, 1).handle, '+49 151 234567');
});
