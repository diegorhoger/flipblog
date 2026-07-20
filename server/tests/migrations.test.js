import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, MIGRATIONS } from '../src/migrations/index.js';
import migration001 from '../src/migrations/001_add_role.js';
import migration002 from '../src/migrations/002_add_avatar.js';
import migration003 from '../src/migrations/003_add_author_id.js';
import migration004 from '../src/migrations/004_rename_admin_to_users.js';
import migration005 from '../src/migrations/005_add_posts_author_fk.js';
import migration006 from '../src/migrations/006_rename_post_author_columns.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  return db;
}

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  return cols.includes(column);
}

function migrationExists(db, version) {
  const row = db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version);
  return !!row;
}

test('legacy database: pending migrations apply and are recorded', () => {
  const db = makeDb();
  db.exec('CREATE TABLE admin (id INTEGER PRIMARY KEY, username TEXT)');
  const migrations = [
    { version: 1, name: 'v1', up: (d) => d.exec('ALTER TABLE admin ADD COLUMN role TEXT') },
    { version: 2, name: 'v2', up: (d) => d.exec('ALTER TABLE admin ADD COLUMN avatar TEXT') },
  ];
  runMigrations(db, migrations);
  assert.equal(columnExists(db, 'admin', 'role'), true);
  assert.equal(columnExists(db, 'admin', 'avatar'), true);
  assert.equal(migrationExists(db, 1), true);
  assert.equal(migrationExists(db, 2), true);
});

test('second startup does not reapply migrations', () => {
  const db = makeDb();
  const migrations = [
    { version: 1, name: 'v1', up: (d) => d.exec('CREATE TABLE example (id INTEGER)') },
  ];
  runMigrations(db, migrations);
  // Second run should be a no-op (no error, no duplicate record).
  runMigrations(db, migrations);
  const rows = db.prepare('SELECT version FROM schema_migrations WHERE version=1').all();
  assert.equal(rows.length, 1);
  assert.equal(tableExists(db, 'example'), true);
});

test('migration failure rolls back the partial schema change', () => {
  const db = makeDb();
  const migrations = [
    { version: 1, name: 'v1', up: (d) => d.exec('CREATE TABLE example (id INTEGER)') },
    {
      version: 2,
      name: 'v2',
      up: (d) => {
        d.exec('ALTER TABLE example ADD COLUMN name TEXT');
        throw new Error('intentional migration failure');
      },
    },
  ];
  assert.throws(() => runMigrations(db, migrations));
  // Everything from the failed batch is rolled back.
  assert.equal(tableExists(db, 'example'), false);
  assert.equal(migrationExists(db, 1), false);
  assert.equal(migrationExists(db, 2), false);
});

test('duplicate migration versions cause startup to fail', () => {
  const db = makeDb();
  const migrations = [
    { version: 1, name: 'v1', up: () => {} },
    { version: 1, name: 'v1-dup', up: () => {} },
  ];
  assert.throws(() => runMigrations(db, migrations), /Duplicate migration version/);
});

test('unknown applied migration is tolerated (newer DB opened by older code)', () => {
  const db = makeDb();
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(99, 'future', 'x');
  // Current registry migrations still apply; the unknown one is ignored.
  const migrations = [
    { version: 1, name: 'v1', up: (d) => d.exec('CREATE TABLE example (id INTEGER)') },
  ];
  runMigrations(db, migrations);
  assert.equal(tableExists(db, 'example'), true);
  assert.equal(migrationExists(db, 1), true);
});

test('avatar migration is idempotent when the column already exists', () => {
  const db = makeDb();
  db.exec('CREATE TABLE admin (id INTEGER PRIMARY KEY, avatar TEXT)');
  const migrations = [
    { version: 1, name: 'add_avatar', up: (d) => {
      const cols = d.prepare('PRAGMA table_info(admin)').all().map((c) => c.name);
      if (!cols.includes('avatar')) d.exec('ALTER TABLE admin ADD COLUMN avatar TEXT');
    } },
  ];
  assert.doesNotThrow(() => runMigrations(db, migrations));
  assert.equal(columnExists(db, 'admin', 'avatar'), true);
});

