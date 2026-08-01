// Offsite backup push: encrypts the newest local backup (or one named by
// BACKUP_SOURCE) and places it in the offsite directory as `<name>.enc`.
//
// Usage:
//   node scripts/offsite-backup.js
//
// Environment:
//   BACKUP_OFFSITE_DIR   destination directory (required; independent of the app disk)
//   BACKUP_OFFSITE_KEY   AES-256 key: 64 hex chars or base64 (required)
//   BACKUP_OFFSITE_RETENTION  how many offsite copies to keep (default 5)
//   BACKUP_SOURCE        optional: a specific local backup file to push (default: newest)
//   DB_BACKUP_DIR        local backup directory (used when BACKUP_SOURCE is unset)
//   DB_PATH              database path (used to locate the default local backup dir)
//
// Prints a single-line JSON manifest and exits non-zero on failure.
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { config } from '../src/config.js';
import { pushOffsiteBackup, parseOffsiteName, listOffsiteBackups, resolveEncryptionKey } from '../src/offsite-backup.js';
import { parseBackupName } from '../src/db-backup.js';

function fail(message) {
  process.stderr.write(`offsite-backup: ${message}\n`);
  process.exit(1);
}

function newestLocalBackup(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((n) => parseBackupName(n))
    .sort((a, b) => {
      const pa = parseBackupName(a);
      const pb = parseBackupName(b);
      if (pa.ts < pb.ts) return 1;
      if (pa.ts > pb.ts) return -1;
      return a < b ? 1 : -1;
    });
  return names.length ? join(dir, names[0]) : null;
}

async function main() {
  if (!config.backupOffsiteDir) fail('BACKUP_OFFSITE_DIR is not set');
  if (!config.backupOffsiteKey) fail('BACKUP_OFFSITE_KEY is not set');
  let key;
  try {
    key = resolveEncryptionKey(config.backupOffsiteKey);
  } catch (err) {
    fail(err.message);
  }

  const source = process.env.BACKUP_SOURCE;
  let sourcePath = source && existsSync(source) ? source : null;
  if (!sourcePath) {
    sourcePath = newestLocalBackup(config.dbBackupDir);
    if (!sourcePath) {
      fail(`no local backup found in ${config.dbBackupDir} — run the server once with pending migrations, or set BACKUP_SOURCE`);
    }
  }

  const manifest = await pushOffsiteBackup({
    sourcePath,
    destDir: config.backupOffsiteDir,
    key,
    retention: config.backupOffsiteRetention,
  });

  const all = listOffsiteBackups(config.backupOffsiteDir).map((b) => b.name);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      source: basename(sourcePath),
      pushed: manifest.name,
      version: manifest.version,
      offsiteDir: config.backupOffsiteDir,
      retained: manifest.retained.length,
      pruned: manifest.pruned,
      newestFirst: all,
    }) + '\n'
  );
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
