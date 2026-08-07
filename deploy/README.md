# FlipBlog production deploy assets

Reference artifacts for the architecture selected in
[`docs/deployment.md`](../docs/deployment.md) and implemented under Issue #34.

## Layout

| Path | Purpose |
|------|---------|
| `systemd/flipblog.service` | systemd unit: runs the app as `flipblog`, reads `/etc/flipblog/app.env`, requires the data-disk mount, gives the app a bounded stop window. |
| `systemd/app.env.example` | template for `/etc/flipblog/app.env` (root:flipblog, mode `0600`). Fill secrets; never commit a real one. |
| `caddy/Caddyfile` | Caddy reverse proxy: TLS termination + auto certs, forwards `X-Forwarded-*` matching `TRUST_PROXY=1`, readiness health check. |

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

# 4. Release dir + symlink (see docs/deployment.md §3.8)
install -d -o flipblog -g flipblog /srv/flipblog
ln -sfn /srv/flipblog/releases/<vX.Y.Z> /srv/flipblog/current
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
