// Restore drill: restores the newest offsite backup (or one named by
// RESTORE_SOURCE) into a clean environment, boots a real server against it, and
// verifies integrity, foreign keys, migrations, login, and the reader API.
// Records RTO (time to ready) and RPO (age of the backup) in the report.
//
// Usage:
//   node scripts/restore-drill.js
//
// Environment:
//   BACKUP_OFFSITE_DIR      where offsite backups live (required for newest)
//   BACKUP_OFFSITE_KEY      AES-256 key: 64 hex chars or base64 (required for .enc)
//   RESTORE_SOURCE          optional: a specific backup file (.db or .enc) to restore
//   RESTORE_WORK_DIR        optional: keep the restored DB at this path (default: temp, cleaned up)
//   ADMIN_USER / ADMIN_PASSWORD   credentials for the login smoke (default: admin/admin)
//   APP_SECRET / TRUST_PROXY      forwarded to the booted server
//
// Prints a single-line JSON report and exits non-zero when any check fails.
import { basename } from 'node:path';
import { config } from '../src/config.js';
import { pickOffsiteBackup, runRestoreDrill } from '../src/restore-drill.js';

function fail(message) {
  process.stderr.write(`restore-drill: ${message}\n`);
  process.exit(1);
}

async function main() {
  const source = process.env.RESTORE_SOURCE;
  let sourcePath = source || null;
  if (!sourcePath) {
    if (!config.backupOffsiteDir) fail('BACKUP_OFFSITE_DIR is not set (or pass RESTORE_SOURCE)');
    const pick = pickOffsiteBackup(config.backupOffsiteDir);
    if (!pick) fail(`no offsite backup found in ${config.backupOffsiteDir}`);
    sourcePath = pick.path;
  }

  const report = await runRestoreDrill({
    sourcePath,
    key: config.backupOffsiteKey || undefined,
    workDir: process.env.RESTORE_WORK_DIR || undefined,
    smokeUser: config.adminUser,
    smokePassword: config.adminPassword,
    serverEnv: {
      APP_SECRET: config.appSecret,
      TRUST_PROXY: config.trustProxy,
    },
  });

  process.stdout.write(JSON.stringify({ source: basename(sourcePath), ...report }) + '\n');
  if (!report.ok) process.exit(1);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
