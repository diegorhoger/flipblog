// Browser-facing security response headers. Applied to every response so the
// browser hardens the rendered app regardless of which route served it.
//
// CSP notes:
//   * style-src needs 'unsafe-inline' because post content is user-authored and
//     sanitized to allow inline styles (see services/sanitize.js allowedStyles)
//     and the Quill editor injects inline styles/`<style>` for its toolbar.
//   * img-src additionally permits https: (and data:) images because post
//     content and cover_image may legitimately reference remote images — the
//     sanitizer preserves http/https image srcs by design. Scripts, connections,
//     fonts and frames stay locked to the same origin.
//   * No external scripts, fonts, or origins are used by the web client (assets
//     are bundled and same-origin), so everything else is locked to 'self'.
//   * frame-ancestors 'self' (modern) + X-Frame-Options SAMEORIGIN (legacy)
//     together prevent clickjacking.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

const HSTS_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function securityHeaders({ production = process.env.NODE_ENV === 'production', hstsMaxAge = HSTS_MAX_AGE } = {}) {
  return (req, res, next) => {
    res.set('Content-Security-Policy', CSP);
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Disable the legacy (often bypassable) reflected-XSS filter; CSP
    // script-src 'self' is the real protection.
    res.set('X-XSS-Protection', '0');
    // HSTS is only meaningful/emitted behind real HTTPS, which we only assume
    // in production (trust proxy + Secure cookies are required there too).
    if (production) {
      res.set('Strict-Transport-Security', `max-age=${hstsMaxAge}; includeSubDomains`);
    }
    next();
  };
}
