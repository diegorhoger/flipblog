import { MIGRATIONS } from './migrations/index.js';

// --- Schema version helpers -------------------------------------------------
//
// The "current" version of a live database is the highest `version` recorded in
// `schema_migrations`. The "expected" version is the highest version present in
// the migration registry compiled into this build — i.e. the version the code
// believes the database should have reached. A healthy database has every
// registry migration recorded.

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
//   migrationVersion— every registry migration is recorded as applied
//
// `ok` is true only when all three checks pass.
export function checkDatabaseHealth(db) {
  const integrityRows = db.prepare('PRAGMA integrity_check').all();
  const integrity =
    integrityRows.length > 0 && integrityRows.every((r) => r.integrity_check === 'ok');

  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  const foreignKeys = fkViolations.length === 0;

  const appliedSet = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  const missing = MIGRATIONS.filter((m) => !appliedSet.has(m.version)).map((m) => m.version);

  const migrationVersion = {
    expected: getExpectedSchemaVersion(),
    applied: [...appliedSet].sort((a, b) => a - b),
    missing,
  };

  return {
    ok: integrity && foreignKeys && missing.length === 0,
    checks: {
      integrity,
      foreignKeys,
      migrationVersion,
    },
  };
}