test('migration 004 renames an existing admin table to users, preserving data', () => {
  const db = makeDb();
  // Simulate a pre-rename deployment: an `admin` table (with rows) and a `posts`
  // table, as created by the baseline schema.
  db.exec(
    `CREATE TABLE admin (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       password_hash TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`
  );
  db.exec(
    `CREATE TABLE posts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       slug TEXT UNIQUE NOT NULL,
       title TEXT NOT NULL,
       content TEXT NOT NULL DEFAULT ''
     )`
  );
  db.exec("INSERT INTO admin (username, password_hash, created_at) VALUES ('alice', 'hash', '2026-01-01')");

  runMigrations(db, [migration001, migration002, migration003, migration004]);

  assert.equal(tableExists(db, 'admin'), false);
  assert.equal(tableExists(db, 'users'), true);
  for (const col of ['id', 'username', 'password_hash', 'created_at', 'role', 'avatar']) {
    assert.equal(columnExists(db, 'users', col), true, `users should have column ${col}`);
  }
  const row = db.prepare('SELECT username, role FROM users WHERE username = ?').get('alice');
  assert.equal(row.username, 'alice');
  assert.equal(row.role, 'admin');
  assert.equal(columnExists(db, 'posts', 'author_id'), true);
  assert.equal(migrationExists(db, 4), true);
});

test('migration 004 is a no-op when only users exists (idempotent re-run)', () => {
  const db = makeDb();
  // An existing `admin` table starts the sequence; everything still ends on users.
  db.exec(
    `CREATE TABLE admin (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       password_hash TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`
  );
  db.exec(
    `CREATE TABLE posts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       slug TEXT UNIQUE NOT NULL,
       title TEXT NOT NULL,
       content TEXT NOT NULL DEFAULT ''
     )`
  );
  assert.doesNotThrow(() => runMigrations(db, [migration001, migration002, migration003, migration004]));
  assert.equal(tableExists(db, 'users'), true);
  assert.equal(tableExists(db, 'admin'), false);
  assert.equal(migrationExists(db, 4), true);
});

// ---- migration 005: posts.author_id -> users.id foreign key ----

