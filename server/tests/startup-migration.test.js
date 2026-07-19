import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// Anchor paths to this file so the suite works no matter the launch cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');
const FIXTURE = join(SERVER_ROOT, 'tests', 'fixtures', 'startup-db.js');

const TMP = tmpdir();

// Run the real server startup in an isolated child process. Each invocation gets
// a fresh module graph, config resolution, and db.js singleton — exactly what a
// deployed process does. We never re-import cached modules in-process.
function runStartup(dbFile, { seed = false } = {}) {
  const result = spawnSync(
    process.execPath,
    seed ? [FIXTURE, '--seed'] : [FIXTURE],
    {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        DB_PATH: dbFile,
        ADMIN_USER: 'migration_admin',
        ADMIN_PASSWORD: 'migration-password',
      },
      encoding: 'utf8',
    }
  );
  return result;
}

function cleanup(dir, dbFile) {
  for (const p of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function newDir(prefix) {
  return mkdtempSync(join(TMP, prefix));
}

test('legacy database startup migrates admin -> users and preserves data + auth', () => {
  const dir = newDir('flipblog-legacy-');
  const dbFile = join(dir, 'data.db');

  // Seed a legacy deployment: an `admin` table with rows (but no `users`).
  const seed = new DatabaseSync(dbFile);
  seed.exec(
    `CREATE TABLE admin (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       password_hash TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`
  );
  seed.exec(
    `CREATE TABLE posts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       slug TEXT UNIQUE NOT NULL,
       title TEXT NOT NULL,
       content TEXT NOT NULL DEFAULT ''
     )`
  );
  seed
    .prepare('INSERT INTO admin (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('legacyuser', 'somehash', '2026-01-01');
  seed.close();

  const result = runStartup(dbFile, { seed: true });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);

  // Schema transition is complete and unambiguous.
  assert.equal(summary.tables.includes('admin'), false, 'legacy admin table must be gone');
  assert.equal(summary.tables.includes('users'), true, 'users table must exist');
  assert.equal(summary.migration4Count, 1, 'migration 004 recorded exactly once');

  // All legacy rows survive the rename, and the role column (added by a later
  // migration) is present on the migrated row.
  const migrated = summary.users.find((u) => u.username === 'legacyuser');
  assert.ok(migrated, 'legacy account survives migration');
  assert.equal(migrated.role, 'admin', 'role column present and correct after rename');

  // The seed is idempotent: a legacy database already has a user, so the
  // configured admin is NOT added a second time. Only the migrated account is
  // present.
  assert.equal(summary.users.length, 1, 'only the migrated legacy account remains');

  cleanup(dir, dbFile);
});

test('fresh database startup ends with users (no admin leftover)', () => {
  const dir = newDir('flipblog-fresh-');
  const dbFile = join(dir, 'data.db');

  const result = runStartup(dbFile, { seed: true });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);

  assert.equal(summary.tables.includes('users'), true);
  assert.equal(summary.tables.includes('admin'), false);
  assert.equal(summary.migration4Count, 1, 'migration 004 recorded exactly once');

  const seeded = summary.users.filter((u) => u.username === 'migration_admin');
  assert.equal(seeded.length, 1, 'configured admin seeded exactly once');
  assert.equal(seeded[0].role, 'admin');

  cleanup(dir, dbFile);
});

test('restarting an already-migrated database is idempotent', () => {
  const dir = newDir('flipblog-restart-');
  const dbFile = join(dir, 'data.db');

  const first = runStartup(dbFile, { seed: true });
  assert.equal(first.status, 0, first.stderr);
  const firstSummary = JSON.parse(first.stdout);
  assert.equal(firstSummary.tables.includes('users'), true);
  assert.equal(firstSummary.tables.includes('admin'), false);

  // Second startup on the same file must succeed and not re-record migrations or
  // re-seed the admin.
  const second = runStartup(dbFile, { seed: true });
  assert.equal(second.status, 0, second.stderr);
  const secondSummary = JSON.parse(second.stdout);

  assert.equal(secondSummary.tables.includes('users'), true);
  assert.equal(secondSummary.tables.includes('admin'), false);
  assert.equal(secondSummary.migration4Count, 1, 'migration 004 still recorded exactly once');

  // The seed is idempotent: no duplicate admin after restart (a single existing
  // user prevents re-seeding).
  assert.equal(secondSummary.users.length, 1, 'no duplicate user after restart');

  cleanup(dir, dbFile);
});

test('a database with both admin and users fails closed and preserves both', () => {
  const dir = newDir('flipblog-collision-');
  const dbFile = join(dir, 'data.db');

  // Pre-create BOTH tables so migration 004 cannot safely rename.
  const seed = new DatabaseSync(dbFile);
  seed.exec('CREATE TABLE admin (id INTEGER PRIMARY KEY, username TEXT)');
  seed.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
  seed.prepare('INSERT INTO admin (username) VALUES (?)').run('from_admin');
  seed.prepare('INSERT INTO users (username) VALUES (?)').run('from_users');
  seed.close();

  const result = runStartup(dbFile, { seed: true });
  // Startup must fail closed.
  assert.notEqual(result.status, 0, 'startup must refuse to migrate when both tables exist');

  // Neither table was deleted, merged, or altered; data is intact.
  const after = new DatabaseSync(dbFile);
  assert.equal(
    !!after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin'").get(),
    true,
    'admin must be preserved on failure'
  );
  assert.equal(
    !!after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get(),
    true,
    'users must be preserved on failure'
  );
  assert.equal(after.prepare('SELECT username FROM admin').get().username, 'from_admin');
  assert.equal(after.prepare('SELECT username FROM users').get().username, 'from_users');
  // Migration 004 was never recorded.
  assert.equal(
    after.prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 4").get().c,
    0,
    'migration 004 must not be recorded on failure'
  );
  after.close();

  cleanup(dir, dbFile);
});
