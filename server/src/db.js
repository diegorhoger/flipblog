import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, isMemoryDb } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT '',
  excerpt     TEXT NOT NULL DEFAULT '',
  cover_image TEXT,
  content     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'published',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_status     ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
`;

let db;

export function getDb() {
  if (db) return db;
  if (!isMemoryDb) mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  if (!isMemoryDb) {
    db.exec('PRAGMA busy_timeout = 5000;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Migration: the `role` column was added after the first release. Existing
  // databases may be missing it, so add it defensively (defaults to 'admin').
  const adminCols = db.prepare("PRAGMA table_info(admin)").all();
  if (!adminCols.some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE admin ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
