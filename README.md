# FlipBlog

A blog publishing platform where every post reads like a **flippable magazine** (powered by
[StPageFlip](https://github.com/StPageFlip/StPageFlip)) and is managed from a simple admin dashboard with a rich-text
editor — no hand-coding articles in HTML.

> Migrated from the original static `jawdhiwao` World Cup blog. The two original articles are seeded as the first
> flipbooks on first run.

---

## Features

- **Flippable reader** — posts render as page-turning books with prev/next, page indicator, zoom, fullscreen and
  share controls, plus keyboard arrows. Works in spread (desktop) and portrait (mobile) modes.
- **Auto-paginated content** — write one document; the engine splits it into pages by explicit page breaks, then by
  headings, then by paragraph length. An **Insert page break** button in the editor gives manual control.
- **Admin dashboard** — list / create / edit / delete posts with a draft/published status, cover image upload, and a
  Quill rich-text editor.
- **Authentication** — multi-user with `admin` / `author` roles, stateless JWT in an httpOnly cookie, and admin-only user registration.
- **Dark mode** — seamless light/dark theme toggle shared across the public site and the admin (persisted to
  `localStorage`), evolving the original yellow/dark palette.
- **Safe content** — all admin HTML is sanitized server-side before storage or rendering (XSS-guarded).

## Tech stack

| Layer | Choice |
|-------|-------|
| Runtime | Node.js ≥ 22.5 (uses the built-in `node:sqlite`) |
| API | Express 4, `zod` validation, `multer` uploads, `sanitize-html` |
| Auth | HS256 JWT (hand-rolled with `node:crypto`) + `scrypt` password hashing — zero extra deps |
| Database | SQLite via `node:sqlite` (single file, zero-config) |
| Front-end | Vanilla JS + Vite, `page-flip` (StPageFlip), `quill` |
| Tests | `node:test` + `supertest` (server), `vitest` (web), `playwright` (e2e) |

## Project layout

```
flipblog/
├─ server/            # Express API + SQLite (Node, ESM)
│  ├─ src/
│  │  ├─ config.js        # env-driven configuration
│  │  ├─ db.js            # node:sqlite connection + schema
│  │  ├─ app.js           # express app, static serving, SPA fallback
│  │  ├─ index.js         # entry point (seed + listen)
│  │  ├─ seed.js          # seeds admin + the two World Cup sample posts
│  │  ├─ auth/            # jwt.js (HS256), password.js (scrypt)
│  │  ├─ middleware/      # validate.js (zod), requireAuth.js
│  │  ├─ routes/          # auth.js, posts.js, uploads.js
│  │  └─ services/        # posts.js, paginate.js, sanitize.js, admin.js
│  └─ tests/              # paginate, auth, posts (supertest)
├─ web/               # Vite front-end (vanilla JS)
│  ├─ src/
│  │  ├─ main.js          # app bootstrap (shell, router, theme)
│  │  ├─ lib/             # api.js, router.js, dom.js, format.js
│  │  ├─ components/      # header, footer, flipbook, editor
│  │  ├─ pages/           # home, reader, login, admin
│  │  ├─ styles/          # tokens (light/dark), base, components
│  │  └─ tests/           # api, router, flipbook, dom (vitest)
│  └─ e2e/                # playwright smoke test
├─ playwright.config.mjs
├─ README.md
└─ ARCHITECTURE.md
```

## Quick start

```bash
# 1. Install all workspace dependencies (server + web)
npm install

# 2. Configure environment (optional — sensible defaults are provided)
cp .env.example .env
#   Change APP_SECRET and ADMIN_PASSWORD before any real deployment!

# 3. Run in development (API on :3000, Vite dev server on :5173 with proxy)
npm run dev

# 4. Build the front-end into the server's public dir and run the production server
npm run build
npm start
#   → http://localhost:3000
```

Default admin credentials (dev): **admin / changeme**. Change them via `.env` (`ADMIN_USER`, `ADMIN_PASSWORD`) or by
editing the seeded row. Log in at `#/login`. Once signed in as an admin, add more accounts (authors or
admins) from the **Registrar** page (`#/register`).

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run API + Vite dev server together (concurrently). |
| `npm run build` | Build the web front-end into `server/public`. |
| `npm start` | Run the production server (serves API + built UI). |
| `npm test` | Run server + web unit/integration tests. |
| `npm run test:e2e` | Build, then run the Playwright end-to-end suite. |
| `npm run lint` | Syntax-check all source/test files in both packages. |

## API reference

All responses are JSON. API responses carry `Cache-Control: no-store`.

### Auth
| Method | Path | Auth | Body |
|--------|------|------|------|
| `POST` | `/api/auth/login` | — | `{ username, password }` → sets session cookie |
| `POST` | `/api/auth/register` | admin | `{ username, password, role? }` → creates a user (see below) |
| `POST` | `/api/auth/change-password` | cookie | `{ currentPassword, newPassword }` → updates the caller's own password (verifies current first) |
| `POST` | `/api/auth/avatar` | cookie | `multipart/form-data` file field → sets the caller's profile picture, returns `{ avatar }` |
| `POST` | `/api/auth/logout` | — | clears session cookie |
| `GET`  | `/api/auth/me` | cookie | returns current user (incl. `role` and `created_at`) or `401` |

### Posts
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET`  | `/api/posts?status=published&page=1&limit=12` | — | list; `status=all` for admin |
| `GET`  | `/api/posts/:slug` | — | single post incl. `pages[]` (pre-split) |
| `GET`  | `/api/posts/id/:id` | — | single post by id (editor) |
| `POST` | `/api/posts` | admin | create |
| `PUT`  | `/api/posts/:id` | admin | update |
| `DELETE` | `/api/posts/:id` | admin | delete |

Post body: `{ title, author?, excerpt?, cover_image?, content, status?, slug? }`. `content` is rich HTML; page breaks
are `<hr data-page-break>`. The server sanitizes `content` and splits it into `pages` on read.

### Uploads
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `POST` | `/api/uploads` | admin | `multipart/form-data` file field; returns `{ url }` |

### Health

| Method | Path | Checks |
|--------|------|--------|
| `GET` | `/api/health` (alias of `/live`) | liveness only |
| `GET` | `/api/health/live` | process is up (does **not** touch the DB) |
| `GET` | `/api/health/ready` | DB opens, all migrations applied, `integrity_check` + `foreign_key_check` pass |

`/live` returns `200 { status: "ok" }` as long as the process is running. Use it for container
liveness probes — it must **not** depend on the database, or a wedged DB would trigger a needless
restart of an otherwise-healthy process.

`/ready` confirms the server can actually serve traffic. On success it returns `200` with a coarse
report (`integrity`, `foreignKeys`, and `migrationVersion.expected/applied/current`). On any failure
it returns `503 { status: "unavailable", reason }` — **no filesystem paths or SQL are ever leaked**.
Wire this to your readiness probe / load-balancer health check.

## Users & passwords

FlipBlog is multi-user. All accounts live in a single `admin` table (where "admin" is the legacy
name for the users table) with a `role` column: `admin` or `author`.

- **Seeded account** — on first run (empty DB) the server seeds one `admin` from `ADMIN_USER` /
  `ADMIN_PASSWORD` (defaults `admin` / `changeme`). Change these via `.env` before deploying.
- **Passwords** — stored as `scrypt` hashes (`salt:derivedKey`, 64-byte key) via
  `server/src/auth/password.js`. Plaintext passwords are never persisted or returned by the API.
- **Registration (admin-only)** — there is **no public self-signup**. Only an authenticated `admin`
  can create users, via `POST /api/auth/register` or the **Registrar** page (`#/register`).
  - Request body: `{ username, password, role? }`.
  - `username`: 3–120 chars, `[a-zA-Z0-9_.-]` only. Must be unique (returns `409` if taken).
  - `password`: minimum 8 characters.
  - `role`: optional, `author` (default) or `admin`. New users cannot grant themselves a role the
    caller lacks — the endpoint simply accepts the provided value, so only trust `admin` callers.
  - Returns `201` with the created `{ user: { username, role } }` (no password hash).
- **Profile & password** — any signed-in user can open the **Perfil** page (`#/profile`) to view their
  username, role, and join date, upload/change a profile picture (`POST /api/auth/avatar`, stored under
  `/uploads`), change their own password (`POST /api/auth/change-password`, which verifies the current
  password first), and see a placeholder for a future subscription plan.
- **Roles & access** — the session JWT carries the user's `role`. `requireRole('admin')` guards the
  registration endpoint; all other write operations (posts, uploads) require only a valid session, so
  both `admin` and `author` accounts can author content. Promote/limit accounts by editing the
  `role` column directly in the SQLite database.

> To reset a forgotten admin password: set a new `ADMIN_PASSWORD` in `.env` and delete the seeded
> row, or update the `password_hash` directly with the `hashPassword` helper.

## How pagination works

`server/src/services/paginate.js` → `splitIntoPages(html)` resolves page boundaries in this order:

1. Explicit `<hr data-page-break>` markers (from the editor's "Insert page break" button).
2. Top-level heading boundaries (`<h2>`/`<h3>`).
3. Paragraph/block chunking by a character budget (default 1400 chars).

It always returns at least one page. The split is pure and unit-tested (`server/tests/paginate.test.js`).

## Security notes

- Change `APP_SECRET` and the admin password before deploying — the defaults are for local dev only.
- Session JWT is stored in an httpOnly, sameSite cookie; `secure` is set automatically in production.
- All rich-text HTML is sanitized with `sanitize-html` (allow-list tags/attributes/styles, `data-page-break` kept).
- Uploads are restricted to images and a configurable size limit (`MAX_UPLOAD_BYTES`, default 5 MB).
- Dev-only dependencies (Vite/esbuild toolchain) carry advisories typical of the build toolchain and are **not** shipped
  in the production bundle; the runtime browser dependency `quill` is pinned to the patched `2.0.2`.

## Deployment

The app is a single Node process. Build the front-end (`npm run build`) so `server/public` exists, then run
`npm start` behind any reverse proxy / static host. `DB_PATH` controls the SQLite file location; back it up like any
database.

### Startup sequence

1. The server opens `DB_PATH` (creating it and its parent directory if missing).
2. It determines pending migrations **without writing to the database** (no `schema_migrations`
   row, no baseline tables are created yet).
3. **Only if an upgrade is pending**, it snapshots the live database — exactly as it exists on disk
   *before* any startup write — into a sibling `backups/` directory (see below). This is your rollback
   point if the upgrade fails. An ordinary restart with nothing to migrate backs up nothing.
 4. The baseline schema (`BASELINE_POSTS`, and the legacy `admin` table when `users` is absent) is
    written first. Then the ordered, versioned migrations run — and **only the pending migration
    bodies and their `schema_migrations` ledger inserts are wrapped in a single `BEGIN IMMEDIATE`
    transaction**. `ensureMigrationsTable()` itself runs before that transaction.
5. A health check runs: `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, a verification that
   every expected migration version is recorded, **and** that no unrecognised (future) migration
   version is present. **If any check fails the process exits non-zero** — it will not serve requests
   on a database it cannot trust. (An unrecognised version means a newer build migrated this
   database; an older build must not start against it.)

No backups or health-gated startup run for `:memory:` databases or when `NODE_ENV=test`.

### Database backups

Whenever the server starts and **pending migrations are about to run**, it automatically snapshots
the database exactly as it was found on disk — *before* the baseline schema, the legacy
`admin`→`users` rename, and `schema_migrations` bookkeeping are written — via SQLite's online
`VACUUM INTO`. A failed deploy therefore never overwrites your only good copy. On a fresh database
the snapshot is empty; on an existing one it is a faithful pre-upgrade copy. An ordinary restart with
nothing to migrate backs up nothing — five identical copies of an unchanged database is not resilience.
Backups are written to `<dir of DB_PATH>/backups/` by default and named
`flipblog-pre-v<version>-<timestamp>-<attempt-id>.db`, where `<version>` is the schema version
*before* the pending migrations run, `<timestamp>` is a millisecond-precision ISO-ish token (e.g.
`20260720T153001.123Z`), and `<attempt-id>` is a collision-resistant UUID that makes concurrent
startups in separate containers race-safe (e.g.
`flipblog-pre-v6-20260720T153001.123Z-550e8400-e29b-41d4-a716-446655440000.db`). The embedded
millisecond-precision timestamp makes the filenames sort chronologically, and retention keeps the
newest `DB_BACKUP_RETENTION` (default `5`) by actual time — across mixed schema versions — pruning
the rest.

| Env var | Default | Purpose |
|---------|---------|---------|
| `DB_BACKUP_ENABLED` | `true` | set `false` to disable startup backups |
| `DB_BACKUP_DIR` | `<dir of DB_PATH>/backups` | override the backup location |
| `DB_BACKUP_RETENTION` | `5` | how many recent backups to keep |

> Transactional migrations protect against SQL failures, but **not** against filesystem corruption,
> operator mistakes, or deploying code against the wrong database file. The startup backup is the
> safety net for those cases.

### Restoring a backup

1. **Stop the server** so the database file is not being written.
2. Copy the live database aside (belt-and-suspenders):
   ```bash
   cp data/flipblog.db data/flipblog.db.broken-$(date +%s)
   ```
3. Replace it with the chosen backup (pick the highest `flipblog-pre-v<N>-…` whose version matches
   the code you are about to run):
   ```bash
   cp data/backups/flipblog-pre-v6-20260720T153001.123Z-550e8400-e29b-41d4-a716-446655440000.db data/flipblog.db
   ```
4. **Verify** the restored file before trusting it:
   ```bash
   node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/flipblog.db');console.log(d.prepare('PRAGMA integrity_check').all());console.log(d.prepare('PRAGMA foreign_key_check').all());"
   ```
   `integrity_check` must print a single `ok` row and `foreign_key_check` an empty list.
5. Start the server. `GET /api/health/ready` should return `200` with `migrationVersion.current: true`.
   If you restored a backup from *before* some migrations, the server will simply re-apply the
   pending ones on startup (it is safe to run migrations against an older-but-valid backup).

### Rollback procedure

- If a pending migration fails, the process refuses to start (fail-closed). The migration ran inside
  a single transaction, so the pending migration bodies and their `schema_migrations` inserts are rolled
  back together, leaving the database as it was before this startup's migration step. (The baseline
  tables written at step 4 are not part of that transaction and are not rolled back — they are
  idempotent `CREATE TABLE IF NOT EXISTS` statements, so re-running startup is safe.) The pre-upgrade
  backup taken at step 3 is also available if you prefer an explicit known-good copy. Restore the backup
  and redeploy the previous build.
- Keep the previous server build/container image available so you can redeploy it against the restored
  database.

### Production launch checklist

- [ ] `APP_SECRET` set to a long random value; `ADMIN_PASSWORD` changed from the default.
- [ ] `DB_PATH` points at durable, backed-up storage (not an ephemeral container volume).
- [ ] `DB_BACKUP_DIR` (if overridden) is on the same durable volume and included in your backup strategy.
- [ ] Reverse proxy sets `X-Forwarded-*` and terminates TLS so the `secure` cookie flag applies.
- [ ] Liveness probe → `/api/health/live`; readiness probe → `/api/health/ready` (both return non-2xx only on real failure).
- [ ] A monitoring alert fires on `GET /api/health/ready` returning `503`.
