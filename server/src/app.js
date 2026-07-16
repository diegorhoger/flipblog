import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';
import { ApiError } from './errors.js';
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

  // Central error handler. It draws a hard line between two kinds of failure:
  //
  //   * Known, client-facing errors (ApiError): validation, auth, lookup and
  //     conflict problems. These carry an explicit status + a stable, safe code
  //     that we surface as-is (with optional validation `details`).
  //   * Client request-parsing errors raised by `express.json()` before any
  //     route runs: malformed JSON and oversized bodies. These are bad requests,
  //     not server faults, so they map to fixed safe codes (400/413) — never the
  //     parser's message or the offending body.
  //   * Everything else: unexpected application/database failures (raw Errors,
  //     SQLite exceptions, filesystem errors, bugs). These are logged
  //     server-side and returned as a generic 500 so we never leak the
  //     underlying message, stack trace, SQL text, filenames, or filesystem
  //     paths to the client.
  //
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      const body = { error: err.code };
      if (err.details !== undefined) body.details = err.details;
      return res.status(err.status).json(body);
    }
    // body-parser (express.json) surfaces client-input problems via `err.type`.
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json' });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

export const app = createApp();
