import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isValidBackupKey } from './offsite-backup.js';

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

function validatePositiveInt(name, val, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = Number(val);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}, got "${val}"`);
  }
  return n;
}

// Express trust proxy setting. Accepts the values proxy-addr understands:
// a numeric hop count (e.g. '1' -> trusts only the single closest proxy),
// boolean false, or a comma-separated list of addresses/CIDRs/'loopback'.
// Unbounded boolean `true` (trust every proxy) is intentionally NOT supported
// because it lets spoofed forwarded headers be taken at face value. Returns
// null when unset so the production guard can tell "not configured" apart from
// "explicitly configured to something".
function resolveTrustProxy(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') value = String(value);
  // Hop counts are parsed BEFORE boolean aliases so TRUST_PROXY=1 becomes the
  // bounded numeric hop count 1, never the unbounded boolean `true`.
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`Invalid TRUST_PROXY: hop count "${value}" is out of range`);
    }
    return n;
  }
  if (value === 'true') {
    throw new Error('TRUST_PROXY=true (trust all proxies) is not supported: use a bounded hop count or an explicit address list');
  }
  if (value === 'false') return false;
  // Any other string (loopback, CIDR, IP, comma-separated list) is passed
  // through for Express/proxy-addr to compile at app startup.
  return value;
}

// Known weak secrets that must never run in production even if long enough.
const INSECURE_APP_SECRETS = new Set([
  'dev-insecure-secret-change-me',
  'test-secret-not-for-production',
  'secret',
  'changeme',
]);

// Production refuses insecure configurations at startup instead of serving a
// broken/insecure site: weak or known-default signing secrets, and deployments
// not behind a TLS-terminating reverse proxy (the session and CSRF cookies are
// marked Secure in production, so direct HTTP serving would break logins).
function validateProductionSecurity(env, appSecret, trustProxy, backupOffsite) {
  if (env.NODE_ENV !== 'production') return;
  if (INSECURE_APP_SECRETS.has(appSecret)) {
    throw new Error('APP_SECRET must not be a known insecure default value in production');
  }
  if (!appSecret || appSecret.length < 32) {
    throw new Error('APP_SECRET must be at least 32 characters long in production');
  }
  if (trustProxy === null) {
    throw new Error('TRUST_PROXY must be set in production: the app must sit behind a TLS-terminating reverse proxy because session/CSRF cookies are marked Secure');
  }
  // Explicitly disabled (false) or zero-hop trust trusts no proxy, so Secure
  // cookies would break behind a TLS-terminating reverse proxy.
  if (trustProxy === false || trustProxy === 0) {
    throw new Error('TRUST_PROXY must trust at least the TLS-terminating reverse proxy in production');
  }
  if (backupOffsite.enabled) {
    if (!backupOffsite.dir) {
      throw new Error('BACKUP_OFFSITE_DIR must be set when BACKUP_OFFSITE_ENABLED=true in production');
    }
    if (!isValidBackupKey(backupOffsite.key)) {
      throw new Error('BACKUP_OFFSITE_KEY must be a 32-byte AES key (64 hex chars or base64) when BACKUP_OFFSITE_ENABLED=true in production');
    }
  }
}

// Pure resolver: given an environment object, compute the application config.
// Exported so tests can verify cwd-independent path resolution without relying
// on module-level process.env mutation. Paths are always absolute (except the
// special ':memory:' database).
export function resolveConfig(env = process.env) {
  const appSecret = env.APP_SECRET || 'dev-insecure-secret-change-me';
  const trustProxy = resolveTrustProxy(env.TRUST_PROXY);
  const dbPath = (env.DB_PATH?.trim() === ':memory:')
    ? ':memory:'
    : resolvePath(env.DB_PATH, join(serverRoot, 'data', 'flipblog.db'));
  const isMemory = dbPath === ':memory:';
  const testMode = env.NODE_ENV === 'test';
  // A real file database has exactly one usable copy. We never run startup
  // backups for in-memory databases (nothing to lose, and VACUUM INTO is a
  // no-op) or under test runs (which spin up many throwaway on-disk files).
  const dbBackupEnabled = !isMemory && !testMode && env.DB_BACKUP_ENABLED !== 'false';
  // Backups live in a sibling `backups/` directory by default so they sit next
  // to — but never inside — the live database file.
  const realDbPath = isMemory ? join(serverRoot, 'data', 'flipblog.db') : dbPath;
  const dbBackupDir = resolvePath(env.DB_BACKUP_DIR?.trim(), join(dirname(realDbPath), 'backups'));
  const dbBackupRetention = Number(env.DB_BACKUP_RETENTION) > 0 ? Number(env.DB_BACKUP_RETENTION) : 5;
  // Offsite backups are encrypted copies pushed to a destination independent of
  // the application disk. Opt-in via BACKUP_OFFSITE_ENABLED=true; in production
  // an enabled offsite backup MUST also configure the destination directory and
  // a 32-byte encryption key (validated above).
  const backupOffsite = {
    enabled: env.BACKUP_OFFSITE_ENABLED === 'true',
    dir: resolvePath(env.BACKUP_OFFSITE_DIR?.trim(), ''),
    key: env.BACKUP_OFFSITE_KEY?.trim() || '',
    retention: Number(env.BACKUP_OFFSITE_RETENTION) > 0 ? Number(env.BACKUP_OFFSITE_RETENTION) : 5,
  };
  validateProductionSecurity(env, appSecret, trustProxy, backupOffsite);

  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    appSecret,
    // Reverse proxy trust. Production requires it to be explicitly configured
    // (see validateProductionSecurity); elsewhere localhost-only trust is the
    // safe default so req.ip/req.secure work behind a local proxy in dev.
    trustProxy: trustProxy ?? 'loopback',
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: env.ADMIN_PASSWORD || 'changeme',
    dbPath,
    publicDir: resolvePath(env.PUBLIC_DIR?.trim(), join(serverRoot, 'public')),
    uploadsDir: resolvePath(env.UPLOADS_DIR?.trim(), join(serverRoot, 'public', 'uploads')),
    uploadsUrl: env.UPLOADS_URL || '/uploads',
    maxUploadBytes: 5 * 1024 * 1024,
    cookieName: 'fb_session',
    jwtTtlSeconds: 60 * 60 * 24 * 7,
    dbBackupEnabled,
    dbBackupDir,
    dbBackupRetention,
    backupOffsiteEnabled: backupOffsite.enabled,
    backupOffsiteDir: backupOffsite.dir,
    backupOffsiteKey: backupOffsite.key,
    backupOffsiteRetention: backupOffsite.retention,
    authRateLimitMaxFailures: validatePositiveInt('AUTH_RATE_LIMIT_MAX_FAILURES', env.AUTH_RATE_LIMIT_MAX_FAILURES, 5, { min: 1, max: 100 }),
    authRateLimitWindowMs: validatePositiveInt('AUTH_RATE_LIMIT_WINDOW_MS', env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, { min: 1000, max: 86_400_000 }),
    authRateLimitMaxEntries: validatePositiveInt('AUTH_RATE_LIMIT_MAX_ENTRIES', env.AUTH_RATE_LIMIT_MAX_ENTRIES, 10000, { min: 100, max: 100_000 }),
  };
}

// Resolved once at module load. Each process (including the startup-migration
// child-process fixtures) sets its environment before importing this module, so
// a single static resolution keeps config.dbPath and isMemoryDb in agreement —
// isMemoryDb must reflect the same dbPath that getDb() opens, not a stale view.
export const config = resolveConfig(process.env);

export const isMemoryDb = config.dbPath === ':memory:';
