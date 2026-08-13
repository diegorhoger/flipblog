#!/usr/bin/env bash
# Waits until every required CI check-run is COMPLETED with a SUCCESS
# conclusion at the exact commit SHA, then exits 0. If any required check
# finishes with a non-success conclusion, or the poll deadline elapses,
# exits 1. Used by the deploy pipelines so a push-to-main (which fires
# `ci.yml` and `deploy-staging.yml` in parallel) doesn't race CI.
#
# Environment:
#   GITHUB_REPOSITORY       (required, owner/repo)
#   CI_SHA                  (required, exact commit SHA the deploy is targeting)
#   REQUIRED_CHECKS         (required, comma-separated check names, e.g. test,e2e,release)
#   POLL_INTERVAL_SECONDS   (default 15)
#   POLL_TIMEOUT_SECONDS    (default 1800 = 30 min)

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${CI_SHA:?CI_SHA is required}"
: "${REQUIRED_CHECKS:?REQUIRED_CHECKS is required}"
POLL_INTERVAL="${POLL_INTERVAL_SECONDS:-15}"
POLL_TIMEOUT="${POLL_TIMEOUT_SECONDS:-1800}"

echo "CI gate: waiting for checks [$REQUIRED_CHECKS] at $CI_SHA"
deadline=$(($(date +%s) + POLL_TIMEOUT))

IFS=',' read -ra names <<< "$REQUIRED_CHECKS"

while :; do
  runs_json=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${CI_SHA}/check-runs" --jq '.check_runs')

  pending=0
  for name in "${names[@]}"; do
    # Latest run per name at this SHA (max by id = most recently created).
    row=$(echo "$runs_json" | jq -r --arg n "$name" 'map(select(.name==$n)) | sort_by(.id) | reverse | .[0] // empty')
    if [ -z "$row" ]; then
      echo "  - $name: not started yet"
      pending=1
      continue
    fi
    status=$(echo "$row" | jq -r '.status')
    concl=$(echo "$row" | jq -r '.conclusion // "null"')
    echo "  - $name: status=$status conclusion=$concl"
    if [ "$status" = "completed" ]; then
      if [ "$concl" != "success" ]; then
        echo "::error::required CI check '$name' finished with conclusion=$concl (not success); refusing to deploy"
        exit 1
      fi
    else
      pending=1
    fi
  done

  if [ "$pending" = 0 ]; then
    echo "CI gate passed at $CI_SHA"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::timed out after ${POLL_TIMEOUT}s waiting for required CI checks at $CI_SHA"
    exit 1
  fi
  sleep "$POLL_INTERVAL"
done