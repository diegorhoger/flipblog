// 002 - add `avatar` to admin (idempotent: skips if column already exists).
// Historical migration identity kept as add_avatar_to_admin; the table is
// `admin` at this point (the baseline creates it, and 004 renames it later).
export default {
  version: 2,
  name: 'add_avatar_to_admin',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(admin)').all().map((c) => c.name);
    if (!cols.includes('avatar')) {
      db.exec('ALTER TABLE admin ADD COLUMN avatar TEXT');
    }
  },
};
