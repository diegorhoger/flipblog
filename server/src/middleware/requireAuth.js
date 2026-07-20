import { config } from '../config.js';
import { verifyJwt } from '../auth/jwt.js';

// Normalize the token payload into a request user. `sub` is normalized to a
// number so service-layer ownership checks can compare it directly against the
// integer owner_user_id stored in the database (JWT sub claims are strings).
function toUser(payload) {
  return {
    username: payload.username,
    sub: Number(payload.sub),
    role: payload.role,
  };
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[config.cookieName];
  const payload = token && verifyJwt(token, config.appSecret);
  if (!payload) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.user = toUser(payload);
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

// Like requireAuth, but does not reject anonymous requests. It attaches req.user
// when a valid token is present and otherwise leaves it undefined. Used for
// public endpoints that show additional (e.g. draft) content to authenticated
// owners/admins.
export function optionalAuth(req, res, next) {
  const token = req.cookies?.[config.cookieName];
  const payload = token && verifyJwt(token, config.appSecret);
  if (payload) {
    req.user = toUser(payload);
  }
  next();
}
