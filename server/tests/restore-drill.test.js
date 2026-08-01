import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  restoreBackup,
  verifyRestoredDatabase,
  runRestoreDrill,
  pickOffsiteBackup,
  parseBackupTimestamp,
  backupTimestampFromName,
} from '../src/restore-drill.js';
import { pushOffsiteBackup, resolveEncryptionKey } from '../src/offsite-backup.js';
import { backupDatabase } from '../src/db-backup.js';

const TMP = tmpdir();
const KEY = 'c'.repeat(64);
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');
const STARTUP_DB = join(HERE, 'fixtures', 'startup-db.js');
const APP_SECRET = 'restore-drill-secret-0123456789abcdef0123456789abcdef';

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

// Builds a fully-migrated, seeded source database at `dbFile` (real startup +
// migrations + admin seed), then inserts one published post so the reader smoke
// sees data. Returns nothing; caller owns cleanup.
function buildSourceDb(dbFile) {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', STARTUP_DB, '--seed'],
    {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        DB_PATH: dbFile,
        NODE_ENV: 'production',
        APP_SECRET,
        TRUST_PROXY: 'loopback',
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD: 'drill-pass-123',
      },
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  // Insert a published post directly so the restored DB has reader-visible data.
  const db = new DatabaseSync(dbFile);
  db.prepare(
    `INSERT INTO posts (slug, title, author_display_name, excerpt, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'drill-post',
    'Drill Post',
    'Drill Author',
    'excerpt',
    '<p>content</p>',
    'published',
    '2026-07-01T00:00:00.000Z',
    '2026-07-01T00:00:00.000Z'
  );
  db.close();
}

// Produces a local backup + an offsite (.enc) backup of `dbFile`.
function makeOffsiteBackup(dbFile, dir) {
  const localDir = join(dir, 'local');
  const offDir = join(dir, 'offsite');
  mkdirSync(localDir, { recursive: true });
  mkdirSync(offDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  const local = backupDatabase(db, { dbPath: dbFile, backupDir: localDir, version: 6, retention: 5 });
  db.close();
  assert.ok(local, 'local backup created');
  return pushOffsiteBackup({
    sourcePath: local.backupPath,
    destDir: offDir,
    key: resolveEncryptionKey(KEY),
    retention: 5,
  });
}

// ------------------------------------------------------------------ unit tests

test('restoreBackup copies a plain .db backup without a key', async () => {
  const dir = newDir('fb-restore-local-');
  const src = join(dir, 'src');
  const dbFile = join(src, 'app.db');
  mkdirSync(src, { recursive: true });
  writeFileSync(dbFile, 'plain-bytes');
  const backup = join(src, 'flipblog-pre-v6-20260720T153001.000Z-abc.db');
  writeFileSync(backup, 'backup-bytes');

  const restored = await restoreBackup({ sourcePath: backup, key: null, targetDir: src });
  assert.equal(restored.name, 'flipblog-pre-v6-20260720T153001.000Z-abc.db');
  assert.equal(readFileSync(restored.restoredPath, 'utf8'), 'backup-bytes');
  cleanup(dir);
});

test('restoreBackup refuses a missing key for an offsite .enc backup', async () => {
  const dir = newDir('fb-restore-nokey-');
  writeFileSync(join(dir, 'flipblog-pre-v6-20260720T153001.000Z-abc.db.enc'), 'x');
  await assert.rejects(
    () => restoreBackup({ sourcePath: join(dir, 'flipblog-pre-v6-20260720T153001.000Z-abc.db.enc'), key: null, targetDir: dir }),
    /BACKUP_OFFSITE_KEY/
  );
  cleanup(dir);
});

test('restoreBackup refuses a non-backup file', async () => {
  const dir = newDir('fb-restore-nonbak-');
  writeFileSync(join(dir, 'unrelated.txt'), 'x');
  await assert.rejects(
    () => restoreBackup({ sourcePath: join(dir, 'unrelated.txt'), key: null, targetDir: dir }),
    /refusing to restore non-backup/
  );
  cleanup(dir);
});

test('verifyRestoredDatabase reports ok=false for a non-database file', () => {
  const dir = newDir('fb-verify-bad-');
  const f = join(dir, 'flipblog-pre-v6-20260720T153001.000Z-abc.db');
  writeFileSync(f, 'not a database');
  const report = verifyRestoredDatabase(f);
  assert.equal(report.ok, false);
  cleanup(dir);
});

test('parseBackupTimestamp parses the canonical token and rejects garbage', () => {
  assert.equal(parseBackupTimestamp('20260720T153001.123Z').toISOString(), '2026-07-20T15:30:01.123Z');
  assert.equal(parseBackupTimestamp('nope'), null);
  assert.equal(parseBackupTimestamp(null), null);
  assert.equal(backupTimestampFromName('flipblog-pre-v6-20260720T153001.123Z-abc.db.enc').toISOString(), '2026-07-20T15:30:01.123Z');
  assert.equal(backupTimestampFromName('flipblog-pre-v6-20260720T153001.123Z-abc.db').toISOString(), '2026-07-20T15:30:01.123Z');
  assert.equal(backupTimestampFromName('garbage.txt'), null);
});

test('pickOffsiteBackup returns the newest offsite backup', async () => {
  const dir = newDir('fb-pick-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'flipblog-pre-v6-20260701T000000.000Z-old.db.enc'), 'old');
  writeFileSync(join(dir, 'flipblog-pre-v6-20260720T153001.000Z-new.db.enc'), 'new');
  const pick = pickOffsiteBackup(dir);
  assert.ok(pick);
  assert.match(pick.name, /20260720T153001\.000Z-new\.db\.enc/);
  assert.equal(pickOffsiteBackup(join(dir, 'missing')), null);
  cleanup(dir);
});

// ------------------------------------------------------------------ integration

test('full restore drill restores, boots, and passes login + reader smokes', async () => {
  const dir = newDir('fb-drill-ok-');
  const dbFile = join(dir, 'source.db');
  buildSourceDb(dbFile);
  const manifest = await makeOffsiteBackup(dbFile, dir);

  const report = await runRestoreDrill({
    sourcePath: manifest.offsitePath,
    key: KEY,
    smokeUser: 'admin',
    smokePassword: 'drill-pass-123',
    serverEnv: { APP_SECRET, TRUST_PROXY: 'loopback' },
  });

  assert.equal(report.error, null, report.error || JSON.stringify(report));
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.checks.integrity, true);
  assert.equal(report.checks.foreignKeys, true);
  assert.equal(report.checks.migrationVersion.missing.length, 0, 'restored DB is current');
  assert.equal(report.ready.ok, true);
  assert.ok(typeof report.ready.rtoMs === 'number' && report.ready.rtoMs >= 0, 'RTO recorded');
  assert.equal(report.login.ok, true, 'login smoke passes');
  assert.equal(report.reader.ok, true, 'reader smoke passes');
  assert.ok(report.reader.count >= 1, 'reader smoke sees the restored post');
  assert.ok(typeof report.rpoSeconds === 'number' && report.rpoSeconds >= 0, 'RPO recorded');
  cleanup(dir);
});

test('restore drill also accepts a plain (unencrypted) local backup', async () => {
  const dir = newDir('fb-drill-local-');
  const dbFile = join(dir, 'source.db');
  buildSourceDb(dbFile);

  const localDir = join(dir, 'local');
  mkdirSync(localDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  const local = backupDatabase(db, { dbPath: dbFile, backupDir: localDir, version: 6, retention: 5 });
  db.close();

  const report = await runRestoreDrill({
    sourcePath: local.backupPath,
    smokeUser: 'admin',
    smokePassword: 'drill-pass-123',
    serverEnv: { APP_SECRET, TRUST_PROXY: 'loopback' },
  });

  assert.equal(report.error, null, report.error || JSON.stringify(report));
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.login.ok, true);
  assert.equal(report.reader.ok, true);
  cleanup(dir);
});

test('restore drill migrates a pre-migration backup forward on boot', async () => {
  const dir = newDir('fb-drill-premig-');
  const dbFile = join(dir, 'pre.db');
  // A database with NO schema_migrations table: the backup predates every
  // migration. The raw restore check reports pending migrations (not a failure);
  // the booted server re-applies them and /api/health/ready is the authority.
  const raw = new DatabaseSync(dbFile);
  raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  raw.prepare('INSERT INTO t (v) VALUES (?)').run('pre-migration-data');
  raw.close();

  const localDir = join(dir, 'local');
  mkdirSync(localDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  const local = backupDatabase(db, { dbPath: dbFile, backupDir: localDir, version: 0, retention: 5 });
  db.close();

  const report = await runRestoreDrill({
    sourcePath: local.backupPath,
    smokeUser: 'admin',
    smokePassword: 'drill-pass-123',
    serverEnv: { APP_SECRET, TRUST_PROXY: 'loopback' },
  });

  assert.equal(report.error, null, report.error || JSON.stringify(report));
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.checks.integrity, true);
  assert.equal(report.checks.foreignKeys, true);
  assert.ok(report.checks.migrationVersion.missing.length > 0, 'raw check reports pending migrations');
  assert.equal(report.ready.ok, true, 'booted server applied pending migrations');
  assert.equal(report.reader.ok, true);
  cleanup(dir);
});

test('restore drill fails cleanly on a tampered offsite backup', async () => {
  const dir = newDir('fb-drill-tamper-');
  const dbFile = join(dir, 'source.db');
  buildSourceDb(dbFile);
  const manifest = await makeOffsiteBackup(dbFile, dir);

  const bytes = readFileSync(manifest.offsitePath);
  // Flip one ciphertext byte -> GCM authentication failure.
  bytes[bytes.length - 20] ^= 0xff;
  writeFileSync(manifest.offsitePath, bytes);

  const report = await runRestoreDrill({
    sourcePath: manifest.offsitePath,
    key: KEY,
    smokeUser: 'admin',
    smokePassword: 'drill-pass-123',
    serverEnv: { APP_SECRET, TRUST_PROXY: 'loopback' },
  });

  assert.equal(report.ok, false);
  assert.match(report.error, /authentication|decryption|wrong key|tampered/i);
  cleanup(dir);
});

test('restore drill fails cleanly on a missing key for an offsite backup', async () => {
  const dir = newDir('fb-drill-nokey-');
  const dbFile = join(dir, 'source.db');
  buildSourceDb(dbFile);
  const manifest = await makeOffsiteBackup(dbFile, dir);

  const report = await runRestoreDrill({
    sourcePath: manifest.offsitePath,
    key: null,
    smokeUser: 'admin',
    smokePassword: 'drill-pass-123',
    serverEnv: { APP_SECRET, TRUST_PROXY: 'loopback' },
  });

  assert.equal(report.ok, false);
  assert.match(report.error, /BACKUP_OFFSITE_KEY/);
  cleanup(dir);
});

test('restore drill does not leave its temp workdir behind', async () => {
  const dir = newDir('fb-drill-cleanup-');
  const dbFile = join(dir, 'source.db');
  buildSourceDb(dbFile);
  const manifest = await makeOffsiteBackup(dbFile, dir);

  const report = await runRestoreDrill({
    sourcePath: manifest.offsitePath,
    key: KEY,
    smokeUser: 'admin',
    smokePassword: 'drill-pass-123',
    serverEnv: { APP_SECRET, TRUST_PROXY: 'loopback' },
  });
  assert.equal(report.ok, true);
  // With no explicit workDir the drill cleans up its temp directory.
  assert.ok(!report.restored || !existsSync(join(tmpdir(), report.restored)), 'temp restore cleaned up');
  cleanup(dir);
});
