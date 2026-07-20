import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { logger } from './logging.js';

// --- Backup naming ----------------------------------------------------------
//
// A backup is taken BEFORE pending migrations run, so its name records the
// schema version we are about to migrate *from* (e.g. `flipblog-pre-v6-...db`
// is the v6 state we snapshot before applying v7). Restoring it returns the
// database to the last known-good, pre-upgrade state. The timestamp is embedded
// directly in the filename as a compact, sortable UTC token so that a lexical
// sort of the directory doubles as a chronological sort (newest last).

const BACKUP_PREFIX = 'flipblog-pre-v';
const BACKUP_SUFFIX = '.db';
const VERSION_RE = /^flipblog-pre-v(\d+)-.*\.db$/;

function escapeSqliteString(value) {
  // SQLite string literals use '' to escape a single quote; backslashes are
  // ordinary characters inside a literal, so only the quote needs handling.
  return String(value).replace(/'/g, "''");
}

export function timestampToken(d = new Date()) {
  // 20260720T153001Z — drops fractional seconds so the name stays stable.
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

export function backupFileName(version, ts = timestampToken()) {
  return `${BACKUP_PREFIX}${version}-${ts}${BACKUP_SUFFIX}`;
}

// A backup is only meaningful for a real, persisted database. In-memory
// databases and disabled/test runs produce no backup (callers get `null`).
export function isBackupApplicable(dbPath, { enabled = true } = {}) {
  if (!enabled) return false;
  if (!dbPath || dbPath === ':memory:') return false;
  return true;
}

export function defaultBackupDir(dbPath) {
  return join(dirname(dbPath), 'backups');
}

// Performs an online, crash-consistent backup of the live database via
// `VACUUM INTO` (which copies a consistent snapshot without blocking writers),
// then atomically moves the temp file into place. Returns the final backup
// path, or `null` when no backup is applicable. Throws only on a genuine backup
// failure so the caller can fail the startup closed rather than silently
// proceeding with no safety net.
export function backupDatabase(
  db,
  { dbPath, backupDir, version = 0, retention = 5, enabled = true, log = logger } = {}
) {
  if (!isBackupApplicable(dbPath, { enabled })) return null;

  mkdirSync(backupDir, { recursive: true });
  const finalName = backupFileName(version);
  const finalPath = join(backupDir, finalName);
  const tmpPath = join(backupDir, `.${finalName}.tmp`);

  try {
    db.exec(`VACUUM INTO '${escapeSqliteString(tmpPath)}'`);
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // Never leave a half-written temp file behind to confuse retention.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort */
    }
    log.error({ event: 'db_backup_failed', version }, err);
    throw new Error(
      `Database backup failed before migrations: ${err && err.message ? err.message : err}`
    );
  }

  const pruned = pruneBackups(backupDir, retention, log);
  log.info({
    event: 'db_backup_created',
    version,
    name: finalName,
    retained: pruned.retained.length,
  });
  return { backupPath: finalPath, version, retained: pruned.retained, pruned: pruned.pruned };
}

// Keeps only the newest `retention` backups; older snapshots are removed. The
// embedded sortable timestamp makes lexical sort == chronological order, so we
// keep the tail and delete the head. Returns the surviving and removed names.
export function pruneBackups(backupDir, retention = 5, log = logger) {
  let entries = [];
  try {
    entries = readdirSync(backupDir).filter((n) => VERSION_RE.test(n));
  } catch {
    return { retained: [], pruned: [] };
  }
  entries.sort();
  const removeCount = Math.max(0, entries.length - retention);
  const toRemove = entries.slice(0, removeCount);
  const pruned = [];
  for (const name of toRemove) {
    try {
      rmSync(join(backupDir, name), { force: true });
      pruned.push(name);
    } catch {
      log.warn({ event: 'db_backup_prune_failed', name });
    }
  }
  return { retained: entries.slice(removeCount), pruned };
}
