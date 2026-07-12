import { getDb } from '../db.js';
import { splitIntoPages, countPages } from './paginate.js';
import { sanitizeContent, sanitizeText } from './sanitize.js';

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
    author: row.author,
    excerpt: row.excerpt,
    cover_image: row.cover_image,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    pageCount: countPages(row.content),
  };
}

export function listPosts({ status = 'published', page = 1, limit = 12 } = {}) {
  const db = getDb();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 12));
  const offset = (safePage - 1) * safeLimit;

  const filter = status && status !== 'all' ? status : null;
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM posts WHERE (? IS NULL OR status = ?)')
    .get(filter, filter).c;

  const rows = db
    .prepare(
      'SELECT * FROM posts WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?'
    )
    .all(filter, filter, safeLimit, offset);

  return {
    items: rows.map(publicFields),
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

export function getPostBySlug(slug) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug);
  return hydrate(row);
}

export function getPostById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  return hydrate(row);
}

function hydrate(row) {
  if (!row) return null;
  const pages = splitIntoPages(row.content);
  return { ...publicFields(row), content: row.content, pages };
}

export function createPost(input = {}) {
  const db = getDb();
  const title = sanitizeText(input.title, 200);
  if (!title) throw new Error('title is required');
  const content = sanitizeContent(input.content || '');
  const excerpt = input.excerpt ? sanitizeText(input.excerpt, 280) : excerptFromContent(content);
  const slug = ensureUniqueSlug(db, slugify(input.slug || title));
  const now = new Date().toISOString();

  const info = db
    .prepare(
      `INSERT INTO posts (slug, title, author, excerpt, cover_image, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      slug,
      title,
      sanitizeText(input.author, 120),
      excerpt,
      input.cover_image ? String(input.cover_image).slice(0, 500) : null,
      content,
      input.status === 'draft' ? 'draft' : 'published',
      now,
      now
    );

  return getPostById(info.lastInsertRowid);
}

export function updatePost(id, input = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  if (!existing) return null;

  const title = input.title != null ? sanitizeText(input.title, 200) : existing.title;
  const content = input.content != null ? sanitizeContent(input.content) : existing.content;
  const excerpt =
    input.excerpt != null
      ? sanitizeText(input.excerpt, 280)
      : existing.excerpt || excerptFromContent(content);
  const author = input.author != null ? sanitizeText(input.author, 120) : existing.author;
  const cover = input.cover_image !== undefined ? (input.cover_image ? String(input.cover_image).slice(0, 500) : null) : existing.cover_image;
  const status = input.status != null ? (input.status === 'draft' ? 'draft' : 'published') : existing.status;
  const slug =
    input.slug != null && input.slug !== existing.slug
      ? ensureUniqueSlug(db, slugify(input.slug), existing.id)
      : existing.slug;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE posts SET slug=?, title=?, author=?, excerpt=?, cover_image=?, content=?, status=?, updated_at=?
     WHERE id=?`
  ).run(slug, title, author, excerpt, cover, content, status, now, existing.id);

  return getPostById(existing.id);
}

export function deletePost(id) {
  const db = getDb();
  const info = db.prepare('DELETE FROM posts WHERE id = ?').run(Number(id));
  return info.changes > 0;
}
