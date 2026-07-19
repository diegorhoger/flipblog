// 004 - rename the `admin` table to `users`.
//
// The table now models all authenticated accounts (admins and authors), not only
// administrators, so the original name is misleading. SQLite supports renaming a
// table in place (preserving data, indexes, and triggers), which is far safer
// than a copy/rebuild. It runs inside runMigrations' transaction, so a failure
// rolls back.
//
// The baseline schema still creates `admin`, so every database — fresh or legacy
// — passes through `admin` first and lands on `users` here. This keeps fresh and
// existing deployments on the same transition path (no competing bootstrap
// histories). The handler below is explicit about every possible starting state:
export default {
  version: 4,
  name: 'rename_admin_to_users',
  up(db) {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('admin','users')")
      .all()
      .map((r) => r.name);
    const hasAdmin = tables.includes('admin');
    const hasUsers = tables.includes('users');

    if (hasAdmin && !hasUsers) {
      // Normal path: legacy or baseline `admin` → `users`.
      db.exec('ALTER TABLE admin RENAME TO users');
      return;
    }
    if (hasUsers && !hasAdmin) {
      // Already renamed (e.g. a fresh DB that somehow has users, or a re-run).
      return;
    }
    if (!hasAdmin && !hasUsers) {
      // Neither table exists — the baseline should have created `admin`. Fail
      // closed rather than silently continuing on an unexpected schema.
      throw new Error('migration 004: expected an admin or users table but found neither');
    }
    // Both tables exist: never merge, delete, or silently pick one. Fail closed
    // to avoid any data-loss risk; an operator must resolve the conflict.
    throw new Error('migration 004: both admin and users exist; refusing to rename (data-loss risk)');
  },
};
