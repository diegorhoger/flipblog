import { Router } from 'express';
import { config } from '../config.js';
import { signJwt } from '../auth/jwt.js';
import { validateBody, loginSchema, registerSchema, changePasswordSchema } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { upload, uploadErrorHandler } from '../middleware/upload.js';
import { deleteUnreferencedUploads } from '../services/uploadRefs.js';
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
//
// Middleware order matters: `upload.single('file')` runs before this handler and
// multer's disk storage has already written the new file to `config.uploadsDir`
// by the time we get here. That physical file therefore exists regardless of
// whether the database update below succeeds, which is exactly what the two
// cleanup paths account for:
//   * On success we best-effort delete the *previous* avatar file if nothing
//     else references it (a replacement frees the old file's disk space).
//   * On failure we best-effort delete the *new* file we just accepted so a
//     rejected update never leaves an orphan behind, while the previous avatar
//     is left completely untouched.
router.post(
  '/avatar',
  requireAuth,
  upload.single('file'),
  async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const url = `${config.uploadsUrl}/${req.file.filename}`;
    let committed = false;
    try {
      // Capture the previous avatar URL before overwriting the column so we can
      // consider it for cleanup once the new value is safely persisted.
      const current = getUserById(req.user.sub);
      const previousUrl = current ? current.avatar : null;

      // Database first: only once the column update commits do we treat the new
      // file as the live avatar and the old one as a cleanup candidate.
      setAvatar(req.user.sub, url);
      committed = true;

      // Best-effort cleanup of the replaced avatar. This runs strictly AFTER the
      // committed update, so the current user's row already holds the new URL and
      // no longer references `previousUrl`. deleteUnreferencedUploads() reuses the
      // shared path-safety + reference checks from PR #4: it deletes the old file
      // only when it is a managed `/uploads/<file>` URL, is not referenced by any
      // post, and is not another user's avatar. External/malformed/traversal URLs
      // map to no managed file and are ignored; a missing file counts as already
      // cleaned; any filesystem failure is swallowed and logged (without paths).
      // No `excludeUserId` is needed: because the update already committed, the
      // old URL is absent from this user's row, so an exact-match avatar hit can
      // only mean *another* user still uses the file.
      if (previousUrl && previousUrl !== url) {
        deleteUnreferencedUploads([previousUrl]);
      }

      res.json({ avatar: url });
    } catch (err) {
      // The new file was written by multer before this handler ran. If the
      // update did not commit, remove that orphaned new file best-effort and
      // leave the previous avatar untouched, then preserve the original error
      // behavior. `committed` guards against ever deleting a now-live avatar.
      if (!committed) deleteUnreferencedUploads([url]);
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
