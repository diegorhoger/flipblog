// 001 — add `role` (idempotent: skips if column already exists). The table may
// be named `admin` (pre-rename databases) or `users` (after migration 004 / a
// fresh install); support both so the sequence is order-independent.
export default {
  version: 1,
  name: 'add_role_to_users',
  up(db) {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','admin')")
      .get()?.name;
    if (!table) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes('role')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
    }
  },
};
