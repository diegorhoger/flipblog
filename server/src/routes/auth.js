import { Router } from 'express';
import { config } from '../config.js';
import { signJwt } from '../auth/jwt.js';
import { validateBody, loginSchema, registerSchema } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { authenticate, createUser, getAdminByUsername } from '../services/admin.js';

const router = Router();

function setSessionCookie(res, user) {
  const token = signJwt(
    { username: user.username, sub: user.id, role: user.role },
    config.appSecret,
    config.jwtTtlSeconds
  );
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: config.jwtTtlSeconds * 1000,
    path: '/',
  });
}

router.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.valid;
    const user = await authenticate(username, password);
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    setSessionCookie(res, user);
    res.json({ user: { username: user.username, role: user.role } });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.cookieName, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { username: req.user.username, role: req.user.role } });
});

// Admin-only registration: create additional users (e.g. authors). Self-signup
// is intentionally disabled; only an authenticated admin may invite new users.
router.post(
  '/register',
  requireAuth,
  requireRole('admin'),
  validateBody(registerSchema),
  async (req, res, next) => {
    try {
      const { username, password, role } = req.valid;
      if (getAdminByUsername(username)) {
        return res.status(409).json({ error: 'username_taken' });
      }
      const user = await createUser({ username, password, role });
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
