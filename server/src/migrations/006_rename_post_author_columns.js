// 006 - rename post ownership columns for clarity:
//   author      -> author_display_name   (the human-readable byline; never the FK)
//   author_id   -> owner_user_id         (the foreign key to users(id))
// SQLite cannot rename a column in place, and the foreign key must be carried
// over to the renamed column, so the posts table is rebuilt:
//
//   1. fail closed if any non-null owner_user_id (formerly author_id) references
//      a missing users.id — never silently drop ownership;
//   2. capture any explicit indexes/triggers on posts so the rebuild cannot
//      silently drop operator-added or drifted objects (autoindexes backing
//      UNIQUE(slug) are recreated automatically and are excluded via sql IS NOT NULL);
//   3. create posts_new with the renamed columns and the foreign key
//      (owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL);
//   4. copy every row by explicit named columns (mapping author -> author_display_name,
//      author_id -> owner_user_id);
//   5. drop the old table and rename posts_new -> posts;
//   6. recreate the captured explicit indexes/triggers;
//   7. verify PRAGMA foreign_key_check(posts) is clean.
//
// The public API keeps returning `author` as the display-name field, so this is
// a server-internal rename; only internal code and the stored schema change.
// Runs inside runMigrations' transaction, so a failure rolls back.
export default {
  version: 6,
  name: 'rename_post_author_columns',
  up(db) {
    // 0. Fail closed if the destination columns already coexist with the source
    //    columns — an ambiguous/partial state indicating a prior half-run or
    //    schema drift. We expect exactly the source columns (author, author_id)
    //    and must not proceed if the renamed columns are already present.
    const destCols = db
      .prepare(`PRAGMA table_info(posts)`)
      .all()
      .map((c) => c.name);
    const hasDest = destCols.includes('author_display_name') || destCols.includes('owner_user_id');
    const hasSrc = destCols.includes('author') && destCols.includes('author_id');
    if (hasDest && hasSrc) {
      throw new Error(
        'migration 006: both source (author/author_id) and destination (author_display_name/owner_user_id) columns coexist; refusing ambiguous rebuild'
      );
    }
    // If the destination columns are already the only ones present, the rename
    // has effectively been applied (idempotent restart handled by registry);
    // nothing further to do here.
    if (hasDest && !hasSrc) {
      return;
    }

    // 1. Fail closed on orphaned ownership (checked against the source column
    //    author_id, which migration 005 established as the FK to users(id)).
    const orphans = db
      .prepare(
        `SELECT p.id FROM posts p
         WHERE p.author_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.author_id)`
      )
      .all();
    if (orphans.length > 0) {
      throw new Error(
        `migration 006: ${orphans.length} post(s) reference a missing user; refusing to rebuild (data-loss risk)`
      );
    }

    // 2. Capture explicit indexes/triggers attached to posts.
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

    // 3. Rebuild with the renamed columns + the carried-over foreign key.
    db.exec(`
      CREATE TABLE posts_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        slug        TEXT UNIQUE NOT NULL,
        title       TEXT NOT NULL,
        author_display_name TEXT NOT NULL DEFAULT '',
        excerpt     TEXT NOT NULL DEFAULT '',
        cover_image TEXT,
        content     TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'published',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // 4. Copy every row by explicit named columns (old -> new names).
    db.exec(`
      INSERT INTO posts_new (id, slug, title, author_display_name, excerpt, cover_image, content, status, created_at, updated_at, owner_user_id)
      SELECT                id, slug, title, author,             excerpt, cover_image, content, status, created_at, updated_at, author_id
      FROM posts
    `);

    // 5. Swap tables.
    db.exec('DROP TABLE posts');
    db.exec('ALTER TABLE posts_new RENAME TO posts');

    // 6. Recreate the captured explicit indexes/triggers (bound to the renamed
    //    posts table). If any statement fails, the thrown error rolls back.
    for (const obj of postsObjects) {
      if (!obj.sql) continue;
      db.exec(obj.sql);
    }

    // 7. Confirm the foreign-key relationship is clean before committing.
    const violations = db.prepare('PRAGMA foreign_key_check(posts)').all();
    if (violations.length > 0) {
      throw new Error('migration 006: foreign_key_check reported violations after rebuild');
    }
  },
};
