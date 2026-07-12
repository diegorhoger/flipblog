import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, KEYLEN);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const derived = await scryptAsync(password, salt, KEYLEN);
  const storedBuf = Buffer.from(hash, 'hex');
  if (storedBuf.length !== derived.length) return false;
  return timingSafeEqual(storedBuf, derived);
}
