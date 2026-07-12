import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody, postSchema } from '../middleware/validate.js';
import { listPosts, getPostBySlug, createPost, updatePost, deletePost } from '../services/posts.js';

const router = Router();

router.get('/', (req, res) => {
  const { status, page, limit } = req.query;
  res.json(listPosts({ status: status || 'published', page, limit }));
});

router.get('/id/:id', (req, res) => {
  const post = getPostById(req.params.id);
  if (!post) return res.status(404).json({ error: 'not_found' });
  res.json(post);
});

router.get('/:slug', (req, res) => {
  const post = getPostBySlug(req.params.slug);
  if (!post) return res.status(404).json({ error: 'not_found' });
  res.json(post);
});

router.post('/', requireAuth, validateBody(postSchema), (req, res, next) => {
  try {
    const post = createPost(req.valid);
    res.status(201).json(post);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAuth, validateBody(postSchema), (req, res, next) => {
  try {
    const post = updatePost(req.params.id, req.valid);
    if (!post) return res.status(404).json({ error: 'not_found' });
    res.json(post);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, (req, res, next) => {
  try {
    const ok = deletePost(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
