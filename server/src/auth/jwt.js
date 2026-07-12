import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (input) => Buffer.from(JSON.stringify(input)).toString('base64url');
const b64urlDecode = (input) => JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));

function signData(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signJwt(payload, secret, ttlSeconds = 60 * 60 * 24 * 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const data = `${b64url(header)}.${b64url(body)}`;
  const sig = signData(data, secret);
  return `${data}.${sig}`;
}

export function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = signData(`${header}.${payload}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let decoded;
  try {
    decoded = b64urlDecode(payload);
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof decoded.exp === 'number' && decoded.exp < now) return null;
  return decoded;
}
