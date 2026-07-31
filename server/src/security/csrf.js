import crypto from 'node:crypto';
import { config } from '../config.js';
import { verifyJwt } from '../auth/jwt.js';

// Double-submit CSRF defense. The server issues a random token in a (readable,
// non-HttpOnly) cookie; the web client echoes it back in a request header. A
// state-changing request is only accepted when both halves match. SameSite=Lax
// already blocks classic cross-site POSTs for modern browsers, so this is
// defense-in-depth against weaker SameSite/legacy-browser environments.
export const CSRF_COOKIE = 'fb_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function cookieOptions() {
  // httpOnly: false is deliberate — the browser JS client must be able to read
  // the cookie to echo it in the header. SameSite/secure mirror the session
  // cookie so the token is only readable/usable on this origin.
  return {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

export function createCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Issues a fresh CSRF cookie on the response (used at login and lazily when an
// authenticated session predates this middleware).
export function setCsrfCookie(res) {
  const token = createCsrfToken();
  res.cookie(CSRF_COOKIE, token, cookieOptions());
  return token;
}

// Constant-time string comparison; returns false (never throws) on length
// mismatch so malformed headers can't leak timing or crash the request.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function csrfProtection(req, res, next) {
  // Only cookie-authenticated sessions are at risk. Anonymous requests have no
  // session to hijack; they are rejected downstream by requireAuth (401).
  const sessionToken = req.cookies?.[config.cookieName];
  const payload = sessionToken && verifyJwt(sessionToken, config.appSecret);
  if (!payload) return next();

  // Make sure the client has a CSRF cookie to echo. This covers sessions that
  // were issued before this middleware existed; the very first state-changing
  // request for such a session is rejected (403) so the client can pick the
  // freshly-issued cookie up and retry.
  if (!req.cookies?.[CSRF_COOKIE]) {
    setCsrfCookie(res);
  }

  // Read-only methods cannot change state and carry no CSRF risk.
  if (!UNSAFE_METHODS.has(req.method)) return next();

  const header = req.get(CSRF_HEADER);
  const cookie = req.cookies?.[CSRF_COOKIE];
  if (!cookie || !safeEqual(header, cookie)) {
    return res.status(403).json({ error: 'csrf_failed' });
  }
  next();
}
