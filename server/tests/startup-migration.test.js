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
  // The columns match the current baseline `admin` schema so the real startup
  // (baseline + migrations + seed) can run against it unchanged.
  const seed = new DatabaseSync(dbFile);
  seed.exec(
    `CREATE TABLE admin (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       password_hash TEXT NOT NULL,
       created_at TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'admin',
       avatar TEXT
     )`
  );
  seed.exec(
    `CREATE TABLE posts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       slug TEXT UNIQUE NOT NULL,
       title TEXT NOT NULL,
       author TEXT NOT NULL DEFAULT '',
       excerpt TEXT NOT NULL DEFAULT '',
       cover_image TEXT,
       content TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'published',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
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

// ---- migration 005: posts.author_id -> users.id foreign key ----

test('fresh database startup has the posts.author_id -> users foreign key', () => {
  const dir = newDir('flipblog-fk-fresh-');
  const dbFile = join(dir, 'data.db');

  const result = runStartup(dbFile, { seed: true });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.postsAuthorFk, true, 'posts.author_id FK to users present after fresh startup');

  cleanup(dir, dbFile);
});

test('restarting an already-migrated database keeps the posts.author_id foreign key', () => {
  const dir = newDir('flipblog-fk-restart-');
  const dbFile = join(dir, 'data.db');

  const first = runStartup(dbFile, { seed: true });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).postsAuthorFk, true);

  const second = runStartup(dbFile, { seed: true });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).postsAuthorFk, true, 'FK still present after restart');

  cleanup(dir, dbFile);
});

test('explicit posts index is preserved through the rebuild (real startup)', () => {
  const dir = newDir('flipblog-fk-index-');
  const dbFile = join(dir, 'data.db');

  // Pre-create a posts table carrying an operator-added explicit index.
  const seed = new DatabaseSync(dbFile);
  seed.exec(
    `CREATE TABLE admin (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       password_hash TEXT NOT NULL,
       created_at TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'admin',
       avatar TEXT
     )`
  );
  seed.exec(
    `CREATE TABLE posts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       slug TEXT UNIQUE NOT NULL,
       title TEXT NOT NULL,
       author TEXT NOT NULL DEFAULT '',
       excerpt TEXT NOT NULL DEFAULT '',
       cover_image TEXT,
       content TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'published',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       author_id INTEGER
     )`
  );
  seed.exec('CREATE INDEX idx_posts_status ON posts(status)');
  seed.close();

  const result = runStartup(dbFile, { seed: true });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.postsAuthorFk, true);

  // The explicit index survives the migration.
  const after = new DatabaseSync(dbFile);
  assert.ok(
    after.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_posts_status' AND tbl_name='posts'").get(),
    'explicit posts index preserved through real startup'
  );
  after.close();

  cleanup(dir, dbFile);
});

test('deleting a user sets owned posts owner_user_id to NULL (ON DELETE SET NULL)', () => {
  const dir = newDir('flipblog-fk-delete-');
  const dbFile = join(dir, 'data.db');

  // Seed an owner (migration_admin) and a post owned by that user.
  const seed = runStartup(dbFile, { seed: true });
  assert.equal(seed.status, 0, seed.stderr);
  const seeded = JSON.parse(seed.stdout);
  const owner = seeded.users.find((u) => u.username === 'migration_admin');
  assert.ok(owner, 'configured admin was seeded');

  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA foreign_keys = ON;');
  db.prepare(
    'INSERT INTO posts (slug, title, author_display_name, content, status, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('owned-post', 'Owned', 'Author', 'body', 'published', '2026-02-01', '2026-02-01', owner.id);
  // Delete the owning user; the FK must null the post's owner_user_id, not delete it.
  db.prepare('DELETE FROM users WHERE id = ?').run(owner.id);
  db.close();

  // Re-open via the real startup path to confirm the post survived and is now
  // ownerless (owner_user_id NULL) rather than gone.
  const reopen = runStartup(dbFile, { seed: false });
  assert.equal(reopen.status, 0, reopen.stderr);
  const after = new DatabaseSync(dbFile);
  const row = after.prepare('SELECT id, owner_user_id FROM posts WHERE slug = ?').get('owned-post');
  assert.ok(row, 'post must survive its owner deletion');
  assert.equal(row.owner_user_id, null, 'owner_user_id set to NULL on owner deletion');
  after.close();

  cleanup(dir, dbFile);
});

test('a database with orphaned post ownership fails closed and preserves posts', () => {
  const dir = newDir('flipblog-fk-orphan-');
  const dbFile = join(dir, 'data.db');

  // Pre-create users + posts, with a post pointing at a non-existent user.
  const seed = new DatabaseSync(dbFile);
  seed.exec(
    `CREATE TABLE users (
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
       author TEXT NOT NULL DEFAULT '',
       excerpt TEXT NOT NULL DEFAULT '',
       cover_image TEXT,
       content TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'published',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       author_id INTEGER
     )`
  );
  seed.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('u1', 'h', '2026-01-01');
  seed
    .prepare('INSERT INTO posts (slug, title, content, created_at, updated_at, author_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run('orphan-post', 'Orphan', 'body', '2026-01-02', '2026-01-02', 999);
  seed.close();

  const result = runStartup(dbFile, { seed: true });
  // Migration 005 must fail closed on the orphan.
  assert.notEqual(result.status, 0, 'startup must refuse to migrate when posts reference a missing user');

  // The posts table and orphan row are preserved (no partial rebuild).
  const after = new DatabaseSync(dbFile);
  assert.equal(
    !!after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get(),
    true
  );
  const row = after.prepare('SELECT author_id FROM posts WHERE slug = ?').get('orphan-post');
  assert.equal(row.author_id, 999, 'orphan row untouched after failed migration');
  // Migration 005 was never recorded.
  assert.equal(
    after.prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 5").get().c,
    0,
    'migration 005 must not be recorded on failure'
  );
  after.close();

  cleanup(dir, dbFile);
});
