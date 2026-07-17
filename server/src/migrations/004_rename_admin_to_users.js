// 004 - rename the `admin` table to `users`.
//
// The table now models all authenticated accounts (admins and authors), not only
// administrators, so the original name is misleading. SQLite supports renaming a
// table in place (preserving data, indexes, and triggers), which is far safer
// than a copy/rebuild — it is applied only when an `admin` table actually exists,
// so it is a no-op on a database that was created with the `users` name already
// (e.g. a fresh install), and it is skipped on re-runs thanks to the migration
// registry. Runs inside runMigrations' transaction, so a failure rolls back.
export default {
  version: 4,
  name: 'rename_admin_to_users',
  up(db) {
    const hasAdmin = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin'")
      .get();
    if (hasAdmin) {
      db.exec('ALTER TABLE admin RENAME TO users');
    }
  },
};
