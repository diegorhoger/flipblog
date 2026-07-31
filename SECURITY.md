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
- JWT-based sessions with HttpOnly, Secure, SameSite=Strict cookies
- Role-based access control (admin, author)
- Rate limiting on authentication endpoints (5 failures per 15 min per user/IP)
- Password hashing with scrypt (16-byte salt, 64-byte derived key)
- Account lockout after failed attempts

### Input Validation
- Server-side validation on all API endpoints
- Zod schemas for request body validation
- File upload validation (type, size, extension)
- SQL injection prevention via parameterized queries

### Data Protection
- SQLite database with foreign key constraints
- No sensitive data in logs
- Passwords never returned in API responses
- JWT secrets stored in environment variables

### Planned (not yet implemented)
- HTTPS enforcement and TLS termination (handled by reverse proxy)
- Security response headers (CSP, HSTS, X-Frame-Options, etc.)
- Automated dependency scanning

## Secure Configuration

Required environment variables for production:

```env
APP_SECRET=<32+ character random string>
DB_PATH=/path/to/production.db
DB_BACKUP_ENABLED=true
DB_BACKUP_RETENTION=5
AUTH_RATE_LIMIT_MAX_FAILURES=5
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX_ENTRIES=10000
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

*Last updated: 2026-07-29*