# FlipBlog Production Deployment Architecture

> **Decision record for Issue #33** — the v1 hosting model selected as the reference
> for all follow-up implementation work. Parent epic: #22.
>
> **Status: SELECTED.** Implementation issues #34, #35, #36 reference this document.
>
> **Decision-record coverage** (from Issue #33): hosting model §3.1 · process
> supervision §3.2 · reverse proxy + TLS §3.3 · domain + DNS §3.4 · persistent
> SQLite + uploads §3.5 · backup destination §3.6 · secrets §3.7 · deployment +
> rollback §3.8 · health + monitoring §3.9 · traffic/availability/maintenance/cost
> §3.10–§3.11 · scale-out / SQLite-exit conditions §4–§5.

## 1. Decision summary

FlipBlog runs as a **single Node.js process** that serves the API, the built web
SPA, and user uploads from one HTTP server. In production it sits behind a
**TLS-terminating reverse proxy (Caddy)**, is supervised by **systemd**, and uses
**SQLite on a persistent attached data disk**. Encrypted offsite backups are staged
to a local directory and **pushed to independent object storage (rclone)** on a
systemd timer.

The reverse proxy is **mandatory**, not optional: the app refuses to start in
production without `TRUST_PROXY` set, because session and CSRF cookies are marked
`Secure` (`server/src/config.js`, `validateProductionSecurity`).

## 2. Boundary diagram

```
 Internet
    │  :443 HTTPS
┌───▼───────────────┐
│      Caddy        │  TLS termination (Let's Encrypt auto certs)
│  :443 → :3000     │  sets/forwards X-Forwarded-For + X-Forwarded-Proto
└───┬───────────────┘
    │  loopback :3000
    ▼
┌─────────────────────────────────────────┐
│  Node.js (systemd unit `flipblog`)      │  Express: /api + /uploads + SPA
│  bound to 127.0.0.1, PORT=3000          │
└───────┬─────────────────────┬───────────┘
        │                     │
  ┌─────▼──────┐        ┌─────▼──────────┐
  │ DATA DISK │        │ DATA DISK      │
  │ DB_PATH   │        │ UPLOADS_DIR    │
  │ flip.db   │        │ public/upload  │
  │ backups/  │        │                │
  └───────────┘        └────────────────┘
        └──────────────┬──────────────────┘
            systemd timer: offsite-backup.js → BACKUP_OFFSITE_DIR
                               │
                         ┌─────▼────────────────────────────┐
                         │  Object storage (rclone sync)    │  independent
                         │  s3://flipblog-backups/          │  of app disk
                         └──────────────────────────────────┘
```

Storage boundaries:

| Boundary | Owned by | Lives on |
|----------|----------|----------|
| Database + local backups | `flipblog` service account | persistent data disk |
| Uploads (`UPLOADS_DIR`) | `flipblog` service account | persistent data disk |
| Built SPA (`server/public`) | deploy step / package content | app directory |
| Encrypted offsite copies | `backup` timer (rclone) | object storage (independent) |
| Secrets (`APP_SECRET`, offsite key) | root → `flipblog` 0600 file | host, vault mirror |

## 3. Decision details

### 3.1 Hosting model — single Linux VPS/VM **(SELECTED)**

- **Selected:** one dedicated small VM (2 vCPU / 4 GiB RAM / 40 GiB disk),
  Debian or Ubuntu, from a straightforward IaaS provider.
- **Rejected for v1, and why:**
  - *Managed platform (Render, Railway, Fly.io)* — their ephemeral/persistent-disk
    model, per-replica billing, and less control conflict with "SQLite on a
    persistent disk + simple backups". Cost/lock-in without a real benefit at
    FlipBlog's scale.
  - *Kubernetes / multi-replica* — the app is a single stateful writer over one
    SQLite file; orchestration adds operational weight and friction with no
    availability win. See §5 for when to revisit.

### 3.2 Process supervision — systemd **(SELECTED)**

| Concern | Answer |
|---------|--------|
| Restart on crash | `Restart=always`, `RestartSec=3` |
| Logs | `journald` |
| Secrets injection | `EnvironmentFile=/etc/flipblog/app.env` |
| Storage dependency | unit `Requires`/`After` the data-disk mount |
| Working dir | `WorkingDirectory=/srv/flipblog` (the `server` package) |

The app is a single stateless-to-a-disk process; systemd is the smallest
supervisor that gives restart, logs, env, and timer integration. **Docker Compose**
was considered and rejected for v1: no image/registry, simpler host lifecycle; a
container layer adds nothing here. This can be revisited later without weakening
the decision.

### 3.3 Reverse proxy & TLS — Caddy **(SELECTED)**

- **Caddy**, because it obtains and renews **Let's Encrypt certificates
  automatically**, supports HTTP/2/3, and needs no per-release tuning.
- It terminates TLS and reverse-proxies to the app on `loopback:3000`,
  forwarding `X-Forwarded-For` and **`X-Forwarded-Proto: https`** (required for
  `TRUST_PROXY=1` + Secure cookies).
- **Nginx is a documented alternative** with certbot-managed certs; we standardize
  on Caddy but nothing is Caddy-specific.
- Caddy listens on `:80` only to redirect → `:443`. Only `:443` is exposed.

### 3.4 Domain and DNS

- **Canonical hostname**: a single apex domain or `www`-subdomain, e.g.
  `flipblog.example.com`. **Canonical redirect policy**: `http://` and the
  non-canonical host (`https://example.com` vs `https://www.example.com`, or
  bare apex) both redirect to the canonical `https://` URL — Caddy does this via
  its default automatic HTTPS redirect plus an explicit `redir` for the
  non-canonical host. Pick **one** canonical form and keep it stable; the SPA and
  API are same-origin so no cross-host cookie/CORS concerns arise.
- **Required DNS records and ownership**:

  | Record | Type | Value | Purpose |
  |--------|------|-------|---------|
  | `flipblog.example.com` | A | VM public IPv4 | canonical host → host |
  | `flipblog.example.com` | AAAA | VM public IPv6 | **optional**; see below |
  | `flipblog.example.com` | CAA | `0 issue "letsencrypt.org"` (recommended) | authorizes Let's Encrypt issuance |

  Ownership: the **operator** owns the domain registrar account and DNS; the
  **deploy automation** only reads/writes records during cutover, and a human is
  responsible for renewal/transfer. The VM's public IP is stable and assigned at
  provisioning; DNS A record points at it.
- **TTL and cutover/rollback**: use a **low TTL (300 s)** on the A/AAAA records
  before and during a cutover so the new address is adopted quickly; raise it
  again after the cutover is stable if you want fewer DNS queries. Rollback of a
  cutover = repoint the A record back to the previous VM's IP and wait out the TTL
  (the old host can be kept running during the window). Keep the previous IP
  assigned to the old VM for at least one TTL after cutover to avoid split-brain.
- **IPv6**: **deferred** in v1 — the VM and DNS only need IPv4 to serve. AAAA is
  optional; if the provider supports it, publishing IPv6 improves reachability but
  is not required for launch. Caddy handles v6 transparently if it is added later.
- **TLS certs**: Let's Encrypt via Caddy's automatic ACME against the canonical
  host; CAA record restricts issuance to Let's Encrypt (or the provider of your
  choice) so a misconfigured actor can't issue for the domain. Certificate renewal
  is automatic; monitor the expiry as part of #36.

