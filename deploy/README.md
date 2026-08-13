# FlipBlog production deploy assets

Reference artifacts for the architecture selected in
[`docs/deployment.md`](../docs/deployment.md) and implemented under Issue #34
(runtime + reproducible build) and Issue #35 (staging + release pipeline).

## Layout

| Path | Purpose |
|------|---------|
| `systemd/flipblog.service` | systemd unit: runs the app as `flipblog`, reads `/etc/flipblog/app.env`, requires the data-disk mount, gives the app a bounded stop window. |
| `systemd/app.env.example` | template for `/etc/flipblog/app.env` (root:flipblog, mode `0600`). Fill secrets; never commit a real one. |
| `caddy/Caddyfile` | Caddy reverse proxy: TLS termination + auto certs, forwards `X-Forwarded-*` matching `TRUST_PROXY=1`, readiness health check. |
| `../scripts/build-release.mjs` | reproducible release build (`npm run release:build`): pinned ref → `npm ci` → Vite build → self-contained versioned release directory. |
| `../scripts/release-smoke.mjs` | boots the built artifact like systemd and verifies liveness, readiness, SPA, and graceful SIGTERM shutdown (`npm run release:smoke`). |
| `../scripts/deploy.sh` | SSH installer used by the pipeline: upload, env write, symlink flip, readiness gate, migration/backup log excerpt, auto-rollback. Rollback is migration-aware (see `db-rollback-check.mjs`). |
| `../scripts/rollback.sh` | restore a previously-installed release on the host (symlink flip; no rebuild). Also migration-aware. |
| `../server/scripts/db-rollback-check.mjs` | DB safety gate run on the host before flipping `current` to an older release. If the release being replaced migrated the DB forward, the newest compatible `flipblog-pre-v*.db` backup is restored so the older build can boot; the flip is refused when no compatible backup exists. Self-contained (no repo imports), so it can be `scp`'d to the host and run from `/tmp`. |
| `../scripts/post-deploy-smoke.mjs` | live-environment smoke: health, login, upload, publish, anonymous read. |

## Build a release (reproducible, Issue #34)

The artifact is produced from the **exact ref/tag** being released, never from a
working tree with uncommitted changes. The build is reproducible because it uses
the committed `package-lock.json` via `npm ci` (no floating installs), records
the commit SHA inside the artifact, and copies only a whitelisted file set (no
`.env`, no dev databases, no runtime uploads).

```bash
# Clean checkout of the tag (the script refuses a dirty tree by default)
git worktree add /tmp/flipblog-v1.2.0 v1.2.0
cd /tmp/flipblog-v1.2.0
npm ci
npm run release:build -- --tag v1.2.0        # -> dist/releases/1.2.0
# Runtime smoke, exactly as the unit will run it:
node scripts/release-smoke.mjs --release dist/releases/1.2.0
```

The output directory **is** the built `server` package (src/, scripts/, the
compiled `public/` SPA, and a production-only `node_modules/`), so the unit's
`WorkingDirectory=/srv/flipblog/current` + `node src/index.js` work unchanged.
The same job runs automatically on every PR as the CI `release` job, which
uploads the built `dist/releases/` artifact — CI green is the gate that the
exact ref builds and boots.

