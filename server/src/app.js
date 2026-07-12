import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';
import authRoutes from './routes/auth.js';
import postRoutes from './routes/posts.js';
import uploadRoutes from './routes/uploads.js';

function parseCookies(req, res, next) {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) {
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (key) req.cookies[key] = decodeURIComponent(val);
      }
    }
  }
  next();
}

export function createApp() {
  getDb();
  const app = express();

  app.use(parseCookies);
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/uploads', uploadRoutes);

  app.use(express.static(config.publicDir));

  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      const indexFile = join(config.publicDir, 'index.html');
      if (existsSync(indexFile)) return res.sendFile(indexFile);
    }
    next();
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'internal_error' : err.message || 'internal_error';
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return app;
}

export const app = createApp();
