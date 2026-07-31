import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { app } from './helpers.js';
import { securityHeaders } from '../src/middleware/securityHeaders.js';

test('every API response carries the hardened browser security headers', async () => {
  const res = await request(app).get('/api/posts');
  assert.equal(res.status, 200);
  const csp = res.headers['content-security-policy'];
  assert.ok(csp, 'Content-Security-Policy is present');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(res.headers['x-xss-protection'], '0');
});

test('non-API responses (including 404s) also carry the security headers', async () => {
  const res = await request(app).get('/no-such-page.html');
  assert.equal(res.status, 404);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
});

test('HSTS is not emitted outside production', async () => {
  const res = await request(app).get('/api/posts');
  assert.equal(res.headers['strict-transport-security'], undefined);
});

test('HSTS is emitted when the middleware is enabled for production', async () => {
  const a = express();
  a.use(securityHeaders({ production: true }));
  a.get('/x', (req, res) => res.json({ ok: true }));
  const res = await request(a).get('/x');
  assert.match(res.headers['strict-transport-security'], /^max-age=\d+; includeSubDomains$/);
});

test('error responses still carry the security headers', async () => {
  const res = await request(app).get('/api/auth/me');
  assert.equal(res.status, 401);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
});
