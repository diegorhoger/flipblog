# Release Process

This document defines the release process for FlipBlog, from development to production deployment.

## Versioning

We follow [Semantic Versioning](https://semver.org/):
- **MAJOR**: Breaking changes to public API or database schema
- **MINOR**: New features, backwards-compatible
- **PATCH**: Bug fixes, backwards-compatible

## Branching Model

```
main ←─────────────────────────────────────────────────────────────
  │
  ├── feature/* (short-lived, merged via PR)
  ├── fix/* (short-lived, merged via PR)
  ├── release/vX.Y.Z (long-lived, RC → production)
  └── hotfix/vX.Y.Z (emergency fixes on production tag)
```

### Main Branch
- Protected by branch protection rules
- Requires: PR with 1 approval, all CI checks pass, conversation resolution
- Direct pushes disabled
- Force pushes disabled

### Feature Branches
- Created from `main`
- Naming: `feature/short-description` or `fix/short-description`
- Merged via PR after review and CI pass
- Deleted after merge

### Release Branches
- Created from `main` when preparing a release
- Naming: `release/vX.Y.Z`
- Only bug fixes and version bumps allowed
- Merged back to `main` after production release

### Hotfix Branches
- Created from production tag
- Naming: `hotfix/vX.Y.Z`
- Merged to both `main` and `release/*` branch
- Fast-tracked review for critical issues

## Release Candidate Workflow

### 1. Prepare Release Candidate
```bash
# On main, after all features for the release are merged
git switch main
git pull origin main

# Create release branch
git switch -c release/v1.2.0

# Bump version in package.json
npm version minor --no-git-tag-version
# or npm version patch / major

# Update CHANGELOG.md
# Commit version bump and changelog (npm version also updates package-lock.json)
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v1.2.0"
git push origin release/v1.2.0
```

### 2. Create RC Tag
```bash
# Tag RC from release branch
git tag -a v1.2.0-rc.1 -m "Release candidate 1 for v1.2.0"
git push origin v1.2.0-rc.1
```

### 3. RC Verification
- CI runs on PRs to `main` and every push to `main` (test, e2e, and the
  reproducible-build `release` job from #34).
- Deploying the RC to staging is **automatic**: every push to `main` triggers
  [`deploy-staging.yml`](../.github/workflows/deploy-staging.yml), which gates on
  green CI, builds the exact ref, deploys to the production-like staging host,
  gates on readiness, and runs the post-deploy smoke. A specific RC tag
  (`workflow_dispatch` → Deploy to staging → version `v1.2.0-rc.1`) can be
  deployed the same way.
- Run the full verification checklist (see RELEASE_CHECKLIST.md).
- Fix any issues on release branch, create new RC if needed.

### 4. Production Release
```bash
# On release branch after RC approval
git tag -a v1.2.0 -m "Release v1.2.0"
git push origin v1.2.0
```

- **Promote via the pipeline**: run
  [`promote-production.yml`](../.github/workflows/promote-production.yml)
  (`workflow_dispatch`) with version `v1.2.0`. It gates on green CI at the tag,
  builds the exact tag, and deploys to production **only after explicit
  approval** — the job targets the `production` GitHub environment, which must
  have "Required reviewers" enabled so a human signs off before any step runs.
  The `current` symlink switch keeps the previous release installed for
  one-command rollback.
- Run post-deployment verification (the pipeline's smoke covers health, login,
  publish, reader, and uploads).
- Merge release branch back to main
- Delete release branch (optional)

## Required Checks

All PRs to `main` and release branches must pass:
1. **test** — Unit, integration, and web tests
2. **e2e** — Playwright end-to-end tests
3. **release** — reproducible build from the exact ref + artifact smoke (Issue #34)

The deploy pipelines re-verify at the commit/tag they deploy: deployment is refused
unless each of these checks is green (`.github/workflows/deploy-staging.yml`,
`.github/workflows/promote-production.yml`).

Branch protection enforces:
- Strict status checks (all three must pass)
- 1 approving review
- Dismiss stale reviews on new commits
- Require last push approval
- Conversation resolution
- Admin enforcement

## Continuous Delivery Pipeline (Issue #35)

| Workflow | Triggers | Destination | Approval |
|----------|----------|-------------|----------|
| `.github/workflows/deploy-staging.yml` | push to `main`, or `workflow_dispatch` with a version/tag | staging host | none (`staging` environment) |
| `.github/workflows/promote-production.yml` | `workflow_dispatch` with a `vX.Y.Z` tag | production host | **required** — `production` environment with "Required reviewers" |
| `.github/workflows/rollback-staging.yml` | `workflow_dispatch` with a release dir name | staging host | none |
| `.github/workflows/rollback-production.yml` | `workflow_dispatch` with a release dir name | production host | **required** |

Every deploy:
1. **Gates on required CI**: refuses the commit/tag unless `test`, `e2e` and
   `release` check-runs are green.
2. **Builds reproducibly**: `npm ci` → `npm run release:build` at the exact
   ref/tag (`scripts/build-release.mjs`, Issue #34).
3. **Local artifact smoke**: `scripts/release-smoke.mjs` (liveness, readiness,
   SPA, graceful SIGTERM exit 0).
4. **Installs via `scripts/deploy.sh`** over SSH: uploads the release dir,
   writes `/etc/flipblog/app.env` (from environment secrets), flips the
   `current` symlink, restarts the unit, and **gates on readiness** (200 within
   90 s), printing the app's migration/backup startup log lines.
5. **Auto-rolls back** on readiness failure by restoring the previous `current`
   symlink (an existing release dir, so **no rebuild**).
6. **Post-deploy smoke** (`scripts/post-deploy-smoke.mjs`): health, admin login,
   upload, publish, and anonymous read.

**Rollback (without rebuilding):** run the environment's `rollback-*.yml`
workflow with the release directory name to restore (it must already exist under
`/srv/flipblog/releases/`). `scripts/rollback.sh` flips the symlink, restarts,
re-checks readiness, and restores the prior version if the target fails.
Release directories are retained on the host after each deploy precisely so the
previous known-good version is always one flip away.

## Database Migrations

- Migrations are JavaScript modules in `server/src/migrations/`
- Numbered sequentially (001, 002, ...)
- Applied automatically on server startup
- **Never** modify applied migrations
- **Always** test migrations on staging with production-like data
- Backwards-compatible when possible
- Breaking migrations require MAJOR version and downtime window

## Pre-Release Checklist

See `.github/RELEASE_CHECKLIST.md` for the complete checklist.

Summary:
- [ ] All CI green
- [ ] Database backup strategy confirmed
- [ ] Migration tested on staging
- [ ] Security review complete
- [ ] Stakeholder sign-off
- [ ] Rollback plan tested

## Post-Release

### Merge Back to Main
`main` is branch-protected and does not accept direct pushes. Merge the release branch back via a pull request:
```bash
# From the release branch
git switch main
git pull origin main
git switch release/v1.2.0
git merge main
# Resolve conflicts, run tests, then open a PR:
#   base: main, head: release/v1.2.0
# Require CI (test + e2e) and 1 approving review before merging.
git push origin release/v1.2.0
```

### Cleanup
- Delete release branch locally and remotely
- Delete RC tags (keep production tag)
- Close milestone in GitHub

### Retrospective
Within 1 week of release:
- Review what went well / what didn't
- Update this document if process changes needed
- Plan next release window

## Emergency Hotfix

For critical production issues:
```bash
# From production tag
git switch -c hotfix/v1.2.1 v1.2.0

# Fix issue, test, commit
git add .
git commit -m "fix: critical production issue"

# Tag (deployment via the pipeline, see below)
git tag -a v1.2.1 -m "Hotfix v1.2.1"
git push origin v1.2.1

# Promote: run promote-production.yml with version v1.2.1, approve the
# production environment gate, post-deploy smoke runs automatically.

# Merge to main via PR (main is branch-protected, no direct pushes)
git push origin hotfix/v1.2.1
# Open a PR: base: main, head: hotfix/v1.2.1
# Require CI + 1 approving review before merging.
```

## Communication

- Release notes published in GitHub Releases
- Stakeholders notified via Slack/email
- Breaking changes highlighted in bold
- Migration instructions included

## Rollback Conditions

Automatic rollback triggers:
- Health check failures > 5 minutes
- Error rate > 5% for 5 minutes
- Critical user flow broken

Manual rollback:
```bash
# Revert to previous tag
git tag -d v1.2.0  # if not pushed
# or deploy previous artifact
```

## Responsibilities

| Role | Responsibility |
|------|----------------|
| Release Engineer | Create RC, run CI, coordinate deployment |
| Engineering Lead | Approve RC, sign off production release |
| Security Reviewer | Approve auth/data changes |
| Product Owner | Feature completeness sign-off |
| On-call | Post-deployment monitoring |

---

*Last updated: 2026-08-12*
*Version: 1.1 — Issue #35: staging + production CD pipeline*