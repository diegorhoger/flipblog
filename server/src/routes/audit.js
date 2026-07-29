import { Router } from 'express';
import { requireAuth, requireAnyRole } from '../middleware/requireAuth.js';
import { auditAltText } from '../services/altAudit.js';

const router = Router();

// GET /api/audit/alt-text
// Read-only audit of legacy image alt text. Returns per-post findings with only
// safe public metadata (post id/title/slug + image src/alt/type). Supports
// pagination over the posts that have findings (bounded limit 1..50).
router.get('/alt-text', requireAuth, requireAnyRole('admin', 'author'), (req, res, next) => {
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
