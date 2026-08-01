import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { logger } from './logging.js';
import { decryptFile, parseOffsiteName, newestOffsiteBackup, resolveEncryptionKey } from './offsite-backup.js';
import { checkDatabaseHealth, getExpectedSchemaVersion } from './db-health.js';
import { parseBackupName } from './db-backup.js';

const here = dirname(fileURLToPath(import.meta.url));
export const serverEntry = join(here, 'index.js');

// --- Source selection -------------------------------------------------------

// Returns the newest offsite backup in `dir`, or null. Only `.enc` FlipBlog
// backups are considered.
export function pickOffsiteBackup(dir) {
  return newestOffsiteBackup(dir);
}

// Converts a backup-name timestamp token (20260720T153001.123Z) to a Date.
// Returns null when the token is malformed.
export function parseBackupTimestamp(token) {
  if (!token) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/.exec(token);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]));
}

export function backupTimestampFromName(name) {
  const p = parseOffsiteName(name) || parseBackupName(name);
  return p ? parseBackupTimestamp(p.ts) : null;
}

// --- Restore ----------------------------------------------------------------

// Copies (plain `.db`) or decrypts (`.enc`) a backup file into `targetDir`.
// Returns the restored file path and the backup's metadata. Throws when the
// source is not a recognizable backup or the key is missing for an `.enc`.
export async function restoreBackup({ sourcePath, key, targetDir }) {
  const name = basename(sourcePath);
  const offsite = parseOffsiteName(name);
  const local = parseBackupName(name);
  if (!offsite && !local) {
    throw new Error(`refusing to restore non-backup file: ${name}`);
  }
  const destName = offsite ? name.slice(0, -'.enc'.length) : name;
  const dest = join(targetDir, destName);
  if (offsite) {
    if (!key) throw new Error('cannot restore offsite backup: BACKUP_OFFSITE_KEY is required to decrypt');
    await decryptFile(sourcePath, resolveEncryptionKey(key), dest);
  } else {
    copyFileSync(sourcePath, dest);
  }
  const p = offsite || local;
  return { restoredPath: dest, name, version: p.version, ts: p.ts };
}

// Runs integrity, foreign-key, and migration audits directly against a restored
// database file (read-only). Never throws; returns a structured report. `ok` is
// false when the file cannot be opened at all, when integrity or foreign keys
// fail, or when the ledger records a version this build does not recognise
// (future migration — an older build must never start against it).
//
// A backup taken BEFORE pending migrations ran has no `schema_migrations` table
// yet: `pending` then equals every expected version, which is NOT a failure —
// the drill's boot step re-applies them and /api/health/ready is the authority
// on whether the restored database is current.
export function verifyRestoredDatabase(dbPath) {
  const hasLedger = (db) =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  const expected = getExpectedSchemaVersion();
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const integrityRows = db.prepare('PRAGMA integrity_check').all();
      const integrity =
        integrityRows.length > 0 && integrityRows.every((r) => r.integrity_check === 'ok');
      const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
      const foreignKeys = fkViolations.length === 0;

      let migrationVersion;
      if (hasLedger(db)) {
        const health = checkDatabaseHealth(db);
        migrationVersion = health.checks.migrationVersion;
      } else {
        migrationVersion = { expected, applied: [], missing: [], unexpected: [] };
        for (let v = 1; v <= expected; v++) migrationVersion.missing.push(v);
      }
      const future = migrationVersion.unexpected.length > 0;
      return {
        ok: integrity && foreignKeys && !future,
        integrity,
        foreignKeys,
        migrationVersion,
      };
    } finally {
      db.close();
    }
  } catch {
    return {
      ok: false,
      integrity: false,
      foreignKeys: false,
      migrationVersion: { expected, applied: [], missing: [], unexpected: [] },
    };
  }
}

// --- Drill orchestration ----------------------------------------------------

async function waitForEndpoint(url, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(intervalMs) });
      lastStatus = res.status;
      if (res.ok) return res;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error(`endpoint ${url} did not become healthy within ${timeoutMs}ms (last status ${lastStatus})`);
  err.code = 'DRILL_TIMEOUT';
  throw err;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Performs the restore drill:
//   1. restore the backup into a clean temp directory,
//   2. verify integrity / FK / migration directly on the restored file,
//   3. boot a real server against the restored database,
//   4. wait for /api/health/ready (integrity + FK + migration gate),
//   5. login smoke (POST /api/auth/login) and reader smoke (GET /api/posts),
//   6. record RTO (time to ready) and RPO (age of the backup).
//
// `serverEnv` augments the server child's environment (DB_PATH, PORT and the
// admin credentials are set by the drill). Returns a structured report; never
// throws — failures are captured in the report so the CLI can exit non-zero
// with a precise diagnosis. The temp workdir and server process are always
// cleaned up.
export async function runRestoreDrill({
  sourcePath,
  key,
  workDir,
  serverEnv = {},
  smokeUser,
  smokePassword,
  log = logger,
} = {}) {
  const startedAt = Date.now();
  const report = {
    ok: false,
    source: basename(sourcePath || ''),
    restored: null,
    checks: null,
    ready: { ok: false, rtoMs: null },
    login: { ok: false, status: null },
    reader: { ok: false, status: null, count: null },
    rpoSeconds: null,
    error: null,
  };

  let dir = workDir;
  let child;
  let port;
  try {
    if (!dir) dir = mkdtempSync(join(tmpdir(), 'flipblog-drill-'));
    const backupTs = backupTimestampFromName(basename(sourcePath || ''));
    if (backupTs) report.rpoSeconds = Math.max(0, Math.round((startedAt - backupTs.getTime()) / 1000));

    const restored = await restoreBackup({ sourcePath, key, targetDir: dir });
    report.restored = restored.name;
    report.checks = verifyRestoredDatabase(restored.restoredPath);
    report.checks.ok = report.checks.ok && report.checks.integrity && report.checks.foreignKeys;

    port = await pickFreePort();
    child = spawn(process.execPath, [serverEntry], {
      cwd: dirname(serverEntry),
      env: {
        ...process.env,
        ...serverEnv,
        DB_PATH: restored.restoredPath,
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: serverEnv.NODE_ENV || 'production',
        // The booted server seeds its admin with ADMIN_USER/ADMIN_PASSWORD when
        // the restored database has none; the login smoke must use the same
        // credentials the seeded admin will have.
        ADMIN_USER: smokeUser,
        ADMIN_PASSWORD: smokePassword,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const base = `http://127.0.0.1:${port}`;
    await waitForEndpoint(`${base}/api/health/ready`, { timeoutMs: 45_000 });
    report.ready = { ok: true, rtoMs: Date.now() - startedAt };

    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: smokeUser, password: smokePassword }),
      signal: AbortSignal.timeout(10_000),
    });
    report.login = { ok: loginRes.ok, status: loginRes.status };

    const readerRes = await fetch(`${base}/api/posts`, { signal: AbortSignal.timeout(10_000) });
    let count = null;
    if (readerRes.ok) {
      const body = await readerRes.json();
      count = body && Array.isArray(body.items) ? body.items.length : null;
    }
    report.reader = { ok: readerRes.ok && count !== null, status: readerRes.status, count };

    const healthy = report.ready.ok && report.login.ok && report.reader.ok;
    report.ok = report.checks.ok && healthy;
    if (!report.ok) {
      report.error = 'one or more drill checks failed';
    }
  } catch (err) {
    report.error = err && err.message ? err.message : String(err);
    log.error({ event: 'restore_drill_failed' }, err);
  } finally {
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        /* best-effort */
      }
    }
    if (workDir === undefined && dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  return report;
}
