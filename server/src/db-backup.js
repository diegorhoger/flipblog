import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logging.js';

// --- Backup naming ----------------------------------------------------------
//
// A backup is taken BEFORE pending migrations run, so its name records the
// schema version we are about to migrate *from* (e.g. `flipblog-pre-v6-...db`
// is the v6 state we snapshot before applying v7). Restoring it returns the
// database to the last known-good, pre-upgrade state.
//
// The timestamp is embedded at millisecond precision and is fixed-width, so it
// sorts chronologically as text. Retention sorts by the *parsed timestamp*,
// never by the full filename (whose leading version would otherwise misorder
// v9 vs v10). To make concurrent backups race-safe across hosts and containers,
// every attempt appends a globally unique attempt identifier (a UUID); because
// the identifier is drawn from cryptographically secure randomness, two
// simultaneous startups — even in separate containers that both run as PID 1 on
// the same mounted volume at the same millisecond — can never choose the same
// final name or share a temp file. There is no time-of-check/time-of-use race
// to reserve, and no backup overwrites another.

const BACKUP_PREFIX = 'flipblog-pre-v';
const BACKUP_SUFFIX = '.db';

// flipblog-pre-v<version>-<YYYYMMDDThhmmss.SSSZ>-<attemptId>.db
const NAME_RE = /^flipblog-pre-v(\d+)-(\d{8}T\d{6}\.\d{3}Z)-([A-Za-z0-9-]+)\.db$/;

// Globally collision-resistant per-attempt identifier. Injectable for tests so
// they can simulate two processes sharing a timestamp/version/PID context.
function defaultAttemptId() {
  return randomUUID();
}

function escapeSqliteString(value) {
  // SQLite string literals use '' to escape a single quote; backslashes are
  // ordinary characters inside a literal, so only the quote needs handling.
  return String(value).replace(/'/g, "''");
}

export function timestampToken(d = new Date()) {
  // 20260720T153001.123Z — toISOString always emits exactly three fractional
  // digits, so the token is fixed-width and sorts chronologically as text.
  return d.toISOString().replace(/[-:]/g, '');
}

// Base backup name WITHOUT the uniqueness suffix (used by tests and for the
// canonical `flipblog-pre-v<version>-<ts>.db` form).
export function backupFileName(version, ts = timestampToken()) {
  return `${BACKUP_PREFIX}${version}-${ts}${BACKUP_SUFFIX}`;
}

// Parses a backup filename into its parts. Returns `null` for non-backup names.
export function parseBackupName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return { version: Number(m[1]), ts: m[2], suffix: m[3] ?? null };
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
// proceeding with no safety net. `ts` and `attemptId` are injectable for
// deterministic tests.
//
// The final name and the temp file both carry the same globally-unique attempt
// identifier, so two concurrent backup attempts (even in different containers
// that are both PID 1 on the same mounted volume at the same millisecond) can
// never collide on the destination or share a temp file — no `existsSync`-then-
// `rename` reservation race exists.
export function backupDatabase(
  db,
  { dbPath, backupDir, version = 0, retention = 5, enabled = true, ts, attemptId, log = logger } = {}
) {
  if (!isBackupApplicable(dbPath, { enabled })) return null;

  mkdirSync(backupDir, { recursive: true });
  const stamp = ts || timestampToken();
  const attempt = attemptId || defaultAttemptId();
  const finalName = `${BACKUP_PREFIX}${version}-${stamp}-${attempt}${BACKUP_SUFFIX}`;
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
  return { backupPath: finalPath, version, name: finalName, retained: pruned.retained, pruned: pruned.pruned };
}

// Keeps only the newest `retention` backups; older snapshots are removed. Order
// is determined by the *parsed timestamp* (version is irrelevant to recency and
// only a tie-breaker), so a v6 backup from today is never pruned in favour of a
// v10 backup from last year. When timestamps tie, the full name breaks the tie
// deterministically. Returns the surviving and removed names.
export function pruneBackups(backupDir, retention = 5, log = logger) {
  let names = [];
  try {
    names = readdirSync(backupDir).filter((n) => NAME_RE.test(n));
  } catch {
    return { retained: [], pruned: [] };
  }
  const parsed = names.map((name) => {
    const p = parseBackupName(name);
    return { name, ts: p.ts, version: p.version, suffix: p.suffix };
  });
  parsed.sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

  const removeCount = Math.max(0, parsed.length - retention);
  const toRemove = parsed.slice(0, removeCount);
  const pruned = [];
  for (const { name } of toRemove) {
    try {
      rmSync(join(backupDir, name), { force: true });
      pruned.push(name);
    } catch {
      log.warn({ event: 'db_backup_prune_failed', name });
    }
  }
  return { retained: parsed.slice(removeCount).map((p) => p.name), pruned };
}