### 3.5 Persistent SQLite storage

- SQLite is the persistent store: `node:sqlite`, `foreign_keys=ON`, single writer.
- `DB_PATH` and `UPLOADS_DIR` point at a **persistent attached disk** (a data
  volume separate from the OS disk) so reboots/reimages do not lose data.
- No network filesystem backs SQLite (SQLite over NFS is not supported and risks
  corruption). SQLite stays on local disk; see §6 on when to move off it.

### 3.6 Offsite backup transport — independent object storage

- Local DB backups are created at startup (one per migration) in `backups/`.
- The offsite layer encrypts with **AES-256-GCM** and pushes to a directory
  (`BACKUP_OFFSITE_DIR`), then **rclone** syncs that directory to **object storage
  independent of the app disk** (e.g. S3-compatible bucket on a different
  provider, or B2). This is driven by a **systemd timer**, recommended schedule
  documented in `docs/backup-and-recovery.md` (currently "every scheduled run";
  pick a fixed cadence like `OnCalendar=*-*-* 06,12,18,00:00`).
- The offsite key is a 32-byte value (hex or base64) stored in the secret file and
  a vault mirror. Only the `flipblog` service account can read `BACKUP_OFFSITE_DIR`.

### 3.7 Secrets management

| Secret | Storage | Notes |
|--------|---------|-------|
| `APP_SECRET` | `/etc/flipblog/app.env` (root:flipblog, mode 0600) | ≥ 32 chars, not a default |
| `ADMIN_USER`/`ADMIN_PASSWORD` | same env file | seeded only when admin empty |
| `BACKUP_OFFSITE_KEY` | same env file **and** vault mirror | 32-byte AES key |
| `.env` dev | never committed | generated locally |

