import { randomUUID } from 'node:crypto';

// --- Request ID validation -------------------------------------------------
//
// A request ID is something we emit back to the client and embed in every log
// line for that request. To prevent header/log injection or control characters
// reaching our logs/responses, we only accept an externally supplied ID if it
// matches a strict shape. Anything else is discarded and a fresh one generated.
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function generateRequestId() {
  return randomUUID();
}

// --- Redaction -------------------------------------------------------------
//
// Structured logs must never carry secrets or internals. We redact the values of
// known-sensitive keys (and mask any value that looks like a bearer token in a
// header) before serialization. The redaction walks nested objects/arrays with a
// bounded depth and a seen-set so cyclic structures cannot blow up. We do NOT log
// request bodies, uploaded file contents, SQL, or filesystem paths by design —
// callers simply do not pass those fields to `log`.
const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'confirm',
  'cookie',
  'cookies',
  'authorization',
  'set-cookie',
  'setcookie',
  'token',
  'secret',
  'appsecret',
  'app_secret',
  'x-api-key',
]);

const REDACTED = '[redacted]';

function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  // Authorization-style headers like "authorization", "x-authorization".
  return lower.endsWith('-authorization');
}

function redactValue(value, seen, depth) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
    return value;
  }
  if (t !== 'object') return undefined; // functions/symbols dropped
  if (depth <= 0) return '[omitted]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen, depth - 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, seen, depth - 1);
  }
  seen.delete(value);
  return out;
}

export function redact(event) {
  return redactValue(event, new Set(), 8);
}

// --- Safe error extraction -------------------------------------------------
//
// Convert an arbitrary thrown value into a small, safe object. We never forward
// the raw message, stack, SQL text, or file paths — only a coarse classification
// (name + optional code). Callers must never rely on `extractError` for anything
// user-facing; it exists purely for structured logs, which deliberately omit the
// message and stack. Non-Error throws are reduced to a fixed classification.
export function extractError(err) {
  if (err && typeof err === 'object') {
    const name = typeof err.name === 'string' ? err.name : 'Error';
    const code = typeof err.code === 'string' ? err.code : undefined;
    return code !== undefined ? { name, code } : { name };
  }
  return { name: 'Error' };
}

// --- Logger ----------------------------------------------------------------
//
// Emits one structured JSON line per call. A `stream` may be injected for tests
// (defaults to process.stdout so structured logs go to the normal console sink).
// All events are routed through `redact()` first.
export function createLogger({ stream = process.stdout } = {}) {
  function log(level, event) {
    const sanitized = redact(event);
    const record = {
      time: new Date().toISOString(),
      level,
      ...sanitized,
    };
    stream.write(JSON.stringify(record) + '\n');
  }

  return {
    // `status` lets 4xx/5xx handlers log without flooding `info` with client noise.
    info(event) {
      log('info', event);
    },
    warn(event) {
      log('warn', event);
    },
    // `err` is a raw Error (or thrown value). The structured log NEVER contains the
    // raw message or stack — those can carry SQL text, file paths, or secrets. It
    // records only a coarse, safe classification (name + optional code) plus
    // whatever correlation fields the caller attached (e.g. request id). Neither is
    // ever returned to the client; the response body stays a fixed `internal_error`.
    error(event, err) {
      const base = typeof event === 'object' && event !== null ? event : { note: String(event) };
      if (err !== undefined) {
        const ex = extractError(err);
        base.error = { name: ex.name, ...(ex.code !== undefined ? { code: ex.code } : {}) };
      }
      log('error', base);
    },
  };
}

export const logger = createLogger();
