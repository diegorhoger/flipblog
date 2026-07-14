// 001 — add `role` to admin (idempotent: skips if column already exists).
export default {
  version: 1,
  name: 'add_role_to_admin',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(admin)').all().map((c) => c.name);
    if (!cols.includes('role')) {
      db.exec("ALTER TABLE admin ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
    }
  },
};
