// 005 - enforce post ownership with a foreign key from posts.author_id to
// users.id. SQLite cannot add a REFERENCES constraint to an existing column via
// a simple ALTER, so the posts table is rebuilt:
//
//   1. detect orphaned non-null author_id values and fail closed (no silent
//      null, reassign, or inventing of owners);
//   2. create posts_new with the full current schema and the foreign key;
//   3. copy every row by named columns;
//   4. drop the old table and rename posts_new -> posts;
//   5. recreate indexes/triggers (none currently, but kept explicit so the
//      rebuild does not silently drop future ones);
//   6. verify PRAGMA foreign_key_check is clean.
//
// The relationship uses ON DELETE SET NULL: deleting a user must not silently
// destroy their published posts. Run inside runMigrations' transaction, so a
// failure rolls back to the untouched posts table.
export default {
  version: 5,
  name: 'add_posts_author_fk',
  up(db) {
    // 1. Fail closed on orphaned ownership BEFORE touching the table.
    const orphans = db
      .prepare(
        `SELECT p.id FROM posts p
         WHERE p.author_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.author_id)`
      )
      .all();
    if (orphans.length > 0) {
      throw new Error(
        `migration 005: ${orphans.length} post(s) reference a missing user; refusing to rebuild (data-loss risk)`
      );
    }

    // 2. Rebuild with the foreign key. All current columns are preserved.
    db.exec(`
      CREATE TABLE posts_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        slug        TEXT UNIQUE NOT NULL,
        title       TEXT NOT NULL,
        author      TEXT NOT NULL DEFAULT '',
        excerpt     TEXT NOT NULL DEFAULT '',
        cover_image TEXT,
        content     TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'published',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // 3. Copy every row by explicit named columns.
    db.exec(`
      INSERT INTO posts_new (id, slug, title, author, excerpt, cover_image, content, status, created_at, updated_at, author_id)
      SELECT                id, slug, title, author, excerpt, cover_image, content, status, created_at, updated_at, author_id
      FROM posts
    `);

    // 4. Swap tables.
    db.exec('DROP TABLE posts');
    db.exec('ALTER TABLE posts_new RENAME TO posts');

    // 5. Recreate indexes/triggers associated with posts. None exist today, but
    //    this is where they would be restored so a rebuild cannot drop them.
    //    (Add CREATE INDEX / CREATE TRIGGER statements here if any are added.)

    // 6. Confirm the foreign-key relationship is clean before committing.
    const violations = db.prepare('PRAGMA foreign_key_check(posts)').all();
    if (violations.length > 0) {
      throw new Error('migration 005: foreign_key_check reported violations after rebuild');
    }
  },
};
