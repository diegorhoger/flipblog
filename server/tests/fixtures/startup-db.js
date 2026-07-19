// Test fixture: exercises the REAL server startup path (getDb → pragmas →
// baseline schema → migrations → optional seed) in an isolated child process so
// each run gets a fresh module graph, fresh config resolution, and a fresh
// db.js singleton. This is what a deployed process actually does — not an
// in-process re-import of cached modules.
//
// Reads the target database from process.env.DB_PATH. When --seed is passed it
// also seeds the configured admin account (mirroring index.js startup). Prints a
// deterministic JSON summary to stdout and exits nonzero on any startup,
// migration, or seed failure. No diagnostics or secrets are ever printed.
import { getDb, closeDb } from '../../src/db.js';
import { seedUserIfMissing } from '../../src/services/users.js';

async function main() {
  const doSeed = process.argv.includes('--seed');
  const db = getDb();
  if (doSeed) {
    // seedUserIfMissing is async; await it BEFORE closing the database so the
    // insert is not raced by closeDb().
    await seedUserIfMissing();
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

  const users = db
    .prepare('SELECT id, username, role, avatar FROM users ORDER BY id')
    .all();

  const migration4 = db
    .prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 4')
    .get().c;

  // posts.author_id -> users(id) foreign key (added by migration 005). A
  // non-empty foreign_key_list means the constraint is declared on posts.
  const postsFk = db
    .prepare("PRAGMA foreign_key_list(posts)")
    .all()
    .filter((fk) => fk.table === 'users' && fk.from === 'author_id');

  const summary = {
    tables,
    users,
    migration4Count: migration4,
    postsAuthorFk: postsFk.length > 0,
  };
  process.stdout.write(JSON.stringify(summary));
  closeDb();
}

main().catch((err) => {
  process.stderr.write(`startup-db fixture failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
