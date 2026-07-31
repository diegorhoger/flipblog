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
# Commit version bump and changelog
git add package.json CHANGELOG.md
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
- CI runs on tag push (test + e2e only; no auto-deploy)
- Deploy RC to staging environment (manual step)
- Run full verification checklist (see RELEASE_CHECKLIST.md)
- Fix any issues on release branch, create new RC if needed

### 4. Production Release
```bash
# On release branch after RC approval
git tag -a v1.2.0 -m "Release v1.2.0"
git push origin v1.2.0
```

- Deploy the tag or release-branch artifact to production (manual step; no CI/CD pipeline exists yet)
- Run post-deployment verification
- Merge release branch back to main
- Delete release branch (optional)

## Required Checks

All PRs to `main` and release branches must pass:
1. **test** — Unit, integration, and web tests
2. **e2e** — Playwright end-to-end tests

Branch protection enforces:
- Strict status checks (both must pass)
- 1 approving review
- Dismiss stale reviews on new commits
- Require last push approval
- Conversation resolution
- Admin enforcement

## Database Migrations

- Migrations are SQL files in `server/migrations/`
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
```bash
git switch main
git pull origin main
git merge --no-ff release/v1.2.0
git push origin main
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

# Tag (deployment is manual — no CI/CD pipeline exists yet)
git tag -a v1.2.1 -m "Hotfix v1.2.1"
git push origin v1.2.1

# Merge to main (and active release branch if one exists)
git switch main
git merge hotfix/v1.2.1
git push origin main
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

*Last updated: 2026-07-29*
*Version: 1.0*