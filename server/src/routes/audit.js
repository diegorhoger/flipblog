import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { auditAltText } from '../services/altAudit.js';

const router = Router();

// Only roles that can manage posts may run the audit. FlipBlog has two such
// roles today (`admin`, `author`); any other/unknown role is rejected with 403.
// Ownership scoping (authors see only their own posts) is enforced in the
// service layer, mirroring how posts.js gates editing.
function requireManagePosts(req, res, next) {
  const role = req.user?.role;
  if (role === 'admin' || role === 'author') return next();
  return res.status(403).json({ error: 'forbidden' });
}

// GET /api/audit/alt-text
// Read-only audit of legacy image alt text. Returns per-post findings with only
// safe public metadata (post id/title/slug + image src/alt/type). Supports
// pagination over the posts that have findings (bounded limit 1..50).
router.get('/alt-text', requireAuth, requireManagePosts, (req, res, next) => {
  try {
    const result = auditAltText({
      actor: req.user,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
