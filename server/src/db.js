import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, isMemoryDb } from './config.js';
import { runMigrations } from './migrations/index.js';

// Minimal baseline schema. All later structure (role, avatar, author_id,
// category/tags/page_count, comments, indexes) is applied by ordered, versioned
// migrations so the schema evolves without brittle inline ALTER checks.
//
// The baseline still creates `admin` (not `users`): migration 004 renames it to
// `users`, so both fresh and legacy databases take the *same* transition path.
// Creating `users` here would collide with the rename on a legacy database that
// already has `admin`, which is why the legacy name is kept in the baseline.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
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
`;

let db;

export function getDb() {
  if (db) return db;
  if (!isMemoryDb) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = new DatabaseSync(config.dbPath);
  } else {
    db = new DatabaseSync(':memory:');
  }
  if (!isMemoryDb) {
    db.exec('PRAGMA busy_timeout = 5000;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  runMigrations(db);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
