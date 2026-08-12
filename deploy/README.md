# FlipBlog production deploy assets

Reference artifacts for the architecture selected in
[`docs/deployment.md`](../docs/deployment.md) and implemented under Issue #34.

## Layout

| Path | Purpose |
|------|---------|
| `systemd/flipblog.service` | systemd unit: runs the app as `flipblog`, reads `/etc/flipblog/app.env`, requires the data-disk mount, gives the app a bounded stop window. |
| `systemd/app.env.example` | template for `/etc/flipblog/app.env` (root:flipblog, mode `0600`). Fill secrets; never commit a real one. |
| `caddy/Caddyfile` | Caddy reverse proxy: TLS termination + auto certs, forwards `X-Forwarded-*` matching `TRUST_PROXY=1`, readiness health check. |
| `../scripts/build-release.mjs` | reproducible release build (`npm run release:build`): pinned ref → `npm ci` → Vite build → self-contained versioned release directory. |
| `../scripts/release-smoke.mjs` | boots the built artifact like systemd and verifies liveness, readiness, SPA, and graceful SIGTERM shutdown (`npm run release:smoke`). |

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

To deploy: `scp`/rsync the directory to the host under
`/srv/flipblog/releases/<version>`, repoint the `current` symlink, and restart
(§3.8 of `docs/deployment.md`).

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
