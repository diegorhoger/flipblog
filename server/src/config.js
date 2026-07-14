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
// All path derivation uses serverRoot (a static module constant anchored at the
// server package location), never process.cwd(), so the resolved locations are
// identical no matter which directory the server process is launched from.
function resolvePath(value, fallback) {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(serverRoot, value);
}

// Pure resolver: given an environment object, compute the application config.
// Exported so tests can verify cwd-independent path resolution without relying
// on module-level process.env mutation. Paths are always absolute (except the
// special ':memory:' database).
export function resolveConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    appSecret: env.APP_SECRET || 'dev-insecure-secret-change-me',
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: env.ADMIN_PASSWORD || 'changeme',
    dbPath: (env.DB_PATH?.trim() === ':memory:')
      ? ':memory:'
      : resolvePath(env.DB_PATH, join(serverRoot, 'data', 'flipblog.db')),
    publicDir: resolvePath(env.PUBLIC_DIR?.trim(), join(serverRoot, 'public')),
    uploadsDir: resolvePath(env.UPLOADS_DIR?.trim(), join(serverRoot, 'public', 'uploads')),
    uploadsUrl: env.UPLOADS_URL || '/uploads',
    maxUploadBytes: 5 * 1024 * 1024,
    cookieName: 'fb_session',
    jwtTtlSeconds: 60 * 60 * 24 * 7,
  };
}

export const config = resolveConfig(process.env);

export const isMemoryDb = config.dbPath === ':memory:';
