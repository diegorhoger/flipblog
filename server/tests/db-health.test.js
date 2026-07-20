import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  backupDatabase,
  pruneBackups,
  isBackupApplicable,
  backupFileName,
  timestampToken,
} from '../src/db-backup.js';
import { checkDatabaseHealth, getCurrentSchemaVersion, getExpectedSchemaVersion } from '../src/db-health.js';

const TMP = tmpdir();

function newDir(prefix) {
  return mkdtempSync(join(TMP, prefix));
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function makeOnDiskDb(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  return db;
}

function seedAllMigrations(db) {
  db.exec(
    `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  for (let v = 1; v <= getExpectedSchemaVersion(); v++) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      v,
      `m${v}`,
      '2026-01-01'
    );
  }
}

// ---------------------------------------------------------------- backup unit

test('backupDatabase writes a restorable, versioned snapshot via VACUUM INTO', () => {
  const dir = newDir('fb-bak-');
  const file = join(dir, 'app.db');
  const db = makeOnDiskDb(file);

  const result = backupDatabase(db, {
    dbPath: file,
    backupDir: join(dir, 'backups'),
    version: 6,
    retention: 5,
  });

  assert.ok(result, 'backup result returned');
  assert.ok(existsSync(result.backupPath), 'backup file exists');
  assert.match(result.backupPath, /flipblog-pre-v6-.*\.db$/, 'name carries the pre-migration version');

  // The backup is a faithful, independently-openable copy of the live data.
  const copy = new DatabaseSync(result.backupPath);
  const row = copy.prepare('SELECT v FROM t WHERE id = 1').get();
  assert.equal(row.v, 'hello', 'backup preserves data');
  copy.close();
  db.close();
  cleanup(dir);
});

test('backupDatabase returns null for an in-memory database', () => {
  const mem = new DatabaseSync(':memory:');
  mem.exec('CREATE TABLE t (id INTEGER)');
  assert.equal(
    backupDatabase(mem, { dbPath: ':memory:', backupDir: join(TMP, 'b'), version: 0, retention: 5 }),
    null
  );
  mem.close();
});

test('backupDatabase returns null when disabled', () => {
  const dir = newDir('fb-bak-off-');
  const file = join(dir, 'app.db');
  const db = makeOnDiskDb(file);
  assert.equal(
    backupDatabase(db, { dbPath: file, backupDir: join(dir, 'b'), version: 0, retention: 5, enabled: false }),
    null
  );
  db.close();
  cleanup(dir);
});

test('isBackupApplicable reflects memory and disabled states', () => {
  assert.equal(isBackupApplicable(':memory:', { enabled: true }), false);
  assert.equal(isBackupApplicable('/data/app.db', { enabled: false }), false);
  assert.equal(isBackupApplicable('/data/app.db', { enabled: true }), true);
});

test('pruneBackups keeps only the newest retention count', () => {
  const dir = newDir('fb-prune-');
  const bdir = join(dir, 'backups');
  mkdirSync(bdir, { recursive: true });
  // Seven backups with sortable, increasing timestamps. The embedded timestamp
  // makes lexical sort == chronological order (newest last).
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(bdir, backupFileName(6, `2026010${i}T00000${i}Z`)), '');
  }
  const { retained, pruned } = pruneBackups(bdir, 5);
  assert.equal(pruned.length, 2, 'two oldest removed');
  assert.equal(retained.length, 5, 'five newest kept');
  // Newest (i=6) survives.
  assert.ok(retained.includes(backupFileName(6, `20260106T000006Z`)));
  cleanup(dir);
});

test('backupDatabase prunes old snapshots down to retention', () => {
  const dir = newDir('fb-bak-prune-');
  const file = join(dir, 'app.db');
  const db = makeOnDiskDb(file);
  const bdir = join(dir, 'backups');
  mkdirSync(bdir, { recursive: true });

  // Seed three old backups so the retention logic has something to trim.
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(bdir, backupFileName(6, `2025010${i}T00000${i}Z`)), '');
  }
  const result = backupDatabase(db, { dbPath: file, backupDir: bdir, version: 6, retention: 5 });
  assert.ok(result);
  const remaining = readdirSync(bdir).filter((n) => n.startsWith('flipblog-pre-v'));
  assert.equal(remaining.length, 4, '3 seeded + 1 new, under the retention of 5');
  db.close();
  cleanup(dir);
});

// --------------------------------------------------------------- health unit

test('checkDatabaseHealth passes for a fully-migrated, sound database', () => {
  const db = new DatabaseSync(':memory:');
  seedAllMigrations(db);
  const health = checkDatabaseHealth(db);
  assert.equal(health.ok, true);
  assert.equal(health.checks.integrity, true);
  assert.equal(health.checks.foreignKeys, true);
  assert.equal(health.checks.migrationVersion.missing.length, 0);
  db.close();
});

test('checkDatabaseHealth fails when a migration is missing', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  // Record only version 6, leaving 1..5 "missing" relative to the registry.
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
    6,
    'm6',
    '2026-01-01'
  );
  const health = checkDatabaseHealth(db);
  assert.equal(health.ok, false);
  assert.ok(health.checks.migrationVersion.missing.includes(1));
  db.close();
});

test('checkDatabaseHealth fails on a foreign-key violation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF;'); // allow the orphan row in so foreign_key_check can find it
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  db.exec(
    'CREATE TABLE posts (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES users(id))'
  );
  db.prepare('INSERT INTO posts (owner) VALUES (?)').run(42); // no such user
  seedAllMigrations(db);
  const health = checkDatabaseHealth(db);
  assert.equal(health.checks.foreignKeys, false);
  assert.equal(health.ok, false);
  db.close();
});

test('getCurrentSchemaVersion reads the highest applied version', () => {
  const db = new DatabaseSync(':memory:');
  assert.equal(getCurrentSchemaVersion(db), 0, '0 when schema_migrations absent');
  seedAllMigrations(db);
  assert.equal(getCurrentSchemaVersion(db), getExpectedSchemaVersion());
  db.close();
});

// ---------------------------------------------------- startup integration

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');

test('startup snapshots the file database before migrations (real process)', () => {
  const dir = newDir('fb-startup-bak-');
  const dbFile = join(dir, 'data.db');
  const result = spawnSync(process.execPath, ['--no-warnings', join(SERVER_ROOT, 'tests', 'fixtures', 'startup-backup.js')], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      DB_PATH: dbFile,
      NODE_ENV: 'production', // backups enabled (test mode disables them)
      DB_BACKUP_ENABLED: 'true',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stderr);
  assert.ok(summary.backups.length >= 1, 'at least one backup created at startup');
  assert.ok(summary.backups[0].startsWith('flipblog-pre-v'), 'backup uses the versioned naming');
  assert.ok(summary.backups[0].endsWith('.db'), 'backup has the .db suffix');

  // The backup is restorable: it opens and contains the post baseline table.
  const backupPath = join(dirname(dbFile), 'backups', summary.backups[0]);
  const copy = new DatabaseSync(backupPath);
  assert.ok(
    copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get(),
    'backup contains the posts table'
  );
  copy.close();
  cleanup(dir);
});

test('a restart with no pending migrations creates no backup (real process)', () => {
  const dir = newDir('fb-startup-nobak-');
  const dbFile = join(dir, 'data.db');
  const env = {
    ...process.env,
    DB_PATH: dbFile,
    NODE_ENV: 'production', // backups enabled (test mode disables them)
    DB_BACKUP_ENABLED: 'true',
  };
  const fixture = ['--no-warnings', join(SERVER_ROOT, 'tests', 'fixtures', 'startup-backup.js')];

  // First startup: fresh database, so migrations are pending -> a backup is taken.
  const first = spawnSync(process.execPath, fixture, { cwd: SERVER_ROOT, env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const firstSummary = JSON.parse(first.stderr);
  assert.equal(firstSummary.backups.length, 1, 'one backup on the upgrading startup');

  // Second startup: database is already at the current version, no pending
  // migrations -> no new backup should be minted (no reboot-resilience theater).
  const second = spawnSync(process.execPath, fixture, { cwd: SERVER_ROOT, env, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const secondSummary = JSON.parse(second.stderr);
  assert.equal(secondSummary.backups.length, 1, 'restart with no pending migrations adds no backup');

  cleanup(dir);
});
