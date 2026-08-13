import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');
const TOOL = join(SERVER_ROOT, 'scripts', 'db-rollback-check.mjs');

function newDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// A release fixture: a copy of the real migration registry (versions 1..6),
// exactly like a built release ships under src/migrations/.
function makeRelease(dir) {
  const rel = join(dir, 'release');
  mkdirSync(join(rel, 'src'), { recursive: true });
  cpSync(join(SERVER_ROOT, 'src', 'migrations'), join(rel, 'src', 'migrations'), { recursive: true });
  return rel;
}

function makeDbWithVersions(file, versions) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  for (const v of versions) {
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(v, `m${v}`, '2026-01-01T00:00:00.000Z');
  }
  db.close();
}

function makeBackup(dir, name, versions) {
  mkdirSync(dir, { recursive: true });
  makeDbWithVersions(join(dir, name), versions);
}

function run(args) {
  const r = spawnSync(process.execPath, ['--no-warnings', TOOL, ...args], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('no restore needed when the DB schema is within the target registry', () => {
  const dir = newDir('fb-gate-ok-');
  const release = makeRelease(dir);
  const dbPath = join(dir, 'live.db');
  makeDbWithVersions(dbPath, [1, 2, 3, 4, 5, 6]);

  const r = run(['--release', release, '--db-path', dbPath]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.restore, false);
  assert.equal(out.reason, 'compatible');
  cleanup(dir);
});

test('fresh DB (no file yet) is compatible by definition', () => {
  const dir = newDir('fb-gate-nodb-');
  const release = makeRelease(dir);
  const dbPath = join(dir, 'not-yet-created.db');

  const r = run(['--release', release, '--db-path', dbPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).restore, false);
  cleanup(dir);
});

test('restore is reported (dry-run) when the DB is ahead of the target', () => {
  const dir = newDir('fb-gate-ahead-');
  const release = makeRelease(dir);
  const dbPath = join(dir, 'live.db');
  makeDbWithVersions(dbPath, [1, 2, 3, 4, 5, 6, 7]); // target only knows 1..6
  const backups = join(dir, 'backups');
  makeBackup(backups, 'flipblog-pre-v6-20260720T153001.000Z-abc.db', [1, 2, 3, 4, 5, 6]);

  const r = run(['--release', release, '--db-path', dbPath, '--backup-dir', backups]);
  assert.equal(r.status, 3, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.restore, true);
  assert.deepEqual(out.unexpected, [7]);
  assert.equal(out.backup, 'flipblog-pre-v6-20260720T153001.000Z-abc.db');
  cleanup(dir);
});

test('--apply restores the newest compatible pre-migration backup', () => {
  const dir = newDir('fb-gate-apply-');
  const release = makeRelease(dir);
  const dbPath = join(dir, 'live.db');
  makeDbWithVersions(dbPath, [1, 2, 3, 4, 5, 6, 7]);
  const backups = join(dir, 'backups');
  // Older compatible backup is present too; the newest (same day, later ts) wins.
  makeBackup(backups, 'flipblog-pre-v5-20260719T100000.000Z-old.db', [1, 2, 3, 4, 5]);
  makeBackup(backups, 'flipblog-pre-v6-20260720T153001.000Z-new.db', [1, 2, 3, 4, 5, 6]);

  const r = run(['--release', release, '--db-path', dbPath, '--backup-dir', backups, '--apply']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.restore, true);
  assert.equal(out.action, 'restored');
  assert.equal(out.backup, 'flipblog-pre-v6-20260720T153001.000Z-new.db');

  // The live DB now holds exactly the backup's schema.
  const check = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = check.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(rows.map((x) => x.version), [1, 2, 3, 4, 5, 6]);
  } finally {
    check.close();
  }
  cleanup(dir);
});

test('--apply refuses when the only backups predate nothing the target can open', () => {
  const dir = newDir('fb-gate-refuse-');
  const release = makeRelease(dir);
  const dbPath = join(dir, 'live.db');
  makeDbWithVersions(dbPath, [1, 2, 3, 4, 5, 6, 7]);
  const backups = join(dir, 'backups');
  // Only a pre-v7 backup: version 7 > target max 6, so no compatible candidate.
  makeBackup(backups, 'flipblog-pre-v7-20260720T153001.000Z-x.db', [1, 2, 3, 4, 5, 6, 7]);

  const r = run(['--release', release, '--db-path', dbPath, '--backup-dir', backups, '--apply']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSING/);
  assert.match(r.stderr, /version <= 6/);
  cleanup(dir);
});

test('usage errors fail loudly with a non-zero exit', () => {
  const r = run([]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /--release/);
});

test('a release without a migration registry fails loudly', () => {
  const dir = newDir('fb-gate-noreg-');
  mkdirSync(join(dir, 'release'), { recursive: true });
  const r = run(['--release', join(dir, 'release')]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /src\/migrations\/index\.js/);
  cleanup(dir);
});
