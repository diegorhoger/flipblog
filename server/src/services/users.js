import { getDb } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { config } from '../config.js';

export function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(String(username));
}

export function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

export async function verifyUserPassword(id, password) {
  const user = getUserById(id);
  if (!user) return false;
  return verifyPassword(password, user.password_hash);
}

export async function updatePassword(id, password) {
  const hash = await hashPassword(password);
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, Number(id));
}

export function setAvatar(id, url) {
  getDb().prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url ?? null, Number(id));
}

export async function authenticate(username, password) {
  const user = getUserByUsername(username);
  if (!user) return false;
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? { id: user.id, username: user.username, role: user.role } : false;
}

export async function createUser({ username, password, role = 'author' }) {
  const db = getDb();
  const hash = await hashPassword(password);
  const info = db
    .prepare(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(String(username), hash, String(role), new Date().toISOString());
  return { id: info.lastInsertRowid, username: String(username), role: String(role) };
}

export async function seedUserIfMissing() {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return existing;
  const hash = await hashPassword(config.adminPassword);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(config.adminUser, hash, 'admin', new Date().toISOString());
  return { id: info.lastInsertRowid, username: config.adminUser, role: 'admin' };
}
