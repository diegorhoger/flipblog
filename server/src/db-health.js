import { MIGRATIONS } from './migrations/index.js';

// --- Schema version helpers -------------------------------------------------
//
// The "expected" versions are those present in the migration registry compiled
// into this build. A healthy database must have applied every expected version
// AND must not contain any applied version the build does not recognise — an
// unrecognised version means a newer build migrated this database, and letting
// an older build start against it is exactly the downgrade / schema-drift
// failure a version gate exists to prevent.

export function getCurrentSchemaVersion(db) {
  const has = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!has) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row && row.v != null ? row.v : 0;
}

export function getExpectedSchemaVersion() {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

// --- Health check -----------------------------------------------------------
//
// Verifies the database is sound and fully migrated. It NEVER throws: it always
// returns a structured report so callers (startup, /health/ready) can decide
// fail-closed without this module ever leaking SQL text or filesystem paths.
//
//   integrity       — PRAGMA integrity_check returns only `ok` rows
//   foreignKeys     — PRAGMA foreign_key_check returns no violation rows
//   migrationVersion— every expected version applied AND no unknown version applied
//
// `ok` is true only when all checks pass and both `missing` and `unexpected`
// are empty. Migration versions are not assumed to be contiguous.
export function checkDatabaseHealth(db, migrations = MIGRATIONS) {
  const integrityRows = db.prepare('PRAGMA integrity_check').all();
  const integrity =
    integrityRows.length > 0 && integrityRows.every((r) => r.integrity_check === 'ok');

  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  const foreignKeys = fkViolations.length === 0;

  const appliedSet = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  const registryVersions = new Set(migrations.map((m) => m.version));
  const missing = migrations.filter((m) => !appliedSet.has(m.version)).map((m) => m.version);
  const unexpected = [...appliedSet]
    .filter((v) => !registryVersions.has(v))
    .sort((a, b) => a - b);

  const migrationVersion = {
    expected: migrations.reduce((max, m) => Math.max(max, m.version), 0),
    applied: [...appliedSet].sort((a, b) => a - b),
    missing,
    unexpected,
  };

  return {
    ok: integrity && foreignKeys && missing.length === 0 && unexpected.length === 0,
    checks: {
      integrity,
      foreignKeys,
      migrationVersion,
    },
  };
}
