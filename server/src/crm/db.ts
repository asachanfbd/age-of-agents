import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { nameKey, normalisePhone, parseCountryCode } from './normalize.ts';
import { defaultSettings } from './settings.ts';
import type { CrmSettings } from './settings.ts';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, fileName TEXT, tags TEXT NOT NULL DEFAULT '[]',
  counts TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, name TEXT, company TEXT, title TEXT, nameKey TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', tagsKey TEXT NOT NULL DEFAULT '', custom TEXT NOT NULL DEFAULT '{}',
  segment TEXT NOT NULL DEFAULT 'prospect', stage TEXT, lostReason TEXT, lostAt INTEGER, customerAt INTEGER,
  noResponse INTEGER NOT NULL DEFAULT 0, noResponseAt INTEGER, resurfaceAt INTEGER, callbackAt INTEGER,
  dnc INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'added by hand', batchId INTEGER REFERENCES batches(id),
  mergedInto INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS contacts_segment ON contacts(segment, mergedInto, id);
CREATE INDEX IF NOT EXISTS contacts_namekey ON contacts(nameKey) WHERE nameKey <> '';
CREATE INDEX IF NOT EXISTS contacts_batch ON contacts(batchId);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY, contactId INTEGER NOT NULL REFERENCES contacts(id), type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL, norm TEXT NOT NULL, invalid INTEGER NOT NULL DEFAULT 0, dnc INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL,
  UNIQUE (type, label, norm));
