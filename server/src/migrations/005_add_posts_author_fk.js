// 005 - enforce post ownership with a foreign key from posts.author_id to
// users.id. SQLite cannot add a REFERENCES constraint to an existing column via
// a simple ALTER, so the posts table is rebuilt:
//
//   1. detect orphaned non-null author_id values and fail closed (no silent
//      null, reassign, or inventing of owners);
//   2. capture any EXPLICIT indexes/triggers on posts so the rebuild does not
//      silently drop operator-added or drifted objects (autoindexes backing
//      UNIQUE/PRIMARY KEY constraints are recreated automatically by the new
//      CREATE TABLE and are excluded via `sql IS NOT NULL`);
//   3. create posts_new with the full current schema and the foreign key;
//   4. copy every row by named columns;
//   5. drop the old table and rename posts_new -> posts;
//   6. recreate the captured explicit indexes/triggers (fail closed if any
//      statement fails — the transaction rolls back to the untouched schema);
//   7. verify PRAGMA foreign_key_check is clean.
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

    // 2. Capture explicit indexes/triggers attached to posts. `sql IS NOT NULL`
    //    excludes SQLite-managed autoindexes (e.g. the one backing UNIQUE(slug)),
    //    which the rebuilt table recreates on its own.
    const postsObjects = db
      .prepare(
        `SELECT type, name, sql
         FROM sqlite_master
         WHERE tbl_name = 'posts'
           AND type IN ('index', 'trigger')
           AND sql IS NOT NULL
         ORDER BY type, name`
      )
      .all();

    // 3. Rebuild with the foreign key. All current columns are preserved.
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

    // 4. Copy every row by explicit named columns.
    db.exec(`
      INSERT INTO posts_new (id, slug, title, author, excerpt, cover_image, content, status, created_at, updated_at, author_id)
      SELECT                id, slug, title, author, excerpt, cover_image, content, status, created_at, updated_at, author_id
      FROM posts
    `);

    // 5. Swap tables.
    db.exec('DROP TABLE posts');
    db.exec('ALTER TABLE posts_new RENAME TO posts');

    // 6. Recreate the captured explicit indexes/triggers. On real SQLite a
    //    trigger (and an index's ON clause) is bound by name at CREATE time, so
    //    re-executing the stored `sql` now — after the table is named `posts`
    //    again — reattaches each object to `posts`. If any statement fails, the
    //    thrown error rolls the whole transaction back (preserving the original
    //    posts table and its captured objects).
    for (const obj of postsObjects) {
      if (!obj.sql) continue;
      db.exec(obj.sql);
    }

    // 7. Confirm the foreign-key relationship is clean before committing.
    const violations = db.prepare('PRAGMA foreign_key_check(posts)').all();
    if (violations.length > 0) {
      throw new Error('migration 005: foreign_key_check reported violations after rebuild');
    }
  },
};
