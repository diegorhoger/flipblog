import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import {
  backupDatabase,
  pruneBackups,
  isBackupApplicable,
  backupFileName,
  parseBackupName,
  timestampToken,
} from '../src/db-backup.js';
import { checkDatabaseHealth, getCurrentSchemaVersion, getExpectedSchemaVersion } from '../src/db-health.js';
import { evaluateReadiness, createHealthRouter } from '../src/routes/health.js';

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
  // Seven backups with sortable, increasing millisecond-precision timestamps.
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(bdir, backupFileName(6, `2026010${i}T00000${i}.000Z`)), '');
  }
  const { retained, pruned } = pruneBackups(bdir, 5);
  assert.equal(pruned.length, 2, 'two oldest removed');
  assert.equal(retained.length, 5, 'five newest kept');
  // Newest (i=6) survives.
  assert.ok(retained.includes(backupFileName(6, `20260106T000006.000Z`)));
  cleanup(dir);
});

test('pruneBackups keeps the chronologically newest across mixed schema versions', () => {
  const dir = newDir('fb-mixed-');
  const bdir = join(dir, 'backups');
  mkdirSync(bdir, { recursive: true });
  // Deliberately out of order: v10 is OLDER than v9, and v6 is the newest by
  // time. A version-only sort would wrongly prefer v10; timestamp sort must win.
  const files = [
    'flipblog-pre-v10-20260101T000000.000Z.db', // oldest
    'flipblog-pre-v9-20260720T000000.000Z.db', // newer
    'flipblog-pre-v6-20260801T000000.000Z.db', // newest
    'flipblog-pre-v10-20260201T000000.000Z.db', // older
    'flipblog-pre-v9-20260301T000000.000Z.db', // mid
    'flipblog-pre-v6-20260401T000000.000Z.db', // mid
    'flipblog-pre-v10-20260501T000000.000Z.db', // mid
  ];
  for (const f of files) writeFileSync(join(bdir, f), '');
  const { retained, pruned } = pruneBackups(bdir, 5);
  assert.equal(pruned.length, 2, 'two oldest removed');
  assert.equal(retained.length, 5);
  // Newest by timestamp (v6 @ 2026-08-01) survives despite being the lowest version.
  assert.ok(retained.includes('flipblog-pre-v6-20260801T000000.000Z.db'));
  // Oldest (v10 @ 2026-01-01) is pruned regardless of its higher version.
  assert.ok(!retained.includes('flipblog-pre-v10-20260101T000000.000Z.db'));
  cleanup(dir);
});

