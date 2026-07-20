import { getDb } from '../db.js';
import { splitIntoPages, countPages } from './paginate.js';
import { sanitizeContent, sanitizeText } from './sanitize.js';
import { extractUploadUrls, diffRemovedUploads, deleteUnreferencedUploads } from './uploadRefs.js';
import { badRequest, forbidden } from '../errors.js';

export function slugify(input) {
  const base = String(input || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'post';
}

function ensureUniqueSlug(db, base, ignoreId = null) {
  let slug = base;
  let n = 2;
  while (true) {
    const row = db
      .prepare('SELECT id FROM posts WHERE slug = ? AND (? IS NULL OR id != ?)')
      .get(slug, ignoreId, ignoreId);
    if (!row) return slug;
    slug = `${base}-${n++}`;
  }
}

function excerptFromContent(content, max = 200) {
  const text = (content || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, max).trim() + (text.length > max ? '…' : '');
}

function publicFields(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    // `author` remains the public display-name field (API compatibility); it is
    // sourced from the author_display_name column.
    author: row.author_display_name,
    excerpt: row.excerpt,
    cover_image: row.cover_image,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    pageCount: countPages(row.content),
  };
}

// owner_user_id (the foreign key to users.id) is intentionally excluded from
// public responses. Ownership decisions are made server-side using the row's
// owner_user_id; it is never exposed to clients.
export function listPosts({ status = 'published', page = 1, limit = 12, actor = null } = {}) {
  const db = getDb();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 12));
  const offset = (safePage - 1) * safeLimit;

  const filter = status && status !== 'all' ? status : null;
  const where = [];
  const params = [];
  if (filter) {
    where.push('status = ?');
    params.push(filter);
  }
  // Non-admin authors may see published posts plus their own (including drafts).
  if (actor && actor.role !== 'admin') {
    where.push('(status = ? OR owner_user_id = ?)');
    params.push('published', Number(actor.sub));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')} ` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM posts ${clause}`)
    .get(...params).c;

  const rows = db
    .prepare(`SELECT * FROM posts ${clause}ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, offset);

  return {
    items: rows.map(publicFields),
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

export function getPostBySlug(slug, actor = null) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug);
  if (!row) return null;
  // Unpublished posts are visible only to their owner or an admin. For everyone
  // else (including anonymous) they do not exist (404), to avoid confirming a
  // private draft's existence.
  if (row.status !== 'published' && !canRead(row, actor)) return null;
  return hydrate(row);
}

export function getPostById(id, actor = null) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  if (!row) return null;
  // Published posts are world-readable; unpublished posts require ownership or
  // admin. Without this guard, the null-actor internal calls below (and anonymous
  // readers) would be wrongly rejected for public content.
  if (row.status !== 'published' && !canRead(row, actor)) {
    throw forbidden();
  }
  return hydrate(row);
}

// Whether the given actor may read a (possibly unpublished) post. Returns false
// for null actors (anonymous) and for non-owners who are not admins.
function canRead(row, actor) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  return row.owner_user_id != null && Number(actor.sub) === Number(row.owner_user_id);
}

function hydrate(row) {
  if (!row) return null;
  const pages = splitIntoPages(row.content);
  return { ...publicFields(row), content: row.content, pages };
}

export function createPost(input = {}, actor = null) {
  const db = getDb();
  const title = sanitizeText(input.title, 200);
  if (!title) throw badRequest('title_required');
  const content = sanitizeContent(input.content || '');
  const excerpt = input.excerpt ? sanitizeText(input.excerpt, 280) : excerptFromContent(content);
  const slug = ensureUniqueSlug(db, slugify(input.slug || title));
  const now = new Date().toISOString();
  // Ownership: the creating user's id is recorded. Falls back to null for
  // non-authenticated callers (e.g. seeded content) but normal requests pass the
  // authenticated user. The display author_display_name stays client-supplied.
  const ownerUserId = actor && Number.isFinite(Number(actor.sub)) ? Number(actor.sub) : null;

  const info = db
    .prepare(
      `INSERT INTO posts (slug, title, author_display_name, owner_user_id, excerpt, cover_image, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      slug,
      title,
      sanitizeText(input.author, 120),
      ownerUserId,
      excerpt,
      input.cover_image ? String(input.cover_image).slice(0, 500) : null,
      content,
      input.status === 'draft' ? 'draft' : 'published',
      now,
      now
    );

  return getPostById(info.lastInsertRowid, actor);
}

// Authors may only modify their own posts; admins may modify any post.
function assertCanManage(existing, actor) {
  if (!actor) throw forbidden();
  const isAdmin = actor.role === 'admin';
  const isOwner = existing.owner_user_id != null && Number(actor.sub) === Number(existing.owner_user_id);
  if (!isAdmin && !isOwner) throw forbidden();
}

export function updatePost(id, input = {}, actor = null) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  if (!existing) return null;
  assertCanManage(existing, actor);

  const title = input.title != null ? sanitizeText(input.title, 200) : existing.title;
  const content = input.content != null ? sanitizeContent(input.content) : existing.content;
  const excerpt =
    input.excerpt != null
      ? sanitizeText(input.excerpt, 280)
      : existing.excerpt || excerptFromContent(content);
  const author = input.author != null ? sanitizeText(input.author, 120) : existing.author_display_name;
  const cover = input.cover_image !== undefined ? (input.cover_image ? String(input.cover_image).slice(0, 500) : null) : existing.cover_image;
  const status = input.status != null ? (input.status === 'draft' ? 'draft' : 'published') : existing.status;
  const slug =
    input.slug != null && input.slug !== existing.slug
      ? ensureUniqueSlug(db, slugify(input.slug), existing.id)
      : existing.slug;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE posts SET slug=?, title=?, author_display_name=?, excerpt=?, cover_image=?, content=?, status=?, updated_at=?
     WHERE id=?`
  ).run(slug, title, author, excerpt, cover, content, status, now, existing.id);

  // Best-effort upload cleanup AFTER the database change has committed. Any
  // failure here must never fail an otherwise successful update, so
  // deleteUnreferencedUploads swallows and logs its own errors. Only uploads
  // that were dropped from this post's content and are not referenced by any
  // other post are removed.
  const removed = diffRemovedUploads(existing.content, content);
  deleteUnreferencedUploads(removed);

  return getPostById(existing.id, actor);
}

export function deletePost(id, actor = null) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  if (!existing) return false;
  assertCanManage(existing, actor);
  // Capture referenced uploads BEFORE the row disappears, then delete the row.
  const uploads = extractUploadUrls(existing.content);
  const info = db.prepare('DELETE FROM posts WHERE id = ?').run(Number(id));
  if (info.changes > 0) {
    // Best-effort cleanup after a committed deletion: remove only uploads no
    // other post still references. Failures are logged, never thrown.
    deleteUnreferencedUploads(uploads);
  }
  return info.changes > 0;
}
