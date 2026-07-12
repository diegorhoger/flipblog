import { config } from '../config.js';
import { verifyJwt } from '../auth/jwt.js';

export function requireAuth(req, res, next) {
  const token = req.cookies?.[config.cookieName];
  const payload = token && verifyJwt(token, config.appSecret);
  if (!payload) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.user = { username: payload.username, sub: payload.sub, role: payload.role };
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
