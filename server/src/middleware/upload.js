import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { config } from '../config.js';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

if (!existsSync(config.uploadsDir)) mkdirSync(config.uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new Error('unsupported_file_type'));
  },
});

// Shared handler for multer upload *validation* failures. Mount it after any
// route that uses `upload.single(...)`.
//
// It deliberately handles ONLY errors that mean the client sent a bad upload
// (too large → 413, wrong type → 415, other malformed multipart → 400). Any
// other error that reaches this handler — most importantly an application or
// database failure thrown by the route handler after multer already accepted the
// file — is NOT a client mistake. Those are forwarded to the central error
// handler via `next(err)` so they become a generic 500 instead of being
// mislabeled as a 400 "bad request" that leaks the internal message.
export function uploadErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file_too_large' });
    }
    // Other multer errors (unexpected field, too many files, malformed
    // multipart) are still client-side upload problems, not server faults.
    return res.status(400).json({ error: 'invalid_upload' });
  }
  if (err && err.message === 'unsupported_file_type') {
    return res.status(415).json({ error: 'unsupported_file_type' });
  }
  return next(err);
}
