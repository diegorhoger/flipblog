import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Stable anchor for all runtime storage paths. Resolving relative env paths
// from here (never from process.cwd()) keeps uploads, public assets and the
// database in the same place regardless of the directory the server is launched
// from — otherwise tools like multer resolve relative paths against cwd and can
// scatter files into nested directories (e.g. server/server/public/uploads).
const serverRoot = dirname(here);

// Tolerant .env loader (no external dependency). Explicit process.env wins.
function loadEnvFile(p) {
  try {
    const text = readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      val = val.trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env file present — use defaults */
  }
}

loadEnvFile(join(here, '..', '.env'));
loadEnvFile(join(here, '.env'));

// Relative env values resolve from serverRoot; absolute values are used as-is.
function resolvePath(value, fallback) {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(serverRoot, value);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  appSecret: process.env.APP_SECRET || 'dev-insecure-secret-change-me',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme',
  dbPath: (process.env.DB_PATH?.trim() === ':memory:')
    ? ':memory:'
    : resolvePath(process.env.DB_PATH, join(serverRoot, 'data', 'flipblog.db')),
  publicDir: resolvePath(process.env.PUBLIC_DIR?.trim(), join(serverRoot, 'public')),
  uploadsDir: resolvePath(process.env.UPLOADS_DIR?.trim(), join(serverRoot, 'public', 'uploads')),
  uploadsUrl: process.env.UPLOADS_URL || '/uploads',
  maxUploadBytes: 5 * 1024 * 1024,
  cookieName: 'fb_session',
  jwtTtlSeconds: 60 * 60 * 24 * 7,
};

export const isMemoryDb = config.dbPath === ':memory:';
