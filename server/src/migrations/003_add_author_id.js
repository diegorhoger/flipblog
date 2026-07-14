// 003 - add author_id to posts (idempotent: skips if column already exists).
// Establishes post ownership so authors can be restricted to their own content
// and admins retain global management.
export default {
  version: 3,
  name: 'add_author_id_to_posts',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
    if (!cols.includes('author_id')) {
      db.exec('ALTER TABLE posts ADD COLUMN author_id INTEGER');
    }
  },
};
