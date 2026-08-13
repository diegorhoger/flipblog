#!/usr/bin/env bash
# Rolls a deployed environment back to a previously-installed release directory
# WITHOUT rebuilding: release directories persist under /srv/flipblog/releases
# after each deploy, so restoring a known-good version is one symlink flip.
#
# Conservative: only operates on release directories already present on the
# host (verified before touching `current`), and refuses a rollback to the same
# version that is currently active. It is migration-aware: before flipping, the
# DB is checked against the target release and, when the release being replaced
# migrated the DB forward, the newest compatible pre-migration backup is restored
# (server/scripts/db-rollback-check.mjs) so the older build can boot. The flip is
# refused entirely when the DB cannot be brought back to a compatible state.
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
REMOTE_TOOL="/tmp/flipblog-db-rollback-check.mjs"

# Upload the migration-aware rollback gate (same fixed host path as deploy.sh so
# one sudoers entry covers both). Rolls back to an OLDER release, so the DB may
# have migrations that release does not know; the gate restores the newest
# compatible pre-migration backup or refuses the flip.
scp "${SSH_OPTS[@]}" -q "server/scripts/db-rollback-check.mjs" "$SSH_USER@$SSH_HOST:$REMOTE_TOOL"

ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
  "export VERSION=$(emit "$VERSION") RELEASES_BASE=$(emit "$RELEASES_BASE") CURRENT_LINK=$(emit "$CURRENT_LINK") SERVICE_USER=$(emit "$SERVICE_USER") READY_URL=$(emit "$READY_URL") DB_ROLLBACK_TOOL=$(emit "$REMOTE_TOOL"); bash -s" <<'REMOTE'
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

# --- Migration-aware DB gate (identical semantics to deploy.sh's db_gate) -----
# The target release must be able to open the live DB. If it cannot (the release
# being replaced migrated the DB forward), restore the newest compatible
# pre-migration backup first; refuse the flip when no such backup exists. The
# unit is stopped first so the restore never replaces the DB while a flipblog
# process holds it open; a refused rollback restarts the previous service state.
DB_PATH="$(sed -n 's/^DB_PATH=//p' /etc/flipblog/app.env 2>/dev/null | tail -n 1)"
DB_BACKUP_DIR="$(sed -n 's/^DB_BACKUP_DIR=//p' /etc/flipblog/app.env 2>/dev/null | tail -n 1)"
if [ -n "$DB_PATH" ] && [ "$DB_PATH" != ":memory:" ]; then
  gate_args=(--release "$target" --db-path "$DB_PATH" --apply)
  [ -n "$DB_BACKUP_DIR" ] && gate_args+=(--backup-dir "$DB_BACKUP_DIR")
  echo "db-gate: ensuring $VERSION can open the live DB ($DB_PATH)"
  sudo systemctl stop flipblog || true
  if ! sudo node "$DB_ROLLBACK_TOOL" "${gate_args[@]}"; then
    echo "db-gate: REFUSING rollback to $VERSION — the DB is newer than that release and"
    echo "db-gate: no compatible pre-migration backup exists. Restore one from the offsite"
    echo "db-gate: backups first, then re-run the rollback." >&2
    sudo systemctl start flipblog || true
    exit 2
  fi
  sudo chown "$SERVICE_USER:$SERVICE_USER" "$DB_PATH" 2>/dev/null || true
else
  echo "db-gate: no persistent DB_PATH configured; skipping DB safety check"
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