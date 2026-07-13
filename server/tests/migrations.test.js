import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrations/index.js';

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
