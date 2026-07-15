import { rmSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db.js';

// Cleanup of orphaned post-content uploads.
//
// FlipBlog only ever stores *relative*, same-origin upload URLs in post content:
// the upload endpoint returns `${config.uploadsUrl}/${filename}` (e.g.
// `/uploads/<uuid>.png`) and the editor inserts that string verbatim as the
// image `src`. The sanitizer preserves it unchanged. This module therefore
// intentionally recognises only that safe format and rejects everything else
// (absolute/external URLs, protocol-relative URLs, data URIs, traversal, and
// anything that would resolve outside the configured uploads directory).

// Normalised uploads URL prefix, always ending in a single slash (e.g.
// '/uploads/'). Used both to detect upload URLs and to strip the prefix.
const UPLOADS_PREFIX = config.uploadsUrl.endsWith('/')
  ? config.uploadsUrl
  : `${config.uploadsUrl}/`;

// Map a permitted upload URL to the absolute file path it refers to under
// config.uploadsDir. Returns null for anything that is not a safe local upload
// URL, so callers can never be tricked into touching a file outside the
// configured upload directory.
export function uploadUrlToPath(url) {
  if (typeof url !== 'string' || url.length === 0) return null;

  // Reject anything carrying a scheme (http:, https:, data:, javascript:, …).
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  // Reject protocol-relative URLs (//host/…).
  if (url.startsWith('//')) return null;
  // Must be a relative URL under the uploads prefix.
  if (!url.startsWith(UPLOADS_PREFIX)) return null;

  // Drop any query string / fragment before resolving the filename.
  let rel = url.slice(UPLOADS_PREFIX.length);
  const cut = rel.search(/[?#]/);
  if (cut !== -1) rel = rel.slice(0, cut);
  if (rel.length === 0) return null;

  // Decode percent-escapes (FlipBlog filenames never need them, but a hostile
  // value might hide traversal behind encoding). Decoding failures are rejected.
  let name;
  try {
    name = decodeURIComponent(rel);
  } catch {
    return null;
  }

  // A valid upload is a single path segment: no directory separators, no
  // parent-directory hops, no NUL bytes.
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    return null;
  }

  const uploadsDir = path.resolve(config.uploadsDir);
  const full = path.resolve(uploadsDir, name);

  // Final containment guard: the resolved path must stay inside uploadsDir.
  const relToDir = path.relative(uploadsDir, full);
  if (relToDir === '' || relToDir.startsWith('..') || path.isAbsolute(relToDir)) {
    return null;
  }
  return full;
}

// Extract the set of local upload URLs referenced by (already sanitized) post
// HTML. Only URLs that map to a safe local file are returned; external URLs and
// traversal attempts are silently ignored.
export function extractUploadUrls(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const urls = new Set();
  const re = /<img\b[^>]*?\bsrc\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const url = match[1];
    if (uploadUrlToPath(url)) urls.add(url);
  }
  return [...urls];
}

// URLs present in the previous content but no longer present in the new content.
export function diffRemovedUploads(prevContent, newContent) {
  const prev = new Set(extractUploadUrls(prevContent));
  if (prev.size === 0) return [];
  const next = new Set(extractUploadUrls(newContent));
  return [...prev].filter((url) => !next.has(url));
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Whether any post still references the given upload URL. `excludeId` lets a
// caller ignore a specific post (not required after a committed mutation, but
// available for completeness/testing).
export function isUploadReferenced(url, { excludeId = null } = {}) {
  if (typeof url !== 'string' || url.length === 0) return false;
  const db = getDb();
  const like = `%${escapeLike(url)}%`;
  const row = db
    .prepare(
      `SELECT 1 FROM posts WHERE content LIKE ? ESCAPE '\\' AND (? IS NULL OR id != ?) LIMIT 1`
    )
    .get(like, excludeId, excludeId);
  return !!row;
}

// Best-effort logger for cleanup problems. Deliberately avoids dumping absolute
// filesystem paths; the operation that triggered the cleanup has already
// succeeded, so this is informational only.
function logCleanupFailure(err) {
  const detail = err && (err.code || err.message) ? err.code || err.message : 'unknown_error';
  // eslint-disable-next-line no-console
  console.error(`[uploads] cleanup skipped due to error: ${detail}`);
}

// Delete each given upload file that is no longer referenced by any post.
// This is strictly best-effort: every failure (a missing file, a permission
// error, an unexpected filesystem error) is logged and swallowed so it can
// never fail the post operation that triggered the cleanup. Missing files are
// treated as already cleaned (rmSync `force`).
export function deleteUnreferencedUploads(urls, { excludeId = null } = {}) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  for (const url of urls) {
    try {
      // Never delete a file that another post still references.
      if (isUploadReferenced(url, { excludeId })) continue;
      const filePath = uploadUrlToPath(url);
      if (!filePath) continue; // external/unsafe URL — nothing we own to delete
      rmSync(filePath, { force: true });
    } catch (err) {
      logCleanupFailure(err);
    }
  }
}
