import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { app, request, ADMIN, csrfTokenFrom } from './helpers.js';
import { createUser, seedUserIfMissing } from '../src/services/users.js';
import { signJwt } from '../src/auth/jwt.js';
import { config } from '../src/config.js';

before(() => seedUserIfMissing());

// An agent holding the session cookie (and any CSRF cookie issued at login)
// but without an explicit x-csrf-token header, to exercise the rejection path.
async function sessionOnlyAgent() {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send(ADMIN);
  assert.equal(res.status, 200);
  return agent;
}

test('login issues a readable (non-HttpOnly) CSRF cookie', async () => {
  const res = await request(app).post('/api/auth/login').send(ADMIN);
  assert.equal(res.status, 200);
  const setCookie = res.headers['set-cookie'];
  const csrfEntry = (Array.isArray(setCookie) ? setCookie : [setCookie]).find((c) => c.startsWith('fb_csrf='));
  assert.ok(csrfEntry, 'login sets a fb_csrf cookie');
  assert.ok(!/HttpOnly/i.test(csrfEntry), 'the CSRF cookie must be readable by client JS');
  assert.ok(/SameSite=Lax/i.test(csrfEntry), 'CSRF cookie mirrors the session SameSite policy');
  assert.ok(csrfTokenFrom(res), 'login exposes the CSRF token to echo back');
});

test('login itself is not CSRF-gated (no session exists yet)', async () => {
  const res = await request(app).post('/api/auth/login').send(ADMIN);
  assert.equal(res.status, 200);
});

test('anonymous state-changing requests reach authentication, not CSRF', async () => {
  const res = await request(app)
    .post('/api/posts')
    .send({ title: 'anon', content: '<p>x</p>' });
  assert.equal(res.status, 401);
});

test('a state-changing request with a session but no CSRF header is rejected', async () => {
  const agent = await sessionOnlyAgent();
  const res = await agent
    .post('/api/posts')
    .send({ title: 'No token', content: '<p>x</p>' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'csrf_failed');
});

test('a mismatched CSRF header is rejected', async () => {
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send(ADMIN);
  const token = csrfTokenFrom(login);
  const wrong = token && token[0] === 'a' ? 'b'.repeat(token.length) : 'a'.repeat(token.length);
  const res = await agent
    .set('x-csrf-token', wrong)
    .post('/api/posts')
    .send({ title: 'Bad token', content: '<p>x</p>' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'csrf_failed');
});

test('a matching CSRF header is accepted', async () => {
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send(ADMIN);
  const token = csrfTokenFrom(login);
  assert.ok(token, 'login provides a CSRF token');
  const res = await agent
    .set('x-csrf-token', token)
    .post('/api/posts')
    .send({ title: 'With token', content: '<p>ok</p>' });
  assert.equal(res.status, 201);
});

test('read-only requests are not CSRF-gated', async () => {
  const agent = await sessionOnlyAgent();
  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  const list = await agent.get('/api/posts');
  assert.equal(list.status, 200);
});

test('a legacy session without a CSRF cookie is refused on its first state-changing request', async () => {
  const user = await createUser({ username: `legacy_${Date.now()}`, password: 'initialpw1', role: 'author' });
  const agent = request.agent(app);
  agent.jar.setCookie(
    `fb_session=${signJwt({ username: user.username, sub: user.id, role: 'author' }, config.appSecret, 3600)}`
  );

  const first = await agent
    .post('/api/posts')
    .send({ title: 'Legacy', content: '<p>x</p>' });
  assert.equal(first.status, 403);
  assert.equal(first.body.error, 'csrf_failed');

  // The 403 response issues a CSRF cookie so a retry with the echoed token works.
  const token = csrfTokenFrom(first);
  assert.ok(token, 'the rejection issues a CSRF cookie for the retry');
  const retry = await agent
    .set('x-csrf-token', token)
    .post('/api/posts')
    .send({ title: 'Legacy retry', content: '<p>ok</p>' });
  assert.equal(retry.status, 201);
});

test('logout with a session and valid CSRF header still works', async () => {
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send(ADMIN);
  const token = csrfTokenFrom(login);
  const out = await agent.set('x-csrf-token', token).post('/api/auth/logout');
  assert.equal(out.status, 200);
});
