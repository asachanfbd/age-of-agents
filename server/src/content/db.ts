import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS concepts_order ON concepts(createdAt DESC, seq DESC);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, conceptId TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, platform TEXT NOT NULL, format TEXT NOT NULL,
  scheduledAt INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', note TEXT, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS posts_concept ON posts(conceptId);
CREATE INDEX IF NOT EXISTS posts_scheduled ON posts(scheduledAt);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, conceptId TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, postId TEXT REFERENCES posts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'empty', content TEXT, finalizedAt INTEGER, round INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS assets_concept ON assets(conceptId);
CREATE TABLE IF NOT EXISTS studio_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, round INTEGER NOT NULL,
  text TEXT NOT NULL, savedAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS studio_drafts_asset ON studio_drafts(assetId, round);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, conceptId TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL,
  size INTEGER NOT NULL, durationMs INTEGER, width INTEGER, height INTEGER, hasThumbnail INTEGER NOT NULL DEFAULT 0, probed INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS media_concept ON media(conceptId);
CREATE TABLE IF NOT EXISTS speaking_rate_samples (
  id TEXT PRIMARY KEY, mediaId TEXT NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE, conceptId TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  wordsPerMinute REAL NOT NULL, words INTEGER NOT NULL, durationSeconds REAL NOT NULL, createdAt INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'agent', seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS video_rounds (
  assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, round INTEGER NOT NULL, confirmedAt INTEGER, scriptChanged INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (assetId, round));
CREATE TABLE IF NOT EXISTS video_checklist_items (
  assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, round INTEGER NOT NULL, itemId TEXT NOT NULL, position INTEGER NOT NULL,
  label TEXT NOT NULL, detail TEXT, ticked INTEGER NOT NULL DEFAULT 0, mediaIds TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (assetId, round, itemId));
CREATE TABLE IF NOT EXISTS video_renders (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, round INTEGER NOT NULL, k INTEGER NOT NULL,
  status TEXT NOT NULL, compositionId TEXT NOT NULL, durationMs INTEGER, size INTEGER, error TEXT, createdAt INTEGER NOT NULL, finishedAt INTEGER);
CREATE INDEX IF NOT EXISTS video_renders_asset ON video_renders(assetId, round);
CREATE TABLE IF NOT EXISTS image_renders (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, round INTEGER NOT NULL, status TEXT NOT NULL,
  compositionIds TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, error TEXT,
  createdAt INTEGER NOT NULL, finishedAt INTEGER);
CREATE INDEX IF NOT EXISTS image_renders_asset ON image_renders(assetId, round);
CREATE TABLE IF NOT EXISTS post_stats (
  id TEXT PRIMARY KEY, postId TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, capturedAt INTEGER NOT NULL, enteredAt INTEGER NOT NULL,
  counts TEXT NOT NULL, watchTime REAL, note TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS post_stats_post ON post_stats(postId, capturedAt);
CREATE TABLE IF NOT EXISTS target_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT NOT NULL, platform TEXT NOT NULL, oldValues TEXT NOT NULL, newValues TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS insights_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, trigger TEXT NOT NULL, markdown TEXT NOT NULL, postCount INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS style_history (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, who TEXT NOT NULL, summary TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retros (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, conceptId TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, draftCount INTEGER NOT NULL, roundCount INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS retros_asset ON retros(assetId, at);
CREATE TABLE IF NOT EXISTS style_proposals (
  id TEXT PRIMARY KEY, retroId TEXT NOT NULL REFERENCES retros(id) ON DELETE CASCADE, assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, summary TEXT NOT NULL, styleVersion TEXT NOT NULL, changes TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', autoApplyError TEXT);
`;

/** Adds columns a database created before they existed is missing. */
function addColumns(db: Db, table: string, columns: Record<string, string>): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

/**
 * Gives every Concept with a video or reel post the one empty thumbnail asset it needs, for databases from before thumbnails
 * existed. Post statuses stay as they are: a post finalized or published before then keeps its status.
 */
function addThumbnailAssets(db: Db): void {
  const missing = db.prepare(`SELECT DISTINCT p.conceptId AS id FROM posts p WHERE p.format IN ('video', 'reel')
    AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.conceptId = p.conceptId AND a.postId IS NULL AND a.kind = 'thumbnail')`).all() as Array<{ id: string }>;
  const insert = db.prepare("INSERT INTO assets (id, conceptId, postId, kind) VALUES (?, ?, NULL, 'thumbnail')");
  db.transaction(() => { for (const { id } of missing) insert.run(randomUUID(), id); })();
}

export function openContentDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  addColumns(db, 'concepts', { imported: 'INTEGER NOT NULL DEFAULT 0', importSessionId: 'TEXT' });
  addColumns(db, 'posts', { publishedAt: 'INTEGER', liveUrl: 'TEXT', externalAssets: 'TEXT' });
  addColumns(db, 'style_history', { autoApplied: 'INTEGER NOT NULL DEFAULT 0' });
  addColumns(db, 'retros', { sourceKind: "TEXT NOT NULL DEFAULT 'asset'" });
  addThumbnailAssets(db);
  return db;
}

export function readMeta(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}
export function writeMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
export function deleteMeta(db: Db, key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}