To deploy: the CI pipeline does it for you — see **Pipeline (Issue #35)** below.
Manually, `scp`/rsync the directory to the host under
`/srv/flipblog/releases/<version>`, repoint the `current` symlink, and restart
(§3.8 of `docs/deployment.md`).

## Pipeline (Issue #35)

GitHub Actions deploys every candidate. Workflows are in
`.github/workflows/`:

| Workflow | When | Where | Approval |
|----------|------|-------|----------|
| `deploy-staging.yml` | every `main` push, or manual with a version/tag | staging | none |
| `promote-production.yml` | manual with a `vX.Y.Z` tag | production | **required** (`production` environment reviewers) |
| `rollback-staging.yml` / `rollback-production.yml` | manual with a release dir name | staging / production | only for production |

Each deploy: CI gate (test/e2e/release green at the ref, polling until complete) →
reproducible build → local artifact smoke → `scripts/deploy.sh`
(readiness-gated, auto-rollback, migration/backup log excerpt) →
`scripts/post-deploy-smoke.mjs` (health/login/publish/reader/uploads).
Rollback is a symlink flip (`scripts/rollback.sh`) over release directories
that remain on the host — no rebuild. If the release being replaced migrated
the DB forward, the DB gate restores the newest compatible `flipblog-pre-v*.db`
backup before the flip so the older build can boot; without a compatible backup
the rollback is refused (restore from the offsite backups first).

### Concurrency & release identity

- **Staging**: `cancel-in-progress: false` — deploys queue so a host update is
  never interrupted. Each push-to-main gets its own release directory named
  by the commit short SHA (e.g. `8ede71b5a6b7`), so previous candidates are
  never overwritten and remain valid rollback targets. Manual re-deploy of a
  tag uses the tag value (sans `v`) as the directory name.
- **Production**: `cancel-in-progress: false` — promotions queue. Tag names
  are the release directories; re-promoting the same tag skips re-extraction
  and just flips the symlink + restarts (no rebuild).

### Host retention

Release directories accumulate under `/srv/flipblog/releases/`. The operator
should periodically prune old staging directories (e.g. keep the last 10
commits). A simple cron like `ls -dt /srv/flipblog/releases/* | tail -n +11 | xargs rm -rf`
can be used. Production directories are kept indefinitely unless manually
removed.

### One-time setup per environment

1. **Host**: install the unit + data-disk mount as in the Install section, with
   separate hosts/domains for staging and production.
2. **Deploy user**: create an SSH key pair for the pipeline runner, install the
   public key in `~deploy/.ssh/authorized_keys`, and grant passwordless sudo for
   exactly what the scripts need. Install it as a sudoers drop-in file
   (`/etc/sudoers.d/flipblog-deploy`, mode `0440`), replacing the values in the
   snippet below with the host's actual absolute paths from `command -v
   systemctl` and `command -v node`:
   ```
   # /etc/sudoers.d/flipblog-deploy
   deploy ALL=(root) NOPASSWD: \
     /usr/bin/systemctl start flipblog, \
     /usr/bin/systemctl stop flipblog, \
     /usr/bin/systemctl restart flipblog, \
     /usr/bin/node /tmp/flipblog-db-rollback-check.mjs, \
     /usr/bin/tee /etc/flipblog/app.env, \
     /usr/bin/chown, \
     /usr/bin/chmod
   ```
   If that file already exists from an earlier setup, **replace its contents
   rather than appending to the old single-line rule** (a rule in an earlier
   line wins in sudoers, so a stale `systemctl restart`-only line would shadow
   this one and break `systemctl start` on rollback).
   The `/usr/bin/node /tmp/flipblog-db-rollback-check.mjs` entry is what lets the
   pipeline run the migration-aware DB gate under root; the tool is uploaded to
   exactly that fixed path by both `deploy.sh` and `rollback.sh` (the scripts
   `scp` it from this repo). After a restore it hands ownership back via the
   already-allowed `chown`. The `start`/`stop`/`restart` entries are all needed:
   the rollback path stops the unit **before** restoring a database backup and
   starts it again afterwards (see the section below).
3. **GitHub environments**: create `staging` and `production`. On `production`,
   enable **Required reviewers** — that is the explicit-approval gate for
   promotion and production rollback.
4. **Secrets/variables** (per environment, named `STAGING_*` / `PROD_*`):

   | Name | Kind | Contents |
   |------|------|----------|
   | `<ENV>_SSH_HOST` / `<ENV>_SSH_USER` | Secret | host + deploy user |
   | `<ENV>_SSH_KEY` | Secret | private key (OpenSSH, PEM) |
   | `<ENV>_APP_ENV` | Secret | the full `/etc/flipblog/app.env` text (all secrets; written to the host 0600) |
   | `<ENV>_ADMIN_USER` / `<ENV>_ADMIN_PASSWORD` | Secret | the seeded admin login (used by the post-deploy smoke) |
   | `<ENV>_BASE_URL` | Variable | public base URL for the post-deploy smoke, e.g. `https://staging.example.com` |

5. Configure the `Caddyfile` hostname per environment (staging domain vs
   production domain).

### Host prerequisite update for migration-aware rollback

The `db-rollback-check.mjs` gate and the stop-before-restore rollback path are
**only operational once this host-side change is applied**. This is a required
prerequisite, not optional documentation: until it is in place, an automatic
deploy rollback or a manual `rollback.sh` that hits an already-migrated database
fails with a permission error exactly when someone is having a bad day. Apply it
on **every** staging and production host before the new rollback workflow is
treated as operational.

Replace the previous sudoers line for the deploy user with a drop-in file.
Use the host's actual absolute paths — resolve them first, because sudoers does
not expand `$PATH` and turns a path mismatch into an opaque permission error:

```bash
SYSTEMCTL="$(command -v systemctl)"
NODE="$(command -v node)"
# sanity-check both are absolute and non-empty before writing the file
printf 'systemctl: %s\nnode: %s\n' "$SYSTEMCTL" "$NODE"
```

Then create the file (adjusting the paths if they differ):

```bash
sudo tee /etc/sudoers.d/flipblog-deploy >/dev/null <<EOF
# /etc/sudoers.d/flipblog-deploy
deploy ALL=(root) NOPASSWD: \\
  $SYSTEMCTL start flipblog, \\
  $SYSTEMCTL stop flipblog, \\
  $SYSTEMCTL restart flipblog, \\
  $NODE /tmp/flipblog-db-rollback-check.mjs, \\
  /usr/bin/tee /etc/flipblog/app.env, \\
  /usr/bin/chown, \\
  /usr/bin/chmod
EOF
sudo chmod 0440 /etc/sudoers.d/flipblog-deploy
sudo visudo -c   # must print "parsed OK" — do not leave a broken sudoers
```

Notes:

- If `/etc/sudoers.d/flipblog-deploy` already exists from an earlier setup,
  **replace** it rather than appending: sudoers honors the *first* matching rule,
  so a stale line that predates this file (or lists only `restart`) would shadow
  the new one and break `systemctl start` during rollback. Verify with
  `sudo -l -U deploy` after applying.
- The scripts scp `server/scripts/db-rollback-check.mjs` to exactly
  `/tmp/flipblog-db-rollback-check.mjs` before running the gate, which is why the
  `node` rule is scoped to that path.
- The `start`/`stop`/`restart` entries are all required: the rollback path runs
  `sudo systemctl stop flipblog` **before** restoring a pre-migration backup
  (never replace the DB while a process holds it open) and starts the unit again
  afterwards.
- `chown`/`chmod`/`tee` are pre-existing requirements of `deploy.sh`
  (app.env write + handing the restored DB back to `flipblog:flipblog`).

## Install (Debian/Ubuntu, as root)

```bash
# 1. Service user and directories
useradd --system --home /var/lib/flipblog --shell /usr/sbin/nologin flipblog
install -d -o flipblog -g flipblog /var/lib/flipblog /var/lib/flipblog/uploads \
  /var/lib/flipblog/backups /var/lib/flipblog/offsite-staging
install -d -m 0750 /etc/flipblog

# 2. Data-disk mount (persistent block volume -> /var/lib/flipblog).
#    See systemd mount docs; the unit Requires=flipblog-data.mount.

# 3. Environment file
install -o root -g flipblog -m 0600 deploy/systemd/app.env.example /etc/flipblog/app.env
# then edit /etc/flipblog/app.env and replace every REPLACE_* value.

# 4. Release dir + symlink (build steps above; §3.8 of docs/deployment.md)
install -d -o flipblog -g flipblog /srv/flipblog /srv/flipblog/releases
# ...place the built dist/releases/<version> directory here...
ln -sfn /srv/flipblog/releases/1.2.0 /srv/flipblog/current
chown -h flipblog:flipblog /srv/flipblog/current

# 5. Caddy
apt install caddy
install -o root -g root -m 0644 deploy/caddy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

## Start

```bash
systemctl daemon-reload
systemctl enable --now flipblog
curl -fsS http://127.0.0.1:3000/api/health/ready   # 200 => gate passed
```

## Shutdown semantics

`SIGTERM` (from `systemctl stop` / restart) triggers the app's graceful drain:
stop accepting connections, finish in-flight requests up to `SHUTDOWN_GRACE_MS`
(10 s default), close the SQLite database, then exit 0. `TimeoutStopSec=20`
exceeds the grace window so systemd waits instead of SIGKILLing mid-drain.
During the drain, `GET /api/health/ready` returns `503 shutting_down`, which
makes Caddy stop routing traffic to the instance.

## Backups

The app's startup + offsite backup story is in
[`docs/backup-and-recovery.md`](../docs/backup-and-recovery.md); `app.env`
points DB/backup/offsite staging dirs at the data disk, and an offsite push
timer ships encrypted copies to independent object storage (see
`docs/deployment.md` §3.6).
