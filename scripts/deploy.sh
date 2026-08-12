#!/usr/bin/env bash
# Deploys a pre-built FlipBlog release directory to a target host over SSH.
#
# Used by the CI pipeline (Issue #35) for both staging and production. Runs on
# a Linux GitHub Actions runner; the built artifact (RELEASE_DIR) is pushed to
# the host and activated atomically via the `current` symlink:
#
#   1. uploads  dist/releases/<VERSION>  ->  <RELEASES_BASE>/<VERSION>
#   2. writes   /etc/flipblog/app.env    from APP_ENV_CONTENT (0600 root:flipblog)
#   3. switches current -> <VERSION>, restarts the unit
#   4. gates on readiness (READY_URL == 200 up to 90s)
#   5. on failure, restores the previous `current` symlink and restarts
#      (rollback uses a release dir that is already on the host — no rebuild)
#   6. prints the app's migration/backup startup log lines
#
# Requires on the host: the `deploy` user's SSH key, passwordless sudo for
# `systemctl` (restart flipblog) and writing /etc/flipblog/app.env, and the
# flipblog systemd unit from deploy/systemd/.
#
# Environment (all required unless noted):
#   SSH_HOST, SSH_USER, SSH_KEY_PATH
#   SSH_KNOWN_HOSTS_PATH   (optional; pins the host key if provided)
#   VERSION, RELEASE_DIR   (local path to the built release directory)
#   APP_ENV_CONTENT        (full app.env text, secrets included) or APP_ENV_B64
#   BASE_DIR / RELEASES_DIR / CURRENT_LINK  (defaults under /srv/flipblog)
#   SERVICE_USER           (default flipblog)
#   READY_URL              (default http://127.0.0.1:3000/api/health/ready)
#   PUSH_HOST              (optional: a copy of the tarball is also pushed here)

set -euo pipefail

: "${SSH_HOST:?SSH_HOST is required}"
: "${SSH_USER:?SSH_USER is required}"
: "${SSH_KEY_PATH:?SSH_KEY_PATH is required}"
: "${VERSION:?VERSION is required}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
[ -d "$RELEASE_DIR" ] || { echo "RELEASE_DIR does not exist: $RELEASE_DIR" >&2; exit 2; }

BASE_DIR="${BASE_DIR:-/srv/flipblog}"
RELEASES_BASE="${RELEASES_BASE:-$BASE_DIR/releases}"
CURRENT_LINK="${CURRENT_LINK:-$BASE_DIR/current}"
SERVICE_USER="${SERVICE_USER:-flipblog}"
READY_URL="${READY_URL:-http://127.0.0.1:3000/api/health/ready}"
REMOTE_TARBALL="/tmp/flipblog-release-${VERSION}-$$.tar.gz"

if [ -n "${APP_ENV_B64+x}" ] && [ -n "$APP_ENV_B64" ]; then
  : # already base64
elif [ -n "${APP_ENV_CONTENT+x}" ]; then
  APP_ENV_B64="$(printf '%s' "$APP_ENV_CONTENT" | base64 | tr -d '\n')"
else
  echo "WARNING: neither APP_ENV_CONTENT nor APP_ENV_B64 set; leaving /etc/flipblog/app.env untouched" >&2
  APP_ENV_B64=""
fi

SSH_OPTS=(-o BatchMode=yes -o LogLevel=ERROR)
if [ -n "${SSH_KNOWN_HOSTS_PATH:-}" ] && [ -f "$SSH_KNOWN_HOSTS_PATH" ]; then
  SSH_OPTS+=(-o UserKnownHostsFile="$SSH_KNOWN_HOSTS_PATH")
else
  SSH_OPTS+=(-o StrictHostKeyChecking=accept-new)
fi

# --- 1. bundle + upload --------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "packaging $RELEASE_DIR"
tar -C "$RELEASE_DIR" -czf "$WORK/release.tar.gz" .
echo "uploading tarball to $SSH_USER@$SSH_HOST"
scp "${SSH_OPTS[@]}" -q "$WORK/release.tar.gz" "$SSH_USER@$SSH_HOST:$REMOTE_TARBALL"

# Escape each value for embedding into the remote shell command line.
emit() { printf '%q' "$1"; }

# --- 2. remote install + gate + rollback ---------------------------------------
echo "remote install: VERSION=$VERSION -> $RELEASES_BASE/$VERSION"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
  "export VERSION=$(emit "$VERSION") RELEASES_BASE=$(emit "$RELEASES_BASE") CURRENT_LINK=$(emit "$CURRENT_LINK") APP_ENV_B64=$(emit "$APP_ENV_B64") SERVICE_USER=$(emit "$SERVICE_USER") READY_URL=$(emit "$READY_URL") TARBALL=$(emit "$REMOTE_TARBALL"); bash -s" <<'REMOTE'
set -euo pipefail

release_dir="$RELEASES_BASE/$VERSION"

echo "extracting to $release_dir"
sudo mkdir -p "$RELEASES_BASE"
# Release directories are immutable: never overwrite an existing dir, because
# every previous deploy is a potential rollback target. If the dir already
# exists (e.g. re-deploying the same SHA, or re-promoting the same tag), skip
# extraction and trust the existing files.
if [ -d "$release_dir" ]; then
  echo "release dir already present: $release_dir (skipping extraction; no rebuild)"
else
  sudo mkdir -p "$release_dir"
  sudo tar -xzf "$TARBALL" -C "$release_dir"
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$release_dir"
fi

if [ -n "$APP_ENV_B64" ]; then
  echo "writing /etc/flipblog/app.env"
  printf '%s\n' "$APP_ENV_B64" | base64 -d | sudo tee /etc/flipblog/app.env >/dev/null
  sudo chown root:"$SERVICE_USER" /etc/flipblog/app.env
  sudo chmod 0600 /etc/flipblog/app.env
fi

PREV_NAME=""
if [ -L "$CURRENT_LINK" ]; then
  PREV_NAME="$(basename "$(readlink "$CURRENT_LINK" || true)")"
fi
echo "previous current: ${PREV_NAME:-none}"

sudo ln -sfn "$release_dir" "$CURRENT_LINK"
sudo chown -h "$SERVICE_USER:$SERVICE_USER" "$CURRENT_LINK"
sudo systemctl restart flipblog

ready=0
for i in $(seq 1 90); do
  if curl -fsS "$READY_URL" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done

if [ "$ready" != 1 ]; then
  echo "READINESS FAILED for $VERSION"
  if [ -n "$PREV_NAME" ] && [ -d "$RELEASES_BASE/$PREV_NAME" ]; then
    echo "rolling back to $PREV_NAME (existing release dir; no rebuild)"
    sudo ln -sfn "$RELEASES_BASE/$PREV_NAME" "$CURRENT_LINK"
    sudo chown -h "$SERVICE_USER:$SERVICE_USER" "$CURRENT_LINK"
    sudo systemctl restart flipblog
  else
    echo "no previous release to roll back to; leaving current as-is"
  fi
  exit 1
fi
echo "readiness 200 for $VERSION"

echo '--- flipblog startup log (migration / backup) ---'
sudo journalctl -u flipblog -n 80 --no-pager \
  | grep -E 'db_migrations_applied|db_backup_created|db_backup_failed|listening on' \
  || echo '(no migration/backup lines in the recent log — nothing to migrate this deploy)'
echo '--- end ---'
echo "DEPLOY_OK current=$CURRENT_LINK -> $release_dir (previous: ${PREV_NAME:-none})"
REMOTE

echo "deploy complete: $VERSION"