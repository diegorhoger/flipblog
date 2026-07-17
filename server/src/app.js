import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';
import { ApiError } from './errors.js';
import { logger } from './logging.js';
import { createErrorHandler } from './errorHandler.js';
import { requestId } from './middleware/requestId.js';
import authRoutes from './routes/auth.js';
import postRoutes from './routes/posts.js';
import uploadRoutes from './routes/uploads.js';
import auditRoutes from './routes/audit.js';

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

  // Request correlation starts before any middleware that can reject the request
  // (the JSON body parser), so malformed/oversized bodies and every other
  // response still carry a stable X-Request-ID that ties the client to the logs.
  app.use(requestId({ log: logger }));
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
  app.use('/api/audit', auditRoutes);

  app.use(express.static(config.publicDir));

  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      const indexFile = join(config.publicDir, 'index.html');
      if (existsSync(indexFile)) return res.sendFile(indexFile);
    }
    next();
  });

  // Central error handler (see errorHandler.js for the full taxonomy). It
  // classifies ApiError / body-parser / unexpected failures, correlates a 500
  // with the request id via the structured logger, and never leaks internals.
  app.use(createErrorHandler(logger));

  return app;
}

export const app = createApp();