test('backupDatabase avoids same-second filename collisions deterministically', () => {
  const dir = newDir('fb-collide-');
  const file = join(dir, 'app.db');
  const db = makeOnDiskDb(file);
  const bdir = join(dir, 'backups');
  mkdirSync(bdir, { recursive: true });
  const ts = '20260720T153001.000Z';
  const r1 = backupDatabase(db, { dbPath: file, backupDir: bdir, version: 6, retention: 5, ts });
  const r2 = backupDatabase(db, { dbPath: file, backupDir: bdir, version: 6, retention: 5, ts });
  assert.notEqual(r1.backupPath, r2.backupPath, 'two backups in the same ms get distinct names');
  assert.ok(
    parseBackupName(r2.name)?.collision === 1,
    'second backup gets a deterministic collision suffix'
  );
  db.close();
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
    writeFileSync(join(bdir, backupFileName(6, `2025010${i}T00000${i}.000Z`)), '');
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

function seedVersions(db, versions) {
  db.exec(
    `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  for (const v of versions) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      v,
      `m${v}`,
      '2026-01-01'
    );
  }
}

test('checkDatabaseHealth fails on an unknown future (downgrade) migration', () => {
  const db = new DatabaseSync(':memory:');
  // All expected versions applied, plus one this build does not recognise.
  seedVersions(db, [...Array.from({ length: getExpectedSchemaVersion() }, (_, i) => i + 1), 999]);
  const health = checkDatabaseHealth(db);
  assert.equal(health.ok, false, 'an unrecognised applied version must fail the gate');
  assert.ok(health.checks.migrationVersion.unexpected.includes(999));
  db.close();
});

test('checkDatabaseHealth accepts non-contiguous numbering matching the registry', () => {
  const db = new DatabaseSync(':memory:');
  const custom = [
    { version: 2, name: 'a' },
    { version: 5, name: 'b' },
    { version: 9, name: 'c' },
  ];
  seedVersions(db, custom.map((m) => m.version));
  const health = checkDatabaseHealth(db, custom);
  assert.equal(health.ok, true);
  assert.equal(health.checks.migrationVersion.missing.length, 0);
  assert.equal(health.checks.migrationVersion.unexpected.length, 0);
  db.close();
});

test('evaluateReadiness never reports ok while migrationVersion.current is false', () => {
  // Healthy: every expected version applied, nothing unexpected.
  const ok = new DatabaseSync(':memory:');
  seedAllMigrations(ok);
  const rOk = evaluateReadiness(ok);
  assert.equal(rOk.status, 'ok');
  assert.equal(rOk.checks.migrationVersion.current, true);
  ok.close();

  // Missing expected version -> unavailable (so never 200 with current false).
  const missing = new DatabaseSync(':memory:');
  seedVersions(missing, [6]);
  const rMissing = evaluateReadiness(missing);
  assert.equal(rMissing.status, 'unavailable');
  missing.close();

  // Unknown future version -> unavailable (so never 200 with current false).
  const future = new DatabaseSync(':memory:');
  seedVersions(future, [...Array.from({ length: getExpectedSchemaVersion() }, (_, i) => i + 1), 999]);
  const rFuture = evaluateReadiness(future);
  assert.equal(rFuture.status, 'unavailable');
  future.close();
});

test('GET /api/health/ready returns 503 for an unhealthy database', async () => {
  const unhealthy = new DatabaseSync(':memory:');
  seedVersions(unhealthy, [...Array.from({ length: getExpectedSchemaVersion() }, (_, i) => i + 1), 999]);

  const app = express();
  app.use('/api/health', createHealthRouter({ getDb: () => unhealthy }));
  const res = await request(app).get('/api/health/ready');
  assert.equal(res.status, 503);
  assert.equal(res.body.status, 'unavailable');
  unhealthy.close();

  const healthy = new DatabaseSync(':memory:');
  seedAllMigrations(healthy);
  const app2 = express();
  app2.use('/api/health', createHealthRouter({ getDb: () => healthy }));
  const res2 = await request(app2).get('/api/health/ready');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.checks.migrationVersion.current, true);
  healthy.close();
});

// ---------------------------------------------------- startup integration

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');

test('startup takes a pre-mutation backup before baseline and migrations (real process)', () => {
  const dir = newDir('fb-startup-bak-');
  const dbFile = join(dir, 'data.db');

  // Pre-seed a database with our own table and row, but NO schema_migrations,
  // so the real startup sees pending migrations and takes a backup BEFORE it
  // writes anything (baseline, the admin->users rename, schema_migrations).
  const seed = new DatabaseSync(dbFile);
  seed.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY, v TEXT)');
  seed.prepare('INSERT INTO marker (v) VALUES (?)').run('survives');
  seed.close();

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

  // The backup is a faithful copy of the on-disk state AS THE PROCESS FOUND IT:
  // our marker row is present, but the startup's own writes (users table, the
  // schema_migrations bookkeeping) are NOT — proving the snapshot predates every
  // startup schema mutation.
  const backupPath = join(dirname(dbFile), 'backups', summary.backups[0]);
  const copy = new DatabaseSync(backupPath);
  assert.equal(copy.prepare('SELECT v FROM marker WHERE id = 1').get().v, 'survives');
  assert.ok(
    !copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get(),
    'backup predates the admin->users rename'
  );
  assert.ok(
    !copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(),
    'backup predates schema_migrations creation'
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
