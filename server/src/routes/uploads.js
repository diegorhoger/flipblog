import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

if (!existsSync(config.uploadsDir)) mkdirSync(config.uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new Error('unsupported_file_type'));
  },
});

const router = Router();

router.post('/', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const url = `${config.uploadsUrl}/${req.file.filename}`;
  res.status(201).json({ url, filename: req.file.filename, size: req.file.size });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large' });
  }
  if (err && err.message === 'unsupported_file_type') {
    return res.status(415).json({ error: 'unsupported_file_type' });
  }
  if (err) return res.status(400).json({ error: err.message || 'upload_failed' });
  next();
});

export default router;
