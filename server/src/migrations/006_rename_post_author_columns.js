// 006 - rename post ownership columns for clarity:
//   author      -> author_display_name   (the human-readable byline; never the FK)
//   author_id   -> owner_user_id         (the foreign key to users(id))
// SQLite cannot rename a column in place, and the foreign key must be carried
// over to the renamed column, so the posts table is rebuilt:
//
//   0. resolve the exact column state (source vs destination) and either no-op
//      (fully migrated), proceed (fully pre-migration), or fail closed on any
//      incomplete/ambiguous mix — a half-renamed schema must never be recorded
//      as version 6;
//   1. fail closed if any non-null author_id references a missing users.id —
//      never silently drop ownership;
//   2. capture any explicit indexes/triggers on posts so the rebuild cannot
//      silently drop operator-added or drifted objects (autoindexes backing
//      UNIQUE(slug) are recreated automatically and are excluded via sql IS NOT NULL);
//   3. create posts_new with the renamed columns and the foreign key
//      (owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL);
//   4. copy every row by explicit named columns (mapping author -> author_display_name,
//      author_id -> owner_user_id);
//   5. drop the old table and rename posts_new -> posts;
//   6. recreate the captured explicit indexes/triggers, rewriting any references
//      to the renamed columns so objects like an index on author_id or a trigger
//      referencing NEW.author survive the rename instead of failing to restore;
//   7. verify PRAGMA foreign_key_check(posts) is clean.
//
// The public API keeps returning `author` as the display-name field, so this is
// a server-internal rename; only internal code and the stored schema change.
// Runs inside runMigrations' transaction, so a failure rolls back.

// Exact column renames applied both to row data and to captured schema-object SQL.
const COLUMN_RENAMES = new Map([
  ['author_id', 'owner_user_id'],
  ['author', 'author_display_name'],
]);

// Rewrite bare and quoted identifier tokens that EXACTLY name a renamed posts
// column, leaving string literals, comments, and every other identifier
// untouched. This is token/quote-aware (not blind string replacement), so:
//   - an index/trigger referencing `author_id` or `author` is carried over;
//   - names like `idx_author_history` are a single token (never equal to a
//     renamed column) and are left alone;
//   - a string literal such as 'author removed' is copied verbatim.
// Handles single-quoted strings, "double", `backtick`, and [bracket] quoted
// identifiers, and -- line / /* block */ comments.
export function rewritePostsColumnRefs(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];

    // Single-quoted string literal: copy verbatim (handles the '' escape).
    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Quoted identifiers: "double", `backtick`, [bracket]. Each may exactly name
    // a renamed column and, if so, is rewritten with the same quoting style.
    if (ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            inner += quote;
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        inner += sql[j];
        j++;
      }
      if (closed && COLUMN_RENAMES.has(inner)) {
        out += quote + COLUMN_RENAMES.get(inner) + quote;
      } else {
        out += sql.slice(i, j);
      }
      i = j;
      continue;
    }

    if (ch === '[') {
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < n) {
        if (sql[j] === ']') {
          closed = true;
          j++;
          break;
        }
        inner += sql[j];
        j++;
      }
      if (closed && COLUMN_RENAMES.has(inner)) {
        out += '[' + COLUMN_RENAMES.get(inner) + ']';
      } else {
        out += sql.slice(i, j);
      }
      i = j;
      continue;
    }

    // Line comment: -- ... end of line.
    if (ch === '-' && sql[i + 1] === '-') {
      let j = i;
      while (j < n && sql[j] !== '\n') {
        out += sql[j];
        j++;
      }
      i = j;
      continue;
    }

    // Block comment: /* ... */.
    if (ch === '/' && sql[i + 1] === '*') {
      out += '/*';
      let j = i + 2;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) {
        out += sql[j];
        j++;
      }
      if (j < n) {
        out += '*/';
        j += 2;
      }
      i = j;
      continue;
    }

    // Bareword identifier/keyword: [A-Za-z_][A-Za-z0-9_$]*
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      let word = '';
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) {
        word += sql[j];
        j++;
      }
      out += COLUMN_RENAMES.has(word) ? COLUMN_RENAMES.get(word) : word;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

export default {
  version: 6,
  name: 'rename_post_author_columns',
  up(db) {
    // 0. Resolve the exact column state. Anything other than a clean
    //    fully-source or fully-destination schema is incomplete/ambiguous and
    //    must fail closed — otherwise a half-renamed table could be recorded as
    //    version 6.
    const cols = db
      .prepare('PRAGMA table_info(posts)')
      .all()
      .map((c) => c.name);
    const hasAuthor = cols.includes('author');
    const hasAuthorId = cols.includes('author_id');
    const hasDisplayName = cols.includes('author_display_name');
    const hasOwnerId = cols.includes('owner_user_id');

    const sourceComplete = hasAuthor && hasAuthorId;
    const destinationComplete = hasDisplayName && hasOwnerId;
    const anySource = hasAuthor || hasAuthorId;
    const anyDestination = hasDisplayName || hasOwnerId;

    if (destinationComplete && !anySource) {
      // Already migrated: safe no-op (idempotent restart).
      return;
    }
    if (!(sourceComplete && !anyDestination)) {
      throw new Error(
        'migration 006: incomplete or ambiguous post-author column state ' +
          `(author=${hasAuthor}, author_id=${hasAuthorId}, ` +
          `author_display_name=${hasDisplayName}, owner_user_id=${hasOwnerId}); refusing to proceed`
      );
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

    // 6. Recreate the captured explicit indexes/triggers, rewriting references
    //    to the renamed columns first so an index on author_id (now
    //    owner_user_id) or a trigger referencing NEW.author (now
    //    author_display_name) restores cleanly. If any statement still fails,
    //    the thrown error rolls the whole transaction back.
    for (const obj of postsObjects) {
      if (!obj.sql) continue;
      db.exec(rewritePostsColumnRefs(obj.sql));
    }

    // 7. Confirm the foreign-key relationship is clean before committing.
    const violations = db.prepare('PRAGMA foreign_key_check(posts)').all();
    if (violations.length > 0) {
      throw new Error('migration 006: foreign_key_check reported violations after rebuild');
    }
  },
};
