# Release Checklist

## Pre-Release

### Branch & Version
- [ ] Release branch created from `main` (e.g., `release/v1.2.0`)
- [ ] Version bumped in `package.json` (semantic versioning)
- [ ] CHANGELOG.md updated with all changes since last release

### Required Checks
- [ ] All CI checks pass on `main` (test, e2e)
- [ ] All CI checks pass on release branch
- [ ] No open critical/high security issues
- [ ] Database migration tested on staging
- [ ] Build artifacts generated and verified

### Approvals
- [ ] At least 1 approving review from maintainer
- [ ] No stale approvals (new commits dismiss old reviews)
- [ ] All conversations resolved
- [ ] Security review completed for auth/data changes

### Database
- [ ] Backup strategy verified for production
- [ ] Migration tested on staging with production-like data
- [ ] Rollback migration script prepared
- [ ] Migration is backwards-compatible or downtime window scheduled

### Configuration
- [ ] Production environment variables reviewed
- [ ] Secrets rotated if needed
- [ ] Feature flags configured for gradual rollout
- [ ] Monitoring alerts updated for new features

## Release Candidate

### RC Creation
- [ ] Tag RC: `git tag -a v1.2.0-rc.1 -m "Release candidate 1"`
- [ ] Push tag: `git push origin v1.2.0-rc.1`
- [ ] Run CI checks manually (tag pushes do not trigger CI yet)
- [ ] RC deployed to staging environment (manual step)

### RC Verification
- [ ] Smoke tests pass on staging
- [ ] E2E tests pass on staging
- [ ] Performance baseline measured
- [ ] Security scan (dependency audit, SAST) clean
- [ ] Manual verification of critical user flows

### Stakeholder Sign-off
- [ ] Product owner approval
- [ ] Engineering lead approval
- [ ] Security approval (if applicable)

## Production Release

### Pre-Deployment
- [ ] Final backup of production database
- [ ] Confirm rollback plan and test it
- [ ] Notify stakeholders of deployment window
- [ ] Verify staging matches RC exactly

### Deployment
- [ ] Deploy to production
- [ ] Run database migrations
- [ ] Verify health checks pass
- [ ] Run smoke tests on production
- [ ] Monitor error rates and latency

### Post-Deployment
- [ ] 15-minute stability watch
- [ ] Key metrics within baseline
- [ ] Error rate < threshold
- [ ] No critical alerts firing

## Post-Release

### Immediate (0-2 hours)
- [ ] Confirm all user-facing features work
- [ ] Verify monitoring dashboards
- [ ] Check error tracking (Sentry, logs)
- [ ] Confirm backup completed

### Short-term (24 hours)
- [ ] No critical regressions reported
- [ ] Performance metrics stable
- [ ] User feedback monitored

### Long-term (1 week)
- [ ] Release retrospective
- [ ] Update documentation
- [ ] Close resolved issues
- [ ] Plan next release

---

## Emergency Rollback Trigger
Rollback immediately if any of the following occur:
- Error rate > 5% for 5 minutes
- Critical user flow completely broken
- Data corruption detected
- Security incident

Rollback procedure:
1. Revert deployment to previous version
2. Run rollback migration if needed
3. Verify health checks
4. Communicate to stakeholders
5. Create incident report