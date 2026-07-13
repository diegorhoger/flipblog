import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/requireAuth.js';
import { validateBody, postSchema } from '../middleware/validate.js';
import { listPosts, getPostBySlug, getPostById, createPost, updatePost, deletePost } from '../services/posts.js';

const router = Router();

// Public listing: anonymous callers always get published posts only. Authenticated
// callers (owners/admins) may additionally request drafts; non-admin authors see
// only published posts plus their own.
router.get('/', optionalAuth, (req, res) => {
  const requestedStatus = req.query.status;
  if (!req.user) {
    return res.json(listPosts({ status: 'published', page: req.query.page, limit: req.query.limit }));
  }
  const status = requestedStatus || 'published';
  return res.json(
    listPosts({ status, page: req.query.page, limit: req.query.limit, actor: req.user })
  );
});

// Editor retrieval by id: authenticated only. Owners and admins may read; others
// receive 403. This endpoint previously crashed because getPostById was not
// imported — it is now, and the ownership check lives in the service layer.
router.get('/id/:id', requireAuth, (req, res, next) => {
  try {
    const post = getPostById(req.params.id, req.user);
    if (!post) return res.status(404).json({ error: 'not_found' });
    res.json(post);
  } catch (err) {
    next(err);
  }
});

// Public read by slug: published posts are world-readable; unpublished posts are
// visible only to their owner or an admin, and appear as 404 to everyone else.
router.get('/:slug', optionalAuth, (req, res) => {
  const post = getPostBySlug(req.params.slug, req.user || null);
  if (!post) return res.status(404).json({ error: 'not_found' });
  res.json(post);
});

router.post('/', requireAuth, validateBody(postSchema), (req, res, next) => {
  try {
    const post = createPost(req.valid, req.user);
    res.status(201).json(post);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAuth, validateBody(postSchema), (req, res, next) => {
  try {
    const post = updatePost(req.params.id, req.valid, req.user);
    if (!post) return res.status(404).json({ error: 'not_found' });
    res.json(post);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, (req, res, next) => {
  try {
    const ok = deletePost(req.params.id, req.user);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
