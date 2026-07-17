// 002 - add `avatar` (idempotent: skips if column already exists). See 001 for
// why both the `users` and legacy `admin` table names are supported.
export default {
  version: 2,
  name: 'add_avatar_to_users',
  up(db) {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','admin')")
      .get()?.name;
    if (!table) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes('avatar')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN avatar TEXT`);
    }
  },
};