CREATE INDEX IF NOT EXISTS channels_contact ON channels(contactId);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY, contactId INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, editedAt INTEGER);
CREATE INDEX IF NOT EXISTS timeline_contact ON timeline(contactId, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS timeline_kind ON timeline(kind, at);
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY, contactId INTEGER NOT NULL, channelId INTEGER, chain TEXT NOT NULL, kind TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', dueAt INTEGER NOT NULL, message TEXT, draft TEXT, platform TEXT,
  sentAt INTEGER, doneAt INTEGER, tries INTEGER NOT NULL DEFAULT 0, retryAt INTEGER, delayReason TEXT, durationMin INTEGER,
  catchUp INTEGER NOT NULL DEFAULT 0, checkedAt INTEGER, unknownFields TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS followups_state ON followups(state, dueAt);
CREATE INDEX IF NOT EXISTS followups_contact ON followups(contactId, state);
CREATE TABLE IF NOT EXISTS dismissed_pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE IF NOT EXISTS merges (
  id INTEGER PRIMARY KEY, survivorId INTEGER NOT NULL, absorbedId INTEGER NOT NULL, at INTEGER NOT NULL, snapshot TEXT NOT NULL, undoneAt INTEGER);
CREATE TABLE IF NOT EXISTS moms (
  id INTEGER PRIMARY KEY, contactId INTEGER NOT NULL, targetKind TEXT NOT NULL, targetId INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '', transcriptStatus TEXT NOT NULL DEFAULT 'none', summary TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '', attendees TEXT NOT NULL DEFAULT '[]', actionItems TEXT NOT NULL DEFAULT '[]',
  draft TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE (targetKind, targetId));
CREATE TABLE IF NOT EXISTS mom_files (
  id INTEGER PRIMARY KEY, momId INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, stored TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS building_links (contactId INTEGER NOT NULL, buildingId TEXT NOT NULL, attachedAt INTEGER NOT NULL, PRIMARY KEY (contactId, buildingId));
CREATE TABLE IF NOT EXISTS slot_days (day TEXT NOT NULL, slotId TEXT NOT NULL, start TEXT, minutes INTEGER, skipped INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, slotId));
CREATE TABLE IF NOT EXISTS block_days (day TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL, start TEXT, PRIMARY KEY (day, key));
CREATE TABLE IF NOT EXISTS email_sends (id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
`;

/** Adds what older databases lack. Every step is a no-op once applied. */
function migrate(db: Db): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('timeline')").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'workKey')) db.exec('ALTER TABLE timeline ADD COLUMN workKey TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS timeline_work_key ON timeline(workKey) WHERE workKey IS NOT NULL');
  repairPhoneHandles(db);
  repairPlannedText(db);
}

const PLANNED_FOR_ISO = /^(.*) planned for (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/s;

/**
 * Planned entries written before due times moved into `data.dueAt` carry a UTC ISO time in their text
 * ("X planned for 2026-10-26T09:30:00.000Z"). Moves that time into `data.dueAt` so the web shows it in the
 * Building time zone. This is the only in-place rewrite of a non-comment timeline entry; it adds no entry.
 */
export function repairPlannedText(db: Db): void {
  const rows = db.prepare("SELECT id, text, data FROM timeline WHERE kind IN ('reachout_planned', 'followup_planned') AND text LIKE '% planned for %'").all() as Array<{ id: number; text: string; data: string }>;
  const update = db.prepare('UPDATE timeline SET text = ?, data = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      const match = PLANNED_FOR_ISO.exec(row.text);
      const dueAt = match ? Date.parse(match[2]!) : NaN;
      if (!match || !Number.isFinite(dueAt)) continue;
      let data: Record<string, unknown>;
      try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { data = {}; }
      update.run(`${match[1]} planned`, JSON.stringify({ ...data, dueAt }), row.id);
    }
  })();
}

const PHONE_RUN_AT_END = /\+?[\d\s().\-/０-９]*[\d０-９][\d\s().\-/０-９]*$/u;

function storedCountryCode(db: Db): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'settings'").get() as { value: string } | undefined;
  try { return parseCountryCode((JSON.parse(row?.value ?? '{}') as { countryCode?: unknown }).countryCode); } catch { return null; }
}

/**
 * Phone handles saved before phones were validated strictly may carry text ("Tarun Gera, +919910166500").
 * Splits each into a name and the number, re-normalises the number and fills an empty contact name.
 * A row whose new number already belongs to another channel is left as is and logged for a manual merge.
 * Rows of merged contacts are included; a merge undo that restores an old row is repaired on the next open.
 */
export function repairPhoneHandles(db: Db, now: () => number = Date.now): void {
  const rows = db.prepare("SELECT id, contactId, label, handle FROM channels WHERE type = 'phone'").all() as Array<{ id: number; contactId: number; label: string; handle: string }>;
  const bad = rows.filter((r) => /\p{L}/u.test(r.handle));
  if (!bad.length) return;
  const countryCode = storedCountryCode(db);
  const collides = db.prepare("SELECT 1 FROM channels WHERE type = 'phone' AND label = ? AND norm = ? AND id <> ?");
  const contactName = db.prepare('SELECT name FROM contacts WHERE id = ?');
  const setName = db.prepare('UPDATE contacts SET name = ?, nameKey = ?, updatedAt = ? WHERE id = ?');
  const setChannel = db.prepare('UPDATE channels SET handle = ?, norm = ? WHERE id = ?');
  const log = db.prepare("INSERT INTO timeline (contactId, kind, at, text, data) VALUES (?, 'channel_changed', ?, ?, '{}')");
  db.transaction(() => {
    for (const row of bad) {
      const run = PHONE_RUN_AT_END.exec(row.handle);
      const number = run?.[0].trim();
      const parsed = number ? normalisePhone(number, countryCode) : null;
      if (!run || !number || !parsed?.ok) continue;
      if (collides.get(row.label, parsed.value, row.id)) {
        console.warn(`CRM phone repair: channel ${row.id} (contact ${row.contactId}) left as "${row.handle}"; ${parsed.value} already belongs to another channel, merge by hand`);
        continue;
      }
      const candidate = row.handle.slice(0, run.index).replace(/[\s,;:|-]+$/, '').trim();
      const current = (contactName.get(row.contactId) as { name: string | null } | undefined)?.name;
      const at = now();
      if (candidate && !current?.trim()) setName.run(candidate, nameKey(candidate), at, row.contactId);
      setChannel.run(number, parsed.value, row.id);
      log.run(row.contactId, at, `Repaired phone "${row.handle}" to ${number}${candidate && !current?.trim() ? ` and set the name to ${candidate}` : ''}`);
    }
  })();
}

export function openCrmDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function readSettings(db: Db, timezone: string): CrmSettings {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'settings'").get() as { value: string } | undefined;
  const base = defaultSettings(timezone);
  return row ? { ...base, ...(JSON.parse(row.value) as Partial<CrmSettings>) } : base;
}
export function writeSettings(db: Db, settings: CrmSettings): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
}
