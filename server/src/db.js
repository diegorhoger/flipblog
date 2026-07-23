import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, isMemoryDb } from './config.js';
import { runMigrations, inspectMigrationState } from './migrations/index.js';
import { backupDatabase, defaultBackupDir } from './db-backup.js';
import { checkDatabaseHealth } from './db-health.js';

// Minimal baseline schema. All later structure (role, avatar, author_id,
// category/tags/page_count, comments, indexes) is applied by ordered, versioned
// migrations so the schema evolves without brittle inline ALTER checks.
//
// `posts` is canonical from the start. The `admin` table is the *legacy* name;
// migration 004 renames it to `users`, so both fresh and legacy databases take
// the same transition path. The baseline creates `admin` ONLY when `users` is
// absent: once migration 004 has run, `users` is canonical and a fresh `admin`
// must not be recreated on the next startup (otherwise migration 004 would see
// two tables and fail closed). On a legacy database `admin` already exists, and
// on a fresh one it is created here and renamed — in neither case does a stray
// `admin` survive after `users` exists.
//
// The baseline `posts` table uses the historical column names (author,
// author_id). Migration 003 adds author_id, migration 005 adds its foreign key,
// and migration 006 renames both to author_display_name / owner_user_id. A fresh
// database follows this same sequence; the baseline is intentionally left
// historical so migrations 003/005 continue to operate on author_id.
const BASELINE_POSTS = `
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

const BASELINE_ADMIN = `
CREATE TABLE IF NOT EXISTS admin (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
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

  // Preflight migration-state inspection, READ-ONLY. Reject an unknown future
  // schema BEFORE making any change to the database: an older build must not
  // mutate a database migrated by a newer build. This runs before the baseline,
  // the legacy admin seed, schema_migrations creation, the backup, and the
  // migrations themselves.
  const state = inspectMigrationState(db);
  if (state.unexpected.length > 0) {
    throw new Error(
      `Refusing to start: database has unknown future migration version(s) ${state.unexpected.join(
        ', '
      )} — an older build cannot open a newer schema`
    );
  }

  // Snapshot the live file *before* any baseline or migration writes, but only
  // when an upgrade is actually pending. The backup captures the on-disk state
  // exactly as the process found it — baseline tables, the legacy `admin` rename,
  // and `schema_migrations` creation all happen afterwards. On a fresh database
  // the snapshot is empty; on an existing one it is a faithful pre-upgrade copy.
  // Transactional migrations protect against SQL failure, but not against
  // filesystem corruption, operator mistakes, or deploying against the wrong file
  // — the backup is the safety net for those, so a failed upgrade can always be
  // rolled back. An ordinary restart with nothing to migrate backs up nothing.
  // Skipped for in-memory / test runs.
  const pending = state.missing;
  if (config.dbBackupEnabled && !isMemoryDb && pending.length > 0) {
    const preVersion = state.applied.length ? Math.max(...state.applied) : 0;
    const backupDir = config.dbBackupDir || defaultBackupDir(config.dbPath);
    backupDatabase(db, {
      dbPath: config.dbPath,
      backupDir,
      version: preVersion,
      retention: config.dbBackupRetention,
    });
  }

  db.exec(BASELINE_POSTS);
  // Only seed the legacy `admin` table when `users` does not yet exist. After
  // migration 004 has renamed it, `users` is the canonical accounts table and
  // we must not recreate `admin` on a subsequent startup.
  const hasUsers = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsers) {
    db.exec(BASELINE_ADMIN);
  }

  runMigrations(db);

  // Fail closed on a broken database. A half-applied migration already throws
  // inside runMigrations; this guards the other failure modes — a corrupt page,
  // a dangling foreign key, or a drifted schema version. We must not serve
  // requests on a database that cannot be trusted.
  const health = checkDatabaseHealth(db);
  if (!health.ok) {
    const mv = health.checks.migrationVersion;
    const reason = mv.unexpected.length
      ? `unknown future migration version(s): ${mv.unexpected.join(', ')}`
      : mv.missing.length
        ? `missing migration version(s): ${mv.missing.join(', ')}`
        : 'integrity_check or foreign_key_check failed';
    throw new Error(`Database health check failed: ${reason}`);
  }

  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