Systemd `EnvironmentFile` is read-only by `root`, then the unit runs as `flipblog`
so the process itself can't be tampered with by the service user. Secrets are
**never committed** (`.env.example` carries safe dev defaults only).

### 3.8 Deployment & rollback flow

- **Artifact**: a versioned release directory per release, placed under
  `/srv/flipblog/releases/<version>`, with `current` a symlink to the active one.
- **Reproducible build (Issue #34 acceptance)**: the release directory is built
  from the exact ref/tag being released by
  [`scripts/build-release.mjs`](../scripts/build-release.mjs)
  (`npm run release:build`): the script requires a clean checkout of the tag,
  runs `npm ci` against the committed `package-lock.json` (never a floating
  install), builds the front-end with Vite into `server/public`, and stages a
  self-contained directory that is the built `server` package (src/, scripts/,
  compiled `public/`, production-only `node_modules/`, plus `VERSION`/`COMMIT`
  provenance). The same script runs in CI as the `release` job, which smoke-tests
  the artifact (liveness, readiness, SPA, graceful SIGTERM shutdown → exit 0)
  and uploads it — so CI green guarantees the exact ref builds and boots. Full
  walk-through in [`deploy/README.md`](../deploy/README.md).
- **Activate**: point `current` → new release, `systemctl restart flipblog`.
- **Gate**: wait on `GET /api/health/ready` to return `200`.
- **Rollback**: point `current` back to the previous release and restart; the
  pre-migration local backup (`docs/backup-and-recovery.md`) is the safety net,
  and `docs/release-process.md` documents triggers (>5 min unhealthy, error rate
  >5% for 5 min, critical flow broken).

### 3.9 Health & monitoring

- **Liveness**: `GET /api/health/live` — 200, no DB touch.
- **Readiness**: `GET /api/health/ready` — integrity + foreign keys + migration
  version; `200` only when all pass, `503` otherwise. This is the deploy gate and
  the availability probe.
- Monitoring and alerting of the host and these health endpoints is scoped to
  **#36**; the deployment doc names the endpoints and who consumes them (systemd
  restart on crash, probe on restart, alerting in #36).

### 3.10 Expected traffic & scaling boundary

- **Assumption**: a publishing blog — single-digit to low double-digit requests/sec,
  a handful of writers, mostly reads. The whole app + SQLite fits easily on one VM.
- **Availability**: not HA in v1; a single host rebuilds from the offsite backup.
  RTO/RPO are measured by the restore drill (`docs/backup-and-recovery.md`).
- **Maintenance**: OS patches via the provider; app upgrades + a periodic restore
  drill.

### 3.11 Cost assumptions

- **Expected monthly range: $10–$20 USD total.** Breakdown:

  | Item | Estimate | Notes |
  |------|----------|-------|
  | Small VM (2 vCPU / 4 GiB / 40 GiB) | $5–$12 | typical IaaS "small" tier; spot/5-yr reserved lowers it |
  | Persistent disk | $1–$3 | 40–80 GiB block storage |
  | Object storage (offsite backups) | $0.50–$2 | ~1–2 GiB stored, low transfer; writes once per cadence |
  | Domain + DNS | $0.50–$1 | e.g. `example.com` yearly amortized; DNS free at registrar |
  | Monitoring / uptime probe | $0 | self-hosted or free-tier probe; no SaaS required in v1 |

- **Traffic/storage assumptions behind the estimate**: a low-read blog
  (single-digit to low double-digit requests/sec), a handful of writers, small
  uploads (≤ 5 MiB each) and a small DB (tens of MB); offsite backup set of a few
  hundred MiB. No CDN or log-egress-heavy workload.
- **Threshold for reassessing the architecture**: revisit this document when
  **any** of the following holds:
  - Monthly spend (VM+disk+egress) exceeds roughly **$50** sustained, or
  - sustained traffic beyond ~50 req/s or multi-GiB weekly egress, or
  - any §5 (SQLite) trigger, or a real HA/downtime requirement appears.

## 4. Trade-offs

| Option | Verdict | Why |
|--------|---------|-----|
| Managed platform | Rejected | Persistent disk + backups + cost realism matter more than convenience |
| Kubernetes | Rejected | Single stateful SQLite writer; no benefit, high overhead |
| Multi-replica | Rejected | In-process, in-memory rate limiter (`authRateLimiter.js`) is **not shared** across replicas — replicating the app is not valid in v1 |
| Docker Compose | Rejected (v1) | systemd covers restart/logs/env; no container need |
| Nginx | Fallback | Caddy auto-TLS chosen; Nginx documented as drop-in |

## 5. When SQLite stops being the right choice

Reconsider the persistence layer when **any** of these hold:

1. Need for **high availability / failover** with no downtime window — a single
   file on one host cannot do that.
2. **Concurrent writers across replicas** — SQLite serializes writes; carve-up
   requires Postgres or a real RDBMS.
3. **Very large write-heavy workload or horizontal read scaling** — SQLite is one
   node; a managed DB/Postgres with replicas replaces it.
4. App **already on a shared filesystem** — SQLite over network storage is
   unsupported; if storage moves off local disk, so must the DB.

At that point FlipBlog should move to **Postgres** managed/replicated storage.
This is a paper decision now; revisit when one of the triggers above is real.

## 6. RPO / RTO targets

- **RPO**: bounded by the offsite timer schedule and local-backup cadence. Target
  ≤ offsite cadence (e.g. ≤ 6 h) plus any migrations since last push; data
  written between pushes is the exposure.
- **RTO**: measured by the restore drill (restore + boot + ready). Assumes a
  healthy replacement VM; drift the offsite restore once per release (see
  `docs/backup-and-recovery.md`).
- These are measured, not guessed, via `scripts/restore-drill.js` running after
  schema changes and on a fixed schedule.

## 7. Ownership & responsibilities

| Area | Owner |
|------|-------|
| Deploy & rollback (symlink + restart) | Release Engineer / operator |
| Persistent disk allocation & snapshots | Host administrator |
| Object-storage / offsite key custody | Security owner + operator (split) |
| Restore drills, RTO/RPO records | Operator (drill script) |
| Monitoring & alerting (#36) | On-call |
| Graceful shutdown wiring | App (implementation #34) |

## 8. Open work referenced by this decision

- **#34** Build the production runtime conforming to this doc (systemd unit,
  data-disk mount, `app.env`, node build) — including the graceful-shutdown path
  (stop accepting connections, drain in-flight requests within
  `SHUTDOWN_GRACE_MS`, close the SQLite database, exit 0; readiness flips to
  `503 shutting_down` while draining). Reference artifacts live in
  [`deploy/`](../deploy/README.md).
- **#35** Create staging deployment and production release pipeline using the
  symlink/`current` + tag approach.
- **#36** Add production monitoring, alerts, incidents, runbooks reading
  `/api/health/live` + `/api/health/ready`.
- The launch architecture must satisfy the mandates in `SECURITY.md` (Secure
  cookies, TRUST_PROXY, bounded trust) — this doc encodes them.

---
_Last updated: 2026-08-06_
_Status: SELECTED — reference for #34/#35/#36_