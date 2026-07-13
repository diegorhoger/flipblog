// 002 - add `avatar` to admin (idempotent: skips if column already exists).
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
