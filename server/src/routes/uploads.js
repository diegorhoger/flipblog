import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { upload, uploadErrorHandler } from '../middleware/upload.js';

const router = Router();

router.post('/', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const url = `${config.uploadsUrl}/${req.file.filename}`;
  res.status(201).json({ url, filename: req.file.filename, size: req.file.size });
});

router.use(uploadErrorHandler);

export default router;
