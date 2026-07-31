## Issue / Link
<!-- Link to the issue this PR addresses -->
Closes #

## Scope
<!-- What does this PR change? Select all that apply -->
- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Documentation
- [ ] Test
- [ ] CI / Build
- [ ] Security

## Risk Assessment
<!-- Evaluate the risk of this change -->
- **Risk level:** [Low / Medium / High / Critical]
- **Affected areas:** [e.g., auth, posts, uploads, config, database]
- **Rollback complexity:** [Trivial / Easy / Moderate / Complex]

## Security Impact
<!-- Does this change have security implications? -->
- [ ] No security impact
- [ ] Authentication / authorization changes
- [ ] Input validation / sanitization
- [ ] Data exposure / privacy
- [ ] Cryptography / secrets
- [ ] Rate limiting / DoS protection

## Database / Migration Impact
<!-- Does this change require database migrations? -->
- [ ] No database changes
- [ ] New migration required (include migration file)
- [ ] Schema change (backwards compatible)
- [ ] Schema change (breaking)
- [ ] Data migration needed

## Verification Commands
<!-- Commands used to verify this change locally -->
```bash
# Lint
npm run lint

# Unit tests
npm test

# Server tests
npm run test --workspace flipblog-server

# Web tests
npm run test --workspace flipblog-web

# E2E tests
npm run test:e2e

# Build
npm run build
```

## Test Results
<!-- Paste relevant test output or describe what was verified -->
```
Tests: 313 server, 63 web, 3 e2e
All passing
```

## Screenshots / Recordings
<!-- For UI changes, include before/after screenshots or a screen recording -->

## Rollback Plan
<!-- How to roll back if this PR causes issues in production -->
1. Revert commit: `git revert <sha>`
2. Deploy previous artifact

## Human Review Gate
<!-- Required for all PRs per branch protection -->
- [ ] Self-reviewed
- [ ] At least 1 approving review
- [ ] No stale approvals (new commits dismiss old reviews)
- [ ] All CI checks pass (test, e2e)
- [ ] Conversations resolved

---

**By submitting this PR, I confirm:**
- Tests pass locally
- No secrets or credentials are committed
- The rollback plan is documented
- This PR is ready for human review