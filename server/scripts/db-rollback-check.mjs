#!/usr/bin/env node
// db-rollback-check.mjs
//
// Migration-aware rollback safety gate, run on the HOST as part of a deploy or
// manual rollback. A symlink flip alone is NOT a safe rollback when the failed
// release applied a database migration first: the older build refuses to start
// against the newer schema (server/src/db.js fails closed on inspectMigrationState()
// "unexpected" versions). This tool detects that situation before the flip and,
// with --apply, restores the newest compatible pre-migration backup so the older
// release can boot.
//
// The tool is self-contained on purpose (no imports beyond node built-ins and a
// path-to-file dynamic import): scripts scp it to the host in isolation and run
// it from /tmp, so it stays correct no matter how old the target release is.
//
// Usage:
//   node db-rollback-check.mjs \
//     --release <releaseDir> \
//     [--db-path <path>] [--backup-dir <dir>] [--apply]
//
//   --release     absolute path to the release directory we are rolling BACK to.
//                 Its own src/migrations/index.js supplies the target migration
//                 registry, so each release is judged by the schema it actually
//                 ships (not the runner's checkout).
//   --db-path     live database file the target release must open
//                 (default: report-only "no db needed" path).
//   --backup-dir  where flipblog-pre-v*.db backups live
//                 (default: <dir of db-path>/backups).
//   --apply       restore the newest compatible backup over the live db-path.
//                 Without it the tool only reports.
//
// Exit codes:
//   0  safe to flip (no restore needed, or a restore was applied with --apply)
//   2  restore REQUIRED but no compatible backup exists -> refuse the flip;
//      the operator must restore from offsite/encrypted backups first
//   4  usage / IO error / release has no migration registry
//
// A backup is "compatible" when its recorded pre-migration version is <= the
// target release's max known migration version: the captured state predates or
// equals the target's schema knowledge, so the target opens it cleanly and re-runs
// any migrations it knows that the snapshot predates.
import { existsSync, readdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// --- inline copy of server/src/db-backup.js parseBackupName ------------------
// flipblog-pre-v<version>-<YYYYMMDDThhmmss.SSSZ>-<attemptId>.db
const NAME_RE = /^flipblog-pre-v(\d+)-(\d{8}T\d{6}\.\d{3}Z)-([A-Za-z0-9-]+)\.db$/;
function parseBackupName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return { version: Number(m[1]), ts: m[2], attemptId: m[3] };
}

function fail(message) {
  process.stderr.write(`db-rollback-check: ${message}\n`);
  process.exit(4);
}

function argsMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) fail(`unknown argument: ${k}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[k.slice(2)] = true;
    } else {
      out[k.slice(2)] = next;
      i++;
    }
  }
  return out;
}

// Applied migration versions present in a database, read-only. A missing DB
// (first deploy) or missing ledger (fresh DB) reports an empty applied list.
function appliedVersions(dbPath) {
  if (!existsSync(dbPath)) return { exists: false, applied: [] };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (!has) return { exists: true, applied: [] };
    return {
      exists: true,
      applied: db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((r) => r.version)
        .sort((a, b) => a - b),
    };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

// Versions in the target release's own migration registry via dynamic import
// (release dirs are ESM; pathToFileURL makes an absolute path importable).
async function targetVersions(releaseDir) {
  const index = join(releaseDir, 'src', 'migrations', 'index.js');
  if (!existsSync(index)) return { exists: false, versions: [] };
  try {
    const m = await import(pathToFileURL(index));
    const list = (m.MIGRATIONS || []).map((x) => x.version).sort((a, b) => a - b);
    return { exists: true, versions: list };
  } catch (err) {
    process.stderr.write(`db-rollback-check: cannot load target migration registry ${index}: ${err.message}\n`);
    return { exists: false, versions: [] };
  }
}

function newestCompatibleBackup(backupDir, maxKnown) {
  if (!existsSync(backupDir)) return null;
  const candidates = [];
  for (const name of readdirSync(backupDir)) {
    const p = parseBackupName(name);
    if (!p || p.version > maxKnown) continue;
    candidates.push({ name, ts: p.ts, version: p.version });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.name < b.name ? 1 : -1));
  return candidates[0];
}

async function main() {
  const a = argsMap(process.argv.slice(2));
  if (!a.release || a.release === true || typeof a.release !== 'string') {
    fail('--release <releaseDir> is required');
  }
  const releaseDir = a.release;
  const dbPath = a['db-path'];
  const backupDir = a['backup-dir'];
  const apply = !!a.apply;
  const wantDbPath = dbPath && typeof dbPath === 'string' && dbPath !== true ? dbPath : null;

  const target = await targetVersions(releaseDir);
  if (!target.exists) {
    fail(`target release has no readable src/migrations/index.js (${join(releaseDir, 'src', 'migrations', 'index.js')})`);
  }
  const maxKnown = target.versions.length ? Math.max(...target.versions) : 0;

  if (!wantDbPath) {
    process.stdout.write(JSON.stringify({ restore: false, reason: 'no-db-path' }) + '\n');
    process.exit(0);
  }

  const live = appliedVersions(wantDbPath);
  if (live.exists) {
    const targetSet = new Set(target.versions);
    const unexpected = live.applied.filter((v) => !targetSet.has(v));
    if (unexpected.length > 0) {
      const bd = (backupDir && typeof backupDir === 'string' && backupDir !== true)
        ? backupDir
        : join(dirname(wantDbPath), 'backups');      const report = { restore: true, reason: 'unexpected-schema', unexpected, maxKnown, apply };
      if (apply) {
        const pick = newestCompatibleBackup(bd, maxKnown);
        if (!pick) {
          process.stderr.write(
            `db-rollback-check: DB schema (${live.applied.join(',')}) is newer than target max (${maxKnown}), ` +
              `but no compatible backup (version <= ${maxKnown}) exists in "${bd}".\n` +
              `REFUSING to flip; restore from the offsite/encrypted backups first.\n`
          );
          process.exit(2);
        }
        const src = join(bd, pick.name);
        const tmp = `${wantDbPath}.rollback.${process.pid}.tmp`;
        copyFileSync(src, tmp);
        renameSync(tmp, wantDbPath);
        report.action = 'restored';
        report.backup = pick.name;
        report.version = pick.version;
      } else {
        report.backup = newestCompatibleBackup(bd, maxKnown)?.name || null;
        process.stdout.write(JSON.stringify(report) + '\n');
        process.exit(3);
      }
      process.stdout.write(JSON.stringify(report) + '\n');
      process.exit(0);
    }
  }

  process.stdout.write(JSON.stringify({ restore: false, reason: 'compatible', dbPath: wantDbPath }) + '\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`db-rollback-check: unexpected error: ${err && err.stack ? err.stack : err}\n`);
  process.exit(4);
});