#!/usr/bin/env bash
# Rolls a deployed environment back to a previously-installed release directory
# WITHOUT rebuilding: release directories persist under /srv/flipblog/releases
# after each deploy, so restoring a known-good version is one symlink flip.
#
# Conservative: only operates on release directories already present on the
# host (verified before touching `current`), and refuses a rollback to the same
# version that is currently active.
#
# Environment:
#   SSH_HOST, SSH_USER, SSH_KEY_PATH      (required)
#   SSH_KNOWN_HOSTS_PATH                  (optional; pins the host key)
#   VERSION                               (target release, REQUIRED; must exist on host)
#   BASE_DIR (default /srv/flipblog), RELEASES_BASE, CURRENT_LINK
#   SERVICE_USER (default flipblog)
#   READY_URL (default http://127.0.0.1:3000/api/health/ready)

set -euo pipefail

: "${SSH_HOST:?SSH_HOST is required}"
: "${SSH_USER:?SSH_USER is required}"
: "${SSH_KEY_PATH:?SSH_KEY_PATH is required}"
: "${VERSION:?VERSION is required}"

BASE_DIR="${BASE_DIR:-/srv/flipblog}"
RELEASES_BASE="${RELEASES_BASE:-$BASE_DIR/releases}"
CURRENT_LINK="${CURRENT_LINK:-$BASE_DIR/current}"
SERVICE_USER="${SERVICE_USER:-flipblog}"
READY_URL="${READY_URL:-http://127.0.0.1:3000/api/health/ready}"

SSH_OPTS=(-o BatchMode=yes -o LogLevel=ERROR)
if [ -n "${SSH_KNOWN_HOSTS_PATH:-}" ] && [ -f "$SSH_KNOWN_HOSTS_PATH" ]; then
  SSH_OPTS+=(-o UserKnownHostsFile="$SSH_KNOWN_HOSTS_PATH")
else
  SSH_OPTS+=(-o StrictHostKeyChecking=accept-new)
fi

emit() { printf '%q' "$1"; }
REMOTE_TARBALL="" # unused; kept for parity

ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
  "export VERSION=$(emit "$VERSION") RELEASES_BASE=$(emit "$RELEASES_BASE") CURRENT_LINK=$(emit "$CURRENT_LINK") SERVICE_USER=$(emit "$SERVICE_USER") READY_URL=$(emit "$READY_URL"); bash -s" <<'REMOTE'
set -euo pipefail

target="$RELEASES_BASE/$VERSION"
if [ ! -d "$target" ]; then
  echo "ROLLBACK FAIL: release dir not present on host: $target" >&2
  exit 2
fi

prev_name=""
if [ -L "$CURRENT_LINK" ]; then
  prev_name="$(basename "$(readlink "$CURRENT_LINK" || true)")"
else
  echo "ROLLBACK FAIL: $CURRENT_LINK is not a symlink (nothing to roll back)" >&2
  exit 2
fi

if [ "$prev_name" = "$VERSION" ]; then
  echo "ROLLBACK FAIL: $VERSION is already active" >&2
  exit 2
fi

echo "rolling back: $prev_name -> $VERSION"
sudo ln -sfn "$target" "$CURRENT_LINK"
sudo chown -h "$SERVICE_USER:$SERVICE_USER" "$CURRENT_LINK"
sudo systemctl restart flipblog

ready=0
for i in $(seq 1 90); do
  if curl -fsS "$READY_URL" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done

if [ "$ready" != 1 ]; then
  echo "ROLLBACK FAIL: $VERSION did not become ready; restoring $prev_name" >&2
  sudo ln -sfn "$RELEASES_BASE/$prev_name" "$CURRENT_LINK"
  sudo chown -h "$SERVICE_USER:$SERVICE_USER" "$CURRENT_LINK"
  sudo systemctl restart flipblog
  exit 1
fi

echo "ROLLBACK_OK current=$CURRENT_LINK -> $VERSION"
REMOTE