import migration001 from './001_add_role.js';
import migration002 from './002_add_avatar.js';
import migration003 from './003_add_author_id.js';
import migration004 from './004_rename_admin_to_users.js';
import migration005 from './005_add_posts_author_fk.js';
import migration006 from './006_rename_post_author_columns.js';

// Ordered migration registry. Add new migrations here in ascending version
// order. Imports are static (not dynamic) so migrations run synchronously —
// node:sqlite is synchronous and getDb() must return a fully-migrated schema.
export const MIGRATIONS = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
].sort((a, b) => a.version - b.version);

function ensureMigrationsTable(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`
  );
}

function appliedVersions(db) {
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
}

// Returns the migrations not yet recorded as applied. Used by the startup path
// to decide whether an upgrade (and therefore a pre-migration backup) is
// actually happening — an ordinary restart with nothing pending must not create
// a backup, or every reboot would mint five identical copies and call it
// resilience. Exported so callers can probe without running migrations.
export function getPendingMigrations(db, migrations = MIGRATIONS) {
  ensureMigrationsTable(db);
  const applied = appliedVersions(db);
  return migrations.filter((m) => !applied.has(m.version));
}

function validateUniqueVersions(migrations) {
  const seen = new Set();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version} (${m.name})`);
    }
    seen.add(m.version);
  }
}

// Runs every pending migration inside a single transaction so a failure rolls
// back cleanly instead of leaving a half-applied schema. Migrations are applied
// in version order; already-applied versions are skipped. Any error is thrown
// so the caller fails closed (the app must not serve requests on a broken
// schema). An optional `migrations` list can be supplied (used by tests to force
// failure scenarios); otherwise the built-in registry is used.
export function runMigrations(db, migrations = MIGRATIONS) {
  validateUniqueVersions(migrations);
  ensureMigrationsTable(db);
  const applied = appliedVersions(db);
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const m of pending) {
      m.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(m.version, m.name, new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
