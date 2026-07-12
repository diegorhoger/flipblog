import { getDb } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { config } from '../config.js';

export function getAdminByUsername(username) {
  return getDb().prepare('SELECT * FROM admin WHERE username = ?').get(String(username));
}

export async function authenticate(username, password) {
  const admin = getAdminByUsername(username);
  if (!admin) return false;
  const ok = await verifyPassword(password, admin.password_hash);
  return ok ? { id: admin.id, username: admin.username, role: admin.role } : false;
}

export async function createUser({ username, password, role = 'author' }) {
  const db = getDb();
  const hash = await hashPassword(password);
  const info = db
    .prepare(
      'INSERT INTO admin (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(String(username), hash, String(role), new Date().toISOString());
  return { id: info.lastInsertRowid, username: String(username), role: String(role) };
}

export async function seedAdminIfMissing() {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM admin LIMIT 1').get();
  if (existing) return existing;
  const hash = await hashPassword(config.adminPassword);
  const info = db
    .prepare('INSERT INTO admin (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(config.adminUser, hash, 'admin', new Date().toISOString());
  return { id: info.lastInsertRowid, username: config.adminUser, role: 'admin' };
}
