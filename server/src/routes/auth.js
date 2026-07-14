import { Router } from 'express';
import { config } from '../config.js';
import { signJwt } from '../auth/jwt.js';
import { validateBody, loginSchema, registerSchema, changePasswordSchema } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { upload, uploadErrorHandler } from '../middleware/upload.js';
import {
  authenticate,
  createUser,
  getAdminByUsername,
  getUserById,
  verifyUserPassword,
  updatePassword,
  setAvatar,
} from '../services/admin.js';

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
  const user = getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    user: {
      username: user.username,
      role: user.role,
      avatar: user.avatar,
      created_at: user.created_at,
    },
  });
});

// Authenticated users upload/change their own profile picture (any role).
router.post(
  '/avatar',
  requireAuth,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      const url = `${config.uploadsUrl}/${req.file.filename}`;
      setAvatar(req.user.sub, url);
      res.json({ avatar: url });
    } catch (err) {
      next(err);
    }
  },
  uploadErrorHandler
);

// Authenticated users change their own password (current password required).
router.post(
  '/change-password',
  requireAuth,
  validateBody(changePasswordSchema),
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.valid;
      const ok = await verifyUserPassword(req.user.sub, currentPassword);
      if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
      await updatePassword(req.user.sub, newPassword);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

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
