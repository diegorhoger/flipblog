# Security Policy

## Supported Versions

We provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | ✅ Yes             |
| < 1.0   | ❌ No              |

Only the latest minor release of the current major version receives security patches. Upgrade to the latest version to receive security fixes.

## Reporting a Vulnerability

**Do not report security vulnerabilities via public GitHub issues.**

Instead, report them privately through one of these channels:

1. **GitHub Security Advisories** (preferred): https://github.com/diegorhoger/flipblog/security/advisories/new
2. **Email**: security@diegorhoger.com

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Your contact information

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Fix timeline**: Depends on severity
  - Critical: Within 7 days
  - High: Within 14 days
  - Medium: Within 30 days
  - Low: Next scheduled release

## Security Measures in Place

### Authentication & Authorization
- JWT-based sessions with HttpOnly, Secure, SameSite=Lax cookies
- CSRF protection via double-submit tokens: a readable CSRF cookie issued at login must be echoed back as an `x-csrf-token` header on every cookie-authenticated state-changing request (POST/PUT/PATCH/DELETE)
- Role-based access control (admin, author)
- Rate limiting on authentication endpoints (5 failures per 15 min per user/IP, in-memory throttling — not a persistent account lockout)
- Password hashing with scrypt (16-byte salt, 64-byte derived key)

### Browser Security Headers
- `Content-Security-Policy` locking scripts, connections, fonts, objects, forms and frames to the same origin (`style-src` additionally allows inline styles because post content is user-authored and sanitized to permit them; `img-src` allows same-origin, `data:`, and `https:` images because post content and cover images may legitimately reference remote images)
- `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` against clickjacking
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security` (HSTS) emitted only in production

### Input Validation
- Server-side validation on all API endpoints
- Zod schemas for request body validation
- File upload validation (MIME type and size; extension checks are not implemented)
- SQL injection prevention via parameterized queries

### Data Protection
- SQLite database with foreign key constraints
- No sensitive data in logs
- Passwords never returned in API responses
- JWT secrets stored in environment variables

### Planned (not yet implemented)
- Automated dependency scanning

## Secure Configuration

The server refuses to start with an insecure production configuration: it fails on
weak/known-default `APP_SECRET` values and on missing `TRUST_PROXY` (session and
CSRF cookies are marked `Secure` in production, so the app must sit behind a
TLS-terminating reverse proxy). Configure your reverse proxy to forward
`X-Forwarded-Proto` and `X-Forwarded-For` and set `TRUST_PROXY` to the addresses
or hop count you are willing to trust (e.g. `loopback`, a CIDR like `10.0.0.0/8`,
a hop count like `1`, or a comma-separated list).

Required environment variables for production:

```env
APP_SECRET=<32+ character random string, not a known default>
DB_PATH=/path/to/production.db
DB_BACKUP_ENABLED=true
DB_BACKUP_RETENTION=5
TRUST_PROXY=loopback            # or your proxy addresses/CIDR/hop count
AUTH_RATE_LIMIT_MAX_FAILURES=5
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX_ENTRIES=10000
```

### Offsite backups

Encrypted (AES-256-GCM) offsite backups live in a destination independent of the
application disk; see `docs/backup-and-recovery.md`. Production refuses to start
with offsite backups enabled but missing a destination directory or a valid key.

```env
BACKUP_OFFSITE_ENABLED=true
BACKUP_OFFSITE_DIR=/mnt/offsite-backups    # independent of the app disk
BACKUP_OFFSITE_KEY=<64 hex chars or base64, 32-byte AES key>
BACKUP_OFFSITE_RETENTION=5
```

## Vulnerability Disclosure

We follow responsible disclosure. We will:
1. Acknowledge receipt
2. Investigate and validate
3. Develop and test a fix
4. Release a patch
5. Publicly disclose after users have time to upgrade

Credit will be given to reporters who follow this process.

## Scope

This policy covers:
- The FlipBlog application code
- Official Docker images
- GitHub Actions workflows

Out of scope:
- Third-party dependencies (report to their maintainers)
- Infrastructure not managed by this repository
- Social engineering attacks

---

*Last updated: 2026-07-31*