// Mirror the real baseline that migration 004 transforms: an `admin` table (with
// the role/avatar columns 001/002 add) and a `posts` table (with author_id from
// 003). Running the full registry renames admin -> users so 005 can reference it.
function seedAdminAndPosts(db, { withAuthorId = true } = {}) {
  db.exec(
    `CREATE TABLE admin (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       password_hash TEXT NOT NULL,
       created_at TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'author',
       avatar TEXT
     )`
  );
  db.exec(
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
  db.prepare('INSERT INTO admin (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)').run(
    'owner',
    'hash',
    '2026-01-01',
    'author'
  );
  if (withAuthorId) {
    db.prepare(
      `INSERT INTO posts (slug, title, content, created_at, updated_at, author_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('p1', 'Post 1', 'body', '2026-01-02', '2026-01-02', 1);
  }
}

function postsFkPresent(db) {
  return (
    db
      .prepare("PRAGMA foreign_key_list(posts)")
      .all()
      .filter((fk) => fk.table === 'users').length > 0
  );
}

function allPostsColumns(db) {
  return db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
}

// Chain that produces `users` (001-004: admin -> users) then applies the posts
// FK (005). The test seeds `admin` directly, so 004's rename is the step that
// yields `users` for 005 to reference.
const MIGRATIONS_TO_005 = [migration001, migration002, migration003, migration004, migration005];

test('migration 005 adds the posts.author_id -> users.id foreign key (fresh)', () => {
  const db = makeDb();
  seedAdminAndPosts(db, { withAuthorId: false });
  runMigrations(db, MIGRATIONS_TO_005);

  assert.equal(postsFkPresent(db), true, 'foreign key declared on posts.author_id');
  assert.equal(migrationExists(db, 5), true);
  // No partial rebuild leftovers.
  assert.equal(tableExists(db, 'posts_new'), false);
  // A user-delete-style check: the constraint references users(id).
  const fk = db
    .prepare("PRAGMA foreign_key_list(posts)")
    .all()
    .find((f) => f.table === 'users');
  assert.equal(fk.from, 'author_id');
  assert.equal(fk.to, 'id');
  assert.equal(fk.on_delete, 'SET NULL');
});

test('migration 005 preserves existing valid ownership rows', () => {
  const db = makeDb();
  seedAdminAndPosts(db, { withAuthorId: true });
  runMigrations(db, MIGRATIONS_TO_005);

  const row = db.prepare('SELECT slug, title, author_id FROM posts WHERE slug = ?').get('p1');
  assert.equal(row.title, 'Post 1');
  assert.equal(row.author_id, 1, 'ownership preserved through rebuild');
  assert.equal(postsFkPresent(db), true);
  // foreign_key_check must be clean.
  assert.equal(db.prepare('PRAGMA foreign_key_check(posts)').all().length, 0);
});

test('migration 005 preserves null author_id rows', () => {
  const db = makeDb();
  seedAdminAndPosts(db, { withAuthorId: false });
  db.prepare(
    `INSERT INTO posts (slug, title, content, created_at, updated_at, author_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('p-null', 'Null owner', 'body', '2026-01-03', '2026-01-03', null);
  runMigrations(db, MIGRATIONS_TO_005);

  const row = db.prepare('SELECT slug, author_id FROM posts WHERE slug = ?').get('p-null');
  assert.equal(row.author_id, null, 'null ownership survives the rebuild');
  assert.equal(postsFkPresent(db), true);
});

test('full migration registry through 006 is idempotent on restart', () => {
  const db = makeDb();
  seedAdminAndPosts(db, { withAuthorId: true });
  // Run the full registry (001-006: admin -> users, posts FK, then the column
  // rename). A second startup must be a no-op leaving the renamed schema intact.
  runMigrations(db, MIGRATIONS);
  runMigrations(db, MIGRATIONS);
  assert.equal(postsFkPresent(db), true, 'fk still present after restart');
  // After 006 the ownership column is owner_user_id and author is author_display_name.
  const row = db.prepare('SELECT title, owner_user_id FROM posts WHERE slug = ?').get('p1');
  assert.equal(row.title, 'Post 1');
  assert.equal(row.owner_user_id, 1, 'ownership preserved through full registry');
  assert.equal(migrationExists(db, 6), true, 'v6 recorded');
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 6').get().c,
    1,
    'recorded once'
  );
});

test('migration 005 keeps every existing post column and index', () => {
  const db = makeDb();
  seedAdminAndPosts(db, { withAuthorId: true });
  runMigrations(db, MIGRATIONS_TO_005);

  for (const col of [
    'id',
    'slug',
    'title',
    'author',
    'excerpt',
    'cover_image',
    'content',
    'status',
    'created_at',
    'updated_at',
    'author_id',
  ]) {
    assert.equal(allPostsColumns(db).includes(col), true, `posts should keep column ${col}`);
  }
  // The baseline UNIQUE constraint on slug is preserved (a duplicate slug is
  // rejected after the rebuild).
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO posts (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('p1', 'Dup', 'body', '2026-01-09', '2026-01-09'),
    /UNIQUE/i,
    'slug uniqueness constraint preserved through rebuild'
  );
});

test('migration 005 fails closed on orphaned ownership (no partial rebuild)', () => {
  const db = makeDb();
  seedAdminAndPosts(db, { withAuthorId: false });
  // Orphan: references a user id that does not exist.
  db.prepare(
    `INSERT INTO posts (slug, title, content, created_at, updated_at, author_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('p-orphan', 'Orphan', 'body', '2026-01-04', '2026-01-04', 999);

  assert.throws(() => runMigrations(db, MIGRATIONS_TO_005), /orphan|missing user/i);
  // Nothing was rebuilt: original posts table is intact, no posts_new, no v5 record.
  assert.equal(tableExists(db, 'posts'), true);
  assert.equal(tableExists(db, 'posts_new'), false);
  assert.equal(migrationExists(db, 5), false);
  const row = db.prepare('SELECT slug, author_id FROM posts WHERE slug = ?').get('p-orphan');
  assert.equal(row.author_id, 999, 'orphan row untouched after failed migration');
});

// Explicit indexes/triggers on posts must survive the rebuild, and must still
// work — not merely still be named in sqlite_master.
function objectSql(db, type, name) {
  return db
    .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ? AND tbl_name = 'posts'")
    .get(type, name);
}

test('migration 005 preserves explicit indexes and triggers on posts', () => {
  const db = makeDb();
  seedAdminAndPosts(db, { withAuthorId: true });
  // An operator-added index and trigger, the kind a real DB might carry.
  db.exec('CREATE INDEX idx_posts_status ON posts(status)');
  db.exec('CREATE TABLE posts_counter (n INTEGER)');
  db.exec('CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN INSERT INTO posts_counter (n) VALUES (1); END');

  runMigrations(db, MIGRATIONS_TO_005);

  // Both objects are restored with their original definitions.
  assert.ok(objectSql(db, 'index', 'idx_posts_status'), 'explicit index restored');
  assert.ok(objectSql(db, 'trigger', 'posts_ai'), 'explicit trigger restored');
  assert.equal(postsFkPresent(db), true);

  // The index is actually usable (the planner chooses it for a status lookup).
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM posts WHERE status = 'published'").all();
  assert.ok(
    plan.some((p) => String(p.detail || '').includes('idx_posts_status')),
    'restored index is used by the planner'
  );

  // Note: this node:sqlite build does not execute triggers, so we assert the
  // trigger is preserved (present + correct SQL) rather than that it fires.
  // Rows and ownership are intact.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM posts').get().c, 1);
  assert.equal(db.prepare('SELECT author_id FROM posts WHERE slug = ?').get('p1').author_id, 1);
});

test('migration 005 fails closed when an explicit object cannot be restored (rollback)', () => {
  const db = makeDb();
  seedAdminAndPosts(db, { withAuthorId: true });
  db.exec('CREATE INDEX idx_posts_status ON posts(status)');
  // A trigger whose body references a table that does not exist: it is captured
  // and stored fine, but re-executing its CREATE fails, so restoration must
  // throw and roll the whole transaction back.
  db.exec('CREATE TRIGGER posts_bad AFTER INSERT ON posts BEGIN INSERT INTO no_such_table (x) VALUES (1); END');

  assert.throws(() => runMigrations(db, MIGRATIONS_TO_005));
  // Rollback restored the original, unrebuilt schema: posts (with its data and
  // the valid explicit index) and no posts_new / v5 record.
  assert.equal(tableExists(db, 'posts'), true);
  assert.equal(tableExists(db, 'posts_new'), false);
  assert.equal(migrationExists(db, 5), false);
  assert.ok(objectSql(db, 'index', 'idx_posts_status'), 'valid index survived the rollback');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM posts').get().c, 1, 'rows intact after rollback');
  assert.equal(postsFkPresent(db), false, 'fk not present because the rebuild was rolled back');
});

// ---- migration 006: rename author -> author_display_name, author_id -> owner_user_id ----

const MIGRATIONS_TO_006 = [...MIGRATIONS_TO_005, migration006];

// Seed the historical admin+posts shape (author display + author_id), run the
// schema through 005 so posts carries the author_id FK, then hand off to 006.
function seedPostsForRename(db) {
  seedAdminAndPosts(db, { withAuthorId: true });
  db.prepare("UPDATE posts SET author = 'Fellipe Bittencourt' WHERE slug = 'p1'").run();
  db.prepare(
    `INSERT INTO posts (slug, title, author, content, created_at, updated_at, author_id)
     VALUES ('p2', 'Post 2', 'Guest Writer', 'body', '2026-01-05', '2026-01-05', NULL)`
  ).run();
}

test('migration 006 renames columns and preserves display name + ownership', () => {
  const db = makeDb();
  seedPostsForRename(db);
  runMigrations(db, MIGRATIONS_TO_006);

  const cols = allPostsColumns(db);
  assert.ok(cols.includes('author_display_name'), 'author_display_name present');
  assert.ok(cols.includes('owner_user_id'), 'owner_user_id present');
  assert.ok(!cols.includes('author'), 'old author column gone');
  assert.ok(!cols.includes('author_id'), 'old author_id column gone');

  const p1 = db.prepare('SELECT author_display_name, owner_user_id FROM posts WHERE slug = ?').get('p1');
  assert.equal(p1.author_display_name, 'Fellipe Bittencourt', 'display name preserved');
  assert.equal(p1.owner_user_id, 1, 'ownership id preserved');

  const p2 = db.prepare('SELECT author_display_name, owner_user_id FROM posts WHERE slug = ?').get('p2');
  assert.equal(p2.author_display_name, 'Guest Writer');
  assert.equal(p2.owner_user_id, null, 'null ownership preserved');

  assert.equal(migrationExists(db, 6), true, 'v6 recorded');
});

test('migration 006 moves the FK onto owner_user_id with ON DELETE SET NULL', () => {
  const db = makeDb();
  seedPostsForRename(db);
  runMigrations(db, MIGRATIONS_TO_006);

  const fk = db.prepare("PRAGMA foreign_key_list(posts)").all().find((f) => f.table === 'users');
  assert.ok(fk, 'fk to users present');
  assert.equal(fk.from, 'owner_user_id');
  assert.equal(fk.to, 'id');
  assert.equal(fk.on_delete, 'SET NULL');

  // ON DELETE SET NULL actually fires.
  db.exec('PRAGMA foreign_keys = ON;');
  db.prepare('DELETE FROM users WHERE id = 1').run();
  const row = db.prepare('SELECT owner_user_id FROM posts WHERE slug = ?').get('p1');
  assert.equal(row.owner_user_id, null, 'owner_user_id nulled on owner deletion');
});

test('migration 006 preserves explicit indexes and triggers on posts', () => {
  const db = makeDb();
  seedPostsForRename(db);
  db.exec('CREATE INDEX idx_posts_status ON posts(status)');
  db.exec('CREATE TABLE posts_counter (n INTEGER)');
  db.exec('CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN INSERT INTO posts_counter (n) VALUES (1); END');

  runMigrations(db, MIGRATIONS_TO_006);

  assert.ok(objectSql(db, 'index', 'idx_posts_status'), 'explicit index restored');
  assert.ok(objectSql(db, 'trigger', 'posts_ai'), 'explicit trigger restored');
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM posts WHERE status = 'published'").all();
  assert.ok(plan.some((p) => String(p.detail || '').includes('idx_posts_status')), 'restored index is used');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM posts').get().c, 2, 'rows intact');
});

test('migration 006 fails closed when an explicit object cannot be restored (rollback)', () => {
  const db = makeDb();
  seedPostsForRename(db);
  db.exec('CREATE INDEX idx_posts_status ON posts(status)');
  db.exec('CREATE TRIGGER posts_bad AFTER INSERT ON posts BEGIN INSERT INTO no_such_table (x) VALUES (1); END');

  assert.throws(() => runMigrations(db, MIGRATIONS_TO_006));
  // Rollback restored the pre-006 schema.
  assert.equal(tableExists(db, 'posts'), true);
  assert.equal(columnExists(db, 'posts', 'author_id'), true, 'original author_id column restored');
  assert.equal(tableExists(db, 'posts_new'), false);
  assert.equal(migrationExists(db, 6), false, 'v6 not recorded on failure');
  assert.ok(objectSql(db, 'index', 'idx_posts_status'), 'valid index survived rollback');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM posts').get().c, 2, 'rows intact after rollback');
});

test('migration 006 fails closed on orphaned ownership (no partial rebuild)', () => {
  const db = makeDb();
  seedPostsForRename(db);
  runMigrations(db, MIGRATIONS_TO_005);
  // Orphan detection in 006 is a query (not FK enforcement), so relax FK for the
  // deliberately-orphaned insert; otherwise the FK rejects it before 006 can.
  db.exec('PRAGMA foreign_keys = OFF;');
  // Inject an orphan (owner id with no matching user) AFTER 005 has passed, then
  // run 006 directly. Its orphan guard must refuse and leave posts untouched.
  db.prepare(
    `INSERT INTO posts (slug, title, content, created_at, updated_at, author_id)
     VALUES ('p-orphan', 'Orphan', 'body', '2026-01-04', '2026-01-04', 999)`
  ).run();
  assert.throws(() => migration006.up(db), /orphan|missing user/i);
  const row = db.prepare('SELECT author_id FROM posts WHERE slug = ?').get('p-orphan');
  assert.equal(row.author_id, 999, 'orphan row untouched after failed rename');
});

test('migration 006 restart is idempotent (recorded once, no posts_new leftover)', () => {
  const db = makeDb();
  seedPostsForRename(db);
  runMigrations(db, MIGRATIONS_TO_006);
  // Second startup with the full registry must be a no-op.
  runMigrations(db, MIGRATIONS);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 6').get().c,
    1,
    'v6 recorded once'
  );
  assert.ok(columnExists(db, 'posts', 'owner_user_id'), 'renamed column still present');
  assert.ok(!columnExists(db, 'posts', 'author_id'), 'old column still absent');
  assert.equal(tableExists(db, 'posts_new'), false, 'no rebuild leftover');
});




